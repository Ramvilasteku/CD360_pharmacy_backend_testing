// routes/pharmacy/batches.js
//
// UNITS (see utils/pharmacyUnits.js)
//   • quantity_received / quantity_available / free_quantity are TABLETS
//     (a capsule / sachet = 1; a syrup / tube / injection = 1 per pack)
//   • units_per_pack = tablets in one strip of THIS batch (the packing it arrived in).
//     Defaults to the medicine's. It can only change while the batch has never moved — except
//     1 → N: a batch counted in packs is RE-PACKED (quantities × N + ledger row), see repackBatch().
//   • purchase_price / selling_price / mrp are PER STRIP
//
// BRANCHES (see utils/pharmacyBranch.js)
//   • new batches are stamped with the branch they arrive in (resolveScope forWrite)
//   • lists show the caller's branch (staff) or all branches / ?branch= (admin)
//   • a batch can only be changed from its own branch (staff); the admin may change any
//
// Every quantity change goes through recordMove() (batch + stock ledger, one transaction).
//
// Route order matters: the fixed paths (/expiring, /reports/*, /medicine/*, /update/*) are
// declared BEFORE /:id so "/expiring" is never read as a batch id.

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
const { unitsPerPack, cleanUnitsPerPack, describeStock, packWord, splitTablets, plural } = require("../../utils/pharmacyUnits");
const {
  BranchError, branchKey, getActor, staffBranches, stockBranches, findBranch, resolveScope, batchFilter, sendBranchError,
} = require("../../utils/pharmacyBranch");
const { recordMove, ledgerRow, istToday } = require("../../utils/pharmacyStock");

