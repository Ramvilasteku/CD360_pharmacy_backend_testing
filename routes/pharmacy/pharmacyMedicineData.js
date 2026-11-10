// routes/pharmacy/medicine-data.js

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");

/* ============================================================
   NOTE ON THIS TABLE
   `medicine_data` has NO admin_id → treated here as a GLOBAL
   master catalog shared across all tenants. If this was meant
   to be tenant-scoped, add `admin_id INT UNSIGNED NOT NULL`
   and re-scope every query below.
   Uses soft delete via status = 'active' | 'inactive'.
============================================================ */

/* ============================================================
   Helper: validate medicine field lengths / presence
============================================================ */
function validateMedicineFields(payload, { requireName = false } = {}) {
  const {
    medicine_name,
    generic_name,
    brand_name,
    medicine_image,
    dosage_form,
    strength,
  } = payload;

  if (requireName) {
    if (!medicine_name || !String(medicine_name).trim()) {
      return { ok: false, message: "medicine_name is required" };
    }
  }

  const checks = [
    ["medicine_name", medicine_name, 255],
    ["generic_name", generic_name, 255],
    ["brand_name", brand_name, 255],
    ["medicine_image", medicine_image, 500],
    ["dosage_form", dosage_form, 100],
    ["strength", strength, 100],
  ];

  for (const [field, value, max] of checks) {
    if (value !== undefined && value !== null && value !== "") {
      if (String(value).length > max) {
        return {
          ok: false,
          message: `${field} too long (max ${max} characters)`,
        };
      }
    }
  }

  return { ok: true };
}

/* ============================================================
   CREATE medicine
============================================================ */
router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.medicines.create"),
  async (req, res) => {
    try {
      const {
        medicine_name,
        generic_name,
        brand_name,
        medicine_image,
        dosage_form,
        strength,
      } = req.body;

      const v = validateMedicineFields(req.body, { requireName: true });
      if (!v.ok) {
        return res.status(400).json({ success: false, message: v.message });
      }

      const trimmedName = String(medicine_name).trim();
      const trimmedStrength = strength ? String(strength).trim() : null;
      const trimmedDosage = dosage_form ? String(dosage_form).trim() : null;

      // Duplicate check on (medicine_name + strength + dosage_form).
      // `<=>` is the NULL-safe equal operator in MySQL.
      const [existing] = await db.query(
        `SELECT id FROM medicine_data
         WHERE medicine_name = ?
           AND (strength <=> ?)
           AND (dosage_form <=> ?)
         LIMIT 1`,
        [trimmedName, trimmedStrength, trimmedDosage]
      );

      if (existing.length) {
        return res.status(409).json({
          success: false,
          message: `'${trimmedName}' with same strength & dosage form already exists`,
          existing_id: existing[0].id,
        });
      }

      const [result] = await db.query(
        `INSERT INTO medicine_data
          (medicine_name, generic_name, brand_name, medicine_image,
           dosage_form, strength, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [
          trimmedName,
          generic_name?.trim() || null,
          brand_name?.trim() || null,
          medicine_image?.trim() || null,
          trimmedDosage,
          trimmedStrength,
        ]
      );

      const [row] = await db.query(
        `SELECT id, medicine_name, generic_name, brand_name, medicine_image,
                dosage_form, strength, status, created_at, updated_at
         FROM medicine_data WHERE id = ?`,
        [result.insertId]
      );

      return res.status(201).json({
        success: true,
        message: "Medicine created successfully",
        data: row[0],
      });
    } catch (err) {
      console.error("Create medicine error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create medicine",
      });
    }
  }
);

/* ============================================================
   LIST medicines (search / filter / pagination)
============================================================ */
router.get(
  "/get",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const {
        search,
        status,
        dosage_form,
        page = 1,
        limit = 20,
        sort_by = "created_at",
        sort_order = "DESC",
      } = req.query;

      const where = [];
      const params = [];

      if (status && ["active", "inactive"].includes(status)) {
        where.push("status = ?");
        params.push(status);
      }

      if (dosage_form && String(dosage_form).trim()) {
        where.push("dosage_form = ?");
        params.push(String(dosage_form).trim());
      }

      if (search && String(search).trim()) {
        where.push(
          "(medicine_name LIKE ? OR generic_name LIKE ? OR brand_name LIKE ?)"
        );
        const like = `%${String(search).trim()}%`;
        params.push(like, like, like);
      }

      const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const offset = (Number(page) - 1) * Number(limit);

      const allowedSort = ["created_at", "medicine_name", "updated_at"];
      const safeSortBy = allowedSort.includes(sort_by)
        ? sort_by
        : "created_at";
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      const [countRes] = await db.query(
        `SELECT COUNT(*) as total FROM medicine_data ${whereClause}`,
        params
      );

      const [rows] = await db.query(
        `SELECT id, medicine_name, generic_name, brand_name, medicine_image,
                dosage_form, strength, status, created_at, updated_at
         FROM medicine_data
         ${whereClause}
         ORDER BY ${safeSortBy} ${safeSortOrder}
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
      console.error("List medicines error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch medicines",
      });
    }
  }
);

