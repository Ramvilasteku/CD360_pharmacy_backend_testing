// routes/pharmacy/customers.js

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions, adminOnly } = require("../../middlewares/allowPermissions");

/* ============================================================
   Helper: resolve tenant admin_id from req.user
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

/* ============================================================
   Helper: validate optional fields (email / gender / age)
   Returns { ok: true } or { ok: false, message }
============================================================ */
function validateOptionalFields({ email, gender, age }) {
  if (gender !== undefined && gender !== null && gender !== "") {
    if (!["male", "female", "other"].includes(gender)) {
      return {
        ok: false,
        message: "Invalid gender. Use 'male', 'female', or 'other'",
      };
    }
  }
  if (age !== undefined && age !== null && age !== "") {
    const n = Number(age);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return { ok: false, message: "Invalid age (must be 0–255)" };
    }
  }
  if (email !== undefined && email !== null && email !== "") {
    if (String(email).length > 150) {
      return { ok: false, message: "Email too long (max 150 characters)" };
    }
  }
  return { ok: true };
}

/* ============================================================
   CREATE customer
   Access:
     - admin (bypass — requires 'pharmacy' module in admin_modules)
     - any staff role with 'pharmacy.customers.create' permission
============================================================ */
router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.customers.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { name, mobile, email, gender, age } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Name is required",
        });
      }
      if (!mobile || !String(mobile).trim()) {
        return res.status(400).json({
          success: false,
          message: "Mobile is required",
        });
      }

      const trimmedName = name.trim();
      const trimmedMobile = String(mobile).trim();

      if (trimmedName.length > 150) {
        return res.status(400).json({
          success: false,
          message: "Name too long (max 150 characters)",
        });
      }
      if (trimmedMobile.length > 15) {
        return res.status(400).json({
          success: false,
          message: "Mobile too long (max 15 characters)",
        });
      }

      const v = validateOptionalFields({ email, gender, age });
      if (!v.ok) {
        return res.status(400).json({ success: false, message: v.message });
      }

      // Duplicate check — same tenant, same mobile
    

      // Duplicate check — same tenant, same name AND same mobile
        const [dupCheck] = await db.query(
          `SELECT id FROM pharmacy_customer_pos
          WHERE admin_id = ? AND mobile = ? AND LOWER(name) = LOWER(?)
          LIMIT 1`,
          [tenantAdminId, trimmedMobile, trimmedName]
        );

        if (dupCheck.length > 0) {
          return res.status(409).json({
            success: false,
            message: `Customer '${trimmedName}' with mobile '${trimmedMobile}' already exists`,
            existing_id: dupCheck[0].id,
          });
        }

      const [result] = await db.query(
        `INSERT INTO pharmacy_customer_pos
          (admin_id, name, mobile, email, gender, age)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          tenantAdminId,
          trimmedName,
          trimmedMobile,
          email?.trim() || null,
          gender || null,
          age !== undefined && age !== null && age !== ""
            ? Number(age)
            : null,
        ]
      );

      const [newCustomer] = await db.query(
        `SELECT id, name, mobile, email, gender, age, created_at, updated_at
         FROM pharmacy_customer_pos WHERE id = ?`,
        [result.insertId]
      );

      return res.status(201).json({
        success: true,
        message: "Customer created successfully",
        data: newCustomer[0],
      });
    } catch (err) {
      console.error("Create customer error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create customer",
      });
    }
  }
);

/* ============================================================
   LIST customers (with search, filter, pagination)
   Query params:
     - search     — matches name, mobile, or email
     - gender     — 'male' | 'female' | 'other'
     - page, limit
     - sort_by    — created_at | name | updated_at
     - sort_order — ASC | DESC
   Access:
     - admin (bypass — requires 'pharmacy' module in admin_modules)
     - any staff role with 'pharmacy.customers.view' permission
============================================================ */
router.get(
  "/get",
  authMiddleware,
  allowPermissions("pharmacy.customers.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      const {
        search,
        gender,
        page = 1,
        limit = 20,
        sort_by = "created_at",
        sort_order = "DESC",
      } = req.query;

      const whereConditions = ["admin_id = ?"];
      const params = [tenantAdminId];

      if (gender && ["male", "female", "other"].includes(gender)) {
        whereConditions.push("gender = ?");
        params.push(gender);
      }

      if (search && search.trim()) {
        whereConditions.push(
          "(name LIKE ? OR mobile LIKE ? OR email LIKE ?)"
        );
        const like = `%${search.trim()}%`;
        params.push(like, like, like);
      }

      const whereClause = whereConditions.join(" AND ");
      const offset = (Number(page) - 1) * Number(limit);

      const allowedSort = ["created_at", "name", "updated_at"];
      const safeSortBy = allowedSort.includes(sort_by)
        ? sort_by
        : "created_at";
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      const [countResult] = await db.query(
        `SELECT COUNT(*) as total
         FROM pharmacy_customer_pos
         WHERE ${whereClause}`,
        params
      );

      const [customers] = await db.query(
        `SELECT id, name, mobile, email, gender, age, created_at, updated_at
         FROM pharmacy_customer_pos
         WHERE ${whereClause}
         ORDER BY ${safeSortBy} ${safeSortOrder}
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), offset]
      );

      return res.json({
        success: true,
        data: customers,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: countResult[0].total,
          total_pages: Math.ceil(countResult[0].total / Number(limit)),
        },
      });
    } catch (err) {
      console.error("List customers error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch customers",
      });
    }
  }
);

