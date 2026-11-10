// routes/pharmacy_payments.js
// Mount at /api  →  app.use('/api', require('./routes/pharmacy_payments'));

const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware } = require('../../middlewares/authMiddleware');
const { allowPermissions } = require('../../middlewares/allowPermissions');
const { resolveScope, recordScope, historyBranchSql, sendBranchError } = require('../../utils/pharmacyBranch');

// ─────────────────────────────────────────────────────────────
// BRANCH — 26 Oct 2026.
//
// This router had no branch awareness at all: every staff member saw every branch's
// payments, and could open, edit or delete any of them by id. A payment has no branch
// column of its own and deliberately does not get one — it belongs to the branch of the
// SALE it is attached to, read through the parent. So a payment can never disagree with
// its sale's branch, and no backfill is needed for it. (pharmacySalesReports.js
// daily-collection already scopes payments this way.)
//
// CUSTOMER payments only. SUPPLIER payments (purchase_id) are Procurement's and are left
// exactly as they were: purchase orders created before the branch feature carry no
// branch, and scoping them here would start refusing procurement staff on payments that
// work today. Procurement scopes its own screens through the PO.
// ─────────────────────────────────────────────────────────────

/** For a list query: supplier payments pass untouched; customer payments only when the
 *  sale is in this branch. One `?`. */
function parentBranchSql() {
  return ` AND (
      pharmacy_payments.purchase_id IS NOT NULL
   OR EXISTS (
         SELECT 1 FROM pharmacy_sales bs
          WHERE bs.id = pharmacy_payments.sale_id${historyBranchSql('bs')})
  )`;
}

/** The branch of the sale or purchase order a payment belongs to (null if neither / none). */
async function parentBranchOf(q, payment, admin_id) {
  const isPurchase = payment.purchase_id != null;
  const id = isPurchase ? payment.purchase_id : payment.sale_id;
  if (id == null) return null;
  const table = isPurchase ? 'pharmacy_purchase_orders' : 'pharmacy_sales';
  const [[row]] = await q.query(
    `SELECT branch FROM ${table} WHERE id = ? AND admin_id = ? LIMIT 1`,
    [id, admin_id]
  );
  return row ? row.branch : null;
}

const PAYMENT_METHODS = ['cash', 'card', 'upi', 'bank_transfer', 'other'];

function getAdminIdFromUser(user) {
  return user.role === 'admin' ? user.id : user.adminId;
}

