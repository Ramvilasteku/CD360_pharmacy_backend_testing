// routes/pharmacy/sales.js
// Sales module for clinic/pharmacy plans
// Hospital plan uses pharmacy_dispencing/items instead (separate routes)

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");

// Stock is counted in TABLETS and priced PER STRIP. These screens send and receive
// STRIPS, so quantities are translated here — see utils/pharmacyStripView.js.
// pharmacy_sale_items.quantity holds the count of sale_unit (strips), and .tablets
// holds what actually left the batch, which is how Ram's procurement code reads it.
const { stripsOf, tabletsOf, batchesToStripView } = require("../../utils/pharmacyStripView");
const { unitsPerPack, readSaleLine } = require("../../utils/pharmacyUnits");
const { recordMove, istToday } = require("../../utils/pharmacyStock");

/** A 4xx the catch block passes straight to the screen (it reads err.status / err.extra). */
const saleFail = (status, message, extra) => Object.assign(new Error(message), { status, extra });

/**
 * M8 (10 Nov 2026) — next bill number for this pharmacy: SALE-YYYYMMDD-0001 (IST day).
 * Highest number used today + 1, read with FOR UPDATE so it sees every committed bill.
 * Call it inside a transaction that has already locked the pharmacy's admins row,
 * so two counters can never be handed the same number.
 */
async function nextSaleNumber(conn, tenantAdminId, prefix = "SALE", day = istToday().replace(/-/g, "")) {
  const [[row]] = await conn.query(
    `SELECT MAX(CAST(SUBSTRING_INDEX(sale_number, '-', -1) AS UNSIGNED)) AS n
       FROM pharmacy_sales
      WHERE admin_id = ? AND sale_number LIKE ?
      FOR UPDATE`,
    [tenantAdminId, `${prefix}-${day}-%`]
  );
  return `${prefix}-${day}-${String((Number(row.n) || 0) + 1).padStart(4, "0")}`;
}
const { resolveScope, batchFilter, rowFilter, historyBranchSql, recordScope, branchKey, sendBranchError } = require("../../utils/pharmacyBranch");

/* ============================================================
   HELPERS
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

function getUserId(req) {
  return req.user.id;
}

/* ============================================================
   Branch guard for routes that open ONE sale by id — 26 Oct 2026.

   The sales LIST is branch-scoped (rowFilter on GET /), but every route that takes an id
   checked admin_id and nothing else: a staff member could open, print, audit or discard
   any branch's bill by typing its id. This closes that.

   Answers through recordScope, so staff get 404 for another branch's sale — the same as
   for a sale that doesn't exist, so ids can't be used to probe other branches — and an
   admin passes for every branch. A sale id that isn't this tenant's at all is left for the
   route's own 404, so its existing message and status are unchanged.

   One indexed primary-key read; deliberately separate from each route's main query so
   none of their column lists had to change.

   Returns true when it has already answered, so the caller just `return`s.
============================================================ */
async function denySaleOutsideBranch(req, res, saleId, tenantAdminId, notFound = "Sale not found") {
  const [rows] = await db.query(
    `SELECT branch FROM pharmacy_sales WHERE id = ? AND admin_id = ? LIMIT 1`,
    [saleId, tenantAdminId]
  );
  if (!rows.length) return false;
  try {
    await recordScope(db, req, rows[0].branch, { notFound });
    return false;
  } catch (e) {
    if (sendBranchError(res, e)) return true;
    throw e;
  }
}

function toDecimal(val, fallback = 0) {
  if (val === undefined || val === null || val === "") return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : Math.round(n * 100) / 100;
}

