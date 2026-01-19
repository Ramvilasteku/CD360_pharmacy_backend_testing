// routes/scheduleRoutes.js
const express = require('express');
const router = express.Router();
const db = require('../db.js');
const {authMiddleware} = require('../middlewares/authMiddleware');
const {allowRoles} = require('../middlewares/roleMiddleware.js');

/* ============================================================================
   1️⃣ GET DOCTORS BY BRANCH (for receptionist)
============================================================================ */
router.get(
  "/doctors-by-branch",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const staffId = req.user.id;
      const adminId = req.user.adminId;

      const [staffRows] = await db.execute(
        `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
        [staffId, adminId]
      );

      if (!staffRows.length) {
        return res.status(404).json({
          success: false,
          message: "Receptionist not found",
        });
      }

      const branch = staffRows[0].branch;

      const [doctors] = await db.execute(
        `
        SELECT
          id,
          name,
          email,
          mobile,
          qualification,
          profile_photo,
          date_of_joining
        FROM staff
        WHERE admin_id = ?
          AND branch = ?
          AND role = 'doctor'
          AND status = 1
        ORDER BY name ASC
        `,
        [adminId, branch]
      );

      return res.json({
        success: true,
        data: {
          branch: branch,
          doctors: doctors,
        },
      });
    } catch (error) {
      console.error("Get doctors by branch error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

/* ============================================================================
   2️⃣ GET WEEKS IN A MONTH
============================================================================ */
router.get(
  "/schedule/weeks",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const { month, year } = req.query;
      
      if (!month || !year) {
        return res.status(400).json({
          success: false,
          message: "Month and year are required",
        });
      }

      const monthNumber = parseInt(month);
      const yearNumber = parseInt(year);

      const firstDay = new Date(yearNumber, monthNumber - 1, 1);
      const lastDay = new Date(yearNumber, monthNumber, 0);
      
      const totalDays = lastDay.getDate();
      const weeksCount = Math.ceil(totalDays / 7);

      const weeks = [];
      for (let i = 1; i <= weeksCount; i++) {
        const weekStart = new Date(firstDay);
        weekStart.setDate(1 + (i - 1) * 7);
        
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        
        if (weekEnd > lastDay) {
          weekEnd.setTime(lastDay.getTime());
        }

        weeks.push({
          value: i,
          label: `Week ${i}`,
          startDate: weekStart.toISOString().split('T')[0],
          endDate: weekEnd.toISOString().split('T')[0],
        });
      }

      return res.json({
        success: true,
        data: {
          month: monthNumber,
          year: yearNumber,
          weeks: weeks,
        },
      });
    } catch (error) {
      console.error("Get weeks error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

/* ============================================================================
   3️⃣ GET SCHEDULE WITH TIME SLOTS AND APPOINTMENTS
============================================================================ */
router.get(
  "/schedule",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const staffId = req.user.id;
      const adminId = req.user.adminId;
      const { week, month, year } = req.query;

      if (!week || !month || !year) {
        return res.status(400).json({
          success: false,
          message: "Week, month, year required",
        });
      }

      /* 1️⃣ Get receptionist branch */
      const [staffRows] = await db.execute(
        `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
        [staffId, adminId]
      );

      if (!staffRows.length) {
        return res.status(404).json({ success: false });
      }

      const branch = staffRows[0].branch;

      /* 2️⃣ Doctors */
      const [doctors] = await db.execute(
        `
        SELECT id, name, qualification, profile_photo
        FROM staff
        WHERE admin_id = ?
          AND branch = ?
          AND role = 'doctor'
          AND status = 1
        ORDER BY name
        `,
        [adminId, branch]
      );

      if (!doctors.length) {
        return res.json({
          success: true,
          data: { branch, doctors: [], dates: [], timeSlots: [] },
        });
      }

      /* 3️⃣ Calculate week dates */
      const start = new Date(year, month - 1, 1 + (week - 1) * 7);
      const dates = [];

      for (let i = 0; i < 6; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        if (d.getMonth() === month - 1) {
          dates.push(d.toISOString().split("T")[0]);
        }
      }

      const doctorIds = doctors.map(d => d.id);
      const doctorPH = doctorIds.map(() => "?").join(",");
      const datePH = dates.map(() => "?").join(",");

      /* 4️⃣ SLOT-DRIVEN QUERY (NO TABLE CHANGES) */
      const query = `
        SELECT
  sts.id AS slotId,
  sts.staff_id AS staffId,
  DATE_FORMAT(sts.slot_date,'%Y-%m-%d') AS slotDate,
  TIME_FORMAT(sts.slot_time_from,'%H:%i:%s') AS slotTimeFrom,
  TIME_FORMAT(sts.slot_time_to,'%H:%i:%s') AS slotTimeTo,

  a.id AS appointmentId,
  a.status AS appointmentStatus,
  a.purpose AS purpose,

  c.name AS clientName,
  c.mobile AS clientMobile,
  c.email AS clientEmail,

  CASE 
    WHEN a.id IS NOT NULL THEN 1 
    ELSE 0 
  END AS hasAppointment

FROM staff_time_slots sts
LEFT JOIN appointments a
  ON a.staff_id = sts.staff_id
  AND DATE(a.appointment_date) = sts.slot_date
  AND TIME(a.from_time) = sts.slot_time_from
  AND TIME(a.to_time) = sts.slot_time_to
  AND a.status != 'cancelled'
LEFT JOIN clients c ON c.id = a.client_id

      `;

      const [timeSlots] = await db.execute(
        query,
        [adminId, ...doctorIds, ...dates]
      );

      return res.json({
        success: true,
        data: {
          branch,
          doctors,
          dates,
          timeSlots,
        },
      });

    } catch (error) {
      console.error("Schedule error:", error);
      res.status(500).json({ success: false });
    }
  }
);


