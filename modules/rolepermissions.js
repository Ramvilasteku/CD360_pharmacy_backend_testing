const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* ═══════════════════════════════════════════════════════════════
   HELPERS  (added 6 Nov 2026)
   ═══════════════════════════════════════════════════════════════ */

/** Thrown to bail out of a transaction with a specific HTTP response. */
class EarlyReturn extends Error {
  constructor(status, body) {
    super("early-return");
    this.status = status;
    this.body = body;
  }
}

/**
 * Run fn inside a transaction.
 * Works whether `db` is a mysql2 pool (getConnection) or a single connection.
 */
async function withTransaction(fn) {
  if (typeof db.getConnection === "function") {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (err) {
      try {
        await conn.rollback();
      } catch (_) {}
      throw err;
    } finally {
      conn.release();
    }
  }

  await db.query("START TRANSACTION");
  try {
    const out = await fn(db);
    await db.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch (_) {}
    throw err;
  }
}

/* ═══════════════════════════════════════════════════════════════
   ASSIGN PERMISSION TO ROLE
   POST /api/role-permissions
   ═══════════════════════════════════════════════════════════════ */
router.post(
  "/post/role-permissions",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
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
        [role_id],
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
        [permission_id],
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
        [role_id, permission_id],
      );

      if (existingRows.length > 0) {
        const existing = existingRows[0];

        if (existing.status === 1) {
          return res.status(409).json({
            message: "This role already has this permission",
          });
        } else {
          return res.status(409).json({
            message:
              "This role previously had this permission (deactivated). Reactivate it instead of creating new.",
            existingAssignmentId: existing.id,
          });
        }
      }

      // ─── STEP 5: Insert new assignment ───
      const [result] = await db.query(
        `INSERT INTO role_permissions (admin_id, role_id, permission_id, granted_by, status)
   VALUES (?, ?, ?, ?, 1)`,
        [admin_id, role_id, permission_id, id],
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
  },
);

/* ═══════════════════════════════════════════════════════════════
   BULK ASSIGN PERMISSIONS TO ROLE
   POST /api/role-permissions/bulk
   ═══════════════════════════════════════════════════════════════ */
