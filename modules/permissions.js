const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* ═══════════════════════════════════════════════════════════════
   CREATE PERMISSION
   POST /api/permissions
   ═══════════════════════════════════════════════════════════════ */
router.post("/post/permissions", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { permission_key, permission_name, module_key, feature_key, action } =
    req.body;

  try {
    // ─── STEP 1: Basic validation ───
    if (
      !permission_key ||
      !permission_name ||
      !module_key ||
      !feature_key ||
      !action
    ) {
      return res.status(400).json({
        message:
          "permission_key, permission_name, module_key, feature_key, and action are required",
      });
    }

    // ─── STEP 2: Validate action ───
    const validActions = [
      "view",
      "create",
      "edit",
      "delete",
      "export",
      "approve",
    ];
    if (!validActions.includes(action)) {
      return res.status(400).json({
        message: `action must be one of: ${validActions.join(", ")}`,
      });
    }

    // ─── STEP 3: Validate permission_key format (module.feature.action) ───
    const expectedKey = `${module_key}.${feature_key}.${action}`;
    if (permission_key !== expectedKey) {
      return res.status(400).json({
        message: `permission_key must follow format 'module.feature.action'. Expected: ${expectedKey}`,
      });
    }

    // ─── STEP 4: Check for duplicate permission_key ───
    const [existingRows] = await db.query(
      `SELECT id, is_active FROM permissions WHERE permission_key = ? LIMIT 1`,
      [permission_key],
    );

    if (existingRows.length > 0) {
      const existing = existingRows[0];

      if (existing.is_active === 1) {
        return res.status(409).json({
          message: "This permission already exists",
        });
      } else {
        return res.status(409).json({
          message:
            "This permission previously existed (deactivated). Reactivate it instead of creating new.",
          existingPermissionId: existing.id,
        });
      }
    }

    // ─── STEP 5: Insert new permission ───
    const [result] = await db.query(
      `INSERT INTO permissions 
        (permission_key, permission_name, module_key, feature_key, action, is_active) 
       VALUES (?, ?, ?, ?, ?, 1)`,
      [permission_key, permission_name, module_key, feature_key, action],
    );

    // ─── STEP 6: Return success ───
    return res.status(201).json({
      message: "Permission created successfully",
      data: {
        id: result.insertId,
        permission_key,
        permission_name,
        module_key,
        feature_key,
        action,
        is_active: 1,
      },
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "This permission already exists",
      });
    }

    console.error("Create Permission Error:", err);
    return res.status(500).json({ message: "Failed to create permission" });
  }
});

/* ═══════════════════════════════════════════════════════════════
   GET ALL PERMISSIONS
   GET /api/permissions
   ═══════════════════════════════════════════════════════════════ */
router.get("/getall/permissions", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { module_key, feature_key, action, is_active } = req.query;

  try {
    let query = `SELECT id, permission_key, permission_name, module_key, feature_key, action, is_active, created_at
                 FROM permissions WHERE 1=1`;
    const params = [];

    if (module_key) {
      query += ` AND module_key = ?`;
      params.push(module_key);
    }

    if (feature_key) {
      query += ` AND feature_key = ?`;
      params.push(feature_key);
    }

    if (action) {
      query += ` AND action = ?`;
      params.push(action);
    }

    if (is_active !== undefined) {
      query += ` AND is_active = ?`;
      params.push(is_active === "true" || is_active === "1" ? 1 : 0);
    }

    query += ` ORDER BY module_key ASC, feature_key ASC, action ASC`;

    const [rows] = await db.query(query, params);

    return res.json({ data: rows });
  } catch (err) {
    console.error("Get All Permissions Error:", err);
    return res.status(500).json({
      message: "Failed to fetch permissions",
    });
  }
});

/* ═══════════════════════════════════════════════════════════════
   GET PERMISSIONS BY MODULE
   GET /api/permissions/module/:moduleKey
   ═══════════════════════════════════════════════════════════════ */
