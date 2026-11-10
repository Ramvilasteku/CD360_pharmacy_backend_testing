const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");

/* ═══════════════════════════════════════════════════════════════
   CREATE ASSIGNMENT
   POST /api/user-role-assignments
   ═══════════════════════════════════════════════════════════════ */
router.post("/", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { user_id, user_type, role_id, is_primary } = req.body;
  const { id, role: userRole, adminId } = req.user;

  const admin_id = userRole === "admin" ? id : adminId;
  const assigned_by = id;

  try {
    // ─── STEP 1: Basic validation ───
    if (!user_id || !user_type || !role_id) {
      return res.status(400).json({
        message: "user_id, user_type, and role_id are required",
      });
    }

    const validUserTypes = ["admin", "staff", "client"];
    if (!validUserTypes.includes(user_type)) {
      return res.status(400).json({
        message: "user_type must be one of: admin, staff, client",
      });
    }

    const isPrimaryFlag = is_primary === true || is_primary === 1 ? 1 : 0;

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
        message: "You cannot assign roles from another organization",
      });
    }

    if (role.status !== 1) {
      return res.status(400).json({
        message: "This role is inactive and cannot be assigned",
      });
    }

    // ─── STEP 3: Verify target user exists AND belongs to this admin ───
    let userTable;
    if (user_type === "admin") userTable = "admins";
    else if (user_type === "staff") userTable = "staff";
    else userTable = "clients";

    const [userRows] = await db.query(
      `SELECT id, name, admin_id 
       FROM ${userTable} 
       WHERE id = ? LIMIT 1`,
      [user_id]
    );

    if (!userRows.length) {
      return res.status(404).json({
        message: `${user_type} with id ${user_id} not found`,
      });
    }

    const targetUser = userRows[0];

    if (user_type !== "admin" && targetUser.admin_id !== admin_id) {
      return res.status(403).json({
        message: "You cannot assign roles to users from another organization",
      });
    }

    // ─── STEP 4: Check for duplicate ───
    const [existingRows] = await db.query(
      `SELECT id, status 
       FROM user_role_assignments 
       WHERE user_id = ? AND user_type = ? AND role_id = ? LIMIT 1`,
      [user_id, user_type, role_id]
    );

    if (existingRows.length > 0) {
      const existing = existingRows[0];

      if (existing.status === 1) {
        return res.status(409).json({
          message: "This user already has this role",
        });
      } else {
        return res.status(409).json({
          message:
            "This user previously had this role (deactivated). Reactivate it instead of creating new.",
          existingAssignmentId: existing.id,
        });
      }
    }

    // ─── STEP 5: Unset existing primary if new one is primary ───
    if (isPrimaryFlag === 1) {
      await db.query(
        `UPDATE user_role_assignments 
         SET is_primary = 0, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND user_type = ? AND is_primary = 1`,
        [user_id, user_type]
      );
    }

    // ─── STEP 6: Insert new assignment ───
    const [result] = await db.query(
      `INSERT INTO user_role_assignments 
        (user_id, user_type, role_id, is_primary, assigned_by, status) 
       VALUES (?, ?, ?, ?, ?, 1)`,
      [user_id, user_type, role_id, isPrimaryFlag, assigned_by]
    );

    // ─── STEP 7: Return success ───
    return res.status(201).json({
      message: "Role assigned successfully",
      data: {
        id: result.insertId,
        user_id: Number(user_id),
        user_type,
        role_id: Number(role_id),
        role_key: role.role_key,
        role_name: role.role_name,
        user_name: targetUser.name,
        is_primary: isPrimaryFlag === 1,
        assigned_by,
        status: 1,
      },
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "This user already has this role",
      });
    }

    console.error("Create Assignment Error:", err);
    return res.status(500).json({ message: "Failed to assign role" });
  }
});

/* ═══════════════════════════════════════════════════════════════
   GET ROLES FOR A USER
   GET /api/user-role-assignments/user/:userType/:userId
   ═══════════════════════════════════════════════════════════════ */
