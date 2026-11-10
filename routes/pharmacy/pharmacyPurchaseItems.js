// routes/pharmacy/purchase-items.js

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
const { unitsPerPack, cleanUnitsPerPack } = require("../../utils/pharmacyUnits");

/* ============================================================
   COMPANION FILE to purchase-orders.js.

   Line items live under a purchase order. In most flows you
   want the parent's POST / PUT endpoints, which manage items
   in bulk. This file exists for the case where you're editing
   a single row on a draft PO ("add row", "remove row", "fix qty").

   Rules enforced by every write here:
     1. The parent PO must exist and belong to the caller's tenant
     2. The parent PO must be in status='draft'
        (received / cancelled orders are locked — corrections go
         via purchase_return / stock adjustment transactions)
     3. Tenant scoping is done via JOIN on the parent PO's admin_id,
        since pharmacy_purchase_items has no admin_id column.

   Units: quantity / free_quantity are STRIPS, prices are per strip.
   units_per_pack (tablets in one strip) is a snapshot on the line: sent
   with the line, or taken from the medicine when the line is added.

   NOT DONE AUTOMATICALLY:
     - Parent PO's subtotal / grand_total is NOT recomputed here.
       After item writes, refresh the parent via
       PUT /pharmacy/purchase-orders/update/:id or the header
       numbers will be stale.
============================================================ */

/* ============================================================
   Helper: resolve tenant admin_id from req.user
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

/* ============================================================
   Helper: validate item fields
   requireAll=true → create mode (medicine_id, batch_number,
   expiry_date, quantity>0 all required)
   requireAll=false → update mode (only validate fields present)
============================================================ */
function validateItemFields(item, { requireAll = true } = {}) {
  if (requireAll) {
    if (!item.medicine_id)
      return { ok: false, message: "medicine_id is required" };
    if (!item.batch_number || !String(item.batch_number).trim())
      return { ok: false, message: "batch_number is required" };
    if (!item.expiry_date)
      return { ok: false, message: "expiry_date is required" };

    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty <= 0)
      return { ok: false, message: "quantity must be > 0" };
  } else {
    if (item.batch_number !== undefined && !String(item.batch_number).trim())
      return { ok: false, message: "batch_number cannot be empty" };
    if (item.quantity !== undefined) {
      const qty = Number(item.quantity);
      if (!Number.isFinite(qty) || qty <= 0)
        return { ok: false, message: "quantity must be > 0" };
    }
  }

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
          message: `${field} must be a non-negative number`,
        };
      }
    }
  }

  if (
    item.gst_percentage !== undefined &&
    Number(item.gst_percentage) > 100
  ) {
    return { ok: false, message: "gst_percentage cannot exceed 100" };
  }

  try {
    cleanUnitsPerPack(item.units_per_pack);
  } catch (e) {
    return { ok: false, message: e.message };
  }

  return { ok: true };
}

/* ============================================================
   Helper: verify parent PO exists, belongs to tenant, is draft
   Uses SELECT ... FOR UPDATE so concurrent item writes block.
============================================================ */
async function verifyParentIsDraft(conn, purchaseId, tenantAdminId) {
  const [rows] = await conn.query(
    `SELECT id, status FROM pharmacy_purchase_orders
     WHERE id = ? AND admin_id = ? LIMIT 1
     FOR UPDATE`,
    [purchaseId, tenantAdminId]
  );
  if (!rows.length) {
    return { ok: false, status: 404, message: "Purchase order not found" };
  }
  if (rows[0].status !== "draft") {
    return {
      ok: false,
      status: 409,
      message: `Cannot modify items — parent PO is '${rows[0].status}'. Only draft POs are editable.`,
    };
  }
  return { ok: true, parent: rows[0] };
}

