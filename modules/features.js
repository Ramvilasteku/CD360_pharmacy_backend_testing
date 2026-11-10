const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

// Returns the module_keys array granted to this admin's tenant
async function getAdminModuleKeys(admin_id) {
  const [rows] = await db.execute(
    `SELECT module_keys FROM admin_modules
     WHERE admin_id = ? AND status  = 1 LIMIT 1`,
    [admin_id],
  );
  if (!rows.length) return [];
  const raw = rows[0].module_keys;
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

/* ============================================================
   CREATE FEATURE
============================================================ */
router.post("/post/feature", authMiddleware, async (req, res) => {
  try {
    const {
      feature_key,
      feature_name,
      module_key,
      description,
      display_order,
    } = req.body;

    if (!feature_key || !feature_name || !module_key) {
      return res.status(400).json({
        success: false,
        message: "feature_key, feature_name and module_key are required",
      });
    }

    const normalizedKey = feature_key.trim().toLowerCase();
    const normalizedModule = module_key.trim().toLowerCase();

    if (normalizedKey.length > 100 || normalizedModule.length > 50) {
      return res.status(400).json({
        success: false,
        message:
          "feature_key (max 100) or module_key (max 50) exceeds allowed length",
      });
    }

    const [existing] = await db.execute(
      `SELECT id FROM features WHERE feature_key = ? LIMIT 1`,
      [normalizedKey],
    );
    if (existing.length) {
      return res.status(409).json({
        success: false,
        message: `Feature '${normalizedKey}' already exists`,
      });
    }

    const [result] = await db.execute(
      `INSERT INTO features
          (feature_key, feature_name, module_key, description, display_order, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
      [
        normalizedKey,
        feature_name.trim(),
        normalizedModule,
        description?.trim() || null,
        Number(display_order) || 0,
      ],
    );

    return res.status(201).json({
      success: true,
      message: "Feature created successfully",
      data: {
        id: result.insertId,
        feature_key: normalizedKey,
        feature_name: feature_name.trim(),
        module_key: normalizedModule,
      },
    });
  } catch (err) {
    console.error("createFeature error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create feature" });
  }
});

/* ============================================================
   LIST FEATURES without admin
============================================================ */
router.get("/getall/features/superadmin", authMiddleware, async (req, res) => {
  try {
    const module_key = (req.query.module_key || "").trim();
    const search = (req.query.search || "").trim();
    const is_active = req.query.is_active;

    let sql = `SELECT id, feature_key, feature_name, module_key, description,
                        display_order, is_active, created_at
                 FROM features WHERE 1=1`;
    const params = [];

    if (module_key) {
      sql += ` AND module_key = ?`;
      params.push(module_key);
    }
    if (is_active === "1" || is_active === "0") {
      sql += ` AND is_active = ?`;
      params.push(Number(is_active));
    }
    if (search) {
      sql += ` AND (feature_name LIKE ? OR feature_key LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY module_key ASC, display_order ASC, feature_name ASC`;

    const [rows] = await db.execute(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("listFeatures error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch features" });
  }
});

/* ============================================================
   LIST FEATURES by own admin
============================================================ */
router.get(
  "/getall/features/admin",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = req.user.id;

      // Scope: only features under modules this admin's tenant has been granted
      const grantedModules = await getAdminModuleKeys(admin_id);
      if (!grantedModules.length) {
        return res.json({ success: true, data: [] });
      }

      const module_key = (req.query.module_key || "").trim();
      const search = (req.query.search || "").trim();
      const is_active = req.query.is_active;

      // If admin requests a specific module_key they don't have, return empty
      if (module_key && !grantedModules.includes(module_key)) {
        return res.json({ success: true, data: [] });
      }

      // db.query (not execute) — needed for IN (?) with array expansion
      let sql = `SELECT id, feature_key, feature_name, module_key, description,
                        display_order, is_active, created_at
                 FROM features WHERE module_key IN (?)`;
      const params = [grantedModules];

      if (module_key) {
        sql += ` AND module_key = ?`;
        params.push(module_key);
      }
      if (is_active === "1" || is_active === "0") {
        sql += ` AND is_active = ?`;
        params.push(Number(is_active));
      }
      if (search) {
        sql += ` AND (feature_name LIKE ? OR feature_key LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
      }

      sql += ` ORDER BY module_key ASC, display_order ASC, feature_name ASC`;

      const [rows] = await db.query(sql, params);
      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("listFeatures error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to fetch features" });
    }
  },
);

/* ============================================================
   GET ONE FEATURE with out admin
============================================================ */
router.get(
  "/get/feature/superadmin/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const [rows] = await db.execute(
        `SELECT id, feature_key, feature_name, module_key, description,
                display_order, is_active, created_at
         FROM features WHERE id = ? LIMIT 1`,
        [id],
      );
      if (!rows.length) {
        return res
          .status(404)
          .json({ success: false, message: "Feature not found" });
      }
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      console.error("getFeatureById error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to fetch feature" });
    }
  },
);

