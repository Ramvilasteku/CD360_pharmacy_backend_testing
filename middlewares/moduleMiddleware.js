// middlewares/allowPermissions.js
const db = require("../db");
 
const buildCheck = (mode) => (...allowedPermissions) => {
    const required = allowedPermissions.map((p) => p.toLowerCase().trim());
 
    return async (req, res, next) => {
        try {
            if (!req.user || !req.user.id) {
                return res.status(401).json({ message: "Authentication required" });
            }
 
            if (required.length === 0) {
                return res.status(500).json({ message: "No permissions specified" });
            }
 
            // Tenant owner bypass — the "admin" role owns the tenant
            if (req.user.role && req.user.role.toLowerCase() === "admin") {
                return next();
            }
 
            // For staff, tenant scope comes from adminId on the JWT
            const admin_id = req.user.adminId;
            if (!admin_id) {
                return res
                    .status(403)
                    .json({ message: "Access denied — tenant not resolved" });
            }
 
            // One query: user -> role assignment -> role_permissions -> permissions
            const [rows] = await db.query(
                `SELECT DISTINCT LOWER(p.permission_key) AS permission_key
     FROM user_role_assignments ura
     INNER JOIN role_permissions rp
             ON rp.role_id = ura.role_id
            AND rp.admin_id = ?
     INNER JOIN permissions p
             ON p.id = rp.permission_id
    WHERE ura.user_id   = ?
      AND ura.user_type = 'staff'
      AND ura.status    = 1
      AND p.is_active   = 1`,
                [admin_id, req.user.id]
            );
 
            const userPermissions = rows.map((r) => r.permission_key);
 
            // If the user has no role assigned at all, block cleanly
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
                return res.status(403).json({
                    message: "Access denied — insufficient permissions",
                    required,
                    have: userPermissions, // remove in prod
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