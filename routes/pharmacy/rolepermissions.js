const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");

/* ═══════════════════════════════════════════════════════════════
   ASSIGN PERMISSION TO ROLE
   POST /api/role-permissions
   ═══════════════════════════════════════════════════════════════ */
router.post("/", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { role_id, permission_id } = req.body;
  const { id, role: userRole, adminId } = req.user;

  const admin_id = userRole === "admin" ? id : adminId;

  try {
    // ─── STEP 1: Basic validation ───
    if (!role_id || !permission_id) {
      return res.status(400).json({
        message: "role_id and permission_id are required",
      });
    }

    // ─── STEP 2: Verify role exists AND belongs to this admin ───
    const [roleRows] = await db.query(
      `SELECT id, admin_id, role_key, role_name, status 
       FROM roles 
       WHERE id = ? LIMIT 1`,
      [role_id]
    );

    if (!roleRows.length) {
      return res.status(404).json({ message: "Role not found" });
    }

    const role = roleRows[0];

    if (role.admin_id !== admin_id) {
      return res.status(403).json({
        message: "You cannot modify roles from another organization",
      });
    }

    if (role.status !== 1) {
      return res.status(400).json({
        message: "This role is inactive and cannot be modified",
      });
    }

    // ─── STEP 3: Verify permission exists AND is active ───
    const [permRows] = await db.query(
      `SELECT id, permission_key, permission_name, module_key, feature_key, action, is_active 
       FROM permissions 
       WHERE id = ? LIMIT 1`,
      [permission_id]
    );

    if (!permRows.length) {
      return res.status(404).json({ message: "Permission not found" });
    }

    const permission = permRows[0];

    if (permission.is_active !== 1) {
      return res.status(400).json({
        message: "This permission is inactive and cannot be assigned",
      });
    }

    // ─── STEP 4: Check for duplicate ───
    const [existingRows] = await db.query(
      `SELECT id, status 
       FROM role_permissions 
       WHERE role_id = ? AND permission_id = ? LIMIT 1`,
      [role_id, permission_id]
    );

    if (existingRows.length > 0) {
      const existing = existingRows[0];

      if (existing.status === 1) {
        return res.status(409).json({
          message: "This role already has this permission",
        });
      } else {
        return res.status(409).json({
          message: "This role previously had this permission (deactivated). Reactivate it instead of creating new.",
          existingAssignmentId: existing.id,
        });
      }
    }

    // ─── STEP 5: Insert new assignment ───
    const [result] = await db.query(
      `INSERT INTO role_permissions 
        (role_id, permission_id, status) 
       VALUES (?, ?, 1)`,
      [role_id, permission_id]
    );

    // ─── STEP 6: Return success ───
    return res.status(201).json({
      message: "Permission assigned to role successfully",
      data: {
        id: result.insertId,
        role_id: Number(role_id),
        permission_id: Number(permission_id),
        role_key: role.role_key,
        role_name: role.role_name,
        permission_key: permission.permission_key,
        permission_name: permission.permission_name,
        module_key: permission.module_key,
        feature_key: permission.feature_key,
        action: permission.action,
        status: 1,
      },
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "This role already has this permission",
      });
    }

    console.error("Create Role Permission Error:", err);
    return res.status(500).json({ message: "Failed to assign permission" });
  }
});

/* ═══════════════════════════════════════════════════════════════
   BULK ASSIGN PERMISSIONS TO ROLE
   POST /api/role-permissions/bulk
   ═══════════════════════════════════════════════════════════════ */
