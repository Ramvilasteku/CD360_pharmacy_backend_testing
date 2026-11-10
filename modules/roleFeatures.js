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
   GRANT one feature to one role
============================================================ */
router.post(
  "/post/rolefeature",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const { role_id, feature_id } = req.body;

      if (!role_id || !feature_id) {
        return res.status(400).json({
          success: false,
          message: "role_id and feature_id are required",
        });
      }

      // Tenant isolation: role must belong to this admin
      const [roleRows] = await db.execute(
        `SELECT id FROM roles WHERE id = ? AND admin_id = ? AND status = 1 LIMIT 1`,
        [role_id, admin_id],
      );
      if (!roleRows.length) {
        return res
          .status(404)
          .json({ success: false, message: "Role not found" });
      }

      // Feature must exist and be active
      const [featureRows] = await db.execute(
        `SELECT id FROM features WHERE id = ? AND is_active = 1 LIMIT 1`,
        [feature_id],
      );
      if (!featureRows.length) {
        return res
          .status(404)
          .json({ success: false, message: "Feature not found" });
      }

      const [existing] = await db.execute(
        `SELECT id FROM role_features WHERE role_id = ? AND feature_id = ? LIMIT 1`,
        [role_id, feature_id],
      );
      if (existing.length) {
        return res.status(409).json({
          success: false,
          message: "Feature already granted to this role",
        });
      }

      const [result] = await db.execute(
        `INSERT INTO role_features (admin_id, role_id, feature_id, granted_by)
         VALUES (?, ?, ?, ?)`,
        [admin_id, role_id, feature_id, req.user.id],
      );

      return res.status(201).json({
        success: true,
        message: "Feature granted to role",
        data: { id: result.insertId, role_id, feature_id },
      });
    } catch (err) {
      console.error("grantFeature error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to grant feature" });
    }
  },
);

/* ============================================================
   LIST all mappings for this admin (with role + feature names joined)
============================================================ */
router.get(
  "/getall/rolefeatures",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const { role_id, feature_id, module_key } = req.query;

      let sql = `
        SELECT rf.id,  rf.admin_id, rf.role_id, rf.feature_id, rf.granted_by, rf.created_at,
               r.role_key, r.role_name,
               f.feature_key, f.feature_name, f.module_key
        FROM role_features rf
        JOIN roles r    ON r.id = rf.role_id
        JOIN features f ON f.id = rf.feature_id
        WHERE rf.admin_id = ?
      `;
      const params = [admin_id];

      if (role_id) {
        sql += ` AND rf.role_id = ?`;
        params.push(role_id);
      }
      if (feature_id) {
        sql += ` AND rf.feature_id = ?`;
        params.push(feature_id);
      }
      if (module_key) {
        sql += ` AND f.module_key = ?`;
        params.push(module_key);
      }

      sql += ` ORDER BY r.role_name ASC, f.module_key ASC, f.feature_name ASC`;

      const [rows] = await db.execute(sql, params);
      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("listRoleFeatures error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to fetch role features" });
    }
  },
);

/* ============================================================
   GET all features for one role
============================================================ */
router.get(
  "/get/rolefeature/:roleId",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const { roleId } = req.params;

      const [roleRows] = await db.execute(
        `SELECT id, role_key, role_name FROM roles
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [roleId, admin_id],
      );
      if (!roleRows.length) {
        return res
          .status(404)
          .json({ success: false, message: "Role not found" });
      }

      const [rows] = await db.execute(
        `SELECT rf.id AS mapping_id, f.id AS feature_id,  rf.admin_id,
                f.feature_key, f.feature_name, f.module_key, f.description,
                rf.created_at AS granted_at
         FROM role_features rf
         JOIN features f ON f.id = rf.feature_id
         WHERE rf.role_id = ? AND rf.admin_id = ? AND f.is_active = 1
         ORDER BY f.module_key ASC, f.feature_name ASC`,
        [roleId, admin_id],
      );

      return res.json({
        success: true,
        data: { role: roleRows[0], features: rows },
      });
    } catch (err) {
      console.error("getFeaturesByRole error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch features for role",
      });
    }
  },
);

/* ============================================================
   BULK SYNC — replace a role's entire feature set atomically
   This is what the admin UI's "Save role access" button hits.
============================================================ */
router.put(
  "/update/rolefeature/:roleId",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const admin_id = getAdminIdFromUser(req.user);
    const { roleId } = req.params;
    const { feature_ids = [] } = req.body;

    if (!Array.isArray(feature_ids)) {
      return res.status(400).json({
        success: false,
        message: "feature_ids must be an array",
      });
    }

    let conn;
    try {
      const [roleRows] = await db.execute(
        `SELECT id FROM roles WHERE id = ? AND admin_id = ? LIMIT 1`,
        [roleId, admin_id],
      );
      if (!roleRows.length) {
        return res
          .status(404)
          .json({ success: false, message: "Role not found" });
      }

      conn = await db.getConnection();
      await conn.beginTransaction();

      await conn.execute(
        `DELETE FROM role_features WHERE role_id = ? AND admin_id = ?`,
        [roleId, admin_id],
      );

      let insertedCount = 0;
      if (feature_ids.length) {
        // Only insert features that exist and are active
        const [validFeatures] = await conn.query(
          `SELECT id FROM features WHERE id IN (?) AND is_active = 1`,
          [feature_ids],
        );
        const validIds = validFeatures.map((f) => f.id);

        if (validIds.length) {
          const values = validIds.map((fid) => [
            admin_id,
            roleId,
            fid,
            req.user.id,
          ]);
          await conn.query(
            `INSERT INTO role_features (admin_id, role_id, feature_id, granted_by)
             VALUES ?`,
            [values],
          );
          insertedCount = validIds.length;
        }
      }

      await conn.commit();

      return res.json({
        success: true,
        message: "Role features synchronized",
        data: {
          role_id: Number(roleId),
          requested: feature_ids.length,
          granted: insertedCount,
        },
      });
    } catch (err) {
      if (conn) await conn.rollback();
      console.error("syncRoleFeatures error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to sync role features",
      });
    } finally {
      if (conn) conn.release();
    }
  },
);

/* ============================================================
   REVOKE one mapping by id
   (hard delete — bridge rows carry no soft-delete field)
============================================================ */
router.delete(
  "/delete/rolefeature/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = getAdminIdFromUser(req.user);
      const { id } = req.params;

      const [result] = await db.execute(
        `DELETE FROM role_features WHERE id = ? AND admin_id = ?`,
        [id, admin_id],
      );
      if (!result.affectedRows) {
        return res.status(404).json({
          success: false,
          message: "Role-feature mapping not found",
        });
      }
      return res.json({ success: true, message: "Feature revoked from role" });
    } catch (err) {
      console.error("revokeFeature error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to revoke feature" });
    }
  },
);

module.exports = router;