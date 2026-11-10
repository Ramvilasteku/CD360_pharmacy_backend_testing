// routes/pharmacy/batches.js

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");

// Stock in this table is counted in TABLETS and priced PER STRIP. These screens speak
// in strips, so quantities are translated on the way in and out — see
// utils/pharmacyStripView.js. Never divide or multiply by units_per_pack here.
const {
  stripsOf,
  tabletsOf,
  SQL_STRIPS,
  uppForNewBatch,
  batchToStripView,
  batchesToStripView,
} = require("../../utils/pharmacyStripView");
const { unitsPerPack } = require("../../utils/pharmacyUnits");
const { recordMove } = require("../../utils/pharmacyStock");
const { resolveScope, batchFilter, sendBranchError } = require("../../utils/pharmacyBranch");


const LOW_STOCK_DEFAULT_LEVEL = 10;
 
// Suggested qty = (reorder_level × multiplier) − in stock − on order
const LOW_STOCK_TOP_UP_MULTIPLIER = 2;
 
// Flip to false if pharmacy_purchase_orders / pharmacy_purchase_items
// aren't created yet — on_order then reads 0 instead of throwing.
const LOW_STOCK_INCLUDE_ON_ORDER = true;
const LOW_STOCK_OPEN_PO_STATUSES = ["pending", "ordered", "partial"];
 
// Tablets → whole sellable strips, per batch. Floored per batch on purpose:
// a batch holding only loose tablets is 0 strips, same rule as the POS.
const LOW_STOCK_STRIPS = `
  FLOOR(
    pmb.quantity_available /
    GREATEST(
      COALESCE(
        NULLIF(pmb.units_per_pack, 0),
        NULLIF(pm.units_per_pack, 0),
        NULLIF(pm.pack_size, 0),
        1
      ), 1
    )
  )
`;

const EXPIRY_ALERT_STATUSES = ["active", "expired"];

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

/* ============================================================
   Helper: validate date (YYYY-MM-DD)
============================================================ */
function isValidDate(val) {
  if (!val) return false;
  const d = new Date(val);
  return d instanceof Date && !isNaN(d);
}