// ─────────────────────────────────────────────────────────────
// GET all payments, optional ?kind=customer|supplier|refund
//   customer  → sale_id NOT NULL
//   supplier  → purchase_id NOT NULL
//   refund    → amount < 0
// ─────────────────────────────────────────────────────────────
router.get(
  '/getall/payments',
  authMiddleware,
  allowPermissions('pharmacy.payments.view'),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);

      // Staff: their own branch, always. Admin: ?branch=X, or every branch when absent.
      let scope;
      try {
        scope = await resolveScope(db, req, { wanted: req.query.branch });
      } catch (e) {
        if (sendBranchError(res, e)) return;
        throw e;
      }

      const params = [admin_id];
      let sql = `
        SELECT *
          FROM pharmacy_payments
         WHERE admin_id = ?
      `;
      if (scope.filter) {
        sql += parentBranchSql();
        params.push(scope.key);
      }
      if (req.query.kind === 'customer') sql += ` AND sale_id IS NOT NULL`;
      if (req.query.kind === 'supplier') sql += ` AND purchase_id IS NOT NULL`;
      if (req.query.kind === 'refund') sql += ` AND amount < 0`;
      sql += ` ORDER BY payment_date DESC`;

      const [rows] = await db.query(sql, params);
      res.json({ success: true, data: rows });
    } catch (err) {
      console.error('getall/payments error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// GET one payment
// ─────────────────────────────────────────────────────────────
router.get(
  '/get/payment/:id',
  authMiddleware,
  allowPermissions('pharmacy.payments.view'),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);

      const [rows] = await db.query(
        `SELECT * FROM pharmacy_payments
          WHERE id = ? AND admin_id = ?
          LIMIT 1`,
        [req.params.id, admin_id]
      );
      const row = rows[0];
      if (!row) {
        return res.status(404).json({ success: false, message: 'Payment not found' });
      }

      // Staff get 404 for another branch's customer payment, the same as for none.
      // (Supplier payments: unchanged — see the note at the top.)
      if (row.purchase_id == null) {
        try {
          await recordScope(db, req, await parentBranchOf(db, row, admin_id), { notFound: 'Payment not found' });
        } catch (e) {
          if (sendBranchError(res, e)) return;
          throw e;
        }
      }

      res.json({ success: true, data: row });
    } catch (err) {
      console.error('get/payment error:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// POST create payment
// Exactly one of sale_id / purchase_id must be provided.
// Negative `amount` = refund.
// Server auto-generates payment_number; payment_date defaults to NOW.
// ─────────────────────────────────────────────────────────────
// Permissions: the route lets in anyone who may take a payment of EITHER kind;
// the handler then checks the kind actually being posted, so a sales-only
// cashier cannot pay a supplier and a purchasing user cannot take sale money.
//   customer payment (sale_id)     → pharmacy.sales.create   or pharmacy.payments.create
//   supplier payment (purchase_id) → pharmacy.purchase.edit  or pharmacy.payments.create
// Tenant admins pass both (allowPermissions already lets them through).
const SALE_PAY_PERMS = ['pharmacy.sales.create', 'pharmacy.payments.create'];
const PURCHASE_PAY_PERMS = ['pharmacy.payments.create', 'pharmacy.purchase.edit'];

router.post(
  '/post/payment',
  authMiddleware,
  allowPermissions(...new Set([...SALE_PAY_PERMS, ...PURCHASE_PAY_PERMS])),
  async (req, res) => {
    const admin_id = getAdminIdFromUser(req.user);
    const received_by = req.user.id;

    const {
      sale_id,
      purchase_id,
      amount,
      payment_method,
      transaction_reference,
      notes,
    } = req.body;

    // ─── Manual validation (no Joi needed) ───
    const amountNum = Number(amount);

    if (!amountNum || amountNum === 0) {
      return res.status(400).json({
        success: false,
        message: 'amount is required and cannot be zero',
      });
    }

    if (!payment_method) {
      return res.status(400).json({
        success: false,
        message: 'payment_method is required',
      });
    }

    if (!PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({
        success: false,
        message: `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}`,
      });
    }

    // Exactly one of sale_id or purchase_id must be present
    const hasSale = sale_id != null && sale_id !== '';
    const hasPurchase = purchase_id != null && purchase_id !== '';
    if (hasSale === hasPurchase) {
      return res.status(400).json({
        success: false,
        message: 'Provide exactly one of sale_id or purchase_id',
      });
    }

    // Guard: reasonable size cap
    if (Math.abs(amountNum) > 10_000_000) {
      return res.status(400).json({ success: false, message: 'amount too large' });
    }

    // Kind-specific permission (staff only — a tenant admin is never restricted here)
    const isTenantAdmin = req.user.role && String(req.user.role).toLowerCase() === 'admin';
    if (!isTenantAdmin) {
      const held = req.user.permissions || [];
      const needed = hasPurchase ? PURCHASE_PAY_PERMS : SALE_PAY_PERMS;
      if (!needed.some((k) => held.includes(k))) {
        return res.status(403).json({
          success: false,
          message: hasPurchase
            ? 'Access denied — you cannot record supplier payments'
            : 'Access denied — you cannot record customer payments',
          required: needed,
        });
      }
    }

    // ─── Generate payment_number: PAY-YYYYMMDD-00001 (per tenant per day) ───
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      // Lock sale/purchase row during this transaction to prevent races
      let parentRow = null;
      if (hasSale) {
        const [[sale]] = await connection.query(
          `SELECT id, admin_id, grand_total, paid_amount, status, branch
             FROM pharmacy_sales
            WHERE id = ? AND admin_id = ?
            FOR UPDATE`,
          [sale_id, admin_id]
        );
        if (!sale) {
          await connection.rollback();
          return res.status(404).json({ success: false, message: 'Sale not found' });
        }
        // Branch: staff may only take money against their own branch's bills.
        try {
          await recordScope(connection, req, sale.branch, { notFound: 'Sale not found' });
        } catch (e) {
          await connection.rollback();
          if (sendBranchError(res, e)) return;
          throw e;
        }
        if (sale.status === 'cancelled') {
          await connection.rollback();
          return res.status(400).json({ success: false, message: 'Cannot collect on a cancelled sale' });
        }
        // Overpayment guard (positive amounts only; negative = refund)
        if (amountNum > 0) {
          const due = Math.max(0, Number(sale.grand_total) - Number(sale.paid_amount));
          if (amountNum > due + 0.001) {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: `Amount exceeds due (₹${due.toFixed(2)})`,
            });
          }
        }
        parentRow = sale;
      }

      // Supplier payment: lock the purchase order so two people paying at once
      // cannot both squeeze past the "amount exceeds due" check.
      if (hasPurchase) {
        const [[po]] = await connection.query(
          `SELECT id, admin_id, grand_total, paid_amount, status
             FROM pharmacy_purchase_orders
            WHERE id = ? AND admin_id = ?
            FOR UPDATE`,
          [purchase_id, admin_id]
        );
        if (!po) {
          await connection.rollback();
          return res.status(404).json({ success: false, message: 'Purchase order not found' });
        }

        if (po.status === 'cancelled') {
          await connection.rollback();
          return res.status(400).json({ success: false, message: 'Cannot pay a cancelled purchase order' });
        }
        if (po.status === 'draft') {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: 'This purchase order has not been placed yet — pay it once it is ordered or received',
          });
        }
        if (amountNum > 0) {
          // Overpayment guard
          const due = Math.max(0, Number(po.grand_total) - Number(po.paid_amount));
          if (amountNum > due + 0.001) {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: `Amount exceeds due (₹${due.toFixed(2)})`,
            });
          }
        } else if (Number(po.paid_amount) + amountNum < -0.001) {
          // A reversal cannot take more back than was ever paid
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Refund exceeds what was paid (₹${Number(po.paid_amount).toFixed(2)})`,
          });
        }
        parentRow = po;
      }

      // Count today's payments for this tenant → generate payment_number
      const [[countRow]] = await connection.query(
        `SELECT COUNT(*) + 1 AS seq
           FROM pharmacy_payments
          WHERE admin_id = ?
            AND DATE(payment_date) = CURDATE()`,
        [admin_id]
      );
      const payment_number = `PAY-${ymd}-${String(countRow.seq).padStart(5, '0')}`;

      // ─── Insert payment (payment_date uses DB default) ───
      const [insertResult] = await connection.query(
        `INSERT INTO pharmacy_payments
           (admin_id, sale_id, purchase_id, payment_number, amount,
            payment_method, transaction_reference, notes, received_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          admin_id,
          hasSale ? sale_id : null,
          hasPurchase ? purchase_id : null,
          payment_number,
          amountNum,
          payment_method,
          transaction_reference || null,
          notes || null,
          received_by,
        ]
      );

      // ─── Update the sale's paid_amount + status (if it's a sale payment) ───
      let newPaid, newDue, newStatus;
      if (hasSale && parentRow) {
        newPaid = Math.round((Number(parentRow.paid_amount) + amountNum) * 100) / 100;
        newDue = Math.max(0, Math.round((Number(parentRow.grand_total) - newPaid) * 100) / 100);
        newStatus = newDue <= 0.001 ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';

        await connection.query(
          `UPDATE pharmacy_sales
              SET paid_amount    = ?,
                  due_amount     = ?,
                  payment_status = ?
            WHERE id = ? AND admin_id = ?`,
          [newPaid, newDue, newStatus, sale_id, admin_id]
        );
      }

      // ─── Same for a supplier payment: keep the purchase order's money in step ───
      // (Without this the PO stayed "unpaid" in the Purchase Orders list no matter
      //  how many payments had been recorded against it.)
      if (hasPurchase && parentRow) {
        newPaid = Math.round((Number(parentRow.paid_amount) + amountNum) * 100) / 100;
        newDue = Math.max(0, Math.round((Number(parentRow.grand_total) - newPaid) * 100) / 100);
        newStatus = newDue <= 0.001 ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';

        await connection.query(
          `UPDATE pharmacy_purchase_orders
              SET paid_amount    = ?,
                  due_amount     = ?,
                  payment_status = ?
            WHERE id = ? AND admin_id = ?`,
          [newPaid, newDue, newStatus, purchase_id, admin_id]
        );
      }

      await connection.commit();

      return res.status(201).json({
        success: true,
        message: 'Payment recorded',
        data: {
          id: insertResult.insertId,
          payment_number,
          sale_id: hasSale ? sale_id : null,
          purchase_id: hasPurchase ? purchase_id : null,
          amount: amountNum,
          payment_method,
          new_paid_total: newPaid,
          new_due: newDue,
          payment_status: newStatus,
        },
      });
    } catch (err) {
      await connection.rollback();
      console.error('post/payment error:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to record payment',
      });
    } finally {
      connection.release();
    }
  }
);