/* ============================================================
   GET single medicine by ID
============================================================ */
router.get(
  "/get/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const [rows] = await db.query(
        `SELECT id, medicine_name, generic_name, brand_name, medicine_image,
                dosage_form, strength, status, created_at, updated_at
         FROM medicine_data WHERE id = ?`,
        [id]
      );

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found",
        });
      }

      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      console.error("Get medicine error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch medicine",
      });
    }
  }
);

/* ============================================================
   UPDATE medicine
============================================================ */
/* ============================================================
   M5 (10 Nov 2026) — the shared catalogue is edited centrally, not by tenants.

   medicine_data is ONE list shared by every pharmacy, so renaming, switching off or
   deleting an entry changes it for everyone. Any pharmacy can still ADD a missing
   medicine (POST /post, used by the Medicines screen and CSV import) and read the list;
   only catalogue editors can change or remove entries.

   There is no super-admin login in this backend yet, so catalogue editors are named
   by admin id in .env:   PHARMACY_CATALOG_EDITOR_IDS=1,42
   Not set → nobody can edit or delete through the API (change it in the database).
============================================================ */
const CATALOG_EDITOR_IDS = new Set(
  String(process.env.PHARMACY_CATALOG_EDITOR_IDS || "")
    .split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0)
);
function catalogEditorsOnly(req, res, next) {
  const isEditor = req.user && req.user.role === "admin" && CATALOG_EDITOR_IDS.has(Number(req.user.id));
  if (isEditor) return next();
  return res.status(403).json({
    success: false,
    message: "The medicine catalogue is shared by every pharmacy, so entries can only be changed or removed centrally. Add a new medicine instead, or ask support to correct this one.",
  });
}

router.put(
  "/update/:id",
  authMiddleware,
  catalogEditorsOnly,
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        medicine_name,
        generic_name,
        brand_name,
        medicine_image,
        dosage_form,
        strength,
        status,
      } = req.body;

      const [existing] = await db.query(
        `SELECT id FROM medicine_data WHERE id = ? LIMIT 1`,
        [id]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found",
        });
      }

      const v = validateMedicineFields(req.body);
      if (!v.ok) {
        return res.status(400).json({ success: false, message: v.message });
      }

      const updates = [];
      const params = [];

      if (medicine_name !== undefined) {
        const trimmed = String(medicine_name).trim();
        if (!trimmed) {
          return res.status(400).json({
            success: false,
            message: "medicine_name cannot be empty",
          });
        }
        updates.push("medicine_name = ?");
        params.push(trimmed);
      }

      if (generic_name !== undefined) {
        updates.push("generic_name = ?");
        params.push(generic_name ? String(generic_name).trim() : null);
      }
      if (brand_name !== undefined) {
        updates.push("brand_name = ?");
        params.push(brand_name ? String(brand_name).trim() : null);
      }
      if (medicine_image !== undefined) {
        updates.push("medicine_image = ?");
        params.push(medicine_image ? String(medicine_image).trim() : null);
      }
      if (dosage_form !== undefined) {
        updates.push("dosage_form = ?");
        params.push(dosage_form ? String(dosage_form).trim() : null);
      }
      if (strength !== undefined) {
        updates.push("strength = ?");
        params.push(strength ? String(strength).trim() : null);
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

      params.push(id);

      await db.query(
        `UPDATE medicine_data SET ${updates.join(", ")} WHERE id = ?`,
        params
      );

      const [updated] = await db.query(
        `SELECT id, medicine_name, generic_name, brand_name, medicine_image,
                dosage_form, strength, status, created_at, updated_at
         FROM medicine_data WHERE id = ?`,
        [id]
      );

      return res.json({
        success: true,
        message: "Medicine updated successfully",
        data: updated[0],
      });
    } catch (err) {
      console.error("Update medicine error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update medicine",
      });
    }
  }
);

/* ============================================================
   SOFT DELETE (status = inactive)
============================================================ */
router.delete(
  "/delete/:id",
  authMiddleware,
  catalogEditorsOnly,
  async (req, res) => {
    try {
      const { id } = req.params;

      const [existing] = await db.query(
        `SELECT id, medicine_name FROM medicine_data WHERE id = ? LIMIT 1`,
        [id]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found",
        });
      }

      await db.query(
        `UPDATE medicine_data SET status = 'inactive' WHERE id = ?`,
        [id]
      );

      return res.json({
        success: true,
        message: `Medicine '${existing[0].medicine_name}' deactivated`,
      });
    } catch (err) {
      console.error("Delete medicine error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to delete medicine",
      });
    }
  }
);

/* ============================================================
   TOGGLE STATUS
============================================================ */
router.patch(
  "/status/:id",
  authMiddleware,
  catalogEditorsOnly,
  async (req, res) => {
    try {
      const { id } = req.params;

      const [existing] = await db.query(
        `SELECT id, status FROM medicine_data WHERE id = ? LIMIT 1`,
        [id]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found",
        });
      }

      const newStatus =
        existing[0].status === "active" ? "inactive" : "active";

      await db.query(
        `UPDATE medicine_data SET status = ? WHERE id = ?`,
        [newStatus, id]
      );

      return res.json({
        success: true,
        message: `Medicine ${newStatus === "active" ? "activated" : "deactivated"}`,
        data: { id: Number(id), status: newStatus },
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