/* ============================================================
   Helper: resolve tenant admin_id from req.user
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

/* ============================================================
   Helper: validate numeric input safely
============================================================ */
function toDecimal(val, fallback = 0) {
  if (val === undefined || val === null || val === "") return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

function toInt(val, fallback = 0) {
  if (val === undefined || val === null || val === "") return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

/** Whole, non-negative tablet count, or null when it isn't one. */
function toCount(val) {
  if (val === undefined || val === null || val === "") return 0;
  const n = typeof val === "number" ? val : Number(String(val).trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/* ============================================================
   Helper: validate date (YYYY-MM-DD)
============================================================ */
function isValidDate(val) {
  if (!val) return false;
  const d = new Date(val);
  return d instanceof Date && !isNaN(d);
}

/* ============================================================
   Helper: shelf / location text (≤ 100 characters)
============================================================ */
function cleanLocation(val) {
  if (val === undefined) return undefined;
  if (val === null) return null;
  if (typeof val === "number") val = String(val);
  if (typeof val !== "string") {
    const e = new Error("Location must be text");
    e.status = 400;
    throw e;
  }
  const s = val.trim().replace(/\s+/g, " ");
  if (s.length > 100) {
    const e = new Error("Location can be at most 100 characters");
    e.status = 400;
    throw e;
  }
  return s || null;
}

/** A 400 / 404 / 409 thrown by a helper → JSON. Returns true when handled. */
function sendKnownError(res, err) {
  if (sendBranchError(res, err)) return true;
  if (err && [400, 403, 404, 409].includes(err.status)) {
    res.status(err.status).json({ success: false, message: err.message, ...(err.extra || {}) });
    return true;
  }
  return false;
}

/** A DATE column as "YYYY-MM-DD", whether the driver gives a string or a Date. */
const ymd = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
};

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/**
 * Adds the unit + location + status fields to a batch row.
 *   units_per_pack   this batch's (never null)
 *   stock_text       "12 strips + 5 tablets"
 *   location         the batch's shelf, else the medicine's default shelf
 *   stock_status     blocked | expired | empty | expiring (≤ 90 days) | ok
 */
function decorateBatch(r, today = istToday()) {
  const upp = unitsPerPack(r);
  const word = packWord({ unit: r.unit }, upp);
  const qa = Number(r.quantity_available) || 0;
  const expiry = ymd(r.expiry_date);
  r.units_per_pack = upp;
  r.pack_word = word;
  r.stock_text = describeStock(qa, upp, word);
  r.full_strips = splitTablets(qa, upp).strips;
  r.loose_tablets = splitTablets(qa, upp).loose;
  r.received_text = describeStock((Number(r.quantity_received) || 0) + (Number(r.free_quantity) || 0), upp, word);
  if (r.medicine_location !== undefined) {
    r.location = r.storage_location || r.medicine_location || null;
    r.location_is_default = !r.storage_location && !!r.medicine_location;
  } else {
    r.location = r.storage_location || null;
  }
  if (expiry) r.days_to_expiry = daysBetween(today, expiry);
  r.stock_status =
    r.status === "blocked"
      ? "blocked"
      : r.status === "expired" || (expiry && expiry < today)
        ? "expired"
        : qa <= 0
          ? "empty"
          : r.days_to_expiry != null && r.days_to_expiry <= 90
            ? "expiring"
            : "ok";
  if (r.reorder_level !== undefined && r.medicine_stock_strips !== undefined) {
    const level = Number(r.reorder_level) || 0;
    r.medicine_low_stock = level > 0 && (Number(r.medicine_stock_strips) || 0) < level;
  }
  return r;
}

/** Stock per medicine in scope (strips counted per batch) — for the low-stock filter. */
function stockJoin(scope, adminId, today) {
  const f = batchFilter(scope, "s");
  return {
    sql: `LEFT JOIN (
            SELECT s.medicine_id,
                   SUM(FLOOR(s.quantity_available / GREATEST(s.units_per_pack, 1))) AS stock_strips
              FROM pharmacy_medicine_batches s
             WHERE s.admin_id = ? AND s.status = 'active' AND s.expiry_date >= ?
               AND s.quantity_available > 0 ${f.sql}
             GROUP BY s.medicine_id
          ) st ON st.medicine_id = pm.id`,
    params: [adminId, today, ...f.params],
  };
}

/**
 * The batch, locked when a connection is given, checked against the caller's branch.
 * Staff may only touch batches of their own branch; the admin may touch any (or must match
 * the branch they picked).
 */
async function loadBatchForWrite(q, req, id, { lock = false } = {}) {
  const tenantAdminId = getTenantAdminId(req);
  const [rows] = await q.query(
    `SELECT pmb.*, md.medicine_name, pm.unit, pm.pack_size AS medicine_pack_size
       FROM pharmacy_medicine_batches pmb
       JOIN pharmacy_medicines pm ON pm.id = pmb.medicine_id
       JOIN medicine_data md      ON md.id = pm.medicine_data_id
      WHERE pmb.id = ? AND pmb.admin_id = ? LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [id, tenantAdminId]
  );
  if (!rows.length) {
    const e = new Error("Batch not found");
    e.status = 404;
    throw e;
  }
  const b = rows[0];
  const scope = await resolveScope(q, req, { wanted: (req.body && req.body.branch) || req.query.branch });
  if (scope.filter && branchKey(b.branch) !== scope.key) {
    throw new BranchError(403, `Batch ${b.batch_number} belongs to ${b.branch ? `the ${b.branch} branch` : "no branch"}.`);
  }
  return { batch: b, scope };
}

/* the columns every batch list returns */
const BATCH_COLUMNS = `
           pmb.id, pmb.medicine_id, pmb.batch_number, pmb.branch,
           pmb.units_per_pack, pmb.storage_location,
           pmb.manufacturing_date, pmb.expiry_date,
           pmb.purchase_price, pmb.selling_price, pmb.mrp,
           pmb.quantity_received, pmb.quantity_available, pmb.free_quantity,
           pmb.supplier_id, pmb.status, pmb.created_at, pmb.updated_at,
           md.medicine_name, md.brand_name, md.dosage_form, md.strength,
           pm.medicine_code, pm.barcode, pm.unit, pm.pack_size,
           pm.storage_location AS medicine_location, pm.reorder_level,
           ps.supplier_name`;

const BATCH_FROM = `
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm      ON pm.id = pmb.medicine_id
         JOIN medicine_data md           ON md.id = pm.medicine_data_id
         LEFT JOIN pharmacy_suppliers ps ON ps.id = pmb.supplier_id`;

async function fetchBatches(ids, today = istToday()) {
  if (!ids.length) return [];
  const [rows] = await db.query(`SELECT ${BATCH_COLUMNS} ${BATCH_FROM} WHERE pmb.id IN (?) ORDER BY pmb.id ASC`, [ids]);
  return rows.map((r) => decorateBatch(r, today));
}

/* ============================================================
   Helper: validate one new batch (shared by /post and /bulk)
   Returns { error } or { row } with clean values. Quantities are TABLETS.
============================================================ */
function checkNewBatch(b, today) {
  if (!b || typeof b !== "object") return { error: "batch must be an object" };
  if (!b.medicine_id) return { error: "medicine_id is required" };
  if (!b.batch_number || !String(b.batch_number).trim()) return { error: "batch_number is required" };
  if (String(b.batch_number).trim().length > 100) return { error: "batch_number can be at most 100 characters" };
  if (!b.expiry_date || !isValidDate(b.expiry_date)) return { error: "expiry_date is required and must be a valid date (YYYY-MM-DD)" };
  if (String(b.expiry_date).slice(0, 10) < today) return { error: "Expiry date cannot be in the past" };
  if (b.manufacturing_date) {
    if (!isValidDate(b.manufacturing_date)) return { error: "manufacturing_date must be a valid date (YYYY-MM-DD)" };
    if (String(b.manufacturing_date).slice(0, 10) > String(b.expiry_date).slice(0, 10)) {
      return { error: "Manufacturing date cannot be after expiry date" };
    }
  }
  const qtyReceived = toCount(b.quantity_received);
  const freeQty = toCount(b.free_quantity);
  if (qtyReceived === null || freeQty === null) return { error: "Quantities must be whole numbers of tablets (not negative)" };
  if (qtyReceived === 0 && freeQty === 0) return { error: "At least one of quantity_received or free_quantity must be > 0" };
  if ([b.purchase_price, b.selling_price, b.mrp].some((v) => v !== undefined && v !== null && v !== "" && Number.isNaN(Number(v)))) {
    return { error: "Prices must be numbers" };
  }
  const purchase = toDecimal(b.purchase_price, 0);
  const selling = toDecimal(b.selling_price, 0);
  const mrp = toDecimal(b.mrp, 0);
  if (purchase < 0 || selling < 0 || mrp < 0) return { error: "Prices cannot be negative" };
  if (mrp > 0 && selling > mrp) return { error: "Selling price can't be more than the MRP (both per strip)" };
  let upp;
  let location;
  try {
    upp = cleanUnitsPerPack(b.units_per_pack);
    location = cleanLocation(b.storage_location);
  } catch (e) {
    return { error: e.message };
  }
  return {
    row: {
      medicine_id: b.medicine_id,
      batch_number: String(b.batch_number).trim(),
      manufacturing_date: b.manufacturing_date || null,
      expiry_date: String(b.expiry_date).slice(0, 10),
      purchase,
      selling: selling || mrp, // the selling price defaults to the MRP
      mrp,
      qtyReceived,
      freeQty,
      upp, // null → the medicine's default
      location, // undefined / null → the medicine's default shelf
      supplier_id: b.supplier_id || null,
    },
  };
}

/** INSERT one batch (with its branch, pack size and shelf) + its opening ledger row. */
async function insertBatch(conn, { tenantAdminId, userId, row, medicine, branch }) {
  const upp = row.upp || unitsPerPack(medicine);
  const location = row.location || medicine.storage_location || null;
  const qtyAvailable = row.qtyReceived + row.freeQty;
  const [result] = await conn.query(
    `INSERT INTO pharmacy_medicine_batches (
      admin_id, branch, medicine_id, batch_number, units_per_pack, storage_location,
      manufacturing_date, expiry_date,
      purchase_price, selling_price, mrp,
      quantity_received, quantity_available, free_quantity,
      supplier_id, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      tenantAdminId,
      branch || null,
      row.medicine_id,
      row.batch_number,
      upp,
      location,
      row.manufacturing_date,
      row.expiry_date,
      row.purchase,
      row.selling,
      row.mrp,
      row.qtyReceived,
      qtyAvailable,
      row.freeQty,
      row.supplier_id,
    ]
  );
  await ledgerRow(conn, {
    adminId: tenantAdminId,
    userId,
    batchId: result.insertId,
    medicineId: row.medicine_id,
    type: "opening_stock",
    tabletsIn: qtyAvailable,
    referenceId: result.insertId,
    referenceNumber: row.batch_number,
    notes: `Batch ${row.batch_number} added with ${describeStock(qtyAvailable, upp, packWord(medicine, upp))}`,
  });
  return result.insertId;
}

/**
 * RE-PACK one batch that was counted in packs (units_per_pack = 1) as strips of `upp` tablets.
 * Used when the migration couldn't read a medicine's pack size and its batches were left at 1:
 * received / available / free are all multiplied by upp, units_per_pack becomes upp, and one
 * ledger row records the tablets added. The batch must already be locked (FOR UPDATE) by the caller.
 * Returns { batch_id, batch_number, branch, packs, tablets } or null when there is nothing to do.
 */
async function repackBatch(conn, { adminId, userId, batch, upp }) {
  if (Number(batch.units_per_pack) !== 1 || !(upp > 1)) return null;
  const packs = Number(batch.quantity_available) || 0;
  const tablets = packs * upp;
  await conn.query(
    `UPDATE pharmacy_medicine_batches
        SET units_per_pack = ?, quantity_received = quantity_received * ?,
            quantity_available = quantity_available * ?, free_quantity = free_quantity * ?, updated_at = NOW()
      WHERE id = ? AND admin_id = ? AND units_per_pack = 1`,
    [upp, upp, upp, upp, batch.id, adminId]
  );
  await ledgerRow(conn, {
    adminId,
    userId,
    batchId: batch.id,
    medicineId: batch.medicine_id,
    type: "adjustment",
    tabletsIn: tablets - packs,
    referenceId: batch.id,
    referenceNumber: batch.batch_number,
    notes: `Pack size set to ${upp} per strip: ${packs} ${packs === 1 ? "pack" : "packs"} counted as ${tablets} tablets`,
  });
  return { batch_id: Number(batch.id), batch_number: batch.batch_number, branch: batch.branch || null, packs, tablets };
}


/* ============================================================
   LEGACY STRIPS MODE — lets the POS screens read this endpoint unchanged

   This router counts stock in TABLETS and says so in `stock_text`
   ("12 strips + 5 tablets"), which the Inventory screens render.
   The POS screens are older: they read `quantity_available` straight into a
   quantity stepper and treat it as whole STRIPS.

   Rather than change either screen, the response adapts to the caller:

     ?units=strips | ?units=tablets    explicit, always wins
     otherwise, a request carrying any paging / sorting / filter parameter
       (page, limit, sort_by, sort_order, in_stock_only, unassigned, view,
        stock, location, expiring_in_days) is an Inventory-style request
        and gets TABLETS;
     anything else — i.e. the bare `?medicine_id=..&status=active` the POS
       sends — gets STRIPS.

   Every row carries BOTH numbers whichever mode is in force, so any new
   caller can be explicit and never has to guess:
     quantity_available_tablets, quantity_available_strips
============================================================ */
const INVENTORY_PARAMS = [
  "page", "limit", "sort_by", "sort_order", "in_stock_only",
  "unassigned", "view", "stock", "location", "expiring_in_days",
];

function wantsStrips(req) {
  const u = String((req.query && req.query.units) || "").trim().toLowerCase();
  if (u === "strips" || u === "strip") return true;
  if (u === "tablets" || u === "tablet") return false;
  return !INVENTORY_PARAMS.some((k) => req.query && req.query[k] !== undefined);
}

/** Always add both representations; swap quantity_available when strips are wanted. */
function applyUnitView(rows, strips) {
  const list = Array.isArray(rows) ? rows : [rows];
  for (const r of list) {
    if (!r) continue;
    const tablets = Number(r.quantity_available) || 0;
    const upp = Math.max(1, Number(r.units_per_pack) || 1);
    const whole = r.full_strips !== undefined ? Number(r.full_strips) : Math.floor(tablets / upp);
    r.quantity_available_tablets = tablets;
    r.quantity_available_strips = whole;
    if (strips) {
      r.quantity_available = whole;
      r.quantity_received = Math.floor((Number(r.quantity_received) || 0) / upp);
      r.free_quantity = Math.floor((Number(r.free_quantity) || 0) / upp);
    }
  }
  return rows;
}

/* ============================================================
   BULK CREATE batches (add multiple batches in one transaction)
   Access:
     - admin (bypass — tenant owner)
     - any staff role with 'pharmacy.batches.create' permission

   Body:
     {
       "branch": "Kukatpally",          // admin of a multi-branch pharmacy: required
       "batches": [
         {
           "medicine_id": 1,
           "batch_number": "GSK-4402",
           "expiry_date": "2028-03-31",
           "quantity_received": 100,       // TABLETS
           "free_quantity": 10,            // TABLETS
           "units_per_pack": 10,           // optional — default: the medicine's
           "storage_location": "Rack B",   // optional — default: the medicine's shelf
           ...
         },
         { ... },
         { ... }
       ]
     }

   Behavior:
     - ALL batches must pass validation → all inserted
     - ANY validation failure → NOTHING inserted (transaction rollback)
     - Each new batch gets an opening_stock ledger row
============================================================ */
router.post(
  "/bulk",
  authMiddleware,
  allowPermissions("pharmacy.medicines.create"),
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      const tenantAdminId = getTenantAdminId(req);
      const { batches } = req.body;

      // ── Basic validation ──
      if (!Array.isArray(batches) || batches.length === 0) {
        return res.status(400).json({
          success: false,
          message: "batches array is required and must not be empty",
        });
      }

      if (batches.length > 100) {
        return res.status(400).json({
          success: false,
          message: "Cannot create more than 100 batches in one request",
        });
      }

      // ── Which branch the stock arrives in ──
      const scope = await resolveScope(connection, req, { wanted: req.body.branch, forWrite: true });

      // ── Pre-validate ALL batches BEFORE starting transaction ──
      const validationErrors = [];
      const clean = [];
      const today = istToday();

      for (let i = 0; i < batches.length; i++) {
        const { error, row } = checkNewBatch(batches[i], today);
        if (error) validationErrors.push({ index: i, error });
        else clean.push(row);
      }

      // If any validation failed, reject the whole batch
      if (validationErrors.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Validation failed for one or more batches. Nothing inserted.",
          errors: validationErrors,
        });
      }

      // ── Verify all medicines belong to tenant (one query) ──
      const medicineIds = [...new Set(clean.map((b) => Number(b.medicine_id)))];
      const [medicines] = await connection.query(
        `SELECT pm.id, pm.units_per_pack, pm.pack_size, pm.unit, pm.storage_location, md.medicine_name
         FROM pharmacy_medicines pm
         JOIN medicine_data md ON md.id = pm.medicine_data_id
         WHERE pm.admin_id = ? AND pm.status = 'active'
           AND pm.id IN (?)`,
        [tenantAdminId, medicineIds]
      );

      const medicineById = new Map(medicines.map((m) => [Number(m.id), m]));
      const invalidMedicines = medicineIds.filter((id) => !medicineById.has(id));

      if (invalidMedicines.length > 0) {
        return res.status(404).json({
          success: false,
          message: "One or more medicines not found in your inventory",
          missing_medicine_ids: invalidMedicines,
        });
      }

      // ── Verify all suppliers belong to tenant (one query) ──
      const supplierIds = [...new Set(clean.map((b) => b.supplier_id).filter(Boolean))];
      if (supplierIds.length > 0) {
        const [suppliers] = await connection.query(
          `SELECT id FROM pharmacy_suppliers
           WHERE admin_id = ? AND id IN (?)`,
          [tenantAdminId, supplierIds]
        );

        const validSupplierIds = new Set(suppliers.map((s) => Number(s.id)));
        const invalidSuppliers = supplierIds.filter((id) => !validSupplierIds.has(Number(id)));

        if (invalidSuppliers.length > 0) {
          return res.status(404).json({
            success: false,
            message: "One or more suppliers not found in your organization",
            missing_supplier_ids: invalidSuppliers,
          });
        }
      }

      // ── Check for duplicates within the request itself ──
      const uniqueKeys = new Set();
      for (let i = 0; i < clean.length; i++) {
        const key = `${clean[i].medicine_id}-${clean[i].batch_number.toLowerCase()}`;
        if (uniqueKeys.has(key)) {
          return res.status(400).json({
            success: false,
            message: `Duplicate entry in request: medicine_id=${clean[i].medicine_id}, batch_number=${clean[i].batch_number}`,
            index: i,
          });
        }
        uniqueKeys.add(key);
      }

      // ── Check for duplicates against existing DB records ──
      const dupParams = [];
      const dupConditions = clean
        .map((b) => {
          dupParams.push(tenantAdminId, b.medicine_id, b.batch_number);
          return "(admin_id = ? AND medicine_id = ? AND batch_number = ?)";
        })
        .join(" OR ");

      const [dupExisting] = await connection.query(
        `SELECT medicine_id, batch_number FROM pharmacy_medicine_batches
         WHERE ${dupConditions}`,
        dupParams
      );

      if (dupExisting.length > 0) {
        return res.status(409).json({
          success: false,
          message: "One or more batches already exist",
          existing_batches: dupExisting,
        });
      }

      // ── Start transaction ──
      await connection.beginTransaction();

      const insertedIds = [];

      for (const row of clean) {
        insertedIds.push(
          await insertBatch(connection, {
            tenantAdminId,
            userId: req.user.id,
            row,
            medicine: medicineById.get(Number(row.medicine_id)),
            branch: scope.branch,
          })
        );
      }

      await connection.commit();

      // ── Return all created rows with joined info ──
      const newRows = await fetchBatches(insertedIds);

      return res.status(201).json({
        success: true,
        message: `${insertedIds.length} batches created successfully`,
        count: insertedIds.length,
        data: newRows,
      });
    } catch (err) {
      await connection.rollback().catch(() => {});
      if (sendKnownError(res, err)) return;
      console.error("Bulk create batches error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create batches",
      });
    } finally {
      connection.release();
    }
  }
);

