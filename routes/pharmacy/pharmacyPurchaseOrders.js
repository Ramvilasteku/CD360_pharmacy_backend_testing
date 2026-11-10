// routes/pharmacy/purchase-orders.js

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const db = require("../../db");
const { buildPurchaseOrderPdf } = require("../../utils/buildPurchaseOrderPdf");
const {
  sendPurchaseOrderEmail,
  defaultSubject,
  defaultMessage,
  isValidEmail,
  parseEmailList,
} = require("../../utils/sendPurchaseOrderEmail");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
const {
  unitsPerPack,
  cleanUnitsPerPack,
  packWord,
  readSaleLine,
  describeStock,
} = require("../../utils/pharmacyUnits");
const {
  resolveScope,
  batchFilter,
  sendBranchError,
} = require("../../utils/pharmacyBranch");

/* ============================================================
   DESIGN NOTES

   ONE FILE for TWO TABLES because a purchase order and its
   items are one logical document. Every write uses a DB
   transaction so header and items commit or roll back together.

   State machine:
     draft → ordered     (sent to the supplier; ordered_at is stamped)
     draft → cancelled
     ordered → cancelled
     draft | ordered → received   ONLY through the Receive screen
                         (routes/Pharmacy/pharmacyReceivePurchaseOrder.js), which
                         creates the batches and the stock ledger. This file refuses
                         'received' (409) — a PO marked received here would claim stock
                         that never reached the shelf.
     received → * terminal *

   Units: quantity / free_quantity on a line are STRIPS; prices are per strip.
   units_per_pack on a line is a snapshot of the medicine's tablets per strip
   when the line was written. Stock is counted in tablets (utils/pharmacyUnits.js).

   Branch: pharmacy_purchase_orders.branch is the DELIVER-TO branch. Staff orders
   go to their own branch; the admin of a multi-branch pharmacy picks one.
       (corrections handled via purchase_return / adjustment
        stock transactions, NOT by editing this PO — same
        audit-trail principle as the stock ledger)

   Updates only allowed while status='draft'.
   Payments go through a dedicated /payment/:id endpoint so
   cashiers can record payment without touching invoice content.
============================================================ */

const VALID_ORDER_STATUS = ["draft", "ordered", "received", "cancelled"];
const VALID_ORDER_TYPE = ["out_of_stock", "new_order"];
const VALID_PAYMENT_STATUS = ["unpaid", "partial", "paid"];
const RECEIVE_ELSEWHERE = "Receive stock on the Receive screen";

/* Generate PO and Sale-based Order are separate pages with separate permissions,
   but one endpoint. out_of_stock = the stock-based page, anything else = sale-based. */
const generateGate = (req, res, next) =>
  allowPermissions(
    (req.body && req.body.order_type) === "out_of_stock" ||
      !(req.body && req.body.order_type)
      ? "pharmacy.purchase.generate_create"
      : "pharmacy.purchase.salebased_create",
  )(req, res, next);

const GENERATE_PERMS = [
  "pharmacy.purchase.view",
  "pharmacy.purchase.generate_create",
  "pharmacy.purchase.salebased_create",
];

/* ============================================================
   Helper: resolve tenant admin_id from req.user
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

/* ============================================================
   Helper: derive due_amount + payment_status from totals
============================================================ */
function computePaymentFields(grandTotal, paidAmount) {
  const gt = Number(grandTotal) || 0;
  const pa = Number(paidAmount) || 0;
  const due = Math.max(0, +(gt - pa).toFixed(2));

  let paymentStatus;
  if (pa <= 0) paymentStatus = "unpaid";
  else if (pa >= gt) paymentStatus = "paid";
  else paymentStatus = "partial";

  return { due_amount: due, payment_status: paymentStatus };
}

/* ============================================================
   Helper: validate a single line item
============================================================ */
function validateItem(item, idx, orderStatus = "received") {
  const prefix = `Item #${idx + 1}`;

  if (!item.medicine_id)
    return { ok: false, message: `${prefix}: medicine_id is required` };

  // A batch number and an expiry exist only once the pack is in your hands, so a
  // draft or an order that is still with the supplier doesn't carry them.
  if (orderStatus === "received") {
    if (!item.batch_number || !String(item.batch_number).trim())
      return { ok: false, message: `${prefix}: batch_number is required` };
    if (!item.expiry_date)
      return { ok: false, message: `${prefix}: expiry_date is required` };
  }

  const qty = Number(item.quantity);
  if (!Number.isFinite(qty) || qty <= 0)
    return { ok: false, message: `${prefix}: quantity must be > 0` };

  const nonNegFields = [
    "free_quantity",
    "purchase_price",
    "mrp",
    "selling_price",
    "discount_amount",
    "gst_percentage",
    "tax_amount",
    "total_amount",
  ];

  for (const field of nonNegFields) {
    const v = item[field];
    if (v !== undefined && v !== null && v !== "") {
      if (!Number.isFinite(Number(v)) || Number(v) < 0) {
        return {
          ok: false,
          message: `${prefix}: ${field} must be a non-negative number`,
        };
      }
    }
  }

  if (item.gst_percentage !== undefined && Number(item.gst_percentage) > 100) {
    return {
      ok: false,
      message: `${prefix}: gst_percentage cannot exceed 100`,
    };
  }

  return { ok: true };
}

/* ============================================================
   Helper: fetch order with items nested
============================================================ */
async function fetchPurchaseWithItems(orderId, tenantAdminId) {
  const [orderRows] = await db.query(
    `SELECT po.*, s.supplier_name
       FROM pharmacy_purchase_orders po
       LEFT JOIN pharmacy_suppliers s ON s.id = po.supplier_id
      WHERE po.id = ? AND po.admin_id = ? LIMIT 1`,
    [orderId, tenantAdminId],
  );
  if (!orderRows.length) return null;

  const [rawItems] = await db.query(
    `SELECT i.*, m.medicine_code, m.pack_size, m.unit, m.units_per_pack AS medicine_units_per_pack,
            md.medicine_name, md.brand_name, md.generic_name, md.dosage_form, md.strength
       FROM pharmacy_purchase_items i
       LEFT JOIN pharmacy_medicines m ON m.id = i.medicine_id
       LEFT JOIN medicine_data md ON md.id = m.medicine_data_id
      WHERE i.purchase_id = ?
      ORDER BY i.id ASC`,
    [orderId],
  );
  // tablets per strip: the line's own snapshot, else the medicine's (its number, then its pack label)
  const itemRows = rawItems.map(({ medicine_units_per_pack, ...it }) => {
    const upp =
      Number(it.units_per_pack) >= 1
        ? Number(it.units_per_pack)
        : unitsPerPack({
            units_per_pack: medicine_units_per_pack,
            pack_size: it.pack_size,
          });
    return { ...it, units_per_pack: upp, pack_word: packWord(it, upp) };
  });

  const [paymentRows] = await db.query(
    `SELECT id, payment_number, payment_date,
            DATE_FORMAT(payment_date, '%Y-%m-%d') AS payment_day,
            amount, payment_method, transaction_reference, notes
       FROM pharmacy_payments
      WHERE purchase_id = ? AND admin_id = ?
      ORDER BY payment_date ASC, id ASC`,
    [orderId, tenantAdminId],
  );

  return { ...orderRows[0], items: itemRows, payments: paymentRows };
}

/* ============================================================
   Helper: insert one item row (used by create + update)
============================================================ */
async function insertItem(conn, purchaseId, item) {
  await conn.query(
    `INSERT INTO pharmacy_purchase_items
      (purchase_id, medicine_id, batch_id, batch_number,
       manufacturing_date, expiry_date,
       quantity, free_quantity, units_per_pack,
       purchase_price, mrp, selling_price,
       discount_amount, gst_percentage, tax_amount, total_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      purchaseId,
      item.medicine_id,
      item.batch_id || null,
      item.batch_number && String(item.batch_number).trim()
        ? String(item.batch_number).trim()
        : null,
      item.manufacturing_date || null,
      item.expiry_date || null,
      Number(item.quantity),
      Number(item.free_quantity) || 0,
      Number(item.units_per_pack) >= 1 ? Number(item.units_per_pack) : null,
      Number(item.purchase_price) || 0,
      Number(item.mrp) || 0,
      Number(item.selling_price) || 0,
      Number(item.discount_amount) || 0,
      Number(item.gst_percentage) || 0,
      Number(item.tax_amount) || 0,
      Number(item.total_amount) || 0,
    ],
  );
}

/* ============================================================
   Helper: tablets per strip for each medicine — what a new line snapshots
============================================================ */
async function medicineUppMap(conn, medicineIds, tenantAdminId) {
  const ids = [...new Set(medicineIds.map(Number).filter(Boolean))];
  if (!ids.length) return new Map();
  const [rows] = await conn.query(
    `SELECT id, units_per_pack, pack_size FROM pharmacy_medicines WHERE id IN (?) AND admin_id = ?`,
    [ids, tenantAdminId],
  );
  return new Map(rows.map((m) => [Number(m.id), unitsPerPack(m)]));
}

/** item.units_per_pack when given (validated), else the medicine's. Throws 400 on a bad number. */
function lineUpp(item, uppOf, idx) {
  if (
    item.units_per_pack !== undefined &&
    item.units_per_pack !== null &&
    item.units_per_pack !== ""
  ) {
    const n = cleanUnitsPerPack(
      item.units_per_pack,
      `Item #${idx + 1}: tablets per strip`,
    );
    if (n) return n;
  }
  return uppOf.get(Number(item.medicine_id)) || 1;
}

