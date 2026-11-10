// routes/pharmacy_returns.js
// Mount at /api  →  app.use('/api', require('./routes/pharmacy_returns'));

const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware } = require('../../middlewares/authMiddleware');
const { allowPermissions } = require('../../middlewares/allowPermissions');
// Returned goods are counted in STRIPS on screen and TABLETS in the batch and ledger.
const { tabletsOf, stripsOf } = require('../../utils/pharmacyStripView');
const { unitsPerPack } = require('../../utils/pharmacyUnits');
const { resolveScope, rowFilter, recordScope, branchKey, sendBranchError } = require('../../utils/pharmacyBranch');
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

function getAdminIdFromUser(user) {
  return user.role === 'admin' ? user.id : user.adminId;
}

// ─────────────────────────────────────────────────────────────
// Return policy helpers
// ─────────────────────────────────────────────────────────────
const DEFAULT_POLICY = {
  is_returnable: true,
  window_days: 7,
  condition: 'unopened_only',
  requires_approval_after_window: true,
};

function parsePolicy(raw) {
  if (!raw) return { ...DEFAULT_POLICY };
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...DEFAULT_POLICY, ...obj };
  } catch (e) {
    return { ...DEFAULT_POLICY };
  }
}

/**
 * Check if a return is allowed for this medicine + sale date.
 * Returns { ok, hard_block, can_override, reason, snapshot }
 */
function checkReturnEligibility({ policy, sale_date, medicine_name }) {
  const p = parsePolicy(policy);
  const nowIso = new Date().toISOString();

  // Hard block — not returnable at all
  if (!p.is_returnable) {
    return {
      ok: false,
      hard_block: true,
      can_override: false,
      reason: p.reason || `${medicine_name} is marked as non-returnable`,
      snapshot: {
        is_returnable: false,
        reason: p.reason,
        resolved_at: nowIso,
      },
    };
  }

  // Window check
  const days = Math.floor(
    (Date.now() - new Date(sale_date).getTime()) / 86400000
  );
  const windowDays = p.window_days;
  const withinWindow =
    windowDays === null || windowDays === undefined
      ? true
      : days <= windowDays;

  if (!withinWindow) {
    return {
      ok: false,
      hard_block: false,
      can_override: p.requires_approval_after_window === true,
      reason: `${medicine_name}: return window expired — must return within ${windowDays} days (sold ${days} days ago)`,
      snapshot: {
        is_returnable: true,
        window_days: windowDays,
        condition: p.condition,
        days_since_sale: days,
        within_window: false,
        resolved_at: nowIso,
      },
    };
  }

  // All good
  return {
    ok: true,
    snapshot: {
      is_returnable: true,
      window_days: windowDays,
      condition: p.condition,
      days_since_sale: days,
      within_window: true,
      resolved_at: nowIso,
    },
  };
}


