// middleware/attachBranch.js

const db = require("../db");

const attachBranch = async (req, res, next) => {
  try {
    if (req.user.role === "receptionist") {
      const [rows] = await db.query(
        `
        SELECT branch
        FROM staff
        WHERE id = ?
        LIMIT 1
        `,
        [req.user.id]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Staff not found",
        });
      }

      req.user.branch_name = rows[0].branch;
    }

    next();
  } catch (error) {
    console.log("Attach Branch Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = attachBranch;