/* ============================================================
   Helper: verify medicines exist for this tenant
============================================================ */
async function verifyMedicines(conn, medicineIds, tenantAdminId) {
  const unique = [...new Set(medicineIds)];
  if (!unique.length) return { ok: true };
  const [meds] = await conn.query(
    `SELECT id FROM pharmacy_medicines WHERE id IN (?) AND admin_id = ?`,
    [unique, tenantAdminId],
  );
  if (meds.length !== unique.length) {
    return {
      ok: false,
      message: "One or more medicines not found for this tenant",
    };
  }
  return { ok: true };
}

/* ============================================================
   CREATE purchase order + items (atomic)
   Access:
     - admin (bypass)
     - staff with 'pharmacy.purchase.create'
============================================================ */
router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.purchase.create"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const tenantAdminId = getTenantAdminId(req);
      const {
        supplier_id,
        purchase_number,
        purchase_date,
        invoice_number,
        invoice_date,
        subtotal = 0,
        discount_amount = 0,
        tax_amount = 0,
        other_charges = 0,
        grand_total = 0,
        paid_amount = 0,
        notes,
        status = "draft",
        order_type = "new_order",
        expected_delivery_date,
        items = [],
      } = req.body;

      // ---- Header validation ----
      if (!supplier_id) {
        return res.status(400).json({
          success: false,
          message: "supplier_id is required",
        });
      }
      if (!purchase_number || !String(purchase_number).trim()) {
        return res.status(400).json({
          success: false,
          message: "purchase_number is required",
        });
      }
      if (!purchase_date) {
        return res.status(400).json({
          success: false,
          message: "purchase_date is required",
        });
      }
      if (!VALID_ORDER_STATUS.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status",
        });
      }
      // Stock only comes in through the Receive screen — an order can't be born 'received'.
      if (status === "received") {
        return res
          .status(409)
          .json({ success: false, message: RECEIVE_ELSEWHERE });
      }
      if (!VALID_ORDER_TYPE.includes(order_type)) {
        return res.status(400).json({
          success: false,
          message: "Invalid order_type",
        });
      }
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: "At least one item is required",
        });
      }

      // ---- Item validation (before opening txn) ----
      for (let i = 0; i < items.length; i++) {
        const v = validateItem(items[i], i, status);
        if (!v.ok) {
          return res.status(400).json({ success: false, message: v.message });
        }
      }

      const trimmedPurchaseNumber = String(purchase_number).trim();

      // deliver-to branch: staff → their own; the admin → the one sent (or none yet)
      const scope = await resolveScope(conn, req, {
        wanted: req.body.branch,
        forWrite: false,
      });

      await conn.beginTransaction();

      // Duplicate purchase_number check per tenant
      const [dup] = await conn.query(
        `SELECT id FROM pharmacy_purchase_orders
         WHERE admin_id = ? AND purchase_number = ? LIMIT 1`,
        [tenantAdminId, trimmedPurchaseNumber],
      );
      if (dup.length) {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: `Purchase number '${trimmedPurchaseNumber}' already exists`,
        });
      }

      // TODO: verify supplier when pharmacy_suppliers table exists
      // const [supplier] = await conn.query(
      //   `SELECT id FROM pharmacy_suppliers WHERE id = ? AND admin_id = ? LIMIT 1`,
      //   [supplier_id, tenantAdminId]
      // );
      // if (!supplier.length) {
      //   await conn.rollback();
      //   return res.status(404).json({ success: false, message: "Supplier not found" });
      // }

      // Verify medicines belong to this tenant
      const medCheck = await verifyMedicines(
        conn,
        items.map((i) => i.medicine_id),
        tenantAdminId,
      );
      if (!medCheck.ok) {
        await conn.rollback();
        return res
          .status(404)
          .json({ success: false, message: medCheck.message });
      }

      const { due_amount, payment_status } = computePaymentFields(
        grand_total,
        paid_amount,
      );

      const uppOf = await medicineUppMap(
        conn,
        items.map((i) => i.medicine_id),
        tenantAdminId,
      );
      const lines = items.map((it, idx) => ({
        ...it,
        units_per_pack: lineUpp(it, uppOf, idx),
      }));

      // ---- Insert header ----
      const [orderResult] = await conn.query(
        `INSERT INTO pharmacy_purchase_orders
          (admin_id, branch, supplier_id, purchase_number, purchase_date,
           order_type, expected_delivery_date, ordered_at,
           invoice_number, invoice_date,
           subtotal, discount_amount, tax_amount, other_charges, grand_total,
           paid_amount, due_amount, payment_status, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${status === "ordered" ? "NOW()" : "NULL"}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantAdminId,
          scope.branch || null,
          supplier_id,
          trimmedPurchaseNumber,
          purchase_date,
          order_type,
          expected_delivery_date || null,
          invoice_number ? String(invoice_number).trim() : null,
          invoice_date || null,
          Number(subtotal) || 0,
          Number(discount_amount) || 0,
          Number(tax_amount) || 0,
          Number(other_charges) || 0,
          Number(grand_total) || 0,
          Number(paid_amount) || 0,
          due_amount,
          payment_status,
          status,
          notes ? String(notes).trim() : null,
        ],
      );

      const orderId = orderResult.insertId;

      // ---- Insert items ----
      for (const item of lines) {
        await insertItem(conn, orderId, item);
      }

      await conn.commit();

      const complete = await fetchPurchaseWithItems(orderId, tenantAdminId);
      return res.status(201).json({
        success: true,
        message: "Purchase order created",
        data: complete,
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (sendBranchError(res, err)) return;
      if (err.status === 400)
        return res.status(400).json({ success: false, message: err.message });
      console.error("Create purchase order error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create purchase order",
      });
    } finally {
      conn.release();
    }
  },
);

/* ============================================================
   LIST purchase orders (headers only, with filters)
   Query: search (po#/invoice#), supplier_id, status,
          payment_status, date_from, date_to, page (from 1), limit (1-100, default 20),
          branch (admin of a multi-branch pharmacy: one deliver-to branch; omit → all)
   Several branches: staff see their own branch's orders plus the ones with no branch yet.
   Reply:  data (this page), pagination {page, limit, total, total_pages},
           summary {count, value, paid, due, open} for ALL matching orders
============================================================ */
router.get(
  "/get",
  authMiddleware,
  allowPermissions("pharmacy.purchase.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const {
        search,
        supplier_id,
        status,
        payment_status,
        date_from,
        date_to,
        sort_order = "DESC",
      } = req.query;

      // A page is a whole number from 1; a page size is 1..100 (the screen offers 10 / 20 / 50 / 100).
      // Anything else — missing, text, negative, absurdly large — falls back instead of reaching SQL.
      const pageNo = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit, 10) || 20),
      );

      const where = ["po.admin_id = ?"];
      const params = [tenantAdminId];

      if (supplier_id) {
        where.push("po.supplier_id = ?");
        params.push(supplier_id);
      }
      const scope = await resolveScope(db, req, {
        wanted: req.query.branch,
        forWrite: false,
      });
      if (scope.filter) {
        where.push(
          scope.actor.isAdmin
            ? "LOWER(TRIM(po.branch)) = ?"
            : "(po.branch IS NULL OR TRIM(po.branch) = '' OR LOWER(TRIM(po.branch)) = ?)",
        );
        params.push(scope.key);
      }
      if (status && VALID_ORDER_STATUS.includes(status)) {
        where.push("po.status = ?");
        params.push(status);
      }
      if (payment_status && VALID_PAYMENT_STATUS.includes(payment_status)) {
        where.push("po.payment_status = ?");
        params.push(payment_status);
      }
      if (date_from) {
        where.push("po.purchase_date >= ?");
        params.push(date_from);
      }
      if (date_to) {
        // a plain date means "up to the end of that day"
        where.push("po.purchase_date < DATE_ADD(?, INTERVAL 1 DAY)");
        params.push(date_to);
      }
      if (search && String(search).trim()) {
        where.push(
          "(po.purchase_number LIKE ? OR po.invoice_number LIKE ? OR s.supplier_name LIKE ?)",
        );
        const like = `%${String(search).trim()}%`;
        params.push(like, like, like);
      }

      const whereClause = where.join(" AND ");
      const offset = (pageNo - 1) * pageSize;
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      // The count AND the figures above the list, for EVERY order that matches the filters —
      // not just the page on screen. A cancelled order owes and costs nothing, so it is left
      // out of the money; "open" is the orders still waiting (draft or ordered).
      const [countRes] = await db.query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN po.status <> 'cancelled' THEN po.grand_total END), 0) AS value,
                COALESCE(SUM(CASE WHEN po.status <> 'cancelled' THEN po.paid_amount END), 0) AS paid,
                COALESCE(SUM(CASE WHEN po.status <> 'cancelled' THEN po.due_amount END), 0) AS due,
                COALESCE(SUM(po.status IN ('draft', 'ordered')), 0) AS open_count
           FROM pharmacy_purchase_orders po
           LEFT JOIN pharmacy_suppliers s ON s.id = po.supplier_id
          WHERE ${whereClause}`,
        params,
      );
      const total = Number(countRes[0].total) || 0;

      const [rows] = await db.query(
        `SELECT po.*, s.supplier_name,
                (SELECT COUNT(*) FROM pharmacy_purchase_items i
                  WHERE i.purchase_id = po.id) AS items_count
           FROM pharmacy_purchase_orders po
           LEFT JOIN pharmacy_suppliers s ON s.id = po.supplier_id
          WHERE ${whereClause}
          ORDER BY po.purchase_date ${safeSortOrder}, po.id ${safeSortOrder}
          LIMIT ? OFFSET ?`,
        [...params, pageSize, offset],
      );

      return res.json({
        success: true,
        data: rows,
        pagination: {
          page: pageNo,
          limit: pageSize,
          total,
          total_pages: Math.ceil(total / pageSize),
        },
        summary: {
          count: total,
          value: Number(countRes[0].value) || 0,
          paid: Number(countRes[0].paid) || 0,
          due: Number(countRes[0].due) || 0,
          open: Number(countRes[0].open_count) || 0,
        },
      });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("List purchase orders error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch purchase orders",
      });
    }
  },
);