/* ============================================================
   CREATE batch (add stock to inventory)
   Access:
     - admin (bypass — tenant owner)
     - any staff role with 'pharmacy.batches.create' permission
   Body: medicine_id, batch_number, expiry_date, manufacturing_date,
         purchase_price / selling_price / mrp (PER STRIP),
         quantity_received / free_quantity (TABLETS),
         units_per_pack (default: the medicine's), storage_location (default: the medicine's shelf),
         supplier_id, branch (admin of a multi-branch pharmacy)
============================================================ */
router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.medicines.create"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const tenantAdminId = getTenantAdminId(req);

      // ── Field validation ──
      const { error, row } = checkNewBatch(req.body, istToday());
      if (error) {
        return res.status(400).json({ success: false, message: error });
      }

      const scope = await resolveScope(conn, req, { wanted: req.body.branch, forWrite: true });

      // ── Verify medicine belongs to this tenant ──
      const [medicineCheck] = await conn.query(
        `SELECT pm.id, pm.units_per_pack, pm.pack_size, pm.unit, pm.storage_location, md.medicine_name
         FROM pharmacy_medicines pm
         JOIN medicine_data md ON md.id = pm.medicine_data_id
         WHERE pm.id = ? AND pm.admin_id = ? AND pm.status = 'active' LIMIT 1`,
        [row.medicine_id, tenantAdminId]
      );

      if (!medicineCheck.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found in your inventory",
        });
      }

      // ── Verify supplier belongs to this tenant (if provided) ──
      if (row.supplier_id) {
        const [supplierCheck] = await conn.query(
          `SELECT id FROM pharmacy_suppliers
           WHERE id = ? AND admin_id = ? LIMIT 1`,
          [row.supplier_id, tenantAdminId]
        );

        if (!supplierCheck.length) {
          return res.status(404).json({
            success: false,
            message: "Supplier not found in your organization",
          });
        }
      }

      // ── Duplicate check: same medicine + batch_number ──
      const [existing] = await conn.query(
        `SELECT id FROM pharmacy_medicine_batches
         WHERE admin_id = ? AND medicine_id = ? AND batch_number = ? LIMIT 1`,
        [tenantAdminId, row.medicine_id, row.batch_number]
      );

      if (existing.length) {
        return res.status(409).json({
          success: false,
          message: `Batch '${row.batch_number}' already exists for this medicine`,
          existing_id: existing[0].id,
        });
      }

      // ── Insert + opening ledger row, together ──
      await conn.beginTransaction();
      const id = await insertBatch(conn, {
        tenantAdminId,
        userId: req.user.id,
        row,
        medicine: medicineCheck[0],
        branch: scope.branch,
      });
      await conn.commit();

      const [newRow] = await fetchBatches([id]);

      return res.status(201).json({
        success: true,
        message: "Batch created successfully",
        data: newRow,
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (sendKnownError(res, err)) return;
      console.error("Create batch error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create batch",
      });
    } finally {
      conn.release();
    }
  }
);