router.get(
  "/get/module/:moduleKey",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { moduleKey } = req.params;

    try {
      const [rows] = await db.query(
        `SELECT id, permission_key, permission_name, module_key, feature_key, action, is_active, created_at
         FROM permissions 
         WHERE module_key = ?
         ORDER BY feature_key ASC, action ASC`,
        [moduleKey],
      );

      return res.json({ data: rows });
    } catch (err) {
      console.error("Get Permissions By Module Error:", err);
      return res.status(500).json({
        message: "Failed to fetch permissions for module",
      });
    }
  },
);

/* ═══════════════════════════════════════════════════════════════
   GET PERMISSIONS BY FEATURE
   GET /api/permissions/feature/:featureKey
   ═══════════════════════════════════════════════════════════════ */
router.get(
  "/get/feature/:featureKey",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { featureKey } = req.params;

    try {
      const [rows] = await db.query(
        `SELECT id, permission_key, permission_name, module_key, feature_key, action, is_active, created_at
         FROM permissions 
         WHERE feature_key = ?
         ORDER BY action ASC`,
        [featureKey],
      );

      return res.json({ data: rows });
    } catch (err) {
      console.error("Get Permissions By Feature Error:", err);
      return res.status(500).json({
        message: "Failed to fetch permissions for feature",
      });
    }
  },
);

/* ═══════════════════════════════════════════════════════════════
   GET SINGLE PERMISSION BY ID
   GET /api/permissions/:id
   ═══════════════════════════════════════════════════════════════ */