/* ============================================================
   GET single order with items nested
============================================================ */
router.get(
  "/get/:id",
  authMiddleware,
  allowPermissions("pharmacy.purchase.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const data = await fetchPurchaseWithItems(id, tenantAdminId);
      if (!data) {
        return res.status(404).json({
          success: false,
          message: "Purchase order not found",
        });
      }

      return res.json({ success: true, data });
    } catch (err) {
      console.error("Get purchase order error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch purchase order",
      });
    }
  },
);

/* ============================================================
   UPDATE purchase order (header + items REPLACED atomically)
   Only allowed while status='draft'.
============================================================ */
router.put(
  "/update/:id",
  authMiddleware,
  allowPermissions("pharmacy.purchase.edit"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
      const {
        supplier_id,
        purchase_number,
        purchase_date,
        invoice_number,
        invoice_date,
        subtotal,
        discount_amount,
        tax_amount,
        other_charges,
        grand_total,
        paid_amount,
        notes,
        items,
      } = req.body;

      await conn.beginTransaction();

      const [existing] = await conn.query(
        `SELECT id, status, purchase_number, grand_total, paid_amount
         FROM pharmacy_purchase_orders
         WHERE id = ? AND admin_id = ? LIMIT 1
         FOR UPDATE`,
        [id, tenantAdminId],
      );

      if (!existing.length) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Purchase order not found",
        });
      }

      if (existing[0].status !== "draft") {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: `Cannot edit — order is '${existing[0].status}'. Only drafts can be edited. Use purchase_return or adjustment transactions to correct received orders.`,
        });
      }

      // Validate items if provided
      if (items !== undefined) {
        if (!Array.isArray(items) || items.length === 0) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: "items must be a non-empty array",
          });
        }
        for (let i = 0; i < items.length; i++) {
          const v = validateItem(items[i], i, "draft");
          if (!v.ok) {
            await conn.rollback();
            return res.status(400).json({ success: false, message: v.message });
          }
        }
        const medCheck = await verifyMedicines(
          conn,
          items.map((i) => i.medicine_id),
          tenantAdminId,
        );
        if (!medCheck.ok) {
          await conn.rollback();
          return res.status(404).json({
            success: false,
            message: medCheck.message,
          });
        }
      }

      // Choosing (or changing) the supplier: it must be one of this tenant's active suppliers.
      // A draft can be given a supplier but never have it taken away again.
      if (supplier_id !== undefined) {
        const sid = Number(supplier_id);
        if (!Number.isInteger(sid) || sid <= 0) {
          await conn.rollback();
          return res
            .status(400)
            .json({ success: false, message: "Choose a valid supplier" });
        }
        const [sup] = await conn.query(
          `SELECT id, status FROM pharmacy_suppliers WHERE id = ? AND admin_id = ? LIMIT 1`,
          [sid, tenantAdminId],
        );
        if (!sup.length) {
          await conn.rollback();
          return res
            .status(404)
            .json({ success: false, message: "Supplier not found" });
        }
        if (sup[0].status !== "active") {
          await conn.rollback();
          return res
            .status(409)
            .json({ success: false, message: "That supplier is inactive" });
        }
      }

      // Duplicate check if purchase_number changing
      if (purchase_number !== undefined) {
        const trimmed = String(purchase_number).trim();
        if (!trimmed) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: "purchase_number cannot be empty",
          });
        }
        if (trimmed !== existing[0].purchase_number) {
          const [dup] = await conn.query(
            `SELECT id FROM pharmacy_purchase_orders
             WHERE admin_id = ? AND purchase_number = ? AND id != ? LIMIT 1`,
            [tenantAdminId, trimmed, id],
          );
          if (dup.length) {
            await conn.rollback();
            return res.status(409).json({
              success: false,
              message: `Purchase number '${trimmed}' already exists`,
            });
          }
        }
      }

      // Build header updates
      const updates = [];
      const params = [];

      const editable = {
        supplier_id,
        purchase_number:
          purchase_number !== undefined
            ? String(purchase_number).trim()
            : undefined,
        purchase_date,
        invoice_number:
          invoice_number !== undefined
            ? invoice_number
              ? String(invoice_number).trim()
              : null
            : undefined,
        invoice_date,
        subtotal,
        discount_amount,
        tax_amount,
        other_charges,
        grand_total,
        paid_amount,
        notes:
          notes !== undefined
            ? notes
              ? String(notes).trim()
              : null
            : undefined,
      };

      for (const [field, value] of Object.entries(editable)) {
        if (value === undefined) continue;
        updates.push(`${field} = ?`);
        params.push(value);
      }

      // Recompute payment fields if grand_total or paid_amount changed
      if (grand_total !== undefined || paid_amount !== undefined) {
        const gt =
          grand_total !== undefined
            ? Number(grand_total)
            : Number(existing[0].grand_total);
        const pa =
          paid_amount !== undefined
            ? Number(paid_amount)
            : Number(existing[0].paid_amount);
        const { due_amount, payment_status } = computePaymentFields(gt, pa);
        updates.push("due_amount = ?", "payment_status = ?");
        params.push(due_amount, payment_status);
      }

      if (updates.length) {
        params.push(id, tenantAdminId);
        await conn.query(
          `UPDATE pharmacy_purchase_orders
           SET ${updates.join(", ")}
           WHERE id = ? AND admin_id = ?`,
          params,
        );
      }

      // Replace items if provided (each keeps the tablets per strip it was ordered in)
      if (items !== undefined) {
        const uppOf = await medicineUppMap(
          conn,
          items.map((i) => i.medicine_id),
          tenantAdminId,
        );
        const lines = items.map((it, idx) => ({
          ...it,
          units_per_pack: lineUpp(it, uppOf, idx),
        }));
        await conn.query(
          `DELETE FROM pharmacy_purchase_items WHERE purchase_id = ?`,
          [id],
        );
        for (const item of lines) {
          await insertItem(conn, id, item);
        }
      }

      await conn.commit();

      const complete = await fetchPurchaseWithItems(id, tenantAdminId);
      return res.json({
        success: true,
        message: "Purchase order updated",
        data: complete,
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (err.status === 400)
        return res.status(400).json({ success: false, message: err.message });
      console.error("Update purchase order error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update purchase order",
      });
    } finally {
      conn.release();
    }
  },
);

/* ============================================================
   CHANGE STATUS (state machine)
     draft → ordered | cancelled
     ordered → cancelled
     → received: refused (409) — stock comes in only through the Receive screen
     received → * (blocked; use returns / adjustments)
============================================================ */
router.patch(
  "/status/:id",
  authMiddleware,
  allowPermissions("pharmacy.purchase.edit"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
      const { status: newStatus } = req.body;

      if (!VALID_ORDER_STATUS.includes(newStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status. Use draft, ordered, received, or cancelled",
        });
      }
      if (newStatus === "received") {
        return res
          .status(409)
          .json({ success: false, message: RECEIVE_ELSEWHERE });
      }

      await conn.beginTransaction();

      const [existing] = await conn.query(
        `SELECT id, status, supplier_id FROM pharmacy_purchase_orders
         WHERE id = ? AND admin_id = ? LIMIT 1
         FOR UPDATE`,
        [id, tenantAdminId],
      );

      if (!existing.length) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Purchase order not found",
        });
      }

      const currentStatus = existing[0].status;

      // A list saved without a supplier can be a draft or be cancelled — nothing more
      // until someone is chosen to supply it.
      if (
        !existing[0].supplier_id &&
        (newStatus === "ordered" || newStatus === "received")
      ) {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: "Choose a supplier for this order before placing it",
        });
      }

      const validTransitions = {
        draft: ["ordered", "cancelled"],
        ordered: ["cancelled"],
        received: [], // terminal
        cancelled: [],
      };

      if (!validTransitions[currentStatus].includes(newStatus)) {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: `Cannot transition from '${currentStatus}' to '${newStatus}'`,
          hint:
            currentStatus === "received"
              ? "A received order is locked. Use purchase_return or adjustment stock transactions to correct it."
              : "This transition is not allowed.",
        });
      }

      await conn.query(
        `UPDATE pharmacy_purchase_orders
            SET status = ?,
                ordered_at = IF(? = 'ordered', NOW(), ordered_at)
          WHERE id = ? AND admin_id = ?`,
        [newStatus, newStatus, id, tenantAdminId],
      );

      await conn.commit();

      return res.json({
        success: true,
        message: `Purchase order status changed to '${newStatus}'`,
        data: { id: Number(id), status: newStatus },
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error("Change status error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to change status",
      });
    } finally {
      conn.release();
    }
  },
);