// ─────────────────────────────────────────────────────────────
// EDIT / DELETE a payment
//
// Both keep the order's (or sale's) paid_amount / due_amount / payment_status in
// step. They work out the CHANGE this edit makes (new amount − old amount) and apply
// just that to the parent's paid_amount, rather than re-adding up every payment — so
// an order that already had money on it from before payments were itemised stays right.
//
// Who may:
//   supplier payment (purchase_id) → pharmacy.purchase.edit  or pharmacy.payments.update / .delete
//   customer payment (sale_id)     → pharmacy.payments.update / .delete
// (Only pharmacy.payments.create exists in the permissions table today, so purchase.edit
//  is what lets a purchasing user fix a supplier payment. Tenant admins always pass.)
//
// Only the money details can change: amount, method, reference, notes, date. Which order
// a payment belongs to, its number and who took it are fixed — to move a payment to a
// different order, delete it and record it again there.
// ─────────────────────────────────────────────────────────────
const EDIT_PERMS_PURCHASE = ['pharmacy.payments.update', 'pharmacy.purchase.edit'];
const EDIT_PERMS_SALE = ['pharmacy.payments.update'];
const DELETE_PERMS_PURCHASE = ['pharmacy.payments.delete', 'pharmacy.purchase.edit'];
const DELETE_PERMS_SALE = ['pharmacy.payments.delete'];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const statusFor = (grand, paid) => {
  const due = Math.max(0, round2(grand - paid));
  return { due, status: due <= 0.001 ? 'paid' : paid > 0 ? 'partial' : 'unpaid' };
};
const isTenantAdminUser = (u) => !!(u.role && String(u.role).toLowerCase() === 'admin');
const holdsAny = (u, keys) => isTenantAdminUser(u) || keys.some((k) => (u.permissions || []).includes(k));

