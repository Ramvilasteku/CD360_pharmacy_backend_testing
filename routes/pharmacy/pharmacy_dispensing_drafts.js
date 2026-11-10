// routes/pharmacy_dispensing_drafts.js
// ─────────────────────────────────────────────────────────────
// Drafts for the pharmacy_dispensing module.
// Same shape and semantics as the POS /drafts routes, but for the
// pharmacy_dispensing + pharmacy_dispensing_items tables.
//
// Mount in your main app like POS:
//    app.use('/api/pharmacy/dispensing', require('./routes/pharmacy_dispensing_drafts'));
//
// Stock is counted in TABLETS in the database and shown in STRIPS on screen —
// see utils/pharmacyStripView.js.
//
// Endpoints:
//   GET    /drafts                 — list parked dispensings (status='pending')
//   GET    /drafts/:id             — one draft with items + patient info
//   PATCH  /drafts/:id/complete    — flip to 'dispensed' + deduct stock atomically
//   DELETE /drafts/:id             — soft cancel (status='cancelled')
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware } = require('../../middlewares/authMiddleware');
const { allowPermissions } = require('../../middlewares/allowPermissions');
const { tabletsOf, stripsOf } = require("../../utils/pharmacyStripView");
const { unitsPerPack } = require("../../utils/pharmacyUnits");
const { recordScope, branchKey, sendBranchError } = require("../../utils/pharmacyBranch");

// NOTE (26 Oct 2026) — of the four routes in this file, only PATCH /drafts/:id/complete
// is reachable. server.js mounts routes/Pharmacy/pharmacy_dispensing.js at /api (line
// 229) BEFORE this file at /api/pharmacy/dispensing (line 235), and that file already
// answers GET /drafts, GET /drafts/:id and DELETE /drafts/:id — branch-aware. So the
// GET/GET/DELETE below are dead code, shadowed. They are left in place rather than
// deleted so nothing depending on this file's exports changes; only the live route was
// given branch scoping.

function getTenantAdminId(req) {
  return req.user.role === 'admin' ? req.user.id : req.user.adminId;
}

// Generate DISP-YYYYMMDD-NNNN, same convention as SALE-YYYYMMDD-NNNN
async function generateDispensingNumber(conn, tenantAdminId) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const [lastRow] = await conn.query(
    `SELECT dispensing_number FROM pharmacy_dispensing
      WHERE admin_id = ? AND dispensing_number LIKE ?
      ORDER BY id DESC LIMIT 1`,
    [tenantAdminId, `DISP-${today}-%`]
  );
  const nextNum = lastRow.length
    ? parseInt(lastRow[0].dispensing_number.split('-').pop(), 10) + 1
    : 1;
  return `DISP-${today}-${String(nextNum).padStart(4, '0')}`;
}

// ═════════════════════════════════════════════════════════════
// GET /drafts — list parked dispensings for the tenant
// ═════════════════════════════════════════════════════════════
router.get(
  '/drafts',
  authMiddleware,
  allowPermissions('pharmacy.sales.view'),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const cashierId = req.user.id;
      const { mine_only = 'true' } = req.query;

      const where = ["d.admin_id = ?", "d.status = 'pending'"];
      const params = [tenantAdminId];

      if (mine_only === 'true') {
        where.push('d.dispensed_by = ?');
        params.push(cashierId);
      }

      const [drafts] = await db.query(
        `SELECT d.id,
                d.dispensing_number,
                d.patient_id,
                d.prescription_id,
                d.doctor_name,
                d.notes,
                d.dispensing_date,
                d.created_at,
                d.dispensed_by,
                c.name   AS patient_name,
                c.mobile AS patient_phone,
                TIMESTAMPDIFF(MINUTE, d.created_at, NOW()) AS parked_minutes_ago,
                COUNT(di.id)                                    AS items_count,
                COALESCE(SUM(di.unit_price * di.dispensed_quantity), 0) AS grand_total
           FROM pharmacy_dispensing d
      LEFT JOIN clients c                       ON c.id  = d.patient_id
      LEFT JOIN pharmacy_dispensing_items di    ON di.dispensing_id = d.id
          WHERE ${where.join(' AND ')}
          GROUP BY d.id
          ORDER BY d.created_at DESC`,
        params
      );

      return res.json({ success: true, data: drafts });
    } catch (err) {
      console.error('List dispensing drafts error:', err);
      return res
        .status(500)
        .json({ success: false, message: 'Failed to fetch drafts' });
    }
  }
);