/* ============================================================
   LIST batches (with search, filter, pagination)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.batches.view' permission
   Query params:
     - branch              : admin only — one branch (default: all branches); staff always see their own
     - search              : matches batch_number, medicine_name, brand, code, location
     - status              : 'active' | 'blocked'        (the batch's own status)
                             'expired'                   (marked expired OR past its expiry date)
                             'in_stock'                  (sellable: active, not expired, stock > 0)
                             'out_of_stock'              (nothing left)
     - medicine_id         : filter by medicine
     - supplier_id         : filter by supplier
     - expiring_days       : batches expiring within N days, with stock (alias: expiring_in_days)
     - in_stock_only       : 'true' → quantity_available > 0
     - low_stock           : 'true' → batches of medicines below their reorder level (strips, in scope)
     - location            : matches the shelf (the batch's, else the medicine's default)
     - unassigned          : 'true' → only batches with no branch yet
     - page, limit         : pagination
     - sort_by             : created_at | expiry_date | batch_number | medicine_name | location |
                              branch | quantity_available | purchase_price | selling_price
     - sort_order          : ASC | DESC
   Each row adds: units_per_pack, stock_text ("12 strips + 5 tablets"), location, branch,
   days_to_expiry, stock_status (ok | expiring | expired | empty | blocked).
============================================================ */
router.get(
  "/",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const today = istToday();

      const {
        search,
        status,
        medicine_id,
        supplier_id,
        in_stock_only,
        low_stock,
        location,
        sort_by = "created_at",
        sort_order = "DESC",
      } = req.query;
      const expiringDays = toInt(req.query.expiring_days ?? req.query.expiring_in_days, 0);
      const page = Math.max(1, toInt(req.query.page, 1));
      const limit = Math.min(500, Math.max(1, toInt(req.query.limit, 20)));

      // ── Branch scope (read-only: the admin sees every branch unless one is picked) ──
      const scope = await resolveScope(db, req, { wanted: req.query.branch });
      const f = batchFilter(scope, "pmb");

      const whereConditions = [`pmb.admin_id = ?${f.sql}`];
      const params = [tenantAdminId, ...f.params];

      if (status === "active" || status === "blocked") {
        whereConditions.push("pmb.status = ?");
        params.push(status);
      } else if (status === "expired") {
        whereConditions.push("(pmb.status = 'expired' OR (pmb.status <> 'blocked' AND pmb.expiry_date < ?))");
        params.push(today);
      } else if (status === "in_stock") {
        whereConditions.push("pmb.status = 'active' AND pmb.expiry_date >= ? AND pmb.quantity_available > 0");
        params.push(today);
      } else if (status === "out_of_stock") {
        whereConditions.push("pmb.quantity_available = 0");
      }

      if (medicine_id) {
        whereConditions.push("pmb.medicine_id = ?");
        params.push(medicine_id);
      }

      if (supplier_id) {
        whereConditions.push("pmb.supplier_id = ?");
        params.push(supplier_id);
      }

      if (expiringDays > 0) {
        whereConditions.push(
          "pmb.expiry_date >= ? AND pmb.expiry_date <= DATE_ADD(?, INTERVAL ? DAY) AND pmb.quantity_available > 0 AND pmb.status <> 'blocked'"
        );
        params.push(today, today, expiringDays);
      }

      if (
        in_stock_only === "true" ||
        in_stock_only === "1" ||
        in_stock_only === 1
      ) {
        whereConditions.push("pmb.quantity_available > 0");
      }

      const locExpr = "COALESCE(NULLIF(TRIM(pmb.storage_location), ''), pm.storage_location)";
      if (location && String(location).trim()) {
        whereConditions.push(`${locExpr} LIKE ?`);
        params.push(`%${String(location).trim()}%`);
      }

      if (search && search.trim()) {
        const searchTerm = `%${search.trim()}%`;
        whereConditions.push(`(
          pmb.batch_number LIKE ? OR
          md.medicine_name LIKE ? OR
          md.brand_name LIKE ? OR
          pm.medicine_code LIKE ? OR
          ${locExpr} LIKE ?
        )`);
        params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
      }

      // ── Low stock: the medicine's strips in this scope are under its reorder level ──
      // batches with no branch yet (stock from before branches were used)
      if (req.query.unassigned === "1" || req.query.unassigned === "true") {
        whereConditions.push("(pmb.branch IS NULL OR TRIM(pmb.branch) = '')");
      }

      const wantLow = low_stock === "true" || low_stock === "1";
      const sj = wantLow ? stockJoin(scope, tenantAdminId, today) : { sql: "", params: [] };
      if (wantLow) {
        whereConditions.push("pm.reorder_level > 0 AND COALESCE(st.stock_strips, 0) < pm.reorder_level");
      }

      const whereClause = whereConditions.join(" AND ");
      const offset = (page - 1) * limit;

      // Whitelisted sort columns
      const allowedSort = {
        created_at: "pmb.created_at",
        updated_at: "pmb.updated_at",
        expiry_date: "pmb.expiry_date",
        batch_number: "pmb.batch_number",
        medicine_name: "md.medicine_name",
        location: locExpr,
        branch: "pmb.branch",
        quantity_available: "pmb.quantity_available",
        purchase_price: "pmb.purchase_price",
        selling_price: "pmb.selling_price",
      };
      const safeSortBy = allowedSort[sort_by] || "pmb.created_at";
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      // Total count
      const [countResult] = await db.query(
        `SELECT COUNT(*) as total
         ${BATCH_FROM}
         ${sj.sql}
         WHERE ${whereClause}`,
        [...sj.params, ...params]
      );

      // Paginated results
      const [batches] = await db.query(
        `SELECT ${BATCH_COLUMNS}
           ${wantLow ? ", COALESCE(st.stock_strips, 0) AS medicine_stock_strips" : ""}
         ${BATCH_FROM}
         ${sj.sql}
         WHERE ${whereClause}
         ORDER BY ${safeSortBy} ${safeSortOrder}, pmb.id ${safeSortOrder}
         LIMIT ? OFFSET ?`,
        [...sj.params, ...params, limit, offset]
      );
      batches.forEach((b) => decorateBatch(b, today));
      applyUnitView(batches, wantsStrips(req));

      return res.json({
        success: true,
        data: batches,
        pagination: {
          page,
          limit,
          total: countResult[0].total,
          total_pages: Math.ceil(countResult[0].total / limit),
        },
        branch: scope.filter ? scope.branch : null,
        multi_branch: scope.multi,
      });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("List batches error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch batches",
      });
    }
  }
);