/* ============================================================
   RECORD PAYMENT — updates paid_amount and derives
   due_amount + payment_status
============================================================ */
router.patch(
  "/payment/:id",
  authMiddleware,
  allowPermissions("pharmacy.purchase.edit"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
      const { paid_amount } = req.body;

      const pa = Number(paid_amount);
      if (!Number.isFinite(pa) || pa < 0) {
        return res.status(400).json({
          success: false,
          message: "paid_amount must be a non-negative number",
        });
      }

      await conn.beginTransaction();

      const [existing] = await conn.query(
        `SELECT id, grand_total, status FROM pharmacy_purchase_orders
         WHERE id = ? AND admin_id = ? LIMIT 1
         FOR UPDATE`,
        [id, tenantAdminId],
      );

      if (!existing.length) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Purchase order not found",
        });
      }

      if (existing[0].status === "cancelled") {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: "Cannot record payment on a cancelled order",
        });
      }

      const gt = Number(existing[0].grand_total);
      if (pa > gt) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: `paid_amount (${pa}) exceeds grand_total (${gt})`,
        });
      }

      const { due_amount, payment_status } = computePaymentFields(gt, pa);

      await conn.query(
        `UPDATE pharmacy_purchase_orders
         SET paid_amount = ?, due_amount = ?, payment_status = ?
         WHERE id = ?`,
        [pa, due_amount, payment_status, id],
      );

      await conn.commit();

      return res.json({
        success: true,
        message: "Payment updated",
        data: {
          id: Number(id),
          paid_amount: pa,
          due_amount,
          payment_status,
        },
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error("Record payment error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to record payment",
      });
    } finally {
      conn.release();
    }
  },
);

/* ============================================================
   DELETE — soft cancel, ONLY drafts allowed
   Received orders can't be deleted (they've hit the ledger).
============================================================ */
router.delete(
  "/delete/:id",
  authMiddleware,
  allowPermissions("pharmacy.purchase.delete"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      await conn.beginTransaction();

      const [existing] = await conn.query(
        `SELECT id, status, purchase_number FROM pharmacy_purchase_orders
         WHERE id = ? AND admin_id = ? LIMIT 1
         FOR UPDATE`,
        [id, tenantAdminId],
      );

      if (!existing.length) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Purchase order not found",
        });
      }

      if (existing[0].status !== "draft") {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: `Only draft orders can be deleted. Current status: '${existing[0].status}'`,
        });
      }

      await conn.query(
        `UPDATE pharmacy_purchase_orders SET status = 'cancelled' WHERE id = ?`,
        [id],
      );

      await conn.commit();

      return res.json({
        success: true,
        message: `Purchase order '${existing[0].purchase_number}' cancelled`,
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error("Delete purchase order error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to delete purchase order",
      });
    } finally {
      conn.release();
    }
  },
);

/* ============================================================
   SENDING A PURCHASE ORDER TO THE SUPPLIER

     GET  /send-info/:id      who it would go to + the default subject / message
     GET  /pdf/:id            the PDF itself (?download=1 to force a download)
     POST /send-email/:id     email the PDF to the supplier
     POST /share-link/:id     a 30-day link to the PDF + the WhatsApp text, for the phone
     GET  /shared/:token/:f   the PDF behind that link — no login, the token IS the key

   Email goes through the backend's own Gmail SMTP. WhatsApp can't be driven from here, so
   the screen opens WhatsApp itself (wa.me) with the link, or hands the PDF file to the
   phone's share sheet.
============================================================ */

const SHARE_DAYS = 30;
const SHARE_PURPOSE = "po-pdf";

/* digits only, with a country code: 9876543210 → 919876543210 */
function toWhatsappNumber(phone) {
  let d = String(phone || "").replace(/\D+/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  const cc = String(process.env.DEFAULT_COUNTRY_CODE || "91").replace(
    /\D+/g,
    "",
  );
  if (d.length === 10) d = cc + d;
  else if (d.length === 11 && d.startsWith("0")) d = cc + d.slice(1);
  return d.length >= 11 && d.length <= 15 ? d : null;
}

function publicBase(req) {
  const env = String(process.env.API_PUBLIC_URL || "")
    .trim()
    .replace(/\/+$/, "");
  return env || `${req.protocol}://${req.get("host")}`;
}

function findLogo(rel) {
  if (!rel) return null;
  const clean = String(rel)
    .replace(/^\/+/, "")
    .replace(/^Images[/\\]/i, "");
  const candidates = [
    path.join(process.cwd(), "Images", clean),
    path.join(__dirname, "..", "..", "Images", clean),
    String(rel),
  ];
  return (
    candidates.find((c) => {
      try {
        return fs.existsSync(c);
      } catch (_) {
        return false;
      }
    }) || null
  );
}

/* everything the PDF and the email need, for one order */
async function loadDocumentData(orderId, tenantAdminId) {
  const order = await fetchPurchaseWithItems(orderId, tenantAdminId);
  if (!order) return null;

  // A draft saved without a supplier has nobody to send to yet.
  const [supRows] = order.supplier_id
    ? await db.query(
        `SELECT * FROM pharmacy_suppliers WHERE id = ? AND admin_id = ? LIMIT 1`,
        [order.supplier_id, tenantAdminId],
      )
    : [[]];
  const [adminRows] = await db.query(
    `SELECT name, company_name, address, mobile, email, company_logo
       FROM admins WHERE id = ? LIMIT 1`,
    [tenantAdminId],
  );
  const a = adminRows[0] || {};
  return {
    order,
    noSupplier: !order.supplier_id,
    items: order.items,
    supplier: supRows[0] || { supplier_name: order.supplier_name },
    company: {
      name: a.company_name || a.name || "",
      address: a.address || "",
      phone: a.mobile || "",
      email: a.email || "",
    },
    logoPath: findLogo(a.company_logo),
  };
}

const NO_SUPPLIER_MSG = "Choose a supplier for this order first";

const makePdf = (d) =>
  buildPurchaseOrderPdf({
    order: d.order,
    items: d.items,
    supplier: d.supplier,
    company: d.company,
    logoPath: d.logoPath,
  });

/* Email one order to the address on its supplier. Never throws: the answer is the result. */
async function emailOrderToSupplier(orderId, tenantAdminId, overrides = {}) {
  try {
    const d = await loadDocumentData(orderId, tenantAdminId);
    if (!d) return { status: "failed", error: "Purchase order not found" };
    if (d.order.status === "cancelled")
      return { status: "failed", error: "This order is cancelled" };
    if (d.noSupplier) return { status: "no_supplier", error: NO_SUPPLIER_MSG };

    const to = overrides.to
      ? parseEmailList(overrides.to)
      : isValidEmail(d.supplier.email)
        ? [d.supplier.email.trim()]
        : null;
    if (!to)
      return {
        status: "no_email",
        error: overrides.to
          ? "That isn't a valid email address"
          : "The supplier has no email address on file",
      };

    const pdfBuffer = await makePdf(d);
    const sent = await sendPurchaseOrderEmail({
      to,
      cc: overrides.cc ? parseEmailList(overrides.cc) || [] : [],
      subject: overrides.subject,
      message: overrides.message,
      order: d.order,
      supplier: d.supplier,
      company: d.company,
      pdfBuffer,
      lineCount: d.items.length,
    });
    return { status: "sent", to: sent.to };
  } catch (err) {
    console.error("Email purchase order error:", err);
    return {
      status: "failed",
      error: err.message || "Couldn't send the email",
    };
  }
}

const SEND_PERMS = ["pharmacy.purchase.create", "pharmacy.purchase.edit"];

/* ---------- who it goes to, and the wording ---------- */
router.get(
  "/send-info/:id",
  authMiddleware,
  allowPermissions("pharmacy.purchase.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const d = await loadDocumentData(req.params.id, tenantAdminId);
      if (!d)
        return res
          .status(404)
          .json({ success: false, message: "Purchase order not found" });
      if (d.noSupplier)
        return res
          .status(409)
          .json({ success: false, message: NO_SUPPLIER_MSG });
      return res.json({
        success: true,
        data: {
          id: d.order.id,
          purchase_number: d.order.purchase_number,
          status: d.order.status,
          grand_total: d.order.grand_total,
          items_count: d.items.length,
          supplier: {
            id: d.supplier.id || d.order.supplier_id,
            name: d.supplier.supplier_name || d.order.supplier_name,
            contact_person: d.supplier.contact_person || null,
            email: d.supplier.email || null,
            phone: d.supplier.phone || null,
          },
          whatsapp_phone: toWhatsappNumber(d.supplier.phone),
          company_name: d.company.name,
          default_subject: defaultSubject(d.order, d.company),
          default_message: defaultMessage(d.order, d.supplier, d.company),
        },
      });
    } catch (err) {
      console.error("Send info error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load the sending details",
      });
    }
  },
);

/* ---------- the PDF ---------- */
router.get(
  "/pdf/:id",
  authMiddleware,
  allowPermissions("pharmacy.purchase.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const d = await loadDocumentData(req.params.id, tenantAdminId);
      if (!d)
        return res
          .status(404)
          .json({ success: false, message: "Purchase order not found" });
      // Every order can be downloaded — drafts without a supplier, received and cancelled ones
      // too. Downloading sends it to nobody; the routes that actually SEND still need a supplier.
      const pdf = await makePdf(d);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", pdf.length);
      res.setHeader(
        "Content-Disposition",
        `${req.query.download ? "attachment" : "inline"}; filename="${d.order.purchase_number}.pdf"`,
      );
      return res.send(pdf);
    } catch (err) {
      console.error("PO pdf error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to build the PDF" });
    }
  },
);