// ═════════════════════════════════════════════════════════════
// GET /drafts/:id — one draft with items (joined with medicines + batches)
// ═════════════════════════════════════════════════════════════
router.get(
  '/drafts/:id',
  authMiddleware,
  allowPermissions('pharmacy.sales.view'),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      const [dispensings] = await db.query(
        `SELECT d.*,
                c.name   AS patient_name,
                c.mobile AS patient_phone,
                c.email  AS patient_email,
                c.gender AS patient_gender,
                c.age    AS patient_age
           FROM pharmacy_dispensing d
      LEFT JOIN clients c ON c.id = d.patient_id
          WHERE d.id = ? AND d.admin_id = ? AND d.status = 'pending'
          LIMIT 1`,
        [req.params.id, tenantAdminId]
      );

      if (!dispensings.length) {
        return res
          .status(404)
          .json({ success: false, message: 'Draft not found' });
      }

      const [items] = await db.query(
        `SELECT di.id,
                di.medicine_id,
                di.batch_id,
                di.prescribed_quantity,
                di.dispensed_quantity,
                di.unit_price,
                di.status AS item_status,
                di.notes  AS item_notes,
                md.medicine_name,
                pm.manufacturer,
                pm.pack_size,
                pm.gst_percentage,
                pm.selling_price,
                pb.batch_number,
                pb.quantity_available,
                pb.units_per_pack AS batch_upp,
                pb.expiry_date
           FROM pharmacy_dispensing_items di
           JOIN pharmacy_medicines pm        ON pm.id = di.medicine_id
           JOIN medicine_data md             ON md.id = pm.medicine_data_id
      LEFT JOIN pharmacy_medicine_batches pb  ON pb.id = di.batch_id
          WHERE di.dispensing_id = ?`,
        [req.params.id]
      );

      return res.json({
        success: true,
        data: {
          dispensing: dispensings[0],
          items: items.map((i) => ({
            medicine_id: i.medicine_id,
            medicine_name: i.medicine_name,
            manufacturer: i.manufacturer,
            pack_size: i.pack_size,
            batch_id: i.batch_id,
            batch_number: i.batch_number,
            // strips, because the screen clamps its quantity stepper against this
            available: stripsOf(i.quantity_available, i.batch_upp),
            expiry_date: i.expiry_date,
            prescribed_quantity: i.prescribed_quantity,
            quantity: i.dispensed_quantity,
            unit_price: Number(i.unit_price),
            gst_percentage: Number(i.gst_percentage),
            // discount lives in item_notes (schema has no column)
            notes: i.item_notes,
            item_status: i.item_status,
            availableBatches: [],
          })),
        },
      });
    } catch (err) {
      console.error('Get dispensing draft error:', err);
      return res
        .status(500)
        .json({ success: false, message: 'Failed to load draft' });
    }
  }
);