// Lock the order/sale a payment belongs to and return it, or { error: [status, message] }.
async function lockParent(conn, payment, admin_id) {
  const isPurchase = payment.purchase_id != null;
  const table = isPurchase ? 'pharmacy_purchase_orders' : 'pharmacy_sales';
  const id = isPurchase ? payment.purchase_id : payment.sale_id;
  const [[parent]] = await conn.query(
    `SELECT id, grand_total, paid_amount, status, branch
       FROM ${table}
      WHERE id = ? AND admin_id = ?
      FOR UPDATE`,
    [id, admin_id]
  );
  if (!parent) {
    return { error: [404, isPurchase ? 'Purchase order not found' : 'Sale not found'] };
  }
  if (parent.status === 'cancelled') {
    return { error: [400, `Cannot change payments on a cancelled ${isPurchase ? 'purchase order' : 'sale'}`] };
  }
  return { parent, table, isPurchase };
}

// Apply `delta` to the parent's paid total. Returns { newPaid, newDue, newStatus } or { error }.
async function applyDelta(conn, ctx, delta, admin_id) {
  const { parent, table } = ctx;
  const grand = Number(parent.grand_total);
  const newPaid = round2(Number(parent.paid_amount) + delta);
  if (newPaid < -0.001) {
    return { error: [400, `That would leave the order with less than nothing paid (paid is ₹${Number(parent.paid_amount).toFixed(2)})`] };
  }
  if (newPaid > grand + 0.001) {
    return { error: [400, `Total paid would be more than the order value (₹${grand.toFixed(2)})`] };
  }
  const { due, status } = statusFor(grand, newPaid);
  if (Math.abs(delta) > 0.0001) {
    await conn.query(
      `UPDATE ${table}
          SET paid_amount = ?, due_amount = ?, payment_status = ?
        WHERE id = ? AND admin_id = ?`,
      [newPaid, due, status, parent.id, admin_id]
    );
  }
  return { newPaid, newDue: due, newStatus: status };
}

