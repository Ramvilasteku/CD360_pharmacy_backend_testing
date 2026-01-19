const express = require("express");
const router = express.Router();
const db = require("../db");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* ======================================================
// CREATE Attendance by Staff clock in  
====================================================== */
router.post(
  "/attendance/clock-in",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    try {
      const staff_id = req.user.id;
      const admin_id = req.user.adminId;

      // Check if already clocked-in today
      const [exists] = await db.execute(
        `SELECT * FROM staff_attendance 
         WHERE staff_id = ? AND date = CURDATE()`,
        [staff_id]
      );

      if (exists.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Already clocked in today",
        });
      }

      await db.execute(
        `INSERT INTO staff_attendance 
        (admin_id, staff_id, date, clock_in, created_at)
        VALUES (?, ?, CURDATE(), CURTIME(), NOW())`,
        [admin_id, staff_id]
      );

      res.status(201).json({
        success: true,
        message: "Clock-in recorded",
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* ======================================================
// CREATE Attendance by Staff clock out  
====================================================== */
router.post(
  "/attendance/clock-out",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    try {
      const staff_id = req.user.id;

      // Check record for today
      const [rows] = await db.execute(
        `SELECT * FROM staff_attendance 
         WHERE staff_id = ? AND date = CURDATE()`,
        [staff_id]
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

      // Calculate total hours in MySQL
      const [update] = await db.execute(
        `
        UPDATE staff_attendance
        SET 
          clock_out = CURTIME(),
          total_hours = TIMESTAMPDIFF(MINUTE, 
                CONCAT(date, ' ', clock_in), 
                CONCAT(date, ' ', CURTIME())
          ) / 60,
          status = CASE
                      WHEN TIMESTAMPDIFF(MINUTE, CONCAT(date,' ',clock_in), CONCAT(date,' ',CURTIME()))/60 >= 6 
                        THEN 'present'
                      WHEN TIMESTAMPDIFF(MINUTE, CONCAT(date,' ',clock_in), CONCAT(date,' ',CURTIME()))/60 >= 4 
                        THEN 'half_day'
                      ELSE 'absent'
                   END
        WHERE staff_id = ? AND date = CURDATE()
      `,
        [staff_id]
      );

      res.status(200).json({
        success: true,
        message: "Clock-out recorded with status calculated",
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
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
          SELECT clock_in, clock_out, status, total_hours, date, staff_id
          FROM staff_attendance
          WHERE admin_id = ? AND date = ?
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

/* ======================================================
// UPDATE Attendance for Admin (any staff or own record)
====================================================== */
router.put(
  "/attendance/admin/update/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const admin_id = req.user.id;
      const attendanceId = req.params.id;
      const { clock_in, clock_out } = req.body;

      // Check if the attendance exists and belongs to this admin (or admin themselves)
      const [check] = await db.execute(
        "SELECT * FROM staff_attendance WHERE id=? AND (admin_id=? OR (admin_id IS NULL AND staff_id=?))",
        [attendanceId, admin_id, admin_id]
      );

      if (!check.length) {
        return res.status(404).json({
          success: false,
          message: "Attendance record not found or no permission",
        });
      }

      // Update record and calculate total_hours and status directly in SQL
      await db.execute(
        `
        UPDATE staff_attendance
        SET 
          clock_in = ?,
          clock_out = ?,
          total_hours = CASE 
                          WHEN ? IS NOT NULL AND ? IS NOT NULL 
                          THEN TIMESTAMPDIFF(MINUTE, CONCAT(date,' ',?), CONCAT(date,' ',?))/60
                          ELSE 0
                        END,
          status = CASE 
                      WHEN ? IS NOT NULL AND ? IS NOT NULL THEN
                        CASE 
                          WHEN TIMESTAMPDIFF(MINUTE, CONCAT(date,' ',?), CONCAT(date,' ',?))/60 >= 6 THEN 'present'
                          WHEN TIMESTAMPDIFF(MINUTE, CONCAT(date,' ',?), CONCAT(date,' ',?))/60 >= 4 THEN 'half_day'
                          ELSE 'absent'
                        END
                      ELSE 'absent'
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

      res.status(200).json({
        success: true,
        message: "Attendance record updated successfully",
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
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
    try {
      const adminId = req.user.id;
      const notification_id = req.params.notification_id;

      const { staff_id, date, clock_in, clock_out } = req.body;

      if (!staff_id || !date) {
        return res.status(400).json({
          success: false,
          message: "staff_id and date are required",
        });
      }

      // Check attendance exists for the date
      const [rows] = await db.execute(
        `SELECT * FROM staff_attendance
         WHERE staff_id = ? AND date = ?`,
        [staff_id, date]
      );

      if (rows.length === 0) {
        // INSERT NEW ATTENDANCE IF NOT EXISTS
        await db.execute(
          `INSERT INTO staff_attendance 
            (admin_id, staff_id, date, clock_in, clock_out)
           VALUES (?, ?, ?, ?, ?)`,
          [adminId, staff_id, date, clock_in || null, clock_out || null]
        );
      } else {
        // UPDATE EXISTING ATTENDANCE
        await db.execute(
          `UPDATE staff_attendance
           SET clock_in = ?, clock_out = ?
           WHERE staff_id = ? AND date = ?`,
          [clock_in || null, clock_out || null, staff_id, date]
        );
      }

      // RECALCULATE TOTAL HOURS + STATUS
      await db.execute(
        `
        UPDATE staff_attendance
        SET 
          total_hours = 
            CASE 
              WHEN clock_in IS NOT NULL AND clock_out IS NOT NULL 
              THEN TIMESTAMPDIFF(MINUTE, clock_in, clock_out)/60
              ELSE total_hours
            END,

          status = (
            CASE
              WHEN clock_in IS NULL OR clock_out IS NULL THEN status
              WHEN TIMESTAMPDIFF(MINUTE, clock_in, clock_out)/60 >= 6 THEN 'present'
              WHEN TIMESTAMPDIFF(MINUTE, clock_in, clock_out)/60 >= 4 THEN 'half_day'
              ELSE 'absent'
            END
          )
        WHERE staff_id = ? AND date = ?
        `,
        [staff_id, date]
      );

      // MARK REQUEST AS READ
      await db.execute(
        `UPDATE notification_receivers
         SET is_read = 1, read_at = NOW()
         WHERE notification_id = ? AND receiver_role = 'admin'`,
        [notification_id]
      );

      // SEND SOCKET NOTIFICATION TO STAFF
      io.to("staff_" + staff_id).emit("attendance-request-updated", {
        staff_id,
        date,
        clock_in,
        clock_out,
        message: "Your attendance update has been approved",
      });

      return res.status(200).json({
        success: true,
        message: "Attendance updated successfully",
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
        success: false,
        error: error.message,
        error,
      });
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
