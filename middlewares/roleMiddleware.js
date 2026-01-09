/**
 * Role-Based Access Control (RBAC) Middleware
 * Allows only specified roles to access a route
 *
 * Usage:
 * allowRoles("admin", "doctor")
 */
exports.allowRoles = (...allowedRoles) => {
  // Normalize roles for safety (case-insensitive)
  const roles = allowedRoles.map((role) => role.toLowerCase());

  return (req, res, next) => {
    try {
      // Ensure authMiddleware ran first
      if (!req.user || !req.user.role) {
        return res.status(401).json({
          message: "Authentication required",
        });
      }
      // console.log("RBAC:", {
      //   allowed: roles,
      //   userRole: req.user.role,
      // });

      const userRole = req.user.role.toLowerCase();

      // Check role permission
      if (!roles.includes(userRole)) {
        return res.status(403).json({
          message: "Access denied",
        });
      }

      next();
    } catch (error) {
      console.error("RBAC Error:", error);
      return res.status(500).json({
        message: "Authorization failed",
      });
    }
  };
};