/* ---------- email it ---------- */
router.post(
  "/send-email/:id",
  authMiddleware,
  allowPermissions(...SEND_PERMS),
  async (req, res) => {
    const tenantAdminId = getTenantAdminId(req);
    const { to, cc, subject, message } = req.body || {};
    if (to !== undefined && to !== "" && !parseEmailList(to)) {
      return res
        .status(400)
        .json({ success: false, message: "That isn't a valid email address" });
    }
    if (cc && !parseEmailList(cc)) {
      return res.status(400).json({
        success: false,
        message: "One of the Cc addresses isn't valid",
      });
    }
    const r = await emailOrderToSupplier(req.params.id, tenantAdminId, {
      to: to || undefined,
      cc,
      subject,
      message,
    });
    if (r.status === "sent") {
      return res.json({
        success: true,
        message: `Sent to ${r.to.join(", ")}`,
        data: r,
      });
    }
    const code =
      r.status === "no_email"
        ? 400
        : r.status === "no_supplier"
          ? 409
          : /not found/i.test(r.error)
            ? 404
            : /cancelled/i.test(r.error)
              ? 409
              : 502;
    return res.status(code).json({ success: false, message: r.error, data: r });
  },
);

/* ---------- a link for WhatsApp ---------- */
router.post(
  "/share-link/:id",
  authMiddleware,
  allowPermissions("pharmacy.purchase.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const d = await loadDocumentData(req.params.id, tenantAdminId);
      if (!d)
        return res
          .status(404)
          .json({ success: false, message: "Purchase order not found" });
      if (d.order.status === "cancelled") {
        return res
          .status(409)
          .json({ success: false, message: "This order is cancelled" });
      }
      if (d.noSupplier)
        return res
          .status(409)
          .json({ success: false, message: NO_SUPPLIER_MSG });
      const token = jwt.sign(
        {
          purpose: SHARE_PURPOSE,
          po: Number(d.order.id),
          admin: Number(tenantAdminId),
        },
        process.env.JWT_SECRET,
        { expiresIn: `${SHARE_DAYS}d` },
      );
      const url = `${publicBase(req)}/api/pharmacy/purchase-orders/shared/${token}/${encodeURIComponent(d.order.purchase_number)}.pdf`;
      const who = d.supplier.contact_person || d.supplier.supplier_name || "";
      const message = [
        `Hello${who ? ` ${who}` : ""},`,
        "",
        `Purchase order ${d.order.purchase_number}${d.company.name ? ` from ${d.company.name}` : ""} — ${d.items.length} item${d.items.length === 1 ? "" : "s"}.`,
        ...(d.order.expected_delivery_date
          ? [
              `Receive by: ${new Date(d.order.expected_delivery_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`,
            ]
          : []),
        `PDF: ${url}`,
        "",
        "Please confirm the order and the receive-by date. Thank you.",
      ].join("\n");
      return res.json({
        success: true,
        data: {
          url,
          message,
          whatsapp_phone: toWhatsappNumber(d.supplier.phone),
          filename: `${d.order.purchase_number}.pdf`,
          expires_in_days: SHARE_DAYS,
        },
      });
    } catch (err) {
      console.error("Share link error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to make the link" });
    }
  },
);

/* ---------- the link opens here, signed in or not ---------- */
router.get("/shared/:token/:filename", async (req, res) => {
  try {
    let claims;
    try {
      claims = jwt.verify(req.params.token, process.env.JWT_SECRET);
    } catch (_) {
      return res
        .status(410)
        .send(
          "This link has expired or isn't valid. Ask the pharmacy to send it again.",
        );
    }
    if (
      !claims ||
      claims.purpose !== SHARE_PURPOSE ||
      !claims.po ||
      !claims.admin
    ) {
      return res
        .status(410)
        .send(
          "This link has expired or isn't valid. Ask the pharmacy to send it again.",
        );
    }
    const d = await loadDocumentData(claims.po, claims.admin);
    if (!d || d.noSupplier || d.order.status === "cancelled") {
      return res
        .status(404)
        .send("This purchase order is no longer available.");
    }
    const pdf = await makePdf(d);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdf.length);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${d.order.purchase_number}.pdf"`,
    );
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.send(pdf);
  } catch (err) {
    console.error("Shared PO pdf error:", err);
    return res.status(500).send("Couldn't open the purchase order.");
  }
});

/* ============================================================
   GENERATE PURCHASE ORDERS

   Two ways in, one way out:

     GET  /auto-preview     "normal": what is low or out of stock right now
     GET  /sales-preview    "sale based": what the till says you will run out of
     GET  /medicine-search  add anything by hand, whichever mode you are in
     GET  /suppliers        active suppliers (filters + the "move to" picker)
     POST /auto-generate    turn the (edited) suggestions into real POs,
                            one per supplier, as drafts or as sent orders

   Both previews answer in the same shape, so the screen renders them with
   the same code:
     { groups:[{supplier_id, supplier_name, supplier_inactive, supplier_missing, lines}],
       unassigned:{lines}, notes:[], summary:{...} }

   EVERYTHING HERE IS IN STRIPS. Stock is kept in tablets, so a batch counts
   floor(tablets ÷ its tablets per strip) whole strips; reorder_level and
   maximum_stock are strips; on_order is strips on draft / ordered POs; sales are
   read line by line (readSaleLine — strip, tablet, old POS, old B2B) as tablets
   and turned into strips with the medicine's tablets per strip.

   BRANCH: stock, sales and on-order are counted for ONE branch — staff: their
   own; the admin of a multi-branch pharmacy must pick one (?branch=…, 400
   "Choose the branch first." otherwise). The new POs deliver to that branch.

   Nothing here changes stock. A PO is a promise to buy; stock moves when the
   goods are received.
============================================================ */

const DEFAULT_REORDER_LEVEL = 10; // used when a medicine has no reorder level set (strips)
// a sale counts unless it never happened (draft / cancelled) or was given back whole
const NOT_SOLD = ["draft", "cancelled", "returned"];

const round1 = (n) => Math.round((Number(n) + Number.EPSILON) * 10) / 10;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const toInt = (v, fallback, min, max) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

function medicineLabel(m) {
  return (
    [m.brand_name || m.medicine_name, m.strength].filter(Boolean).join(" ") ||
    m.medicine_name ||
    `Medicine #${m.medicine_id}`
  );
}

/* Whole strips (and the tablets behind them) per medicine, in this branch: active, unexpired batches. */
async function stockByMedicine(q, tenantAdminId, scope, ids = null) {
  const f = batchFilter(scope, "b");
  const [rows] = await q.query(
    `SELECT b.medicine_id,
            SUM(CASE WHEN b.status = 'active' AND b.expiry_date >= CURDATE()
                     THEN FLOOR(b.quantity_available / GREATEST(b.units_per_pack, 1)) ELSE 0 END) AS stock_strips,
            SUM(CASE WHEN b.status = 'active' AND b.expiry_date >= CURDATE()
                     THEN b.quantity_available ELSE 0 END) AS stock_tablets,
            COUNT(*) AS batches
       FROM pharmacy_medicine_batches b
      WHERE b.admin_id = ? ${f.sql} ${ids ? "AND b.medicine_id IN (?)" : ""}
      GROUP BY b.medicine_id`,
    [tenantAdminId, ...f.params, ...(ids ? [ids] : [])],
  );
  return rows;
}

/* Strips already on a draft / placed PO for this branch — don't order them twice. */
async function onOrderByMedicine(q, tenantAdminId, scope, ids = null) {
  const branchSql =
    scope && scope.filter ? "AND LOWER(TRIM(o.branch)) = ?" : "";
  const [rows] = await q.query(
    `SELECT i.medicine_id, SUM(i.quantity) AS on_order
       FROM pharmacy_purchase_items i
       JOIN pharmacy_purchase_orders o ON o.id = i.purchase_id
      WHERE o.admin_id = ? AND o.status IN ('draft', 'ordered') ${branchSql}
            ${ids ? "AND i.medicine_id IN (?)" : ""}
      GROUP BY i.medicine_id`,
    [tenantAdminId, ...(branchSql ? [scope.key] : []), ...(ids ? [ids] : [])],
  );
  return rows;
}

