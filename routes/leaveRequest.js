const express = require("express");
const router = express.Router();
const db = require("../db");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

// CREATE Leave Request (Staff Only) ---------------------------
router.post(
  "/leave/create/",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    try {
      const staff_id = req.user.id;
      const staff_role = req.user.role; // ✅ doctor | receptionist
      const admin_id = req.user.adminId;

      const { leave_type, start_date, end_date, reason } = req.body;

      if (!leave_type || !start_date || !end_date) {
        return res.status(400).json({
          success: false,
          message: "leave_type, start_date and end_date are required",
        });
      }

      if (!admin_id) {
        return res.status(400).json({
          success: false,
          message: "Admin not linked to staff",
        });
      }

      /* 1️⃣ INSERT LEAVE REQUEST */
      const [leaveResult] = await db.execute(
        `INSERT INTO leave_requests 
         (admin_id, staff_id, leave_type, start_date, end_date, reason, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'Pending', NOW())`,
        [admin_id, staff_id, leave_type, start_date, end_date, reason || null]
      );

      /* 2️⃣ CREATE NOTIFICATION (WITH admin_id + dynamic role) */
      const title = "New Leave Request";
      const message = `Staff #${staff_id} (${staff_role}) requested ${leave_type} leave from ${start_date} to ${end_date}.`;

      const [notifResult] = await db.execute(
        `INSERT INTO notifications 
         (admin_id, sender_role, sender_id, title, message, type, created_at)
         VALUES (?, ?, ?, ?, ?, 'request', NOW())`,
        [
          admin_id,        // ✅ admin_id added
          staff_role,      // ✅ doctor | receptionist
          staff_id,
          title,
          message,
        ]
      );

      const notification_id = notifResult.insertId;

      /* 3️⃣ LINK NOTIFICATION TO ADMIN */
      await db.execute(
        `INSERT INTO notification_receivers 
         (notification_id, receiver_role, receiver_id, is_read)
         VALUES (?, 'admin', ?, 0)`,
        [notification_id, admin_id]
      );

      /* 4️⃣ REAL-TIME SOCKET NOTIFICATION */
      if (req.io && req.io.connectedUsers) {
        const adminSocketId = req.io.connectedUsers[admin_id];
        if (adminSocketId) {
          req.io.to(adminSocketId).emit("new-notification", {
            notification_id,
            title,
            message,
            sender_role: staff_role,
            sender_id: staff_id,
            type: "request",
            created_at: new Date(),
          });
        }
      }

      res.status(201).json({
        success: true,
        message: "Leave request submitted successfully",
      });
    } catch (error) {
      console.error("Leave Request Error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
        details: error.message,
      });
    }
  }
);



// GET ALL Leave Requests (Admin Only Their Own all Leave Requests) ---------------------------
router.get(
  "/leave/getall",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = req.user.id;

      const [rows] = await db.execute(
        `SELECT lr.*, s.name AS staff_name 
         FROM leave_requests lr
         LEFT JOIN staff s ON lr.staff_id = s.id
         WHERE s.admin_id = ?
         ORDER BY lr.id DESC`,
        [admin_id]
      );

      res.status(200).json({ success: true, data: rows });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Server error",
        details: error.message,
      });
    }
  }
);

// GET Leave Requests (Staff Only - Their Own all Leave Requests ) ---------------------------
router.get(
  "/leave/getownall",
  authMiddleware,
  allowRoles("staff"),
  async (req, res) => {
    try {
      const staff_id = req.user.id;

      const [rows] = await db.execute(
        `SELECT * FROM leave_requests WHERE staff_id = ? ORDER BY id DESC`,
        [staff_id]
      );

      res.status(200).json({ success: true, data: rows });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Server error",
        details: error.message,
      });
    }
  }
);