/* ============================================================
   GET ONE FEATURE by own admin
============================================================ */
router.get(
  "/get/feature/admin/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = req.user.id;
      const { id } = req.params;

      const [rows] = await db.execute(
        `SELECT id, feature_key, feature_name, module_key, description,
                display_order, is_active, created_at
         FROM features WHERE id = ? LIMIT 1`,
        [id],
      );
      if (!rows.length) {
        return res
          .status(404)
          .json({ success: false, message: "Feature not found" });
      }

      // Enforce scope: feature must belong to a module this admin's tenant has
      const grantedModules = await getAdminModuleKeys(admin_id);
      if (!grantedModules.includes(rows[0].module_key)) {
        return res
          .status(404)
          .json({ success: false, message: "Feature not found" });
      }

      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      console.error("getFeatureById error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to fetch feature" });
    }
  },
);

/* ============================================================
   UPDATE FEATURE
   NOTE: feature_key is not updatable — it's referenced in JWT arrays and
   route middleware calls. Renaming would silently break access checks.
============================================================ */
router.put("/update/feature/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { feature_name, module_key, description, display_order } = req.body;
    // Accept is_active (matches the column); fall back to the old `status`
    // body field so existing frontend calls keep working.
    const is_active =
      req.body.is_active !== undefined ? req.body.is_active : req.body.status;

    const [existing] = await db.execute(
      `SELECT id FROM features WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!existing.length) {
      return res
        .status(404)
        .json({ success: false, message: "Feature not found" });
    }

    const fields = [];
    const params = [];

    if (feature_name !== undefined) {
      if (!feature_name.trim()) {
        return res
          .status(400)
          .json({ success: false, message: "feature_name cannot be empty" });
      }
      fields.push("feature_name = ?");
      params.push(feature_name.trim());
    }
    if (module_key !== undefined) {
      const normalizedModule = module_key.trim().toLowerCase();
      if (!normalizedModule || normalizedModule.length > 50) {
        return res.status(400).json({
          success: false,
          message: "module_key must be 1–50 characters",
        });
      }
      fields.push("module_key = ?");
      params.push(normalizedModule);
    }
    if (description !== undefined) {
      fields.push("description = ?");
      params.push(description?.trim() || null);
    }
    if (display_order !== undefined) {
      fields.push("display_order = ?");
      params.push(Number(display_order) || 0);
    }
    if (is_active !== undefined) {
      fields.push("is_active = ?");
      params.push(Number(is_active) === 1 ? 1 : 0);
    }

    if (!fields.length) {
      return res
        .status(400)
        .json({ success: false, message: "No fields to update" });
    }

    params.push(id);
    await db.execute(
      `UPDATE features SET ${fields.join(", ")} WHERE id = ?`,
      params,
    );

    return res.json({ success: true, message: "Feature updated successfully" });
  } catch (err) {
    console.error("updateFeature error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update feature" });
  }
});

/* ============================================================
   DELETE FEATURE (hard delete — blocked while granted to any role)
============================================================ */
router.delete("/delete/feature/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await db.execute(
      `SELECT id FROM features WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!existing.length) {
      return res
        .status(404)
        .json({ success: false, message: "Feature not found" });
    }

    // Block if feature is still granted to any role
    const [grants] = await db.execute(
      `SELECT COUNT(*) AS cnt FROM role_features WHERE feature_id = ?`,
      [id],
    );
    if (grants[0].cnt > 0) {
      return res.status(409).json({
        success: false,
        message: `Feature is granted to ${grants[0].cnt} role(s). Revoke grants before deleting.`,
      });
    }

    const [result] = await db.execute(`DELETE FROM features WHERE id = ?`, [
      id,
    ]);

    if (!result.affectedRows) {
      return res
        .status(404)
        .json({ success: false, message: "Feature not found" });
    }

    return res.json({ success: true, message: "Feature deleted successfully" });
  } catch (err) {
    console.error("deleteFeature error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete feature" });
  }
});

module.exports = router;