/* ------------------------------------------------------------
   Read everything a preview needs. Each query is small and
   tenant-scoped; the arithmetic happens in buildSuggestions so it
   reads top to bottom and can be tested without a database.
------------------------------------------------------------ */
async function loadPreviewData(tenantAdminId, { withSales, days, scope }) {
  const [medicines] = await db.query(
    `SELECT m.id AS medicine_id, m.medicine_code, m.gst_percentage,
            m.purchase_price, m.selling_price, m.reorder_level, m.maximum_stock,
            m.units_per_pack, m.pack_size, m.unit,
            md.medicine_name, md.brand_name, md.generic_name,
            md.dosage_form, md.strength
       FROM pharmacy_medicines m
       JOIN medicine_data md ON md.id = m.medicine_data_id
      WHERE m.admin_id = ? AND m.status = 'active'`,
    [tenantAdminId],
  );

  // Sellable stock = active, unexpired batches. batches counts every batch ever
  // received, so we can tell "never stocked" from "sold out".
  const stockRows = await stockByMedicine(db, tenantAdminId, scope);
  const onOrderRows = await onOrderByMedicine(db, tenantAdminId, scope);

  // The newest real purchase per medicine: its price (per strip), MRP, GST and supplier.
  const [lastBuyRows] = await db.query(
    `SELECT i.medicine_id, i.purchase_price, i.mrp, i.gst_percentage,
            o.supplier_id, o.purchase_date
       FROM pharmacy_purchase_items i
       JOIN pharmacy_purchase_orders o ON o.id = i.purchase_id
      WHERE i.id IN (
              SELECT MAX(i2.id)
                FROM pharmacy_purchase_items i2
                JOIN pharmacy_purchase_orders o2 ON o2.id = i2.purchase_id
               WHERE o2.admin_id = ? AND o2.status IN ('ordered', 'received')
               GROUP BY i2.medicine_id)`,
    [tenantAdminId],
  );

  // Where a medicine came from when no PO says so (opening stock, direct entry).
  const [batchSupRows] = await db.query(
    `SELECT medicine_id, supplier_id, mrp, purchase_price
       FROM pharmacy_medicine_batches
      WHERE id IN (
              SELECT MAX(id) FROM pharmacy_medicine_batches
               WHERE admin_id = ? AND supplier_id IS NOT NULL
               GROUP BY medicine_id)`,
    [tenantAdminId],
  );

  const [suppliers] = await db.query(
    `SELECT id, supplier_name, status FROM pharmacy_suppliers WHERE admin_id = ?`,
    [tenantAdminId],
  );

  // Sold, in TABLETS, per medicine — every line read the way it was sold (strip / tablet,
  // old POS lines = strips, old B2B lines = tablets). An old sale with no branch counts for
  // the branch of the batch it came out of.
  const soldRows = [];
  if (withSales) {
    const branchSql =
      scope && scope.filter
        ? "AND LOWER(TRIM(COALESCE(NULLIF(TRIM(s.branch), ''), b.branch))) = ?"
        : "";
    const [lines] = await db.query(
      `SELECT si.medicine_id, si.quantity, si.sale_unit, si.units_per_pack, si.tablets,
              LEFT(s.notes, 16) AS notes, b.units_per_pack AS batch_upp, b.id AS batch_id
         FROM pharmacy_sale_items si
         JOIN pharmacy_sales s ON s.id = si.sale_id
         LEFT JOIN pharmacy_medicine_batches b ON b.id = si.batch_id
        WHERE s.admin_id = ?
          AND s.status NOT IN (?)
          AND s.sale_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ${branchSql}`,
      [tenantAdminId, NOT_SOLD, days, ...(branchSql ? [scope.key] : [])],
    );
    const sum = new Map();
    for (const l of lines) {
      const read = readSaleLine(
        l,
        { notes: l.notes },
        l.batch_id ? { units_per_pack: l.batch_upp } : null,
      );
      const id = Number(l.medicine_id);
      sum.set(id, (sum.get(id) || 0) + (Number(read.tablets) || 0));
    }
    for (const [medicine_id, tablets] of sum)
      soldRows.push({ medicine_id, sold_tablets: tablets });
  }

  return {
    medicines,
    stockRows,
    onOrderRows,
    lastBuyRows,
    batchSupRows,
    suppliers,
    soldRows,
  };
}

/* What a line says about the medicine's pack and its stock — the same on every screen. */
function packFacts(m, stockStrips, stockTablets) {
  const upp = unitsPerPack(m);
  const word = packWord(m, upp);
  return {
    units_per_pack: upp,
    pack_size: m.pack_size || null,
    pack_word: word,
    current_stock: stockStrips, // whole strips
    stock_tablets: stockTablets,
    stock_text: describeStock(stockTablets, upp, word),
  };
}

/* ------------------------------------------------------------
   The arithmetic — in strips.

   normal      low when stock <= reorder level; order back up to the maximum
               stock (or twice the reorder level when no maximum is set).
   sales       order enough to cover `coverDays` of what sold over the last
               `days` days (tablets sold ÷ tablets per strip = strips).
   Either way:  suggested = target - stock - already on order  (never < 0)
------------------------------------------------------------ */
function buildSuggestions(
  data,
  { mode, days = 30, coverDays = 15, branch = null },
) {
  const stockOf = new Map(
    data.stockRows.map((r) => [Number(r.medicine_id), r]),
  );
  const onOrderOf = new Map(
    data.onOrderRows.map((r) => [
      Number(r.medicine_id),
      Number(r.on_order) || 0,
    ]),
  );
  const lastBuyOf = new Map(
    data.lastBuyRows.map((r) => [Number(r.medicine_id), r]),
  );
  const batchSupOf = new Map(
    data.batchSupRows.map((r) => [Number(r.medicine_id), r]),
  );
  const soldOf = new Map(
    data.soldRows.map((r) => [
      Number(r.medicine_id),
      Number(r.sold_tablets) || 0,
    ]),
  );
  const supplierOf = new Map(data.suppliers.map((s) => [Number(s.id), s]));

  const lines = [];
  let alreadyCovered = 0;
  let defaultLevelUsed = 0;
  let checked = 0;

  for (const m of data.medicines) {
    const id = Number(m.medicine_id);
    const st = stockOf.get(id);
    const stock = st ? Math.max(0, Number(st.stock_strips) || 0) : 0;
    const stockTablets = st ? Math.max(0, Number(st.stock_tablets) || 0) : 0;
    const everStocked = !!(st && Number(st.batches) > 0);
    const onOrder = onOrderOf.get(id) || 0;
    const level =
      Number(m.reorder_level) > 0
        ? Number(m.reorder_level)
        : DEFAULT_REORDER_LEVEL;
    const levelIsDefault = !(Number(m.reorder_level) > 0);
    const upp = unitsPerPack(m);

    let suggested = 0;
    let extra = {};

    if (mode === "sales") {
      const soldTablets = soldOf.get(id) || 0;
      if (soldTablets <= 0) continue;
      checked += 1;
      const soldStrips = soldTablets / upp;
      const perDay = soldStrips / days;
      suggested = Math.max(0, Math.ceil(perDay * coverDays) - stock - onOrder);
      extra = {
        sold_qty: round1(soldStrips), // strips (a tablet sale is part of a strip)
        sold_tablets: soldTablets,
        avg_daily: round2(perDay), // strips a day
        days_left: perDay > 0 ? Math.floor(stockTablets / upp / perDay) : null,
        cover_days: coverDays,
      };
    } else {
      // a medicine nobody ever stocked and nobody set a level for is just catalogue
      if (levelIsDefault && !everStocked) continue;
      checked += 1;
      if (stock > level) continue;
      const max =
        Number(m.maximum_stock) > level ? Number(m.maximum_stock) : level * 2;
      suggested = Math.max(0, max - stock - onOrder);
      if (levelIsDefault) defaultLevelUsed += 1;
    }

    if (suggested <= 0) {
      if (onOrder > 0) alreadyCovered += 1;
      continue;
    }

    const lastBuy = lastBuyOf.get(id);
    const batchSup = batchSupOf.get(id);
    const supplierId = lastBuy?.supplier_id ?? batchSup?.supplier_id ?? null;
    // every price here is PER STRIP (PO lines, batches and the catalog all keep strip prices)
    const price =
      Number(lastBuy?.purchase_price) > 0
        ? Number(lastBuy.purchase_price)
        : Number(batchSup?.purchase_price) > 0
          ? Number(batchSup.purchase_price)
          : Number(m.purchase_price) || 0;
    const mrp =
      Number(lastBuy?.mrp) > 0
        ? Number(lastBuy.mrp)
        : Number(batchSup?.mrp) > 0
          ? Number(batchSup.mrp)
          : 0;

    lines.push({
      medicine_id: id,
      medicine: medicineLabel(m),
      dosage_form: m.dosage_form || null,
      medicine_code: m.medicine_code || null,
      ...packFacts(m, stock, stockTablets),
      reorder_level: level,
      reorder_level_is_default: levelIsDefault,
      on_order: onOrder,
      stock_status: stock <= 0 ? "out_of_stock" : "low",
      suggested_quantity: suggested,
      last_purchase_date: lastBuy?.purchase_date || null,
      purchase_price: round2(price),
      gst_percentage: Number(lastBuy?.gst_percentage ?? m.gst_percentage) || 0,
      mrp: round2(mrp),
      supplier_id: supplierId,
      ...extra,
    });
  }

  lines.sort(
    (a, b) =>
      (a.stock_status === "out_of_stock" ? 0 : 1) -
        (b.stock_status === "out_of_stock" ? 0 : 1) ||
      (a.days_left ?? 1e9) - (b.days_left ?? 1e9) ||
      a.medicine.localeCompare(b.medicine),
  );

  // ---- bucket by supplier ----
  const groupsById = new Map();
  const unassigned = { lines: [] };
  const notes = [];

  for (const line of lines) {
    const sid = line.supplier_id;
    delete line.supplier_id;
    if (sid == null) {
      unassigned.lines.push(line);
      continue;
    }
    if (!groupsById.has(sid)) {
      const sup = supplierOf.get(Number(sid));
      groupsById.set(sid, {
        supplier_id: Number(sid),
        supplier_name: sup ? sup.supplier_name : "Unknown supplier",
        supplier_inactive: !!sup && sup.status !== "active",
        supplier_missing: !sup,
        lines: [],
      });
    }
    groupsById.get(sid).lines.push(line);
  }

  const groups = [...groupsById.values()].sort((a, b) =>
    a.supplier_name.localeCompare(b.supplier_name),
  );

  if (unassigned.lines.length) {
    notes.push(
      `${unassigned.lines.length} medicine${unassigned.lines.length === 1 ? " has" : "s have"} never been bought from anyone, so pick a supplier for ${unassigned.lines.length === 1 ? "it" : "them"}.`,
    );
  }
  for (const g of groups) {
    if (g.supplier_inactive)
      notes.push(
        `${g.supplier_name} is marked inactive — move those medicines to another supplier or reactivate them.`,
      );
    if (g.supplier_missing)
      notes.push(
        `A supplier these medicines came from no longer exists — move them to another supplier.`,
      );
  }
  if (mode !== "sales" && defaultLevelUsed) {
    notes.push(
      `${defaultLevelUsed} medicine${defaultLevelUsed === 1 ? " has" : "s have"} no reorder level set, so ${DEFAULT_REORDER_LEVEL} strips was assumed. Set real levels on the medicines for better suggestions.`,
    );
  }

  const all = [...groups.flatMap((g) => g.lines), ...unassigned.lines];
  return {
    groups,
    unassigned,
    notes,
    summary: {
      mode: mode === "sales" ? "sales" : "normal",
      branch,
      unit: "strip",
      medicines_checked: checked,
      lines: all.length,
      suppliers: groups.length,
      out_of_stock: all.filter((l) => l.stock_status === "out_of_stock").length,
      low: all.filter((l) => l.stock_status === "low").length,
      already_on_order: alreadyCovered,
      ...(mode === "sales" ? { days, cover_days: coverDays } : {}),
    },
  };
}