// GET ONE Leave Requests (Staff and Admin - Their Own by Leave Requests ID) ---------------------------
router.get(
  "/leave/single/:id",
  authMiddleware,
  allowRoles("admin", "staff"),
  async (req, res) => {
    try {
      const user = req.user;
      const requestId = req.params.id;

      let query = "";
      let params = [];

      // ============================
      // ADMIN: fetch any leave under their staff
      // ============================
      if (user.role === "admin") {
        query = `
          SELECT lr.*, s.name AS staff_name
          FROM leave_requests lr
          LEFT JOIN staff s ON lr.staff_id = s.id
          WHERE lr.id = ? AND s.admin_id = ?
        `;
        params = [requestId, user.id];
      }

      // ============================
      // STAFF: fetch only their own leave
      // ============================
      if (user.role === "staff") {
        query = `
          SELECT lr.*, s.name AS staff_name
          FROM leave_requests lr
          LEFT JOIN staff s ON lr.staff_id = s.id
          WHERE lr.id = ? AND lr.staff_id = ?
        `;
        params = [requestId, user.id];
      }

      const [rows] = await db.execute(query, params);

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Leave request not found",
        });
      }

      return res.status(200).json({
        success: true,
        data: rows[0],
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        error: "Server error",
        details: error.message,
      });
    }
  }
);


// UPDATE Leave Request (Staff Can Edit Only Pending; Admin Can Edit Status) ---------------------------
router.put(
  "/leave/update/:id",
  authMiddleware,
  allowRoles("admin"), // 🔥 ADMIN ONLY
  async (req, res) => {
    try {
      const admin = req.user;
      const requestId = req.params.id;
      const { status } = req.body;

      if (!status || !["Approved", "Rejected"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Status must be Approved or Rejected",
        });
      }

      // ==============================
      // FETCH LEAVE REQUEST
      // ==============================
      const [leaveData] = await db.execute(
        `SELECT * FROM leave_requests WHERE id = ?`,
        [requestId]
      );

      if (leaveData.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Leave request not found",
        });
      }

      const leave = leaveData[0];

      // ==============================
      // UPDATE LEAVE STATUS
      // ==============================
      await db.execute(
        `UPDATE leave_requests SET status = ? WHERE id = ?`,
        [status, requestId]
      );

      // ==============================
      // FETCH STAFF ROLE (doctor / receptionist)
      // ==============================
      const [staffData] = await db.execute(
        `SELECT role FROM staff WHERE id = ?`,
        [leave.staff_id]
      );

      if (staffData.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Staff not found",
        });
      }

      const receiverRole = staffData[0].role; // doctor | receptionist

      if (!["doctor", "receptionist"].includes(receiverRole)) {
        return res.status(400).json({
          success: false,
          message: "Invalid receiver role",
        });
      }

      // ==============================
      // CREATE NOTIFICATION
      // ==============================
      const title = `Leave Request ${status}`;
      const message = `Your leave request from ${leave.start_date} to ${leave.end_date} has been ${status.toLowerCase()} by Admin`;

      const [notifResult] = await db.execute(
        `INSERT INTO notifications 
         (admin_id, sender_role, sender_id, title, message, type)
         VALUES (?, 'admin', ?, ?, ?, 'request')`,
        [admin.id, admin.id, title, message]
      );

      const notificationId = notifResult.insertId;

      // ==============================
      // NOTIFICATION RECEIVER
      // ==============================
      await db.execute(
        `INSERT INTO notification_receivers
         (notification_id, receiver_role, receiver_id)
         VALUES (?, ?, ?)`,
        [notificationId, receiverRole, leave.staff_id]
      );

      // ==============================
      // SOCKET NOTIFICATION
      // ==============================
      global.io
        .to(leave.staff_id.toString())
        .emit("new-notification", {
          notificationId,
          title,
          message,
          type: "request",
        });

      return res.status(200).json({
        success: true,
        message: `Leave request ${status} successfully`,
      });
    } catch (error) {
      console.error("Leave update error:", error);
      return res.status(500).json({
        success: false,
        message: "Server error",
        error: error.message,
      });
    }
  }
);





// DELETE Leave Request (Admin Only) ---------------------------
router.delete(
  "/leave/delete/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const id = req.params.id;

      const [exists] = await db.execute(
        `SELECT lr.id 
         FROM leave_requests lr
         LEFT JOIN staff s ON lr.staff_id = s.id
         WHERE lr.id = ? AND s.admin_id = ?`,
        [id, req.user.id]
      );

      if (exists.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Leave request not found",
        });
      }

      await db.execute("DELETE FROM leave_requests WHERE id = ?", [id]);

      res.status(200).json({
        success: true,
        message: "Leave request deleted successfully",
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: "Server error",
        details: error.message,
      });
    }
  }
);

module.exports = router;