router.post(
  "/post/bulk/role-permissions",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { role_id, permission_ids } = req.body;
    const { id, role: userRole, adminId } = req.user;

    const admin_id = userRole === "admin" ? id : adminId;

    try {
      // ─── STEP 1: Basic validation ───
      if (!role_id) {
        return res.status(400).json({ message: "role_id is required" });
      }

      if (
        !permission_ids ||
        !Array.isArray(permission_ids) ||
        permission_ids.length === 0
      ) {
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
        [role_id],
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
            [permission_id],
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
            [role_id, permission_id],
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
                `UPDATE role_permissions SET status = 1, granted_by = ? WHERE id = ?`,
                [id, existing[0].id],
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
            `INSERT INTO role_permissions (admin_id, role_id, permission_id, granted_by, status)
   VALUES (?, ?, ?, ?, 1)`,
            [admin_id, role_id, permission_id, id],
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
  },
);

/* ═══════════════════════════════════════════════════════════════
   GET PERMISSIONS FOR A ROLE
   GET /api/role-permissions/get/role/:roleId
   GET /api/role-permissions/get/role/:roleId?matrix=1      <-- ADDED
   GET /api/role-permissions/get/role/:roleId?matrix=1&module_key=pharmacy

   WHY matrix=1 EXISTS  (6 Nov 2026)
   The legacy response returns only `rp.status = 1` rows, INNER JOINed to
   `permissions`. So the screen can never see a revoked grant, nor a grant
   pointing at a permission id this database does not have. The screen then
   has to source its checkbox list from somewhere else — and when that list
   carried ids from another environment, saving it revoked everything the
   two lists disagreed on.

   matrix=1 returns the WHOLE catalogue with a `granted` flag, so the screen
   renders from this database's own ids and the two lists cannot drift.
   Point the Roles screen at this.

   The legacy shape is unchanged when matrix is absent.
   ═══════════════════════════════════════════════════════════════ */
router.get(
  "/get/role/:roleId",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { roleId } = req.params;
    const { matrix, module_key } = req.query;
    const { id, role: userRole, adminId } = req.user;

    try {
      const admin_id = userRole === "admin" ? id : adminId;

      // Verify role belongs to this admin
      const [roleRows] = await db.query(
        `SELECT id, role_key, role_name FROM roles WHERE id = ? AND admin_id = ? LIMIT 1`,
        [roleId, admin_id],
      );

      if (!roleRows.length) {
        return res.status(404).json({ message: "Role not found" });
      }

      // ─── matrix=1: every active permission, flagged granted / not ───
      if (String(matrix) === "1" || String(matrix) === "true") {
        const params = [roleId];
        let moduleSql = "";
        if (module_key) {
          moduleSql = " AND p.module_key = ?";
          params.push(module_key);
        }

        const [rows] = await db.query(
          `SELECT
             p.id            AS permission_id,
             p.permission_key,
             p.permission_name,
             p.module_key,
             p.feature_key,
             p.action,
             COALESCE(rp.status, 0) = 1 AS granted,
             rp.id           AS assignment_id
           FROM permissions p
           LEFT JOIN role_permissions rp
                  ON rp.permission_id = p.id AND rp.role_id = ?
          WHERE p.is_active = 1${moduleSql}
          ORDER BY p.module_key ASC, p.feature_key ASC, p.action ASC`,
          params,
        );

        // Grants pointing at a permission row that no longer exists. They
        // grant nothing (allowPermissions INNER JOINs `permissions`) but they
        // are why a tick can appear to do nothing.
        const [orphans] = await db.query(
          `SELECT rp.id, rp.permission_id, rp.status
             FROM role_permissions rp
             LEFT JOIN permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = ? AND p.id IS NULL`,
          [roleId],
        );

        return res.json({
          role: {
            id: roleRows[0].id,
            role_key: roleRows[0].role_key,
            role_name: roleRows[0].role_name,
          },
          data: rows.map((r) => ({ ...r, granted: !!r.granted })),
          orphan_assignments: orphans,
        });
      }

      // ─── legacy shape, unchanged ───
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
         WHERE rp.role_id = ? AND rp.status = 1
        ORDER BY p.module_key ASC, p.feature_key ASC, p.action ASC`,
        [roleId],
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
  },
);

/* ═══════════════════════════════════════════════════════════════
   GET ROLES FOR A PERMISSION
   GET /api/role-permissions/permission/:permissionId
   ═══════════════════════════════════════════════════════════════ */
router.get(
  "/get/permission/:permissionId",
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
        [permissionId],
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
        [permissionId, admin_id],
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
  },
);

/* ═══════════════════════════════════════════════════════════════
   GET PERMISSIONS BY MODULE FOR A ROLE
   GET /api/role-permissions/role/:roleId/module/:moduleKey
   ═══════════════════════════════════════════════════════════════ */
router.get(
  "/get/role/:roleId/module/:moduleKey",
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
        [roleId, admin_id],
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
        [roleId, moduleKey],
      );

      return res.json({ data: rows });
    } catch (err) {
      console.error("Get Role Permissions By Module Error:", err);
      return res.status(500).json({
        message: "Failed to fetch permissions",
      });
    }
  },
);

/* ═══════════════════════════════════════════════════════════════
   GET SINGLE ROLE-PERMISSION BY ID
   GET /api/role-permissions/:id
   ═══════════════════════════════════════════════════════════════ */
router.get(
  "/getby/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
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
        [assignmentId, admin_id],
      );

      if (!rows.length) {
        return res
          .status(404)
          .json({ message: "Role-permission assignment not found" });
      }

      return res.json({ data: rows[0] });
    } catch (err) {
      console.error("Get Role Permission By Id Error:", err);
      return res.status(500).json({ message: "Failed to fetch assignment" });
    }
  },
);

/* ═══════════════════════════════════════════════════════════════
   SYNC PERMISSIONS FOR A ROLE
   PUT /api/role-permissions/update/role/:roleId/sync

   REWRITTEN 6 Nov 2026.

   WHAT WAS WRONG WITH THE OLD VERSION
   1. Destructive by omission. Anything absent from `permission_ids` was set
      to status = 0, and it still answered 200 "synced successfully". A screen
      that saves one section at a time therefore wiped every permission
      outside that section. Measured on live data: a save carrying the 8
      Sales ids revoked 39 of 46 grants.
   2. Silent skip. A permission_id with no row, or is_active = 0, hit
      `if (permRows.length)` and fell through with no error and no entry in
      the response — this endpoint had no `errors` array at all. Ticking a
      box that carried an id from another environment did nothing and
      reported success.
   3. No admin_id filter on the SELECT or the deactivating UPDATE, while
      allowPermissions and buildUserAccess both filter on it.
   4. No transaction. A failure between the add loop and the remove loop left
      the role half synced.
   5. `Number(p)` unvalidated, so a non-numeric element reached SQL as a bare
      `NaN` identifier and threw ER_BAD_FIELD_ERROR -> 500.
   6. `removed++` counted intent, not affectedRows.

   REQUEST BODY
     permission_keys    string[]  preferred. Keys are stable across
                                  environments; ids are not.
     permission_ids     number[]  accepted for backwards compatibility.
                                  Send exactly one of the two; either may be
                                  empty to revoke everything in scope.
     scope              object    optional, limits what this save may revoke:
                                    { module_key: "pharmacy" }
                                    { feature_keys: ["sales"] }
                                  Without it this is a whole-role replace.
     allow_bulk_revoke  boolean   required to confirm an unscoped save that
                                  revokes more than it keeps.
     dry_run            boolean   report the diff, write nothing.

   RESPONSE
     summary.added / removed come from affectedRows.
     removed_keys  what this save revoked, so the UI can show it.
     unknown       everything that could not be resolved, never swallowed.
   ═══════════════════════════════════════════════════════════════ */
router.put(
  "/update/role/:roleId/sync",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const { roleId } = req.params;
    const {
      permission_ids,
      permission_keys,
      scope,
      allow_bulk_revoke = false,
      dry_run = false,
    } = req.body;
    const { id, role: userRole, adminId } = req.user;

    const admin_id = userRole === "admin" ? id : adminId;

    const usingKeys = Array.isArray(permission_keys);
    const usingIds = Array.isArray(permission_ids);

    if (usingKeys === usingIds) {
      return res.status(400).json({
        message:
          "Send exactly one of permission_keys (preferred) or permission_ids. Either may be an empty array to revoke all.",
      });
    }

    try {
      // ─── STEP 1: Verify the role belongs to this admin ───
      const [roleRows] = await db.query(
        `SELECT id, role_key, status FROM roles WHERE id = ? AND admin_id = ? LIMIT 1`,
        [roleId, admin_id],
      );

      if (!roleRows.length) {
        return res.status(404).json({ message: "Role not found" });
      }

      if (roleRows[0].status !== 1) {
        return res.status(400).json({
          message: "This role is inactive and cannot be modified",
        });
      }

      // ─── STEP 2: Resolve the request to real permission rows ───
      let wanted = [];
      let unknown = [];

      if (usingKeys) {
        const keys = [
          ...new Set(
            permission_keys.map((k) => String(k).trim()).filter(Boolean),
          ),
        ];
        if (keys.length) {
          const [rows] = await db.query(
            `SELECT id, permission_key, module_key, feature_key
               FROM permissions WHERE permission_key IN (?) AND is_active = 1`,
            [keys],
          );
          wanted = rows;
          const found = new Set(rows.map((r) => r.permission_key));
          unknown = keys
            .filter((k) => !found.has(k))
            .map((k) => ({
              permission_key: k,
              reason: "no active permission with this key",
            }));
        }
      } else {
        const bad = permission_ids.filter(
          (p) => !Number.isInteger(Number(p)) || Number(p) <= 0,
        );
        if (bad.length) {
          return res.status(400).json({
            message: "permission_ids must contain positive integers only",
            invalid: bad,
          });
        }
        const ids = [...new Set(permission_ids.map((p) => Number(p)))];
        if (ids.length) {
          const [rows] = await db.query(
            `SELECT id, permission_key, module_key, feature_key
               FROM permissions WHERE id IN (?) AND is_active = 1`,
            [ids],
          );
          wanted = rows;
          const found = new Set(rows.map((r) => r.id));
          unknown = ids
            .filter((i) => !found.has(i))
            .map((i) => ({
              permission_id: i,
              reason: "no active permission with this id",
            }));
        }
      }

      const wantedIds = wanted.map((r) => r.id);

      // ─── STEP 3: What may this save revoke? ───
      const scopeParts = [];
      const scopeParams = [];
      if (scope && typeof scope === "object") {
        if (scope.module_key) {
          scopeParts.push("p.module_key = ?");
          scopeParams.push(scope.module_key);
        }
        if (Array.isArray(scope.feature_keys) && scope.feature_keys.length) {
          scopeParts.push("p.feature_key IN (?)");
          scopeParams.push(scope.feature_keys);
        }
      }
      const scopeSql = scopeParts.length
        ? ` AND (${scopeParts.join(" AND ")})`
        : "";
      const scoped = scopeParts.length > 0;

      // ─── STEP 4: Diff and write, in one transaction ───
      const payload = await withTransaction(async (conn) => {
        const [currentRows] = await conn.query(
          `SELECT rp.permission_id, p.permission_key
             FROM role_permissions rp
             JOIN permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = ? AND rp.status = 1${scopeSql}`,
          [roleId, ...scopeParams],
        );
        const currentIds = currentRows.map((r) => r.permission_id);

        const toAdd = wantedIds.filter((p) => !currentIds.includes(p));
        const toRemove = currentRows.filter(
          (r) => !wantedIds.includes(r.permission_id),
        );

        // Guard: an unscoped save that revokes more than it keeps is almost
        // always a partial list sent to a whole-role endpoint.
        if (
          !scoped &&
          !allow_bulk_revoke &&
          toRemove.length > 0 &&
          toRemove.length > wantedIds.length
        ) {
          throw new EarlyReturn(409, {
            message:
              "This would revoke more permissions than it keeps. If that is intended, resend with allow_bulk_revoke: true — otherwise send a `scope` so the save only affects the section being edited.",
            would_revoke: toRemove.length,
            would_keep: wantedIds.length,
            revoked_keys: toRemove.map((r) => r.permission_key),
            unknown,
          });
        }

        if (dry_run) {
          throw new EarlyReturn(200, {
            message: "Dry run — nothing was written",
            summary: {
              role_id: Number(roleId),
              role_key: roleRows[0].role_key,
              scope: scoped ? scope : "whole role",
              would_add: toAdd.length,
              would_remove: toRemove.length,
            },
            removed_keys: toRemove.map((r) => r.permission_key),
            unknown,
          });
        }

        let added = 0;
        let removed = 0;

        if (toAdd.length) {
          const [r] = await conn.query(
            `INSERT INTO role_permissions (admin_id, role_id, permission_id, granted_by, status)
             VALUES ?
             ON DUPLICATE KEY UPDATE status = 1, granted_by = VALUES(granted_by), admin_id = VALUES(admin_id)`,
            [toAdd.map((pid) => [admin_id, roleId, pid, id, 1])],
          );
          added = r.affectedRows;
        }

        if (toRemove.length) {
          const [r] = await conn.query(
            `UPDATE role_permissions SET status = 0
              WHERE role_id = ? AND permission_id IN (?)`,
            [roleId, toRemove.map((x) => x.permission_id)],
          );
          removed = r.affectedRows;
        }

        // A grant written without admin_id is invisible to allowPermissions
        // and to buildUserAccess. The role is this admin's, so repair it.
        await conn.query(
          `UPDATE role_permissions SET admin_id = ?
            WHERE role_id = ? AND (admin_id IS NULL OR admin_id <> ?)`,
          [admin_id, roleId, admin_id],
        );

        return {
          message: unknown.length
            ? "Synced, but some permissions were not recognised — see `unknown`"
            : "Role permissions synced successfully",
          summary: {
            role_id: Number(roleId),
            role_key: roleRows[0].role_key,
            scope: scoped ? scope : "whole role",
            added,
            removed,
            unchanged: wantedIds.length - toAdd.length,
            total_active: wantedIds.length,
          },
          removed_keys: toRemove.map((r) => r.permission_key),
          unknown,
        };
      });

      return res.json(payload);
    } catch (err) {
      if (err instanceof EarlyReturn) {
        return res.status(err.status).json(err.body);
      }
      console.error("Sync Role Permissions Error:", err);
      return res.status(500).json({
        message: "Failed to sync permissions",
      });
    }
  },
);

/* ═══════════════════════════════════════════════════════════════
   DEACTIVATE ROLE-PERMISSION
   PUT /api/role-permissions/:id/deactivate
   ═══════════════════════════════════════════════════════════════ */
router.put(
  "/update/:id/deactivate",
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
        [assignmentId],
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
        [assignmentId],
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
  },
);

/* ═══════════════════════════════════════════════════════════════
   ACTIVATE ROLE-PERMISSION
   PUT /api/role-permissions/:id/activate
   ═══════════════════════════════════════════════════════════════ */
router.put(
  "/update/:id/activate",
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
        [assignmentId],
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
        [assignmentId],
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
  },
);

/* ═══════════════════════════════════════════════════════════════
   DELETE ROLE-PERMISSION (HARD DELETE)
   DELETE /api/role-permissions/:id
   ═══════════════════════════════════════════════════════════════ */
router.delete(
  "/delete/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
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
        [assignmentId],
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
        [assignmentId],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Assignment not found" });
      }

      return res.json({ message: "Assignment deleted successfully" });
    } catch (err) {
      console.error("Delete Role Permission Error:", err);
      return res.status(500).json({ message: "Failed to delete assignment" });
    }
  },
);

/* ═══════════════════════════════════════════════════════════════
   REMOVE ALL PERMISSIONS FROM A ROLE
   DELETE /api/role-permissions/role/:roleId/all
   ═══════════════════════════════════════════════════════════════ */
router.delete(
  "/delete/role/:roleId/all",
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
        [roleId, admin_id],
      );

      if (!roleRows.length) {
        return res.status(404).json({ message: "Role not found" });
      }

      const [result] = await db.query(
        `UPDATE role_permissions SET status = 0 WHERE role_id = ?`,
        [roleId],
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
  },
);

module.exports = router;