/* ============================================================
   EXPIRING (short list — dashboard widget)
   GET /api/pharmacy/batches/expiring?days=90&limit=5
   Batches with stock expiring in the next N days, in the caller's branch scope.
   `total` is how many there are in all (data holds the first `limit`).
============================================================ */
router.get(
  "/expiring",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {   // ⭐ Add try/catch
      const tenantAdminId = getTenantAdminId(req);
      const days = Math.max(0, Number(req.query.days) || 90);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 5));
      const today = istToday();
      const scope = await resolveScope(db, req, { wanted: req.query.branch });
      const f = batchFilter(scope, "pmb");
      const where = `pmb.admin_id = ? ${f.sql}
           AND pmb.status = 'active'
           AND pmb.quantity_available > 0
           AND pmb.expiry_date >= ? AND pmb.expiry_date <= DATE_ADD(?, INTERVAL ? DAY)`;
      const params = [tenantAdminId, ...f.params, today, today, days];

      const [[count]] = await db.query(
        `SELECT COUNT(*) AS total FROM pharmacy_medicine_batches pmb WHERE ${where}`,
        params
      );
      const [rows] = await db.query(
        `SELECT
           pmb.id, pmb.medicine_id, pmb.batch_number, pmb.expiry_date, pmb.quantity_available,
           pmb.units_per_pack, pmb.storage_location, pmb.branch, pmb.status,
           md.medicine_name, pm.manufacturer, pm.unit, pm.storage_location AS medicine_location
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm ON pm.id = pmb.medicine_id
         JOIN medicine_data md ON md.id = pm.medicine_data_id
         WHERE ${where}
         ORDER BY pmb.expiry_date ASC, pmb.id ASC
         LIMIT ?`,
        [...params, limit]
      );
      rows.forEach((r) => decorateBatch(r, today));
      applyUnitView(rows, wantsStrips(req));
      return res.json({ success: true, data: rows, total: Number(count.total) || 0, within_days: days });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("Expiring batches (short) error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch expiring batches",
      });
    }
  }
);

/* ============================================================
   EXPIRY REPORT — batches expiring soon or already expired
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.batches.view' permission
   Query params:
     - within_days : batches expiring within N days (default 90)
     - branch      : admin only
============================================================ */
router.get(
  "/reports/expiring",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const withinDays = toInt(req.query.within_days, 90);
      const today = istToday();
      const scope = await resolveScope(db, req, { wanted: req.query.branch });
      const f = batchFilter(scope, "pmb");

      const [rows] = await db.query(
        `SELECT
           pmb.id, pmb.batch_number, pmb.expiry_date, pmb.branch,
           pmb.quantity_available, pmb.units_per_pack, pmb.storage_location,
           pmb.purchase_price, pmb.selling_price,
           md.medicine_name, md.brand_name, md.dosage_form, md.strength,
           pm.medicine_code, pm.unit, pm.storage_location AS medicine_location,
           ps.supplier_name,
           CASE
             WHEN pmb.expiry_date < ? THEN 'expired'
             WHEN pmb.expiry_date <= DATE_ADD(?, INTERVAL 30 DAY) THEN 'critical'
             WHEN pmb.expiry_date <= DATE_ADD(?, INTERVAL 90 DAY) THEN 'warning'
             ELSE 'ok'
           END AS urgency
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm      ON pm.id = pmb.medicine_id
         JOIN medicine_data md           ON md.id = pm.medicine_data_id
         LEFT JOIN pharmacy_suppliers ps ON ps.id = pmb.supplier_id
         WHERE pmb.admin_id = ? ${f.sql}
           AND pmb.status = 'active'
           AND pmb.quantity_available > 0
           AND pmb.expiry_date <= DATE_ADD(?, INTERVAL ? DAY)
         ORDER BY pmb.expiry_date ASC`,
        [today, today, today, tenantAdminId, ...f.params, today, withinDays]
      );
      rows.forEach((r) => decorateBatch(r, today));
      applyUnitView(rows, wantsStrips(req));

      return res.json({
        success: true,
        data: rows,
        total: rows.length,
        within_days: withinDays,
      });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("Expiry report error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch expiry report",
      });
    }
  }
);