/* ============================================================
   POS QUICK LOOKUP — by mobile
   The natural POS entry flow: cashier types a phone number,
   you either fetch the existing customer or fall back to create.
   MUST be defined BEFORE '/:id' so Express doesn't match /lookup
   as an :id param.
   Access:
     - admin (bypass)
     - staff with 'pharmacy.customers.view'
============================================================ */
router.get(
  "/get/moblie-no/:mobile",
  authMiddleware,
  // M7: billing screens need this read — a cashier holding only pharmacy.sales.create must be able to use it
  allowPermissions("pharmacy.customers.view", "pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const mobile = String(req.params.mobile || "").trim();

      if (!mobile) {
        return res.status(400).json({
          success: false,
          message: "Mobile is required",
        });
      }

      // The POS fires this as a TYPE-AHEAD from the 2nd digit onwards, so an exact
      // `mobile = ?` match returned nothing until the counter had typed the whole
      // number character-for-character — and still nothing when the stored number
      // carries formatting ("+91 98765 43210") that the UI strips before sending.
      // Match on digits only, anywhere in the number, and rank the closest first.
      const digits = mobile.replace(/\D/g, "");
      if (!digits) {
        return res.json({ success: true, found: false, count: 0, data: [] });
      }

      // mobile with spaces, dashes, brackets, dots and + removed
      const NORM =
        "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.mobile,' ',''),'-',''),'(',''),')',''),'.',''),'+','')";

      const [rows] = await db.query(
        `SELECT c.id, c.name, c.mobile, c.email, c.gender, c.age,
                c.created_at, c.updated_at
           FROM pharmacy_customer_pos c
          WHERE c.admin_id = ?
            AND ${NORM} LIKE CONCAT('%', ?, '%')
          ORDER BY
            CASE WHEN ${NORM} = ?                      THEN 0
                 WHEN ${NORM} LIKE CONCAT(?, '%')      THEN 1
                 WHEN ${NORM} LIKE CONCAT('%', ?)      THEN 2
                 ELSE 3 END,
            c.created_at DESC
          LIMIT 25`,
        [tenantAdminId, digits, digits, digits, digits]
      );

      // `found` still means "this exact number is already on file", which is what the
      // existing-customer branch of the POS keys off.
      const normalise = (v) => String(v || "").replace(/\D/g, "");
      const exact = rows.some((r) => normalise(r.mobile) === digits);

      return res.json({
        success: true,
        found: exact,
        count: rows.length,
        data: rows,
      });
    } catch (err) {
      console.error("Lookup customer error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to lookup customer",
      });
    }
  }
);
/* ============================================================
   GET single customer by ID
   Access:
     - admin (bypass)
     - staff with 'pharmacy.customers.view'
============================================================ */
router.get(
  "/get/:id",
  authMiddleware,
  allowPermissions("pharmacy.customers.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [customer] = await db.query(
        `SELECT id, name, mobile, email, gender, age, created_at, updated_at
         FROM pharmacy_customer_pos
         WHERE id = ? AND admin_id = ?`,
        [id, tenantAdminId]
      );

      if (!customer.length) {
        return res.status(404).json({
          success: false,
          message: "Customer not found",
        });
      }

      return res.json({
        success: true,
        data: customer[0],
      });
    } catch (err) {
      console.error("Get customer error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch customer",
      });
    }
  }
);