/* ============================================================
   CREATE — add a single item to an existing draft PO
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
      const item = req.body;

      if (!item.purchase_id) {
        return res.status(400).json({
          success: false,
          message: "purchase_id is required",
        });
      }

      const v = validateItemFields(item, { requireAll: true });
      if (!v.ok) {
        return res.status(400).json({ success: false, message: v.message });
      }

      await conn.beginTransaction();

      // Parent must exist, belong to tenant, be draft
      const parentCheck = await verifyParentIsDraft(
        conn,
        item.purchase_id,
        tenantAdminId
      );
      if (!parentCheck.ok) {
        await conn.rollback();
        return res
          .status(parentCheck.status)
          .json({ success: false, message: parentCheck.message });
      }

      // Verify medicine belongs to this tenant (and read its tablets per strip)
      const [med] = await conn.query(
        `SELECT id, units_per_pack, pack_size FROM pharmacy_medicines
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [item.medicine_id, tenantAdminId]
      );
      if (!med.length) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Medicine not found for this tenant",
        });
      }

      const [result] = await conn.query(
        `INSERT INTO pharmacy_purchase_items
          (purchase_id, medicine_id, batch_id, batch_number,
           manufacturing_date, expiry_date,
           quantity, free_quantity, units_per_pack,
           purchase_price, mrp, selling_price,
           discount_amount, gst_percentage, tax_amount, total_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.purchase_id,
          item.medicine_id,
          item.batch_id || null,
          String(item.batch_number).trim(),
          item.manufacturing_date || null,
          item.expiry_date,
          Number(item.quantity),
          Number(item.free_quantity) || 0,
          cleanUnitsPerPack(item.units_per_pack) || unitsPerPack(med[0]),
          Number(item.purchase_price) || 0,
          Number(item.mrp) || 0,
          Number(item.selling_price) || 0,
          Number(item.discount_amount) || 0,
          Number(item.gst_percentage) || 0,
          Number(item.tax_amount) || 0,
          Number(item.total_amount) || 0,
        ]
      );

      await conn.commit();

      const [row] = await db.query(
        `SELECT * FROM pharmacy_purchase_items WHERE id = ?`,
        [result.insertId]
      );

      return res.status(201).json({
        success: true,
        message: "Purchase item added",
        data: row[0],
        note: "Refresh parent PO totals via PUT /purchase-orders/update/:id",
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error("Create purchase item error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to add purchase item",
      });
    } finally {
      conn.release();
    }
  }
);

/* ============================================================
   LIST items
   Query params:
     - purchase_id      — filter items of one PO (most common)
     - medicine_id      — filter items of one medicine across POs
     - batch_number     — LIKE search
     - expiry_before    — items expiring before this date (e.g. next-30-day audit)
     - page, limit, sort_by (id | expiry_date | quantity | created_at), sort_order
   Tenant scoping via JOIN on parent PO.
============================================================ */
router.get(
  "/get",
  authMiddleware,
  allowPermissions("pharmacy.purchase.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const {
        purchase_id,
        medicine_id,
        batch_number,
        expiry_before,
        page = 1,
        limit = 50,
        sort_by = "id",
        sort_order = "ASC",
      } = req.query;

      const where = ["po.admin_id = ?"];
      const params = [tenantAdminId];

      if (purchase_id) {
        where.push("i.purchase_id = ?");
        params.push(purchase_id);
      }
      if (medicine_id) {
        where.push("i.medicine_id = ?");
        params.push(medicine_id);
      }
      if (batch_number && String(batch_number).trim()) {
        where.push("i.batch_number LIKE ?");
        params.push(`%${String(batch_number).trim()}%`);
      }
      if (expiry_before) {
        where.push("i.expiry_date < ?");
        params.push(expiry_before);
      }

      const whereClause = where.join(" AND ");
      const offset = (Number(page) - 1) * Number(limit);
      const allowedSort = ["id", "expiry_date", "quantity", "created_at"];
      const safeSortBy = allowedSort.includes(sort_by) ? sort_by : "id";
      const safeSortOrder = sort_order === "DESC" ? "DESC" : "ASC";

      const [countRes] = await db.query(
        `SELECT COUNT(*) as total
         FROM pharmacy_purchase_items i
         JOIN pharmacy_purchase_orders po ON po.id = i.purchase_id
         WHERE ${whereClause}`,
        params
      );

      const [rows] = await db.query(
        `SELECT i.*
         FROM pharmacy_purchase_items i
         JOIN pharmacy_purchase_orders po ON po.id = i.purchase_id
         WHERE ${whereClause}
         ORDER BY i.${safeSortBy} ${safeSortOrder}
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), offset]
      );

      return res.json({
        success: true,
        data: rows,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: countRes[0].total,
          total_pages: Math.ceil(countRes[0].total / Number(limit)),
        },
      });
    } catch (err) {
      console.error("List purchase items error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch purchase items",
      });
    }
  }
);

/* ============================================================
   GET single item (scoped to tenant via JOIN)
============================================================ */
router.get(
  "/get/:id",
  authMiddleware,
  allowPermissions("pharmacy.purchase.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [rows] = await db.query(
        `SELECT i.*, po.status AS parent_status, po.purchase_number
         FROM pharmacy_purchase_items i
         JOIN pharmacy_purchase_orders po ON po.id = i.purchase_id
         WHERE i.id = ? AND po.admin_id = ?
         LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Purchase item not found",
        });
      }

      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      console.error("Get purchase item error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch purchase item",
      });
    }
  }
);