// Read the payment, lock its order, then re-read the payment under lock.
// (Order first, payment second — the same order POST uses, so two people can't deadlock.)
async function lockPaymentAndParent(conn, paymentId, admin_id) {
  const [[peek]] = await conn.query(
    `SELECT * FROM pharmacy_payments WHERE id = ? AND admin_id = ? LIMIT 1`,
    [paymentId, admin_id]
  );
  if (!peek) return { error: [404, 'Payment not found'] };
  if (peek.purchase_id == null && peek.sale_id == null) {
    return { error: [400, 'This payment is not attached to an order or a sale'] };
  }
  const ctx = await lockParent(conn, peek, admin_id);
  if (ctx.error) return ctx;
  const [[payment]] = await conn.query(
    `SELECT * FROM pharmacy_payments WHERE id = ? AND admin_id = ? FOR UPDATE`,
    [paymentId, admin_id]
  );
  if (!payment) return { error: [404, 'Payment not found'] };
  return { ...ctx, payment };
}

const fail = (res, [status, message], extra) =>
  res.status(status).json({ success: false, message, ...(extra || {}) });

// A debit note is written by a purchase return (routes/Pharmacy/pharmacyPurchaseReturns.js) and
// belongs to it: changing or deleting it here would move the order's due while the return still
// says "credited". It is undone by cancelling the return.
const debitNoteLock = (payment) =>
  payment.payment_method === 'debit_note'
    ? [409, `This is debit note ${payment.transaction_reference || ''} from a purchase return — cancel the return (Purchase Returns) to take it back.`.replace('  ', ' ')]
    : null;

// ─────────────────────────────────────────────────────────────
// PUT update payment
// body (all optional): amount, payment_method, transaction_reference, notes, payment_date (YYYY-MM-DD)
// ─────────────────────────────────────────────────────────────
router.put(
  '/update/payment/:id',
  authMiddleware,
  allowPermissions(...new Set([...EDIT_PERMS_PURCHASE, ...EDIT_PERMS_SALE])),
  async (req, res) => {
    const admin_id = getAdminIdFromUser(req.user);
    const body = req.body || {};

    // ── validate what was sent (before touching the DB) ──
    if (body.payment_method !== undefined && !PAYMENT_METHODS.includes(body.payment_method)) {
      return fail(res, [400, `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}`]);
    }
    let newAmount;
    if (body.amount !== undefined) {
      newAmount = round2(body.amount);
      if (!Number.isFinite(newAmount) || newAmount === 0) {
        return fail(res, [400, 'amount cannot be zero — to remove a payment, delete it']);
      }
      if (Math.abs(newAmount) > 10_000_000) return fail(res, [400, 'amount too large']);
    }
    let newDay;
    if (body.payment_date !== undefined && body.payment_date !== null && body.payment_date !== '') {
      newDay = String(body.payment_date).slice(0, 10);
      const t = new Date(`${newDay}T00:00:00`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newDay) || Number.isNaN(t.getTime())) {
        return fail(res, [400, 'payment_date must be a date like 2026-10-15']);
      }
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);
      if (t > endOfToday) return fail(res, [400, 'payment_date cannot be in the future']);
    }
    let newRef;
    if (body.transaction_reference !== undefined) {
      newRef = String(body.transaction_reference || '').trim().slice(0, 255) || null;
    }
    let newNotes;
    if (body.notes !== undefined) {
      newNotes = String(body.notes || '').trim() || null;
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const ctx = await lockPaymentAndParent(conn, req.params.id, admin_id);
      if (ctx.error) {
        await conn.rollback();
        return fail(res, ctx.error);
      }
      // Branch: staff may only change payments on their own branch's sales.
      // (Supplier payments: unchanged — see the note at the top.)
      if (!ctx.isPurchase) {
        try {
          await recordScope(conn, req, ctx.parent.branch, { notFound: 'Payment not found' });
        } catch (e) {
          await conn.rollback();
          if (sendBranchError(res, e)) return;
          throw e;
        }
      }
      const { payment, isPurchase } = ctx;
      if (debitNoteLock(payment)) {
        await conn.rollback();
        return fail(res, debitNoteLock(payment));
      }

      const needed = isPurchase ? EDIT_PERMS_PURCHASE : EDIT_PERMS_SALE;
      if (!holdsAny(req.user, needed)) {
        await conn.rollback();
        return fail(
          res,
          [403, isPurchase
            ? 'Access denied — you cannot edit supplier payments'
            : 'Access denied — you cannot edit customer payments'],
          { required: needed }
        );
      }

      const oldAmount = round2(payment.amount);
      const amount = newAmount === undefined ? oldAmount : newAmount;
      // A payment stays a payment and a refund stays a refund.
      if (Math.sign(amount) !== Math.sign(oldAmount)) {
        await conn.rollback();
        return fail(res, [400, oldAmount > 0
          ? 'A payment cannot be turned into a refund — delete it and record the refund instead'
          : 'A refund cannot be turned into a payment — delete it and record the payment instead']);
      }

      const applied = await applyDelta(conn, ctx, round2(amount - oldAmount), admin_id);
      if (applied.error) {
        await conn.rollback();
        return fail(res, applied.error);
      }

      await conn.query(
        `UPDATE pharmacy_payments
            SET amount                = ?,
                payment_method        = ?,
                transaction_reference = ?,
                notes                 = ?,
                payment_date          = IF(? IS NULL, payment_date,
                                           CONCAT(?, ' ', COALESCE(TIME(payment_date), '00:00:00')))
          WHERE id = ? AND admin_id = ?`,
        [
          amount,
          body.payment_method ?? payment.payment_method,
          newRef !== undefined ? newRef : payment.transaction_reference,
          newNotes !== undefined ? newNotes : payment.notes,
          newDay ?? null,
          newDay ?? null,
          payment.id,
          admin_id,
        ]
      );

      await conn.commit();
      console.log(
        `[payments] #${payment.id} edited by user ${req.user.id}: ` +
        `amount ${oldAmount} -> ${amount}, method ${payment.payment_method} -> ${body.payment_method ?? payment.payment_method}`
      );

      return res.json({
        success: true,
        message: 'Payment updated',
        data: {
          id: payment.id,
          purchase_id: payment.purchase_id,
          sale_id: payment.sale_id,
          amount,
          new_paid_total: applied.newPaid,
          new_due: applied.newDue,
          payment_status: applied.newStatus,
        },
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error('update/payment error:', err);
      return res.status(500).json({ success: false, message: 'Failed to update the payment' });
    } finally {
      conn.release();
    }
  }
);