/* ---------- NORMAL: low and out-of-stock ----------
   Query: branch (admin of a multi-branch pharmacy — required there) */
router.get(
  "/auto-preview",
  authMiddleware,
  allowPermissions("pharmacy.purchase.generate_create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const scope = await resolveScope(db, req, {
        wanted: req.query.branch,
        forWrite: true,
      });
      const data = await loadPreviewData(tenantAdminId, {
        withSales: false,
        scope,
      });
      return res.json({
        success: true,
        data: buildSuggestions(data, { mode: "normal", branch: scope.branch }),
      });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("Auto preview error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to work out what to reorder",
      });
    }
  },
);

/* ---------- SALE BASED: what sold, and how long stock will last ----------
   Query: days (1-365, default 30)       how far back to look at sales
          cover_days (1-180, default 15) how many days the order should last
          branch                         (admin of a multi-branch pharmacy — required there) */
router.get(
  "/sales-preview",
  authMiddleware,
  allowPermissions("pharmacy.purchase.salebased_create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const days = toInt(req.query.days, 30, 1, 365);
      const coverDays = toInt(req.query.cover_days, 15, 1, 180);
      const scope = await resolveScope(db, req, {
        wanted: req.query.branch,
        forWrite: true,
      });
      const data = await loadPreviewData(tenantAdminId, {
        withSales: true,
        days,
        scope,
      });
      return res.json({
        success: true,
        data: buildSuggestions(data, {
          mode: "sales",
          days,
          coverDays,
          branch: scope.branch,
        }),
      });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("Sales preview error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to work out what to reorder from sales",
      });
    }
  },
);

/* ---------- active suppliers ---------- */
router.get(
  "/suppliers",
  authMiddleware,
  	allowPermissions(...GENERATE_PERMS),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const [rows] = await db.query(
        `SELECT id, supplier_name FROM pharmacy_suppliers
          WHERE admin_id = ? AND status = 'active'
          ORDER BY supplier_name ASC`,
        [tenantAdminId],
      );
      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("List suppliers error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to load suppliers" });
    }
  },
);

/* ---------- catalogue search, for "Add a medicine" (stock in strips, for the branch) ---------- */
router.get(
  "/medicine-search",
  authMiddleware,
	allowPermissions(...GENERATE_PERMS),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const q = String(req.query.q || "").trim();
      const limit = toInt(req.query.limit, 25, 1, 50);
      if (!q) return res.json({ success: true, data: [] });
      const scope = await resolveScope(db, req, {
        wanted: req.query.branch,
        forWrite: true,
      });

      const like = `%${q}%`;
      const [meds] = await db.query(
        `SELECT m.id AS medicine_id, m.medicine_code, m.gst_percentage,
                m.purchase_price, m.reorder_level, m.maximum_stock,
                m.units_per_pack, m.pack_size, m.unit,
                md.medicine_name, md.brand_name, md.generic_name,
                md.dosage_form, md.strength
           FROM pharmacy_medicines m
           JOIN medicine_data md ON md.id = m.medicine_data_id
          WHERE m.admin_id = ? AND m.status = 'active'
            AND (md.medicine_name LIKE ? OR md.brand_name LIKE ?
                 OR md.generic_name LIKE ? OR m.medicine_code LIKE ?)
          ORDER BY md.medicine_name ASC
          LIMIT ?`,
        [tenantAdminId, like, like, like, like, limit],
      );
      if (!meds.length) return res.json({ success: true, data: [] });

      const ids = meds.map((m) => m.medicine_id);
      const stockRows = await stockByMedicine(db, tenantAdminId, scope, ids);
      const onOrderRows = await onOrderByMedicine(
        db,
        tenantAdminId,
        scope,
        ids,
      );
      const [lastBuyRows] = await db.query(
        `SELECT i.medicine_id, i.purchase_price, i.mrp, i.gst_percentage,
                o.supplier_id, s.supplier_name
           FROM pharmacy_purchase_items i
           JOIN pharmacy_purchase_orders o ON o.id = i.purchase_id
           LEFT JOIN pharmacy_suppliers s ON s.id = o.supplier_id
          WHERE i.id IN (
                  SELECT MAX(i2.id)
                    FROM pharmacy_purchase_items i2
                    JOIN pharmacy_purchase_orders o2 ON o2.id = i2.purchase_id
                   WHERE o2.admin_id = ? AND o2.status IN ('ordered', 'received')
                     AND i2.medicine_id IN (?)
                   GROUP BY i2.medicine_id)`,
        [tenantAdminId, ids],
      );

      const stockOf = new Map(stockRows.map((r) => [Number(r.medicine_id), r]));
      const onOrderOf = new Map(
        onOrderRows.map((r) => [
          Number(r.medicine_id),
          Number(r.on_order) || 0,
        ]),
      );
      const lastOf = new Map(
        lastBuyRows.map((r) => [Number(r.medicine_id), r]),
      );

      const data = meds.map((m) => {
        const id = Number(m.medicine_id);
        const st = stockOf.get(id);
        const stock = st ? Number(st.stock_strips) || 0 : 0;
        const onOrder = onOrderOf.get(id) || 0;
        const last = lastOf.get(id);
        const level =
          Number(m.reorder_level) > 0
            ? Number(m.reorder_level)
            : DEFAULT_REORDER_LEVEL;
        const max =
          Number(m.maximum_stock) > level ? Number(m.maximum_stock) : level * 2;
        return {
          medicine_id: id,
          medicine: medicineLabel(m),
          dosage_form: m.dosage_form || null,
          medicine_code: m.medicine_code || null,
          ...packFacts(m, stock, st ? Number(st.stock_tablets) || 0 : 0),
          reorder_level: level,
          reorder_level_is_default: !(Number(m.reorder_level) > 0),
          on_order: onOrder,
          stock_status:
            stock <= 0 ? "out_of_stock" : stock <= level ? "low" : "ok",
          suggested_quantity: Math.max(0, max - stock - onOrder),
          last_supplier_id: last ? Number(last.supplier_id) : null,
          last_supplier_name: last ? last.supplier_name : null,
          purchase_price: round2(
            Number(last?.purchase_price) > 0
              ? last.purchase_price
              : m.purchase_price,
          ),
          gst_percentage: Number(last?.gst_percentage ?? m.gst_percentage) || 0,
          mrp: round2(last?.mrp),
        };
      });

      return res.json({ success: true, data });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("Medicine search error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to search medicines" });
    }
  },
);

/* ------------------------------------------------------------
   Next PO number for a tenant: PO-<year>-<4 digits>.
   Called while holding the tenant's number lock, so two people
   generating at once can't be handed the same number.
------------------------------------------------------------ */
/* Generate PO number: PO-YYYYMM-0001 */
async function nextPoSequence(conn, tenantAdminId, yearMonth) {
  const prefix = `PO-${yearMonth}-`;

  const [rows] = await conn.query(
    `SELECT purchase_number
       FROM pharmacy_purchase_orders
      WHERE admin_id = ?
        AND purchase_number LIKE ?`,
    [tenantAdminId, `${prefix}%`],
  );

  let max = 0;

  for (const row of rows) {
    const tail = String(row.purchase_number).slice(prefix.length);

    if (/^\d+$/.test(tail)) {
      max = Math.max(max, Number(tail));
    }
  }

  return { prefix, next: max + 1 };
}

/* ---------- GENERATE ----------
   Body: { status: 'draft'|'ordered',
           branch?,                 deliver-to (admin of a multi-branch pharmacy: required; staff: their own)
           order_type?: 'out_of_stock'|'new_order',
           expected_delivery_date?, notes?,
           groups:[{ supplier_id, items:[{medicine_id, quantity (strips), purchase_price (per strip), gst_percentage, mrp (per strip)}] }] }
   Each line snapshots the medicine's tablets per strip (units_per_pack) and its selling
   price PER STRIP — never a per-tablet figure.
   One PO per supplier. A group that can't be made (unknown or inactive
   supplier, bad line) is skipped and reported; the rest still go through. */



