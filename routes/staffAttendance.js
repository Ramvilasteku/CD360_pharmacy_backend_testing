const express = require("express");
const router = express.Router();
const db = require("../db");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* ======================================================
// CREATE Attendance by Staff clock in  
====================================================== */
// router.post(
//   "/attendance/clock-in",
//   authMiddleware,
//   allowRoles("doctor", "receptionist"),
//   async (req, res) => {
//     try {
//       const staff_id = req.user.id;
//       const admin_id = req.user.adminId;

//       // Check if already clocked-in today
//       const [exists] = await db.execute(
//         `SELECT * FROM staff_attendance 
//          WHERE staff_id = ? AND date = CURDATE()`,
//         [staff_id]
//       );

//       if (exists.length > 0) {
//         return res.status(400).json({
//           success: false,
//           message: "Already clocked in today",
//         });
//       }

//       await db.execute(
//         `INSERT INTO staff_attendance 
//         (admin_id, staff_id, date, clock_in, created_at)
//         VALUES (?, ?, CURDATE(), CURTIME(), NOW())`,
//         [admin_id, staff_id]
//       );

//       res.status(201).json({
//         success: true,
//         message: "Clock-in recorded",
//       });
//     } catch (error) {
//       res.status(500).json({ success: false, error: error.message });
//     }
//   }
// );
router.post(
  "/attendance/clock-in",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    try {
      const staff_id = req.user.id;
      const admin_id = req.user.adminId;

      // ✅ IST date & time (Node controlled)
      const now = new Date();

      const istDate = now.toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      }); // YYYY-MM-DD

      const istTime = now.toLocaleTimeString("en-GB", {
        timeZone: "Asia/Kolkata",
        hour12: false,
      }); // HH:mm:ss

      // ❌ Prevent double clock-in
      const [exists] = await db.execute(
        `SELECT id FROM staff_attendance 
         WHERE staff_id = ? AND date = ?`,
        [staff_id, istDate]
      );

      if (exists.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Already clocked in today",
        });
      }

      await db.execute(
        `INSERT INTO staff_attendance
         (admin_id, staff_id, date, clock_in)
         VALUES (?, ?, ?, ?)`,
        [admin_id, staff_id, istDate, istTime]
      );

      res.status(201).json({
        success: true,
        message: "Clock-in recorded",
        date: istDate,
        clock_in: istTime,
      });
    } catch (error) {
      console.error("Clock-in error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

/* ======================================================
// CREATE Attendance by Staff clock out  
====================================================== */
// router.post(
//   "/attendance/clock-out",
//   authMiddleware,
//   allowRoles("doctor", "receptionist"),
//   async (req, res) => {
//     try {
//       const staff_id = req.user.id;

//       // Check record for today
//       const [rows] = await db.execute(
//         `SELECT * FROM staff_attendance 
//          WHERE staff_id = ? AND date = CURDATE()`,
//         [staff_id]
//       );

//       if (!rows.length) {
//         return res.status(400).json({
//           success: false,
//           message: "Clock-in not found for today",
//         });
//       }

//       const record = rows[0];

//       if (record.clock_out) {
//         return res.status(400).json({
//           success: false,
//           message: "Already clocked out today",
//         });
//       }

//       // Calculate total hours in MySQL
//       const [update] = await db.execute(
//         `
//         UPDATE staff_attendance
//         SET 
//           clock_out = CURTIME(),
//           total_hours = TIMESTAMPDIFF(MINUTE, 
//                 CONCAT(date, ' ', clock_in), 
//                 CONCAT(date, ' ', CURTIME())
//           ) / 60,
//           status = CASE
//                       WHEN TIMESTAMPDIFF(MINUTE, CONCAT(date,' ',clock_in), CONCAT(date,' ',CURTIME()))/60 >= 6 
//                         THEN 'present'
//                       WHEN TIMESTAMPDIFF(MINUTE, CONCAT(date,' ',clock_in), CONCAT(date,' ',CURTIME()))/60 >= 4 
//                         THEN 'half_day'
//                       ELSE 'absent'
//                    END
//         WHERE staff_id = ? AND date = CURDATE()
//       `,
//         [staff_id]
//       );

//       res.status(200).json({
//         success: true,
//         message: "Clock-out recorded with status calculated",
//       });
//     } catch (error) {
//       res.status(500).json({ success: false, error: error.message });
//     }
//   }
// );
router.post(
  "/attendance/clock-out",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    try {
      const staff_id = req.user.id;

      // ✅ IST date & time
      const now = new Date();

      const istDate = now.toLocaleDateString("en-CA", {
        timeZone: "Asia/Kolkata",
      }); // YYYY-MM-DD

      const istTime = now.toLocaleTimeString("en-GB", {
        timeZone: "Asia/Kolkata",
        hour12: false,
      }); // HH:mm:ss

      // 🔍 Fetch today's attendance (IST date)
      const [rows] = await db.execute(
        `SELECT * FROM staff_attendance 
         WHERE staff_id = ? AND date = ?`,
        [staff_id, istDate]
      );

      if (!rows.length) {
        return res.status(400).json({
          success: false,
          message: "Clock-in not found for today",
        });
      }

      const record = rows[0];

      if (record.clock_out) {
        return res.status(400).json({
          success: false,
          message: "Already clocked out today",
        });
      }

      // ⏱️ Calculate total hours in Node (safer)
      const clockIn = new Date(`${istDate}T${record.clock_in}`);
      const clockOut = new Date(`${istDate}T${istTime}`);

      const diffMs = clockOut - clockIn;
      const totalHours = +(diffMs / (1000 * 60 * 60)).toFixed(2);

      // 🏷️ Status logic
      let status = "absent";
      if (totalHours >= 6) status = "present";
      else if (totalHours >= 4) status = "half_day";

      // ✅ Update record
      await db.execute(
        `UPDATE staff_attendance
         SET clock_out = ?, total_hours = ?, status = ?
         WHERE staff_id = ? AND date = ?`,
        [istTime, totalHours, status, staff_id, istDate]
      );

      res.status(200).json({
        success: true,
        message: "Clock-out recorded",
        clock_out: istTime,
        total_hours: totalHours,
        status,
      });
    } catch (error) {
      console.error("Clock-out error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

/* ======================================================
// GET date wise Attendance by Staff them self and for Admin only his staff
====================================================== */
router.get(
  "/attendance/date",
  authMiddleware,
  allowRoles("doctor", "receptionist", "admin"),
  async (req, res) => {
    try {
      const staff_id = req.user.id;
      const admin_id = req.user.id;
      const role = req.user.role;

      // get ?date from query
      const { date } = req.query;

      if (!date) {
        return res.status(400).json({
          success: false,
          message: "date is required in query (YYYY-MM-DD)",
        });
      }

      let query;
      let params;

      // ADMIN → fetch attendance of all staff for selected date
      if (role === "admin") {
        query = `
  SELECT 
    sa.clock_in,
    sa.clock_out,
    sa.status,
    sa.total_hours,
    sa.date,
    sa.staff_id,
    s.name
  FROM staff_attendance sa
  JOIN staff s ON s.id = sa.staff_id
  WHERE sa.admin_id = ? AND sa.date = ?
`;
        params = [admin_id, date];
      }

      // STAFF → fetch only his/her own attendance for selected date
      else if (role === "doctor" || role === "receptionist") {
        query = `
          SELECT clock_in, clock_out, status, total_hours, date, staff_id
          FROM staff_attendance
          WHERE staff_id = ? AND date = ?
        `;
        params = [staff_id, date];
      }

      const [rows] = await db.execute(query, params);

      res.status(200).json({
        success: true,
        date: date,
        data: rows,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* ======================================================
// GET Attendance by Staff or Admin all  
====================================================== */
router.get(
  "/attendance/all",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const user = req.user; // { id, role }
      const { date, month, year, staff_id } = req.query;

      const currentYear = year || new Date().getFullYear();
      const currentMonth = month || new Date().getMonth() + 1;

      let query = "";
      let params = [];

      if (user.role === "admin") {
        query = `
          SELECT sa.*, s.name AS staff_name , s.role AS role, s.branch AS branch
          FROM staff_attendance sa
          LEFT JOIN staff s ON sa.staff_id = s.id
          WHERE sa.admin_id = ?
        `;
        params.push(user.id);

        // 🔹 Single date filter
        if (date) {
          query += ` AND sa.date = ?`;
          params.push(date);
        }

        // 🔹 Month-wise filter
        if (!date && month && year) {
          query += ` AND MONTH(sa.date) = ? AND YEAR(sa.date) = ?`;
          params.push(month, year);
        }

        // 🔹 Staff filter
        if (staff_id) {
          query += ` AND sa.staff_id = ?`;
          params.push(staff_id);
        }
      } else {
        query = `
          SELECT sa.*, s.name AS staff_name 
          FROM staff_attendance sa
          LEFT JOIN staff s ON sa.staff_id = s.id
          WHERE sa.staff_id = ?
        `;
        params.push(user.id);

        if (date) {
          query += ` AND sa.date = ?`;
          params.push(date);
        }

        if (!date && month && year) {
          query += ` AND MONTH(sa.date) = ? AND YEAR(sa.date) = ?`;
          params.push(month, year);
        }
      }

      // 🔹 Default = current month
      if (!date && !month && !year) {
        query += ` AND MONTH(sa.date) = ? AND YEAR(sa.date) = ?`;
        params.push(currentMonth, currentYear);
      }

      query += ` ORDER BY sa.date DESC`;

      const [rows] = await db.execute(query, params);

      res.status(200).json({
        success: true,
        role: user.role,
        data: rows,
      });
    } catch (error) {
      console.error("Attendance error:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

/* ======================================================
// GET Doctors List (Receptionist: same branch doctor attendance list )
====================================================== */
router.get(
  "/doctors/list",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const user = req.user; // { id, role, admin_id }

      let query = "";
      let params = [];

      // =========================
      // RECEPTIONIST → SAME BRANCH DOCTORS
      // =========================
      if (user.role === "receptionist") {
        query = `
    SELECT 
      d.id,
      d.name,
      d.email,
      d.mobile,
      d.branch,
      d.status,
      d.role,

      sa.status AS attendance_status,
      sa.clock_in,
      sa.clock_out

    FROM staff d
    JOIN staff r ON r.id = ?
    LEFT JOIN staff_attendance sa
    ON sa.staff_id = d.id
    AND sa.date = CURDATE()

    WHERE d.role = 'doctor'
      AND d.admin_id = r.admin_id
      AND d.branch = r.branch

    ORDER BY d.name ASC
  `;
        params.push(user.id);
      }

      const [rows] = await db.execute(query, params);

      res.status(200).json({
        success: true,
        role: user.role,
        data: rows,
      });
    } catch (error) {
      console.error("Doctor list error:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// GET DOCTORS PRESENT AND AVAILABLE TODAY
router.get(
  "/attendance/doctors",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = req.user.id;
      const { date } = req.query;

      if (!date) {
        return res.status(400).json({
          success: false,
          message: "date is required in query (YYYY-MM-DD)",
        });
      }

      const query = `
        SELECT 
          s.id AS staff_id,
          s.name,
          COALESCE(sa.status, 'absent') AS status
        FROM staff s
        LEFT JOIN staff_attendance sa 
          ON sa.staff_id = s.id 
          AND sa.date = ?
          AND sa.admin_id = ?
        WHERE s.role = 'doctor'
          AND s.admin_id = ?
      `;

      const [rows] = await db.execute(query, [
        date,
        admin_id,
        admin_id,
      ]);

      const presentDoctors = rows.filter(
        (row) => row.status === "present"
      );

      const leaveDoctors = rows.filter(
        (row) => row.status === "absent"
      );

      res.status(200).json({
        success: true,
        date,
        presentDoctors,
        presentCount: presentDoctors.length,
        leaveDoctors,
        leaveCount: leaveDoctors.length,
        totalDoctors: rows.length,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);


/* ======================================================
// UPDATE Attendance for Admin (any staff or own record)
====================================================== */
router.put(
  "/attendance/admin/update/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const adminId = req.user.id;
      const attendanceId = req.params.id;
      const { clock_in, clock_out } = req.body;

      await conn.beginTransaction();

      /* ======================================================
         1️⃣ GET ATTENDANCE + STAFF INFO
      ====================================================== */
      const [[row]] = await conn.execute(
        `
        SELECT 
          sa.id,
          sa.staff_id,
          sa.date,
          s.role
        FROM staff_attendance sa
        JOIN staff s ON s.id = sa.staff_id
        WHERE sa.id = ? AND s.admin_id = ?
        `,
        [attendanceId, adminId]
      );

      if (!row) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Attendance record not found",
        });
      }

      const { staff_id, date, role: staffRole } = row; // doctor | receptionist

      /* ======================================================
         2️⃣ UPDATE ATTENDANCE
      ====================================================== */
      await conn.execute(
        `
        UPDATE staff_attendance
        SET 
          clock_in = ?,
          clock_out = ?,
          total_hours =
            CASE
              WHEN ? IS NOT NULL AND ? IS NOT NULL
              THEN TIMESTAMPDIFF(
                     MINUTE,
                     CONCAT(date,' ',?),
                     CONCAT(date,' ',?)
                   ) / 60
              ELSE total_hours
            END,
          status =
            CASE
              WHEN ? IS NOT NULL AND ? IS NOT NULL THEN
                CASE
                  WHEN TIMESTAMPDIFF(
                         MINUTE,
                         CONCAT(date,' ',?),
                         CONCAT(date,' ',?)
                       ) / 60 >= 6 THEN 'present'
                  WHEN TIMESTAMPDIFF(
                         MINUTE,
                         CONCAT(date,' ',?),
                         CONCAT(date,' ',?)
                       ) / 60 >= 4 THEN 'half_day'
                  ELSE 'absent'
                END
              ELSE status
            END
        WHERE id = ?
        `,
        [
          clock_in,
          clock_out,
          clock_in,
          clock_out,
          clock_in,
          clock_out,
          clock_in,
          clock_out,
          clock_in,
          clock_out,
          clock_in,
          clock_out,
          attendanceId,
        ]
      );

      /* ======================================================
         3️⃣ CREATE NOTIFICATION (ADMIN → STAFF)
      ====================================================== */
      const title = "Attendance Updated";
      const message = `Your attendance for ${date} has been updated by admin`;

      const [notifResult] = await conn.execute(
        `
        INSERT INTO notifications
          (admin_id, sender_role, title, message, type)
        VALUES
          (?, 'admin', ?, ?, 'attendance')
        `,
        [adminId, title, message]
      );

      const notificationId = notifResult.insertId;

      /* ======================================================
         4️⃣ MAP RECEIVER (doctor / receptionist ONLY)
      ====================================================== */
      await conn.execute(
        `
        INSERT INTO notification_receivers
          (notification_id, receiver_role, receiver_id)
        VALUES
          (?, ?, ?)
        `,
        [notificationId, staffRole, staff_id]
      );

      await conn.commit();

      /* ======================================================
         5️⃣ SOCKET NOTIFICATION (MATCH DASHBOARD ROOM)
      ====================================================== */
      if (global.io) {
        global.io
          .to(`${staffRole}_${staff_id}`) // doctor_12 / receptionist_7
          .emit("new-notification", {
            id: notificationId,
            title,
            message,
            type: "attendance",
          });
      }

      return res.json({
        success: true,
        message: "Attendance updated and notification sent",
      });

    } catch (error) {
      await conn.rollback();
      console.error("Attendance update error:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    } finally {
      conn.release();
    }
  }
);



/* ======================================================
// DELETE Attendance by Staff or Admin by attendance ID
====================================================== */

router.delete(
  "/attendance/delete/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = req.user.id;
      const attendanceId = req.params.id;

      const [check] = await db.execute(
        "SELECT id FROM staff_attendance WHERE id = ? AND admin_id = ?",
        [attendanceId, admin_id]
      );

      if (!check.length) {
        return res.status(404).json({
          success: false,
          message: "Attendance not found",
        });
      }

      await db.execute("DELETE FROM staff_attendance WHERE id = ?", [
        attendanceId,
      ]);

      res.status(200).json({
        success: true,
        message: "Attendance deleted",
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        details: error.message,
      });
    }
  }
);

/* ======================================================
// Attendance Correction Methods Routes Start  ==================
====================================================== */

/* ======================================================
//Staff Request Attendance Correction
====================================================== */
router.post(
  "/attendance/request-correction",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    try {
      const staff_id = req.user.id;
      const staff_role = req.user.role;
      const staff_name = req.user.name;
      const admin_id = req.user.adminId; // Staff must belong to an admin
      const { date, clock_in, clock_out, reason } = req.body;

      console.log(staff_id, staff_role, admin_id, staff_name);

      // Validation
      if (!date || !reason) {
        return res.status(400).json({
          success: false,
          message: "date and reason are required",
        });
      }

      if (!admin_id) {
        return res.status(400).json({
          success: false,
          message: "Admin not linked to staff",
        });
      }

      // Create notification record
      const title = "Attendance Update Request";

      const fullMessage = `
      Staff ID: ${staff_id}
      Staff Name: ${staff_name}
      Staff Role: ${staff_role}
      Requested Date: ${date}
      Requested Clock-In: ${clock_in || "Not Provided"}
      Requested Clock-Out: ${clock_out || "Not Provided"}
      Reason: ${reason}
      `;

      // Insert into notifications table
      const [notiResult] = await db.execute(
        `INSERT INTO notifications 
        (admin_id, sender_role, sender_id, title, message, type)
        VALUES (?, ?, ?, ?, ?, 'request')`,
        [admin_id, staff_role, staff_id, title, fullMessage.trim()]
      );

      const notification_id = notiResult.insertId;

      // Insert notification_receiver for admin
      await db.execute(
        `INSERT INTO notification_receivers 
        (notification_id, receiver_role, receiver_id)
        VALUES (?, 'admin', ?)`,
        [notification_id, admin_id]
      );

      // Send socket notification to admin
      const socketData = {
        notification_id,
        staff_id,
        date,
        clock_in: clock_in || null,
        clock_out: clock_out || null,
        reason,
        title,
        message: "New attendance update request from staff",
        created_at: new Date(),
      };

      // Notify the admin (admin’s room is admin_id)
      if (global.io) {
        global.io
          .to(admin_id.toString())
          .emit("attendance_request", socketData);
      }

      res.status(201).json({
        success: true,
        message: "Attendance correction request sent to admin",
        notification_id,
      });
    } catch (error) {
      console.error("Request Correction Error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* ======================================================
//admin get requested attendance updates
====================================================== */
router.get(
  "/attendance/update-requests",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;
      const { staff_id } = req.query; // optional filter

      let query = `
  SELECT 
    n.id AS notification_id,
    n.title,
    n.message,
    n.created_at,
    n.admin_id,
    n.sender_id AS staff_id,
    s.name AS staff_name
  FROM notifications n
  INNER JOIN notification_receivers nr 
      ON nr.notification_id = n.id
  INNER JOIN staff s 
      ON s.id = n.sender_id
  WHERE 
      n.type = 'request'
      AND n.sender_role IN ('doctor', 'receptionist')
      AND n.admin_id = ?
`;

      const params = [adminId];

      if (staff_id) {
        query += ` AND n.sender_id = ? `;
        params.push(staff_id);
      }

      query += ` ORDER BY n.created_at DESC `;

      const [rows] = await db.execute(query, params);

      return res.status(200).json({
        success: true,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

/* ======================================================
//Admin Update Staff Attendance
====================================================== */
router.put(
  "/attendance/update/:notification_id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const adminId = req.user.id;
      const { notification_id } = req.params;
      const { staff_id, date, clock_in, clock_out } = req.body;

      if (!staff_id || !date) {
        return res.status(400).json({
          success: false,
          message: "staff_id and date are required",
        });
      }

      await conn.beginTransaction();

      /* ======================================================
         1️⃣ VERIFY STAFF & GET ROLE
      ====================================================== */
      const [[staff]] = await conn.execute(
        `SELECT id, role FROM staff WHERE id = ? AND admin_id = ?`,
        [staff_id, adminId]
      );

      if (!staff) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Staff not found",
        });
      }

      const staffRole = staff.role; // ✅ doctor | receptionist

      /* ======================================================
         2️⃣ INSERT / UPDATE ATTENDANCE
      ====================================================== */
      const [existing] = await conn.execute(
        `SELECT id FROM staff_attendance
         WHERE staff_id = ? AND date = ?`,
        [staff_id, date]
      );

      if (existing.length === 0) {
        await conn.execute(
          `INSERT INTO staff_attendance
           (admin_id, staff_id, date, clock_in, clock_out)
           VALUES (?, ?, ?, ?, ?)`,
          [adminId, staff_id, date, clock_in || null, clock_out || null]
        );
      } else {
        await conn.execute(
          `UPDATE staff_attendance
           SET clock_in = ?, clock_out = ?
           WHERE staff_id = ? AND date = ?`,
          [clock_in || null, clock_out || null, staff_id, date]
        );
      }

      /* ======================================================
         3️⃣ CALCULATE HOURS & STATUS
      ====================================================== */
      await conn.execute(
        `
        UPDATE staff_attendance
        SET
          total_hours =
            CASE
              WHEN clock_in IS NOT NULL AND clock_out IS NOT NULL
              THEN TIMESTAMPDIFF(MINUTE, clock_in, clock_out) / 60
              ELSE total_hours
            END,
          status =
            CASE
              WHEN clock_in IS NULL OR clock_out IS NULL THEN status
              WHEN TIMESTAMPDIFF(MINUTE, clock_in, clock_out) / 60 >= 6 THEN 'present'
              WHEN TIMESTAMPDIFF(MINUTE, clock_in, clock_out) / 60 >= 4 THEN 'half_day'
              ELSE 'absent'
            END
        WHERE staff_id = ? AND date = ?
        `,
        [staff_id, date]
      );

      /* ======================================================
         4️⃣ REMOVE ADMIN REQUEST NOTIFICATION
      ====================================================== */
      await conn.execute(
        `DELETE FROM notification_receivers
         WHERE notification_id = ?
           AND receiver_role = 'admin'
           AND receiver_id = ?`,
        [notification_id, adminId]
      );

      const [[remaining]] = await conn.execute(
        `SELECT COUNT(*) AS total
         FROM notification_receivers
         WHERE notification_id = ?`,
        [notification_id]
      );

      if (remaining.total === 0) {
        await conn.execute(
          `DELETE FROM notifications WHERE id = ?`,
          [notification_id]
        );
      }

      /* ======================================================
         5️⃣ CREATE STAFF NOTIFICATION (FIXED)
      ====================================================== */
      const title = "Attendance Approved";
      const message = `Your attendance for ${date} has been approved`;

      const [notif] = await conn.execute(
        `INSERT INTO notifications
         (admin_id, sender_role, title, message, type)
         VALUES (?, 'admin', ?, ?, 'attendance')`,
        [adminId, title, message]
      );

      const newNotificationId = notif.insertId;

      // ✅ IMPORTANT FIX HERE
      await conn.execute(
        `INSERT INTO notification_receivers
         (notification_id, receiver_role, receiver_id)
         VALUES (?, ?, ?)`,
        [newNotificationId, staffRole, staff_id]
      );

      await conn.commit();

      /* ======================================================
         6️⃣ SOCKET NOTIFICATION
      ====================================================== */
      if (global.io) {
        global.io
          .to(`${staffRole}_${staff_id}`)
          .emit("new-notification", {
            notification_id: newNotificationId,
            title,
            message,
            type: "attendance",
          });
      }

      return res.json({
        success: true,
        message: "Attendance updated and staff notified",
      });

    } catch (error) {
      await conn.rollback();
      console.error("Attendance update error:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    } finally {
      conn.release();
    }
  }
);


/* ======================================================
// Attendance Correction Methods Ends  ===================
====================================================== */

router.get(
  "/doctor/attendance-by-date",
  authMiddleware,
  allowRoles("receptionist", "admin"),
  async (req, res) => {
    try {
      const { date } = req.query;
      const role = req.user.role;

      if (!date) {
        return res.status(400).json({
          success: false,
          message: "Date is required",
        });
      }

      // 🔑 Correct adminId resolution
      const adminId =
        role === "admin" ? req.user.id : req.user.adminId;

      let branchCondition = "";
      let params = [date, adminId]; // ✅ CORRECT ORDER

      /* ===============================
         Receptionist → same branch
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
            message: "Branch not found",
          });
        }

        branchCondition = "AND s.branch = ?";
        params.push(staff.branch);
      }

      /* ===============================
         Doctors attendance list
      =============================== */
      const [rows] = await db.execute(
        `
        SELECT
          s.id AS doctorId,
          s.name AS doctorName,
          COALESCE(sa.status, 'absent') AS attendanceStatus,
          sa.clock_in AS clockIn,
          sa.clock_out AS clockOut
        FROM staff s
        LEFT JOIN staff_attendance sa
          ON sa.staff_id = s.id
          AND sa.date = ?
        WHERE s.admin_id = ?
          AND s.role = 'doctor'
          ${branchCondition}
        ORDER BY s.name ASC
        `,
        params
      );

      /* ===============================
         Summary counts
      =============================== */
      const presentCount = rows.filter(
        (r) => r.attendanceStatus === "present"
      ).length;

      const absentCount = rows.filter(
        (r) => r.attendanceStatus === "absent"
      ).length;

      res.json({
        success: true,
        date,
        summary: {
          present: presentCount,
          absent: absentCount,
        },
        doctors: rows,
      });
    } catch (error) {
      console.error("Doctor attendance error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch attendance",
      });
    }
  }
);
module.exports = router;