/* ============================================================
   BULK CREATE batches (add multiple batches in one transaction)
   Access:
     - admin (bypass — tenant owner)
     - any staff role with 'pharmacy.batches.create' permission
   
   Body:
     {
       "batches": [
         {
           "medicine_id": 1,
           "batch_number": "GSK-4402",
           "expiry_date": "2028-03-31",
           "quantity_received": 100,
           ...
         },
         { ... },
         { ... }
       ]
     }
   
   Behavior:
     - ALL batches must pass validation → all inserted
     - ANY validation failure → NOTHING inserted (transaction rollback)
     - Response includes per-batch results and any errors
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

      // Which branch this stock lands in. Staff always get their own branch; with one
      // branch (or none) configured, scope.branch is that branch and nothing is filtered.
      let scope;
      try {
        scope = await resolveScope(connection, req, { wanted: (req.body || {}).branch, forWrite: true });
      } catch (e) {
        connection.release();
        // M3: sendBranchError only answers BranchErrors; anything else used to leave the request hanging
        if (sendBranchError(res, e)) return;
        console.error("Branch scope error:", e);
        return res.status(500).json({ success: false, message: "Couldn't work out the branch for this request" });
      }

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

      // ── Pre-validate ALL batches BEFORE starting transaction ──
      const validationErrors = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];

        if (!b.medicine_id) {
          validationErrors.push({ index: i, error: "medicine_id is required" });
          continue;
        }
        if (!b.batch_number || !b.batch_number.trim()) {
          validationErrors.push({ index: i, error: "batch_number is required" });
          continue;
        }
        if (!b.expiry_date || !isValidDate(b.expiry_date)) {
          validationErrors.push({ index: i, error: "valid expiry_date is required" });
          continue;
        }

        const expiry = new Date(b.expiry_date);
        if (expiry < today) {
          validationErrors.push({ index: i, error: "expiry_date cannot be in the past" });
          continue;
        }

        if (b.manufacturing_date) {
          if (!isValidDate(b.manufacturing_date)) {
            validationErrors.push({ index: i, error: "invalid manufacturing_date" });
            continue;
          }
          if (new Date(b.manufacturing_date) > expiry) {
            validationErrors.push({ index: i, error: "manufacturing_date after expiry_date" });
            continue;
          }
        }

        const qtyReceived = toInt(b.quantity_received, 0);
        const freeQty = toInt(b.free_quantity, 0);

        if (qtyReceived < 0 || freeQty < 0) {
          validationErrors.push({ index: i, error: "quantities cannot be negative" });
          continue;
        }

        if (qtyReceived === 0 && freeQty === 0) {
          validationErrors.push({ index: i, error: "must have quantity_received or free_quantity > 0" });
          continue;
        }

        const p = toDecimal(b.purchase_price, 0);
        const s = toDecimal(b.selling_price, 0);
        const m = toDecimal(b.mrp, 0);
        if (p < 0 || s < 0 || m < 0) {
          validationErrors.push({ index: i, error: "prices cannot be negative" });
          continue;
        }
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
      const medicineIds = [...new Set(batches.map((b) => b.medicine_id))];
      const [medicines] = await connection.query(
        `SELECT pm.id, pm.units_per_pack, pm.pack_size, md.medicine_name
         FROM pharmacy_medicines pm
         JOIN medicine_data md ON md.id = pm.medicine_data_id
         WHERE pm.admin_id = ? AND pm.status = 'active'
           AND pm.id IN (?)`,
        [tenantAdminId, medicineIds]
      );

      // tablets per strip to stamp on each new batch, keyed by medicine
      const uppByMedicine = new Map(medicines.map((m) => [m.id, uppForNewBatch(m)]));

      const validMedicineIds = new Set(medicines.map((m) => m.id));
      const invalidMedicines = medicineIds.filter((id) => !validMedicineIds.has(id));

      if (invalidMedicines.length > 0) {
        return res.status(404).json({
          success: false,
          message: "One or more medicines not found in your inventory",
          missing_medicine_ids: invalidMedicines,
        });
      }

      // ── Verify all suppliers belong to tenant (one query) ──
      const supplierIds = [...new Set(batches.map((b) => b.supplier_id).filter(Boolean))];
      if (supplierIds.length > 0) {
        const [suppliers] = await connection.query(
          `SELECT id FROM pharmacy_suppliers 
           WHERE admin_id = ? AND id IN (?)`,
          [tenantAdminId, supplierIds]
        );

        const validSupplierIds = new Set(suppliers.map((s) => s.id));
        const invalidSuppliers = supplierIds.filter((id) => !validSupplierIds.has(id));

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
      for (let i = 0; i < batches.length; i++) {
        const key = `${batches[i].medicine_id}-${batches[i].batch_number.trim()}`;
        if (uniqueKeys.has(key)) {
          return res.status(400).json({
            success: false,
            message: `Duplicate entry in request: medicine_id=${batches[i].medicine_id}, batch_number=${batches[i].batch_number}`,
            index: i,
          });
        }
        uniqueKeys.add(key);
      }

      // ── Check for duplicates against existing DB records ──
      const dupChecks = batches.map((b) => [tenantAdminId, b.medicine_id, b.batch_number.trim()]);
      const dupParams = [];
      const dupConditions = dupChecks
        .map(([aid, mid, bn]) => {
          dupParams.push(aid, mid, bn);
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

      for (const b of batches) {
        // The form sends strips; the table holds tablets.
        const upp = uppByMedicine.get(b.medicine_id) || 1;
        const stripsReceived = toInt(b.quantity_received, 0);
        const stripsFree = toInt(b.free_quantity, 0);
        const tabletsReceived = tabletsOf(stripsReceived, upp);
        const tabletsFree = tabletsOf(stripsFree, upp);
        const tabletsAvailable = tabletsReceived + tabletsFree;

        const [result] = await connection.query(
          `INSERT INTO pharmacy_medicine_batches (
            admin_id, branch, medicine_id, batch_number,
            units_per_pack, storage_location,
            manufacturing_date, expiry_date,
            purchase_price, selling_price, mrp,
            quantity_received, quantity_available, free_quantity,
            supplier_id, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          [
            tenantAdminId,
            scope.branch || null,
            b.medicine_id,
            b.batch_number.trim(),
            upp,
            b.storage_location || null,
            b.manufacturing_date || null,
            b.expiry_date,
            toDecimal(b.purchase_price, 0),
            toDecimal(b.selling_price, 0),
            toDecimal(b.mrp, 0),
            tabletsReceived,
            tabletsAvailable,
            tabletsFree,
            b.supplier_id || null,
          ]
        );

        insertedIds.push(result.insertId);

        // Opening stock has to show up in the ledger, or the stock report and the
        // batch quantity drift apart from the very first batch.
        if (tabletsAvailable > 0) {
          await connection.query(
            `INSERT INTO pharmacy_stock_transactions
               (admin_id, medicine_id, batch_id, transaction_type,
                reference_id, reference_number, quantity_in, quantity_out,
                balance_quantity, transaction_date, notes, created_by)
             VALUES (?, ?, ?, 'opening_stock', NULL, ?, ?, 0, ?, NOW(), ?, ?)`,
            [
              tenantAdminId,
              b.medicine_id,
              result.insertId,
              b.batch_number.trim(),
              tabletsAvailable,
              tabletsAvailable,
              `Batch ${b.batch_number.trim()} added (${stripsReceived + stripsFree} strips)`,
              req.user.id,
            ]
          );
        }
      }

      await connection.commit();

      // ── Return all created rows with joined info ──
      const [newRows] = await db.query(
        `SELECT 
           pmb.id, pmb.medicine_id, pmb.batch_number,
           pmb.manufacturing_date, pmb.expiry_date,
           pmb.purchase_price, pmb.selling_price, pmb.mrp,
           pmb.quantity_received, pmb.quantity_available, pmb.free_quantity,
           pmb.units_per_pack, pmb.branch, pmb.storage_location,
           pmb.supplier_id, pmb.status, pmb.created_at,
           md.medicine_name, md.brand_name,
           pm.medicine_code,
           ps.supplier_name
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm      ON pm.id = pmb.medicine_id
         JOIN medicine_data md           ON md.id = pm.medicine_data_id
         LEFT JOIN pharmacy_suppliers ps ON ps.id = pmb.supplier_id
         WHERE pmb.id IN (?)
         ORDER BY pmb.id ASC`,
        [insertedIds]
      );

      return res.status(201).json({
        success: true,
        message: `${insertedIds.length} batches created successfully`,
        count: insertedIds.length,
        data: batchesToStripView(newRows),
      });
    } catch (err) {
      await connection.rollback();
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
============================================================ */
router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.medicines.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      // Which branch this stock lands in (staff: always their own).
      let scope;
      try {
        scope = await resolveScope(db, req, { wanted: (req.body || {}).branch, forWrite: true });
      } catch (e) {
        // M3: sendBranchError only answers BranchErrors; anything else used to leave the request hanging
        if (sendBranchError(res, e)) return;
        console.error("Branch scope error:", e);
        return res.status(500).json({ success: false, message: "Couldn't work out the branch for this request" });
      }

      const {
        medicine_id,
        batch_number,
        manufacturing_date,
        expiry_date,
        purchase_price,
        selling_price,
        mrp,
        quantity_received,
        free_quantity,
        supplier_id,
      } = req.body;

      // ── Required field validation ──
      if (!medicine_id) {
        return res.status(400).json({
          success: false,
          message: "medicine_id is required",
        });
      }

      if (!batch_number || !batch_number.trim()) {
        return res.status(400).json({
          success: false,
          message: "batch_number is required",
        });
      }

      if (!expiry_date || !isValidDate(expiry_date)) {
        return res.status(400).json({
          success: false,
          message: "expiry_date is required and must be a valid date (YYYY-MM-DD)",
        });
      }

      if (manufacturing_date && !isValidDate(manufacturing_date)) {
        return res.status(400).json({
          success: false,
          message: "manufacturing_date must be a valid date (YYYY-MM-DD)",
        });
      }

      // ── Verify medicine belongs to this tenant ──
      const [medicineCheck] = await db.query(
        `SELECT pm.id, pm.units_per_pack, pm.pack_size, md.medicine_name
         FROM pharmacy_medicines pm
         JOIN medicine_data md ON md.id = pm.medicine_data_id
         WHERE pm.id = ? AND pm.admin_id = ? AND pm.status = 'active' LIMIT 1`,
        [medicine_id, tenantAdminId]
      );

      if (!medicineCheck.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found in your inventory",
        });
      }

      // ── Verify supplier belongs to this tenant (if provided) ──
      if (supplier_id) {
        const [supplierCheck] = await db.query(
          `SELECT id FROM pharmacy_suppliers 
           WHERE id = ? AND admin_id = ? LIMIT 1`,
          [supplier_id, tenantAdminId]
        );

        if (!supplierCheck.length) {
          return res.status(404).json({
            success: false,
            message: "Supplier not found in your organization",
          });
        }
      }

      // ── Duplicate check: same medicine + batch_number ──
      const [existing] = await db.query(
        `SELECT id FROM pharmacy_medicine_batches 
         WHERE admin_id = ? AND medicine_id = ? AND batch_number = ? LIMIT 1`,
        [tenantAdminId, medicine_id, batch_number.trim()]
      );

      if (existing.length) {
        return res.status(409).json({
          success: false,
          message: `Batch '${batch_number}' already exists for this medicine`,
          existing_id: existing[0].id,
        });
      }

      // ── Validate numeric fields ──
      const purchase = toDecimal(purchase_price, 0);
      const selling = toDecimal(selling_price, 0);
      const mrpVal = toDecimal(mrp, 0);
      const qtyReceived = toInt(quantity_received, 0);
      const freeQty = toInt(free_quantity, 0);

      if (purchase < 0 || selling < 0 || mrpVal < 0) {
        return res.status(400).json({
          success: false,
          message: "Prices cannot be negative",
        });
      }

      if (qtyReceived < 0 || freeQty < 0) {
        return res.status(400).json({
          success: false,
          message: "Quantities cannot be negative",
        });
      }

      if (qtyReceived === 0 && freeQty === 0) {
        return res.status(400).json({
          success: false,
          message: "At least one of quantity_received or free_quantity must be > 0",
        });
      }

      // ── Validate expiry_date is in the future ──
      const expiryDate = new Date(expiry_date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (expiryDate < today) {
        return res.status(400).json({
          success: false,
          message: "Expiry date cannot be in the past",
        });
      }

      // ── Validate mfg_date <= expiry_date ──
      if (manufacturing_date) {
        const mfgDate = new Date(manufacturing_date);
        if (mfgDate > expiryDate) {
          return res.status(400).json({
            success: false,
            message: "Manufacturing date cannot be after expiry date",
          });
        }
      }

      // The form sends strips; the table holds tablets.
      const upp = uppForNewBatch(medicineCheck[0], req.body.units_per_pack);
      const tabletsReceived = tabletsOf(qtyReceived, upp);
      const tabletsFree = tabletsOf(freeQty, upp);
      const tabletsAvailable = tabletsReceived + tabletsFree;

      // ── Insert ──
      const [result] = await db.query(
        `INSERT INTO pharmacy_medicine_batches (
          admin_id, branch, medicine_id, batch_number,
          units_per_pack, storage_location,
          manufacturing_date, expiry_date,
          purchase_price, selling_price, mrp,
          quantity_received, quantity_available, free_quantity,
          supplier_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          tenantAdminId,
          scope.branch || null,
          medicine_id,
          batch_number.trim(),
          upp,
          req.body.storage_location || null,
          manufacturing_date || null,
          expiry_date,
          purchase,
          selling,
          mrpVal,
          tabletsReceived,
          tabletsAvailable,
          tabletsFree,
          supplier_id || null,
        ]
      );

      // Opening stock in the ledger, so the stock report and the batch agree from day one.
      if (tabletsAvailable > 0) {
        await db.query(
          `INSERT INTO pharmacy_stock_transactions
             (admin_id, medicine_id, batch_id, transaction_type,
              reference_id, reference_number, quantity_in, quantity_out,
              balance_quantity, transaction_date, notes, created_by)
           VALUES (?, ?, ?, 'opening_stock', NULL, ?, ?, 0, ?, NOW(), ?, ?)`,
          [
            tenantAdminId,
            medicine_id,
            result.insertId,
            batch_number.trim(),
            tabletsAvailable,
            tabletsAvailable,
            `Batch ${batch_number.trim()} added (${qtyReceived + freeQty} strips)`,
            req.user.id,
          ]
        );
      }

      // ── Return created row with joined info ──
      const [newRow] = await db.query(
        `SELECT 
           pmb.id, pmb.admin_id, pmb.medicine_id, pmb.batch_number,
           pmb.manufacturing_date, pmb.expiry_date,
           pmb.purchase_price, pmb.selling_price, pmb.mrp,
           pmb.quantity_received, pmb.quantity_available, pmb.free_quantity,
           pmb.units_per_pack, pmb.branch, pmb.storage_location,
           pmb.supplier_id, pmb.status, pmb.created_at, pmb.updated_at,
           md.medicine_name, md.brand_name, md.dosage_form, md.strength,
           pm.medicine_code, pm.barcode,
           ps.supplier_name
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm      ON pm.id = pmb.medicine_id
         JOIN medicine_data md           ON md.id = pm.medicine_data_id
         LEFT JOIN pharmacy_suppliers ps ON ps.id = pmb.supplier_id
         WHERE pmb.id = ?`,
        [result.insertId]
      );

      return res.status(201).json({
        success: true,
        message: "Batch created successfully",
        data: batchToStripView(newRow[0]),
      });
    } catch (err) {
      console.error("Create batch error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create batch",
      });
    }
  }
);

/* ============================================================
   LIST batches (with search, filter, pagination)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.batches.view' permission
   Query params:
     - search              : matches batch_number, medicine_name, brand
     - status              : 'active' | 'expired' | 'blocked'
     - medicine_id         : filter by medicine
     - supplier_id         : filter by supplier
     - expiring_in_days    : batches expiring within N days
     - in_stock_only       : 'true' → quantity_available > 0
     - page, limit         : pagination
     - sort_by             : created_at | expiry_date | batch_number |
                              quantity_available | purchase_price | selling_price
     - sort_order          : ASC | DESC
============================================================ */
router.get(
  "/",
  authMiddleware,
  // 6 Nov 2026: the Inventory page and Stock Adjustment's batch search read this list, so
  // the inventory permissions open it too (ANY of these). sql/2026-11-06_inventory_permissions.sql
  // M7: billing screens need this read — a cashier holding only pharmacy.sales.create must be able to use it
  allowPermissions("pharmacy.medicines.view", "pharmacy.stock.view", "pharmacy.stock.create", "pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      const {
        search,
        status,
        medicine_id,
        supplier_id,
        expiring_in_days,
        in_stock_only,
        page = 1,
        limit = 20,
        sort_by = "created_at",
        sort_order = "DESC",
      } = req.query;

      const whereConditions = ["pmb.admin_id = ?"];
      const params = [tenantAdminId];

      // Branch scoping: staff see their own branch's stock, admins see every branch
      // unless one is named. With a single branch configured this adds nothing.
      let scope;
      try {
        scope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        // M3: sendBranchError only answers BranchErrors; anything else used to leave the request hanging
        if (sendBranchError(res, e)) return;
        console.error("Branch scope error:", e);
        return res.status(500).json({ success: false, message: "Couldn't work out the branch for this request" });
      }
      const bf = batchFilter(scope, "pmb");
      if (bf.sql) {
        whereConditions.push(bf.sql.replace(/^\s*AND\s+/i, ""));
        params.push(...bf.params);
      }

      if (status && ["active", "expired", "blocked"].includes(status)) {
        whereConditions.push("pmb.status = ?");
        params.push(status);
      }

      if (medicine_id) {
        whereConditions.push("pmb.medicine_id = ?");
        params.push(medicine_id);
      }

      if (supplier_id) {
        whereConditions.push("pmb.supplier_id = ?");
        params.push(supplier_id);
      }

      if (expiring_in_days) {
        const days = toInt(expiring_in_days, 0);
        if (days > 0) {
          whereConditions.push(
            "pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)"
          );
          whereConditions.push("pmb.expiry_date >= CURDATE()");
          params.push(days);
        }
      }

      if (
        in_stock_only === "true" ||
        in_stock_only === "1" ||
        in_stock_only === 1
      ) {
        whereConditions.push("pmb.quantity_available > 0");
      }

      if (search && search.trim()) {
        const searchTerm = `%${search.trim()}%`;
        whereConditions.push(`(
          pmb.batch_number LIKE ? OR
          md.medicine_name LIKE ? OR
          md.brand_name LIKE ? OR
          pm.medicine_code LIKE ?
        )`);
        params.push(searchTerm, searchTerm, searchTerm, searchTerm);
      }

      const whereClause = whereConditions.join(" AND ");
      const offset = (Number(page) - 1) * Number(limit);

      // Whitelisted sort columns
      const allowedSort = {
        created_at: "pmb.created_at",
        updated_at: "pmb.updated_at",
        expiry_date: "pmb.expiry_date",
        batch_number: "pmb.batch_number",
        quantity_available: "pmb.quantity_available",
        purchase_price: "pmb.purchase_price",
        selling_price: "pmb.selling_price",
      };
      const safeSortBy = allowedSort[sort_by] || "pmb.created_at";
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      // Total count
      const [countResult] = await db.query(
        `SELECT COUNT(*) as total
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm      ON pm.id = pmb.medicine_id
         JOIN medicine_data md           ON md.id = pm.medicine_data_id
         LEFT JOIN pharmacy_suppliers ps ON ps.id = pmb.supplier_id
         WHERE ${whereClause}`,
        params
      );

      // Paginated results
      const [batches] = await db.query(
        `SELECT 
           pmb.id, pmb.medicine_id, pmb.batch_number,
           pmb.manufacturing_date, pmb.expiry_date,
           pmb.purchase_price, pmb.selling_price, pmb.mrp,
           pmb.quantity_received, pmb.quantity_available, pmb.free_quantity,
           pmb.units_per_pack, pmb.branch, pmb.storage_location,
           pmb.supplier_id, pmb.status, pmb.created_at, pmb.updated_at,
           md.medicine_name, md.brand_name, md.dosage_form, md.strength,
           pm.medicine_code, pm.barcode,
           ps.supplier_name,
           DATEDIFF(pmb.expiry_date, CURDATE()) AS days_to_expiry
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm      ON pm.id = pmb.medicine_id
         JOIN medicine_data md           ON md.id = pm.medicine_data_id
         LEFT JOIN pharmacy_suppliers ps ON ps.id = pmb.supplier_id
         WHERE ${whereClause}
         ORDER BY ${safeSortBy} ${safeSortOrder}
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), offset]
      );

      return res.json({
        success: true,
        data: batchesToStripView(batches),
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: countResult[0].total,
          total_pages: Math.ceil(countResult[0].total / Number(limit)),
        },
      });
    } catch (err) {
      console.error("List batches error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch batches",
      });
    }
  }
);