router.post(
  "/auto-generate",
  authMiddleware,
  generateGate,
  async (req, res) => {
    const conn = await db.getConnection();
    let lockName = null;
    try {
      const tenantAdminId = getTenantAdminId(req);
      const {
        status = "draft",
        order_type = "out_of_stock",
        notes,
        send_email,
        groups,
      } = req.body || {};

      // "Receive by": the date the supplier is asked to deliver. Optional, YYYY-MM-DD.
      let expected_delivery_date = null;
      const rawReceiveBy = req.body && req.body.expected_delivery_date;
      if (
        rawReceiveBy !== undefined &&
        rawReceiveBy !== null &&
        String(rawReceiveBy).trim() !== ""
      ) {
        const v = String(rawReceiveBy).trim().slice(0, 10);
        const t = /^\d{4}-\d{2}-\d{2}$/.test(v)
          ? new Date(`${v}T00:00:00Z`)
          : null;
        if (
          !t ||
          Number.isNaN(t.getTime()) ||
          t.toISOString().slice(0, 10) !== v
        ) {
          return res.status(400).json({
            success: false,
            message: "Receive-by date must be a valid date (YYYY-MM-DD)",
          });
        }
        expected_delivery_date = v;
      }

      if (!["draft", "ordered"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "status must be 'draft' or 'ordered'",
        });
      }
      if (!VALID_ORDER_TYPE.includes(order_type)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid order_type" });
      }
      if (!Array.isArray(groups) || groups.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "Nothing to order" });
      }

      // ---- shape-check every group before touching the database ----
      const skipped = [];
      const clean = [];
      for (const g of groups) {
        const sid = Number(g && g.supplier_id) || 0;
        // A list with no supplier is a legitimate DRAFT (pick the supplier later, from
        // the order). It can never be placed: nobody would receive it.
        if (!sid && status !== "draft") {
          skipped.push({
            supplier_id: null,
            reason:
              "Choose a supplier before placing an order — or save this list as a draft",
          });
          continue;
        }
        const merged = new Map(); // one line per medicine
        let bad = null;
        for (const it of Array.isArray(g.items) ? g.items : []) {
          const mid = Number(it && it.medicine_id);
          const qty = Number(it && it.quantity);
          const price =
            it.purchase_price === undefined || it.purchase_price === ""
              ? 0
              : Number(it.purchase_price);
          const gst =
            it.gst_percentage === undefined || it.gst_percentage === ""
              ? 0
              : Number(it.gst_percentage);
          const mrp =
            it.mrp === undefined || it.mrp === "" ? 0 : Number(it.mrp);
          if (!mid) {
            bad = "A line has no medicine";
            break;
          }
          if (!Number.isInteger(qty) || qty <= 0) {
            bad = "Quantities must be whole numbers above zero";
            break;
          }
          if (!Number.isFinite(price) || price < 0) {
            bad = "A rate is not a valid amount";
            break;
          }
          if (!Number.isFinite(gst) || gst < 0 || gst > 100) {
            bad = "GST must be between 0 and 100";
            break;
          }
          if (!Number.isFinite(mrp) || mrp < 0) {
            bad = "An MRP is not a valid amount";
            break;
          }
          const prev = merged.get(mid);
          if (prev) prev.quantity += qty;
          else
            merged.set(mid, {
              medicine_id: mid,
              quantity: qty,
              purchase_price: price,
              gst_percentage: gst,
              mrp,
            });
        }
        if (bad) {
          skipped.push({ supplier_id: sid, reason: bad });
          continue;
        }
        if (!merged.size) {
          skipped.push({
            supplier_id: sid,
            reason: "No medicines on this order",
          });
          continue;
        }
        clean.push({ supplier_id: sid || null, items: [...merged.values()] });
      }

      if (!clean.length) {
        return res.status(400).json({
          success: false,
          message:
            skipped.map((s) => s.reason).join("; ") || "Nothing to order",
          summary: { created: 0, skipped },
        });
      }

      // deliver-to branch (asked before a number is taken)
      const scope = await resolveScope(conn, req, {
        wanted: req.body && req.body.branch,
        forWrite: true,
      });

      // ---- numbers for this tenant are handed out one request at a time ----
      lockName = `po_number_${tenantAdminId}`;
      const [[lk]] = await conn.query(`SELECT GET_LOCK(?, 10) AS got`, [
        lockName,
      ]);
      if (!lk || Number(lk.got) !== 1) {
        lockName = null;
        return res.status(503).json({
          success: false,
          message: "Another order is being numbered — try again in a moment",
        });
      }

      await conn.beginTransaction();

      const wantedSuppliers = [
        ...new Set(clean.map((g) => g.supplier_id).filter(Boolean)),
      ];
      const [supRows] = wantedSuppliers.length
        ? await conn.query(
            `SELECT id, supplier_name, status FROM pharmacy_suppliers
              WHERE admin_id = ? AND id IN (?)`,
            [tenantAdminId, wantedSuppliers],
          )
        : [[]];
      const supplierOf = new Map(supRows.map((s) => [Number(s.id), s]));

      const [medRows] = await conn.query(
        `SELECT id, selling_price, units_per_pack, pack_size FROM pharmacy_medicines
          WHERE admin_id = ? AND id IN (?)`,
        [
          tenantAdminId,
          [...new Set(clean.flatMap((g) => g.items.map((i) => i.medicine_id)))],
        ],
      );
      const medicineOf = new Map(medRows.map((m) => [Number(m.id), m]));

      const now = new Date();

      const yearMonth = `${now.getFullYear()}${String(
        now.getMonth() + 1,
      ).padStart(2, "0")}`;

      let { prefix, next } = await nextPoSequence(
        conn,
        tenantAdminId,
        yearMonth,
      );
      const created = [];
      for (const g of clean) {
        const sup = g.supplier_id ? supplierOf.get(g.supplier_id) : null;
        if (g.supplier_id && !sup) {
          skipped.push({
            supplier_id: g.supplier_id,
            reason: "Supplier not found",
          });
          continue;
        }
        if (sup && sup.status !== "active") {
          skipped.push({
            supplier_id: g.supplier_id,
            reason: `${sup.supplier_name} is inactive`,
          });
          continue;
        }
        if (g.items.some((i) => !medicineOf.has(i.medicine_id))) {
          skipped.push({
            supplier_id: g.supplier_id,
            reason: `A medicine on the ${sup ? sup.supplier_name : "no-supplier"} list no longer exists`,
          });
          continue;
        }

        let subtotal = 0;
        let tax = 0;
        const lines = g.items.map((i) => {
          const base = round2(i.quantity * i.purchase_price);
          const t = round2((base * i.gst_percentage) / 100);
          subtotal += base;
          tax += t;
          const med = medicineOf.get(i.medicine_id);
          return {
            ...i,
            tax_amount: t,
            total_amount: round2(base + t),
            selling_price: Number(med.selling_price) || 0, // per strip, as the catalog keeps it
            units_per_pack: unitsPerPack(med),
          };
        });
        subtotal = round2(subtotal);
        tax = round2(tax);
        const grand = round2(subtotal + tax);

        const number = `${prefix}${String(next).padStart(4, "0")}`;
        next += 1;

        const [ins] = await conn.query(
          `INSERT INTO pharmacy_purchase_orders
             (admin_id, branch, supplier_id, purchase_number, purchase_date, order_type,
              expected_delivery_date, ordered_at,
              subtotal, discount_amount, tax_amount, other_charges, grand_total,
              paid_amount, due_amount, payment_status, status, notes)
           VALUES (?, ?, ?, ?, NOW(), ?, ?, ${status === "ordered" ? "NOW()" : "NULL"},
                   ?, 0, ?, 0, ?, 0, ?, 'unpaid', ?, ?)`,
          [
            tenantAdminId,
            scope.branch || null,
            g.supplier_id,
            number,
            order_type,
            expected_delivery_date || null,
            subtotal,
            tax,
            grand,
            grand,
            status,
            notes ? String(notes).trim() : null,
          ],
        );

        for (const l of lines) {
          await insertItem(conn, ins.insertId, {
            medicine_id: l.medicine_id,
            quantity: l.quantity,
            units_per_pack: l.units_per_pack,
            purchase_price: l.purchase_price,
            mrp: l.mrp,
            selling_price: l.selling_price,
            gst_percentage: l.gst_percentage,
            tax_amount: l.tax_amount,
            total_amount: l.total_amount,
          });
        }

        created.push({
          id: ins.insertId,
          purchase_number: number,
          supplier_id: g.supplier_id,
          supplier_name: sup ? sup.supplier_name : null,
          branch: scope.branch || null,
          status,
          order_type,
          grand_total: grand,
          items: lines.map((l) => ({
            medicine_id: l.medicine_id,
            quantity: l.quantity,
            units_per_pack: l.units_per_pack,
          })),
        });
      }

      if (!created.length) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: skipped.map((s) => s.reason).join("; "),
          summary: { created: 0, skipped },
        });
      }

      await conn.commit();

      // The numbers are handed out; free the lock before anything slow (SMTP) happens.
      if (lockName) {
        await conn.query(`SELECT RELEASE_LOCK(?)`, [lockName]).catch(() => {});
        lockName = null;
      }

      // Optional: email each supplier its PDF. Orders are already saved, so a mail that
      // can't go (no address, SMTP down) is reported per order and never undoes them.
      let emailed = 0;
      if (send_email === true) {
        for (const o of created) {
          if (!o.supplier_id) {
            o.email = {
              status: "no_supplier",
              error: "No supplier chosen yet",
            };
            continue;
          }
          o.email = await emailOrderToSupplier(o.id, tenantAdminId);
          if (o.email.status === "sent") emailed += 1;
        }
      }

      const word = status === "ordered" ? "placed" : "saved as draft";
      return res.status(201).json({
        success: true,
        message:
          `${created.length} purchase order${created.length === 1 ? "" : "s"} ${word}` +
          (send_email === true ? ` — ${emailed} emailed` : ""),
        data: created,
        summary: {
          created: created.length,
          skipped,
          ...(send_email === true ? { emailed } : {}),
        },
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (sendBranchError(res, err)) return;
      console.error("Auto generate purchase orders error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to generate purchase orders",
      });
    } finally {
      if (lockName)
        await conn.query(`SELECT RELEASE_LOCK(?)`, [lockName]).catch(() => {});
      conn.release();
    }
  },
);

module.exports = router;