router.get(
  "/user/:userType/:userId",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { userType, userId } = req.params;
    const { id, role: userRole, adminId } = req.user;

    try {
      const admin_id = userRole === "admin" ? id : adminId;

      const validUserTypes = ["admin", "staff", "client"];
      if (!validUserTypes.includes(userType)) {
        return res.status(400).json({
          message: "userType must be one of: admin, staff, client",
        });
      }

      // ─── Get RBAC assignments ───
      const [rows] = await db.query(
        `SELECT ura.id, ura.user_id, ura.user_type, ura.role_id,
                r.role_key, r.role_name, r.description,
                ura.is_primary, ura.assigned_by, ura.status,
                ura.created_at, ura.updated_at
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         WHERE ura.user_id = ? AND ura.user_type = ? AND r.admin_id = ?
         ORDER BY ura.is_primary DESC, ura.created_at ASC`,
        [userId, userType, admin_id]
      );

      // ─── ALSO fetch legacy role for staff ───
      let legacyRole = null;
      if (userType === "staff") {
        const [staffRows] = await db.query(
          `SELECT role FROM staff WHERE id = ? AND admin_id = ? LIMIT 1`,
          [userId, admin_id]
        );
        if (staffRows.length > 0) {
          legacyRole = staffRows[0].role;
        }
      }

      // ─── Check if legacy role is missing from assignments ───
      const rbacRoleKeys = rows.map((r) => r.role_key);
      const hasLegacyRoleInRbac = legacyRole && rbacRoleKeys.includes(legacyRole);

      return res.json({
        data: rows,
        legacyRole: legacyRole,
        legacyRoleInRbac: hasLegacyRoleInRbac,
        needsMigration: legacyRole && !hasLegacyRoleInRbac,
      });
    } catch (err) {
      console.error("Get Assignments By User Error:", err);
      return res.status(500).json({
        message: "Failed to fetch assignments",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   GET USERS FOR A ROLE
   GET /api/user-role-assignments/role/:roleId
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
        `SELECT id FROM roles WHERE id = ? AND admin_id = ? LIMIT 1`,
        [roleId, admin_id]
      );

      if (!roleRows.length) {
        return res.status(404).json({ message: "Role not found" });
      }

      const [rows] = await db.query(
        `SELECT 
           ura.id,
           ura.user_id,
           ura.user_type,
           CASE ura.user_type
             WHEN 'admin' THEN a.name
             WHEN 'staff' THEN s.name
             WHEN 'client' THEN c.name
           END AS user_name,
           CASE ura.user_type
             WHEN 'admin' THEN a.email
             WHEN 'staff' THEN s.email
             WHEN 'client' THEN c.email
           END AS user_email,
           CASE ura.user_type
             WHEN 'staff' THEN s.branch
             ELSE NULL
           END AS branch,
           ura.is_primary,
           ura.status,
           ura.created_at
         FROM user_role_assignments ura
         LEFT JOIN admins a ON ura.user_type = 'admin' AND ura.user_id = a.id
         LEFT JOIN staff s ON ura.user_type = 'staff' AND ura.user_id = s.id
         LEFT JOIN clients c ON ura.user_type = 'client' AND ura.user_id = c.id
         WHERE ura.role_id = ?
         ORDER BY ura.created_at DESC`,
        [roleId]
      );

      return res.json({ data: rows });
    } catch (err) {
      console.error("Get Users By Role Error:", err);
      return res.status(500).json({
        message: "Failed to fetch users for role",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   GET SINGLE ASSIGNMENT BY ID
   GET /api/user-role-assignments/:id
   ═══════════════════════════════════════════════════════════════ */
router.get("/:id", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { id: assignmentId } = req.params;
  const { id, role: userRole, adminId } = req.user;

  try {
    const admin_id = userRole === "admin" ? id : adminId;

    const [rows] = await db.query(
      `SELECT 
         ura.id,
         ura.user_id,
         ura.user_type,
         ura.role_id,
         r.role_key,
         r.role_name,
         r.description,
         ura.is_primary,
         ura.assigned_by,
         ura.status,
         ura.created_at,
         ura.updated_at
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       WHERE ura.id = ? AND r.admin_id = ?
       LIMIT 1`,
      [assignmentId, admin_id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    return res.json({ data: rows[0] });
  } catch (err) {
    console.error("Get Assignment By Id Error:", err);
    return res.status(500).json({ message: "Failed to fetch assignment" });
  }
});

/* ═══════════════════════════════════════════════════════════════
   SET PRIMARY ROLE
   PUT /api/user-role-assignments/:id/set-primary
   ═══════════════════════════════════════════════════════════════ */
router.put(
  "/:id/set-primary",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { id: assignmentId } = req.params;
    const { id, role: userRole, adminId } = req.user;

    try {
      const admin_id = userRole === "admin" ? id : adminId;

      const [rows] = await db.query(
        `SELECT ura.id, ura.user_id, ura.user_type, ura.role_id, ura.status, r.admin_id 
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         WHERE ura.id = ? LIMIT 1`,
        [assignmentId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Assignment not found" });
      }

      const assignment = rows[0];

      if (assignment.admin_id !== admin_id) {
        return res.status(403).json({
          message: "You cannot modify assignments from another organization",
        });
      }

      if (assignment.status !== 1) {
        return res.status(400).json({
          message: "Cannot set inactive assignment as primary",
        });
      }

      // Unset previous primary for this user
      await db.query(
        `UPDATE user_role_assignments 
         SET is_primary = 0, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND user_type = ? AND is_primary = 1`,
        [assignment.user_id, assignment.user_type]
      );

      // Set this one as primary
      await db.query(
        `UPDATE user_role_assignments 
         SET is_primary = 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [assignmentId]
      );

      return res.json({ message: "Primary role updated successfully" });
    } catch (err) {
      console.error("Set Primary Role Error:", err);
      return res.status(500).json({ message: "Failed to set primary role" });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   DEACTIVATE ASSIGNMENT
   PUT /api/user-role-assignments/:id/deactivate
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

      const [rows] = await db.query(
        `SELECT ura.id, ura.is_primary, r.admin_id 
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         WHERE ura.id = ? LIMIT 1`,
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
        `UPDATE user_role_assignments 
         SET status = 0, is_primary = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [assignmentId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Assignment not found" });
      }

      return res.json({ message: "Assignment deactivated successfully" });
    } catch (err) {
      console.error("Deactivate Assignment Error:", err);
      return res.status(500).json({
        message: "Failed to deactivate assignment",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   ACTIVATE ASSIGNMENT
   PUT /api/user-role-assignments/:id/activate
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

      const [rows] = await db.query(
        `SELECT ura.id, r.admin_id, r.status AS role_status 
         FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         WHERE ura.id = ? LIMIT 1`,
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

      if (rows[0].role_status !== 1) {
        return res.status(400).json({
          message: "Cannot activate — the underlying role is inactive",
        });
      }

      const [result] = await db.query(
        `UPDATE user_role_assignments 
         SET status = 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [assignmentId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Assignment not found" });
      }

      return res.json({ message: "Assignment activated successfully" });
    } catch (err) {
      console.error("Activate Assignment Error:", err);
      return res.status(500).json({
        message: "Failed to activate assignment",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   DELETE ASSIGNMENT (HARD DELETE)
   DELETE /api/user-role-assignments/:id
   ═══════════════════════════════════════════════════════════════ */
router.delete("/:id", authMiddleware, allowRoles("admin"), async (req, res) => {
  const { id: assignmentId } = req.params;
  const { id, role: userRole, adminId } = req.user;

  try {
    const admin_id = userRole === "admin" ? id : adminId;

    const [rows] = await db.query(
      `SELECT ura.id, r.admin_id 
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       WHERE ura.id = ? LIMIT 1`,
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
      `DELETE FROM user_role_assignments WHERE id = ?`,
      [assignmentId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    return res.json({ message: "Assignment deleted successfully" });
  } catch (err) {
    console.error("Delete Assignment Error:", err);
    return res.status(500).json({ message: "Failed to delete assignment" });
  }
});

module.exports = router;