router.get("/get/:id", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { id: permissionId } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT id, permission_key, permission_name, module_key, feature_key, action, is_active, created_at
       FROM permissions 
       WHERE id = ?
       LIMIT 1`,
      [permissionId],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Permission not found" });
    }

    return res.json({ data: rows[0] });
  } catch (err) {
    console.error("Get Permission By Id Error:", err);
    return res.status(500).json({ message: "Failed to fetch permission" });
  }
});

/* ═══════════════════════════════════════════════════════════════
   UPDATE PERMISSION
   PUT /api/permissions/:id
   ═══════════════════════════════════════════════════════════════ */
router.put("/update/:id", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { id: permissionId } = req.params;
  const { permission_name } = req.body;

  try {
    // Verify permission exists
    const [rows] = await db.query(
      `SELECT id, permission_key FROM permissions WHERE id = ? LIMIT 1`,
      [permissionId],
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Permission not found" });
    }

    if (!permission_name) {
      return res.status(400).json({
        message: "permission_name is required for update",
      });
    }

    const [result] = await db.query(
      `UPDATE permissions 
       SET permission_name = ?
       WHERE id = ?`,
      [permission_name, permissionId],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Permission not found" });
    }

    return res.json({
      message: "Permission updated successfully",
      data: {
        id: Number(permissionId),
        permission_name,
      },
    });
  } catch (err) {
    console.error("Update Permission Error:", err);
    return res.status(500).json({ message: "Failed to update permission" });
  }
});

/* ═══════════════════════════════════════════════════════════════
   DEACTIVATE PERMISSION
   PUT /api/permissions/:id/deactivate
   ═══════════════════════════════════════════════════════════════ */
router.put(
  "/update/:id/deactivate",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { id: permissionId } = req.params;

    try {
      const [rows] = await db.query(
        `SELECT id FROM permissions WHERE id = ? LIMIT 1`,
        [permissionId],
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Permission not found" });
      }

      const [result] = await db.query(
        `UPDATE permissions SET is_active = 0 WHERE id = ?`,
        [permissionId],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Permission not found" });
      }

      return res.json({ message: "Permission deactivated successfully" });
    } catch (err) {
      console.error("Deactivate Permission Error:", err);
      return res.status(500).json({
        message: "Failed to deactivate permission",
      });
    }
  },
);

/* ═══════════════════════════════════════════════════════════════
   ACTIVATE PERMISSION
   PUT /api/permissions/:id/activate
   ═══════════════════════════════════════════════════════════════ */
router.put(
  "/update/:id/activate",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { id: permissionId } = req.params;

    try {
      const [rows] = await db.query(
        `SELECT id FROM permissions WHERE id = ? LIMIT 1`,
        [permissionId],
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Permission not found" });
      }

      const [result] = await db.query(
        `UPDATE permissions SET is_active = 1 WHERE id = ?`,
        [permissionId],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Permission not found" });
      }

      return res.json({ message: "Permission activated successfully" });
    } catch (err) {
      console.error("Activate Permission Error:", err);
      return res.status(500).json({
        message: "Failed to activate permission",
      });
    }
  },
);

/* ═══════════════════════════════════════════════════════════════
   DELETE PERMISSION (HARD DELETE)
   DELETE /api/permissions/:id
   ═══════════════════════════════════════════════════════════════ */
router.delete("/delete/:id", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { id: permissionId } = req.params;

  try {
    // Check if permission is in use by any role_permissions
    const [usageRows] = await db.query(
      `SELECT COUNT(*) as usage_count FROM role_permissions WHERE permission_id = ?`,
      [permissionId],
    );

    if (usageRows[0].usage_count > 0) {
      return res.status(409).json({
        message: `Cannot delete: this permission is used by ${usageRows[0].usage_count} role(s). Deactivate it instead.`,
      });
    }

    const [result] = await db.query(`DELETE FROM permissions WHERE id = ?`, [
      permissionId,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Permission not found" });
    }

    return res.json({ message: "Permission deleted successfully" });
  } catch (err) {
    console.error("Delete Permission Error:", err);
    return res.status(500).json({ message: "Failed to delete permission" });
  }
});

/* ═══════════════════════════════════════════════════════════════
   BULK CREATE PERMISSIONS
   POST /api/permissions/bulk
   ═══════════════════════════════════════════════════════════════ */
router.post("/post/bulk/permissions", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { permissions } = req.body;

  try {
    if (
      !permissions ||
      !Array.isArray(permissions) ||
      permissions.length === 0
    ) {
      return res.status(400).json({
        message: "permissions array is required and must not be empty",
      });
    }

    if (permissions.length > 100) {
      return res.status(400).json({
        message: "Cannot create more than 100 permissions at once",
      });
    }

    const validActions = [
      "view",
      "create",
      "edit",
      "delete",
      "export",
      "approve",
    ];
    const created = [];
    const skipped = [];
    const errors = [];

    for (const perm of permissions) {
      const {
        permission_key,
        permission_name,
        module_key,
        feature_key,
        action,
      } = perm;

      // Validate each permission
      if (
        !permission_key ||
        !permission_name ||
        !module_key ||
        !feature_key ||
        !action
      ) {
        errors.push({
          permission_key: permission_key || "unknown",
          error: "Missing required fields",
        });
        continue;
      }

      if (!validActions.includes(action)) {
        errors.push({ permission_key, error: `Invalid action: ${action}` });
        continue;
      }

      const expectedKey = `${module_key}.${feature_key}.${action}`;
      if (permission_key !== expectedKey) {
        errors.push({
          permission_key,
          error: `Key format mismatch. Expected: ${expectedKey}`,
        });
        continue;
      }

      try {
        const [existing] = await db.query(
          `SELECT id FROM permissions WHERE permission_key = ? LIMIT 1`,
          [permission_key],
        );

        if (existing.length > 0) {
          skipped.push({ permission_key, reason: "Already exists" });
          continue;
        }

        const [result] = await db.query(
          `INSERT INTO permissions 
            (permission_key, permission_name, module_key, feature_key, action, is_active) 
           VALUES (?, ?, ?, ?, ?, 1)`,
          [permission_key, permission_name, module_key, feature_key, action],
        );

        created.push({
          id: result.insertId,
          permission_key,
          permission_name,
        });
      } catch (dbErr) {
        errors.push({ permission_key, error: dbErr.message });
      }
    }

    return res.status(201).json({
      message: "Bulk permission creation completed",
      summary: {
        total: permissions.length,
        created: created.length,
        skipped: skipped.length,
        errors: errors.length,
      },
      created,
      skipped,
      errors,
    });
  } catch (err) {
    console.error("Bulk Create Permissions Error:", err);
    return res.status(500).json({
      message: "Failed to bulk create permissions",
    });
  }
});

module.exports = router;