// ═════════════════════════════════════════════════════════════
// PATCH /drafts/:id/complete
// Flip 'pending' → 'dispensed'. Deduct stock atomically with
// row locks, assign a fresh DISP number, and mark each item
// as dispensed. 409 if stock has moved since the park.
// ═════════════════════════════════════════════════════════════
router.patch(
  '/drafts/:id/complete',
  authMiddleware,
  allowPermissions('pharmacy.sales.create'),
  async (req, res) => {
    const tenantAdminId = getTenantAdminId(req);
    const { notes } = req.body || {};

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      // 1) Verify the draft exists and lock its header row
      const [dispensings] = await connection.query(
        `SELECT id, branch FROM pharmacy_dispensing
          WHERE id = ? AND admin_id = ? AND status = 'pending'
          FOR UPDATE`,
        [req.params.id, tenantAdminId]
      );
      if (!dispensings.length) {
        await connection.rollback();
        return res
          .status(404)
          .json({ success: false, message: 'Draft not found' });
      }

      // 1b) Branch — 26 Oct 2026. This route takes stock and checked admin_id only, so a
      //     staff member could complete another branch's parked dispensing and take that
      //     branch's stock. Pinned to the DRAFT's stored branch, as finalize in
      //     pharmacy_dispensing.js already is: staff only for their own branch, and every
      //     batch must still be in that branch (checked per item in step 3).
      let draftScope;
      try {
        draftScope = await recordScope(connection, req, dispensings[0].branch, {
          forStock: true,
          notFound: 'Draft not found',
          noBranch: "This parked dispensing has no branch, so there's no telling whose stock it should take. Open it, choose the branch and park it again.",
        });
      } catch (e) {
        await connection.rollback();
        if (sendBranchError(res, e)) return;
        throw e;
      }

      // 2) Load items (snapshot of what was parked)
      const [items] = await connection.query(
        `SELECT id, medicine_id, batch_id, dispensed_quantity, unit_price
           FROM pharmacy_dispensing_items
          WHERE dispensing_id = ?`,
        [req.params.id]
      );

      // 3) For each item: lock the batch, verify stock, deduct, mark item dispensed
      for (const item of items) {
        if (!item.batch_id || !item.dispensed_quantity) continue;

        // Lock the batch so no concurrent sale can race us
        const [[batch]] = await connection.query(
          `SELECT quantity_available, units_per_pack, branch, batch_number
             FROM pharmacy_medicine_batches
            WHERE id = ? AND admin_id = ?
            FOR UPDATE`,
          [item.batch_id, tenantAdminId]
        );
        if (!batch) {
          await connection.rollback();
          return res.status(409).json({
            success: false,
            message: `Batch ${item.batch_id} not found`,
          });
        }
        // The batch must still sit in the draft's branch (it can move between parking and
        // completing — a purchase transfer).
        if (draftScope.key && branchKey(batch.branch) !== draftScope.key) {
          await connection.rollback();
          return res.status(409).json({
            success: false,
            message: `Batch ${batch.batch_number || item.batch_id} is no longer in ${draftScope.branch}. Remove it and add it again.`,
          });
        }
        // dispensed_quantity is in STRIPS; the batch is counted in tablets.
        const uppDisp = unitsPerPack(batch);
        const tabletsNeeded = tabletsOf(item.dispensed_quantity, uppDisp);
        if (Number(batch.quantity_available) < tabletsNeeded) {
          await connection.rollback();
          return res.status(409).json({
            success: false,
            message: `Stock changed since this sale was parked — only ${stripsOf(batch.quantity_available, uppDisp)} available for batch ${item.batch_id}`,
          });
        }

        // Deduct
        const [upd] = await connection.query(
          `UPDATE pharmacy_medicine_batches
              SET quantity_available = quantity_available - ?
            WHERE id = ? AND admin_id = ? AND quantity_available >= ?`,
          [
            tabletsNeeded,
            item.batch_id,
            tenantAdminId,
            tabletsNeeded,
          ]
        );
        if (upd.affectedRows === 0) {
          await connection.rollback();
          return res.status(409).json({
            success: false,
            message:
              'Stock changed since this sale was parked — please review and retry',
          });
        }

        // Mark the item as dispensed
        await connection.query(
          `UPDATE pharmacy_dispensing_items
              SET status = 'dispensed'
            WHERE id = ?`,
          [item.id]
        );
      }

      // 4) Flip the header to 'dispensed' with a fresh DISP number
      const newDispensingNumber = await generateDispensingNumber(
        connection,
        tenantAdminId
      );

      await connection.query(
        `UPDATE pharmacy_dispensing
            SET status            = 'dispensed',
                dispensing_number = ?,
                dispensing_date   = NOW(),
                notes             = COALESCE(?, notes),
                updated_at        = NOW()
          WHERE id = ?`,
        [newDispensingNumber, notes ?? null, req.params.id]
      );

      await connection.commit();
      return res.json({
        success: true,
        message: 'Dispensing completed',
        data: {
          id: Number(req.params.id),
          dispensing_number: newDispensingNumber,
        },
      });
    } catch (err) {
      await connection.rollback();
      console.error('Complete dispensing draft error:', err);
      return res
        .status(500)
        .json({ success: false, message: 'Failed to complete dispensing' });
    } finally {
      connection.release();
    }
  }
);

// ═════════════════════════════════════════════════════════════
// DELETE /drafts/:id — soft cancel
// ═════════════════════════════════════════════════════════════
router.delete(
  '/drafts/:id',
  authMiddleware,
  allowPermissions('pharmacy.sales.create'),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      await db.query(
        `UPDATE pharmacy_dispensing
            SET status     = 'cancelled',
                updated_at = NOW()
          WHERE id = ? AND admin_id = ? AND status = 'pending'`,
        [req.params.id, tenantAdminId]
      );
      return res.json({ success: true, message: 'Draft discarded' });
    } catch (err) {
      console.error('Discard dispensing draft error:', err);
      return res
        .status(500)
        .json({ success: false, message: 'Failed to discard draft' });
    }
  }
);

module.exports = router;