function toInt(val, fallback = 0) {
  if (val === undefined || val === null || val === "") return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

function isValidMobile(m) {
  if (!m) return false;
  const cleaned = m.replace(/[\s\-()+]/g, "");
  return /^\d{7,15}$/.test(cleaned);
}

const VALID_PAYMENT_METHODS = ["cash", "card", "upi", "bank_transfer", "credit", "mixed"];
// pharmacy_payments.payment_method has no 'credit' / 'mixed' — those are recorded as 'other'
// (writing them as-is made the whole sale fail with a database error).
const paymentRowMethod = (m) => (["cash", "card", "upi", "bank_transfer"].includes(m) ? m : "other");
const VALID_PAYMENT_STATUSES = ["unpaid", "partial", "paid"];
const VALID_SALE_STATUSES = ["completed", "cancelled", "returned"];
const VALID_GENDERS = ["male", "female", "other"];

function derivePaymentStatus(grandTotal, paidAmount) {
  if (paidAmount <= 0) return "unpaid";
  if (paidAmount >= grandTotal) return "paid";
  return "partial";
}

/* ============================================================
   NEW HELPER 1: Get admin's plan_type
   Blocks hospital plan from using this route
============================================================ */
async function getAdminPlanType(tenantAdminId, conn = db) {
  const [rows] = await conn.query(
    `SELECT plan_type FROM admins WHERE id = ? LIMIT 1`,
    [tenantAdminId]
  );
  if (!rows.length) return null;
  return rows[0].plan_type;
}

async function ensurePosPlan(tenantAdminId, res) {
  const planType = await getAdminPlanType(tenantAdminId);
  if (!planType) {
    res.status(403).json({ success: false, message: "Admin not found" });
    return false;
  }
  if (planType === "hospital") {
    res.status(403).json({
      success: false,
      message: "Hospital plan uses dispensing endpoint (/api/pharmacy/dispensing)",
      plan_type: planType,
    });
    return false;
  }
  return true;
}

/* ============================================================
   HELPER 2: Resolve the customer for a sale. NEVER creates one.

   Changed 25 Oct 2026. This used to auto-create a row in pharmacy_customer_pos whenever a
   bill arrived with a phone number that was not on file, and reported it back as
   `customer_created: true` ("✓ New patient added" on the POS). That is gone.

   Why: the counter types a phone number to SEARCH. Every near-miss — a typo, a digit
   short, a number entered as the person reads it out and then corrected — minted a
   permanent customer record as a side effect of billing. The customer book filled up with
   half-right duplicates that nobody chose to create and nobody knew to clean up.

   A customer is now created only by an explicit act: the "Add customer" button on the POS
   or the Customers screen, both of which POST to routes/Pharmacy/pharmacyCustomer.js and
   are gated on pharmacy.customers.create. That route also de-duplicates on
   (admin_id, mobile, name), which this helper never did.

   Rules now:
   - customer_id given        → verify it belongs to this tenant, use it
   - customer_phone given     → look it up; found → use it, NOT found → walk-in
   - nothing given            → walk-in

   A walk-in keeps customer_name / customer_phone on the pharmacy_sales row, so the bill
   still prints the name and number the counter typed and the sale is still searchable by
   either. What it does not do is create a customer record. Nothing is lost from the sale;
   only the silent INSERT is.

   Returns: { customer_id, customer_name, customer_phone }
============================================================ */
async function resolveCustomer(body, tenantAdminId, connection) {
  const {
    customer_id, customer_name, customer_phone,
    customer_email, customer_gender, customer_age,
  } = body;

  // Case A: customer_id provided → verify
  if (customer_id) {
    const [rows] = await connection.query(
      `SELECT id, name, mobile FROM pharmacy_customer_pos 
       WHERE id = ? AND admin_id = ? LIMIT 1`,
      [customer_id, tenantAdminId]
    );
    if (!rows.length) {
      return { error: `Customer id ${customer_id} not found in pharmacy customers` };
    }
    return {
      customer_id: rows[0].id,
      customer_name: rows[0].name,
      customer_phone: rows[0].mobile,
    };
  }

  // Case B: customer_phone provided → look it up. No match is a walk-in, not a new record.
  if (customer_phone) {
    if (!isValidMobile(customer_phone)) {
      return { error: "Invalid customer_phone" };
    }

    // The number is matched the same way routes/Pharmacy/pharmacyCustomer.js matches it:
    // on digits only. A stored "+91 98765 43210" and a typed "9876543210" are the same
    // customer, and the old exact-string compare treated them as different — which is how
    // a customer already on file could still get a duplicate created at bill time.
    const digits = String(customer_phone).replace(/\D/g, "");
    const [existing] = await connection.query(
      `SELECT id, name, mobile FROM pharmacy_customer_pos
        WHERE admin_id = ?
          AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                mobile, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '') = ?
        ORDER BY id DESC
        LIMIT 1`,
      [tenantAdminId, digits]
    );

    if (existing.length) {
      return {
        customer_id: existing[0].id,
        customer_name: existing[0].name,
        customer_phone: existing[0].mobile,
      };
    }

    // Not on file. The sale goes through as a walk-in carrying the typed details, and no
    // customer row is written. customer_name is no longer required here: it was only ever
    // required because this branch was about to INSERT.
    return {
      customer_id: null,
      customer_name: customer_name?.trim() || "Walk-in",
      customer_phone: customer_phone.trim(),
    };
  }

  // Case C: Walk-in with no info at all
  return {
    customer_id: null,
    customer_name: customer_name?.trim() || "Walk-in",
    customer_phone: null,
  };
}

// Not called anywhere today; kept as a thin wrapper so nothing that imports it breaks.
async function generateSaleNumber(tenantAdminId, conn = db) {
  return nextSaleNumber(conn, tenantAdminId, "SALE");
}

/* ============================================================
   Core: allocateBatches (batch_number / batch_id / FEFO)

   `bf` added 26 Oct 2026 — a branch filter from batchFilter(scope, "b"), i.e.
   { sql: " AND b.branch … = ?", params: [...] }, or the empty filter.

   Before this the function had no branch concept at all: all three lookups below read
   pharmacy_medicine_batches by admin_id only, so PATCH /:id/edit (its only caller) could
   re-allocate a bill against ANOTHER branch's stock — FEFO would happily pick the
   earliest-expiring batch in the whole pharmacy. The filter is STRICT on purpose: live
   stock must never come from a branch the bill does not belong to.

   The alias is `b` in every query so the same filter string works in all three.
   Default is the empty filter, so a single-branch pharmacy behaves exactly as before.
============================================================ */
async function allocateBatches(items, tenantAdminId, connection, useLock = false, bf = { sql: "", params: [] }) {
  const lockClause = useLock ? "FOR UPDATE" : "";
  const allocations = [];
  const errors = [];

  const medicineIds = [...new Set(items.map((i) => i.medicine_id))];
  const [medicines] = await connection.query(
    `SELECT pm.id, pm.gst_percentage, md.medicine_name
     FROM pharmacy_medicines pm
     JOIN medicine_data md ON md.id = pm.medicine_data_id
     WHERE pm.admin_id = ? AND pm.status = 'active' AND pm.id IN (?)`,
    [tenantAdminId, medicineIds]
  );

  const medicineMap = new Map(
    medicines.map((m) => [m.id, {
      gst_percentage: Number(m.gst_percentage),
      medicine_name: m.medicine_name,
    }])
  );

  const invalidMeds = medicineIds.filter((id) => !medicineMap.has(id));
  if (invalidMeds.length > 0) {
    return {
      allocations: [],
      errors: [{ code: "MEDICINE_NOT_FOUND", invalid_medicine_ids: invalidMeds }],
    };
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const medInfo = medicineMap.get(item.medicine_id);
    const qtyRequested = toInt(item.quantity, 0);
    let batches;

    if (item.batch_number) {
      const [rows] = await connection.query(
        `SELECT b.id, b.batch_number, b.expiry_date, b.quantity_available, b.selling_price, b.mrp, b.units_per_pack
         FROM pharmacy_medicine_batches b
         WHERE b.admin_id = ? AND b.medicine_id = ? AND b.batch_number = ?
           AND b.status = 'active' AND b.quantity_available > 0
           AND b.expiry_date >= CURDATE() ${bf.sql}
         ${lockClause}`,
        [tenantAdminId, item.medicine_id, item.batch_number, ...bf.params]
      );
      if (rows.length === 0) {
        errors.push({
          index: i, medicine_id: item.medicine_id,
          medicine_name: medInfo.medicine_name, batch_number: item.batch_number,
          error: `Batch '${item.batch_number}' not found or unavailable`,
        });
        continue;
      }
      batches = rows;
    } else if (item.batch_id) {
      const [rows] = await connection.query(
        `SELECT b.id, b.batch_number, b.expiry_date, b.quantity_available, b.selling_price, b.mrp, b.units_per_pack
         FROM pharmacy_medicine_batches b
         WHERE b.admin_id = ? AND b.id = ? AND b.medicine_id = ?
           AND b.status = 'active' AND b.quantity_available > 0
           AND b.expiry_date >= CURDATE() ${bf.sql}
         ${lockClause}`,
        [tenantAdminId, item.batch_id, item.medicine_id, ...bf.params]
      );
      if (rows.length === 0) {
        errors.push({
          index: i, medicine_id: item.medicine_id, batch_id: item.batch_id,
          error: `Batch id ${item.batch_id} not found or unavailable`,
        });
        continue;
      }
      batches = rows;
    } else {
      // FEFO auto-select (excludes ₹0 batches)
      const [rows] = await connection.query(
        `SELECT b.id, b.batch_number, b.expiry_date, b.quantity_available, b.selling_price, b.mrp, b.units_per_pack
         FROM pharmacy_medicine_batches b
         WHERE b.admin_id = ? AND b.medicine_id = ?
           AND b.status = 'active' AND b.quantity_available > 0
           AND b.expiry_date >= CURDATE()
           AND b.selling_price > 0 ${bf.sql}
         ORDER BY b.expiry_date ASC
         ${lockClause}`,
        [tenantAdminId, item.medicine_id, ...bf.params]
      );
      if (rows.length === 0) {
        errors.push({
          index: i, medicine_id: item.medicine_id,
          medicine_name: medInfo.medicine_name,
          error: `No stock available for '${medInfo.medicine_name}'`,
        });
        continue;
      }
      batches = rows;
    }

    let qtyNeeded = qtyRequested;
    for (const batch of batches) {
      if (qtyNeeded <= 0) break;
      // quantity_available is tablets; the request is in strips, so compare in strips.
      const upp = unitsPerPack(batch);
      const stripsInBatch = stripsOf(batch.quantity_available, upp);
      if (stripsInBatch <= 0) continue;
      const deductQty = Math.min(qtyNeeded, stripsInBatch);
      allocations.push({
        medicine_id: item.medicine_id,
        medicine_name: medInfo.medicine_name,
        batch_id: batch.id,
        batch_number: batch.batch_number,
        expiry_date: batch.expiry_date,
        quantity: deductQty,
        units_per_pack: upp,
        unit_price: Number(batch.selling_price),
        mrp: Number(batch.mrp),
        // The screens send discount_amount per line. The old code read
        // discount_percentage, which they never send, so every edit silently dropped
        // the discount. Both are accepted now, with the amount taking precedence.
        discount_amount:
          item.discount_amount !== undefined && item.discount_amount !== null && item.discount_amount !== ""
            ? toDecimal(item.discount_amount, 0)
            : null,
        discount_percentage: toDecimal(item.discount_percentage, 0),
        gst_percentage: medInfo.gst_percentage,
      });
      qtyNeeded -= deductQty;
    }

    if (qtyNeeded > 0) {
      const totalAvail = batches.reduce(
        (s, b) => s + stripsOf(b.quantity_available, unitsPerPack(b)),
        0
      );
      errors.push({
        index: i, medicine_id: item.medicine_id,
        medicine_name: medInfo.medicine_name,
        error: `Insufficient stock. Requested: ${qtyRequested}, Available: ${totalAvail}`,
      });
    }
  }

  return { allocations, errors };
}

/* ============================================================
   Core: computeTotals
============================================================ */
function computeTotals(allocations) {
  let subtotal = 0, totalDiscount = 0, totalTax = 0;

  const lineItems = allocations.map((a) => {
    const gross = a.unit_price * a.quantity;
    // A per-line amount wins over a percentage, because that is what the screens send.
    const discAmt =
      a.discount_amount !== null && a.discount_amount !== undefined
        ? Math.min(Math.max(0, Number(a.discount_amount) || 0), gross)
        : (gross * (Number(a.discount_percentage) || 0)) / 100;
    const afterDisc = gross - discAmt;
    const taxAmt = (afterDisc * a.gst_percentage) / 100;
    const totalAmt = afterDisc + taxAmt;

    subtotal += gross;
    totalDiscount += discAmt;
    totalTax += taxAmt;

    return {
      medicine_id: a.medicine_id,
      medicine_name: a.medicine_name,
      batch_id: a.batch_id,
      batch_number: a.batch_number,
      expiry_date: a.expiry_date,
      quantity: a.quantity,
      units_per_pack: a.units_per_pack,
      unit_price: a.unit_price,
      mrp: a.mrp,
      discount_amount: Math.round(discAmt * 100) / 100,
      gst_percentage: a.gst_percentage,
      tax_amount: Math.round(taxAmt * 100) / 100,
      total_amount: Math.round(totalAmt * 100) / 100,
    };
  });

  subtotal = Math.round(subtotal * 100) / 100;
  totalDiscount = Math.round(totalDiscount * 100) / 100;
  totalTax = Math.round(totalTax * 100) / 100;
  const grandTotal = Math.round((subtotal - totalDiscount + totalTax) * 100) / 100;

  return { lineItems, subtotal, totalDiscount, totalTax, grandTotal };
}

/* ═══════════════════════════════════════════════════════════
   ENDPOINTS
═══════════════════════════════════════════════════════════ */

/* ============================================================
   1. CALCULATE — Preview cart total
   POST /calculate
============================================================ */


router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.sales.create"),
  async (req, res) => {
    const tenantAdminId = getTenantAdminId(req);
    const cashierId = req.user.id;
 
    const {
      // Customer — accept both shapes
      customer,
      customer_id, customer_name, customer_phone,
 
      prescription_id,
      doctor_name,
      items,
      payment_method,
      paid_amount,
      notes,
 
      // Overall bill-level amounts (optional — frontend may compute)
      discount_amount: discountFromBody,
      tax_amount: taxFromBody,
      grand_total: grandTotalFromBody,
 
      // Draft / park
      status = "completed",
      park_reason,
      park_notes,
 
      // Optional for payment ledger
      transaction_reference,
    } = req.body;
 
    // ═══════════════════════════════════════════════════════════
    // Normalize customer
    // ═══════════════════════════════════════════════════════════
    const custInput =
      customer && typeof customer === "object"
        ? customer
        : { id: customer_id, name: customer_name, mobile: customer_phone };
 
    const cId     = custInput.id || null;
    const cName   = custInput.name ? String(custInput.name).trim() : "";
    const cMobile = custInput.mobile ? String(custInput.mobile).trim() : "";
    const cEmail  = custInput.email ? String(custInput.email).trim() : null;
    const cGender =
      custInput.gender && ["male", "female", "other"].includes(custInput.gender)
        ? custInput.gender
        : null;
    const cAge =
      custInput.age !== undefined && custInput.age !== null && custInput.age !== ""
        ? Number(custInput.age)
        : null;
 
    if (!cName || !cMobile) {
      return res.status(400).json({ success: false, message: "Customer required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Cart is empty" });
    }
    if (items.length > 200) {
      return res.status(400).json({ success: false, message: "Too many items in one sale" });
    }

    // Validate every line before anything is written. This path had no item validation
    // at all, and a negative quantity used to pass the stock guard and ADD stock back.
    for (const item of items) {
      const q = Number(item.quantity);
      if (!Number.isFinite(q) || q <= 0 || !Number.isInteger(q)) {
        return res.status(400).json({
          success: false,
          message: "Every item needs a whole quantity of at least 1.",
        });
      }
      if (!item.medicine_id || !item.batch_id) {
        return res.status(400).json({
          success: false,
          message: "Every item needs a medicine and a batch.",
        });
      }
      if (Number(item.unit_price) < 0 || Number(item.discount_amount) < 0) {
        return res.status(400).json({
          success: false,
          message: "Price and discount cannot be negative.",
        });
      }
    }
    if (!VALID_SALE_STATUSES.includes(status) && status !== "draft") {
      return res.status(400).json({ success: false, message: "Unknown sale status." });
    }
    if (payment_method && !VALID_PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ success: false, message: "Unknown payment method." });
    }

    // Which branch this sale draws stock from. Staff are always on their own branch.
    //
    // forWrite: true added 26 Oct 2026. Without it, a multi-branch ADMIN who sent no branch
    // got scope.filter = false — so saleBf below was empty, the batch check accepted a
    // batch from ANY branch, and the sale was stamped branch = NULL. That was the main
    // source of the unattributed sales that made strict branch filtering impossible.
    // Now resolveScope answers 400 "Choose the branch first." and nothing is written.
    //
    // It applies to a parked draft as well, although parking moves no stock: the draft's
    // stored branch is what PATCH /drafts/:id/complete draws from later, so a draft with
    // no branch could only ever be completed against the wrong stock or none.
    // Staff and single-branch pharmacies are unaffected — resolveScope never asks them.
    let scope;
    try {
      scope = await resolveScope(db, req, { wanted: req.body.branch, forWrite: true });
    } catch (e) {
      if (sendBranchError(res, e)) return;
      throw e;
    }
    const saleBf = batchFilter(scope, "b");
 
    // ═══════════════════════════════════════════════════════════
    // N3 (10 Nov 2026): totals are computed on the server from the lines, once every
    // batch has been checked (below). The client's numbers are only used to CHECK
    // that the screen and the server agree — they are never stored as they come.
    // ═══════════════════════════════════════════════════════════
    const orderDiscountIn = Math.max(0, Number(discountFromBody) || 0);
    const overallGstIn = Number(
      req.body.overall_gst_percent !== undefined ? req.body.overall_gst_percent : req.body.extra_gst_percent
    ) || 0;
    if (overallGstIn < 0 || overallGstIn > 100) {
      return res.status(400).json({ success: false, message: "Overall GST must be between 0 and 100%." });
    }
    void taxFromBody; // kept in the payload for older screens; the server works GST out itself

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      // M8: one sale at a time per pharmacy while the bill number is taken. This must be
      // the first statement of the transaction (same pattern as B2B invoices).
      await connection.query(`SELECT id FROM admins WHERE id = ? FOR UPDATE`, [tenantAdminId]);
 
      // ═══════════════════════════════════════════════════════════
      // Find customer — NEVER create one
      //
      // Changed 25 Oct 2026, same reasoning as resolveCustomer() above (see the long note
      // there). This handler had its OWN inline copy of the find-or-create, so fixing the
      // helper alone would have left the POS still minting customers: this is the path the
      // walk-in counter actually takes.
      //
      // Now: match on id, else match on mobile, else bill it as a walk-in. The typed name
      // and number still go onto the pharmacy_sales row, so the bill prints normally and
      // the sale is searchable by either — there is simply no customer record created
      // behind the counter's back.
      // ═══════════════════════════════════════════════════════════
      let resolvedCustomerId = null;
      let resolvedName = null;
      let resolvedMobile = null;

      if (cId) {
        const [rows] = await connection.query(
          `SELECT id, name, mobile FROM pharmacy_customer_pos
            WHERE id = ? AND admin_id = ? LIMIT 1`,
          [cId, tenantAdminId]
        );
        if (rows.length) {
          resolvedCustomerId = rows[0].id;
          resolvedName       = rows[0].name;
          resolvedMobile     = rows[0].mobile;
        }
      }
 
      if (!resolvedCustomerId && cMobile) {
        // Digits-only compare, so a stored "+91 98765 43210" matches a typed "9876543210".
        // The old `mobile = ?` exact compare missed those and then created a duplicate.
        const cDigits = String(cMobile).replace(/\D/g, "");
        const [existing] = await connection.query(
          `SELECT id, name, mobile FROM pharmacy_customer_pos
            WHERE admin_id = ?
              AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                    mobile, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '') = ?
            ORDER BY created_at DESC
            LIMIT 1`,
          [tenantAdminId, cDigits]
        );
        if (existing.length) {
          resolvedCustomerId = existing[0].id;
          resolvedName       = existing[0].name;
          resolvedMobile     = existing[0].mobile;
        }
      }

      if (!resolvedCustomerId) {
        // Walk-in. These were validated here because a row was about to be INSERTed; they
        // are kept because the same values are written onto pharmacy_sales, whose
        // customer_name / customer_phone columns have the same limits.
        if (cName.length > 150) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: "Name too long (max 150)" });
        }
        if (cMobile.length > 15) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: "Mobile too long (max 15)" });
        }

        resolvedName   = cName || "Walk-in";
        resolvedMobile = cMobile || null;
      }
 
      // ═══════════════════════════════════════════════════════════
      // Check every line against its batch BEFORE anything is written
      //   N2 — the batch must be active and in date, the medicine active
      //   N4 — the line's medicine must be the batch's medicine
      //   N3 — the rate may not exceed the batch MRP; a line discount not the line
      // ═══════════════════════════════════════════════════════════
      const todayIst = istToday();
      const lines = [];
      for (const item of items) {
        const qty          = Number(item.quantity) || 0;
        const unitPrice    = Math.round((Number(item.unit_price) || 0) * 100) / 100;
        const lineDiscount = Math.round((Number(item.discount_amount) || 0) * 100) / 100;
        const gstPct       = Number(item.gst_percentage) || 0;

        const [batchRows] = await connection.query(
          `SELECT b.id, b.medicine_id, b.batch_number, b.units_per_pack, b.mrp,
                  b.quantity_available, b.branch, b.status, b.expiry_date,
                  pm.status AS medicine_status, md.medicine_name
             FROM pharmacy_medicine_batches b
             JOIN pharmacy_medicines pm ON pm.id = b.medicine_id AND pm.admin_id = b.admin_id
        LEFT JOIN medicine_data md      ON md.id = pm.medicine_data_id
            WHERE b.id = ? AND b.admin_id = ? ${saleBf.sql}
            LIMIT 1`,
          [item.batch_id, tenantAdminId, ...saleBf.params]
        );
        if (!batchRows.length) {
          throw saleFail(404, "One of the items is not stocked in this branch. Refresh the cart and try again.");
        }
        const batch = batchRows[0];
        const label = `${batch.medicine_name || "Medicine"} (batch ${batch.batch_number})`;

        if (Number(item.medicine_id) !== Number(batch.medicine_id)) {
          throw saleFail(400, `Batch ${batch.batch_number} belongs to a different medicine than the one on this line. Remove the line and add it again.`);
        }
        if (batch.medicine_status !== "active") {
          throw saleFail(409, `${batch.medicine_name || "This medicine"} has been deactivated and can't be sold. Remove it from the bill.`, { batch_number: batch.batch_number });
        }
        if (batch.status !== "active") {
          throw saleFail(409, `${label} is ${batch.status || "not active"} and can't be sold. Remove it from the bill.`, { batch_number: batch.batch_number });
        }
        const exp = batch.expiry_date ? String(batch.expiry_date).slice(0, 10) : null;
        if (exp && exp < todayIst) {
          throw saleFail(409, `${label} expired on ${exp} and can't be sold. Remove it from the bill.`, { batch_number: batch.batch_number });
        }
        const mrp = Number(batch.mrp) || 0;
        if (mrp > 0 && unitPrice > mrp + 0.005) {
          throw saleFail(400, `${label}: the rate ₹${unitPrice} is above the MRP ₹${mrp}.`, { batch_number: batch.batch_number });
        }
        const lineGross = Math.round(unitPrice * qty * 100) / 100;
        if (lineDiscount > lineGross + 0.005) {
          throw saleFail(400, `${label}: the discount ₹${lineDiscount} is more than the line (₹${lineGross}).`);
        }

        const upp       = unitsPerPack(batch);
        const lineNet   = Math.max(0, lineGross - lineDiscount);
        const lineTaxRaw = (lineNet * gstPct) / 100;
        const lineTax   = Math.round(lineTaxRaw * 100) / 100;
        lines.push({
          batch, qty, unitPrice, lineDiscount, gstPct, lineNet, lineTaxRaw, lineTax,
          lineTotal: Math.round((lineNet + lineTax) * 100) / 100,
          upp,
          // units_per_pack 1 means the item is only ever sold whole, which the schema calls a pack.
          saleUnit: upp > 1 ? "strip" : "pack",
          tabletsOut: tabletsOf(qty, upp),
        });
      }

      // ═══════════════════════════════════════════════════════════
      // Totals — the same formula the POS and Existing-patient screens use:
      //   lines net − order discount, then GST: either a % on the whole bill
      //   (overall_gst_percent) or the sum of each line's own GST.
      // ═══════════════════════════════════════════════════════════
      const r2 = (n) => Math.round(n * 100) / 100;
      const itemsSubtotal  = r2(lines.reduce((t, l) => t + l.lineNet, 0));
      const discountAmount = r2(Math.min(orderDiscountIn, itemsSubtotal));
      const afterDiscount  = r2(itemsSubtotal - discountAmount);
      const taxAmount = overallGstIn > 0
        ? r2((afterDiscount * overallGstIn) / 100)
        : r2(lines.reduce((t, l) => t + l.lineTaxRaw, 0));
      const grandTotal = r2(afterDiscount + taxAmount);

      if (grandTotalFromBody !== undefined && grandTotalFromBody !== null && grandTotalFromBody !== "") {
        const screenTotal = Number(grandTotalFromBody);
        const tolerance = Math.max(0.05, 0.01 * lines.length);
        if (!Number.isFinite(screenTotal) || Math.abs(screenTotal - grandTotal) > tolerance) {
          throw saleFail(400,
            `The bill total doesn't add up: the screen says ₹${Number.isFinite(screenTotal) ? screenTotal.toFixed(2) : "?"}, ` +
            `the items come to ₹${grandTotal.toFixed(2)}. Refresh the bill and try again.`,
            { server_grand_total: grandTotal });
        }
      }

      // ═══════════════════════════════════════════════════════════
      // Sale number — M8: IST date, highest number so far + 1, read with a lock
      // (the admins row lock above makes the read-and-insert one step per pharmacy)
      // ═══════════════════════════════════════════════════════════
      const today  = todayIst.replace(/-/g, "");
      const prefix = status === "draft" ? "DRAFT" : "SALE";
      const saleNumber = await nextSaleNumber(connection, tenantAdminId, prefix, today);

      // Payment fields — draft gets zeros (unchanged)
      // Change handed back is not "paid": the payment recorded is at most the bill.
      const paidForDb     = status === "draft" ? 0 : r2(Math.min(Math.max(0, Number(paid_amount) || 0), grandTotal));
      const dueForDb      = status === "draft" ? 0 : Math.max(0, grandTotal - paidForDb);
      const paymentMethod = status === "draft" ? "cash" : (payment_method || "cash");
      const paymentStatus = status === "draft"
        ? "unpaid"
        : (paidForDb >= grandTotal ? "paid"
            : paidForDb > 0 ? "partial" : "unpaid");
 
      // ═══════════════════════════════════════════════════════════
      // Insert sale — discount_amount is now a parameter (was 0)
      // ═══════════════════════════════════════════════════════════
      const [saleResult] = await connection.query(
        `INSERT INTO pharmacy_sales
          (admin_id, branch, sale_number, customer_id, customer_name, customer_phone,
           prescription_id, doctor_name, sale_date,
           subtotal, discount_amount, tax_amount, grand_total,
           paid_amount, due_amount, payment_method, payment_status,
           status, park_reason, park_notes,
           sold_by, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantAdminId, scope.branch || null, saleNumber,
          resolvedCustomerId,
          resolvedName   || cName,
          resolvedMobile || cMobile,
          prescription_id || null, doctor_name || null,
          itemsSubtotal,                 // subtotal
          discountAmount,                // ⭐ now from body (not hardcoded 0)
          taxAmount,
          grandTotal,
          paidForDb, dueForDb, paymentMethod, paymentStatus,
          status,
          status === "draft" ? (park_reason || "other") : null,
          status === "draft" ? (park_notes?.trim() || null) : null,
          cashierId, notes?.trim() || null,
        ]
      );
      const saleId = saleResult.insertId;

      for (const line of lines) {
        await connection.query(
          `INSERT INTO pharmacy_sale_items
            (sale_id, medicine_id, batch_id,
             quantity, sale_unit, units_per_pack, tablets,
             unit_price, discount_amount,
             gst_percentage, tax_amount, total_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            saleId, line.batch.medicine_id, line.batch.id,   // N4: the batch's own medicine
            line.qty, line.saleUnit, line.upp, line.tabletsOut,
            line.unitPrice, line.lineDiscount,
            line.gstPct, line.lineTax, line.lineTotal,
          ]
        );

        if (status === "completed") {
          // recordMove locks the batch, takes the tablets out, throws a 409 naming the batch
          // when there aren't enough, and writes the pharmacy_stock_transactions row.
          await recordMove(connection, {
            adminId: tenantAdminId,
            userId: cashierId,
            batchId: line.batch.id,
            tabletsOut: line.tabletsOut,
            type: "sale",
            referenceId: saleId,
            referenceNumber: saleNumber,
            notes: `Sold ${line.qty} ${line.saleUnit}${line.qty === 1 ? "" : "s"} on ${saleNumber}`,
          });
        }
      }

      // ═══════════════════════════════════════════════════════════
      // ⭐ NEW — also insert into pharmacy_payments when paid at sale
      // Only when sale is completed and some money came in. The
      // separate /post/payment route stays unchanged for later top-ups
      // (partial payments collected after the fact).
      // ═══════════════════════════════════════════════════════════
      let paymentNumber = null;
      let paymentId = null;
      if (status === "completed" && paidForDb > 0) {
        // M8: same day (IST) as the bill number, highest so far + 1, under the same lock
        const [[payRow]] = await connection.query(
          `SELECT MAX(CAST(SUBSTRING_INDEX(payment_number, '-', -1) AS UNSIGNED)) AS n
             FROM pharmacy_payments
            WHERE admin_id = ? AND payment_number LIKE ?
            FOR UPDATE`,
          [tenantAdminId, `PAY-${today}-%`]
        );
        paymentNumber = `PAY-${today}-${String((Number(payRow.n) || 0) + 1).padStart(5, "0")}`;
 
        const [payIns] = await connection.query(
          `INSERT INTO pharmacy_payments
             (admin_id, sale_id, purchase_id, payment_number, amount,
              payment_method, transaction_reference, notes, received_by)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
          [
            tenantAdminId,
            saleId,
            paymentNumber,
            paidForDb,
            paymentRowMethod(paymentMethod),
            transaction_reference || null,
            notes?.trim() || null,
            cashierId,
          ]
        );
        paymentId = payIns.insertId;
      }
 
      await connection.commit();
      return res.status(201).json({
        success: true,
        message: status === "draft"
          ? `Sale parked as ${saleNumber}`
          : "Sale completed",
        data: {
          id: saleId,
          sale_number: saleNumber,
          status,
          customer_id: resolvedCustomerId,
          // customer_created removed 25 Oct 2026 — a sale never creates a customer now.
          // resolvedCustomerId is null for a walk-in, which is what the screen reads.
          customer_walkin: resolvedCustomerId === null,
          subtotal: itemsSubtotal,
          discount_amount: discountAmount,
          tax_amount: taxAmount,
          grand_total: grandTotal,
          paid_amount: paidForDb,
          due_amount: dueForDb,
          payment_status: paymentStatus,
          payment_id: paymentId,         // ⭐ null for drafts / unpaid
          payment_number: paymentNumber, // ⭐ PAY-… or null
        },
      });
    } catch (err) {
      await connection.rollback();
      // recordMove raises a 409 naming the batch when stock has moved under the cart,
      // and a 404 when the batch is gone. Pass those through instead of a blank 500.
      if (err && err.status) {
        return res.status(err.status).json({
          success: false,
          message: err.message,
          ...(err.extra || {}),
        });
      }
      console.error("Create sale error:", err);
      return res.status(500).json({ success: false, message: "Failed to save sale" });
    } finally {
      connection.release();
    }
  }
);
 


// ═══════════════════════════ HELPERS ═══════════════════════════

const FULL_PAYMENT_METHODS = ["cash", "card", "upi", "bank_transfer"];
const MOBILE_REGEX = /^[6-9]\d{9}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Optional customer details: request body key → column in pharmacy_customer_pos.
 * Only uncomment columns that EXIST in your table.
 */
const CUSTOMER_OPTIONAL_FIELDS = {
  customer_email: "email",
  // customer_address: "address",
  // customer_age: "age",
  // customer_gender: "gender",
  // doctor_name: "doctor_name",
};

// Trim text, collapse spaces, return null if empty
const cleanText = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().replace(/\s+/g, " ");
  return s || null;
};

// "+91 98765-43210" → "9876543210"
const normalizePhone = (v) => {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
};

// ═══════════════════════════ ROUTE ═══════════════════════════




router.get(
  "/:id/view",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      // Security: validate id is a positive integer
      const saleId = Number(id);
      if (!Number.isInteger(saleId) || saleId <= 0) {
        return res.status(400).json({ success: false, message: "Invalid sale ID" });
      }

      // ─── Sale header + pharmacy + cashier ───
      if (await denySaleOutsideBranch(req, res, saleId, tenantAdminId)) return;
      const [saleRows] = await db.query(
        `
        SELECT
          ps.id,
          ps.sale_number,
          ps.customer_name,
          ps.customer_phone,
          ps.sale_date,
          ps.subtotal,
          ps.discount_amount,
          ps.tax_amount,
          ps.grand_total,
          ps.paid_amount,
          ps.due_amount,
          ps.payment_method,
          ps.payment_status,
          ps.status,
          ps.notes,
          ps.doctor_name,

          a.company_name AS pharmacy_name,
          a.address      AS pharmacy_address,
          a.mobile       AS pharmacy_phone,
          a.company_logo AS pharmacy_logo,

          s.name  AS sold_by_name
        FROM pharmacy_sales ps
        LEFT JOIN admins a  ON a.id = ps.admin_id
        LEFT JOIN staff s   ON s.id = ps.sold_by
        WHERE ps.id = ? AND ps.admin_id = ?
        LIMIT 1
        `,
        [saleId, tenantAdminId]
      );

      if (!saleRows.length) {
        return res.status(404).json({ success: false, message: "Sale not found" });
      }

      const sale = saleRows[0];

      // ─── Items — minimal columns only ───
      const [items] = await db.query(
        `
        SELECT
          md.medicine_name,
          md.strength,
          md.dosage_form,
          pmb.batch_number,
          pmb.expiry_date,
          psi.quantity,
          psi.unit_price,
          psi.discount_amount,
          psi.gst_percentage,
          psi.tax_amount,
          psi.total_amount
        FROM pharmacy_sale_items psi
        JOIN pharmacy_medicines pm         ON pm.id  = psi.medicine_id
        JOIN medicine_data md              ON md.id  = pm.medicine_data_id
        JOIN pharmacy_medicine_batches pmb ON pmb.id = psi.batch_id
        WHERE psi.sale_id = ?
        ORDER BY psi.id ASC
        `,
        [saleId]
      );

      // Shape response for the modal
      const data = {
        id: sale.id,
        sale_number: sale.sale_number,
        sale_date: sale.sale_date,
        status: sale.status,
        is_cancelled: sale.status === "cancelled",
        is_returned: sale.status === "returned",

        pharmacy: {
          name: sale.pharmacy_name || "Pharmacy",
          address: sale.pharmacy_address,
          phone: sale.pharmacy_phone,
          logo: sale.pharmacy_logo,
        },

        customer: {
          name: sale.customer_name || "Walk-in Customer",
          phone: sale.customer_phone,
        },

        doctor_name: sale.doctor_name,

        items: items.map((it, idx) => ({
          sl_no: idx + 1,
          name: it.medicine_name,
          strength: it.strength,
          dosage_form: it.dosage_form,
          batch_number: it.batch_number,
          expiry_date: it.expiry_date,
          quantity: it.quantity,
          unit_price: Number(it.unit_price),
          discount: Number(it.discount_amount || 0),
          gst_pct: Number(it.gst_percentage || 0),
          total: Number(it.total_amount),
        })),

        totals: {
          subtotal: Number(sale.subtotal),
          discount: Number(sale.discount_amount),
          tax: Number(sale.tax_amount),
          grand_total: Number(sale.grand_total),
          paid: Number(sale.paid_amount),
          due: Number(sale.due_amount),
        },

        payment: {
          method: sale.payment_method,
          status: sale.payment_status,
        },

        notes: sale.notes,
        sold_by: sale.sold_by_name || "Staff",
      };

      return res.json({ success: true, data });
    } catch (err) {
      console.error("Sale view error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load sale",
      });
    }
  }
);


// draft routes 

//  this is get drafts route
// M7: billing screens need this read — a cashier with only pharmacy.sales.create must be able to use it
router.get("/drafts", authMiddleware, allowPermissions("pharmacy.sales.view", "pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const cashierId = req.user.id;
      const { mine_only = "true" } = req.query;

      const where = ["s.admin_id = ?", "s.status = 'draft'"];
      const params = [tenantAdminId];

      // A parked bill belongs to the branch it was started in.
      let dScope;
      try {
        dScope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }
      const dBf = rowFilter(dScope, "s");
      if (dBf.sql) {
        where.push(dBf.sql.replace(/^\s*AND\s+/i, ""));
        params.push(...dBf.params);
      }

      if (mine_only === "true") {
        where.push("s.sold_by = ?");
        params.push(cashierId);
      }

      const [drafts] = await db.query(
        `SELECT s.id, s.sale_number, s.customer_id,
                s.customer_name, s.customer_phone,
                s.grand_total, s.park_reason, s.park_notes,
                s.created_at, s.sold_by,
                TIMESTAMPDIFF(MINUTE, s.created_at, NOW()) AS parked_minutes_ago,
                COUNT(si.id) AS items_count
           FROM pharmacy_sales s
           LEFT JOIN pharmacy_sale_items si ON si.sale_id = s.id
          WHERE ${where.join(" AND ")}
          GROUP BY s.id
          ORDER BY s.created_at DESC`,
        params
      );

      return res.json({ success: true, data: drafts });
    } catch (err) {
      console.error("List drafts error:", err);
      return res.status(500).json({ success: false, message: "Failed to fetch drafts" });
    }
  }
);

// M7: billing screens need this read — a cashier with only pharmacy.sales.create must be able to use it
router.get("/drafts/:id", authMiddleware, allowPermissions("pharmacy.sales.view", "pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      if (await denySaleOutsideBranch(req, res, req.params.id, tenantAdminId, "Draft not found")) return;
      const [sales] = await db.query(
        `SELECT * FROM pharmacy_sales
          WHERE id = ? AND admin_id = ? AND status = 'draft'`,
        [req.params.id, tenantAdminId]
      );

      if (!sales.length) {
        return res.status(404).json({ success: false, message: "Draft not found" });
      }

      const [items] = await db.query(
        `SELECT si.medicine_id, si.batch_id, si.quantity,
                si.unit_price, si.discount_amount,
                si.sale_unit, si.units_per_pack, si.tablets,
                md.medicine_name,
                pm.manufacturer, pm.pack_size, pm.gst_percentage, pm.selling_price,
                pb.batch_number, pb.quantity_available, pb.expiry_date,
                pb.units_per_pack AS batch_upp
           FROM pharmacy_sale_items si
           JOIN pharmacy_medicines pm ON pm.id = si.medicine_id
           JOIN medicine_data md      ON md.id = pm.medicine_data_id
           JOIN pharmacy_medicine_batches pb ON pb.id = si.batch_id
          WHERE si.sale_id = ?`,
        [req.params.id]
      );

      return res.json({
        success: true,
        data: {
          sale: sales[0],
          items: items.map(i => ({
            medicine_id: i.medicine_id,
            medicine_name: i.medicine_name,
            manufacturer: i.manufacturer,
            pack_size: i.pack_size,
            batch_id: i.batch_id,
            batch_number: i.batch_number,
            // strips, because the POS clamps its quantity stepper against this
            available: stripsOf(i.quantity_available, i.batch_upp || i.units_per_pack),
            expiry_date: i.expiry_date,
            quantity: i.quantity,
            unit_price: Number(i.unit_price),
            discount_amount: Number(i.discount_amount),
            gst_percentage: Number(i.gst_percentage),
            availableBatches: [],
          })),
        },
      });
    } catch (err) {
      console.error("Get draft error:", err);
      return res.status(500).json({ success: false, message: "Failed to load draft" });
    }
  }
);

router.patch("/drafts/:id/complete", authMiddleware,
  allowPermissions("pharmacy.sales.create"),
  async (req, res) => {
    const tenantAdminId = getTenantAdminId(req);
    const { payment_method = "cash", paid_amount = 0, transaction_reference = null } = req.body || {};
    if (!VALID_PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ success: false, message: "Unknown payment method." });
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      // M8: numbering is serialised per pharmacy — first statement of the transaction.
      await connection.query(`SELECT id FROM admins WHERE id = ? FOR UPDATE`, [tenantAdminId]);

      // Verify the draft exists
      const [sales] = await connection.query(
        `SELECT id, grand_total, sale_number, notes, branch FROM pharmacy_sales
          WHERE id = ? AND admin_id = ? AND status = 'draft'`,
        [req.params.id, tenantAdminId]
      );
      if (!sales.length) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: "Draft not found" });
      }
      const grandTotal = Number(sales[0].grand_total);

      // Branch — 26 Oct 2026. This route deducts stock and used to check admin_id only, so
      // a staff member could complete another branch's parked bill and take that branch's
      // stock. Pinned to the DRAFT's stored branch, the way pharmacy_dispensing.js finalize
      // does: staff may only complete a draft parked in their own branch, and every batch on
      // it must still be in that branch (checked per item below).
      let draftScope;
      try {
        draftScope = await recordScope(connection, req, sales[0].branch, {
          forStock: true,
          notFound: "Draft not found",
          noBranch: "This parked bill has no branch, so there's no telling whose stock it should take. Open it, choose the branch and park it again.",
        });
      } catch (e) {
        await connection.rollback();
        if (sendBranchError(res, e)) return;
        throw e;
      }

      // Load items to deduct stock NOW. `tablets` is what actually leaves the batch;
      // rows parked before this column existed fall back to quantity x pack size.
      const [items] = await connection.query(
        `SELECT si.medicine_id, si.batch_id, si.quantity, si.sale_unit,
                si.units_per_pack, si.tablets,
                b.units_per_pack AS batch_upp, b.batch_number, b.branch AS batch_branch,
                b.status AS batch_status, b.expiry_date, pm.status AS medicine_status,
                md.medicine_name
           FROM pharmacy_sale_items si
           LEFT JOIN pharmacy_medicine_batches b ON b.id = si.batch_id
           LEFT JOIN pharmacy_medicines pm       ON pm.id = b.medicine_id
           LEFT JOIN medicine_data md            ON md.id = pm.medicine_data_id
          WHERE si.sale_id = ?`,
        [req.params.id]
      );

      // The real bill number (M8: IST day, locked). Taken before stock moves so the
      // stock ledger rows carry the SALE number, not the old DRAFT one.
      const today = istToday().replace(/-/g, "");
      const saleNumber = await nextSaleNumber(connection, tenantAdminId, "SALE", today);
      const todayIst = istToday();

      for (const item of items) {
        // N2: a batch may have expired or been blocked, or the medicine switched off,
        // while the bill sat parked.
        const what = `${item.medicine_name || "Medicine"} (batch ${item.batch_number || item.batch_id})`;
        const exp = item.expiry_date ? String(item.expiry_date).slice(0, 10) : null;
        const stop =
          item.medicine_status && item.medicine_status !== "active" ? `${item.medicine_name || "A medicine"} on this bill has been deactivated.` :
          item.batch_status && item.batch_status !== "active" ? `${what} is ${item.batch_status}.` :
          exp && exp < todayIst ? `${what} expired on ${exp}.` : null;
        if (stop) {
          await connection.rollback();
          return res.status(409).json({
            success: false,
            message: `${stop} Remove it from the bill and park it again.`,
            batch_number: item.batch_number || undefined,
          });
        }
        // Every batch on the draft must still sit in the draft's branch. A batch can move
        // (a purchase transfer) between parking and completing; taking it anyway would
        // charge one branch's stock to another branch's bill.
        if (draftScope.key && branchKey(item.batch_branch) !== draftScope.key) {
          await connection.rollback();
          return res.status(409).json({
            success: false,
            message: `Batch ${item.batch_number || item.batch_id} is no longer in ${draftScope.branch}. Remove it from the bill and add it again.`,
            batch_number: item.batch_number || undefined,
          });
        }
        const line = readSaleLine(item, sales[0], { units_per_pack: item.batch_upp });
        try {
          await recordMove(connection, {
            adminId: tenantAdminId,
            userId: req.user.id,
            batchId: item.batch_id,
            tabletsOut: line.tablets,
            type: "sale",
            referenceId: Number(req.params.id),
            referenceNumber: saleNumber,
            notes: `Parked sale ${sales[0].sale_number} completed (${item.quantity} ${line.sale_unit})`,
          });
        } catch (e) {
          await connection.rollback();
          if (e && e.status === 409) {
            return res.status(409).json({
              success: false,
              message: "Stock changed since this sale was parked — please review and retry",
              batch_number: item.batch_number || undefined,
            });
          }
          if (e && e.status) {
            return res.status(e.status).json({ success: false, message: e.message });
          }
          throw e;
        }
      }


      // Change handed back is not "paid": at most the bill.
      const paidNum = Math.round(Math.min(Math.max(0, Number(paid_amount) || 0), grandTotal) * 100) / 100;
      const dueNum = Math.max(0, Math.round((grandTotal - paidNum) * 100) / 100);
      const paymentStatus = paidNum >= grandTotal ? "paid"
                          : paidNum > 0 ? "partial" : "unpaid";

      await connection.query(
        `UPDATE pharmacy_sales
            SET status = 'completed',
                sale_number = ?,
                payment_method = ?,
                paid_amount = ?,
                due_amount = ?,
                payment_status = ?,
                park_reason = NULL,
                park_notes = NULL,
                sale_date = NOW(),
                updated_at = NOW()
          WHERE id = ?`,
        [saleNumber, payment_method, paidNum, dueNum, paymentStatus, req.params.id]
      );

      // A parked bill paid at the counter is money in, exactly like a direct sale — it
      // never got a pharmacy_payments row, so payment reports missed it (10 Nov 2026).
      let paymentNumber = null;
      if (paidNum > 0) {
        const [[payRow]] = await connection.query(
          `SELECT MAX(CAST(SUBSTRING_INDEX(payment_number, '-', -1) AS UNSIGNED)) AS n
             FROM pharmacy_payments
            WHERE admin_id = ? AND payment_number LIKE ?
            FOR UPDATE`,
          [tenantAdminId, `PAY-${today}-%`]
        );
        paymentNumber = `PAY-${today}-${String((Number(payRow.n) || 0) + 1).padStart(5, "0")}`;
        await connection.query(
          `INSERT INTO pharmacy_payments
             (admin_id, sale_id, purchase_id, payment_number, amount,
              payment_method, transaction_reference, notes, received_by)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
          [tenantAdminId, Number(req.params.id), paymentNumber, paidNum, paymentRowMethod(payment_method),
           transaction_reference || null, `Parked bill ${sales[0].sale_number} completed`, req.user.id]
        );
      }

      await connection.commit();
      return res.json({
        success: true,
        message: "Sale completed",
        data: {
          id: Number(req.params.id),
          sale_number: saleNumber,
          grand_total: grandTotal,
          paid_amount: paidNum,
          due_amount: dueNum,
          payment_status: paymentStatus,
          payment_number: paymentNumber,
        },
      });
    } catch (err) {
      await connection.rollback();
      console.error("Complete draft error:", err);
      return res.status(500).json({ success: false, message: "Failed to complete sale" });
    } finally {
      connection.release();
    }
  }
);

