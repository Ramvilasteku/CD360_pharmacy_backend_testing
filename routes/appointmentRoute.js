// appointmentsRoutes.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const { sendAppointmentEmail } = require("../utils/mailer");
const { sendAppointmentStatusEmail } = require("../utils/mailer");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

// ===================== CREATE APPOINTMENT =====================
router.post(
  "/appointment/request",
  authMiddleware,
  allowRoles("client", "receptionist"),
  async (req, res) => {
    try {
      const { role, id: userId, adminId } = req.user;

      let clientId;
      let {
        doctorId,
        appointment_date,
        from_time,
        to_time,
        client_id,
        purpose, // ✅ NEW
        selected_branch, // NEW
      } = req.body;

      appointment_date = appointment_date?.trim();
      from_time = from_time?.trim();
      to_time = to_time?.trim();
      doctorId = Number(doctorId);
      client_id = client_id ? Number(client_id) : null;
      purpose = purpose?.trim();
      selected_branch = selected_branch?.trim();

      if (
        !doctorId ||
        !appointment_date ||
        !from_time ||
        !to_time ||
        !purpose ||
        !selected_branch
      ) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // 🔐 Role handling
      clientId = role === "client" ? userId : client_id;

      // 👤 Client validation
      const [clients] = await db.query(
        `SELECT id, name, email FROM clients WHERE id=? AND admin_id=?`,
        [clientId, adminId]
      );
      if (!clients.length) {
        return res.status(404).json({ message: "Client not found" });
      }
      const client = clients[0];

      // 👨‍⚕️ Doctor validation
      // 👨‍⚕️ Doctor validation
      const [doctors] = await db.query(
        `SELECT id, name, branch FROM staff
        WHERE id=? AND role='doctor' AND admin_id=? AND status=1`,
        [doctorId, adminId]
      );

      if (!doctors.length) {
        return res.status(404).json({ message: "Doctor not found" });
      }
      const doctor = doctors[0];

      /* =================================================
   🆕 RECEPTIONIST → SAME BRANCH DOCTOR ONLY
================================================= */
      if (role === "receptionist") {
        const [[receptionist]] = await db.query(
          `SELECT branch FROM staff
     WHERE id=? AND admin_id=? AND role='receptionist' AND status=1`,
          [userId, adminId]
        );

        if (!receptionist) {
          return res.status(403).json({ message: "Invalid receptionist" });
        }

        // 🔹 Normalize branches (trim + lowercase)
        const receptionistBranch = receptionist.branch?.trim().toLowerCase();
        const doctorBranch = doctor.branch?.trim().toLowerCase();

        // 🔹 Compare ONLY branches
        if (!receptionistBranch || receptionistBranch !== doctorBranch) {
          return res.status(403).json({
            message:
              "You can book appointments only for doctors in your branch",
          });
        }
      }

      // ⏱️ Slot availability
      const [slots] = await db.query(
        `SELECT id FROM staff_time_slots
         WHERE admin_id=? AND staff_id=? AND slot_date=?
         AND slot_time_from=? AND slot_time_to=? AND is_booked=0`,
        [adminId, doctorId, appointment_date, from_time, to_time]
      );
      if (!slots.length) {
        return res.status(400).json({ message: "Slot not available" });
      }
      const slotId = slots[0].id;

      const [receptionistsForContact] = await db.query(
        `SELECT mobile, email
   FROM staff
   WHERE role = 'receptionist'
     AND admin_id = ?
     AND status = 1
     AND LOWER(TRIM(branch)) = LOWER(TRIM(?))`,
        [adminId, doctor.branch]
      );

      const receptionistPhone =
        receptionistsForContact.length > 0
          ? receptionistsForContact[0].mobile
          : "";

      // 📝 Create appointment (AUTO ASSIGNED)
      const status = "assigned";

      const [result] = await db.query(
        `INSERT INTO appointments
(admin_id, client_id, staff_id, purpose, selected_branch, status, appointment_date, from_time, to_time, is_booked)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`,
        [
          adminId,
          clientId,
          doctorId,
          purpose, // ✅ NEW
          selected_branch, // ✅ NEW
          status,
          appointment_date,
          from_time,
          to_time,
        ]
      );

      const appointmentId = result.insertId;

      // 🔒 Lock slot
      await db.query(`UPDATE staff_time_slots SET is_booked=1 WHERE id=?`, [
        slotId,
      ]);

      // 🔔 Notification
      const title = "New Appointment Assigned";
      const message = `Appointment with Dr. ${doctor.name} on ${appointment_date} (${from_time}-${to_time})`;

      // 🔹 Create notification
      const [notif] = await db.query(
        `INSERT INTO notifications
   (admin_id,sender_role, sender_id, title, message, type)
   VALUES (?, ?, ?, ?, ?, 'appointment')`,
        [adminId, role, role === "client" ? clientId : userId, title, message]
      );

      const notificationId = notif.insertId;

      /* ===============================
   👨‍⚕️ DOCTOR RECEIVER
=============================== */
      await db.query(
        `INSERT INTO notification_receivers
   (notification_id, receiver_role, receiver_id)
   VALUES (?, 'doctor', ?)`,
        [notificationId, doctor.id]
      );

      global.io.to(doctor.id.toString()).emit("new-notification", {
        title,
        message,
        appointment_id: appointmentId,
      });

      /* ===============================
   🧑‍💼 RECEPTIONISTS (SAME BRANCH)
=============================== */

      // 🔹 Get doctor branch
      const [[doctorBranch]] = await db.query(
        `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
        [doctorId, adminId]
      );

      if (doctorBranch?.branch) {
        const [receptionists] = await db.query(
          `SELECT id FROM staff
     WHERE role = 'receptionist'
       AND admin_id = ?
       AND branch = ?
       AND status = 1`,
          [adminId, doctorBranch.branch]
        );

        for (const rec of receptionists) {
          await db.query(
            `INSERT INTO notification_receivers
       (notification_id, receiver_role, receiver_id)
       VALUES (?, 'receptionist', ?)`,
            [notificationId, rec.id]
          );

          global.io.to(rec.id.toString()).emit("new-notification", {
            title,
            message,
            appointment_id: appointmentId,
          });
        }
      }

      // ✉️ SEND EMAIL TO CLIENT
      await sendAppointmentEmail(client.email, {
        clientName: client.name,
        doctorName: doctor.name,
        branchName: doctorBranch.branch,
        receptionistPhone,
        date: appointment_date,
        fromTime: from_time,
        toTime: to_time,
      });

      return res.status(201).json({
        success: true,
        appointment_id: appointmentId,
        status,
        message: "Appointment booked, doctor assigned & email sent",
      });
    } catch (error) {
      console.error("Appointment Error:", error);
      res.status(500).json({ message: "Internal server error", error });
    }
  }
);

// ===================== default tota list or any date  LIST APPOINTMENTS =====================
router.get(
  "/appointments",
  authMiddleware,
  allowRoles("admin", "client", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const { role, id: userId } = req.user;
      const adminId = role === "admin" ? req.user.id : req.user.adminId;

      let { date, branch } = req.query;
      branch = branch ? branch.trim().toLowerCase() : null;

      // ==========================
      // BASE WHERE CONDITIONS
      // ==========================
      let baseWhere = `a.admin_id = ?`;
      let baseParams = [adminId];

      if (role === "client") {
        baseWhere += " AND a.client_id = ?";
        baseParams.push(userId);
      }

      if (role === "doctor") {
        baseWhere += " AND a.staff_id = ?";
        baseParams.push(userId);
      }

      if (role === "receptionist") {
        const [[receptionist]] = await db.query(
          `SELECT branch
           FROM staff
           WHERE id = ? AND admin_id = ? AND role = 'receptionist' AND status = 1`,
          [userId, adminId]
        );

        if (!receptionist || !receptionist.branch) {
          return res.status(403).json({
            success: false,
            message: "Invalid receptionist branch",
          });
        }

        const recBranch = receptionist.branch.trim().toLowerCase();
        baseWhere += " AND LOWER(s.branch) = ?";
        baseParams.push(recBranch);
        branch = recBranch;
      }

      if (role === "admin" && branch) {
        baseWhere += " AND LOWER(s.branch) = ?";
        baseParams.push(branch);
      }

      // ==========================
      // DATE FILTER (ONLY IF PROVIDED)
      // ==========================
      let listWhere = baseWhere;
      let listParams = [...baseParams];

      if (date) {
        listWhere += " AND DATE(a.appointment_date) = ?";
        listParams.push(date);
      }

      // ==========================
      // FETCH APPOINTMENTS
      // ==========================
      const [appointments] = await db.query(
        `SELECT
          a.id,
          a.purpose, -- ✅ NEW
          a.selected_branch, -- ✅ NEW
          DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS appointment_date,
          TIME_FORMAT(a.from_time, '%H:%i') AS from_time,
          TIME_FORMAT(a.to_time, '%H:%i') AS to_time,
          a.status,
          a.created_at,
          c.id AS client_id,
          c.name AS client_name,
          s.id AS doctor_id,
          s.name AS doctor_name,
          s.branch
         FROM appointments a
         JOIN clients c ON c.id = a.client_id
         JOIN staff s ON s.id = a.staff_id
         WHERE ${listWhere}
         ORDER BY appointment_date DESC, from_time ASC`,
        listParams
      );

      // ==========================
      // TOTAL APPOINTMENTS
      // ==========================
      let totalAppointments = appointments.length;

      if (role === "admin") {
        const today = new Date().toISOString().split("T")[0];
        const [[totalResult]] = await db.query(
          `SELECT COUNT(*) AS totalAppointments
           FROM appointments a
           JOIN staff s ON s.id = a.staff_id
           WHERE ${baseWhere}
             AND DATE(a.appointment_date) <= ?`,
          [...baseParams, today]
        );
        totalAppointments = totalResult.totalAppointments;
      }

      return res.status(200).json({
        success: true,
        role,
        branch: branch || "all",
        date: date || null,
        count: appointments.length,
        totalAppointments,
        appointments,
      });
    } catch (error) {
      console.error("Appointments list error:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);
// ======================total list appointments for admin with branch and client filter======================
router.get(
  "/admin/appointments",
  authMiddleware,
  allowRoles("admin", "client", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const { role, id: userId } = req.user;
      const adminId = role === "admin" ? req.user.id : req.user.adminId;

      let { date, branch, staffId } = req.query;
      branch = branch ? branch.trim().toLowerCase() : null;

      // ==========================
      // BASE WHERE CONDITIONS
      // ==========================
      let baseWhere = `a.admin_id = ?`;
      let baseParams = [adminId];

      if (role === "client") {
        baseWhere += " AND a.client_id = ?";
        baseParams.push(userId);
      }

      if (role === "doctor") {
        baseWhere += " AND a.staff_id = ?";
        baseParams.push(userId);
      }

      // ==========================
      // RECEPTIONIST BRANCH CONTROL
      // ==========================
      if (role === "receptionist") {
        const [[receptionist]] = await db.query(
          `SELECT branch
           FROM staff
           WHERE id = ? AND admin_id = ? AND role = 'receptionist' AND status = 1`,
          [userId, adminId]
        );

        if (!receptionist || !receptionist.branch) {
          return res.status(403).json({
            success: false,
            message: "Invalid receptionist branch",
          });
        }

        const recBranch = receptionist.branch.trim().toLowerCase();

        baseWhere += " AND LOWER(a.selected_branch) = ?";
        baseParams.push(recBranch);

        branch = recBranch;
      }

      // ==========================
      // ADMIN BRANCH FILTER
      // ==========================
      if (role === "admin" && branch) {
        baseWhere += " AND LOWER(a.selected_branch) = ?";
        baseParams.push(branch);
      }

      // ==========================
      // 🔥 STAFF FILTER (ADMIN + RECEPTIONIST)
      // ==========================
      if (
        staffId &&
        (role === "admin" || role === "receptionist")
      ) {
        baseWhere += " AND a.staff_id = ?";
        baseParams.push(staffId);
      }

      // ==========================
      // DATE FILTER
      // ==========================
      let listWhere = baseWhere;
      let listParams = [...baseParams];

      if (date) {
        listWhere += " AND DATE(a.appointment_date) = ?";
        listParams.push(date);
      }

      // ==========================
      // FETCH APPOINTMENTS
      // ==========================
      const [appointments] = await db.query(
        `SELECT
          a.id,
          a.purpose,
          DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS appointment_date,
          TIME_FORMAT(a.from_time, '%H:%i') AS from_time,
          TIME_FORMAT(a.to_time, '%H:%i') AS to_time,
          a.status,
          a.created_at,
          a.selected_branch,
          c.id AS client_id,
          c.name AS client_name,
          s.id AS doctor_id,
          s.name AS doctor_name
         FROM appointments a
         JOIN clients c ON c.id = a.client_id
         JOIN staff s ON s.id = a.staff_id
         WHERE ${listWhere}
         ORDER BY appointment_date DESC, from_time ASC`,
        listParams
      );

      // ==========================
      // TOTAL APPOINTMENTS
      // ==========================
      let totalAppointments = appointments.length;

      if (role === "admin") {
        const today = new Date().toISOString().split("T")[0];
        const [[totalResult]] = await db.query(
          `SELECT COUNT(*) AS totalAppointments
           FROM appointments a
           WHERE ${baseWhere}
             AND DATE(a.appointment_date) <= ?`,
          [...baseParams, today]
        );
        totalAppointments = totalResult.totalAppointments;
      }

      return res.status(200).json({
        success: true,
        role,
        branch: branch || "all",
        date: date || null,
        staffId: staffId || null,
        count: appointments.length,
        totalAppointments,
        appointments,
      });
    } catch (error) {
      console.error("Appointments list error:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);
// ======================total list appointments for admin with branch and client filter======================
router.get(
  "/admin/client/appointments",
  authMiddleware,
  allowRoles("admin", "client", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const { role, id: userId } = req.user;
      const adminId = role === "admin" ? req.user.id : req.user.adminId;

      let { date, branch, clientId } = req.query;
      branch = branch ? branch.trim().toLowerCase() : null;

      // ==========================
      // BASE WHERE CONDITIONS
      // ==========================
      let baseWhere = `a.admin_id = ?`;
      let baseParams = [adminId];

      // 🔒 Client can only see their own appointments
      if (role === "client") {
        baseWhere += " AND a.client_id = ?";
        baseParams.push(userId);
      }

      // 🔒 Doctor can only see their own appointments
      if (role === "doctor") {
        baseWhere += " AND a.staff_id = ?";
        baseParams.push(userId);
      }

      // ==========================
      // RECEPTIONIST BRANCH CONTROL
      // ==========================
      if (role === "receptionist") {
        const [[receptionist]] = await db.query(
          `SELECT branch
           FROM staff
           WHERE id = ? AND admin_id = ? AND role = 'receptionist' AND status = 1`,
          [userId, adminId]
        );

        if (!receptionist || !receptionist.branch) {
          return res.status(403).json({
            success: false,
            message: "Invalid receptionist branch",
          });
        }

        const recBranch = receptionist.branch.trim().toLowerCase();

        baseWhere += " AND LOWER(a.selected_branch) = ?";
        baseParams.push(recBranch);

        branch = recBranch;
      }

      // ==========================
      // ADMIN BRANCH FILTER
      // ==========================
      if (role === "admin" && branch) {
        baseWhere += " AND LOWER(a.selected_branch) = ?";
        baseParams.push(branch);
      }

      // ==========================
      // 🔥 CLIENT FILTER (ADMIN + RECEPTIONIST)
      // ==========================
      if (
        clientId &&
        (role === "admin" || role === "receptionist")
      ) {
        baseWhere += " AND a.client_id = ?";
        baseParams.push(clientId);
      }

      // ==========================
      // DATE FILTER
      // ==========================
      let listWhere = baseWhere;
      let listParams = [...baseParams];

      if (date) {
        listWhere += " AND DATE(a.appointment_date) = ?";
        listParams.push(date);
      }

      // ==========================
      // FETCH APPOINTMENTS
      // ==========================
      const [appointments] = await db.query(
        `SELECT
          a.id,
          a.purpose,
          DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS appointment_date,
          TIME_FORMAT(a.from_time, '%H:%i') AS from_time,
          TIME_FORMAT(a.to_time, '%H:%i') AS to_time,
          a.status,
          a.created_at,
          a.selected_branch,
          c.id AS client_id,
          c.name AS client_name,
          s.id AS doctor_id,
          s.name AS doctor_name
         FROM appointments a
         JOIN clients c ON c.id = a.client_id
         JOIN staff s ON s.id = a.staff_id
         WHERE ${listWhere}
         ORDER BY appointment_date DESC, from_time ASC`,
        listParams
      );

      // ==========================
      // TOTAL APPOINTMENTS
      // ==========================
      let totalAppointments = appointments.length;

      if (role === "admin") {
        const today = new Date().toISOString().split("T")[0];
        const [[totalResult]] = await db.query(
          `SELECT COUNT(*) AS totalAppointments
           FROM appointments a
           WHERE ${baseWhere}
             AND DATE(a.appointment_date) <= ?`,
          [...baseParams, today]
        );
        totalAppointments = totalResult.totalAppointments;
      }

      return res.status(200).json({
        success: true,
        role,
        branch: branch || "all",
        date: date || null,
        clientId: clientId || null,
        count: appointments.length,
        totalAppointments,
        appointments,
      });
    } catch (error) {
      console.error("Appointments list error:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// ===================== CANCEL APPOINTMENT =====================
router.put(
  "/client/appointment/cancel",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;
      const adminId = req.user.adminId;
      const { appointmentId } = req.body;

      if (!appointmentId)
        return res.status(400).json({ message: "Appointment ID is required" });

      // Fetch appointment
      const [rows] = await db.query(
        `SELECT id, admin_id, staff_id, appointment_date, from_time, to_time 
         FROM appointments 
         WHERE id=? AND client_id=?`,
        [appointmentId, clientId]
      );

      if (!rows.length)
        return res
          .status(400)
          .json({ message: "No appointment found to cancel" });

      const appointment = rows[0];

      // ❗ UPDATED: also set is_booked = 0
      await db.query(
        `UPDATE appointments 
         SET status='cancelled', is_booked = 0 
         WHERE id=?`,
        [appointmentId]
      );

      // ❗ NEW: free staff time slot
      await db.query(
        `UPDATE staff_time_slots
         SET is_booked = 0
         WHERE staff_id = ?
           AND slot_date = ?
           AND slot_time_from = ?
           AND slot_time_to = ?`,
        [
          appointment.staff_id,
          appointment.appointment_date,
          appointment.from_time,
          appointment.to_time,
        ]
      );

      // Notification
      const title = "Appointment Cancelled";
      const message = `Client cancelled appointment on ${appointment.appointment_date} | ${appointment.from_time}-${appointment.to_time}`;

      const [notifResult] = await db.query(
        `INSERT INTO notifications 
         (admin_id, sender_role, sender_id, title, message, type) 
         VALUES (?, 'client', ?, ?, ?, 'appointment')`,
        [adminId, clientId, title, message]
      );

      const notificationId = notifResult.insertId;

      // 🔽 ONLY CHANGE IS HERE 🔽
      const [receptionists] = await db.query(
        `SELECT id, role FROM staff 
         WHERE admin_id=? 
         AND role IN ('doctor','receptionist') 
         AND status=1`,
        [appointment.admin_id]
      );

      for (const r of receptionists) {
        await db.query(
          `INSERT INTO notification_receivers 
           (notification_id, receiver_role, receiver_id) 
           VALUES (?, ?, ?)`,
          [notificationId, r.role, r.id] // 👈 role added
        );

        global.io.to(r.id.toString()).emit("new-notification", {
          id: notificationId,
          title,
          message,
          type: "appointment",
          appointment_id: appointmentId,
        });
      }
      // 🔼 NOTHING ELSE CHANGED 🔼

      return res.json({
        success: true,
        message: "Appointment cancelled and notification sent",
      });
    } catch (error) {
      console.error("Client cancel appointment error:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  }
);

// ===================== UPDATE STATUS =====================


// router.put(
//   "/appointment/:id/status",
//   authMiddleware,
//   allowRoles("receptionist", "doctor"),
//   async (req, res) => {
//     try {
//       const { id } = req.params;
//       const { status } = req.body;

//       const { role, id: userId, adminId } = req.user;

//       const allowedStatuses = ["assigned", "cancelled", "completed"];

//       if (!allowedStatuses.includes(status)) {
//         return res
//           .status(400)
//           .json({ success: false, message: "Invalid status" });
//       }

//       /* ===============================
//          📌 FETCH APPOINTMENT + DOCTOR
//       =============================== */
//       const [[appointment]] = await db.execute(
//         `SELECT a.id, a.client_id, a.staff_id,
//                 s.branch AS doctor_branch
//          FROM appointments a
//          JOIN staff s ON s.id = a.staff_id
//          WHERE a.id = ? AND a.admin_id = ?`,
//         [id, adminId]
//       );

//       if (!appointment) {
//         return res
//           .status(404)
//           .json({ success: false, message: "Appointment not found" });
//       }

//       /* ===============================
//          👨‍⚕️ DOCTOR → OWN APPOINTMENTS
//       =============================== */
//       if (role === "doctor" && appointment.staff_id !== userId) {
//         return res.status(403).json({
//           success: false,
//           message: "You can update only your own appointments",
//         });
//       }

//       /* ===============================
//          🧑‍💼 RECEPTIONIST → SAME BRANCH
//       =============================== */
//       if (role === "receptionist") {
//         const [[receptionist]] = await db.execute(
//           `SELECT branch FROM staff
//            WHERE id = ? AND admin_id = ? AND role = 'receptionist' AND status = 1`,
//           [userId, adminId]
//         );
//         const [receptionistsForContact] = await db.execute(
//           `SELECT mobile
//    FROM staff
//    WHERE role = 'receptionist'
//      AND branch = ?
//      AND admin_id = ?
//      AND status = 1
//    LIMIT 1`,
//           [appointment.doctor_branch, adminId]
//         );

//         if (!receptionist) {
//           return res
//             .status(403)
//             .json({ success: false, message: "Invalid receptionist" });
//         }

//         const receptionistBranch = receptionist.branch?.trim().toLowerCase();
//         const doctorBranch = appointment.doctor_branch?.trim().toLowerCase();

//         if (!receptionistBranch || receptionistBranch !== doctorBranch) {
//           return res.status(403).json({
//             success: false,
//             message: "You can update appointments only for your branch doctors",
//           });
//         }
//       }

//       const receptionistPhone =
//         receptionistsForContact.length > 0
//           ? receptionistsForContact[0].mobile
//           : "";

//       /* ===============================
//          🔄 UPDATE STATUS
//       =============================== */
//       await db.execute(`UPDATE appointments SET status = ? WHERE id = ?`, [
//         status,
//         id,
//       ]);

//       /* ===============================
//          🔔 NOTIFICATION (DB)
//       =============================== */
//       const title = "Appointment Status Updated";
//       const message = `Your appointment status has been updated to "${status}".`;

//       const [notif] = await db.execute(
//         `INSERT INTO notifications
//          (admin_id,sender_role, sender_id, title, message, type)
//          VALUES (?,?, ?, ?, ?, 'appointment')`,
//         [adminId, role, userId, title, message]
//       );

//       const notificationId = notif.insertId;

//       await db.execute(
//         `INSERT INTO notification_receivers
//          (notification_id, receiver_role, receiver_id)
//          VALUES (?, 'client', ?)`,
//         [notificationId, appointment.client_id]
//       );

//       /* ===============================
//          📡 SOCKET NOTIFICATION
//       =============================== */
//       global.io.to(appointment.client_id.toString()).emit("new-notification", {
//         id: notificationId,
//         title,
//         message,
//         appointment_id: id,
//         type: "appointment",
//       });
//       await db.execute(`UPDATE appointments SET status = ? WHERE id = ?`, [
//         status,
//         id,
//       ]);

//       /* ===============================
//          ✉️ EMAIL TO CLIENT
//       =============================== */
//       // ===============================
//       const [[client]] = await db.execute(
//         `SELECT c.name AS client_name, c.email,
//           s.name AS doctor_name, s.branch AS doctor_branch,
//           a.appointment_date, a.from_time, a.to_time
//    FROM appointments a
//    JOIN clients c ON c.id = a.client_id
//    JOIN staff s ON s.id = a.staff_id
//    WHERE a.id = ?`,
//         [id]
//       );

//       // ✅ DEFINE statusColor FIRST
//       const statusColor =
//         status?.toLowerCase() === "assigned"
//           ? "#2563eb"
//           : status?.toLowerCase() === "completed"
//           ? "#16a34a"
//           : status?.toLowerCase() === "cancelled"
//           ? "#dc2626"
//           : "#6b7280";

//       // SEND EMAIL WITH THE UPDATED STATUS
//       if (client?.email) {
//         await sendAppointmentStatusEmail(client.email, {
//           clientName: client.client_name,
//           doctorName: client.doctor_name,
//           branchName: client.doctor_branch,
//           date: client.appointment_date,
//           fromTime: client.from_time,
//           receptionistPhone,
//           toTime: client.to_time,
//           status,
//           statusColor, // ✅ PASS IT EXPLICITLY
//         });
//       }

//       return res.status(200).json({
//         success: true,
//         message: "Appointment status updated, notification & email sent",
//         appointmentId: id,
//         status,
//       });
//     } catch (error) {
//       console.error("Update appointment status error:", error);
//       return res.status(500).json({ success: false, message: "Server error" });
//     }
//   }
// );

router.put(
  "/appointment/:id/status",
  authMiddleware,
  allowRoles("receptionist", "doctor"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const { role, id: userId, adminId } = req.user;

      const allowedStatuses = ["assigned", "cancelled", "completed"];
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status",
        });
      }

      /* ===============================
         📌 FETCH APPOINTMENT + CURRENT STATUS
      =============================== */
      const [[appointment]] = await db.execute(
        `SELECT a.id, a.client_id, a.staff_id, a.status,
                a.appointment_date, a.from_time, a.to_time,
                s.branch AS doctor_branch
         FROM appointments a
         JOIN staff s ON s.id = a.staff_id
         WHERE a.id = ? AND a.admin_id = ?`,
        [id, adminId]
      );

      if (!appointment) {
        return res.status(404).json({
          success: false,
          message: "Appointment not found",
        });
      }

      /* ===============================
         ❌ CANCEL ONLY IF CURRENT STATUS = ASSIGNED
      =============================== */
      if (status === "cancelled" && appointment.status !== "assigned") {
        return res.status(400).json({
          success: false,
          message: `Appointment cannot be cancelled because it is already "${appointment.status}"`,
        });
      }

      /* ===============================
         👨‍⚕️ DOCTOR → OWN APPOINTMENTS ONLY
      =============================== */
      if (role === "doctor" && appointment.staff_id !== userId) {
        return res.status(403).json({
          success: false,
          message: "You can update only your own appointments",
        });
      }

      /* ===============================
         🧑‍💼 RECEPTIONIST → SAME BRANCH ONLY
      =============================== */
      if (role === "receptionist") {
        const [[receptionist]] = await db.execute(
          `SELECT branch
           FROM staff
           WHERE id = ?
             AND admin_id = ?
             AND role = 'receptionist'
             AND status = 1`,
          [userId, adminId]
        );

        if (!receptionist) {
          return res.status(403).json({
            success: false,
            message: "Invalid receptionist",
          });
        }

        const receptionistBranch = receptionist.branch?.trim().toLowerCase();
        const doctorBranch = appointment.doctor_branch?.trim().toLowerCase();

        if (!receptionistBranch || receptionistBranch !== doctorBranch) {
          return res.status(403).json({
            success: false,
            message:
              "You can update appointments only for your branch doctors",
          });
        }
      }

      /* ===============================
         🔄 UPDATE STATUS
      =============================== */
      await db.execute(
        `UPDATE appointments SET status = ? WHERE id = ?`,
        [status, id]
      );

      /* ===============================
         🔓 FREE SLOT + UPDATE is_booked IF CANCELLED
      =============================== */
      if (status === "cancelled") {
        // ✅ FREE TIME SLOT
        await db.execute(
          `UPDATE staff_time_slots
           SET is_booked = 0
           WHERE staff_id = ?
             AND slot_date = ?
             AND slot_time_from = ?
             AND slot_time_to = ?`,
          [
            appointment.staff_id,
            appointment.appointment_date,
            appointment.from_time,
            appointment.to_time,
          ]
        );

        // ✅ ALSO UPDATE appointments.is_booked
        await db.execute(
          `UPDATE appointments
           SET is_booked = 0
           WHERE id = ?`,
          [id]
        );
      }

      /* ===============================
         📞 FETCH RECEPTIONIST PHONE
      =============================== */
      const [receptionistsForContact] = await db.execute(
        `SELECT mobile
         FROM staff
         WHERE role = 'receptionist'
           AND branch = ?
           AND admin_id = ?
           AND status = 1
         LIMIT 1`,
        [appointment.doctor_branch, adminId]
      );

      const receptionistPhone =
        receptionistsForContact.length > 0
          ? receptionistsForContact[0].mobile
          : "";

      /* ===============================
         🔔 NOTIFICATION (DB)
      =============================== */
      const title = "Appointment Status Updated";
      const message = `Your appointment status has been updated to "${status}".`;

      const [notif] = await db.execute(
        `INSERT INTO notifications
         (admin_id, sender_role, sender_id, title, message, type)
         VALUES (?, ?, ?, ?, ?, 'appointment')`,
        [adminId, role, userId, title, message]
      );

      const notificationId = notif.insertId;

      await db.execute(
        `INSERT INTO notification_receivers
         (notification_id, receiver_role, receiver_id)
         VALUES (?, 'client', ?)`,
        [notificationId, appointment.client_id]
      );

      /* ===============================
         📡 SOCKET NOTIFICATION
      =============================== */
      global.io
        .to(appointment.client_id.toString())
        .emit("new-notification", {
          id: notificationId,
          title,
          message,
          appointment_id: id,
          type: "appointment",
        });

      /* ===============================
         ✉️ EMAIL TO CLIENT
      =============================== */
      const [[client]] = await db.execute(
        `SELECT c.name AS client_name, c.email,
                s.name AS doctor_name, s.branch AS doctor_branch,
                a.appointment_date, a.from_time, a.to_time
         FROM appointments a
         JOIN clients c ON c.id = a.client_id
         JOIN staff s ON s.id = a.staff_id
         WHERE a.id = ?`,
        [id]
      );

      const statusColor =
        status === "assigned"
          ? "#2563eb"
          : status === "completed"
          ? "#16a34a"
          : status === "cancelled"
          ? "#dc2626"
          : "#6b7280";

      if (client?.email) {
        await sendAppointmentStatusEmail(client.email, {
          clientName: client.client_name,
          doctorName: client.doctor_name,
          branchName: client.doctor_branch,
          date: client.appointment_date,
          fromTime: client.from_time,
          toTime: client.to_time,
          receptionistPhone,
          status,
          statusColor,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Appointment status updated successfully",
        appointmentId: id,
        status,
      });
    } catch (error) {
      console.error("Update appointment status error:", error);
      return res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);


// ===================== DELETE APPOINTMENT =====================
router.delete(
  "/appointment/:id",
  authMiddleware,
  allowRoles("receptionist", "doctor"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { role, id: userId, adminId } = req.user;

      // ===============================
      // FETCH APPOINTMENT + DOCTOR INFO
      // ===============================
      const [[appointment]] = await db.execute(
        `SELECT a.id, a.staff_id, a.status, s.branch AS doctor_branch
         FROM appointments a
         JOIN staff s ON s.id = a.staff_id
         WHERE a.id = ? AND a.admin_id = ?`,
        [id, adminId]
      );

      if (!appointment) {
        return res
          .status(404)
          .json({ success: false, message: "Appointment not found" });
      }

      // ===============================
      // DOCTOR → can delete only own appointments
      // ===============================
      if (role === "doctor" && appointment.staff_id !== userId) {
        return res.status(403).json({
          success: false,
          message: "You can delete only your own appointments",
        });
      }

      // ===============================
      // RECEPTIONIST → can delete only appointments under doctors in their branch
      // ===============================
      if (role === "receptionist") {
        const [[receptionist]] = await db.execute(
          `SELECT branch FROM staff
           WHERE id = ? AND admin_id = ? AND role = 'receptionist' AND status = 1`,
          [userId, adminId]
        );

        if (!receptionist) {
          return res
            .status(403)
            .json({ success: false, message: "Invalid receptionist" });
        }

        const receptionistBranch = receptionist.branch?.trim().toLowerCase();
        const doctorBranch = appointment.doctor_branch?.trim().toLowerCase();

        if (!receptionistBranch || receptionistBranch !== doctorBranch) {
          return res.status(403).json({
            success: false,
            message: "You can delete appointments only for your branch doctors",
          });
        }
      }

      // ===============================
      // ALLOW ONLY ASSIGNED OR CANCELLED APPOINTMENTS
      // ===============================
      const allowedStatuses = ["assigned", "cancelled"];
      if (!allowedStatuses.includes(appointment.status)) {
        return res.status(400).json({
          success: false,
          message: `Only ${allowedStatuses.join(
            " or "
          )} appointments can be deleted`,
        });
      }

      // ===============================
      // DELETE APPOINTMENT
      // ===============================
      await db.execute(`DELETE FROM appointments WHERE id = ?`, [id]);

      return res.status(200).json({
        success: true,
        message: "Appointment deleted successfully",
        appointmentId: id,
      });
    } catch (error) {
      console.error("Delete appointment error:", error);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

//Route: /appointments/monthly-visitors
router.get(
  "/appointments/monthly-visitors",
  authMiddleware,
  allowRoles("doctor"),
  async (req, res) => {
    try {
      const { id: doctorId, adminId } = req.user;

      const year = new Date().getFullYear();
      const month = new Date().getMonth() + 1; // current month

      const [rows] = await db.query(
        `
        SELECT 
          DAY(appointment_date) AS day,
          COUNT(*) AS count
        FROM appointments
        WHERE admin_id = ?
          AND staff_id = ?
          AND status = 'completed'
          AND YEAR(appointment_date) = ?
          AND MONTH(appointment_date) = ?
        GROUP BY DAY(appointment_date)
        ORDER BY day ASC
        `,
        [adminId, doctorId, year, month]
      );

      res.status(200).json({
        success: true,
        month,
        year,
        data: rows, // [{ day: 1, count: 3 }, ...]
      });
    } catch (error) {
      console.error("Monthly visitors error:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

//Route: /appointments/monthly-visitors
router.get(
  "/appointments/monthly-visitors",
  authMiddleware,
  allowRoles("doctor"),
  async (req, res) => {
    try {
      const { id: doctorId, adminId } = req.user;

      const year = new Date().getFullYear();
      const month = new Date().getMonth() + 1; // current month

      const [rows] = await db.query(
        `
        SELECT 
          DAY(appointment_date) AS day,
          COUNT(*) AS count
        FROM appointments
        WHERE admin_id = ?
          AND staff_id = ?
          AND status = 'completed'
          AND YEAR(appointment_date) = ?
          AND MONTH(appointment_date) = ?
        GROUP BY DAY(appointment_date)
        ORDER BY day ASC
        `,
        [adminId, doctorId, year, month]
      );

      res.status(200).json({
        success: true,
        month,
        year,
        data: rows, // [{ day: 1, count: 3 }, ...]
      });
    } catch (error) {
      console.error("Monthly visitors error:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// ===================== GET LIST APPOINTMENTS TO BY ID TO CLIENT OR ALL BY  =====================
router.get(
  "/appointments/:id",
  authMiddleware,
  allowRoles("admin", "client", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const appointmentId = req.params.id;
      const { role, id: userId } = req.user;
      const adminId = role === "admin" ? userId : req.user.adminId;

      // ==========================
      // BASE WHERE CONDITIONS
      // ==========================
      let where = `a.id = ? AND a.admin_id = ?`;
      let params = [appointmentId, adminId];

      // ==========================
      // ROLE BASED ACCESS
      // ==========================
      if (role === "client") {
        where += " AND a.client_id = ?";
        params.push(userId);
      }

      if (role === "doctor") {
        where += " AND a.staff_id = ?";
        params.push(userId);
      }

      if (role === "receptionist") {
        const [[receptionist]] = await db.query(
          `SELECT branch
           FROM staff
           WHERE id = ? AND admin_id = ? AND role = 'receptionist' AND status = 1`,
          [userId, adminId]
        );

        if (!receptionist || !receptionist.branch) {
          return res.status(403).json({
            success: false,
            message: "Invalid receptionist branch",
          });
        }

        where += " AND LOWER(s.branch) = ?";
        params.push(receptionist.branch.trim().toLowerCase());
      }

      // ==========================
      // FETCH APPOINTMENT
      // ==========================
      const [[appointment]] = await db.query(
        `SELECT
          a.id,
          a.purpose,
          a.selected_branch,
          DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS appointment_date,
          TIME_FORMAT(a.from_time, '%H:%i') AS from_time,
          TIME_FORMAT(a.to_time, '%H:%i') AS to_time,
          a.status,
          a.created_at,

          c.id AS client_id,
          c.name AS client_name,
          c.mobile AS client_mobile,

          s.id AS doctor_id,
          s.name AS doctor_name,
          s.branch
         FROM appointments a
         JOIN clients c ON c.id = a.client_id
         JOIN staff s ON s.id = a.staff_id
         WHERE ${where}
         LIMIT 1`,
        params
      );

      if (!appointment) {
        return res.status(404).json({
          success: false,
          message: "Appointment not found or access denied",
        });
      }

      return res.status(200).json({
        success: true,
        appointment,
      });
    } catch (error) {
      console.error("Get appointment by id error:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

//add this route before appointment/:id 

router.get(
  "/appointments/count",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const role = req.user.role;
      const adminId =
        role === "admin" ? req.user.id : req.user.adminId;

      let totalAppointments = 0;
      let branch = "ALL";

      // ==========================
      // ADMIN → ALL appointments
      // ==========================
      if (role === "admin") {
        const [[result]] = await db.execute(
          `
          SELECT COUNT(*) AS total
          FROM appointments
          WHERE admin_id = ?
          `,
          [adminId]
        );

        totalAppointments = result.total;
      }

      // ==========================
      // RECEPTIONIST → SAME BRANCH
      // ==========================
      if (role === "receptionist") {
        // 1️⃣ Get receptionist branch
        const [[receptionist]] = await db.execute(
          `
          SELECT branch
          FROM staff
          WHERE id = ? AND admin_id = ?
          `,
          [req.user.id, adminId]
        );

        if (!receptionist || !receptionist.branch) {
          return res.status(404).json({
            success: false,
            message: "Receptionist branch not found",
          });
        }

        branch = receptionist.branch;

        // 2️⃣ Count appointments under that branch
        const [[result]] = await db.execute(
          `
          SELECT COUNT(*) AS total
          FROM appointments a
          JOIN staff s ON a.staff_id = s.id
          WHERE a.admin_id = ?
            AND s.branch = ?
          `,
          [adminId, branch]
        );

        totalAppointments = result.total;
      }

      res.json({
        success: true,
        role,
        branch,
        totalAppointments,
      });
    } catch (error) {
      console.error("Appointments count error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch appointments count",
      });
    }
  }
);

router.get(
  "/role-based",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const role = req.user.role;
      const adminId =
        role === "admin" ? req.user.id : req.user.adminId;

      const today = new Date().toISOString().split("T")[0];

      let branch = "ALL";
      let appointments = [];

      // ==========================
      // ADMIN → TODAY
      // ==========================
      if (role === "admin") {
        const [rows] = await db.execute(
          `
          SELECT 
            a.id,
            a.appointment_date,
            a.from_time,
            a.to_time,
            a.status,
            a.purpose,
            c.name AS client_name,
            s.name AS staff_name,
            s.branch
          FROM appointments a
          LEFT JOIN clients c ON c.id = a.client_id
          LEFT JOIN staff s ON s.id = a.staff_id
          WHERE a.admin_id = ?
            AND a.appointment_date = CURDATE()
          ORDER BY a.from_time ASC
          `,
          [adminId]
        );

        appointments = rows;
      }

      // ==========================
      // RECEPTIONIST → TODAY + BRANCH
      // ==========================
      if (role === "receptionist") {
        const [[receptionist]] = await db.execute(
          `
          SELECT branch
          FROM staff
          WHERE id = ? AND admin_id = ?
          `,
          [req.user.id, adminId]
        );

        if (!receptionist?.branch) {
          return res.status(404).json({
            success: false,
            message: "Receptionist branch not found",
          });
        }

        branch = receptionist.branch;

        const [rows] = await db.execute(
          `
          SELECT 
            a.id,
            a.appointment_date,
            a.from_time,
            a.to_time,
            a.status,
            a.purpose,
            c.name AS client_name,
            s.name AS staff_name,
            s.branch
          FROM appointments a
          JOIN staff s ON s.id = a.staff_id
          LEFT JOIN clients c ON c.id = a.client_id
          WHERE a.admin_id = ?
            AND s.branch = ?
            AND a.appointment_date = CURDATE()
          ORDER BY a.from_time ASC
          `,
          [adminId, branch]
        );

        appointments = rows;
      }

      res.json({
        success: true,
        role,
        branch,
        date: today,
        totalAppointments: appointments.length,
        appointments,
      });
    } catch (error) {
      console.error("Today appointments error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch today's appointments",
      });
    }
  }
);

module.exports = router;