/* ============================================================
   BATCHES BY MEDICINE — FEFO order (First Expiring, First Out)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.batches.view' permission
   Used by POS/billing to auto-pick the correct batch for sale.
   Only the caller's branch (staff) / the picked branch (admin).
============================================================ */
router.get(
  "/medicine/:medicine_id/available",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { medicine_id } = req.params;
      const today = istToday();
      const scope = await resolveScope(db, req, { wanted: req.query.branch });
      const f = batchFilter(scope, "pmb");

      const [rows] = await db.query(
        `SELECT
           pmb.id, pmb.batch_number, pmb.expiry_date, pmb.branch,
           pmb.quantity_available, pmb.selling_price, pmb.mrp,
           pmb.purchase_price, pmb.units_per_pack, pmb.storage_location,
           pm.unit, pm.storage_location AS medicine_location
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm ON pm.id = pmb.medicine_id
         WHERE pmb.admin_id = ? ${f.sql}
           AND pmb.medicine_id = ?
           AND pmb.status = 'active'
           AND pmb.quantity_available > 0
           AND pmb.expiry_date >= ?
         ORDER BY pmb.expiry_date ASC, pmb.id ASC`,
        [tenantAdminId, ...f.params, medicine_id, today]
      );
      rows.forEach((r) => decorateBatch(r, today));
      applyUnitView(rows, wantsStrips(req));

      const totalAvailable = rows.reduce(
        (sum, r) => sum + r.quantity_available,
        0
      );

      return res.json({
        success: true,
        data: rows,
        total_batches: rows.length,
        total_quantity_available: totalAvailable, // tablets
        // full strips counted per batch (each has its own pack size) + the loose tablets left over
        total_strips: rows.reduce((t, r) => t + r.full_strips, 0),
        total_text: (() => {
          const strips = rows.reduce((t, r) => t + r.full_strips, 0);
          const loose = rows.reduce((t, r) => t + r.loose_tablets, 0);
          const word = rows.length ? rows[0].pack_word : "strip";
          const w = (n) => plural(word, n);
          if (strips && loose) return `${strips} ${w(strips)} + ${loose} ${plural("tablet", loose)}`;
          if (loose) return `${loose} ${plural("tablet", loose)}`;
          return `${strips} ${w(strips)}`;
        })(),
      });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("Available batches error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch available batches",
      });
    }
  }
);

/* ============================================================
   UPDATE LOCATION — where a batch sits on the shelf
   PATCH /update/location/:id   { storage_location: "Rack B / Shelf 3" }   (empty → the medicine's default)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.medicines.edit' permission (own branch's batches)
============================================================ */
router.patch(
  "/update/location/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const location = cleanLocation(req.body.storage_location === undefined ? null : req.body.storage_location);
      const { batch } = await loadBatchForWrite(db, req, req.params.id);

      await db.query(
        `UPDATE pharmacy_medicine_batches SET storage_location = ?, updated_at = NOW() WHERE id = ? AND admin_id = ?`,
        [location, batch.id, tenantAdminId]
      );

      const [row] = await fetchBatches([batch.id]);
      return res.json({
        success: true,
        message: location
          ? `Batch ${batch.batch_number} is now at ${location}`
          : `Batch ${batch.batch_number} now uses the medicine's default shelf`,
        data: row,
      });
    } catch (err) {
      if (sendKnownError(res, err)) return;
      console.error("Update batch location error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update the location",
      });
    }
  }
);

/* ============================================================
   ASSIGN A BRANCH — for batches that have none yet (stock from before branches were used)
   Admin only. Nothing else changes (no quantity → no ledger row).
     PATCH /update/branch/:id            { branch }                  one batch
     PATCH /update/branch-unassigned     { branch, medicine_id? }    every unassigned batch
   400 unknown branch · 403 not the admin · 404 not found ·
   409 the batch already has a branch (stock moves between branches with a transfer)
============================================================ */
async function adminBranch(req) {
  const actor = await getActor(req, db);
  if (!actor.isAdmin) throw new BranchError(403, "Only the admin can assign a branch to a batch.");
  const wanted = typeof req.body.branch === "string" ? req.body.branch.trim() : "";
  if (!wanted) throw new BranchError(400, "Choose the branch.");
  const all = [...(await staffBranches(db, actor.adminId)), ...(await stockBranches(db, actor.adminId))];
  const name = findBranch(all, wanted);
  if (!name) throw new BranchError(400, `"${wanted}" is not one of your branches.`);
  return { actor, branch: name };
}

router.patch(
  "/update/branch-unassigned",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const { actor, branch } = await adminBranch(req);
      const medicineId = req.body.medicine_id ? Number(req.body.medicine_id) : null;
      if (req.body.medicine_id !== undefined && req.body.medicine_id !== null && !(Number.isInteger(medicineId) && medicineId > 0)) {
        return res.status(400).json({ success: false, message: "medicine_id must be a medicine id" });
      }
      const [r] = await db.query(
        `UPDATE pharmacy_medicine_batches
            SET branch = ?, updated_at = NOW()
          WHERE admin_id = ? AND (branch IS NULL OR TRIM(branch) = '')${medicineId ? " AND medicine_id = ?" : ""}`,
        medicineId ? [branch, actor.adminId, medicineId] : [branch, actor.adminId]
      );
      const count = Number(r.affectedRows) || 0;
      return res.json({
        success: true,
        message: count ? `${count} ${count === 1 ? "batch" : "batches"} assigned to ${branch}` : "No batch was without a branch",
        data: { branch, count },
      });
    } catch (err) {
      if (sendKnownError(res, err)) return;
      console.error("Assign branch (all) error:", err);
      return res.status(500).json({ success: false, message: "Failed to assign the branch" });
    }
  }
);

