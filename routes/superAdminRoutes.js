const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcryptjs");
// const { authMiddleware } = require("../middlewares/authMiddleware");
// const { allowRoles } = require("../middlewares/roleMiddleware");

router.put(
  "/admin/updatestatus/:id",
  async (req, res) => {
    try {
      const adminId = req.params.id; // ID of the admin to update
      const { status } = req.body; // expecting 0 or 1

      // Validate input
      if (typeof status !== "number" || ![0, 1].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Status must be 0 (inactive) or 1 (active)"
        });
      }

      // Update admin status
      const [result] = await db.execute(
        "UPDATE admins SET status = ? WHERE id = ?",
        [status, adminId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          success: false,
          message: "Admin not found"
        });
      }

      res.status(200).json({
        success: true,
        message: `Admin status updated to ${status === 1 ? "active" : "inactive"}`
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        details: error.message
      });
    }
  }
);


module.exports = router;
