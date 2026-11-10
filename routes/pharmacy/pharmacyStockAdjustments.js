// routes/pharmacy/stock-adjustments.js
//
// Stock adjustments: count corrections, write-offs (expired / damaged / lost), opening stock.
//
// Every POST changes the BATCH and writes the stock ledger in one transaction, through
// utils/pharmacyStock.recordMove() — the shelf and the ledger always agree. Stock is counted in
// TABLETS (utils/pharmacyUnits.js); a quantity can be typed in tablets or in whole strips.
//
//   POST /post
//     body { medicine_id?, batch_id, adjustment_type: 'increase'|'decrease', quantity,
//            unit?: 'tablet'|'strip' (default 'tablet'), reason, notes?, branch? (admin, several branches) }
//     → 201 { success, message, data: { …the adjustment row (quantity in TABLETS),
//                                         unit, quantity_entered, tablets,
//                                         batch: { id, batch_number, units_per_pack, quantity_available, stock_text } },
//             ledger: { previous_balance, new_balance } }
//     400 bad input · 404 batch not found / not in your branch · 409 taking out more than the batch holds
//   GET  /get        list (filters below)        GET /get/:id   one adjustment

const express = require("express");
const router = express.Router();
const db = require("../../db.js");

const { authMiddleware } = require("../../middlewares/authMiddleware.js");
const { allowPermissions } = require("../../middlewares/allowPermissions.js");
const { unitsPerPack, packWord, describeStock, describeSaleQty } = require("../../utils/pharmacyUnits");
const { recordMove } = require("../../utils/pharmacyStock");
const { resolveScope, batchFilter, sendBranchError } = require("../../utils/pharmacyBranch");

/* ============================================================
   IMMUTABLE LOG TABLE
   Only has created_at (no updated_at). Once logged, an
   adjustment is NEVER updated or deleted — that would defeat
   the audit trail. To correct a mistake, POST a new adjustment
   that offsets it (reason='correction'). Same rule as the
   stock ledger.

   Every POST here does THREE writes atomically:
     1. INSERT into pharmacy_stock_adjustments (this table)
     2. UPDATE the batch's quantity_available
     3. INSERT into pharmacy_stock_transactions (the ledger)
   (2 + 3 are recordMove()). If anything fails (e.g. taking out
   more than the batch holds), all of it rolls back.
   pharmacy_stock_adjustments.quantity is in TABLETS from now on
   (rows logged before the strip / tablet change are in strips).
============================================================ */

const VALID_ADJ_TYPES = ["increase", "decrease"];
const VALID_REASONS = [
  "damaged",
  "expired",
  "lost",
  "physical_count",
  "correction",
  "opening_stock",
  "other",
];
// reasons that can only take stock away
const OUT_ONLY = ["damaged", "expired", "lost"];
const UNITS = ["tablet", "strip"];

/* ============================================================
   Helper: map reason → ledger transaction_type
============================================================ */
function reasonToTxnType(reason) {
  if (reason === "damaged") return "damaged";
  if (reason === "expired") return "expired";
  if (reason === "opening_stock") return "opening_stock";
  return "adjustment";
}

