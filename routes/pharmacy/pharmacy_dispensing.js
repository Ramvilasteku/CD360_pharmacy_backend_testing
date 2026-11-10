// routes/pharmacy_dispensing.js
// Mount at /api  →  app.use('/api', require('./routes/pharmacy_dispensing'));
//
// What's new:
//   • Header stores subtotal, item_discount_amount, order_discount_* ,
//     item_gst_amount, extra_gst_*, tax_amount, grand_total,
//     paid_amount, due_amount, payment_status, payment_method
//   • Items store discount_amount, gst_percentage, gst_amount, line_total
//   • Payment entries written to pharmacy_payments on finalize

const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware } = require('../../middlewares/authMiddleware');
const { allowPermissions } = require('../../middlewares/allowPermissions');
// Dispensed quantities are entered in STRIPS; the batch and the stock ledger are
// counted in TABLETS. See utils/pharmacyStripView.js.
const { tabletsOf, stripsOf } = require("../../utils/pharmacyStripView");
const { unitsPerPack } = require("../../utils/pharmacyUnits");
// Branch. "Existing patient" sales land here instead of in pharmacy_sales, and this
// router had no branch awareness at all: the frontend was sending `branch` and the
// backend dropped it, so a dispensing was never attributed to a branch and nothing
// stopped branch A dispensing stock that sits in branch B.
const {
  resolveScope,
  rowFilter,
  batchFilter,
  recordScope,
  sendBranchError,
} = require("../../utils/pharmacyBranch");

function getAdminIdFromUser(user) {
  return user.role === 'admin' ? user.id : user.adminId;
}