router.get(
  "/low-stock",
  authMiddleware,
  // 6 Nov 2026: Inventory → Low Stock is opened by pharmacy.stock.view
  allowPermissions("pharmacy.medicines.view", "pharmacy.stock.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
 
      // Branch scoping, so a branch isn't told to reorder stock that is
      // sitting in another branch.
      let scope;
      try {
        scope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        // M3: sendBranchError only answers BranchErrors; anything else used to leave the request hanging
        if (sendBranchError(res, e)) return;
        console.error("Branch scope error:", e);
        return res.status(500).json({ success: false, message: "Couldn't work out the branch for this request" });
      }
      const bf = batchFilter(scope, "pmb");
 
      // ---- inputs
      const allowedOnly = ["all", "out_of_stock", "low"];
      const only = allowedOnly.includes(req.query.only) ? req.query.only : "all";
 
      const search = (req.query.search || "").trim();
      const page = Math.max(toInt(req.query.page, 1), 1);
      const limit = Math.min(Math.max(toInt(req.query.limit, 10), 1), 100);
      const offset = (page - 1) * limit;
 
      // ---- on-order sub-select (quantity on open purchase orders, in strips)
            // ---- on-order sub-select (quantity on open purchase orders)
      const onOrderSelect = LOW_STOCK_INCLUDE_ON_ORDER
        ? `COALESCE((
             SELECT SUM(ppi.quantity)
               FROM pharmacy_purchase_items ppi
               JOIN pharmacy_purchase_orders ppo ON ppo.id = ppi.purchase_id
              WHERE ppi.medicine_id = pm.id
                AND ppo.admin_id   = pm.admin_id
                AND ppo.status IN (${LOW_STOCK_OPEN_PO_STATUSES.map(() => "?").join(", ")})
           ), 0)`
        : `0`;
 
      const searchClause = search
        ? `AND (md.medicine_name LIKE ? OR md.brand_name LIKE ? OR pm.medicine_code LIKE ?)`
        : "";

      /* ---- per branch under "All branches" (6 Nov 2026)
         reorder_level is one number per medicine, but stock lives per branch and a branch can
         only sell its own batches. Adding every branch together and comparing the total hid a
         branch that had run out (Dolo 0 in P2 + 40 in P1 = 40 > 20 → not "low"). So, in a
         multi-branch pharmacy with no branch picked, each branch is checked on its own: one row
         per medicine × branch, carrying `branch`. Same rule as lowStockQuery() in
         pharmacySalesReports.js. One branch picked / staff / single-branch: unchanged.
         Batches with no branch count for no branch here, as at the POS. */
      const perBranch = !!(scope.multi && !scope.filter && scope.branches && scope.branches.length);
      const branchParams = [];
      let branchCol = "NULL";
      let branchJoin = "";
      let batchBranch = bf.sql;
      let groupBranch = "";
      if (perBranch) {
        branchJoin =
          "CROSS JOIN (" +
          scope.branches.map(() => "SELECT ? AS branch, ? AS bkey").join(" UNION ALL ") +
          ") br";
        scope.branches.forEach((b) => branchParams.push(b, String(b).trim().toLowerCase()));
        branchCol = "br.branch";
        batchBranch = "AND pmb.branch IS NOT NULL AND LOWER(TRIM(pmb.branch)) = br.bkey";
        groupBranch = "br.branch, br.bkey, ";
      }
 
      /* ----------------------------------------------------------------
         One roll-up row per medicine. Reused verbatim by the summary
         query and the paged query, so the chips and the table can never
         disagree about what "low stock" means.
      ---------------------------------------------------------------- */
      const baseSql = `
        SELECT
          ${branchCol}                            AS branch,
          pm.id                                   AS medicine_id,
          COALESCE(md.brand_name, md.medicine_name) AS brand_name,
          md.medicine_name                        AS medicine_name,
          md.dosage_form                          AS dosage_form,
          md.strength                             AS strength,
          pm.pack_size                            AS pack_size,
          pm.medicine_code                        AS medicine_code,
 
          CASE WHEN pm.reorder_level IS NULL OR pm.reorder_level <= 0
               THEN ?
               ELSE pm.reorder_level
          END                                     AS reorder_level,
          CASE WHEN pm.reorder_level IS NULL OR pm.reorder_level <= 0
               THEN 1 ELSE 0
          END                                     AS reorder_level_is_default,
 
          /* sellable now: active batches that haven't expired */
          COALESCE(SUM(
            CASE WHEN pmb.id IS NOT NULL
                  AND pmb.status = 'active'
                  AND (pmb.expiry_date IS NULL OR pmb.expiry_date >= CURDATE())
                 THEN ${LOW_STOCK_STRIPS} ELSE 0 END
          ), 0)                                   AS current_stock,
 
          /* shown as a note on the row, never counted as stock */
          COALESCE(SUM(
            CASE WHEN pmb.id IS NOT NULL
                  AND (pmb.status = 'expired'
                       OR (pmb.expiry_date IS NOT NULL AND pmb.expiry_date < CURDATE()))
                 THEN ${LOW_STOCK_STRIPS} ELSE 0 END
          ), 0)                                   AS expired_stock,
 
          MIN(
            CASE WHEN pmb.status = 'active'
                  AND pmb.quantity_available > 0
                  AND (pmb.expiry_date IS NULL OR pmb.expiry_date >= CURDATE())
                 THEN pmb.expiry_date END
          )                                       AS earliest_expiry,
 
          /* last rate paid, per strip — newest batch that carries a price */
          (
            SELECT pb.purchase_price
              FROM pharmacy_medicine_batches pb
             WHERE pb.medicine_id = pm.id
               AND pb.admin_id    = pm.admin_id
               AND pb.purchase_price IS NOT NULL
             ORDER BY pb.created_at DESC, pb.id DESC
             LIMIT 1
          )                                       AS purchase_price,
 
          ${onOrderSelect}                        AS on_order
 
        FROM pharmacy_medicines pm
        JOIN medicine_data md ON md.id = pm.medicine_data_id
        ${branchJoin}
 
        /* LEFT JOIN + branch filter in the ON clause: a medicine with no
           batches in this branch must still surface as out of stock. */
        LEFT JOIN pharmacy_medicine_batches pmb
               ON pmb.medicine_id = pm.id
              AND pmb.admin_id    = ?
              ${batchBranch}
 
        WHERE pm.admin_id = ?
          AND pm.status   = 'active'
          ${searchClause}
 
        GROUP BY ${groupBranch}pm.id
      `;
 
      const baseParams = [];
      baseParams.push(LOW_STOCK_DEFAULT_LEVEL); // reorder_level CASE
      if (LOW_STOCK_INCLUDE_ON_ORDER) baseParams.push(...LOW_STOCK_OPEN_PO_STATUSES);
      baseParams.push(...branchParams); // derived branch table (per-branch only)
      baseParams.push(tenantAdminId, ...(perBranch ? [] : bf.params)); // batch join
      baseParams.push(tenantAdminId); // medicines
      if (search) {
        const like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        baseParams.push(like, like, like);
      }
 
      const LOW_STOCK_PREDICATE = "s.current_stock <= s.reorder_level";
 
      /* ---- 1. summary: counts over the search-filtered set (but NOT the
               `only` filter), so the All / Out of stock / Low chips stay
               correct while a tab is active. */
      const [summaryRows] = await db.query(
        `SELECT
           COUNT(*)                                              AS total,
           SUM(CASE WHEN s.current_stock <= 0 THEN 1 ELSE 0 END)  AS out_of_stock,
           SUM(CASE WHEN s.current_stock >  0 THEN 1 ELSE 0 END)  AS low,
           SUM(CASE WHEN s.on_order      >  0 THEN 1 ELSE 0 END)  AS already_on_order
         FROM (${baseSql}) s
         WHERE ${LOW_STOCK_PREDICATE}`,
        baseParams
      );
 
      const sum = summaryRows[0] || {};
      const summary = {
        total: Number(sum.total || 0),
        out_of_stock: Number(sum.out_of_stock || 0),
        low: Number(sum.low || 0),
        already_on_order: Number(sum.already_on_order || 0),
        default_reorder_level: LOW_STOCK_DEFAULT_LEVEL,
      };
 
      // Pagination total = the count of the tab the user is looking at.
      const total =
        only === "out_of_stock"
          ? summary.out_of_stock
          : only === "low"
          ? summary.low
          : summary.total;
 
      if (total === 0) {
        return res.json({
          success: true,
          data: [],
          summary,
          pagination: { total: 0, page, limit, pages: 0 },
        });
      }
 
      // ---- 2. the page of rows
      const onlyClause =
        only === "out_of_stock"
          ? "AND s.current_stock <= 0"
          : only === "low"
          ? "AND s.current_stock > 0"
          : "";
 
      const [rows] = await db.query(
        `SELECT
           s.*,
           CASE WHEN s.current_stock <= 0 THEN 'out_of_stock' ELSE 'low' END AS stock_status,
           GREATEST(CEIL(s.reorder_level * ?) - s.current_stock - s.on_order, 0) AS suggested_quantity
         FROM (${baseSql}) s
         WHERE ${LOW_STOCK_PREDICATE}
           ${onlyClause}
         ORDER BY
           (s.current_stock <= 0) DESC,              /* out of stock first    */
           (s.reorder_level - s.current_stock) DESC, /* then biggest shortfall */
           s.brand_name ASC,
           s.branch ASC
         LIMIT ? OFFSET ?`,
        [LOW_STOCK_TOP_UP_MULTIPLIER, ...baseParams, limit, offset]
      );
 
      const data = rows.map((r) => ({
        branch: r.branch || null, // set only for the per-branch rows of "All branches"
        medicine_id: r.medicine_id,
        brand_name: r.brand_name,
        medicine_name: r.medicine_name,
        dosage_form: r.dosage_form,
        strength: r.strength,
        pack_size: r.pack_size,
        medicine_code: r.medicine_code,
        current_stock: Number(r.current_stock || 0),
        expired_stock: Number(r.expired_stock || 0),
        reorder_level: Number(r.reorder_level || 0),
        reorder_level_is_default: Number(r.reorder_level_is_default) === 1,
        on_order: Number(r.on_order || 0),
        suggested_quantity: Number(r.suggested_quantity || 0),
        earliest_expiry: r.earliest_expiry || null,
        purchase_price: r.purchase_price == null ? null : Number(r.purchase_price),
        stock_status: r.stock_status,
      }));
 
      return res.json({
        success: true,
        data,
        summary,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      console.error("Low stock error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load low stock",
      });
    }
  }
);