/* ============================================================
   UPDATE customer
   Access:
     - admin (bypass)
     - staff with 'pharmacy.customers.edit'
============================================================ */
router.put(
  "/update/:id",
  authMiddleware,
  allowPermissions("pharmacy.customers.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
      const { name, mobile, email, gender, age } = req.body;

      const [existing] = await db.query(
        `SELECT id, mobile FROM pharmacy_customer_pos
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Customer not found",
        });
      }

      const v = validateOptionalFields({ email, gender, age });
      if (!v.ok) {
        return res.status(400).json({ success: false, message: v.message });
      }

      const updates = [];
      const params = [];

      if (name !== undefined) {
        const trimmed = String(name).trim();
        if (!trimmed) {
          return res.status(400).json({
            success: false,
            message: "Name cannot be empty",
          });
        }
        if (trimmed.length > 150) {
          return res.status(400).json({
            success: false,
            message: "Name too long (max 150 characters)",
          });
        }
        updates.push("name = ?");
        params.push(trimmed);
      }

      if (mobile !== undefined) {
        const trimmed = String(mobile).trim();
        if (!trimmed) {
          return res.status(400).json({
            success: false,
            message: "Mobile cannot be empty",
          });
        }
        if (trimmed.length > 15) {
          return res.status(400).json({
            success: false,
            message: "Mobile too long (max 15 characters)",
          });
        }
        if (trimmed !== existing[0].mobile) {
          const [dup] = await db.query(
            `SELECT id FROM pharmacy_customer_pos
             WHERE admin_id = ? AND mobile = ? AND id != ? LIMIT 1`,
            [tenantAdminId, trimmed, id]
          );
          if (dup.length) {
            return res.status(409).json({
              success: false,
              message: `Another customer with mobile '${trimmed}' already exists`,
            });
          }
        }
        updates.push("mobile = ?");
        params.push(trimmed);
      }

      if (email !== undefined) {
        updates.push("email = ?");
        params.push(email ? String(email).trim() : null);
      }

      if (gender !== undefined) {
        updates.push("gender = ?");
        params.push(gender || null);
      }

      if (age !== undefined) {
        updates.push("age = ?");
        params.push(age === null || age === "" ? null : Number(age));
      }

      if (!updates.length) {
        return res.status(400).json({
          success: false,
          message: "No fields to update",
        });
      }

      params.push(id, tenantAdminId);

      await db.query(
        `UPDATE pharmacy_customer_pos
         SET ${updates.join(", ")}
         WHERE id = ? AND admin_id = ?`,
        params
      );

      const [updated] = await db.query(
        `SELECT id, name, mobile, email, gender, age, created_at, updated_at
         FROM pharmacy_customer_pos WHERE id = ?`,
        [id]
      );

      return res.json({
        success: true,
        message: "Customer updated successfully",
        data: updated[0],
      });
    } catch (err) {
      console.error("Update customer error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update customer",
      });
    }
  }
);

/* ============================================================
   DELETE customer (HARD DELETE)
   Note: this table has no `status` column, so there is no
   soft-delete option. Once POS sales / orders tables exist,
   either (a) block delete when the customer has history, or
   (b) add a status column and switch to the categories-style
   soft-delete pattern.
   Access:
     - admin (bypass)
     - staff with 'pharmacy.customers.delete'
============================================================ */
router.delete(
  "/delete/:id",
  authMiddleware,
  allowPermissions("pharmacy.customers.delete"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [existing] = await db.query(
        `SELECT id, name FROM pharmacy_customer_pos
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Customer not found",
        });
      }

      // TODO: once POS sales tables exist, block delete if this
      // customer has any sales history — or migrate to soft delete.

      await db.query(
        `DELETE FROM pharmacy_customer_pos
         WHERE id = ? AND admin_id = ?`,
        [id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `Customer '${existing[0].name}' deleted`,
      });
    } catch (err) {
      console.error("Delete customer error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to delete customer",
      });
    }
  }
);

module.exports = router;