router.patch(
  "/update/branch/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const { actor, branch } = await adminBranch(req);
      const [[b]] = await db.query(
        `SELECT id, batch_number, branch FROM pharmacy_medicine_batches WHERE id = ? AND admin_id = ? LIMIT 1`,
        [req.params.id, actor.adminId]
      );
      if (!b) return res.status(404).json({ success: false, message: "Batch not found" });
      if (b.branch && String(b.branch).trim()) {
        return res.status(409).json({
          success: false,
          message: `This batch already belongs to ${String(b.branch).trim()} — move stock with a transfer`,
        });
      }
      // the WHERE repeats the "no branch" test so two admins can't both assign it
      const [r] = await db.query(
        `UPDATE pharmacy_medicine_batches SET branch = ?, updated_at = NOW()
          WHERE id = ? AND admin_id = ? AND (branch IS NULL OR TRIM(branch) = '')`,
        [branch, b.id, actor.adminId]
      );
      if (!r.affectedRows) {
        return res.status(409).json({ success: false, message: "This batch was just given a branch — reload the list" });
      }
      const [row] = await fetchBatches([b.id]);
      return res.json({ success: true, message: `Batch ${b.batch_number} is now in ${branch}`, data: row });
    } catch (err) {
      if (sendKnownError(res, err)) return;
      console.error("Assign branch error:", err);
      return res.status(500).json({ success: false, message: "Failed to assign the branch" });
    }
  }
);

/* ============================================================
   GET single batch by ID
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.batches.view' permission
============================================================ */
router.get(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [batch] = await db.query(
        `SELECT
           pmb.id, pmb.admin_id, pmb.medicine_id, pmb.batch_number, pmb.branch,
           pmb.units_per_pack, pmb.storage_location,
           pmb.manufacturing_date, pmb.expiry_date,
           pmb.purchase_price, pmb.selling_price, pmb.mrp,
           pmb.quantity_received, pmb.quantity_available, pmb.free_quantity,
           pmb.supplier_id, pmb.status, pmb.created_at, pmb.updated_at,
           md.medicine_name, md.brand_name, md.generic_name,
           md.dosage_form, md.strength,
           pm.medicine_code, pm.barcode, pm.hsn_code, pm.gst_percentage,
           pm.unit, pm.pack_size, pm.storage_location AS medicine_location,
           ps.supplier_name, ps.contact_person, ps.phone AS supplier_phone
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm      ON pm.id = pmb.medicine_id
         JOIN medicine_data md           ON md.id = pm.medicine_data_id
         LEFT JOIN pharmacy_suppliers ps ON ps.id = pmb.supplier_id
         WHERE pmb.id = ? AND pmb.admin_id = ?`,
        [id, tenantAdminId]
      );

      if (!batch.length) {
        return res.status(404).json({
          success: false,
          message: "Batch not found",
        });
      }

      return res.json({
        success: true,
        data: applyUnitView(decorateBatch(batch[0]), wantsStrips(req)),
      });
    } catch (err) {
      console.error("Get batch error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch batch",
      });
    }
  }
);

/* ============================================================
   UPDATE batch
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.batches.edit' permission

   NOTE: medicine_id, batch_number and quantity_received are IMMUTABLE.
         They represent historical facts about this stock intake event.
         To record more stock of same medicine, create a NEW batch.
   • quantity_available (tablets) is a stock correction → written through recordMove
     (adjustment ledger row); it can't exceed received + free.
   • units_per_pack can change only while the batch has never moved
     (quantity_available = received + free and no sale lines) → else 409.
     The tablet counts are kept as they are. EXCEPT 1 → N (a batch counted in packs): it is
     re-packed even after sales — received / available / free × N + an adjustment ledger row.
   • storage_location: the shelf (empty → the medicine's default).
============================================================ */
router.put(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
      const {
        manufacturing_date,
        expiry_date,
        purchase_price,
        selling_price,
        mrp,
        quantity_available,
        free_quantity,
        supplier_id,
        status,
        units_per_pack,
        storage_location,
      } = req.body;

      await conn.beginTransaction();

      // Verify ownership + branch, and lock the batch
      const { batch: existing } = await loadBatchForWrite(conn, req, id, { lock: true });

      const updates = [];
      const params = [];
      const bad = (message, status = 400) => {
        const e = new Error(message);
        e.status = status;
        throw e;
      };

      // ── manufacturing_date ──
      if (manufacturing_date !== undefined) {
        if (manufacturing_date && !isValidDate(manufacturing_date)) bad("manufacturing_date must be a valid date");
        updates.push("manufacturing_date = ?");
        params.push(manufacturing_date || null);
      }

      // ── expiry_date ──
      if (expiry_date !== undefined) {
        if (!isValidDate(expiry_date)) bad("expiry_date must be a valid date");
        updates.push("expiry_date = ?");
        params.push(expiry_date);
      }

      // ── prices (per strip) ──
      const priceField = (val, column, label) => {
        if (val === undefined) return;
        const p = toDecimal(val, NaN);
        if (Number.isNaN(p)) bad(`${label} must be a number`);
        if (p < 0) bad(`${label} cannot be negative`);
        updates.push(`${column} = ?`);
        params.push(p);
      };
      priceField(purchase_price, "purchase_price", "Purchase price");
      priceField(selling_price, "selling_price", "Selling price");
      priceField(mrp, "mrp", "MRP");
      const nextSelling = selling_price !== undefined ? Number(selling_price) : Number(existing.selling_price);
      const nextMrp = mrp !== undefined ? Number(mrp) : Number(existing.mrp);
      if ((selling_price !== undefined || mrp !== undefined) && nextMrp > 0 && nextSelling > nextMrp) {
        bad("Selling price can't be more than the MRP (both per strip)");
      }

      // ── free_quantity (tablets) ──
      let nextFree = Number(existing.free_quantity) || 0;
      if (free_quantity !== undefined) {
        const fq = toCount(free_quantity);
        if (fq === null) bad("Free quantity must be a whole number of tablets (not negative)");
        nextFree = fq;
        updates.push("free_quantity = ?");
        params.push(fq);
      }

      // ── units_per_pack ──
      //   1 → N (a batch counted in packs): re-pack it, even after sales — quantities × N + ledger row
      //   any other change: only while the batch has never moved (tablet counts are kept)
      let repackTo = null;
      if (units_per_pack !== undefined) {
        const upp = cleanUnitsPerPack(units_per_pack);
        if (!upp) bad("Tablets per strip must be a whole number from 1 to 10000");
        if (Number(existing.units_per_pack) === 1 && upp > 1) {
          if (quantity_available !== undefined || free_quantity !== undefined) {
            bad("Change the pack size on its own, then correct the quantities");
          }
          repackTo = upp;
        } else if (upp !== Number(existing.units_per_pack)) {
          const untouched =
            Number(existing.quantity_available) === Number(existing.quantity_received) + Number(existing.free_quantity);
          const [[sold]] = await conn.query(`SELECT COUNT(*) AS n FROM pharmacy_sale_items WHERE batch_id = ?`, [existing.id]);
          if (!untouched || Number(sold.n) > 0) bad("Pack size can't change once stock has moved", 409);
          updates.push("units_per_pack = ?");
          params.push(upp);
        }
      }

      // ── storage_location ──
      if (storage_location !== undefined) {
        updates.push("storage_location = ?");
        params.push(cleanLocation(storage_location));
      }

      // ── supplier_id ──
      if (supplier_id !== undefined) {
        if (supplier_id === null || supplier_id === "") {
          updates.push("supplier_id = ?");
          params.push(null);
        } else {
          const [supplierCheck] = await conn.query(
            `SELECT id FROM pharmacy_suppliers
             WHERE id = ? AND admin_id = ? LIMIT 1`,
            [supplier_id, tenantAdminId]
          );
          if (!supplierCheck.length) bad("Supplier not found in your organization", 404);
          updates.push("supplier_id = ?");
          params.push(supplier_id);
        }
      }

      // ── status ──
      if (status !== undefined) {
        if (!["active", "expired", "blocked"].includes(status)) {
          bad("Invalid status. Use 'active', 'expired', or 'blocked'");
        }
        updates.push("status = ?");
        params.push(status);
      }

      // ── quantity_available (stock correction, tablets) ──
      let move = null;
      if (quantity_available !== undefined) {
        const qa = toCount(quantity_available);
        if (qa === null) bad("Quantity available must be a whole number of tablets (not negative)");
        const cap = Number(existing.quantity_received) + nextFree;
        if (qa > cap) bad(`Quantity available (${qa}) cannot exceed what was received with the free goods (${cap} tablets)`);
        const diff = qa - Number(existing.quantity_available);
        if (diff !== 0) move = { diff, from: Number(existing.quantity_available), to: qa };
      }

      if (!updates.length && !move && !repackTo) bad("No fields to update");

      if (updates.length) {
        params.push(id, tenantAdminId);
        await conn.query(
          `UPDATE pharmacy_medicine_batches
           SET ${updates.join(", ")}, updated_at = NOW()
           WHERE id = ? AND admin_id = ?`,
          params
        );
      }

      let repacked = null;
      if (repackTo) {
        repacked = await repackBatch(conn, { adminId: tenantAdminId, userId: req.user.id, batch: existing, upp: repackTo });
      }

      if (move) {
        await recordMove(conn, {
          adminId: tenantAdminId,
          userId: req.user.id,
          batchId: existing.id,
          type: "adjustment",
          [move.diff > 0 ? "tabletsIn" : "tabletsOut"]: Math.abs(move.diff),
          referenceId: existing.id,
          referenceNumber: existing.batch_number,
          notes: `Stock corrected from ${move.from} to ${move.to} tablets`,
        });
      }

      await conn.commit();

      // Return updated row with joined data
      const [updated] = await fetchBatches([existing.id]);

      return res.json({
        success: true,
        message: repacked
          ? `Batch ${repacked.batch_number} recounted: ${repacked.packs} ${repacked.packs === 1 ? "pack" : "packs"} → ${repacked.tablets} tablets`
          : "Batch updated successfully",
        data: updated,
        repacked,
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (sendKnownError(res, err)) return;
      console.error("Update batch error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update batch",
      });
    } finally {
      conn.release();
    }
  }
);

