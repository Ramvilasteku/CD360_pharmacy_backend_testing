const jwt = require("jsonwebtoken");

/**
 * Authentication Middleware
 * - Reads JWT from HttpOnly cookie
 * - Verifies token
 * - Attaches user data to req.user
 */
exports.authMiddleware = (req, res, next) => {
  try {
    // 1️⃣ Check token existence
    const token = req.cookies?.token;

    if (!token) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    // 2️⃣ Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 3️⃣ Attach user payload to request
    req.user = {
      id: decoded.id,
      role: decoded.role,
      name: decoded.name,
      adminId: decoded.adminId || null,
      otpVerified: decoded.otpVerified || false,
    };

    // 4️⃣ Proceed to next middleware
    next();
  } catch (error) {
    // 5️⃣ Handle token errors
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "Session expired. Please login again.",
      });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        message: "Invalid authentication token",
      });
    }

    console.error("Auth Middleware Error:", error);
    return res.status(500).json({
      message: "Authentication failed",
    });
  }
};
