// routes/pharmacy/categories.js

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");

/* ============================================================
   Helper: resolve tenant admin_id from req.user
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

/* ============================================================
   CREATE category
   Access:
     - admin (bypass — requires 'pharmacy' module in admin_modules)
     - any staff role with 'pharmacy.medicines.create' permission
============================================================ */
router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.medicines.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { category_name, description } = req.body;

      if (!category_name || !category_name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Category name is required",
        });
      }

      const trimmedName = category_name.trim();

      if (trimmedName.length > 255) {
        return res.status(400).json({
          success: false,
          message: "Category name too long (max 255 characters)",
        });
      }

      const [existing] = await db.query(
        `SELECT id FROM pharmacy_categories 
         WHERE admin_id = ? AND category_name = ? LIMIT 1`,
        [tenantAdminId, trimmedName]
      );

      if (existing.length) {
        return res.status(409).json({
          success: false,
          message: `Category '${trimmedName}' already exists`,
        });
      }

      const [result] = await db.query(
        `INSERT INTO pharmacy_categories 
          (admin_id, category_name, description, status)
         VALUES (?, ?, ?, 'active')`,
        [tenantAdminId, trimmedName, description?.trim() || null]
      );

      const [newCategory] = await db.query(
        `SELECT id, category_name, description, status, created_at
         FROM pharmacy_categories WHERE id = ?`,
        [result.insertId]
      );

      return res.status(201).json({
        success: true,
        message: "Category created successfully",
        data: newCategory[0],
      });
    } catch (err) {
      console.error("Create category error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create category",
      });
    }
  }
);

/* ============================================================
   LIST categories (with search, filter, pagination)
   Access:
     - admin (bypass — requires 'pharmacy' module in admin_modules)
     - any staff role with 'pharmacy.medicines.view' permission
============================================================ */
router.get(
  "/",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      const {
        search,
        status,
        page = 1,
        limit = 20,
        sort_by = "created_at",
        sort_order = "DESC",
      } = req.query;

      const whereConditions = ["admin_id = ?"];
      const params = [tenantAdminId];

      if (status && ["active", "inactive"].includes(status)) {
        whereConditions.push("status = ?");
        params.push(status);
      }

      if (search && search.trim()) {
        whereConditions.push("(category_name LIKE ? OR description LIKE ?)");
        params.push(`%${search.trim()}%`, `%${search.trim()}%`);
      }

      const whereClause = whereConditions.join(" AND ");
      const offset = (Number(page) - 1) * Number(limit);

      const allowedSort = ["created_at", "category_name", "updated_at"];
      const safeSortBy = allowedSort.includes(sort_by) ? sort_by : "created_at";
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      const [countResult] = await db.query(
        `SELECT COUNT(*) as total 
         FROM pharmacy_categories 
         WHERE ${whereClause}`,
        params
      );

      const [categories] = await db.query(
        `SELECT id, category_name, description, status, created_at, updated_at
         FROM pharmacy_categories 
         WHERE ${whereClause}
         ORDER BY ${safeSortBy} ${safeSortOrder}
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), offset]
      );

      return res.json({
        success: true,
        data: categories,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: countResult[0].total,
          total_pages: Math.ceil(countResult[0].total / Number(limit)),
        },
      });
    } catch (err) {
      console.error("List categories error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch categories",
      });
    }
  }
);

/* ============================================================
   GET single category by ID
   Access:
     - admin (bypass — requires 'pharmacy' module in admin_modules)
     - any staff role with 'pharmacy.medicines.view' permission
============================================================ */
router.get(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [category] = await db.query(
        `SELECT id, category_name, description, status, created_at, updated_at
         FROM pharmacy_categories 
         WHERE id = ? AND admin_id = ?`,
        [id, tenantAdminId]
      );

      if (!category.length) {
        return res.status(404).json({
          success: false,
          message: "Category not found",
        });
      }

      return res.json({
        success: true,
        data: category[0],
      });
    } catch (err) {
      console.error("Get category error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch category",
      });
    }
  }
);

/* ============================================================
   UPDATE category
   Access:
     - admin (bypass — requires 'pharmacy' module in admin_modules)
     - any staff role with 'pharmacy.medicines.edit' permission
============================================================ */
router.put(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
      const { category_name, description, status } = req.body;

      const [existing] = await db.query(
        `SELECT id, category_name FROM pharmacy_categories 
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Category not found",
        });
      }

      const updates = [];
      const params = [];

      if (category_name !== undefined) {
        const trimmedName = category_name.trim();

        if (!trimmedName) {
          return res.status(400).json({
            success: false,
            message: "Category name cannot be empty",
          });
        }

        if (trimmedName !== existing[0].category_name) {
          const [duplicate] = await db.query(
            `SELECT id FROM pharmacy_categories 
             WHERE admin_id = ? AND category_name = ? AND id != ? LIMIT 1`,
            [tenantAdminId, trimmedName, id]
          );

          if (duplicate.length) {
            return res.status(409).json({
              success: false,
              message: `Category '${trimmedName}' already exists`,
            });
          }
        }

        updates.push("category_name = ?");
        params.push(trimmedName);
      }

      if (description !== undefined) {
        updates.push("description = ?");
        params.push(description?.trim() || null);
      }

      if (status !== undefined) {
        if (!["active", "inactive"].includes(status)) {
          return res.status(400).json({
            success: false,
            message: "Invalid status. Use 'active' or 'inactive'",
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
        `UPDATE pharmacy_categories 
         SET ${updates.join(", ")} 
         WHERE id = ? AND admin_id = ?`,
        params
      );

      const [updated] = await db.query(
        `SELECT id, category_name, description, status, created_at, updated_at
         FROM pharmacy_categories WHERE id = ?`,
        [id]
      );

      return res.json({
        success: true,
        message: "Category updated successfully",
        data: updated[0],
      });
    } catch (err) {
      console.error("Update category error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update category",
      });
    }
  }
);