/* ============================================================================
   4️⃣ GET SLOT DETAILS (for popup/modal)
============================================================================ */
router.get(
  "/schedule/slot-details/:slotId",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const { slotId } = req.params;
      const adminId = req.user.adminId;

      const [slotDetails] = await db.execute(
        `
        SELECT
          sts.id AS slotId,
          DATE_FORMAT(sts.slot_date, '%Y-%m-%d') AS slotDate,
          TIME_FORMAT(sts.slot_time_from, '%H:%i:%s') AS slotTimeFrom,
          TIME_FORMAT(sts.slot_time_to, '%H:%i:%s') AS slotTimeTo,
          sts.is_booked AS isBooked,
          
          s.id AS doctorId,
          s.name AS doctorName,
          s.qualification AS doctorQualification,
          s.profile_photo AS doctorPhoto,
          
          a.id AS appointmentId,
          a.status AS appointmentStatus,
          a.purpose AS purpose,
          a.created_at AS bookingTime,
          
          c.id AS clientId,
          c.name AS clientName,
          c.mobile AS clientMobile,
          c.email AS clientEmail,
          c.gender AS clientGender,
          c.dob AS clientDob,
          c.blood_group AS clientBloodGroup,
          c.address AS clientAddress

        FROM staff_time_slots sts

        INNER JOIN staff s 
          ON s.id = sts.staff_id

        LEFT JOIN appointments a 
          ON a.staff_id = sts.staff_id
          AND DATE(a.appointment_date) = DATE(sts.slot_date)
          AND TIME(a.from_time) = TIME(sts.slot_time_from)
          AND TIME(a.to_time) = TIME(sts.slot_time_to)
          AND a.status NOT IN ('cancelled')

        LEFT JOIN clients c 
          ON c.id = a.client_id

        WHERE sts.id = ?
          AND sts.admin_id = ?
        `,
        [slotId, adminId]
      );

      if (!slotDetails.length) {
        return res.status(404).json({
          success: false,
          message: "Slot not found",
        });
      }

      return res.json({
        success: true,
        data: slotDetails[0],
      });

    } catch (error) {
      console.error("Get slot details error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

module.exports = router;