// ─────────────────────────────────────────────────────────────
// Numbering helpers
// ─────────────────────────────────────────────────────────────
async function generateDispensingNumber(conn, admin_id) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt FROM pharmacy_dispensing WHERE admin_id = ?`,
    [admin_id]
  );
  const nextNum = (rows[0].cnt || 0) + 1;
  const d = new Date();
  const yyyymm = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `DISP-${yyyymm}-${String(nextNum).padStart(5, '0')}`;
}

async function generatePaymentNumber(conn, admin_id) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const [lastRow] = await conn.query(
    `SELECT payment_number FROM pharmacy_payments
      WHERE admin_id = ? AND payment_number LIKE ?
      ORDER BY id DESC LIMIT 1`,
    [admin_id, `PAY-${today}-%`]
  );
  const nextNum = lastRow.length
    ? parseInt(lastRow[0].payment_number.split('-').pop(), 10) + 1
    : 1;
  return `PAY-${today}-${String(nextNum).padStart(4, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// Compute every money figure server-side. Frontend inputs are hints.
// ─────────────────────────────────────────────────────────────
function computeTotals(items, orderDiscountType, orderDiscountValue, extraGstPercent) {
  let subtotal = 0;
  let itemDiscount = 0;
  let itemGst = 0;

  const normalizedItems = items.map((it) => {
    const qty = Number(it.dispensed_quantity ?? it.quantity ?? 0);
    const price = Number(it.unit_price || 0);
    const disc = Math.max(0, Math.min(Number(it.discount_amount || 0), price * qty));
    const gstPct = Number(it.gst_percentage || 0);
    const lineNet = price * qty - disc;
    const gstAmt = (lineNet * gstPct) / 100;
    const lineTotal = lineNet + gstAmt;

    subtotal += price * qty;
    itemDiscount += disc;
    itemGst += gstAmt;

    return {
      ...it,
      dispensed_quantity: qty,
      unit_price: price,
      discount_amount: Number(disc.toFixed(2)),
      gst_percentage: gstPct,
      gst_amount: Number(gstAmt.toFixed(2)),
      line_total: Number(lineTotal.toFixed(2)),
    };
  });

  const netAfterItemDisc = subtotal - itemDiscount;
  const odType = ['amount', 'percent'].includes(orderDiscountType) ? orderDiscountType : 'amount';
  const odVal = Math.max(0, Number(orderDiscountValue || 0));
  const orderDiscountAmount =
    odType === 'percent'
      ? Math.min(netAfterItemDisc, (netAfterItemDisc * odVal) / 100)
      : Math.min(odVal, netAfterItemDisc);

  const netAfterAllDisc = Math.max(0, netAfterItemDisc - orderDiscountAmount);
  const extraGstPct = Math.max(0, Math.min(100, Number(extraGstPercent || 0)));
  const extraGstAmt = (netAfterAllDisc * extraGstPct) / 100;
  const tax = itemGst + extraGstAmt;
  const grandTotal = Math.round((netAfterAllDisc + tax) * 100) / 100;

  return {
    normalizedItems,
    subtotal: Number(subtotal.toFixed(2)),
    item_discount_amount: Number(itemDiscount.toFixed(2)),
    order_discount_type: odType,
    order_discount_value: Number(odVal.toFixed(2)),
    order_discount_amount: Number(orderDiscountAmount.toFixed(2)),
    item_gst_amount: Number(itemGst.toFixed(2)),
    extra_gst_percent: Number(extraGstPct.toFixed(2)),
    extra_gst_amount: Number(extraGstAmt.toFixed(2)),
    tax_amount: Number(tax.toFixed(2)),
    grand_total: grandTotal,
    net_after_all_disc: Number(netAfterAllDisc.toFixed(2)),
  };
}

function paymentStatusFor(grandTotal, paidAmount) {
  const g = Number(grandTotal || 0);
  const p = Number(paidAmount || 0);
  if (p <= 0) return 'unpaid';
  if (p >= g) return 'paid';
  return 'partial';
}

// ═════════════════════════════════════════════════════════════
// POST /api/pharmacy/dispensing
// Create a dispense (finalized OR parked draft)
// body: {
//   prescription_id, patient_id, doctor_name, notes, status,
//   order_discount_type, order_discount_value, extra_gst_percent,
//   payment_method, paid_amount, transaction_reference, payment_notes,
//   items: [{ medicine_id, batch_id, prescribed_quantity, dispensed_quantity,
//             unit_price, discount_amount, gst_percentage, notes }]
// }
// ═════════════════════════════════════════════════════════════
router.post(
  '/pharmacy/dispensing',
  authMiddleware,
  allowPermissions('pharmacy.sales.create'),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const admin_id = getAdminIdFromUser(req.user);
      const dispensed_by = req.user.id;

      // Which branch this dispensing belongs to. Finalising moves real stock, so a
      // multi-branch admin must name the branch (forWrite); a draft need not.
      const willMoveStock =
        req.body.status === 'dispensed' || req.body.status === 'partially_dispensed';
      let scope;
      try {
        scope = await resolveScope(conn, req, {
          wanted: req.body.branch || req.query.branch,
          forWrite: willMoveStock,
        });
      } catch (e) {
        await conn.rollback();
        if (sendBranchError(res, e)) return;
        throw e;
      }

      const {
        prescription_id,
        patient_id,
        doctor_name,
        notes,
        status = 'dispensed',
        order_discount_type = 'amount',
        order_discount_value = 0,
        extra_gst_percent = 0,
        payment_method = null,
        paid_amount = 0,
        transaction_reference = null,
        payment_notes = null,
        items = [],
      } = req.body;

      if (!Array.isArray(items) || items.length === 0) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: 'No items to dispense' });
      }
      if (!['pending', 'partially_dispensed', 'dispensed', 'cancelled'].includes(status)) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: 'Invalid dispensing status' });
      }

      // Compute all money figures server-side
      const totals = computeTotals(items, order_discount_type, order_discount_value, extra_gst_percent);
      const payStatus = status === 'pending'
        ? 'unpaid'
        : paymentStatusFor(totals.grand_total, paid_amount);
      const dueAmount = Math.max(0, totals.grand_total - Number(paid_amount || 0));

      // Lock & verify stock on finalize
      if (status === 'dispensed' || status === 'partially_dispensed') {
        for (const it of totals.normalizedItems) {
          if (!it.batch_id || it.dispensed_quantity <= 0) continue;
          // Strict branch test here, unlike the report filters: you must not be able to
          // dispense stock that is physically in another branch. bf is empty when the
          // pharmacy has fewer than two branches, so single-branch setups are unaffected.
          const bf = batchFilter(scope, "b");
          const [[batch]] = await conn.query(
            `SELECT b.id, b.quantity_available, b.units_per_pack
               FROM pharmacy_medicine_batches b
              WHERE b.id = ? AND b.admin_id = ?${bf.sql}
              FOR UPDATE`,
            [it.batch_id, admin_id, ...bf.params]
          );
          if (!batch) {
            await conn.rollback();
            return res.status(400).json({
              success: false,
              message: scope.filter
                ? `Batch ${it.batch_id} is not in ${scope.branch}. Pick stock from this branch.`
                : `Batch ${it.batch_id} not found`,
            });
          }
          const uppPre = unitsPerPack(batch);
          if (Number(batch.quantity_available) < tabletsOf(it.dispensed_quantity, uppPre)) {
            await conn.rollback();
            return res.status(400).json({
              success: false,
              message: `Only ${stripsOf(batch.quantity_available, uppPre)} available for batch ${it.batch_id}`,
            });
          }
        }
      }

      const dispensing_number = await generateDispensingNumber(conn, admin_id);

      // ── INSERT header with the full breakdown ──
      const [headerResult] = await conn.query(
        `INSERT INTO pharmacy_dispensing
           (admin_id, branch, prescription_id, patient_id, doctor_name,
            dispensing_number, dispensing_date, dispensed_by, status, notes,
            subtotal, item_discount_amount,
            order_discount_type, order_discount_value, order_discount_amount,
            item_gst_amount, extra_gst_percent, extra_gst_amount,
            tax_amount, grand_total,
            paid_amount, due_amount, payment_status, payment_method)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?,
                 ?, ?, ?, ?, ?,
                 ?, ?, ?,
                 ?, ?,
                 ?, ?, ?, ?)`,
        [
          admin_id,
          scope.branch || null,
          prescription_id || 0,
          patient_id || null,
          doctor_name || null,
          dispensing_number,
          dispensed_by,
          status,
          notes || null,
          totals.subtotal,
          totals.item_discount_amount,
          totals.order_discount_type,
          totals.order_discount_value,
          totals.order_discount_amount,
          totals.item_gst_amount,
          totals.extra_gst_percent,
          totals.extra_gst_amount,
          totals.tax_amount,
          totals.grand_total,
          Number(paid_amount || 0),
          dueAmount,
          payStatus,
          payment_method,
        ]
      );
      const dispensing_id = headerResult.insertId;

      // ── INSERT items with discount, gst_amount, line_total ──
      for (const it of totals.normalizedItems) {
        const itemStatus =
          status === 'pending'
            ? 'pending'
            : it.dispensed_quantity > 0
            ? 'dispensed'
            : 'cancelled';

        await conn.query(
          `INSERT INTO pharmacy_dispensing_items
             (dispensing_id, medicine_id, batch_id,
              prescribed_quantity, dispensed_quantity,
              unit_price, discount_amount,
              gst_percentage, gst_amount, line_total,
              status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            dispensing_id,
            it.medicine_id,
            it.batch_id || null,
            Number(it.prescribed_quantity || 0),
            it.dispensed_quantity,
            it.unit_price,
            it.discount_amount,
            it.gst_percentage,
            it.gst_amount,
            it.line_total,
            itemStatus,
            it.notes || null,
          ]
        );

        if (
          (status === 'dispensed' || status === 'partially_dispensed') &&
          it.batch_id &&
          it.dispensed_quantity > 0
        ) {
          const [[bUpp]] = await conn.query(
            `SELECT units_per_pack FROM pharmacy_medicine_batches
              WHERE id = ? AND admin_id = ?`,
            [it.batch_id, admin_id]
          );
          await conn.query(
            `UPDATE pharmacy_medicine_batches
                SET quantity_available = GREATEST(0, quantity_available - ?)
              WHERE id = ? AND admin_id = ?`,
            [tabletsOf(it.dispensed_quantity, unitsPerPack(bUpp || {})), it.batch_id, admin_id]
          );
        }
      }

      // ── Record payment on finalize ──
      if (status !== 'pending' && Number(paid_amount || 0) > 0) {
        const payment_number = await generatePaymentNumber(conn, admin_id);
        // Payment reflects the whole bill breakdown (so receipts stay reproducible)
        await conn.query(
          `INSERT INTO pharmacy_payments
             (admin_id, dispensing_id, payment_number, payment_date,
              amount, subtotal, discount_type, discount_value, discount_amount,
              gst_percentage, gst_amount,
              payment_method, transaction_reference, notes, received_by)
           VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            admin_id,
            dispensing_id,
            payment_number,
            Number(paid_amount),
            totals.subtotal,
            totals.order_discount_type,
            totals.order_discount_value,
            totals.item_discount_amount + totals.order_discount_amount,
            totals.extra_gst_percent,
            totals.tax_amount,
            payment_method || 'cash',
            transaction_reference,
            payment_notes,
            dispensed_by,
          ]
        );
      }

      await conn.commit();
      res.json({
        success: true,
        message: status === 'pending' ? 'Dispensing parked' : 'Dispensing completed',
        data: {
          id: dispensing_id,
          dispensing_number,
          status,
          subtotal: totals.subtotal,
          grand_total: totals.grand_total,
          paid_amount: Number(paid_amount || 0),
          due_amount: dueAmount,
          payment_status: payStatus,
        },
      });
    } catch (err) {
      await conn.rollback();
      console.error('POST /pharmacy/dispensing error:', err);
      res.status(500).json({ success: false, message: err.message });
    } finally {
      conn.release();
    }
  }
);