router.post("/bulk", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { role_id, permission_ids } = req.body;
  const { id, role: userRole, adminId } = req.user;

  const admin_id = userRole === "admin" ? id : adminId;

  try {
    // ─── STEP 1: Basic validation ───
    if (!role_id) {
      return res.status(400).json({ message: "role_id is required" });
    }

    if (!permission_ids || !Array.isArray(permission_ids) || permission_ids.length === 0) {
      return res.status(400).json({
        message: "permission_ids array is required and must not be empty",
      });
    }

    if (permission_ids.length > 100) {
      return res.status(400).json({
        message: "Cannot assign more than 100 permissions at once",
      });
    }

    // ─── STEP 2: Verify role belongs to admin ───
    const [roleRows] = await db.query(
      `SELECT id, admin_id, role_key, status FROM roles WHERE id = ? LIMIT 1`,
      [role_id]
    );

    if (!roleRows.length) {
      return res.status(404).json({ message: "Role not found" });
    }

    if (roleRows[0].admin_id !== admin_id) {
      return res.status(403).json({
        message: "You cannot modify roles from another organization",
      });
    }

    if (roleRows[0].status !== 1) {
      return res.status(400).json({
        message: "This role is inactive and cannot be modified",
      });
    }

    // ─── STEP 3: Process each permission ───
    const assigned = [];
    const skipped = [];
    const errors = [];

    for (const permission_id of permission_ids) {
      try {
        // Verify permission exists and is active
        const [permRows] = await db.query(
          `SELECT id, permission_key, is_active FROM permissions WHERE id = ? LIMIT 1`,
          [permission_id]
        );

        if (!permRows.length) {
          errors.push({ permission_id, error: "Permission not found" });
          continue;
        }

        if (permRows[0].is_active !== 1) {
          errors.push({ permission_id, error: "Permission is inactive" });
          continue;
        }

        // Check duplicate
        const [existing] = await db.query(
          `SELECT id, status FROM role_permissions WHERE role_id = ? AND permission_id = ? LIMIT 1`,
          [role_id, permission_id]
        );

        if (existing.length > 0) {
          if (existing[0].status === 1) {
            skipped.push({
              permission_id,
              permission_key: permRows[0].permission_key,
              reason: "Already assigned",
            });
            continue;
          } else {
            // Reactivate existing
            await db.query(
              `UPDATE role_permissions SET status = 1 WHERE id = ?`,
              [existing[0].id]
            );
            assigned.push({
              id: existing[0].id,
              permission_id,
              permission_key: permRows[0].permission_key,
              action: "reactivated",
            });
            continue;
          }
        }

        // Insert new
        const [result] = await db.query(
          `INSERT INTO role_permissions (role_id, permission_id, status) VALUES (?, ?, 1)`,
          [role_id, permission_id]
        );

        assigned.push({
          id: result.insertId,
          permission_id,
          permission_key: permRows[0].permission_key,
          action: "created",
        });
      } catch (dbErr) {
        errors.push({ permission_id, error: dbErr.message });
      }
    }

    return res.status(201).json({
      message: "Bulk permission assignment completed",
      summary: {
        total: permission_ids.length,
        assigned: assigned.length,
        skipped: skipped.length,
        errors: errors.length,
      },
      role_id: Number(role_id),
      role_key: roleRows[0].role_key,
      assigned,
      skipped,
      errors,
    });
  } catch (err) {
    console.error("Bulk Create Role Permissions Error:", err);
    return res.status(500).json({
      message: "Failed to bulk assign permissions",
    });
  }
});

/* ═══════════════════════════════════════════════════════════════
   GET PERMISSIONS FOR A ROLE
   GET /api/role-permissions/role/:roleId
   ═══════════════════════════════════════════════════════════════ */