// ─────────────────────────────────────────────────────────────
// DELETE a payment (hard delete) — and take it back off the order's paid total.
// For a genuine reversal that should stay on the books, POST a negative payment instead.
// ─────────────────────────────────────────────────────────────
router.delete(
  '/delete/payment/:id',
  authMiddleware,
  allowPermissions(...new Set([...DELETE_PERMS_PURCHASE, ...DELETE_PERMS_SALE])),
  async (req, res) => {
    const admin_id = getAdminIdFromUser(req.user);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const ctx = await lockPaymentAndParent(conn, req.params.id, admin_id);
      if (ctx.error) {
        await conn.rollback();
        return fail(res, ctx.error);
      }
      // Branch: staff may only change payments on their own branch's sales.
      // (Supplier payments: unchanged — see the note at the top.)
      if (!ctx.isPurchase) {
        try {
          await recordScope(conn, req, ctx.parent.branch, { notFound: 'Payment not found' });
        } catch (e) {
          await conn.rollback();
          if (sendBranchError(res, e)) return;
          throw e;
        }
      }
      const { payment, isPurchase } = ctx;
      if (debitNoteLock(payment)) {
        await conn.rollback();
        return fail(res, debitNoteLock(payment));
      }

      const needed = isPurchase ? DELETE_PERMS_PURCHASE : DELETE_PERMS_SALE;
      if (!holdsAny(req.user, needed)) {
        await conn.rollback();
        return fail(
          res,
          [403, isPurchase
            ? 'Access denied — you cannot delete supplier payments'
            : 'Access denied — you cannot delete customer payments'],
          { required: needed }
        );
      }

      const applied = await applyDelta(conn, ctx, -round2(payment.amount), admin_id);
      if (applied.error) {
        await conn.rollback();
        return fail(res, applied.error);
      }

      await conn.query(`DELETE FROM pharmacy_payments WHERE id = ? AND admin_id = ?`, [payment.id, admin_id]);

      await conn.commit();
      console.log(
        `[payments] #${payment.id} (${payment.payment_number}, ${payment.amount}) deleted by user ${req.user.id}`
      );

      return res.json({
        success: true,
        message: 'Payment deleted',
        data: {
          id: payment.id,
          new_paid_total: applied.newPaid,
          new_due: applied.newDue,
          payment_status: applied.newStatus,
        },
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error('delete/payment error:', err);
      return res.status(500).json({ success: false, message: 'Failed to delete the payment' });
    } finally {
      conn.release();
    }
  }
);

module.exports = router;