router.get(
  "/expiry-alerts",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
 
      // Branch scoping — a branch shouldn't be chasing another branch's stock.
      let scope;
      try {
        scope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        // M3: sendBranchError only answers BranchErrors; anything else used to leave the request hanging
        if (sendBranchError(res, e)) return;
        console.error("Branch scope error:", e);
        return res.status(500).json({ success: false, message: "Couldn't work out the branch for this request" });
      }
      const bf = batchFilter(scope, "pmb");
 
      // ---- inputs
      const allowedOnly = ["all", "expired", "within_30d", "expiring"];
      const rawOnly = req.query.only || req.query.filter;
      const only = allowedOnly.includes(rawOnly) ? rawOnly : "all";
 
      // Window from the "Next N days" dropdown. Clamped so a stray value
      // can't turn this into a full table scan of every future batch.
      const withinDays = Math.min(
        Math.max(toInt(req.query.within ?? req.query.days, 30), 1),
        365
      );
 
      const search = (req.query.search ?? req.query.q ?? "").trim();
      const page = Math.max(toInt(req.query.page, 1), 1);
      const limit = Math.min(Math.max(toInt(req.query.limit, 10), 1), 100);
      const offset = (page - 1) * limit;
 
      /* ---- scope of the whole screen: anything already expired, plus
              anything expiring inside the chosen window. The tabs then cut
              this set up; the chips count all of it. */
      const whereConditions = [
        "pmb.admin_id = ?",
        `pmb.status IN (${EXPIRY_ALERT_STATUSES.map(() => "?").join(", ")})`,
        "pmb.quantity_available > 0",
        "pmb.expiry_date IS NOT NULL",
        "pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)",
      ];
      const params = [tenantAdminId, ...EXPIRY_ALERT_STATUSES, withinDays];
 
      if (bf.sql) {
        whereConditions.push(bf.sql.replace(/^\s*AND\s+/i, ""));
        params.push(...bf.params);
      }
 
      if (search) {
        const like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        whereConditions.push(`(
          pmb.batch_number  LIKE ? OR
          md.medicine_name  LIKE ? OR
          md.brand_name     LIKE ? OR
          pm.medicine_code  LIKE ?
        )`);
        params.push(like, like, like, like);
      }
 
      const whereClause = whereConditions.join(" AND ");
 
      const FROM_SQL = `
        FROM pharmacy_medicine_batches pmb
        JOIN pharmacy_medicines pm      ON pm.id = pmb.medicine_id
        JOIN medicine_data md           ON md.id = pm.medicine_data_id
        LEFT JOIN pharmacy_suppliers ps ON ps.id = pmb.supplier_id
        WHERE ${whereClause}
      `;
 
      // Strips, for the value-at-risk figure. Row quantities are converted
      // by batchToStripView instead — don't convert them twice.
      const STRIPS = `
        FLOOR(
          pmb.quantity_available /
          GREATEST(COALESCE(NULLIF(pmb.units_per_pack, 0),
                            NULLIF(pm.units_per_pack, 0),
                            NULLIF(pm.pack_size, 0), 1), 1)
        )
      `;
 
      /* ---- 1. summary: counts over the whole window so the All / Expired /
               Within 30d / Expiring chips stay put while a tab is active. */
      const [summaryRows] = await db.query(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN pmb.expiry_date <  CURDATE() THEN 1 ELSE 0 END) AS expired,
           SUM(CASE WHEN pmb.expiry_date >= CURDATE()
                     AND pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
                    THEN 1 ELSE 0 END)                                   AS within_30d,
           SUM(CASE WHEN pmb.expiry_date >= CURDATE() THEN 1 ELSE 0 END) AS expiring,
           COALESCE(SUM(${STRIPS} * COALESCE(pmb.purchase_price, 0)), 0) AS value_at_risk
         ${FROM_SQL}`,
        params
      );
 
      const sum = summaryRows[0] || {};
      const summary = {
        total: Number(sum.total || 0),
        expired: Number(sum.expired || 0),
        within_30d: Number(sum.within_30d || 0),
        expiring: Number(sum.expiring || 0),
        value_at_risk: Number(sum.value_at_risk || 0),
        within_days: withinDays,
      };
 
      // ---- tab filter
      const onlyClause =
        only === "expired"
          ? "AND pmb.expiry_date < CURDATE()"
          : only === "within_30d"
          ? "AND pmb.expiry_date >= CURDATE() AND pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)"
          : only === "expiring"
          ? "AND pmb.expiry_date >= CURDATE()"
          : "";
 
      const total =
        only === "expired"
          ? summary.expired
          : only === "within_30d"
          ? summary.within_30d
          : only === "expiring"
          ? summary.expiring
          : summary.total;
 
      if (total === 0) {
        return res.json({
          success: true,
          data: [],
          summary,
          pagination: { total: 0, page, limit, pages: 0 },
        });
      }
 
      // ---- 2. the page of rows, soonest expiry first
      const [rows] = await db.query(
        `SELECT
           pmb.id, pmb.medicine_id, pmb.batch_number,
           pmb.expiry_date, pmb.manufacturing_date,
           pmb.quantity_available, pmb.quantity_received, pmb.free_quantity,
           pmb.purchase_price, pmb.selling_price, pmb.mrp,
           pmb.units_per_pack, pmb.branch, pmb.storage_location,
           pmb.supplier_id, pmb.status,
           md.medicine_name, md.brand_name, md.dosage_form, md.strength,
           pm.medicine_code, pm.pack_size,
           ps.supplier_name,
           DATEDIFF(pmb.expiry_date, CURDATE()) AS days_to_expiry,
           ${STRIPS} * COALESCE(pmb.purchase_price, 0) AS stock_value,
           CASE
             WHEN pmb.expiry_date <  CURDATE() THEN 'expired'
             WHEN pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 'critical'
             WHEN pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 90 DAY) THEN 'warning'
             ELSE 'ok'
           END AS urgency
         ${FROM_SQL}
           ${onlyClause}
         ORDER BY pmb.expiry_date ASC, pmb.id ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
 
      return res.json({
        success: true,
        data: batchesToStripView(rows),
        summary,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      console.error("Expiry alerts error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load expiry alerts",
      });
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
  async (req, res, next) => {
    // "/expiring" is registered further down this file, so without this guard it would
    // land here as id = "expiring" and 404. Anything that is not a positive integer
    // falls through to the literal routes below.
    if (!/^\d+$/.test(String(req.params.id))) return next();
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [batch] = await db.query(
        `SELECT 
           pmb.id, pmb.admin_id, pmb.medicine_id, pmb.batch_number,
           pmb.manufacturing_date, pmb.expiry_date,
           pmb.purchase_price, pmb.selling_price, pmb.mrp,
           pmb.quantity_received, pmb.quantity_available, pmb.free_quantity,
           pmb.units_per_pack, pmb.branch, pmb.storage_location,
           pmb.supplier_id, pmb.status, pmb.created_at, pmb.updated_at,
           md.medicine_name, md.brand_name, md.generic_name,
           md.dosage_form, md.strength,
           pm.medicine_code, pm.barcode, pm.hsn_code, pm.gst_percentage,
           ps.supplier_name, ps.contact_person, ps.phone AS supplier_phone,
           DATEDIFF(pmb.expiry_date, CURDATE()) AS days_to_expiry
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
        data: batchToStripView(batch[0]),
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
   
   NOTE: medicine_id, batch_number, and quantity_received are IMMUTABLE.
         They represent historical facts about this stock intake event.
         To record more stock of same medicine, create a NEW batch.
============================================================ */
router.put(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
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
      } = req.body;

      // Verify ownership
      const [existing] = await db.query(
        `SELECT id, quantity_received, quantity_available, units_per_pack
           FROM pharmacy_medicine_batches
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Batch not found",
        });
      }

      const updates = [];
      const params = [];

      // ── manufacturing_date ──
      if (manufacturing_date !== undefined) {
        if (manufacturing_date && !isValidDate(manufacturing_date)) {
          return res.status(400).json({
            success: false,
            message: "manufacturing_date must be a valid date",
          });
        }
        updates.push("manufacturing_date = ?");
        params.push(manufacturing_date || null);
      }

      // ── expiry_date ──
      if (expiry_date !== undefined) {
        if (!isValidDate(expiry_date)) {
          return res.status(400).json({
            success: false,
            message: "expiry_date must be a valid date",
          });
        }
        updates.push("expiry_date = ?");
        params.push(expiry_date);
      }

      // ── purchase_price ──
      if (purchase_price !== undefined) {
        const p = toDecimal(purchase_price, 0);
        if (p < 0) {
          return res.status(400).json({
            success: false,
            message: "Purchase price cannot be negative",
          });
        }
        updates.push("purchase_price = ?");
        params.push(p);
      }

      // ── selling_price ──
      if (selling_price !== undefined) {
        const s = toDecimal(selling_price, 0);
        if (s < 0) {
          return res.status(400).json({
            success: false,
            message: "Selling price cannot be negative",
          });
        }
        updates.push("selling_price = ?");
        params.push(s);
      }

      // ── mrp ──
      if (mrp !== undefined) {
        const m = toDecimal(mrp, 0);
        if (m < 0) {
          return res.status(400).json({
            success: false,
            message: "MRP cannot be negative",
          });
        }
        updates.push("mrp = ?");
        params.push(m);
      }

      // ── quantity_available (stock correction) ──
      // Sent in STRIPS by the form; stored in tablets.
      const uppExisting = unitsPerPack(existing[0]);
      const receivedStrips = stripsOf(existing[0].quantity_received, uppExisting);
      if (quantity_available !== undefined) {
        const qa = toInt(quantity_available, 0);
        if (qa < 0) {
          return res.status(400).json({
            success: false,
            message: "Quantity available cannot be negative",
          });
        }
        if (qa > receivedStrips) {
          return res.status(400).json({
            success: false,
            message: `Quantity available (${qa}) cannot exceed quantity received (${receivedStrips})`,
          });
        }
        updates.push("quantity_available = ?");
        params.push(tabletsOf(qa, uppExisting));
      }

      // ── free_quantity ──
      if (free_quantity !== undefined) {
        const fq = toInt(free_quantity, 0);
        if (fq < 0) {
          return res.status(400).json({
            success: false,
            message: "Free quantity cannot be negative",
          });
        }
        updates.push("free_quantity = ?");
        params.push(tabletsOf(fq, uppExisting));
      }

      // ── supplier_id ──
      if (supplier_id !== undefined) {
        if (supplier_id === null || supplier_id === "") {
          updates.push("supplier_id = ?");
          params.push(null);
        } else {
          const [supplierCheck] = await db.query(
            `SELECT id FROM pharmacy_suppliers 
             WHERE id = ? AND admin_id = ? LIMIT 1`,
            [supplier_id, tenantAdminId]
          );
          if (!supplierCheck.length) {
            return res.status(404).json({
              success: false,
              message: "Supplier not found in your organization",
            });
          }
          updates.push("supplier_id = ?");
          params.push(supplier_id);
        }
      }

      // ── status ──
      if (status !== undefined) {
        if (!["active", "expired", "blocked"].includes(status)) {
          return res.status(400).json({
            success: false,
            message: "Invalid status. Use 'active', 'expired', or 'blocked'",
          });
        }
        updates.push("status = ?");
        params.push(status);
      }

      if (!updates.length) {
        return res.status(400).json({
          success: false,
          message: "No fields to update",
        });
      }

      params.push(id, tenantAdminId);

      await db.query(
        `UPDATE pharmacy_medicine_batches
         SET ${updates.join(", ")}
         WHERE id = ? AND admin_id = ?`,
        params
      );

      // A stock correction made here has to reach the ledger too, otherwise the stock
      // report and the batch quantity drift apart exactly as they used to.
      if (quantity_available !== undefined) {
        const beforeTablets = Number(existing[0].quantity_available) || 0;
        const afterTablets = tabletsOf(toInt(quantity_available, 0), uppExisting);
        const delta = afterTablets - beforeTablets;
        if (delta !== 0) {
          await db.query(
            `INSERT INTO pharmacy_stock_transactions
               (admin_id, medicine_id, batch_id, transaction_type,
                reference_id, reference_number, quantity_in, quantity_out,
                balance_quantity, transaction_date, notes, created_by)
             SELECT ?, medicine_id, id, 'adjustment', NULL, batch_number, ?, ?, ?, NOW(), ?, ?
               FROM pharmacy_medicine_batches WHERE id = ? AND admin_id = ?`,
            [
              tenantAdminId,
              delta > 0 ? delta : 0,
              delta < 0 ? -delta : 0,
              afterTablets,
              "Stock corrected while editing the batch",
              req.user.id,
              id,
              tenantAdminId,
            ]
          );
        }
      }

      // Return updated row with joined data
      const [updated] = await db.query(
        `SELECT
           pmb.id, pmb.medicine_id, pmb.batch_number,
           pmb.manufacturing_date, pmb.expiry_date,
           pmb.purchase_price, pmb.selling_price, pmb.mrp,
           pmb.quantity_received, pmb.quantity_available, pmb.free_quantity,
           pmb.units_per_pack, pmb.branch, pmb.storage_location,
           pmb.supplier_id, pmb.status, pmb.created_at, pmb.updated_at,
           md.medicine_name, md.brand_name,
           pm.medicine_code,
           ps.supplier_name,
           DATEDIFF(pmb.expiry_date, CURDATE()) AS days_to_expiry
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm      ON pm.id = pmb.medicine_id
         JOIN medicine_data md           ON md.id = pm.medicine_data_id
         LEFT JOIN pharmacy_suppliers ps ON ps.id = pmb.supplier_id
         WHERE pmb.id = ?`,
        [id]
      );

      return res.json({
        success: true,
        message: "Batch updated successfully",
        data: batchToStripView(updated[0]),
      });
    } catch (err) {
      console.error("Update batch error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update batch",
      });
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
      const { id } = req.params;

      const [existing] = await db.query(
        `SELECT pmb.id, pmb.batch_number, md.medicine_name 
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm ON pm.id = pmb.medicine_id
         JOIN medicine_data md      ON md.id = pm.medicine_data_id
         WHERE pmb.id = ? AND pmb.admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Batch not found",
        });
      }

      await db.query(
        `UPDATE pharmacy_medicine_batches 
         SET status = 'blocked' 
         WHERE id = ? AND admin_id = ?`,
        [id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `Batch '${existing[0].batch_number}' of '${existing[0].medicine_name}' has been blocked`,
      });
    } catch (err) {
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
      const { id } = req.params;
      const { status } = req.body;

      if (!status || !["active", "expired", "blocked"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Valid status is required: 'active', 'expired', or 'blocked'",
        });
      }

      const [existing] = await db.query(
        `SELECT pmb.id, pmb.batch_number, pmb.status, md.medicine_name 
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm ON pm.id = pmb.medicine_id
         JOIN medicine_data md      ON md.id = pm.medicine_data_id
         WHERE pmb.id = ? AND pmb.admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Batch not found",
        });
      }

      await db.query(
        `UPDATE pharmacy_medicine_batches 
         SET status = ? 
         WHERE id = ? AND admin_id = ?`,
        [status, id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `Batch '${existing[0].batch_number}' status changed to '${status}'`,
        data: { id: Number(id), status },
      });
    } catch (err) {
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
     - adjustment: +5 (add) or -3 (remove)
     - reason:     text describing why (e.g., 'damage', 'stock correction')
============================================================ */
router.patch(
  "/:id/adjust-stock",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
      const { adjustment, reason } = req.body;

      const adj = toInt(adjustment, null);
      if (adj === null || adj === 0) {
        return res.status(400).json({
          success: false,
          message: "adjustment must be a non-zero integer (positive or negative)",
        });
      }

      // The form sends an adjustment in STRIPS; the batch is counted in tablets.
      // recordMove does the whole thing in one transaction with the row locked, and
      // writes the ledger row — the old code did a read-modify-write with no lock and
      // left the ledger untouched, so the stock report drifted from the batch.
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        const [existing] = await conn.query(
          `SELECT pmb.id, pmb.batch_number, pmb.quantity_available, pmb.quantity_received,
                  pmb.units_per_pack, pm.pack_size, md.medicine_name
           FROM pharmacy_medicine_batches pmb
           JOIN pharmacy_medicines pm ON pm.id = pmb.medicine_id
           JOIN medicine_data md      ON md.id = pm.medicine_data_id
           WHERE pmb.id = ? AND pmb.admin_id = ? LIMIT 1`,
          [id, tenantAdminId]
        );

        if (!existing.length) {
          await conn.rollback();
          return res.status(404).json({
            success: false,
            message: "Batch not found",
          });
        }

        const row = existing[0];
        const upp = unitsPerPack(row);
        const tabletsDelta = tabletsOf(Math.abs(adj), upp);
        const stripsBefore = stripsOf(row.quantity_available, upp);
        const stripsReceived = stripsOf(row.quantity_received, upp);

        if (adj < 0 && tabletsDelta > Number(row.quantity_available)) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: `Insufficient stock. Available: ${stripsBefore}, requested reduction: ${Math.abs(adj)}`,
          });
        }

        if (adj > 0 && stripsBefore + adj > stripsReceived) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: `Cannot exceed quantity received (${stripsReceived})`,
          });
        }

        const newTablets = await recordMove(conn, {
          adminId: tenantAdminId,
          userId: req.user.id,
          batchId: Number(id),
          tabletsIn: adj > 0 ? tabletsDelta : 0,
          tabletsOut: adj < 0 ? tabletsDelta : 0,
          type: "adjustment",
          referenceNumber: row.batch_number,
          notes: reason?.trim() || `Manual adjustment of ${adj > 0 ? "+" : ""}${adj} strips`,
        });

        await conn.commit();

        const newStrips = stripsOf(newTablets, upp);
        return res.json({
          success: true,
          message: `Stock adjusted by ${adj > 0 ? "+" : ""}${adj}. New quantity: ${newStrips}`,
          data: {
            id: Number(id),
            previous_quantity: stripsBefore,
            adjustment: adj,
            new_quantity: newStrips,
            reason: reason?.trim() || null,
          },
        });
      } catch (e) {
        await conn.rollback();
        if (e && e.status) {
          return res.status(e.status).json({ success: false, message: e.message });
        }
        throw e;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error("Adjust stock error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to adjust stock",
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
============================================================ */
router.get(
  "/reports/expiring",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const withinDays = toInt(req.query.within_days, 90);

      const [rows] = await db.query(
        `SELECT 
           pmb.id, pmb.batch_number, pmb.expiry_date,
           pmb.quantity_available, pmb.purchase_price, pmb.selling_price,
           pmb.units_per_pack, pmb.branch, pmb.storage_location,
           md.medicine_name, md.brand_name, md.dosage_form, md.strength,
           pm.medicine_code,
           ps.supplier_name,
           DATEDIFF(pmb.expiry_date, CURDATE()) AS days_to_expiry,
           CASE 
             WHEN pmb.expiry_date < CURDATE() THEN 'expired'
             WHEN pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 'critical'
             WHEN pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 90 DAY) THEN 'warning'
             ELSE 'ok'
           END AS urgency
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm      ON pm.id = pmb.medicine_id
         JOIN medicine_data md           ON md.id = pm.medicine_data_id
         LEFT JOIN pharmacy_suppliers ps ON ps.id = pmb.supplier_id
         WHERE pmb.admin_id = ?
           AND pmb.status = 'active'
           AND pmb.quantity_available > 0
           AND pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
         ORDER BY pmb.expiry_date ASC`,
        [tenantAdminId, withinDays]
      );

      return res.json({
        success: true,
        data: batchesToStripView(rows),
        total: rows.length,
        within_days: withinDays,
      });
    } catch (err) {
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
============================================================ */
router.get(
  "/medicine/:medicine_id/available",
  authMiddleware,
  // M7: billing screens need this read — a cashier holding only pharmacy.sales.create must be able to use it
  allowPermissions("pharmacy.medicines.view", "pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { medicine_id } = req.params;

      // Branch scoping, so the POS is never offered a batch sitting in another branch.
      let scope;
      try {
        scope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        // M3: sendBranchError only answers BranchErrors; anything else used to leave the request hanging
        if (sendBranchError(res, e)) return;
        console.error("Branch scope error:", e);
        return res.status(500).json({ success: false, message: "Couldn't work out the branch for this request" });
      }
      const bf = batchFilter(scope, "pmb");

      const [rows] = await db.query(
        `SELECT
           pmb.id, pmb.batch_number, pmb.expiry_date,
           pmb.quantity_available, pmb.selling_price, pmb.mrp,
           pmb.purchase_price, pmb.units_per_pack, pmb.branch, pmb.storage_location,
           DATEDIFF(pmb.expiry_date, CURDATE()) AS days_to_expiry
         FROM pharmacy_medicine_batches pmb
         WHERE pmb.admin_id = ?
           AND pmb.medicine_id = ?
           AND pmb.status = 'active'
           AND pmb.quantity_available > 0
           AND pmb.expiry_date >= CURDATE()
           ${bf.sql}
         ORDER BY pmb.expiry_date ASC, pmb.id ASC`,
        [tenantAdminId, medicine_id, ...bf.params]
      );

      // Strips, because that is what the POS counts in. A batch holding only loose
      // tablets reads as 0 strips and the POS filters it out on its own.
      const view = batchesToStripView(rows);
      const totalAvailable = view.reduce(
        (sum, r) => sum + (Number(r.quantity_available) || 0),
        0
      );

      return res.json({
        success: true,
        data: view,
        total_batches: view.length,
        total_quantity_available: totalAvailable,
      });
    } catch (err) {
      console.error("Available batches error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch available batches",
      });
    }
  }
);


// GET /api/pharmacy/batches/expiring?days=90
// GET /api/pharmacy/batches/expiring?days=90&limit=5
/* ============================================================
   H6: UPDATE SHELF LOCATION of one batch  (ported from batches.js, which is not mounted)
   PATCH /api/pharmacy/batches/update/location/:id   { storage_location: "Rack B / Shelf 3" }
   Empty / null → the batch falls back to the medicine's default shelf.
   Staff may only move batches of their own branch; the admin any batch.
   Returns only the fields that changed, so the screen can merge them into its row.
============================================================ */
router.patch(
  "/update/location/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, message: "Invalid batch id" });
      }

      const raw = req.body ? req.body.storage_location : undefined;
      if (raw !== undefined && raw !== null && typeof raw !== "string" && typeof raw !== "number") {
        return res.status(400).json({ success: false, message: "Location must be text" });
      }
      const location = raw === undefined || raw === null ? null : String(raw).trim().replace(/\s+/g, " ") || null;
      if (location && location.length > 100) {
        return res.status(400).json({ success: false, message: "Location can be at most 100 characters" });
      }

      const [[batch]] = await db.query(
        `SELECT pmb.id, pmb.batch_number, pmb.branch, pm.storage_location AS medicine_location
           FROM pharmacy_medicine_batches pmb
           JOIN pharmacy_medicines pm ON pm.id = pmb.medicine_id
          WHERE pmb.id = ? AND pmb.admin_id = ?`,
        [id, tenantAdminId]
      );
      if (!batch) return res.status(404).json({ success: false, message: "Batch not found" });

      let scope;
      try {
        scope = await resolveScope(db, req, { wanted: (req.body && req.body.branch) || req.query.branch });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }
      const batchKey = String(batch.branch || "").trim().toLowerCase();
      if (scope && scope.filter && batchKey !== scope.key) {
        return res.status(403).json({
          success: false,
          message: `Batch ${batch.batch_number} belongs to ${batch.branch ? `the ${batch.branch} branch` : "no branch"}.`,
        });
      }

      await db.query(
        `UPDATE pharmacy_medicine_batches SET storage_location = ?, updated_at = NOW() WHERE id = ? AND admin_id = ?`,
        [location, id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: location
          ? `Batch ${batch.batch_number} is now at ${location}`
          : `Batch ${batch.batch_number} now uses the medicine's default shelf`,
        data: {
          id,
          storage_location: location,
          medicine_location: batch.medicine_location || null,
          location: location || batch.medicine_location || null,
        },
      });
    } catch (err) {
      console.error("Update batch location error:", err);
      return res.status(500).json({ success: false, message: "Failed to update the location" });
    }
  }
);