router.get(
  "/role/:roleId",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { roleId } = req.params;
    const { id, role: userRole, adminId } = req.user;

    try {
      const admin_id = userRole === "admin" ? id : adminId;

      // Verify role belongs to this admin
      const [roleRows] = await db.query(
        `SELECT id, role_key, role_name FROM roles WHERE id = ? AND admin_id = ? LIMIT 1`,
        [roleId, admin_id]
      );

      if (!roleRows.length) {
        return res.status(404).json({ message: "Role not found" });
      }

      const [rows] = await db.query(
        `SELECT 
           rp.id,
           rp.role_id,
           rp.permission_id,
           p.permission_key,
           p.permission_name,
           p.module_key,
           p.feature_key,
           p.action,
           p.is_active AS permission_is_active,
           rp.status,
           rp.created_at
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ?
         ORDER BY p.module_key ASC, p.feature_key ASC, p.action ASC`,
        [roleId]
      );

      return res.json({
        role: {
          id: roleRows[0].id,
          role_key: roleRows[0].role_key,
          role_name: roleRows[0].role_name,
        },
        data: rows,
      });
    } catch (err) {
      console.error("Get Permissions By Role Error:", err);
      return res.status(500).json({
        message: "Failed to fetch permissions for role",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   GET ROLES FOR A PERMISSION
   GET /api/role-permissions/permission/:permissionId
   ═══════════════════════════════════════════════════════════════ */
router.get(
  "/permission/:permissionId",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { permissionId } = req.params;
    const { id, role: userRole, adminId } = req.user;

    try {
      const admin_id = userRole === "admin" ? id : adminId;

      // Verify permission exists
      const [permRows] = await db.query(
        `SELECT id, permission_key, permission_name FROM permissions WHERE id = ? LIMIT 1`,
        [permissionId]
      );

      if (!permRows.length) {
        return res.status(404).json({ message: "Permission not found" });
      }

      const [rows] = await db.query(
        `SELECT 
           rp.id,
           rp.role_id,
           rp.permission_id,
           r.role_key,
           r.role_name,
           r.description,
           r.admin_id,
           rp.status,
           rp.created_at
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         WHERE rp.permission_id = ? AND r.admin_id = ?
         ORDER BY r.role_name ASC`,
        [permissionId, admin_id]
      );

      return res.json({
        permission: {
          id: permRows[0].id,
          permission_key: permRows[0].permission_key,
          permission_name: permRows[0].permission_name,
        },
        data: rows,
      });
    } catch (err) {
      console.error("Get Roles By Permission Error:", err);
      return res.status(500).json({
        message: "Failed to fetch roles for permission",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   GET PERMISSIONS BY MODULE FOR A ROLE
   GET /api/role-permissions/role/:roleId/module/:moduleKey
   ═══════════════════════════════════════════════════════════════ */
router.get(
  "/role/:roleId/module/:moduleKey",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { roleId, moduleKey } = req.params;
    const { id, role: userRole, adminId } = req.user;

    try {
      const admin_id = userRole === "admin" ? id : adminId;

      // Verify role belongs to admin
      const [roleRows] = await db.query(
        `SELECT id FROM roles WHERE id = ? AND admin_id = ? LIMIT 1`,
        [roleId, admin_id]
      );

      if (!roleRows.length) {
        return res.status(404).json({ message: "Role not found" });
      }

      const [rows] = await db.query(
        `SELECT 
           rp.id,
           rp.role_id,
           rp.permission_id,
           p.permission_key,
           p.permission_name,
           p.feature_key,
           p.action,
           rp.status
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.module_key = ?
         ORDER BY p.feature_key ASC, p.action ASC`,
        [roleId, moduleKey]
      );

      return res.json({ data: rows });
    } catch (err) {
      console.error("Get Role Permissions By Module Error:", err);
      return res.status(500).json({
        message: "Failed to fetch permissions",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   GET SINGLE ROLE-PERMISSION BY ID
   GET /api/role-permissions/:id
   ═══════════════════════════════════════════════════════════════ */
router.get("/:id", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { id: assignmentId } = req.params;
  const { id, role: userRole, adminId } = req.user;

  try {
    const admin_id = userRole === "admin" ? id : adminId;

    const [rows] = await db.query(
      `SELECT 
         rp.id,
         rp.role_id,
         rp.permission_id,
         r.role_key,
         r.role_name,
         p.permission_key,
         p.permission_name,
         p.module_key,
         p.feature_key,
         p.action,
         rp.status,
         rp.created_at
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.id = ? AND r.admin_id = ?
       LIMIT 1`,
      [assignmentId, admin_id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Role-permission assignment not found" });
    }

    return res.json({ data: rows[0] });
  } catch (err) {
    console.error("Get Role Permission By Id Error:", err);
    return res.status(500).json({ message: "Failed to fetch assignment" });
  }
});

/* ═══════════════════════════════════════════════════════════════
   SYNC PERMISSIONS FOR A ROLE (Replace all)
   PUT /api/role-permissions/role/:roleId/sync
   ═══════════════════════════════════════════════════════════════ */
router.put(
  "/role/:roleId/sync",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { roleId } = req.params;
    const { permission_ids } = req.body;
    const { id, role: userRole, adminId } = req.user;

    const admin_id = userRole === "admin" ? id : adminId;

    try {
      if (!Array.isArray(permission_ids)) {
        return res.status(400).json({
          message: "permission_ids must be an array (can be empty to remove all)",
        });
      }

      // Verify role belongs to admin
      const [roleRows] = await db.query(
        `SELECT id, role_key, status FROM roles WHERE id = ? AND admin_id = ? LIMIT 1`,
        [roleId, admin_id]
      );

      if (!roleRows.length) {
        return res.status(404).json({ message: "Role not found" });
      }

      if (roleRows[0].status !== 1) {
        return res.status(400).json({
          message: "This role is inactive and cannot be modified",
        });
      }

      // Get current permissions
      const [currentRows] = await db.query(
        `SELECT permission_id FROM role_permissions WHERE role_id = ? AND status = 1`,
        [roleId]
      );

      const currentPermissionIds = currentRows.map((r) => r.permission_id);
      const newPermissionIds = permission_ids.map((p) => Number(p));

      // Calculate diff
      const toAdd = newPermissionIds.filter((p) => !currentPermissionIds.includes(p));
      const toRemove = currentPermissionIds.filter((p) => !newPermissionIds.includes(p));

      let added = 0;
      let removed = 0;

      // Add new permissions
      for (const permission_id of toAdd) {
        // Verify permission is active
        const [permRows] = await db.query(
          `SELECT id FROM permissions WHERE id = ? AND is_active = 1 LIMIT 1`,
          [permission_id]
        );

        if (permRows.length) {
          // Check if inactive assignment exists (reactivate)
          const [existing] = await db.query(
            `SELECT id FROM role_permissions WHERE role_id = ? AND permission_id = ? LIMIT 1`,
            [roleId, permission_id]
          );

          if (existing.length > 0) {
            await db.query(
              `UPDATE role_permissions SET status = 1 WHERE id = ?`,
              [existing[0].id]
            );
          } else {
            await db.query(
              `INSERT INTO role_permissions (role_id, permission_id, status) VALUES (?, ?, 1)`,
              [roleId, permission_id]
            );
          }
          added++;
        }
      }

      // Deactivate removed permissions (soft delete)
      for (const permission_id of toRemove) {
        await db.query(
          `UPDATE role_permissions SET status = 0 WHERE role_id = ? AND permission_id = ?`,
          [roleId, permission_id]
        );
        removed++;
      }

      return res.json({
        message: "Role permissions synced successfully",
        summary: {
          role_id: Number(roleId),
          role_key: roleRows[0].role_key,
          added,
          removed,
          unchanged: newPermissionIds.length - toAdd.length,
          total_active: newPermissionIds.length,
        },
      });
    } catch (err) {
      console.error("Sync Role Permissions Error:", err);
      return res.status(500).json({
        message: "Failed to sync permissions",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   DEACTIVATE ROLE-PERMISSION
   PUT /api/role-permissions/:id/deactivate
   ═══════════════════════════════════════════════════════════════ */
router.put(
  "/:id/deactivate",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { id: assignmentId } = req.params;
    const { id, role: userRole, adminId } = req.user;

    try {
      const admin_id = userRole === "admin" ? id : adminId;

      // Verify tenant ownership via role
      const [rows] = await db.query(
        `SELECT rp.id, r.admin_id 
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         WHERE rp.id = ? LIMIT 1`,
        [assignmentId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Assignment not found" });
      }

      if (rows[0].admin_id !== admin_id) {
        return res.status(403).json({
          message: "You cannot modify assignments from another organization",
        });
      }

      const [result] = await db.query(
        `UPDATE role_permissions SET status = 0 WHERE id = ?`,
        [assignmentId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Assignment not found" });
      }

      return res.json({ message: "Assignment deactivated successfully" });
    } catch (err) {
      console.error("Deactivate Role Permission Error:", err);
      return res.status(500).json({
        message: "Failed to deactivate assignment",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   ACTIVATE ROLE-PERMISSION
   PUT /api/role-permissions/:id/activate
   ═══════════════════════════════════════════════════════════════ */
router.put(
  "/:id/activate",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { id: assignmentId } = req.params;
    const { id, role: userRole, adminId } = req.user;

    try {
      const admin_id = userRole === "admin" ? id : adminId;

      // Verify tenant ownership + permission is active
      const [rows] = await db.query(
        `SELECT rp.id, r.admin_id, p.is_active AS permission_active 
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.id = ? LIMIT 1`,
        [assignmentId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Assignment not found" });
      }

      if (rows[0].admin_id !== admin_id) {
        return res.status(403).json({
          message: "You cannot modify assignments from another organization",
        });
      }

      if (rows[0].permission_active !== 1) {
        return res.status(400).json({
          message: "Cannot activate — the underlying permission is inactive",
        });
      }

      const [result] = await db.query(
        `UPDATE role_permissions SET status = 1 WHERE id = ?`,
        [assignmentId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Assignment not found" });
      }

      return res.json({ message: "Assignment activated successfully" });
    } catch (err) {
      console.error("Activate Role Permission Error:", err);
      return res.status(500).json({
        message: "Failed to activate assignment",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   DELETE ROLE-PERMISSION (HARD DELETE)
   DELETE /api/role-permissions/:id
   ═══════════════════════════════════════════════════════════════ */
router.delete("/:id", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { id: assignmentId } = req.params;
  const { id, role: userRole, adminId } = req.user;

  try {
    const admin_id = userRole === "admin" ? id : adminId;

    // Verify tenant ownership
    const [rows] = await db.query(
      `SELECT rp.id, r.admin_id 
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       WHERE rp.id = ? LIMIT 1`,
      [assignmentId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    if (rows[0].admin_id !== admin_id) {
      return res.status(403).json({
        message: "You cannot delete assignments from another organization",
      });
    }

    const [result] = await db.query(
      `DELETE FROM role_permissions WHERE id = ?`,
      [assignmentId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    return res.json({ message: "Assignment deleted successfully" });
  } catch (err) {
    console.error("Delete Role Permission Error:", err);
    return res.status(500).json({ message: "Failed to delete assignment" });
  }
});

/* ═══════════════════════════════════════════════════════════════
   REMOVE ALL PERMISSIONS FROM A ROLE
   DELETE /api/role-permissions/role/:roleId/all
   ═══════════════════════════════════════════════════════════════ */
router.delete(
  "/role/:roleId/all",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { roleId } = req.params;
    const { id, role: userRole, adminId } = req.user;

    try {
      const admin_id = userRole === "admin" ? id : adminId;

      // Verify role belongs to admin
      const [roleRows] = await db.query(
        `SELECT id, role_key FROM roles WHERE id = ? AND admin_id = ? LIMIT 1`,
        [roleId, admin_id]
      );

      if (!roleRows.length) {
        return res.status(404).json({ message: "Role not found" });
      }

      const [result] = await db.query(
        `UPDATE role_permissions SET status = 0 WHERE role_id = ?`,
        [roleId]
      );

      return res.json({
        message: "All permissions removed from role successfully",
        role_id: Number(roleId),
        role_key: roleRows[0].role_key,
        affected_count: result.affectedRows,
      });
    } catch (err) {
      console.error("Remove All Role Permissions Error:", err);
      return res.status(500).json({
        message: "Failed to remove permissions",
      });
    }
  }
);

module.exports = router;