// ─────────────────────────────────────────────────────────────
// GET all returns (excludes cancelled), optional ?type=customer_return|supplier_return
// ─────────────────────────────────────────────────────────────
router.get(
  '/getall/returns',
  authMiddleware,
  allowPermissions('pharmacy.sales-returns.view'),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);

      // Branch: a return belongs to the branch its sale was billed in. Admins choose
      // with the Branch dropdown (?branch=); staff see their own branch only.
      let rScope;
      try {
        rScope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }
      const rBf = rowFilter(rScope, 'pharmacy_returns');

      const params = [admin_id];
      let sql = `
        SELECT *
          FROM pharmacy_returns
         WHERE admin_id = ?
           AND (status IS NULL OR status <> 'cancelled')
           ${rBf.sql}
      `;
      params.push(...rBf.params);
      if (req.query.type) {
        sql += ` AND return_type = ?`;
        params.push(req.query.type);
      }
      sql += ` ORDER BY return_date DESC`;

      const [rows] = await db.query(sql, params);
      res.json({ success: true, data: rows });
    } catch (err) {
      console.error('getall/returns error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET one return with its items
// ─────────────────────────────────────────────────────────────
router.get(
  '/get/return/:id',
  authMiddleware,
  allowPermissions('pharmacy.sales-returns.view'),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);

      const [headerRows] = await db.query(
        `SELECT * FROM pharmacy_returns
          WHERE id = ? AND admin_id = ?
          LIMIT 1`,
        [req.params.id, admin_id]
      );
      const header = headerRows[0];
      if (!header) {
        return res.status(404).json({ success: false, message: 'Return not found' });
      }

      // Branch — 26 Oct 2026: staff see only their own branch's returns. Looked up by id,
      // this used to check admin_id alone. A return elsewhere answers 404, same as none.
      try {
        await recordScope(db, req, header.branch, { notFound: 'Return not found' });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }

      const [items] = await db.query(
        `SELECT pri.*,
                pri.policy_snapshot,
                pri.approved_by,
                s.name AS approved_by_name
          FROM pharmacy_return_items pri
          LEFT JOIN staff s ON s.id = pri.approved_by
          WHERE pri.return_id = ?`,
        [header.id]
      );

      res.json({ success: true, data: { ...header, items } });
    } catch (err) {
      console.error('get/return error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// POST create return + items (transaction)
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// POST create return + items (transaction)
//   - Validates against already-returned quantities
//   - Inserts into pharmacy_returns + pharmacy_return_items
//   - Restores stock in pharmacy_medicine_batches (unless expired/damaged)
//   - Logs movement in pharmacy_stock_transactions
//   - Updates sale.status to partially_returned / returned
// ─────────────────────────────────────────────────────────────
router.post(
  '/post/return',
  authMiddleware,
  allowPermissions('pharmacy.sales-returns.create'),
  async (req, res) => {
    const admin_id = getAdminIdFromUser(req.user);
    const created_by = req.user.id;
    const {
      return_number,
      sale_id,
      patient_id,
      return_date,
      return_type,
      reason,
      total_amount,
      refund_amount,
      status,
      processed_by,
      notes,
      items = [],
    } = req.body;

    // ── Validation ──
    if (!return_number || !return_date || !return_type) {
      return res.status(400).json({
        success: false,
        message: 'return_number, return_date, return_type are required',
      });
    }
    if (!['customer_return', 'supplier_return'].includes(return_type)) {
      return res.status(400).json({
        success: false,
        message: "return_type must be 'customer_return' or 'supplier_return'",
      });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one return item is required',
      });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // ── 0. Branch — 26 Oct 2026 ──
      // This route put stock back into batches and wrote pharmacy_returns with NO branch:
      // the INSERT below omitted the column entirely, so every return was born NULL and
      // invisible to its own branch filter on GET /getall/returns. And nothing stopped a
      // staff member returning against another branch's bill.
      //
      //   against a sale   the return belongs to the SALE's branch (that is where the
      //                    goods left from), and staff may only return their own branch's
      //                    bills — another branch's sale id is a 404
      //   no sale          the branch being worked in: staff → their own; a multi-branch
      //                    admin must choose (forWrite), exactly as when billing
      let returnBranch = null;
      let returnKey = null;
      let multiBranch = false;
      try {
        if (sale_id) {
          const [saleRows] = await conn.query(
            `SELECT id, branch FROM pharmacy_sales WHERE id = ? AND admin_id = ? LIMIT 1`,
            [sale_id, admin_id]
          );
          if (!saleRows.length) {
            await conn.rollback();
            return res.status(404).json({ success: false, message: 'Sale not found' });
          }
          const rs = await recordScope(conn, req, saleRows[0].branch, { notFound: 'Sale not found' });
          multiBranch = rs.scope.multi;
          returnBranch = rs.branch;
          returnKey = rs.key;
          if (multiBranch && !returnKey) {
            // An admin returning against an old sale the backfill could not attribute: the
            // return goes to the branch the admin is working in, if one is picked, rather
            // than inheriting the sale's NULL.
            const working = await resolveScope(conn, req, { wanted: req.body.branch });
            returnBranch = working.branch;
            returnKey = working.key;
          }
        } else {
          const sc = await resolveScope(conn, req, { wanted: req.body.branch, forWrite: true });
          multiBranch = sc.multi;
          returnBranch = sc.branch;
          returnKey = sc.key;
        }
      } catch (e) {
        await conn.rollback();
        if (sendBranchError(res, e)) return;
        throw e;
      }

      // ── 1. Validate against already-returned quantities ──
if (sale_id) {
  const [saleItems] = await conn.query(
    `SELECT si.medicine_id, si.batch_id, si.quantity AS sold_qty,
            ps.sale_date,
            pm.return_policy,
            md.medicine_name,
            COALESCE(SUM(ri.quantity), 0) AS already_returned
       FROM pharmacy_sale_items si
       JOIN pharmacy_sales ps ON ps.id = si.sale_id
       JOIN pharmacy_medicines pm ON pm.id = si.medicine_id
       JOIN medicine_data md ON md.id = pm.medicine_data_id
       LEFT JOIN pharmacy_return_items ri
              ON ri.medicine_id = si.medicine_id
             AND ri.batch_id = si.batch_id
             AND ri.return_id IN (
               SELECT id FROM pharmacy_returns
                WHERE sale_id = ? AND admin_id = ?
                  AND (status IS NULL OR status <> 'cancelled')
             )
      WHERE si.sale_id = ? AND ps.admin_id = ?
      GROUP BY si.medicine_id, si.batch_id, si.quantity, ps.sale_date, pm.return_policy, md.medicine_name`,
    // admin_id added 26 Oct 2026: this lookup filtered on sale_id alone, so a return could
    // be validated against — and restock the batches of — another tenant's sale.
    [sale_id, admin_id, sale_id, admin_id]
  );

  // Attach eligibility to each requested item
  for (const reqItem of items) {
    const match = saleItems.find(
      (s) =>
        s.medicine_id === reqItem.medicine_id &&
        s.batch_id === reqItem.batch_id
    );
    if (!match) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: `Item not in original sale (medicine_id=${reqItem.medicine_id}, batch_id=${reqItem.batch_id})`,
      });
    }

    // Quantity check
    const remaining = match.sold_qty - match.already_returned;
    if (reqItem.quantity > remaining) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: `Return qty (${reqItem.quantity}) exceeds remaining (${remaining}) for ${match.medicine_name}`,
      });
    }
    if (reqItem.quantity <= 0) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: 'Return quantity must be greater than 0',
      });
    }

    // ── Return policy eligibility check ──
    const check = checkReturnEligibility({
      policy: match.return_policy,
      sale_date: match.sale_date,
      medicine_name: match.medicine_name,
    });

    if (!check.ok) {
      // Hard block — never returnable
      if (check.hard_block) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: check.reason,
          medicine_id: reqItem.medicine_id,
        });
      }
      // Soft block — needs override
      if (!check.can_override) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: check.reason,
          medicine_id: reqItem.medicine_id,
        });
      }
      // Needs permission + reason
      const userPerms = req.user.permissions || [];
      const hasOverride =
        req.user.role === 'admin' ||
        userPerms.includes('pharmacy.sales-returns.override');
      if (!hasOverride) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: `${check.reason}. Manager approval required.`,
          medicine_id: reqItem.medicine_id,
        });
      }
      if (!reqItem.override_reason && !req.body.override_reason) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: `Override reason is required to return ${match.medicine_name} past the window`,
          medicine_id: reqItem.medicine_id,
        });
      }
      // Attach override info to snapshot
      check.snapshot.overridden = true;
      check.snapshot.override_reason =
        reqItem.override_reason || req.body.override_reason;
      check.snapshot.approved_by = created_by;
    }

    // Attach snapshot to the request item for later insert
    reqItem._snapshot = check.snapshot;
    reqItem._approved_by = check.snapshot.overridden ? created_by : null;
  }
}

      // ── 2. Insert return header ──
      const [headerResult] = await conn.query(
        `INSERT INTO pharmacy_returns
           (admin_id, branch, return_number, sale_id, patient_id, return_date, return_type,
            reason, total_amount, refund_amount, status, processed_by, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          admin_id,
          returnBranch || null,   // was never written — see step 0
          return_number,
          sale_id || null,
          patient_id || null,
          return_date,
          return_type,
          reason || null,
          total_amount || 0,
          refund_amount || 0,
          status || 'completed',
          processed_by || created_by,
          notes || null,
        ]
      );
      const return_id = headerResult.insertId;

     // ── 3. Insert return items (with policy_snapshot + approved_by) ──
        const itemRows = items.map((it) => [
          return_id,
          it.medicine_id,
          it.batch_id,
          it.quantity,
          it.unit_price,
          it.total_amount != null
            ? it.total_amount
            : (it.quantity || 0) * (it.unit_price || 0),
          it._snapshot ? JSON.stringify(it._snapshot) : null,
          it._approved_by || null,
        ]);
        await conn.query(
          `INSERT INTO pharmacy_return_items
            (return_id, medicine_id, batch_id, quantity, unit_price, total_amount,
              policy_snapshot, approved_by)
          VALUES ?`,
          [itemRows]
        );

      // ── 4. Decide stock behavior based on reason ──
      // unused / customer request / wrong_item → restore to stock
      // expired / damaged → do NOT restore (quarantine)
      const restoreToStock =
        return_type === 'customer_return' &&
        !['expired', 'damaged'].includes(reason);

      // ── 5. Process each item: update batches + log stock transaction ──
      for (const it of items) {
        let newBalance = 0;

        // The screens count returned goods in STRIPS; the batch is counted in tablets.
        const [uppRows] = await conn.query(
          `SELECT units_per_pack, branch FROM pharmacy_medicine_batches
            WHERE id = ? AND admin_id = ?`,
          [it.batch_id, admin_id]
        );

        // The goods come back over THIS branch's counter, so they can only go onto this
        // branch's shelf. Without a sale the batch id is whatever the request sent; with
        // one it is the sale's own batch, which can still have moved branch since (a
        // purchase transfer). Either way, a batch elsewhere is refused rather than
        // credited to a shelf the goods never reached.
        if (multiBranch && returnKey && it.batch_id && uppRows[0]
            && branchKey(uppRows[0].branch) !== returnKey) {
          await conn.rollback();
          return res.status(409).json({
            success: false,
            message: `Batch ${it.batch_id} is not in ${returnBranch}, so this return can't put stock back into it.`,
          });
        }
        const uppBatch = unitsPerPack(uppRows[0] || {});
        const tabletsBack = tabletsOf(it.quantity, uppBatch);

        if (restoreToStock && it.batch_id) {
          // Restore stock to the batch, in tablets
          await conn.query(
            `UPDATE pharmacy_medicine_batches
                SET quantity_available = quantity_available + ?
              WHERE id = ? AND admin_id = ?`,
            [tabletsBack, it.batch_id, admin_id]
          );

          // Fetch new balance for stock_transactions log
          const [batchRows] = await conn.query(
            `SELECT quantity_available FROM pharmacy_medicine_batches
              WHERE id = ? AND admin_id = ?`,
            [it.batch_id, admin_id]
          );
          newBalance = batchRows[0]?.quantity_available || 0;
        } else {
          // No stock change — just read current balance for log
          const [batchRows] = await conn.query(
            `SELECT quantity_available FROM pharmacy_medicine_batches
              WHERE id = ? AND admin_id = ?`,
            [it.batch_id, admin_id]
          );
          newBalance = batchRows[0]?.quantity_available || 0;
        }

        // ── Determine transaction_type for log ──
        let txnType = 'return';           // default — customer_return, restorable
        if (return_type === 'supplier_return') {
          txnType = 'purchase_return';
        } else if (reason === 'expired') {
          txnType = 'expired';
        } else if (reason === 'damaged') {
          txnType = 'damaged';
        }

        // ── Log stock transaction ──
        await conn.query(
          `INSERT INTO pharmacy_stock_transactions
             (admin_id, medicine_id, batch_id, transaction_type,
              reference_id, reference_number,
              quantity_in, quantity_out, balance_quantity,
              transaction_date, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
          [
            admin_id,
            it.medicine_id,
            it.batch_id || null,
            txnType,
            return_id,
            return_number,
            // The ledger is kept in tablets, like the batch it balances against.
            restoreToStock ? tabletsBack : 0,     // quantity_in — only if restored
            restoreToStock ? 0 : tabletsBack,     // quantity_out — if quarantined
            newBalance,
            `Return ${return_number} — reason: ${reason || 'N/A'}`,
            created_by,
          ]
        );
      }

      // ── 6. Update sale status based on total returned ──
      if (sale_id) {
        const [statusRows] = await conn.query(
          `SELECT 
             SUM(si.quantity) AS total_sold,
             COALESCE(SUM(ri_sum.returned_qty), 0) AS total_returned
           FROM pharmacy_sale_items si
           LEFT JOIN (
             SELECT ri.medicine_id, ri.batch_id, SUM(ri.quantity) AS returned_qty
             FROM pharmacy_return_items ri
             JOIN pharmacy_returns pr ON pr.id = ri.return_id
             WHERE pr.sale_id = ? AND (pr.status IS NULL OR pr.status <> 'cancelled')
             GROUP BY ri.medicine_id, ri.batch_id
           ) ri_sum 
             ON ri_sum.medicine_id = si.medicine_id 
            AND ri_sum.batch_id = si.batch_id
           WHERE si.sale_id = ?`,
          [sale_id, sale_id]
        );

        const totalSold = Number(statusRows[0]?.total_sold || 0);
        const totalReturned = Number(statusRows[0]?.total_returned || 0);

        let newStatus = 'completed';
        if (totalReturned >= totalSold && totalSold > 0) {
          newStatus = 'returned';
        } else if (totalReturned > 0) {
          newStatus = 'partially_returned';
        }

        await conn.query(
          `UPDATE pharmacy_sales 
              SET status = ? 
            WHERE id = ? AND admin_id = ?`,
          [newStatus, sale_id, admin_id]
        );
      }

      await conn.commit();
      res.json({
        success: true,
        message: 'Return processed successfully',
        return_id,
        stock_restored: restoreToStock,
      });
    } catch (err) {
      await conn.rollback();
      console.error('post/return error:', err);
      res.status(500).json({ success: false, message: err.message });
    } finally {
      conn.release();
    }
  }
);

// ─────────────────────────────────────────────────────────────
// PUT update return header + replace items (transaction)
// ─────────────────────────────────────────────────────────────
router.put(
  '/update/return/:id',
  authMiddleware,
  allowPermissions('pharmacy.sales-returns.edit'),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const admin_id = getAdminIdFromUser(req.user);

      await conn.beginTransaction();

      const [existingRows] = await conn.query(
        `SELECT * FROM pharmacy_returns
          WHERE id = ? AND admin_id = ?
          LIMIT 1`,
        [req.params.id, admin_id]
      );
      const existing = existingRows[0];
      if (!existing) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: 'Return not found' });
      }

      // Branch — 26 Oct 2026: staff see only their own branch's returns. Looked up by id,
      // this used to check admin_id alone. A return elsewhere answers 404, same as none.
      try {
        await recordScope(conn, req, existing.branch, { notFound: 'Return not found' });
      } catch (e) {
        await conn.rollback();
        if (sendBranchError(res, e)) return;
        throw e;
      }

      const {
        return_number,
        sale_id,
        patient_id,
        return_date,
        return_type,
        reason,
        total_amount,
        refund_amount,
        status,
        processed_by,
        notes,
        items,
      } = req.body;

      await conn.query(
        `UPDATE pharmacy_returns
            SET return_number = ?,
                sale_id       = ?,
                patient_id    = ?,
                return_date   = ?,
                return_type   = ?,
                reason        = ?,
                total_amount  = ?,
                refund_amount = ?,
                status        = ?,
                processed_by  = ?,
                notes         = ?
          WHERE id = ? AND admin_id = ?`,
        [
          return_number ?? existing.return_number,
          sale_id !== undefined ? sale_id : existing.sale_id,
          patient_id !== undefined ? patient_id : existing.patient_id,
          return_date ?? existing.return_date,
          return_type ?? existing.return_type,
          reason !== undefined ? reason : existing.reason,
          total_amount ?? existing.total_amount,
          refund_amount ?? existing.refund_amount,
          status ?? existing.status,
          processed_by !== undefined ? processed_by : existing.processed_by,
          notes !== undefined ? notes : existing.notes,
          req.params.id,
          admin_id,
        ]
      );

     if (Array.isArray(items)) {
  await conn.query(
    `DELETE FROM pharmacy_return_items WHERE return_id = ?`,
    [req.params.id]
  );

  if (items.length > 0) {
    // Re-run eligibility if sale_id present
    const effectiveSaleId = sale_id !== undefined ? sale_id : existing.sale_id;
    const snapshotMap = new Map(); // key: medicine_id|batch_id → snapshot

    if (effectiveSaleId) {
      const [policies] = await conn.query(
        `SELECT si.medicine_id, si.batch_id, ps.sale_date,
                pm.return_policy, md.medicine_name
           FROM pharmacy_sale_items si
           JOIN pharmacy_sales ps ON ps.id = si.sale_id
           JOIN pharmacy_medicines pm ON pm.id = si.medicine_id
           JOIN medicine_data md ON md.id = pm.medicine_data_id
          WHERE si.sale_id = ?`,
        [effectiveSaleId]
      );

      for (const it of items) {
        const match = policies.find(
          (p) => p.medicine_id === it.medicine_id && p.batch_id === it.batch_id
        );
        if (match) {
          const check = checkReturnEligibility({
            policy: match.return_policy,
            sale_date: match.sale_date,
            medicine_name: match.medicine_name,
          });
          // Edit mode: trust existing override on the item if provided
          if (!check.ok && it.override_reason) {
            check.snapshot.overridden = true;
            check.snapshot.override_reason = it.override_reason;
            check.snapshot.approved_by = req.user.id;
          }
          snapshotMap.set(
            `${it.medicine_id}|${it.batch_id}`,
            {
              snapshot: check.snapshot,
              approved_by: check.snapshot.overridden ? req.user.id : null,
            }
          );
        }
      }
    }

    const itemRows = items.map((it) => {
      const key = `${it.medicine_id}|${it.batch_id}`;
      const meta = snapshotMap.get(key) || { snapshot: null, approved_by: null };
      return [
        req.params.id,
        it.medicine_id,
        it.batch_id,
        it.quantity,
        it.unit_price,
        it.total_amount != null
          ? it.total_amount
          : (it.quantity || 0) * (it.unit_price || 0),
        meta.snapshot ? JSON.stringify(meta.snapshot) : null,
        meta.approved_by,
      ];
    });

    await conn.query(
      `INSERT INTO pharmacy_return_items
         (return_id, medicine_id, batch_id, quantity, unit_price, total_amount,
          policy_snapshot, approved_by)
       VALUES ?`,
      [itemRows]
    );
  }
}

      await conn.commit();
      res.json({ success: true, message: 'Return updated' });
    } catch (err) {
      await conn.rollback();
      console.error('update/return error:', err);
      res.status(500).json({ success: false, message: err.message });
    } finally {
      conn.release();
    }
  }
);

// ─────────────────────────────────────────────────────────────
// DELETE soft-delete (status = 'cancelled')
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// DELETE soft-delete (status = 'cancelled') + REVERSE stock changes
// ─────────────────────────────────────────────────────────────
router.delete(
  '/delete/return/:id',
  authMiddleware,
  allowPermissions('pharmacy.sales-returns.cancel'),
  async (req, res) => {
    const admin_id = getAdminIdFromUser(req.user);
    const created_by = req.user.id;
    const conn = await db.getConnection();

    try {
      await conn.beginTransaction();

      // 1. Fetch the return + items
      const [returnRows] = await conn.query(
        `SELECT * FROM pharmacy_returns 
          WHERE id = ? AND admin_id = ? LIMIT 1`,
        [req.params.id, admin_id]
      );
      const ret = returnRows[0];
      if (!ret) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: 'Return not found' });
      }

      // Branch — 26 Oct 2026: staff see only their own branch's returns. Looked up by id,
      // this used to check admin_id alone. A return elsewhere answers 404, same as none.
      try {
        await recordScope(conn, req, ret.branch, { notFound: 'Return not found' });
      } catch (e) {
        await conn.rollback();
        if (sendBranchError(res, e)) return;
        throw e;
      }
      if (ret.status === 'cancelled') {
        await conn.rollback();
        return res.status(400).json({ success: false, message: 'Already cancelled' });
      }

      const [items] = await conn.query(
        `SELECT * FROM pharmacy_return_items WHERE return_id = ?`,
        [req.params.id]
      );

      // 2. Reverse stock changes (only if stock was restored originally)
      const wasRestored =
        ret.return_type === 'customer_return' &&
        !['expired', 'damaged'].includes(ret.reason);

      for (const it of items) {
        // Same strip -> tablet translation as the restore above, so cancelling a return
        // takes back exactly what the return put in.
        const [uppRows] = await conn.query(
          `SELECT units_per_pack FROM pharmacy_medicine_batches
            WHERE id = ? AND admin_id = ?`,
          [it.batch_id, admin_id]
        );
        const uppBatch = unitsPerPack(uppRows[0] || {});
        const tabletsBack = tabletsOf(it.quantity, uppBatch);

        if (wasRestored && it.batch_id) {
          // Undo the restore — subtract back
          await conn.query(
            `UPDATE pharmacy_medicine_batches
                SET quantity_available = GREATEST(quantity_available - ?, 0)
              WHERE id = ? AND admin_id = ?`,
            [tabletsBack, it.batch_id, admin_id]
          );
        }

        // Get current balance for log
        const [batchRows] = await conn.query(
          `SELECT quantity_available FROM pharmacy_medicine_batches
            WHERE id = ? AND admin_id = ?`,
          [it.batch_id, admin_id]
        );
        const newBalance = batchRows[0]?.quantity_available || 0;

        // Log reversal in stock_transactions
        await conn.query(
          `INSERT INTO pharmacy_stock_transactions
             (admin_id, medicine_id, batch_id, transaction_type,
              reference_id, reference_number,
              quantity_in, quantity_out, balance_quantity,
              transaction_date, notes, created_by)
           VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, ?, NOW(), ?, ?)`,
          [
            admin_id,
            it.medicine_id,
            it.batch_id || null,
            ret.id,
            ret.return_number,
            0,
            wasRestored ? tabletsBack : 0,
            newBalance,
            `Return ${ret.return_number} cancelled — stock reversed`,
            created_by,
          ]
        );
      }

      // 3. Mark the return as cancelled
      await conn.query(
        `UPDATE pharmacy_returns 
            SET status = 'cancelled' 
          WHERE id = ? AND admin_id = ?`,
        [req.params.id, admin_id]
      );

      // 4. Recalculate sale status
      if (ret.sale_id) {
        const [statusRows] = await conn.query(
          `SELECT 
             SUM(si.quantity) AS total_sold,
             COALESCE(SUM(ri_sum.returned_qty), 0) AS total_returned
           FROM pharmacy_sale_items si
           LEFT JOIN (
             SELECT ri.medicine_id, ri.batch_id, SUM(ri.quantity) AS returned_qty
             FROM pharmacy_return_items ri
             JOIN pharmacy_returns pr ON pr.id = ri.return_id
             WHERE pr.sale_id = ? AND (pr.status IS NULL OR pr.status <> 'cancelled')
             GROUP BY ri.medicine_id, ri.batch_id
           ) ri_sum 
             ON ri_sum.medicine_id = si.medicine_id 
            AND ri_sum.batch_id = si.batch_id
           WHERE si.sale_id = ?`,
          [ret.sale_id, ret.sale_id]
        );

        const totalSold = Number(statusRows[0]?.total_sold || 0);
        const totalReturned = Number(statusRows[0]?.total_returned || 0);
        let newStatus = 'completed';
        if (totalReturned >= totalSold && totalSold > 0) {
          newStatus = 'returned';
        } else if (totalReturned > 0) {
          newStatus = 'partially_returned';
        }

        await conn.query(
          `UPDATE pharmacy_sales SET status = ? WHERE id = ? AND admin_id = ?`,
          [newStatus, ret.sale_id, admin_id]
        );
      }

      await conn.commit();
      res.json({ success: true, message: 'Return cancelled and stock reversed' });
    } catch (err) {
      await conn.rollback();
      console.error('delete/return error:', err);
      res.status(500).json({ success: false, message: err.message });
    } finally {
      conn.release();
    }
  }
);


async function getLogoBuffer(logoSource) {
  if (!logoSource) return null;
  try {
    if (logoSource.startsWith('http://') || logoSource.startsWith('https://')) {
      const response = await axios.get(logoSource, { responseType: 'arraybuffer', timeout: 5000 });
      return Buffer.from(response.data);
    }
    let filePath = logoSource;
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(process.cwd(), logoSource);
    }
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath);
    }
    return null;
  } catch (err) {
    console.error('Logo fetch error:', err.message);
    return null;
  }
}

// Helper: number to Indian words
function numberToWordsIndian(num) {
  if (num === 0) return 'ZERO';
  const ones = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
    'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
  const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
  function twoDigit(n) {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
  }
  function threeDigit(n) {
    let str = '';
    if (n >= 100) { str = ones[Math.floor(n / 100)] + ' HUNDRED '; n = n % 100; }
    if (n > 0) str += twoDigit(n);
    return str.trim();
  }
  let n = Math.floor(num), words = '';
  const crore = Math.floor(n / 10000000); n = n % 10000000;
  const lakh = Math.floor(n / 100000); n = n % 100000;
  const thousand = Math.floor(n / 1000); n = n % 1000;
  if (crore) words += threeDigit(crore) + ' CRORE ';
  if (lakh) words += threeDigit(lakh) + ' LAKH ';
  if (thousand) words += threeDigit(thousand) + ' THOUSAND ';
  if (n) words += threeDigit(n);
  return words.trim();
}

// ============================================================
// RETURN RECEIPT PDF
// GET /api/sales/return/:id/receipt/pdf
// ============================================================
router.get(
  '/:id/receipt/pdf',
  authMiddleware,
  allowPermissions('pharmacy.sales-returns.view'),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const { id } = req.params;

      if (!id || isNaN(Number(id))) {
        return res.status(400).json({ success: false, message: 'Invalid return ID' });
      }

      // ─── 1. Fetch return + original sale + pharmacy + customer ───
      const [returnRows] = await db.query(
        `SELECT
           pr.id,
           pr.branch,
           pr.return_number,
           pr.sale_id,
           pr.patient_id,
           pr.return_date,
           pr.return_type,
           pr.reason,
           pr.total_amount,
           pr.refund_amount,
           pr.status,
           pr.notes,
           pr.processed_by,
           
           ps.sale_number     AS original_sale_number,
           ps.sale_date       AS original_sale_date,
           ps.customer_name,
           ps.customer_phone,
           ps.payment_method  AS original_payment_method,
           ps.grand_total     AS original_grand_total,
           
           a.company_name     AS pharmacy_name,
           a.company_logo     AS pharmacy_logo,
           a.address          AS pharmacy_address,
           a.mobile           AS pharmacy_phone,
           a.email            AS pharmacy_email,
           
           cp.email           AS customer_email,
           cp.age             AS customer_age,
           cp.gender          AS customer_gender,
           
           s.name             AS processed_by_name
           
         FROM pharmacy_returns pr
         LEFT JOIN pharmacy_sales ps          ON ps.id = pr.sale_id
         LEFT JOIN admins a                   ON a.id  = pr.admin_id
         LEFT JOIN pharmacy_customer_pos cp   ON cp.id = ps.customer_id
         LEFT JOIN staff s                    ON s.id  = pr.processed_by
         WHERE pr.id = ? AND pr.admin_id = ?
         LIMIT 1`,
        [id, admin_id]
      );

      if (!returnRows.length) {
        return res.status(404).json({ success: false, message: 'Return not found' });
      }
      const ret = returnRows[0];

      // Branch — 26 Oct 2026: staff see only their own branch's returns. Looked up by id,
      // this used to check admin_id alone. A return elsewhere answers 404, same as none.
      try {
        await recordScope(db, req, ret.branch, { notFound: 'Return not found' });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }

      // ─── 2. Fetch return items with medicine + batch info ───
     const [items] = await db.query(
      `SELECT
        pri.quantity,
        pri.unit_price,
        pri.total_amount,
        pri.policy_snapshot,
        pri.approved_by,
        md.medicine_name,
        pm.hsn_code,
        pmb.batch_number,
        pmb.expiry_date,
        pmb.mrp,
        s.name AS approved_by_name
      FROM pharmacy_return_items pri
      JOIN pharmacy_medicines pm           ON pm.id  = pri.medicine_id
      JOIN medicine_data md                ON md.id  = pm.medicine_data_id
      LEFT JOIN pharmacy_medicine_batches pmb ON pmb.id = pri.batch_id
      LEFT JOIN staff s                    ON s.id = pri.approved_by
      WHERE pri.return_id = ?
      ORDER BY pri.id ASC`,
      [id]
    );

      if (!items.length) {
        return res.status(404).json({ success: false, message: 'No items found for this return' });
      }

      // ─── 3. Fetch logo ───
      const logoBuffer = await getLogoBuffer(ret.pharmacy_logo);

      // ─── 4. Determine paper size (half A4 for few items, full A4 for many) ───
      const ITEMS_THRESHOLD = 3;
      const useFullA4 = items.length > ITEMS_THRESHOLD;
      const paperSize = useFullA4 ? 'A4' : [595, 500];

      // ─── 5. Generate PDF ───
      const doc = new PDFDocument({ size: paperSize, margin: 20 });
      const filename = `Return-Receipt-${ret.return_number}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.pipe(res);

      // ─── 6. Top: Print timestamp ───
      const printDate = new Date().toLocaleString('en-IN', {
        day: 'numeric', month: 'numeric', year: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: true,
      });
      doc.fontSize(7).fillColor('#000').font('Helvetica').text(printDate, 20, 15);

      // ─── 7. Logo + Pharmacy Header ───
      const headerY = 30;
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, 30, headerY, { fit: [50, 50] });
        } catch (e) { console.error('Logo render error:', e.message); }
      }

      doc.fontSize(16).font('Helvetica-Bold').fillColor('#000')
         .text((ret.pharmacy_name || 'PHARMACY').toUpperCase(), 95, headerY + 3,
               { width: 340, align: 'left' });

      doc.fontSize(7).font('Helvetica')
         .text(`GST NO: 36ADIPS7039J2ZK    DL.No: TG/17/01/2015-11610`,
               95, headerY + 25, { width: 340 });

      doc.fontSize(7).font('Helvetica').fillColor('#000')
         .text(ret.pharmacy_address?.substring(0, 30) || '-', 445, headerY)
         .text(`Ph: ${ret.pharmacy_phone || '-'}`, 445, headerY + 12);
      if (ret.pharmacy_email) {
        doc.fontSize(6).text(ret.pharmacy_email, 445, headerY + 24, { width: 130 });
      }

      // Separator line
      doc.moveTo(20, 90).lineTo(575, 90).strokeColor('#000').lineWidth(1).stroke();

      // ─── 8. Title: RETURN RECEIPT / CREDIT NOTE (RED COLOR) ───
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#C62828')
         .text('RETURN RECEIPT / CREDIT NOTE', 20, 95,
               { align: 'center', width: 555 });

      // ─── 9. Return + Customer Info Block ───
      const infoY = 120;
      doc.fontSize(8).font('Helvetica').fillColor('#000');

      // Left column
      doc.text('Return No', 20, infoY);
      doc.text(':', 85, infoY);
      doc.font('Helvetica-Bold').text(ret.return_number || '-', 100, infoY);

      doc.font('Helvetica').text('Customer', 20, infoY + 12);
      doc.text(':', 85, infoY + 12);
      doc.font('Helvetica-Bold').text(ret.customer_name || 'Walk-in', 100, infoY + 12);

      doc.font('Helvetica').text('Mobile', 20, infoY + 24);
      doc.text(':', 85, infoY + 24);
      doc.font('Helvetica-Bold').text(ret.customer_phone || '-', 100, infoY + 24);

      doc.font('Helvetica').text('Reason', 20, infoY + 36);
      doc.text(':', 85, infoY + 36);
      doc.font('Helvetica-Bold').fillColor('#C62828')
         .text((ret.reason || 'N/A').toUpperCase(), 100, infoY + 36);
      doc.fillColor('#000');

      // Right column
      const returnDateStr = new Date(ret.return_date).toLocaleDateString('en-IN', {
        day: '2-digit', month: '2-digit', year: 'numeric',
      });
      doc.font('Helvetica').text('Return Date', 310, infoY);
      doc.text(':', 380, infoY);
      doc.font('Helvetica-Bold').text(returnDateStr, 395, infoY);

      doc.font('Helvetica').text('Original Sale', 310, infoY + 12);
      doc.text(':', 380, infoY + 12);
      doc.font('Helvetica-Bold').text(ret.original_sale_number || '-', 395, infoY + 12);

      const origSaleDate = ret.original_sale_date
        ? new Date(ret.original_sale_date).toLocaleDateString('en-IN', {
            day: '2-digit', month: '2-digit', year: 'numeric',
          })
        : '-';
      doc.font('Helvetica').text('Sale Date', 310, infoY + 24);
      doc.text(':', 380, infoY + 24);
      doc.font('Helvetica-Bold').text(origSaleDate, 395, infoY + 24);

      doc.font('Helvetica').text('Processed By', 310, infoY + 36);
      doc.text(':', 380, infoY + 36);
      doc.font('Helvetica-Bold').text(ret.processed_by_name || '-', 395, infoY + 36);

      // ─── 10. Items Table Header ───
      const tableTop = 175;
      const tableHeaderHeight = 18;
      const cols = {
        particular: { x: 20,  w: 170, label: 'Medicine Returned' },
        batch:      { x: 190, w: 65,  label: 'Batch No' },
        exp:        { x: 255, w: 55,  label: 'Exp Date' },
        rate:       { x: 310, w: 55,  label: 'Rate' },
        qty:        { x: 365, w: 45,  label: 'Qty' },
        hsn:        { x: 410, w: 55,  label: 'HSN' },
        amount:     { x: 465, w: 110, label: 'Refund (Rs)' },
      };

      // Header background (light red tint for return context)
      doc.rect(20, tableTop, 555, tableHeaderHeight).fillColor('#FFEBEE').fill();

      doc.fillColor('#000').fontSize(7).font('Helvetica-Bold');
      Object.values(cols).forEach((col) => {
        doc.text(col.label, col.x + 3, tableTop + 5, { width: col.w - 3 });
      });

      doc.moveTo(20, tableTop).lineTo(575, tableTop)
         .strokeColor('#000').lineWidth(0.5).stroke();
      doc.moveTo(20, tableTop + tableHeaderHeight).lineTo(575, tableTop + tableHeaderHeight).stroke();

      // ─── 11. Items Table Rows ───
      let currentY = tableTop + tableHeaderHeight;
      const rowHeight = 16;
      doc.fillColor('#000').fontSize(7).font('Helvetica');

      items.forEach((item) => {
        const rowTextY = currentY + 5;

        doc.text((item.medicine_name || '-').toUpperCase(),
                 cols.particular.x + 3, rowTextY,
                 { width: cols.particular.w - 3, ellipsis: true });

        doc.text(item.batch_number || '-', cols.batch.x + 3, rowTextY,
                 { width: cols.batch.w - 3 });

        const expDate = item.expiry_date
          ? new Date(item.expiry_date).toLocaleDateString('en-US',
              { month: 'short', year: 'numeric' }).replace(' ', '-')
          : '-';
        doc.text(expDate, cols.exp.x + 3, rowTextY, { width: cols.exp.w - 3 });

        doc.text(Number(item.unit_price).toFixed(2),
                 cols.rate.x + 3, rowTextY, { width: cols.rate.w - 3 });

        doc.text(String(item.quantity),
                 cols.qty.x + 3, rowTextY, { width: cols.qty.w - 3 });

        doc.text(item.hsn_code || '-',
                 cols.hsn.x + 3, rowTextY, { width: cols.hsn.w - 3 });

        doc.text(`₹${Number(item.total_amount).toFixed(2)}`,
                 cols.amount.x + 3, rowTextY, { width: cols.amount.w - 3 });

        currentY += rowHeight;
      });

      // Bottom border of items table
      doc.moveTo(20, currentY).lineTo(575, currentY)
         .strokeColor('#000').lineWidth(0.5).stroke();

      // ─── 12. Totals Section ───
      currentY += 10;
      const totalsX = 380;
      const valueX = 480;
      doc.fontSize(8).font('Helvetica').fillColor('#000');

      const totalRows = [
        { label: 'Total Items Returned:',
          value: items.reduce((s, i) => s + i.quantity, 0).toString() },
        { label: 'Return Subtotal:',
          value: `₹${Number(ret.total_amount).toFixed(2)}` },
        { label: 'Refund Amount:',
          value: `₹${Number(ret.refund_amount).toFixed(2)}`,
          bold: true, color: '#C62828' },
        { label: 'Refund Mode:',
          value: ret.original_payment_method
            ? ret.original_payment_method.charAt(0).toUpperCase() +
              ret.original_payment_method.slice(1)
            : 'Cash' },
        { label: 'Status:',
          value: (ret.status || 'completed').toUpperCase(), bold: true },
      ];

      totalRows.forEach((row) => {
        doc.font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#000')
           .text(row.label, totalsX, currentY);
        doc.fillColor(row.color || '#000')
           .text(row.value, valueX, currentY, { width: 90, align: 'right' });
        currentY += 12;
      });
      doc.fillColor('#000');

      currentY += 10;

      // ─── 13. Amount in Words ───
      const amountInWords = numberToWordsIndian(Math.floor(ret.refund_amount));
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#000')
         .text('Refund Amount in Words:', 20, currentY);
      doc.font('Helvetica').fontSize(8)
         .text(`${amountInWords} RUPEES ONLY`, 20, currentY + 12,
               { width: 400 });
      currentY += 32;

      // ─── 14. Notes (if any) ───
      if (ret.notes) {
        doc.fontSize(7).font('Helvetica-Bold').text('Notes:', 20, currentY);
        doc.font('Helvetica').fontSize(7)
           .text(ret.notes, 60, currentY, { width: 500 });
        currentY += 20;
      }

      // ─── 15. Important Notice ───
      currentY += 5;
      doc.fontSize(6).font('Helvetica-Oblique').fillColor('#C62828')
         .text(
           'This Credit Note is issued against the original tax invoice. ' +
           'GST on returned items has been reversed as per applicable tax law. ' +
           'Returned items in good condition have been restored to inventory.',
           20, currentY, { width: 555, align: 'justify' }
         );
      currentY += 25;

      // ─── Override Notice (if any item was overridden) ───
      const overriddenItems = items.filter((i) => {
        try {
          const s = typeof i.policy_snapshot === 'string'
            ? JSON.parse(i.policy_snapshot)
            : i.policy_snapshot;
          return s?.overridden === true;
        } catch { return false; }
      });

    if (overriddenItems.length > 0) {
      currentY += 5;
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#C62828')
        .text('POLICY OVERRIDE:', 20, currentY);
      overriddenItems.forEach((it) => {
        const s = typeof it.policy_snapshot === 'string'
          ? JSON.parse(it.policy_snapshot)
          : it.policy_snapshot;
        doc.font('Helvetica').fontSize(7).fillColor('#000')
          .text(
            `• ${it.medicine_name} — ${s.override_reason} (Approved by: ${it.approved_by_name || 'N/A'})`,
            30, currentY + 10, { width: 540 }
          );
        currentY += 12;
      });
      currentY += 10;
    }

      // ─── 16. Signature Section ───
      doc.fontSize(8).font('Helvetica').fillColor('#000');

      // Customer signature
      doc.moveTo(50, currentY + 25).lineTo(200, currentY + 25)
         .strokeColor('#000').lineWidth(0.5).stroke();
      doc.text('Customer Signature', 80, currentY + 28);

      // Pharmacy stamp & signature
      doc.moveTo(380, currentY + 25).lineTo(555, currentY + 25).stroke();
      doc.text('Pharmacist Signature & Stamp', 400, currentY + 28);

      // ─── 17. Footer ───
      doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666')
         .text('~ Thank You. Please visit again. ~',
               20, useFullA4 ? 800 : 470,
               { align: 'center', width: 555 });

      // ─── 18. Finalize ───
      doc.end();

    } catch (err) {
      console.error('Return receipt PDF error:', err);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: 'Failed to generate return receipt PDF',
          ...(process.env.NODE_ENV !== 'production' && { error: err.message }),
        });
      }
    }
  }
);


