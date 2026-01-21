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
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    try {
      const staff_id = req.user.id; // doctor or receptionist id

      const [rows] = await db.execute(
        `SELECT * FROM leave_requests WHERE staff_id = ? ORDER BY id DESC`,
        [staff_id]
      );

      return res.status(200).json({
        success: true,
        data: rows,
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
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const user = req.user;
      const requestId = req.params.id;
      const { leave_type, start_date, end_date, reason, status } = req.body;

      // =====================================================
      // DOCTOR / RECEPTIONIST: edit ONLY their own PENDING leave
      // =====================================================
      if (user.role === "doctor" || user.role === "receptionist") {
        const [data] = await conn.execute(
          `SELECT * FROM leave_requests WHERE id = ? AND staff_id = ?`,
          [requestId, user.id]
        );

        if (data.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Leave request not found",
          });
        }

        if (data[0].status !== "Pending") {
          return res.status(403).json({
            success: false,
            message: "Only pending requests can be updated",
          });
        }

        // Update the leave request
        await conn.execute(
          `UPDATE leave_requests 
           SET leave_type=?, start_date=?, end_date=?, reason=?
           WHERE id=?`,
          [
            leave_type || data[0].leave_type,
            start_date || data[0].start_date,
            end_date || data[0].end_date,
            reason || data[0].reason,
            requestId,
          ]
        );

        // -------------------- NOTIFY ADMIN(S) --------------------
        const title = `Leave Request Updated`;
        const message = `${user.role} ${user.name} updated their leave from ${data[0].start_date} to ${data[0].end_date}`;

        // Get all admins (or specific admin_id if available)
        const [admins] = await conn.execute(`SELECT id FROM admins `);

        for (const admin of admins) {
          const [notifResult] = await conn.execute(
            `INSERT INTO notifications 
             (admin_id, sender_role, title, message, type)
             VALUES (?, ?, ?, ?, 'request')`,
            [user.id, user.role, title, message]
          );

          const notificationId = notifResult.insertId;

          await conn.execute(
            `INSERT INTO notification_receivers 
             (notification_id, receiver_role, receiver_id)
             VALUES (?, 'admin', ?)`,
            [notificationId, admin.id]
          );

          // SOCKET.IO EMIT
          if (global.io) {
            global.io.to(admin.id.toString()).emit("new-notification", {
              notificationId,
              title,
              message,
              type: "request",
            });
          }
        }
      }

      // ======================================
      // ADMIN: approve or reject leave request
      // ======================================
      if (user.role === "admin") {
        if (!status) {
          return res.status(400).json({
            success: false,
            message: "Status required (Approved or Rejected)",
          });
        }

        // 1️⃣ Get leave request
        const [leaveData] = await conn.execute(
          `SELECT staff_id, start_date, end_date 
           FROM leave_requests WHERE id = ?`,
          [requestId]
        );

        if (leaveData.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Leave request not found",
          });
        }

        const { staff_id, start_date: leaveStart, end_date: leaveEnd } = leaveData[0];

        // 2️⃣ Get staff role
        const [staffData] = await conn.execute(
          `SELECT role, name FROM staff WHERE id = ?`,
          [staff_id]
        );

        if (staffData.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Staff not found",
          });
        }

        const receiverRole = staffData[0].role;
        const staffName = staffData[0].name;

        if (!["doctor", "receptionist"].includes(receiverRole)) {
          return res.status(400).json({
            success: false,
            message: "Invalid staff role for notification",
          });
        }

        // 3️⃣ Update leave status
        await conn.execute(`UPDATE leave_requests SET status=? WHERE id=?`, [status, requestId]);

        // -------------------- NOTIFY STAFF --------------------
        const title = `Leave Request ${status}`;
        const message = `Your leave request from ${leaveStart} to ${leaveEnd} has been ${status.toLowerCase()} by Admin`;

        const [notifResult] = await conn.execute(
          `INSERT INTO notifications 
           (admin_id, sender_role, title, message, type)
           VALUES (?, 'admin', ?, ?, 'request')`,
          [user.id, title, message]
        );

        const notificationId = notifResult.insertId;

        await conn.execute(
          `INSERT INTO notification_receivers 
           (notification_id, receiver_role, receiver_id)
           VALUES (?, ?, ?)`,
          [notificationId, receiverRole, staff_id]
        );

        // SOCKET.IO EMIT to the staff
        if (global.io) {
          global.io.to(staff_id.toString()).emit("new-notification", {
            notificationId,
            title,
            message,
            type: "request",
          });
        }
      }

      await conn.commit();

      return res.status(200).json({
        success: true,
        message: `Leave request updated successfully by ${user.role}`,
      });
    } catch (error) {
      await conn.rollback();
      console.error("Leave update error:", error);
      return res.status(500).json({
        success: false,
        error: "Server error",
        details: error.message,
      });
    } finally {
      conn.release();
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

//to get doctors count which are in leave
router.get(
  "/doctor/schedule-summary",
  authMiddleware,
  allowRoles("receptionist", "admin"),
  async (req, res) => {
    try {
      const role = req.user.role;
      const adminId =
        role === "admin" ? req.user.id : req.user.adminId;

      let branchCondition = "";
      let params = [adminId];

      /* ===============================
         RECEPTIONIST → SAME BRANCH ONLY
      =============================== */
      if (role === "receptionist") {
        const [[staff]] = await db.execute(
          `
          SELECT branch
          FROM staff
          WHERE id = ? AND admin_id = ?
          `,
          [req.user.id, adminId]
        );

        if (!staff?.branch) {
          return res.status(404).json({
            success: false,
            message: "Receptionist branch not found",
          });
        }

        branchCondition = "AND s.branch = ?";
        params.push(staff.branch);
      }

      /* ===============================
         AVAILABLE DOCTORS
      =============================== */
      const [[availableResult]] = await db.execute(
        `
        SELECT COUNT(DISTINCT s.id) AS availableDoctors
        FROM staff s
        WHERE s.admin_id = ?
          AND s.role = 'doctor'
          ${branchCondition}
          AND s.id NOT IN (
            SELECT lr.staff_id
            FROM leave_requests lr
            WHERE lr.status = 'Approved'
              AND CURDATE() BETWEEN lr.start_date AND lr.end_date
          )
        `,
        params
      );

      /* ===============================
         ON-LEAVE DOCTORS
      =============================== */
      const [[leaveResult]] = await db.execute(
        `
        SELECT COUNT(DISTINCT s.id) AS onLeaveDoctors
        FROM staff s
        JOIN leave_requests lr ON lr.staff_id = s.id
        WHERE s.admin_id = ?
          AND s.role = 'doctor'
          ${branchCondition}
          AND lr.status = 'Approved'
          AND CURDATE() BETWEEN lr.start_date AND lr.end_date
        `,
        params
      );

      res.json({
        success: true,
        availableDoctors: availableResult.availableDoctors,
        onLeaveDoctors: leaveResult.onLeaveDoctors,
      });
    } catch (error) {
      console.error("Doctor schedule summary error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch doctor schedule summary",
      });
    }
  }
);

module.exports = router;
