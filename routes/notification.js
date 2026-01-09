const express = require("express");
const router = express.Router();
const db = require("../db");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

// Staff sends a request notification to a specific admin
router.post(
  "/notifications/staff-request",
  authMiddleware,
  allowRoles("staff"),
  async (req, res) => {
    const { title, message } = req.body;
    const adminId = req.user.adminId;

    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }

    if (!adminId) {
      return res.status(400).json({ message: "Admin ID is required" });
    }

    let conn;
    try {
      conn = await db.getConnection();
      await conn.beginTransaction();

      // ---------------- INSERT NOTIFICATION ----------------
      const [notifResult] = await conn.query(
        `INSERT INTO notifications (sender_role, sender_id, title, message, type)
         VALUES (?, ?, ?, ?, 'request')`,
        ["staff", req.user.id, title || "Attendance Request", message]
      );

      const notificationId = notifResult.insertId;

      // ---------------- INSERT RECEIVER (ADMIN) ----------------
      await conn.query(
        `INSERT INTO notification_receivers (notification_id, receiver_role, receiver_id)
         VALUES (?, 'admin', ?)`,
        [notificationId, adminId]
      );

      await conn.commit();

      // ---------------- SOCKET EMIT (WEB NOTIFICATION) ----------------
      global.io.to(adminId.toString()).emit("new-notification", {
        notificationId,
        title: title || "Attendance Request",
        message,
        type: "request",
        senderRole: "staff",
      });

      return res.json({
        message: "Attendance update sent to admin successfully",
        notificationId,
      });

    } catch (err) {
      if (conn) await conn.rollback();
      console.error("Staff notification error:", err);
      return res.status(500).json({ message: "Internal server error" });
    } finally {
      if (conn) conn.release();
    }
  }
);


module.exports = router;