// ─────────────────────────────────────────────────────────────
// GET return eligibility for all items in a sale
// Frontend uses this to disable return buttons/qty inputs
// ─────────────────────────────────────────────────────────────
router.get(
  '/sale/:sale_id/return-eligibility',
  authMiddleware,
  allowPermissions('pharmacy.sales-returns.view'),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const { sale_id } = req.params;

      const [rows] = await db.query(
        `SELECT si.id AS sale_item_id, si.medicine_id, si.batch_id,
                si.quantity AS sold_qty,
                ps.sale_date, ps.branch AS sale_branch,
                pm.return_policy,
                md.medicine_name,
                COALESCE((
                  SELECT SUM(ri.quantity)
                    FROM pharmacy_return_items ri
                    JOIN pharmacy_returns pr ON pr.id = ri.return_id
                   WHERE pr.sale_id = si.sale_id
                     AND ri.medicine_id = si.medicine_id
                     AND ri.batch_id = si.batch_id
                     AND (pr.status IS NULL OR pr.status <> 'cancelled')
                ), 0) AS already_returned
           FROM pharmacy_sale_items si
           JOIN pharmacy_sales ps ON ps.id = si.sale_id
           JOIN pharmacy_medicines pm ON pm.id = si.medicine_id
           JOIN medicine_data md ON md.id = pm.medicine_data_id
          WHERE si.sale_id = ? AND ps.admin_id = ?`,
        [sale_id, admin_id]
      );

      // Branch — 26 Oct 2026: staff may only check (and then return) their own branch's
      // bills. Asking about another branch's sale answers 404, the same as a sale that
      // doesn't exist — the Returns screen opens this before the user can return anything.
      if (rows.length) {
        try {
          await recordScope(db, req, rows[0].sale_branch, { notFound: 'Sale not found' });
        } catch (e) {
          if (sendBranchError(res, e)) return;
          throw e;
        }
      }

      const items = rows.map((r) => {
        const check = checkReturnEligibility({
          policy: r.return_policy,
          sale_date: r.sale_date,
          medicine_name: r.medicine_name,
        });
        return {
          sale_item_id: r.sale_item_id,
          medicine_id: r.medicine_id,
          batch_id: r.batch_id,
          medicine_name: r.medicine_name,
          sold_qty: Number(r.sold_qty),
          already_returned: Number(r.already_returned),
          remaining_qty: Number(r.sold_qty) - Number(r.already_returned),
          eligible: check.ok,
          hard_block: !!check.hard_block,
          can_override: !!check.can_override,
          reason: check.ok ? null : check.reason,
          policy: parsePolicy(r.return_policy),
        };
      });

      res.json({ success: true, data: items });
    } catch (err) {
      console.error('return-eligibility error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);



module.exports = router;