router.delete("/drafts/:id", authMiddleware,
  allowPermissions("pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      if (await denySaleOutsideBranch(req, res, req.params.id, tenantAdminId, "Draft not found")) return;
      await db.query(
        `UPDATE pharmacy_sales
            SET status = 'cancelled',
                updated_at = NOW()
          WHERE id = ? AND admin_id = ? AND status = 'draft'`,
        [req.params.id, tenantAdminId]
      );
      return res.json({ success: true, message: "Draft discarded" });
    } catch (err) {
      console.error("Discard draft error:", err);
      return res.status(500).json({ success: false, message: "Failed to discard draft" });
    }
  }
);




/* ============================================================
   3. LIST SALES (with filters, search, pagination)
   GET /
============================================================ */
router.get(
  "/",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const {
        search, status, payment_status, payment_method,
        customer_id, sold_by,
        start_date, end_date, min_amount, max_amount,
        page = 1, limit = 20,
        sort_by = "sale_date", sort_order = "DESC",
      } = req.query;

      const where = ["ps.admin_id = ?"];
      const params = [tenantAdminId];

      // Branch: admins choose with the Branch dropdown (?branch=) and may leave it on
      // "All branches"; staff only ever see their own branch's bills.
      let listScope;
      try {
        listScope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }
      const listBf = rowFilter(listScope, "ps");
      if (listBf.sql) {
        where.push(listBf.sql.replace(/^\s*AND\s+/i, ""));
        params.push(...listBf.params);
      }

      if (status && VALID_SALE_STATUSES.includes(status)) {
        where.push("ps.status = ?"); params.push(status);
      }
      if (payment_status && VALID_PAYMENT_STATUSES.includes(payment_status)) {
        where.push("ps.payment_status = ?"); params.push(payment_status);
      }
      if (payment_method && VALID_PAYMENT_METHODS.includes(payment_method)) {
        where.push("ps.payment_method = ?"); params.push(payment_method);
      }
      if (customer_id) { where.push("ps.customer_id = ?"); params.push(customer_id); }
      if (sold_by) { where.push("ps.sold_by = ?"); params.push(sold_by); }
      if (start_date) { where.push("DATE(ps.sale_date) >= ?"); params.push(start_date); }
      if (end_date) { where.push("DATE(ps.sale_date) <= ?"); params.push(end_date); }
      if (min_amount) { where.push("ps.grand_total >= ?"); params.push(toDecimal(min_amount, 0)); }
      if (max_amount) { where.push("ps.grand_total <= ?"); params.push(toDecimal(max_amount, 0)); }

      if (search && search.trim()) {
        const term = `%${search.trim()}%`;
        where.push(`(ps.sale_number LIKE ? OR ps.customer_name LIKE ? OR ps.customer_phone LIKE ?)`);
        params.push(term, term, term);
      }

      const whereClause = where.join(" AND ");
      const offset = (Number(page) - 1) * Number(limit);

      const allowedSort = {
        sale_date: "ps.sale_date",
        grand_total: "ps.grand_total",
        created_at: "ps.created_at",
        sale_number: "ps.sale_number",
      };
      const safeSortBy = allowedSort[sort_by] || "ps.sale_date";
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      const [countResult] = await db.query(
        `SELECT COUNT(*) as total FROM pharmacy_sales ps WHERE ${whereClause}`,
        params
      );

      const [sales] = await db.query(
        `SELECT 
           ps.id, ps.sale_number, ps.customer_id, ps.customer_name, ps.customer_phone,
           ps.sale_date, ps.subtotal, ps.discount_amount, ps.tax_amount, ps.grand_total,
           ps.paid_amount, ps.due_amount,
           ps.payment_method, ps.payment_status, ps.status,
           ps.sold_by, ps.created_at,
           s.name AS sold_by_name,
           cp.email AS customer_email,
           (SELECT COUNT(*) FROM pharmacy_sale_items psi WHERE psi.sale_id = ps.id) AS item_count
         FROM pharmacy_sales ps
         LEFT JOIN staff s ON s.id = ps.sold_by
         LEFT JOIN pharmacy_customer_pos cp ON cp.id = ps.customer_id
         WHERE ${whereClause}
         ORDER BY ${safeSortBy} ${safeSortOrder}
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), offset]
      );

      const [aggregates] = await db.query(
        `SELECT 
           COALESCE(SUM(ps.grand_total), 0) AS total_revenue,
           COALESCE(SUM(ps.paid_amount), 0) AS total_paid,
           COALESCE(SUM(ps.due_amount), 0) AS total_due,
           COUNT(*) AS total_transactions
         FROM pharmacy_sales ps
         WHERE ${whereClause}`,
        params
      );

      return res.json({
        success: true,
        data: sales,
        aggregates: aggregates[0],
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: countResult[0].total,
          total_pages: Math.ceil(countResult[0].total / Number(limit)),
        },
      });
    } catch (err) {
      console.error("List sales error:", err);
      return res.status(500).json({ success: false, message: "Failed to fetch sales" });
    }
  }
);

/* ============================================================
   4. GET SINGLE sale (with items + customer info)
   GET /:id
============================================================ */
router.get(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      if (await denySaleOutsideBranch(req, res, id, tenantAdminId)) return;
      const [sale] = await db.query(
        `SELECT ps.*, s.name AS sold_by_name,
                cp.name AS customer_full_name, cp.email AS customer_email,
                cp.gender AS customer_gender, cp.age AS customer_age
         FROM pharmacy_sales ps
         LEFT JOIN staff s ON s.id = ps.sold_by
         LEFT JOIN pharmacy_customer_pos cp ON cp.id = ps.customer_id
         WHERE ps.id = ? AND ps.admin_id = ?`,
        [id, tenantAdminId]
      );

      if (!sale.length) {
        return res.status(404).json({ success: false, message: "Sale not found" });
      }

      const [items] = await db.query(
        `SELECT 
           psi.id, psi.medicine_id, psi.batch_id,
           psi.quantity, psi.unit_price,
           psi.discount_amount, psi.gst_percentage, psi.tax_amount,
           psi.total_amount, psi.created_at,
           md.medicine_name, md.brand_name, md.dosage_form, md.strength,
           pm.medicine_code, pm.hsn_code,
           pmb.batch_number, pmb.expiry_date, pmb.mrp
         FROM pharmacy_sale_items psi
         JOIN pharmacy_medicines pm         ON pm.id = psi.medicine_id
         JOIN medicine_data md              ON md.id = pm.medicine_data_id
         JOIN pharmacy_medicine_batches pmb ON pmb.id = psi.batch_id
         WHERE psi.sale_id = ?
         ORDER BY psi.id ASC`,
        [id]
      );

      return res.json({
        success: true,
        data: { ...sale[0], items },
      });
    } catch (err) {
      console.error("Get sale error:", err);
      return res.status(500).json({ success: false, message: "Failed to fetch sale" });
    }
  }
);

/* All other endpoints (UPDATE, CANCEL, PAYMENT, RETURN, REPORTS)
   remain as in the previous sales.js — they don't depend on plan_type 
   or customer resolution. Copy them from your existing file. */


   // routes/pharmacy/sales.js — EDIT + CANCEL endpoints
// Using ONLY existing columns — no ALTER TABLE needed
// Add these to your existing sales.js

/* ============================================================
   HELPER: Format audit line for notes field
============================================================ */

/* ============================================================
   HELPER: Append audit line to existing notes
============================================================ */
/* ═══════════════════════════════════════════════════════════
   ENDPOINT: EDIT SALE
   PATCH /:id/edit

   Uses only: status, notes, updated_at (all existing columns)
   Audit info stored in notes as prefixed lines
═══════════════════════════════════════════════════════════ */
// routes/pharmacy/sales.js — EDIT with post-payment restriction
// Add this guard to your existing PATCH /:id/edit endpoint

/* ============================================================
   NEW RULE: After full payment, item changes NOT allowed
   → Customer info, prescription, date: still editable
   → Items, sale-level discount, payment method: BLOCKED
   → Reason: Once money is exchanged, changes must be traceable 
     as returns (creates return record, not silent edit)
============================================================ */

// routes/pharmacy/sales.js — EDIT ROUTE (only existing columns)
// Uses: notes field for audit trail — no new columns needed

/* ============================================================
   HELPER: Format audit line for notes field
============================================================ */


/* ═══════════════════════════════════════════════════════════
   ENDPOINT: EDIT SALE
   PATCH /:id/edit
   
   Rules:
   - Only 'completed' sales can be edited
   - Items/payment: 24h time limit
   - Fully paid sales: only customer info, prescription, sale_date editable
   - Items changes trigger stock restoration + recalculation
   - Refund confirmation required when reducing total below paid amount
═══════════════════════════════════════════════════════════ */
router.patch(
  "/:id/edit",
  authMiddleware,
  allowPermissions("pharmacy.sales.edit"),
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      const tenantAdminId = getTenantAdminId(req);
      const userId = getUserId(req);
      const { id } = req.params;

      const {
        // Customer
        customer_id, customer_name, customer_phone,
        customer_email, customer_gender, customer_age,
        
        // Metadata
        sale_date,
        prescription_id, prescription_photo,
        notes,                          // user-facing notes
        
        // Financial
        payment_method, paid_amount,
        
        // Items
        items,
        
        // Refund confirmation
        confirm_refund,
      } = req.body;

      // Fetch existing sale
      const [existing] = await connection.query(
        `SELECT id, sale_number, status, payment_status,
                grand_total, paid_amount, due_amount,
                subtotal, discount_amount, tax_amount, notes, sale_date,
                created_at, sold_by, branch,
                TIMESTAMPDIFF(HOUR, created_at, NOW()) AS hours_since_sale
         FROM pharmacy_sales 
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({ success: false, message: "Sale not found" });
      }

      const sale = existing[0];

      // Branch — 26 Oct 2026. Edit used to check admin_id only: a staff member could edit
      // another branch's bill, and re-allocating its items (allocateBatches, below) could
      // take stock from ANY branch. Now the bill's own stored branch decides: staff may only
      // edit their branch's bills, and new items come only from that branch's stock.
      let editScope;
      try {
        editScope = await recordScope(connection, req, sale.branch, { notFound: "Sale not found" });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }

      // Status check
      if (sale.status !== "completed") {
        return res.status(400).json({
          success: false,
          message: `Cannot edit '${sale.status}' sale`,
        });
      }

      // Detect what's being edited
      const requestingItemChange = Array.isArray(items) && items.length > 0;
      const requestingFinancialChange = paid_amount !== undefined || payment_method !== undefined;
      const requestingDateChange = sale_date !== undefined;
      const requestingCustomerChange = customer_id !== undefined ||
                                       customer_phone !== undefined ||
                                       customer_name !== undefined;
      const requestingMetadataChange = prescription_id !== undefined ||
                                       prescription_photo !== undefined ||
                                       notes !== undefined;

      /* ═══════════════════════════════════════════════════════════
         🔒 GUARD 1: BLOCK ITEM/FINANCIAL CHANGES IF FULLY PAID
      ═══════════════════════════════════════════════════════════ */
      const isFullyPaid = sale.payment_status === "paid" && Number(sale.due_amount) === 0;

      if (isFullyPaid && (requestingItemChange || requestingFinancialChange)) {
        return res.status(400).json({
          success: false,
          code: "SALE_ALREADY_PAID",
          message: "Cannot modify items or payment on a fully paid sale. Use return endpoint instead.",
          details: {
            sale_number: sale.sale_number,
            payment_status: sale.payment_status,
            paid_amount: Number(sale.paid_amount),
            grand_total: Number(sale.grand_total),
            allowed_edits: ["customer_info", "prescription", "sale_date", "notes"],
            blocked_edits: [
              requestingItemChange ? "items" : null,
              paid_amount !== undefined ? "paid_amount" : null,
              payment_method !== undefined ? "payment_method" : null,
            ].filter(Boolean),
            alternative: {
              full_return: `PATCH /api/pharmacy/sales/${id}/return`,
              partial_return: `PATCH /api/pharmacy/sales/${id}/items/:item_id/return`,
            },
          },
        });
      }

      /* ═══════════════════════════════════════════════════════════
         🔒 GUARD 2: 24-HOUR TIME LIMIT FOR FINANCIAL/ITEM EDITS
      ═══════════════════════════════════════════════════════════ */
      if ((requestingItemChange || requestingFinancialChange) && sale.hours_since_sale > 24) {
        return res.status(400).json({
          success: false,
          message: "Items/payment can only be edited within 24 hours. Use return endpoint for older sales.",
          hours_since_sale: sale.hours_since_sale,
        });
      }

      await connection.beginTransaction();

      const updates = [];
      const params = [];
      let hasChanges = false;
      let refundAmount = 0;
      let collectedMoreAmount = 0;
      const oldGrandTotal = Number(sale.grand_total);
      const oldPaid = Number(sale.paid_amount);

      // ═══════ Customer info ═══════
      if (requestingCustomerChange) {
        const customerResult = await resolveCustomer(req.body, tenantAdminId, connection);
        if (customerResult.error) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: customerResult.error });
        }
        updates.push("customer_id = ?", "customer_name = ?", "customer_phone = ?");
        params.push(
          customerResult.customer_id,
          customerResult.customer_name,
          customerResult.customer_phone
        );
        hasChanges = true;
      }

      // ═══════ Sale date ═══════
      if (requestingDateChange) {
        const newDate = new Date(sale_date);
        if (isNaN(newDate)) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: "Invalid sale_date format" });
        }
        if (newDate > new Date()) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: "sale_date cannot be in the future" });
        }
        updates.push("sale_date = ?");
        params.push(sale_date);
        hasChanges = true;
      }

      // ═══════ Prescription ═══════
      if (prescription_id !== undefined) {
        updates.push("prescription_id = ?");
        params.push(prescription_id || null);
        hasChanges = true;
      }
      if (prescription_photo !== undefined) {
        updates.push("prescription_photo = ?");
        params.push(prescription_photo?.trim() || null);
        hasChanges = true;
      }

      // ═══════ Item changes ═══════
      if (requestingItemChange) {
        // Validate items
        if (items.length > 100) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: "Max 100 items" });
        }
        for (let i = 0; i < items.length; i++) {
          if (!items[i].medicine_id) {
            await connection.rollback();
            return res.status(400).json({
              success: false, message: `Item ${i + 1}: medicine_id required`,
            });
          }
          if (toInt(items[i].quantity, 0) <= 0) {
            await connection.rollback();
            return res.status(400).json({
              success: false, message: `Item ${i + 1}: quantity must be > 0`,
            });
          }
        }

        // Restore old stock, in tablets, through the ledger so the edit is traceable.
        const [oldItems] = await connection.query(
          `SELECT si.batch_id, si.quantity, si.sale_unit, si.units_per_pack, si.tablets,
                  b.units_per_pack AS batch_upp
             FROM pharmacy_sale_items si
             LEFT JOIN pharmacy_medicine_batches b ON b.id = si.batch_id
            WHERE si.sale_id = ?`,
          [id]
        );
        for (const old of oldItems) {
          const line = readSaleLine(old, sale, { units_per_pack: old.batch_upp });
          await recordMove(connection, {
            adminId: tenantAdminId,
            userId: userId,
            batchId: old.batch_id,
            tabletsIn: line.tablets,
            type: "adjustment",
            referenceId: Number(id),
            referenceNumber: sale.sale_number,
            notes: "Returned to stock while editing the sale",
          });
        }

        // Delete old items
        await connection.query(`DELETE FROM pharmacy_sale_items WHERE sale_id = ?`, [id]);

        // Allocate new
        // Re-allocating needs to know whose shelf to take from. A multi-branch bill with no
        // branch (an old admin-made sale the backfill could not attribute) can still have
        // its customer, date or notes edited — only changing its ITEMS is refused.
        if (editScope.scope.multi && !editScope.key) {
          await connection.rollback();
          return res.status(409).json({
            success: false,
            message: "This bill has no branch, so its items can't be changed — there's no telling which branch's stock to use. Cancel it and bill again from the right branch.",
          });
        }
        const { allocations, errors } = await allocateBatches(items, tenantAdminId, connection, true, editScope.bf);
        if (errors.length > 0) {
          await connection.rollback();
          return res.status(400).json({
            success: false, message: "Cannot fulfill edit", errors,
          });
        }

        const { lineItems, subtotal, totalDiscount, totalTax, grandTotal } = computeTotals(allocations);

        // Insert new items + deduct stock, recording the unit each line was sold in.
        for (const li of lineItems) {
          const upp = Number(li.units_per_pack) || 1;
          const saleUnit = upp > 1 ? "strip" : "pack";
          const tabletsOut = tabletsOf(li.quantity, upp);

          await connection.query(
            `INSERT INTO pharmacy_sale_items (
              sale_id, medicine_id, batch_id, quantity,
              sale_unit, units_per_pack, tablets, unit_price,
              discount_amount, gst_percentage, tax_amount, total_amount
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, li.medicine_id, li.batch_id, li.quantity,
             saleUnit, upp, tabletsOut, li.unit_price,
             li.discount_amount, li.gst_percentage, li.tax_amount, li.total_amount]
          );

          await recordMove(connection, {
            adminId: tenantAdminId,
            userId: userId,
            batchId: li.batch_id,
            tabletsOut,
            type: "sale",
            referenceId: Number(id),
            referenceNumber: sale.sale_number,
            notes: `Re-issued on edit (${li.quantity} ${saleUnit})`,
          });
        }

        // Update totals
        updates.push("subtotal = ?", "discount_amount = ?", "tax_amount = ?", "grand_total = ?");
        params.push(subtotal, totalDiscount, totalTax, grandTotal);
        hasChanges = true;

        // ═══════ Payment logic with refund handling ═══════
        const newGrandTotal = grandTotal;
        const requestedPaid = paid_amount !== undefined ? toDecimal(paid_amount, 0) : oldPaid;

        // Scenario A: New total < already paid → REFUND required
        if (newGrandTotal < oldPaid) {
          refundAmount = Math.round((oldPaid - newGrandTotal) * 100) / 100;

          if (!confirm_refund) {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: `This edit reduces total to ₹${newGrandTotal}, but ₹${oldPaid} was already paid. Set 'confirm_refund: true' to process refund of ₹${refundAmount}.`,
              refund_required: refundAmount,
              new_grand_total: newGrandTotal,
              current_paid: oldPaid,
            });
          }

          updates.push("paid_amount = ?", "due_amount = ?", "payment_status = ?");
          params.push(newGrandTotal, 0, "paid");
        }
        // Scenario B: New total > current paid → collect more
        else if (newGrandTotal > oldPaid) {
          collectedMoreAmount = Math.round((newGrandTotal - oldPaid) * 100) / 100;

          if (requestedPaid < 0 || requestedPaid > newGrandTotal) {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: `paid_amount must be between 0 and ${newGrandTotal}`,
            });
          }

          const newDue = Math.round((newGrandTotal - requestedPaid) * 100) / 100;
          updates.push("paid_amount = ?", "due_amount = ?", "payment_status = ?");
          params.push(requestedPaid, newDue, derivePaymentStatus(newGrandTotal, requestedPaid));
        }
        // Scenario C: equal
        else {
          updates.push("paid_amount = ?", "due_amount = ?", "payment_status = ?");
          params.push(newGrandTotal, 0, "paid");
        }
      } else if (requestingFinancialChange) {
        // Financial only (no items)
        const grandTotal = oldGrandTotal;
        const newPaid = paid_amount !== undefined ? toDecimal(paid_amount, 0) : oldPaid;

        if (newPaid < 0 || newPaid > grandTotal) {
          await connection.rollback();
          return res.status(400).json({
            success: false, message: `paid_amount must be between 0 and ${grandTotal}`,
          });
        }
        updates.push("paid_amount = ?", "due_amount = ?", "payment_status = ?");
        params.push(newPaid, grandTotal - newPaid, derivePaymentStatus(grandTotal, newPaid));
        hasChanges = true;

        if (payment_method && VALID_PAYMENT_METHODS.includes(payment_method)) {
          updates.push("payment_method = ?");
          params.push(payment_method);
        }
      }

      // Check hasChanges BEFORE notes update
      if (!hasChanges && notes === undefined) {
        await connection.rollback();
        return res.status(400).json({
          success: false, message: "No fields to update",
        });
      }

      // ═══════ Notes: user notes + audit line ═══════
      const auditExtras = {};
      if (refundAmount > 0) auditExtras.refund = `₹${refundAmount}`;
      if (collectedMoreAmount > 0) auditExtras.collect_more = `₹${collectedMoreAmount}`;
      if (requestingItemChange) auditExtras.items_changed = "yes";
      if (isFullyPaid) auditExtras.on_paid_sale = "yes";

      const auditLine = formatAuditNote("EDIT", userId, auditExtras);
      
      // If user provided new notes, replace user portion; else keep existing
      let baseNotes;
      if (notes !== undefined) {
        // Strip old audit lines from existing notes to isolate user portion,
        // then combine new user notes with old audit history
        const auditLinePattern = /^\[(EDIT|CANCELLED|RETURNED).*?\]$/gm;
        const oldAuditLines = (sale.notes || "").split("\n").filter(l => auditLinePattern.test(l));
        baseNotes = notes?.trim() || "";
        if (oldAuditLines.length > 0) {
          baseNotes = baseNotes ? `${baseNotes}\n${oldAuditLines.join("\n")}` : oldAuditLines.join("\n");
        }
        hasChanges = true;
      } else {
        baseNotes = sale.notes || "";
      }

      const newNotes = appendToNotes(baseNotes, auditLine);
      updates.push("notes = ?");
      params.push(newNotes);

      // Apply all updates
      params.push(id, tenantAdminId);
      await connection.query(
        `UPDATE pharmacy_sales SET ${updates.join(", ")} 
         WHERE id = ? AND admin_id = ?`,
        params
      );

      // Fetch updated sale
      const [updatedSale] = await connection.query(
        `SELECT ps.*, s.name AS sold_by_name,
                cp.name AS customer_full_name, cp.email AS customer_email
         FROM pharmacy_sales ps
         LEFT JOIN staff s ON s.id = ps.sold_by
         LEFT JOIN pharmacy_customer_pos cp ON cp.id = ps.customer_id
         WHERE ps.id = ?`,
        [id]
      );

      const [updatedItems] = await connection.query(
        `SELECT psi.*, md.medicine_name, pmb.batch_number, pmb.expiry_date
         FROM pharmacy_sale_items psi
         JOIN pharmacy_medicines pm ON pm.id = psi.medicine_id
         JOIN medicine_data md ON md.id = pm.medicine_data_id
         JOIN pharmacy_medicine_batches pmb ON pmb.id = psi.batch_id
         WHERE psi.sale_id = ?`,
        [id]
      );

      await connection.commit();

      // Build response
      const responseMeta = {
        was_edited: true,
        edit_summary: {
          items_changed: requestingItemChange,
          payment_changed: requestingFinancialChange,
          date_changed: requestingDateChange,
          customer_changed: requestingCustomerChange,
          notes_changed: notes !== undefined,
          old_grand_total: oldGrandTotal,
          new_grand_total: Number(updatedSale[0].grand_total),
        },
      };

      if (refundAmount > 0) {
        responseMeta.refund_processed = {
          amount: refundAmount,
          message: `Please refund ₹${refundAmount} to customer`,
        };
      }
      if (collectedMoreAmount > 0) {
        responseMeta.additional_collection = {
          amount: collectedMoreAmount,
          message: `Collect ₹${collectedMoreAmount} more from customer`,
        };
      }

      return res.json({
        success: true,
        message: `Sale '${sale.sale_number}' edited successfully`,
        data: { ...updatedSale[0], items: updatedItems },
        meta: responseMeta,
      });
    } catch (err) {
      await connection.rollback();
      console.error("Edit sale error:", err);
      return res.status(500).json({
        success: false, message: "Failed to edit sale", error: err.message,
      });
    } finally {
      connection.release();
    }
  }
);



/// routes/pharmacy/sales.js — CANCEL ROUTE (only existing columns)
// Uses: status, notes — no ALTER TABLE needed
// Cancellation reason stored inside notes field as prefixed audit line

/* ============================================================
   HELPER: Format audit line for notes field
============================================================ */
// The only declaration of this function. There used to be three in this file, and
// because declarations hoist, the last one won for every caller — so the edit route,
// which calls it with three arguments, put its extras object in the `reason` slot and
// wrote "[EDIT ...] [object Object]" into notes, losing the refund metadata.
// `reason` may now be a string or the extras object.
function formatAuditNote(action, userId, reason, extras = {}) {
  const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
  let text = reason;
  let all = extras;
  if (reason && typeof reason === "object") {
    text = "";
    all = { ...reason, ...extras };
  }
  const extraStr = Object.keys(all).length
    ? ` | ${Object.entries(all).map(([k, v]) => `${k}=${v}`).join(", ")}`
    : "";
  return `[${action.toUpperCase()} ${timestamp} by user#${userId}] ${text || ""}${extraStr}`.replace(/\s+$/, "");
}

function appendToNotes(existingNotes, auditLine) {
  if (!existingNotes || !existingNotes.trim()) return auditLine;
  return `${existingNotes}\n${auditLine}`;
}

/* ═══════════════════════════════════════════════════════════
   ENDPOINT: CANCEL SALE
   PATCH /:id/cancel
   
   Rules:
   - Only 'completed' sales can be cancelled
   - Must be within 24 hours of sale creation
   - Cancellation reason required (min 10 chars) — stored in notes
   - Restores all stock to batches
   - Sale row is preserved (soft-cancel via status field)
   - Full audit trail via notes field
═══════════════════════════════════════════════════════════ */
router.patch(
  "/:id/cancel",
  authMiddleware,
  allowPermissions("pharmacy.sales.cancel"),
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      const tenantAdminId = getTenantAdminId(req);
      const userId = getUserId(req);
      const { id } = req.params;
      const { reason } = req.body;

      // Validate reason
      if (!reason || reason.trim().length < 10) {
        return res.status(400).json({
          success: false,
          message: "Cancellation reason is required (min 10 characters)",
        });
      }

      // Fetch existing sale
      const [existing] = await connection.query(
        `SELECT id, sale_number, status, grand_total, paid_amount, 
                notes, created_at, branch,
                TIMESTAMPDIFF(HOUR, created_at, NOW()) AS hours_since_sale
         FROM pharmacy_sales 
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({ success: false, message: "Sale not found" });
      }

      const sale = existing[0];

      // Branch — 26 Oct 2026. Staff may only cancel their own branch's bills (it used to be
      // admin_id only). No stock pin is needed here, unlike edit: a cancel puts each item
      // back into the exact batch it came out of (si.batch_id below), which is by definition
      // the right shelf whatever branch it is in. So a branchless bill can still be
      // cancelled by the admin.
      try {
        await recordScope(db, req, sale.branch, { notFound: "Sale not found" });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }

      // Status checks
      if (sale.status === "cancelled") {
        return res.status(400).json({
          success: false,
          message: "Sale is already cancelled",
        });
      }
      if (sale.status === "returned") {
        return res.status(400).json({
          success: false,
          message: "Cannot cancel a returned sale",
        });
      }

      // Time limit — 24 hours
      if (sale.hours_since_sale > 24) {
        return res.status(400).json({
          success: false,
          message: "Cannot cancel sales older than 24 hours. Use return endpoint instead.",
          hours_since_sale: sale.hours_since_sale,
          alternative: `PATCH /api/pharmacy/sales/${id}/return`,
        });
      }

      await connection.beginTransaction();

      // Fetch items to restore stock
      const [items] = await connection.query(
        `SELECT si.batch_id, si.quantity, si.sale_unit, si.units_per_pack, si.tablets,
                b.units_per_pack AS batch_upp
           FROM pharmacy_sale_items si
           LEFT JOIN pharmacy_medicine_batches b ON b.id = si.batch_id
          WHERE si.sale_id = ?`,
        [id]
      );

      // Restore stock to each batch, in tablets, through the ledger.
      let totalRestored = 0;
      for (const item of items) {
        const line = readSaleLine(item, sale, { units_per_pack: item.batch_upp });
        await recordMove(connection, {
          adminId: tenantAdminId,
          userId: userId,
          batchId: item.batch_id,
          tabletsIn: line.tablets,
          type: "return",
          referenceId: Number(id),
          referenceNumber: sale.sale_number,
          notes: `Sale cancelled — ${item.quantity} ${line.sale_unit} returned to stock`,
        });
        totalRestored += Number(item.quantity) || 0;
      }

      // Build audit line with cancellation metadata
      const auditExtras = {
        amount: `₹${Number(sale.grand_total).toFixed(2)}`,
        items_restored: items.length,
        units_restored: totalRestored,
      };
      if (Number(sale.paid_amount) > 0) {
        auditExtras.refund_needed = `₹${Number(sale.paid_amount).toFixed(2)}`;
      }

      const auditLine = formatAuditNote(
        "CANCELLED",
        userId,
        reason.trim(),
        auditExtras
      );
      const newNotes = appendToNotes(sale.notes, auditLine);

      // Update sale — status + notes only (no new columns)
      await connection.query(
        `UPDATE pharmacy_sales 
         SET status = 'cancelled', notes = ?
         WHERE id = ? AND admin_id = ?`,
        [newNotes, id, tenantAdminId]
      );

      await connection.commit();

      // Build response
      const response = {
        success: true,
        message: `Sale '${sale.sale_number}' cancelled. Stock restored.`,
        data: {
          sale_id: Number(id),
          sale_number: sale.sale_number,
          amount_cancelled: Number(sale.grand_total),
          items_restored: items.length,
          total_units_restored: totalRestored,
          cancelled_by: userId,
          cancelled_at: new Date().toISOString(),
          reason: reason.trim(),
        },
      };

      // Flag if refund needed (customer had paid something)
      if (Number(sale.paid_amount) > 0) {
        response.data.refund_required = {
          amount: Number(sale.paid_amount),
          message: `Refund ₹${Number(sale.paid_amount).toFixed(2)} to customer`,
        };
      }

      return res.json(response);
    } catch (err) {
      await connection.rollback();
      console.error("Cancel sale error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to cancel sale",
      });
    } finally {
      connection.release();
    }
  }
);

/* ═══════════════════════════════════════════════════════════
   ENDPOINT: PARSED AUDIT HISTORY (from notes)
   GET /:id/audit
   
   Parses the notes field to show structured audit trail , it gives every changes made to sales
═══════════════════════════════════════════════════════════ */
router.get(
  "/:id/audit",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      if (await denySaleOutsideBranch(req, res, id, tenantAdminId)) return;
      const [sale] = await db.query(
        `SELECT ps.id, ps.sale_number, ps.status, ps.notes,
                ps.created_at, ps.updated_at, ps.sold_by,
                s.name AS sold_by_name
         FROM pharmacy_sales ps
         LEFT JOIN staff s ON s.id = ps.sold_by
         WHERE ps.id = ? AND ps.admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!sale.length) {
        return res.status(404).json({ success: false, message: "Sale not found" });
      }

      // Parse notes for audit lines
      const auditEvents = [];
      
      // Always add creation
      auditEvents.push({
        action: "CREATED",
        timestamp: sale[0].created_at,
        by_user_id: sale[0].sold_by,
        by_user_name: sale[0].sold_by_name,
        reason: "Sale created",
      });

      // Parse [ACTION timestamp by user#X] reason
      if (sale[0].notes) {
        const auditRegex = /\[(EDIT|CANCELLED|RETURNED)\s+([\d\-\s:]+)\s+by\s+user#(\d+)\]\s*(.*)/g;
        const lines = sale[0].notes.split("\n");
        
        for (const line of lines) {
          const match = /\[(EDIT|CANCELLED|RETURNED)\s+([\d\-\s:]+)\s+by\s+user#(\d+)\]\s*(.*)/.exec(line);
          if (match) {
            auditEvents.push({
              action: match[1],
              timestamp: match[2].trim(),
              by_user_id: parseInt(match[3], 10),
              reason: match[4].trim(),
            });
          }
        }
      }

      // Fetch names for referenced users
      const userIds = [...new Set(auditEvents.map(e => e.by_user_id).filter(id => id))];
      if (userIds.length > 0) {
        const [staff] = await db.query(
          `SELECT id, name FROM staff WHERE id IN (?)`,
          [userIds]
        );
        const nameMap = new Map(staff.map(s => [s.id, s.name]));
        auditEvents.forEach(e => {
          if (!e.by_user_name && e.by_user_id) {
            e.by_user_name = nameMap.get(e.by_user_id) || `User #${e.by_user_id}`;
          }
        });
      }

      return res.json({
        success: true,
        sale_id: Number(id),
        sale_number: sale[0].sale_number,
        current_status: sale[0].status,
        created_at: sale[0].created_at,
        last_updated: sale[0].updated_at,
        audit_trail: auditEvents.reverse(), // newest first
        raw_notes: sale[0].notes,
      });
    } catch (err) {
      console.error("Audit fetch error:", err);
      return res.status(500).json({ success: false, message: "Failed to fetch audit" });
    }
  }
);


// ============================================================
// INVOICE GENERATION ENDPOINT
// GET /api/pharmacy/sales/:id/invoice
//
// Combines data from:
//   - pharmacy_sales           (bill header, totals, payment)
//   - pharmacy_sale_items      (line items)
//   - pharmacy_medicines       (medicine code, HSN)
//   - medicine_data            (name, brand, generic, dosage form)
//   - pharmacy_medicine_batches (batch, expiry, MRP)
//   - admins                   (pharmacy details as seller)
//   - staff                    (cashier name)
//   - pharmacy_customer_pos    (customer extra details)
//
// Returns structured JSON invoice ready for:
//   - Direct print (frontend renders)
//   - PDF generation
//   - Thermal receipt
//   - Email attachment
// ============================================================

router.get(
  "/:id/invoice",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      // Validate ID
      if (!id || isNaN(Number(id))) {
        return res.status(400).json({
          success: false,
          message: "Invalid sale ID",
        });
      }

      // ============================================================
      // 1. FETCH SALE HEADER + PHARMACY + STAFF + CUSTOMER
      // ============================================================

      if (await denySaleOutsideBranch(req, res, id, tenantAdminId)) return;
      const [saleRows] = await db.query(
        `
        SELECT 
          ps.id,
          ps.sale_number,
          ps.customer_id,
          ps.customer_name,
          ps.customer_phone,
          ps.prescription_id,
          ps.prescription_photo,
          ps.doctor_name,
          ps.sale_date,
          ps.subtotal,
          ps.discount_amount,
          ps.tax_amount,
          ps.grand_total,
          ps.paid_amount,
          ps.due_amount,
          ps.payment_method,
          ps.payment_status,
          ps.status,
          ps.notes,
          ps.created_at,
          ps.updated_at,
          
          -- Pharmacy (seller) details
          a.company_name AS pharmacy_name,
          a.address      AS pharmacy_address,
          a.mobile       AS pharmacy_phone,
          a.email        AS pharmacy_email,
          a.company_logo AS pharmacy_logo,
          
          -- Cashier who processed the sale
          s.name  AS sold_by_name,
          
          -- Customer extra details
          cp.email  AS customer_email,
          cp.age    AS customer_age,
          cp.gender AS customer_gender
          
        FROM pharmacy_sales ps
        LEFT JOIN admins a               ON a.id  = ps.admin_id
        LEFT JOIN staff s                ON s.id  = ps.sold_by
        LEFT JOIN pharmacy_customer_pos cp ON cp.id = ps.customer_id
        WHERE ps.id = ? AND ps.admin_id = ?
        LIMIT 1
        `,
        [id, tenantAdminId]
      );

      if (!saleRows.length) {
        return res.status(404).json({
          success: false,
          message: "Sale not found",
        });
      }

      const sale = saleRows[0];

      // ============================================================
      // 2. FETCH SALE LINE ITEMS + MEDICINE + BATCH DETAILS
      // ============================================================

      const [items] = await db.query(
        `
        SELECT 
          psi.id,
          psi.quantity,
          psi.unit_price,
          psi.discount_amount,
          psi.gst_percentage,
          psi.tax_amount,
          psi.total_amount,
          
          -- Medicine details
          md.medicine_name,
          md.brand_name,
          md.generic_name,
          md.dosage_form,
          md.strength,
          
          -- Pharmacy medicine
          pm.medicine_code,
          pm.hsn_code,
          
          -- Batch details (mandatory for pharmacy invoice per GST rules)
          pmb.batch_number,
          pmb.expiry_date,
          pmb.manufacturing_date,
          pmb.mrp
          
        FROM pharmacy_sale_items psi
        JOIN pharmacy_medicines pm          ON pm.id  = psi.medicine_id
        JOIN medicine_data md               ON md.id  = pm.medicine_data_id
        JOIN pharmacy_medicine_batches pmb  ON pmb.id = psi.batch_id
        WHERE psi.sale_id = ?
        ORDER BY psi.id ASC
        `,
        [id]
      );

      if (!items.length) {
        return res.status(404).json({
          success: false,
          message: "No items found for this sale",
        });
      }

      // ============================================================
      // 3. CALCULATE GST BREAKDOWN (CGST + SGST)
      // Indian GST rules require splitting tax into CGST + SGST equally
      // ============================================================

      const gstBreakup = {};
      let totalCgst = 0;
      let totalSgst = 0;

      items.forEach((item) => {
        const gstPct = Number(item.gst_percentage);
        const taxAmt = Number(item.tax_amount);
        const halfGst = gstPct / 2;

        if (!gstBreakup[gstPct]) {
          gstBreakup[gstPct] = {
            gst_rate: gstPct,
            cgst_rate: halfGst,
            sgst_rate: halfGst,
            taxable_amount: 0,
            cgst_amount: 0,
            sgst_amount: 0,
          };
        }

        const gross =
          Number(item.unit_price) * item.quantity -
          Number(item.discount_amount);

        gstBreakup[gstPct].taxable_amount += gross;
        gstBreakup[gstPct].cgst_amount += taxAmt / 2;
        gstBreakup[gstPct].sgst_amount += taxAmt / 2;

        totalCgst += taxAmt / 2;
        totalSgst += taxAmt / 2;
      });

      // Round all breakup numbers to 2 decimals
      Object.values(gstBreakup).forEach((row) => {
        row.taxable_amount = Math.round(row.taxable_amount * 100) / 100;
        row.cgst_amount = Math.round(row.cgst_amount * 100) / 100;
        row.sgst_amount = Math.round(row.sgst_amount * 100) / 100;
      });

      totalCgst = Math.round(totalCgst * 100) / 100;
      totalSgst = Math.round(totalSgst * 100) / 100;

      // ============================================================
      // 4. FORMAT LINE ITEMS FOR DISPLAY
      // ============================================================

      const formattedItems = items.map((item, idx) => ({
        sl_no: idx + 1,
        medicine_name: item.medicine_name,
        brand_name: item.brand_name,
        generic_name: item.generic_name,
        dosage_form: item.dosage_form,
        strength: item.strength,
        medicine_code: item.medicine_code,
        hsn_code: item.hsn_code,

        batch_number: item.batch_number,
        expiry_date: item.expiry_date,
        manufacturing_date: item.manufacturing_date,

        mrp: Number(item.mrp),
        quantity: item.quantity,
        unit_price: Number(item.unit_price),
        discount_amount: Number(item.discount_amount),
        gst_percentage: Number(item.gst_percentage),
        tax_amount: Number(item.tax_amount),
        total_amount: Number(item.total_amount),
      }));

      // ============================================================
      // 5. AMOUNT IN WORDS (Indian invoice requirement)
      // ============================================================

      const amountInWords = numberToWordsIndian(Number(sale.grand_total));

      // ============================================================
      // 6. BUILD INVOICE OBJECT
      // ============================================================

      const invoice = {
        // ---- Invoice metadata ----
        invoice_type: "TAX INVOICE",
        invoice_number: sale.sale_number,
        invoice_date: sale.sale_date,
        status: sale.status,
        is_cancelled: sale.status === "cancelled",
        is_returned: sale.status === "returned",

        // ---- Pharmacy (seller) details ----
        pharmacy: {
          name: sale.pharmacy_name || "Pharmacy",
          address: sale.pharmacy_address,
          phone: sale.pharmacy_phone,
          email: sale.pharmacy_email,
          logo: sale.pharmacy_logo,
        },

        // ---- Customer (buyer) details ----
        customer: {
          id: sale.customer_id,
          name: sale.customer_name || "Walk-in Customer",
          phone: sale.customer_phone,
          email: sale.customer_email,
          age: sale.customer_age,
          gender: sale.customer_gender,
        },

        // ---- Prescription (if applicable) ----
        prescription: sale.prescription_id ||
                      sale.prescription_photo ||
                      sale.doctor_name
          ? {
              prescription_id: sale.prescription_id,
              prescription_photo: sale.prescription_photo,
              doctor_name: sale.doctor_name,
              has_prescription: true,
            }
          : {
              has_prescription: false,
              doctor_name: null,
            },

        // ---- Line items ----
        items: formattedItems,
        item_count: formattedItems.length,
        total_units: formattedItems.reduce(
          (s, i) => s + i.quantity,
          0
        ),

        // ---- Totals ----
        totals: {
          subtotal: Number(sale.subtotal),
          discount_amount: Number(sale.discount_amount),
          taxable_amount:
            Math.round(
              (Number(sale.subtotal) - Number(sale.discount_amount)) * 100
            ) / 100,
          cgst_amount: totalCgst,
          sgst_amount: totalSgst,
          total_tax: Number(sale.tax_amount),
          grand_total: Number(sale.grand_total),
          amount_in_words: amountInWords,
        },

        // ---- GST breakdown by rate (Indian invoice legal requirement) ----
        gst_breakup: Object.values(gstBreakup),

        // ---- Payment info ----
        payment: {
          method: sale.payment_method,
          status: sale.payment_status,
          paid_amount: Number(sale.paid_amount),
          due_amount: Number(sale.due_amount),
        },

        // ---- Meta ----
        sold_by: sale.sold_by_name || "Staff",
        notes: sale.notes,
        created_at: sale.created_at,
        updated_at: sale.updated_at,
        generated_at: new Date().toISOString(),

        // ---- Legal footer ----
        terms: [
          "Goods once sold cannot be returned without proper receipt",
          "All disputes subject to local jurisdiction",
          "E-invoice generated electronically",
        ],
      };

      // ============================================================
      // 7. RESPONSE
      // ============================================================

      return res.json({
        success: true,
        message: "Invoice generated successfully",
        data: invoice,
      });

    } catch (err) {
      console.error("Invoice generation error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to generate invoice",
        ...(process.env.NODE_ENV !== "production" && {
          error: err.message,
        }),
      });
    }
  }
);