/* ============================================================
   BLOCK batch (soft delete → status='blocked')
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.batches.delete' permission

   NOTE: Batches hold historical stock data — never hard-delete.
         Blocked batches won't appear in sale lookups.
============================================================ */
router.delete(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.delete"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { batch } = await loadBatchForWrite(db, req, req.params.id);

      await db.query(
        `UPDATE pharmacy_medicine_batches
         SET status = 'blocked'
         WHERE id = ? AND admin_id = ?`,
        [batch.id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `Batch '${batch.batch_number}' of '${batch.medicine_name}' has been blocked`,
      });
    } catch (err) {
      if (sendKnownError(res, err)) return;
      console.error("Block batch error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to block batch",
      });
    }
  }
);

/* ============================================================
   CHANGE STATUS (active / expired / blocked)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.batches.edit' permission
============================================================ */
router.patch(
  "/:id/status",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { status } = req.body;

      if (!status || !["active", "expired", "blocked"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Valid status is required: 'active', 'expired', or 'blocked'",
        });
      }

      const { batch } = await loadBatchForWrite(db, req, req.params.id);

      await db.query(
        `UPDATE pharmacy_medicine_batches
         SET status = ?
         WHERE id = ? AND admin_id = ?`,
        [status, batch.id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `Batch '${batch.batch_number}' status changed to '${status}'`,
        data: { id: Number(batch.id), status },
      });
    } catch (err) {
      if (sendKnownError(res, err)) return;
      console.error("Change batch status error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to change status",
      });
    }
  }
);

/* ============================================================
   ADJUST STOCK (increment / decrement quantity_available)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.batches.edit' permission

   Body:
     - adjustment: +5 (add) or -3 (remove) — TABLETS (or strips with unit: 'strip')
     - unit:       'tablet' (default) | 'strip'
     - reason:     text describing why (e.g., 'damaged', 'expired', 'stock correction')
   Written through recordMove (batch + ledger in one transaction). The stock can't go
   below 0 (409) or above what was received with the free goods (400).
============================================================ */
router.patch(
  "/:id/adjust-stock",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { adjustment, reason, unit } = req.body;

      const adj = toInt(adjustment, null);
      if (adj === null || adj === 0 || String(adjustment).includes(".")) {
        return res.status(400).json({
          success: false,
          message: "adjustment must be a non-zero whole number (positive or negative)",
        });
      }
      if (unit !== undefined && !["tablet", "strip"].includes(unit)) {
        return res.status(400).json({ success: false, message: "unit must be 'tablet' or 'strip'" });
      }

      await conn.beginTransaction();
      const { batch: existing } = await loadBatchForWrite(conn, req, req.params.id, { lock: true });
      const upp = unitsPerPack(existing);
      const tablets = unit === "strip" ? adj * upp : adj;

      const newQty = Number(existing.quantity_available) + tablets;
      const cap = Number(existing.quantity_received) + Number(existing.free_quantity);

      if (newQty > cap) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: `Cannot exceed what was received with the free goods (${cap} tablets)`,
        });
      }

      const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
      const type = /^damage/i.test(why) ? "damaged" : /^expir/i.test(why) ? "expired" : "adjustment";
      const after = await recordMove(conn, {
        adminId: tenantAdminId,
        userId: req.user.id,
        batchId: existing.id,
        type,
        [tablets > 0 ? "tabletsIn" : "tabletsOut"]: Math.abs(tablets),
        referenceId: existing.id,
        referenceNumber: existing.batch_number,
        notes: why || `Stock ${tablets > 0 ? "added" : "removed"}`,
      });

      await conn.commit();

      const word = packWord(existing, upp);
      return res.json({
        success: true,
        message: `Stock adjusted by ${tablets > 0 ? "+" : ""}${tablets} tablets. Now ${describeStock(after, upp, word)}`,
        data: {
          id: Number(existing.id),
          previous_quantity: Number(existing.quantity_available),
          adjustment: tablets,
          new_quantity: after,
          stock_text: describeStock(after, upp, word),
          reason: why || null,
        },
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (sendKnownError(res, err)) return;
      console.error("Adjust stock error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to adjust stock",
      });
    } finally {
      conn.release();
    }
  }
);


module.exports = router;
// exposed for medicines.js (same pattern as pharmacyStockTransactions.recordStockTransaction)
module.exports.repackBatch = repackBatch;