// middlewares/allowPermissions.js
const db = require("../db");

// Cheap in-memory cache for admin's enabled modules, keyed by admin_id.
// Bust when you write to admin_modules.
const moduleCache = new Map();
const MODULE_CACHE_TTL_MS = 60 * 1000;

async function getEnabledModuleKeys(admin_id) {
  const cached = moduleCache.get(admin_id);
  if (cached && cached.expires > Date.now()) return cached.keys;

  const [rows] = await db.query(
    `SELECT module_keys FROM admin_modules
      WHERE admin_id = ? AND status = 1
      LIMIT 1`,
    [admin_id]
  );

  let keys = [];
  if (rows[0] && rows[0].module_keys) {
    // mysql2 auto-parses JSON columns in most configs, but guard anyway
    const raw = rows[0].module_keys;
    keys = Array.isArray(raw) ? raw : JSON.parse(raw);
    keys = keys.map((k) => String(k).toLowerCase());
  }

  moduleCache.set(admin_id, { keys, expires: Date.now() + MODULE_CACHE_TTL_MS });
  return keys;
}

// Extract the module prefix from a permission_key.
// "pharmacy.dispensing.read" -> "pharmacy"
function moduleOf(permissionKey) {
  return permissionKey.split(".")[0];
}

const buildCheck = (mode) => (...allowedPermissions) => {
  const required = allowedPermissions.map((p) => p.toLowerCase().trim());
  const requiredModules = [...new Set(required.map(moduleOf))];

  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }
      if (required.length === 0) {
        return res.status(500).json({ message: "No permissions specified" });
      }

      const isAdmin = req.user.role && req.user.role.toLowerCase() === "admin";

      // Tenant scope: admins own their tenant (adminId is null), staff carry adminId
      const admin_id = isAdmin ? req.user.id : req.user.adminId;
      if (!admin_id) {
        return res
          .status(403)
          .json({ message: "Access denied — tenant not resolved" });
      }

      // ── Module gate — applies to admin AND staff ─────────────────────
      const enabledModules = await getEnabledModuleKeys(admin_id);
      const moduleOk =
        mode === "all"
          ? requiredModules.every((m) => enabledModules.includes(m))
          : requiredModules.some((m) => enabledModules.includes(m));

      if (!moduleOk) {
        return res.status(403).json({
          message: "Access denied — module not enabled for this tenant",
          required_modules: requiredModules,
        });
      }

      // ── Tenant admin bypasses the per-permission check ───────────────
      if (isAdmin) return next();

      // ── Staff permission check ───────────────────────────────────────
      //
      // rp.status = 1 is what makes unticking a permission on the Roles screen
      // mean anything. Without it the grant row is still there (status 0) and
      // the request goes through — every permission in the app reads as granted.
      const [rows] = await db.query(
        `SELECT DISTINCT LOWER(p.permission_key) AS permission_key
           FROM user_role_assignments ura
           INNER JOIN role_permissions rp
                   ON rp.role_id = ura.role_id
                  AND rp.admin_id = ?
                  AND rp.status = 1
           INNER JOIN permissions p
                   ON p.id = rp.permission_id
          WHERE ura.user_id   = ?
            AND ura.user_type = 'staff'
            AND ura.status    = 1
            AND p.is_active   = 1`,
        [admin_id, req.user.id]
      );

      const userPermissions = rows.map((r) => r.permission_key);
      if (userPermissions.length === 0) {
        return res
          .status(403)
          .json({ message: "Access denied — no permissions assigned" });
      }

      const ok =
        mode === "all"
          ? required.every((perm) => userPermissions.includes(perm))
          : required.some((perm) => userPermissions.includes(perm));

      if (!ok) {
        // `required` tells the screen which permission to ask the admin for.
        // The caller's own permission list is NOT sent back — it told anyone
        // with a login the full shape of the tenant's access model.
        return res.status(403).json({
          message: "Access denied — insufficient permissions",
          required,
        });
      }

      req.user.permissions = userPermissions;
      next();
    } catch (error) {
      console.error("PBAC Error:", error);
      return res.status(500).json({ message: "Authorization failed" });
    }
  };
};

exports.allowPermissions = buildCheck("any");
exports.allowPermissions.all = buildCheck("all");
// Expose cache-buster so your admin_modules update route can call it
exports.bustModuleCache = (admin_id) => moduleCache.delete(admin_id); 