/* ============================================================
   UPDATE item — parent PO must be draft
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
      const body = req.body;

      await conn.beginTransaction();

      // Fetch item + parent, lock parent row
      const [rows] = await conn.query(
        `SELECT i.id AS item_id, i.purchase_id, po.status AS parent_status
         FROM pharmacy_purchase_items i
         JOIN pharmacy_purchase_orders po ON po.id = i.purchase_id
         WHERE i.id = ? AND po.admin_id = ?
         LIMIT 1
         FOR UPDATE`,
        [id, tenantAdminId]
      );

      if (!rows.length) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Purchase item not found",
        });
      }

      if (rows[0].parent_status !== "draft") {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: `Cannot edit — parent PO is '${rows[0].parent_status}'. Only draft items are editable.`,
        });
      }

      const v = validateItemFields(body, { requireAll: false });
      if (!v.ok) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: v.message });
      }

      // If medicine_id changing, verify new one belongs to tenant
      if (body.medicine_id !== undefined) {
        const [med] = await conn.query(
          `SELECT id FROM pharmacy_medicines
           WHERE id = ? AND admin_id = ? LIMIT 1`,
          [body.medicine_id, tenantAdminId]
        );
        if (!med.length) {
          await conn.rollback();
          return res.status(404).json({
            success: false,
            message: "Medicine not found for this tenant",
          });
        }
      }

      const updates = [];
      const params = [];

      const editable = {
        medicine_id: body.medicine_id,
        batch_id: body.batch_id,
        batch_number:
          body.batch_number !== undefined
            ? String(body.batch_number).trim()
            : undefined,
        manufacturing_date: body.manufacturing_date,
        expiry_date: body.expiry_date,
        quantity:
          body.quantity !== undefined ? Number(body.quantity) : undefined,
        free_quantity:
          body.free_quantity !== undefined
            ? Number(body.free_quantity)
            : undefined,
        units_per_pack:
          body.units_per_pack !== undefined && body.units_per_pack !== null && body.units_per_pack !== ""
            ? cleanUnitsPerPack(body.units_per_pack)
            : undefined,
        purchase_price:
          body.purchase_price !== undefined
            ? Number(body.purchase_price)
            : undefined,
        mrp: body.mrp !== undefined ? Number(body.mrp) : undefined,
        selling_price:
          body.selling_price !== undefined
            ? Number(body.selling_price)
            : undefined,
        discount_amount:
          body.discount_amount !== undefined
            ? Number(body.discount_amount)
            : undefined,
        gst_percentage:
          body.gst_percentage !== undefined
            ? Number(body.gst_percentage)
            : undefined,
        tax_amount:
          body.tax_amount !== undefined ? Number(body.tax_amount) : undefined,
        total_amount:
          body.total_amount !== undefined
            ? Number(body.total_amount)
            : undefined,
      };

      for (const [field, value] of Object.entries(editable)) {
        if (value === undefined) continue;
        updates.push(`${field} = ?`);
        params.push(value === "" ? null : value);
      }

      if (!updates.length) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "No fields to update",
        });
      }

      params.push(id);
      await conn.query(
        `UPDATE pharmacy_purchase_items
         SET ${updates.join(", ")}
         WHERE id = ?`,
        params
      );

      await conn.commit();

      const [updated] = await db.query(
        `SELECT * FROM pharmacy_purchase_items WHERE id = ?`,
        [id]
      );

      return res.json({
        success: true,
        message: "Purchase item updated",
        data: updated[0],
        note: "Refresh parent PO totals if item amounts changed.",
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error("Update purchase item error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update purchase item",
      });
    } finally {
      conn.release();
    }
  }
);

/* ============================================================
   DELETE item — hard delete, parent PO must be draft
   Items table has no status column, so this is a real delete.
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

      const [rows] = await conn.query(
        `SELECT i.id AS item_id, i.purchase_id, po.status AS parent_status
         FROM pharmacy_purchase_items i
         JOIN pharmacy_purchase_orders po ON po.id = i.purchase_id
         WHERE i.id = ? AND po.admin_id = ?
         LIMIT 1
         FOR UPDATE`,
        [id, tenantAdminId]
      );

      if (!rows.length) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Purchase item not found",
        });
      }

      if (rows[0].parent_status !== "draft") {
        await conn.rollback();
        return res.status(409).json({
          success: false,
          message: `Cannot delete — parent PO is '${rows[0].parent_status}'. Only draft items are deletable.`,
        });
      }

      await conn.query(
        `DELETE FROM pharmacy_purchase_items WHERE id = ?`,
        [id]
      );

      await conn.commit();

      return res.json({
        success: true,
        message: "Purchase item deleted",
        note: "Refresh parent PO totals via PUT /purchase-orders/update/:id",
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error("Delete purchase item error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to delete purchase item",
      });
    } finally {
      conn.release();
    }
  }
);

module.exports = router;