/* ============================================================
   HELPER: Convert number to Indian words
   Required by Indian tax law on printed invoices
   
   Examples:
     235.50    → "Two Hundred Thirty Five Rupees and Fifty Paise Only"
     1000      → "One Thousand Rupees Only"
     125000    → "One Lakh Twenty Five Thousand Rupees Only"
     12500000  → "One Crore Twenty Five Lakh Rupees Only"
============================================================ */
function numberToWordsIndian(num) {
  if (num === 0) return "Zero Rupees Only";

  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven",
    "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
    "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen",
    "Nineteen",
  ];
  const tens = [
    "", "", "Twenty", "Thirty", "Forty", "Fifty",
    "Sixty", "Seventy", "Eighty", "Ninety",
  ];

  function twoDigit(n) {
    if (n < 20) return ones[n];
    return (
      tens[Math.floor(n / 10)] +
      (n % 10 !== 0 ? " " + ones[n % 10] : "")
    );
  }

  function threeDigit(n) {
    let str = "";
    if (n >= 100) {
      str = ones[Math.floor(n / 100)] + " Hundred ";
      n = n % 100;
    }
    if (n > 0) str += twoDigit(n);
    return str.trim();
  }

  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);

  let words = "";
  let n = rupees;

  const crore = Math.floor(n / 10000000);
  n = n % 10000000;
  const lakh = Math.floor(n / 100000);
  n = n % 100000;
  const thousand = Math.floor(n / 1000);
  n = n % 1000;

  if (crore) words += threeDigit(crore) + " Crore ";
  if (lakh) words += threeDigit(lakh) + " Lakh ";
  if (thousand) words += threeDigit(thousand) + " Thousand ";
  if (n) words += threeDigit(n);

  words = words.trim() + " Rupees";

  if (paise > 0) {
    words += " and " + twoDigit(paise) + " Paise";
  }

  return words + " Only";
}