// ═════════════════════════════════════════════════════════════
// GET /api/pharmacy/dispensing   (list all for tenant)
// ═════════════════════════════════════════════════════════════
router.get(
  '/pharmacy/dispensing',
  authMiddleware,
  allowPermissions('pharmacy.sales.view'),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      // Branch scoping for a read: a staff member sees their own branch, an admin sees
      // every branch unless the Branch dropdown names one. Tolerant filter, so a
      // dispensing recorded before branches existed is not hidden from the books.
      let scope;
      try {
        scope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }
      const bf = rowFilter(scope, "d");
      const [rows] = await db.query(
        `SELECT d.*,
                c.name AS patient_name,
                c.mobile AS patient_mobile,
                (SELECT COUNT(*) FROM pharmacy_dispensing_items
                   WHERE dispensing_id = d.id) AS items_count
           FROM pharmacy_dispensing d
      LEFT JOIN clients c ON c.id = d.patient_id
          WHERE d.admin_id = ?${bf.sql}
          ORDER BY d.dispensing_date DESC`,
        [admin_id, ...bf.params]
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      console.error('GET /pharmacy/dispensing error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ═════════════════════════════════════════════════════════════
// GET /api/pharmacy/dispensing/drafts   (only pending)
// ═════════════════════════════════════════════════════════════
router.get(
  '/pharmacy/dispensing/drafts',
  authMiddleware,
  allowPermissions('pharmacy.sales.view'),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      // Branch scoping for a read: a staff member sees their own branch, an admin sees
      // every branch unless the Branch dropdown names one. Tolerant filter, so a
      // dispensing recorded before branches existed is not hidden from the books.
      let scope;
      try {
        scope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }
      const bf = rowFilter(scope, "d");
      const [rows] = await db.query(
        `SELECT d.id,
                d.dispensing_number,
                d.patient_id,
                d.prescription_id,
                d.doctor_name,
                d.notes,
                d.subtotal, d.item_discount_amount,
                d.order_discount_type, d.order_discount_value, d.order_discount_amount,
                d.item_gst_amount, d.extra_gst_percent, d.extra_gst_amount,
                d.tax_amount, d.grand_total,
                d.paid_amount, d.due_amount, d.payment_status,
                d.dispensing_date, d.created_at,
                p.name   AS patient_name,
                p.mobile AS patient_mobile,
                (SELECT COUNT(*) FROM pharmacy_dispensing_items
                   WHERE dispensing_id = d.id) AS items_count,
                TIMESTAMPDIFF(MINUTE, d.created_at, NOW()) AS parked_minutes_ago
           FROM pharmacy_dispensing d
      LEFT JOIN clients p ON p.id = d.patient_id
          WHERE d.admin_id = ?${bf.sql}
            AND d.status = 'pending'
          ORDER BY d.created_at DESC`,
        [admin_id, ...bf.params]
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      console.error('GET /pharmacy/dispensing/drafts error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ═════════════════════════════════════════════════════════════
// GET /api/pharmacy/dispensing/drafts/:id   (one draft + items)
// ═════════════════════════════════════════════════════════════
router.get(
  '/pharmacy/dispensing/drafts/:id',
  authMiddleware,
  allowPermissions('pharmacy.sales.view'),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const [headerRows] = await db.query(
        `SELECT d.*, p.name AS patient_name, p.mobile AS patient_mobile,
                p.email AS patient_email, p.gender AS patient_gender,
                p.age AS patient_age
           FROM pharmacy_dispensing d
      LEFT JOIN clients p ON p.id = d.patient_id
          WHERE d.id = ? AND d.admin_id = ? AND d.status = 'pending'
          LIMIT 1`,
        [req.params.id, admin_id]
      );
      const header = headerRows[0];
      if (!header) {
        return res.status(404).json({ success: false, message: 'Draft not found' });
      }

      // Branch — 26 Oct 2026: the drafts LIST was branch-scoped but opening one by id was
      // not. Staff get 404 for another branch's draft, the same as for none.
      try {
        await recordScope(db, req, header.branch, { notFound: 'Draft not found' });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }

      const [items] = await db.query(
        `SELECT di.id, di.medicine_id, di.batch_id,
                di.prescribed_quantity, di.dispensed_quantity,
                di.unit_price, di.discount_amount,
                di.gst_percentage, di.gst_amount, di.line_total,
                di.status AS item_status, di.notes AS item_notes,
                pm.medicine_name,
                pmb.batch_number,
                FLOOR(pmb.quantity_available / GREATEST(COALESCE(pmb.units_per_pack, 1), 1)) AS available,
                pmb.selling_price,
                pmb.expiry_date
           FROM pharmacy_dispensing_items di
      LEFT JOIN pharmacy_medicines pm ON pm.id = di.medicine_id
      LEFT JOIN pharmacy_medicine_batches pmb ON pmb.id = di.batch_id
          WHERE di.dispensing_id = ?`,
        [header.id]
      );

      res.json({ success: true, data: { dispensing: header, items } });
    } catch (err) {
      console.error('GET draft error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ═════════════════════════════════════════════════════════════
// DELETE /api/pharmacy/dispensing/drafts/:id   (hard-delete a draft)
// ═════════════════════════════════════════════════════════════
router.delete(
  '/pharmacy/dispensing/drafts/:id',
  authMiddleware,
  allowPermissions('pharmacy.sales.delete'),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const admin_id = getAdminIdFromUser(req.user);

      const [[found]] = await conn.query(
        `SELECT id, branch FROM pharmacy_dispensing
          WHERE id = ? AND admin_id = ? AND status = 'pending'`,
        [req.params.id, admin_id]
      );
      if (!found) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: 'Draft not found' });
      }

      // Branch — 26 Oct 2026: staff may only discard their own branch's drafts.
      try {
        await recordScope(conn, req, found.branch, { notFound: 'Draft not found' });
      } catch (e) {
        await conn.rollback();
        if (sendBranchError(res, e)) return;
        throw e;
      }

      await conn.query(
        `DELETE FROM pharmacy_dispensing_items WHERE dispensing_id = ?`,
        [req.params.id]
      );
      await conn.query(
        `DELETE FROM pharmacy_dispensing WHERE id = ? AND admin_id = ?`,
        [req.params.id, admin_id]
      );

      await conn.commit();
      res.json({ success: true, message: 'Draft discarded' });
    } catch (err) {
      await conn.rollback();
      console.error('DELETE draft error:', err);
      res.status(500).json({ success: false, message: err.message });
    } finally {
      conn.release();
    }
  }
);

// ═════════════════════════════════════════════════════════════
// PUT /api/pharmacy/dispensing/:id/finalize
// Move a pending draft → 'dispensed', decrement stock, record payment.
// body: { payment_method, paid_amount, transaction_reference?, payment_notes? }
// ═════════════════════════════════════════════════════════════
router.put(
  '/pharmacy/dispensing/:id/finalize',
  authMiddleware,
  allowPermissions('pharmacy.sales.create'),
  async (req, res) => {
    const {
      payment_method = 'cash',
      paid_amount = 0,
      transaction_reference = null,
      payment_notes = null,
    } = req.body || {};

    if (!['cash', 'card', 'upi', 'bank_transfer', 'other'].includes(payment_method)) {
      return res.status(400).json({ success: false, message: 'Invalid payment_method' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const admin_id = getAdminIdFromUser(req.user);
      const received_by = req.user.id;

      // Lock header
      const [[header]] = await conn.query(
        `SELECT * FROM pharmacy_dispensing
          WHERE id = ? AND admin_id = ? AND status = 'pending'
          FOR UPDATE`,
        [req.params.id, admin_id]
      );
      if (!header) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: 'Draft not found' });
      }

      // Lock + decrement each item's batch
      const [items] = await conn.query(
        `SELECT * FROM pharmacy_dispensing_items WHERE dispensing_id = ?`,
        [req.params.id]
      );

      // The branch comes from the DRAFT, not from the request: the draft was raised in a
      // branch and that is where its stock has to come from.
      //
      // 26 Oct 2026: through recordScope, which adds the two things this lacked —
      //   • a staff member may only finalize a draft raised in THEIR branch (it checked
      //     admin_id only, so any staff could finalize any branch's draft);
      //   • a draft with NO branch in a multi-branch pharmacy is refused, instead of being
      //     "left unfiltered rather than guessed at" — unfiltered meant it could take any
      //     branch's stock, which is the opposite of not guessing. The backfill stamps
      //     these from dispensed_by; one it could not attribute must be re-parked.
      let finScope;
      try {
        finScope = await recordScope(conn, req, header.branch, {
          forStock: true,
          notFound: 'Draft not found',
          noBranch: "This draft has no branch, so there's no telling whose stock it should take. Open it, choose the branch and park it again.",
        });
      } catch (e) {
        await conn.rollback();
        if (sendBranchError(res, e)) return;
        throw e;
      }
      // Same strict test as before, now on the scope's canonical key. Empty in a
      // single-branch pharmacy, exactly as before.
      const bSql = finScope.key ? " AND branch IS NOT NULL AND LOWER(TRIM(branch)) = ?" : "";
      const bPrm = finScope.key ? [finScope.key] : [];

      for (const it of items) {
        if (!it.batch_id || it.dispensed_quantity <= 0) continue;
        const [[batch]] = await conn.query(
          `SELECT quantity_available, units_per_pack FROM pharmacy_medicine_batches
            WHERE id = ? AND admin_id = ?${bSql} FOR UPDATE`,
          [it.batch_id, admin_id, ...bPrm]
        );
        const uppFin = unitsPerPack(batch || {});
        const tabletsFin = tabletsOf(it.dispensed_quantity, uppFin);
        if (!batch || Number(batch.quantity_available) < tabletsFin) {
          await conn.rollback();
          return res.status(409).json({
            success: false,
            message: `Insufficient stock for batch ${it.batch_id}`,
          });
        }
        await conn.query(
          `UPDATE pharmacy_medicine_batches
              SET quantity_available = quantity_available - ?
            WHERE id = ? AND admin_id = ?`,
          [tabletsFin, it.batch_id, admin_id]
        );
        // Dispensing never wrote the stock ledger; without this the ledger balance and
        // the batch quantity drift apart every time a prescription is dispensed.
        await conn.query(
          `INSERT INTO pharmacy_stock_transactions
             (admin_id, medicine_id, batch_id, transaction_type,
              reference_id, reference_number, quantity_in, quantity_out,
              balance_quantity, transaction_date, notes, created_by)
           VALUES (?, ?, ?, 'dispense', ?, ?, 0, ?, ?, NOW(), ?, ?)`,
          [
            admin_id,
            it.medicine_id,
            it.batch_id,
            Number(req.params.id),
            header.dispensing_number,
            tabletsFin,
            Number(batch.quantity_available) - tabletsFin,
            `Dispensed ${it.dispensed_quantity} strip(s) on ${header.dispensing_number}`,
            req.user.id,
          ]
        );
        await conn.query(
          `UPDATE pharmacy_dispensing_items SET status = 'dispensed' WHERE id = ?`,
          [it.id]
        );
      }

      // Update header with payment summary
      const grandTotal = Number(header.grand_total || 0);
      const paidNum = Number(paid_amount || 0);
      const dueNum = Math.max(0, grandTotal - paidNum);
      const payStatus = paymentStatusFor(grandTotal, paidNum);

      await conn.query(
        `UPDATE pharmacy_dispensing
            SET status         = 'dispensed',
                paid_amount    = ?,
                due_amount     = ?,
                payment_status = ?,
                payment_method = ?,
                updated_at     = NOW()
          WHERE id = ? AND admin_id = ?`,
        [paidNum, dueNum, payStatus, payment_method, req.params.id, admin_id]
      );

      // Record payment (if any)
      if (paidNum > 0) {
        const payment_number = await generatePaymentNumber(conn, admin_id);
        await conn.query(
          `INSERT INTO pharmacy_payments
             (admin_id, dispensing_id, payment_number, payment_date,
              amount, subtotal, discount_type, discount_value, discount_amount,
              gst_percentage, gst_amount,
              payment_method, transaction_reference, notes, received_by)
           VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            admin_id,
            req.params.id,
            payment_number,
            paidNum,
            Number(header.subtotal || 0),
            header.order_discount_type || 'amount',
            Number(header.order_discount_value || 0),
            Number(header.item_discount_amount || 0) + Number(header.order_discount_amount || 0),
            Number(header.extra_gst_percent || 0),
            Number(header.tax_amount || 0),
            payment_method,
            transaction_reference,
            payment_notes,
            received_by,
          ]
        );
      }

      await conn.commit();
      res.json({
        success: true,
        message: 'Dispensing finalized',
        data: {
          id: Number(req.params.id),
          dispensing_number: header.dispensing_number,
          grand_total: grandTotal,
          paid_amount: paidNum,
          due_amount: dueNum,
          payment_status: payStatus,
        },
      });
    } catch (err) {
      await conn.rollback();
      console.error('PUT finalize error:', err);
      res.status(500).json({ success: false, message: err.message });
    } finally {
      conn.release();
    }
  }
);

// ═════════════════════════════════════════════════════════════
// POST /api/pharmacy/dispensing/:id/payments
// Record an additional payment against an existing dispense
// (useful when a partial payment is topped up later).
// body: { amount, payment_method, transaction_reference?, notes? }
// ═════════════════════════════════════════════════════════════
router.post(
  '/pharmacy/dispensing/:id/payments',
  authMiddleware,
  allowPermissions('pharmacy.sales.create'),
  async (req, res) => {
    const { amount, payment_method, transaction_reference = null, notes = null } = req.body || {};

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount required' });
    }
    if (!['cash', 'card', 'upi', 'bank_transfer', 'other'].includes(payment_method)) {
      return res.status(400).json({ success: false, message: 'Invalid payment_method' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const admin_id = getAdminIdFromUser(req.user);
      const received_by = req.user.id;

      const [[header]] = await conn.query(
        `SELECT grand_total, paid_amount, subtotal,
                order_discount_type, order_discount_value,
                item_discount_amount, order_discount_amount,
                extra_gst_percent, tax_amount
           FROM pharmacy_dispensing
          WHERE id = ? AND admin_id = ? FOR UPDATE`,
        [req.params.id, admin_id]
      );
      if (!header) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: 'Dispense not found' });
      }

      const payment_number = await generatePaymentNumber(conn, admin_id);
      await conn.query(
        `INSERT INTO pharmacy_payments
           (admin_id, dispensing_id, payment_number, payment_date,
            amount, subtotal, discount_type, discount_value, discount_amount,
            gst_percentage, gst_amount,
            payment_method, transaction_reference, notes, received_by)
         VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          admin_id,
          req.params.id,
          payment_number,
          Number(amount),
          Number(header.subtotal || 0),
          header.order_discount_type || 'amount',
          Number(header.order_discount_value || 0),
          Number(header.item_discount_amount || 0) + Number(header.order_discount_amount || 0),
          Number(header.extra_gst_percent || 0),
          Number(header.tax_amount || 0),
          payment_method,
          transaction_reference,
          notes,
          received_by,
        ]
      );

      const newPaid = Number(header.paid_amount) + Number(amount);
      const newDue  = Math.max(0, Number(header.grand_total) - newPaid);
      const newStatus = paymentStatusFor(header.grand_total, newPaid);

      await conn.query(
        `UPDATE pharmacy_dispensing
            SET paid_amount    = ?,
                due_amount     = ?,
                payment_status = ?,
                payment_method = COALESCE(payment_method, ?),
                updated_at     = NOW()
          WHERE id = ? AND admin_id = ?`,
        [newPaid, newDue, newStatus, payment_method, req.params.id, admin_id]
      );

      await conn.commit();
      res.json({
        success: true,
        message: 'Payment recorded',
        data: {
          payment_number,
          paid_amount: newPaid,
          due_amount: newDue,
          payment_status: newStatus,
        },
      });
    } catch (err) {
      await conn.rollback();
      console.error('POST additional payment error:', err);
      res.status(500).json({ success: false, message: err.message });
    } finally {
      conn.release();
    }
  }
);

module.exports = router;