/* ============================================================
   M10: STOCK TOTAL for the dashboard "Units in stock" tile
   GET /api/pharmacy/batches/stock-total[?branch=Kukatpally]
   Counts sellable stock only: active, not expired, quantity > 0.
   Staff see their own branch; an admin sees all branches unless one is named.
============================================================ */
router.get(
  "/stock-total",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      let scope;
      try {
        scope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }
      const bf = batchFilter(scope, "pmb");
      const [[row]] = await db.query(
        `SELECT COALESCE(SUM(pmb.quantity_available), 0) AS total_units,
                COUNT(*)                                  AS total_batches,
                COUNT(DISTINCT pmb.medicine_id)           AS total_medicines
           FROM pharmacy_medicine_batches pmb
          WHERE pmb.admin_id = ?
            AND pmb.status = 'active'
            AND pmb.quantity_available > 0
            AND (pmb.expiry_date IS NULL OR pmb.expiry_date >= CURDATE())${bf.sql}`,
        [tenantAdminId, ...bf.params]
      );
      return res.json({
        success: true,
        total_units: Number(row.total_units) || 0,
        total_batches: Number(row.total_batches) || 0,
        total_medicines: Number(row.total_medicines) || 0,
        branch: scope && scope.filter ? scope.key : null,
      });
    } catch (err) {
      console.error("Stock total error:", err);
      return res.status(500).json({ success: false, message: "Failed to load stock total" });
    }
  }
);

router.get(
  "/expiring",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {   // ⭐ Add try/catch
      const tenantAdminId = getTenantAdminId(req);
      const days = Number(req.query.days) || 90;
      const limit = Number(req.query.limit) || 5;
      const [rows] = await db.query(
        `SELECT 
           pmb.id, pmb.batch_number, pmb.expiry_date, pmb.quantity_available,
           pmb.units_per_pack, pmb.branch,
           md.medicine_name, pm.manufacturer,
           DATEDIFF(pmb.expiry_date, CURDATE()) AS days_to_expiry
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm ON pm.id = pmb.medicine_id
         JOIN medicine_data md ON md.id = pm.medicine_data_id
         WHERE pmb.admin_id = ?
           AND pmb.status = 'active'
           AND pmb.quantity_available > 0
           AND DATEDIFF(pmb.expiry_date, CURDATE()) BETWEEN 0 AND ?
         ORDER BY pmb.expiry_date ASC
         LIMIT ?`,
        [tenantAdminId, days, limit]
      );
      return res.json({ success: true, data: batchesToStripView(rows), total: rows.length });
    } catch (err) {
      console.error("Expiring batches (short) error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch expiring batches",
      });
    }
  }
);


module.exports = router;