// GET /api/pharmacy/sales/reports/today
router.get(
  "/reports/today",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    // Wrapped: without a try/catch a DB error here became an unhandled rejection.
    try {
      const tenantAdminId = getTenantAdminId(req);
      let tScope;
      try {
        tScope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }
      const tB = tScope.filter ? historyBranchSql("") : "";
      const tP = tScope.filter ? [tScope.key] : [];
      const [rows] = await db.query(
        `SELECT 
           COUNT(*) AS total_bills,
           COALESCE(SUM(grand_total), 0) AS total_amount,
           COALESCE(SUM(paid_amount), 0) AS total_paid,
           COALESCE(SUM(due_amount), 0) AS total_due
         FROM pharmacy_sales 
         WHERE admin_id = ? AND DATE(sale_date) = CURDATE() AND status = 'completed'${tB}`,
        [tenantAdminId, ...tP]
      );
      return res.json({ success: true, ...rows[0] });
    } catch (err) {
      console.error("Today report error:", err);
      return res.status(500).json({ success: false, message: "Failed to load today's figures" });
    }
  }
);

// GET /api/pharmacy/sales/reports/month
router.get(
  "/reports/month",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      let mScope;
      try {
        mScope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }
      const mB = mScope.filter ? historyBranchSql("") : "";
      const mP = mScope.filter ? [mScope.key] : [];
      const [rows] = await db.query(
        `SELECT 
           COALESCE(SUM(grand_total), 0) AS total_amount,
           COALESCE(SUM(due_amount), 0) AS outstanding
         FROM pharmacy_sales
         WHERE admin_id = ? 
           AND MONTH(sale_date) = MONTH(CURDATE())
           AND YEAR(sale_date) = YEAR(CURDATE())
           AND status = 'completed'${mB}`,
        [tenantAdminId, ...mP]
      );
      return res.json({ success: true, ...rows[0] });
    } catch (err) {
      console.error("Month report error:", err);
      return res.status(500).json({ success: false, message: "Failed to load this month's figures" });
    }
  }
);


