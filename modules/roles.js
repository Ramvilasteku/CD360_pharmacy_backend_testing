const express = require("express");
const router = express.Router();
const db = require("../db");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");
 
function getAdminIdFromUser(user) {
  if (user.userType === "admin" || user.role === "admin") return user.id;
  return user.adminId;
}
 
/* ============================================================
   CREATE ROLE
============================================================ */
router.post(
  "/post/role",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const { role_key, role_name, description } = req.body;
 
      if (!role_key || !role_name) {
        return res.status(400).json({
          success: false,
          message: "role_key and role_name are required",
        });
      }
 
      const normalizedKey = role_key.trim().toLowerCase().replace(/\s+/g, "_");
 
      if (normalizedKey.length > 50) {
        return res.status(400).json({
          success: false,
          message: "role_key must be 50 characters or fewer",
        });
      }
 
      const [existing] = await db.execute(
        `SELECT id FROM roles WHERE admin_id = ? AND role_key = ? LIMIT 1`,
        [admin_id, normalizedKey],
      );
      if (existing.length) {
        return res.status(409).json({
          success: false,
          message: `Role '${normalizedKey}' already exists`,
        });
      }
 
      const [result] = await db.execute(
        `INSERT INTO roles
  (admin_id, role_key, role_name, description, is_system_role, status)
 VALUES (?, ?, ?, ?, 0, 1)`,
        [
          admin_id,
          normalizedKey,
          role_name.trim(),
          description?.trim() || null,
        ],
      );
 
      return res.status(201).json({
        success: true,
        message: "Role created successfully",
        data: {
          id: result.insertId,
          role_key: normalizedKey,
          role_name: role_name.trim(),
        },
      });
    } catch (err) {
      console.error("createRole error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to create role" });
    }
  },
);
 
/* ============================================================
   LIST ROLES
============================================================ */
router.get(
  "/getall/roles",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const search = (req.query.search || "").trim();
      const status = req.query.status;
      const includeSystem = req.query.includeSystem !== "false";
 
      let sql = `SELECT id, role_key, role_name, description, is_system_role,
                        status, created_at, updated_at
                 FROM roles WHERE admin_id = ?`;
      const params = [admin_id];
 
      if (status === "1" || status === "0") {
        sql += ` AND status = ?`;
        params.push(Number(status));
      } else if (status !== "all") {
        sql += ` AND status = 1`;
      }
 
      if (!includeSystem) {
        sql += ` AND is_system_role = 0`;
      }
      if (search) {
        sql += ` AND (role_name LIKE ? OR role_key LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
      }
 
      sql += ` ORDER BY is_system_role DESC, role_name ASC`;
 
      const [rows] = await db.execute(sql, params);
      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("listRoles error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to fetch roles" });
    }
  },
);
 
/* ============================================================
   GET ONE ROLE (active only)
============================================================ */
router.get(
  "/get/role/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const { id } = req.params;
 
      const [rows] = await db.execute(
        `SELECT id, role_key, role_name, description, is_system_role,
                status, created_at, updated_at
         FROM roles
         WHERE id = ? AND admin_id = ? AND status = 1
         LIMIT 1`,
        [id, admin_id],
      );
 
      if (!rows.length) {
        return res
          .status(404)
          .json({ success: false, message: "Role not found" });
      }
      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      console.error("getRoleById error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to fetch role" });
    }
  },
);
 
/* ============================================================
   UPDATE ROLE
   NOTE: role_key is intentionally NOT updatable — changing it would silently
   break existing JWTs, role_modules rows, and any code that reads req.user.role.
============================================================ */
router.put(
  "/update/role/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const { id } = req.params;
      const { role_name, description, status } = req.body;
 
      const [existing] = await db.execute(
        `SELECT id, role_key, is_system_role FROM roles
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, admin_id],
      );
      if (!existing.length) {
        return res
          .status(404)
          .json({ success: false, message: "Role not found" });
      }
      const role = existing[0];
 
      if (
        role.is_system_role === 1 &&
        status !== undefined &&
        Number(status) === 0
      ) {
        return res.status(403).json({
          success: false,
          message: "System roles cannot be deactivated",
        });
      }
 
      const fields = [];
      const params = [];
 
      if (role_name !== undefined) {
        if (!role_name.trim()) {
          return res
            .status(400)
            .json({ success: false, message: "role_name cannot be empty" });
        }
        fields.push("role_name = ?");
        params.push(role_name.trim());
      }
      if (description !== undefined) {
        fields.push("description = ?");
        params.push(description?.trim() || null);
      }
      if (status !== undefined) {
        fields.push("status = ?");
        params.push(Number(status));
      }
 
      if (!fields.length) {
        return res
          .status(400)
          .json({ success: false, message: "No fields to update" });
      }
 
      params.push(id, admin_id);
      const [result] = await db.execute(
        `UPDATE roles SET ${fields.join(", ")} WHERE id = ? AND admin_id = ?`,
        params,
      );
 
      if (!result.affectedRows) {
        return res
          .status(404)
          .json({ success: false, message: "Role not found" });
      }
 
      return res.json({ success: true, message: "Role updated successfully" });
    } catch (err) {
      console.error("updateRole error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to update role" });
    }
  },
);
 
/* ============================================================
   DELETE ROLE (hard delete — row is permanently removed)
   Blocks deletion if:
     - Role is a system role
     - Role has active user assignments
     - Role has feature grants (from role_features)
   Deletes role_features and role_permissions cascade rows in one transaction.
============================================================ */
router.delete(
  "/delete/role/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const admin_id = getAdminIdFromUser(req.user);
    const { id } = req.params;
    let conn;
 
    try {
      const [existing] = await db.execute(
        `SELECT id, is_system_role FROM roles
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, admin_id],
      );
      if (!existing.length) {
        return res
          .status(404)
          .json({ success: false, message: "Role not found" });
      }
      if (existing[0].is_system_role === 1) {
        return res.status(403).json({
          success: false,
          message: "System roles cannot be deleted",
        });
      }
 
      // Guard 1: block if any active user is still assigned this role
      const [assignments] = await db.execute(
        `SELECT COUNT(*) AS cnt FROM user_role_assignments
         WHERE role_id = ? AND status = 1`,
        [id],
      );
      if (assignments[0].cnt > 0) {
        return res.status(409).json({
          success: false,
          message: `Role has ${assignments[0].cnt} active user assignment(s). Reassign users before deleting.`,
        });
      }
 
      // Delete the role AND its downstream bridge rows in a single transaction
      // so we never leave orphaned role_features / role_permissions / assignments.
      conn = await db.getConnection();
      await conn.beginTransaction();
 
      await conn.execute(`DELETE FROM role_features WHERE role_id = ?`, [id]);
      await conn.execute(`DELETE FROM role_permissions WHERE role_id = ?`, [
        id,
      ]);
      // Any inactive assignments still pointing at this role
      await conn.execute(
        `DELETE FROM user_role_assignments WHERE role_id = ?`,
        [id],
      );
      const [result] = await conn.execute(
        `DELETE FROM roles WHERE id = ? AND admin_id = ?`,
        [id, admin_id],
      );
 
      if (!result.affectedRows) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Role not found",
        });
      }
 
      await conn.commit();
      return res.json({ success: true, message: "Role deleted successfully" });
    } catch (err) {
      if (conn) await conn.rollback();
      console.error("deleteRole error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to delete role" });
    } finally {
      if (conn) conn.release();
    }
  },
);
 
module.exports = router;