/* ============================================================
   SOFT DELETE (set inactive)
   Access:
     - admin (bypass — requires 'pharmacy' module in admin_modules)
     - any staff role with 'pharmacy.medicines.delete' permission
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
        `SELECT id, category_name FROM pharmacy_categories 
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Category not found",
        });
      }

      const [medicineCheck] = await db.query(
        `SELECT COUNT(*) as count 
         FROM pharmacy_medicines 
         WHERE category_id = ? AND admin_id = ? AND status = 'active'`,
        [id, tenantAdminId]
      );

      if (medicineCheck[0].count > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot deactivate - ${medicineCheck[0].count} active medicines use this category`,
          active_medicines_count: medicineCheck[0].count,
        });
      }

      await db.query(
        `UPDATE pharmacy_categories 
         SET status = 'inactive' 
         WHERE id = ? AND admin_id = ?`,
        [id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `Category '${existing[0].category_name}' deactivated`,
      });
    } catch (err) {
      console.error("Delete category error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to delete category",
      });
    }
  }
);

/* ============================================================
   TOGGLE STATUS (activate/deactivate)
   Access:
     - admin (bypass — requires 'pharmacy' module in admin_modules)
     - any staff role with 'pharmacy.medicines.edit' permission
============================================================ */
router.patch(
  "/:id/status",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [existing] = await db.query(
        `SELECT id, category_name, status FROM pharmacy_categories 
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Category not found",
        });
      }

      const newStatus =
        existing[0].status === "active" ? "inactive" : "active";

      if (newStatus === "inactive") {
        const [medicineCheck] = await db.query(
          `SELECT COUNT(*) as count 
           FROM pharmacy_medicines 
           WHERE category_id = ? AND admin_id = ? AND status = 'active'`,
          [id, tenantAdminId]
        );

        if (medicineCheck[0].count > 0) {
          return res.status(409).json({
            success: false,
            message: `Cannot deactivate - ${medicineCheck[0].count} active medicines use this category`,
          });
        }
      }

      await db.query(
        `UPDATE pharmacy_categories 
         SET status = ? 
         WHERE id = ? AND admin_id = ?`,
        [newStatus, id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `Category ${newStatus === "active" ? "activated" : "deactivated"}`,
        data: { id, status: newStatus },
      });
    } catch (err) {
      console.error("Toggle status error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to toggle status",
      });
    }
  }
);

module.exports = router;