// pharmacySales.js
// This route had no permission gate and read req.user.admin_id — snake_case, which the
// token never carries, so the bind was undefined and the request crashed. It now uses
// the same tenant helper as every other route, and is gated like the other sale reads.
router.get(
  "/by-number/:sale_number",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
  try {
  const admin_id = getTenantAdminId(req);
  const [[sale]] = await db.query(
    `SELECT * FROM pharmacy_sales WHERE admin_id = ? AND sale_number = ? LIMIT 1`,
    [admin_id, req.params.sale_number]
  );
  if (!sale) return res.status(404).json({ success: false, message: "Sale not found" });
  // Branch — 26 Oct 2026: a bill number from another branch answers 404 for staff.
  try {
    await recordScope(db, req, sale.branch, { notFound: "Sale not found" });
  } catch (e) {
    if (sendBranchError(res, e)) return;
    throw e;
  }
  const [items] = await db.query(
    `SELECT si.*, md.medicine_name, md.strength, b.batch_number
       FROM pharmacy_sale_items si
       JOIN pharmacy_medicines m ON m.id = si.medicine_id
       -- L1: the name lives in the shared catalogue, not on pharmacy_medicines
       JOIN medicine_data md ON md.id = m.medicine_data_id
       JOIN pharmacy_medicine_batches b ON b.id = si.batch_id
      WHERE si.sale_id = ? AND b.admin_id = ?`,
    [sale.id, admin_id]
  );
  res.json({ success: true, data: { ...sale, items } });
  } catch (err) {
    console.error("Get sale by number error:", err);
    return res.status(500).json({ success: false, message: "Failed to load sale" });
  }
});




module.exports = router;