/* ============================================================
   Helper: resolve tenant admin_id from req.user
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

const bad = (res, message, status = 400, extra) => res.status(status).json({ success: false, message, ...(extra || {}) });

/* ============================================================
   CREATE — change the batch + log the adjustment + ledger row
   Access:
     - admin (bypass)
     - staff with 'pharmacy.stock.create'
============================================================ */
router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.stock.create"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const tenantAdminId = getTenantAdminId(req);
      const adjustedBy = req.user.id;
      const body = req.body || {};
      const { medicine_id, batch_id, adjustment_type, quantity, reason, notes } = body;
      const unit = body.unit === undefined || body.unit === null || body.unit === "" ? "tablet" : String(body.unit).toLowerCase();

      // ---- Validation ----
      if (!batch_id) return bad(res, "Choose the batch to adjust");
      if (!VALID_ADJ_TYPES.includes(adjustment_type)) {
        return bad(res, "adjustment_type must be 'increase' or 'decrease'");
      }
      if (!VALID_REASONS.includes(reason)) {
        return bad(res, `reason must be one of: ${VALID_REASONS.join(", ")}`);
      }
      if (!UNITS.includes(unit)) return bad(res, "unit must be 'tablet' or 'strip'");
      if (adjustment_type === "increase" && OUT_ONLY.includes(reason)) {
        return bad(res, `A "${reason}" adjustment can only take stock out. Use "correction" or "physical_count" to add stock.`);
      }

      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty <= 0) {
        return bad(res, "quantity must be a whole number above 0");
      }

      await conn.beginTransaction();

      // ---- the batch, in this user's branch ----
      const scope = await resolveScope(conn, req, { wanted: body.branch, forWrite: true });
      const f = batchFilter(scope, "b");
      const [[batch]] = await conn.query(
        `SELECT b.*, m.unit, m.pack_size
           FROM pharmacy_medicine_batches b
           JOIN pharmacy_medicines m ON m.id = b.medicine_id
          WHERE b.id = ? AND b.admin_id = ? ${f.sql}
          FOR UPDATE`,
        [batch_id, tenantAdminId, ...f.params]
      );
      if (!batch) {
        await conn.rollback();
        return bad(res, scope.filter ? `That batch is not in ${scope.branch}.` : "Batch not found", 404);
      }
      if (medicine_id && Number(medicine_id) !== Number(batch.medicine_id)) {
        await conn.rollback();
        return bad(res, "That batch belongs to a different medicine");
      }

      const upp = unitsPerPack(batch);
      const word = packWord(batch, upp);
      const tablets = unit === "strip" ? qty * upp : qty;
      const entered = unit === "strip" ? describeSaleQty(upp > 1 ? "strip" : "pack", qty, word) : describeSaleQty("tablet", qty);
      const previous = Number(batch.quantity_available) || 0;

      if (adjustment_type === "decrease" && tablets > previous) {
        await conn.rollback();
        return bad(
          res,
          `Batch ${batch.batch_number} has only ${describeStock(previous, upp, word)} — you can't take out ${entered}.`,
          409,
          { batch_id: Number(batch.id), available: previous }
        );
      }

      // ---- Insert the adjustment row (quantity in tablets) ----
      const [result] = await conn.query(
        `INSERT INTO pharmacy_stock_adjustments
          (admin_id, medicine_id, batch_id, adjustment_type,
           quantity, reason, notes, adjusted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantAdminId,
          batch.medicine_id,
          batch.id,
          adjustment_type,
          tablets,
          reason,
          notes ? String(notes).trim() : null,
          adjustedBy,
        ]
      );
      const adjustmentId = result.insertId;

      // ---- batch + ledger, together ----
      const newBalance = await recordMove(conn, {
        adminId: tenantAdminId,
        userId: adjustedBy,
        batchId: batch.id,
        tabletsIn: adjustment_type === "increase" ? tablets : 0,
        tabletsOut: adjustment_type === "decrease" ? tablets : 0,
        type: reasonToTxnType(reason),
        referenceId: adjustmentId,
        referenceNumber: `ADJ-${adjustmentId}`,
        notes: `${notes ? `${String(notes).trim()} — ` : ""}Stock ${adjustment_type} (${reason.replace(/_/g, " ")}): ${entered}${unit === "strip" && upp > 1 ? ` = ${tablets} tablets` : ""}`,
      });

      await conn.commit();

      const [row] = await db.query(
        `SELECT * FROM pharmacy_stock_adjustments WHERE id = ?`,
        [adjustmentId]
      );

      return res.status(201).json({
        success: true,
        message: `Stock ${adjustment_type === "increase" ? "added" : "taken out"}: ${entered}. Batch ${batch.batch_number} now has ${describeStock(newBalance, upp, word)}.`,
        data: {
          ...row[0],
          unit,
          quantity_entered: qty,
          tablets,
          batch: {
            id: Number(batch.id),
            batch_number: batch.batch_number,
            branch: batch.branch || null,
            units_per_pack: upp,
            quantity_available: newBalance,
            stock_text: describeStock(newBalance, upp, word),
          },
        },
        ledger: { previous_balance: previous, new_balance: newBalance },
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (sendBranchError(res, err)) return undefined;
      if (err.status && err.status < 500) {
        return res.status(err.status).json({ success: false, message: err.message, ...(err.extra || {}) });
      }
      console.error("Create stock adjustment error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to record stock adjustment",
      });
    } finally {
      conn.release();
    }
  }
);

/* ============================================================
   LIST adjustments (with filters)
   Query params:
     - medicine_id
     - batch_id
     - adjustment_type ('increase' | 'decrease')
     - reason (any of VALID_REASONS)
     - adjusted_by (user id)
     - date_from, date_to
     - page, limit
     - sort_order (ASC | DESC, default DESC = newest first)
     - branch (admin of several branches; staff always see their own)
   Access:
     - admin (bypass)
     - staff with 'pharmacy.stock.view'
   Branch (6 Nov 2026): an adjustment belongs to the branch of its batch. Rows also carry
   batch_number, branch and the medicine's names now, which the screen already shows.
============================================================ */
router.get(
  "/get",
  authMiddleware,
  // 6 Nov 2026: whoever may adjust stock may see the recent adjustments beside the form
  allowPermissions("pharmacy.stock.view", "pharmacy.stock.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const {
        medicine_id,
        batch_id,
        adjustment_type,
        reason,
        adjusted_by,
        date_from,
        date_to,
        page = 1,
        limit = 20,
        sort_order = "DESC",
      } = req.query;

      const where = ["a.admin_id = ?"];
      const params = [tenantAdminId];

      // Branch of the batch: staff → their own; admin → all, or ?branch=
      const scope = await resolveScope(db, req, { wanted: req.query.branch });
      const f = batchFilter(scope, "b");
      if (f.sql) {
        where.push(f.sql.replace(/^\s*AND\s+/i, ""));
        params.push(...f.params);
      }

      if (medicine_id) {
        where.push("a.medicine_id = ?");
        params.push(medicine_id);
      }
      if (batch_id) {
        where.push("a.batch_id = ?");
        params.push(batch_id);
      }
      if (adjustment_type && VALID_ADJ_TYPES.includes(adjustment_type)) {
        where.push("a.adjustment_type = ?");
        params.push(adjustment_type);
      }
      if (reason && VALID_REASONS.includes(reason)) {
        where.push("a.reason = ?");
        params.push(reason);
      }
      if (adjusted_by) {
        where.push("a.adjusted_by = ?");
        params.push(adjusted_by);
      }
      if (date_from) {
        where.push("a.created_at >= ?");
        params.push(date_from);
      }
      if (date_to) {
        where.push("a.created_at <= ?");
        params.push(date_to);
      }

      const whereClause = where.join(" AND ");
      const safeLimit = Math.min(200, Math.max(1, Number(limit) || 20));
      const safePage = Math.max(1, Number(page) || 1);
      const offset = (safePage - 1) * safeLimit;
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      const fromJoins = `
         FROM pharmacy_stock_adjustments a
         LEFT JOIN pharmacy_medicine_batches b ON b.id = a.batch_id
         LEFT JOIN pharmacy_medicines pm       ON pm.id = a.medicine_id
         LEFT JOIN medicine_data md            ON md.id = pm.medicine_data_id`;

      const [countRes] = await db.query(
        `SELECT COUNT(*) as total ${fromJoins}
         WHERE ${whereClause}`,
        params
      );

      const [rows] = await db.query(
        `SELECT a.id, a.admin_id, a.medicine_id, a.batch_id, a.adjustment_type,
                a.quantity, a.reason, a.notes, a.adjusted_by, a.created_at,
                b.batch_number, b.branch,
                md.medicine_name, md.brand_name, md.strength
         ${fromJoins}
         WHERE ${whereClause}
         ORDER BY a.created_at ${safeSortOrder}, a.id ${safeSortOrder}
         LIMIT ? OFFSET ?`,
        [...params, safeLimit, offset]
      );

      return res.json({
        success: true,
        data: rows,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total: countRes[0].total,
          total_pages: Math.ceil(countRes[0].total / safeLimit),
        },
      });
    } catch (err) {
      if (sendBranchError(res, err)) return undefined;
      console.error("List adjustments error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch adjustments",
      });
    }
  }
);

/* ============================================================
   GET single adjustment
============================================================ */
router.get(
  "/get/:id",
  authMiddleware,
  allowPermissions("pharmacy.stock.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      // Staff: only an adjustment on a batch of their own branch (404 otherwise, like Sales)
      const scope = await resolveScope(db, req, { wanted: req.query.branch });
      const f = batchFilter(scope, "b");

      const [rows] = await db.query(
        `SELECT a.id, a.admin_id, a.medicine_id, a.batch_id, a.adjustment_type,
                a.quantity, a.reason, a.notes, a.adjusted_by, a.created_at,
                b.batch_number, b.branch
         FROM pharmacy_stock_adjustments a
         LEFT JOIN pharmacy_medicine_batches b ON b.id = a.batch_id
         WHERE a.id = ? AND a.admin_id = ? ${f.sql}
         LIMIT 1`,
        [id, tenantAdminId, ...f.params]
      );

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Adjustment not found",
        });
      }

      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      if (sendBranchError(res, err)) return undefined;
      console.error("Get adjustment error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch adjustment",
      });
    }
  }
);

/* ============================================================
   Deliberately NO PUT / NO DELETE.
   To correct a mistake, POST a new adjustment that offsets it:
     - wrong "decrease 10" → POST "increase 10" with
       reason='correction' and a note pointing at the original id.
   Both rows stay in the log — that's the audit trail.
============================================================ */

module.exports = router;