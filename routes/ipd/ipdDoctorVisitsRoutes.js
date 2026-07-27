const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");
const { regenerateBill } = require("./ipdBillsRoutes");

const normalize = (value) => value?.toString().trim().toLowerCase();

// ==============================
// ✅ CREATE VISIT ✅
// ==============================
router.post(
  "/post/doctor-visit/",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    try {
      let { ipd_id, doctor_id, visit_date, visit_notes, visit_charge } =
        req.body;
      const { role, id, adminId } = req.user;

      const admin_id = adminId;

      // ==============================
      // ✅ BASIC VALIDATION
      // ==============================
      if (!ipd_id || !visit_date) {
        return res.status(400).json({
          message: "ipd_id and visit_date are required",
        });
      }

      // ==============================
      // ✅ VERIFY USER BELONGS TO ADMIN
      // ==============================
      const [user] = await db.query(
        `SELECT id, branch FROM staff WHERE id = ? AND admin_id = ?`,
        [id, admin_id],
      );

      if (user.length === 0) {
        return res.status(403).json({
          message: "User does not belong to this admin",
        });
      }

      const userBranch = user[0].branch;

      // ==============================
      // ✅ VERIFY IPD BELONGS TO ADMIN
      // ==============================
      const [ipd] = await db.query(
        `SELECT id, branch_name FROM ipd_admissions 
         WHERE id = ? AND admin_id = ?`,
        [ipd_id, admin_id],
      );

      if (ipd.length === 0) {
        return res.status(404).json({
          message: "Invalid IPD or access denied",
        });
      }

      // ==============================
      // ✅ BRANCH CHECK
      // ==============================
      if (
        ipd[0].branch_name?.toLowerCase().trim() !==
        userBranch?.toLowerCase().trim()
      ) {
        return res.status(403).json({
          message: "IPD belongs to another branch",
        });
      }

      let finalDoctorId;

      // ==============================
      // 👨‍⚕️ DOCTOR FLOW
      // ==============================
      if (role === "doctor") {
        finalDoctorId = id;

        // Optional strict check
        if (doctor_id && doctor_id !== id) {
          return res.status(403).json({
            message: "You cannot assign another doctor",
          });
        }
      }

      // ==============================
      // 🧑‍💼 RECEPTIONIST FLOW
      // ==============================
      if (role === "receptionist") {
        if (!doctor_id) {
          return res.status(400).json({
            message: "doctor_id is required",
          });
        }

        const [doctor] = await db.query(
          `SELECT id, branch FROM staff 
           WHERE id = ? 
           AND admin_id = ? 
           AND role = 'doctor'`,
          [doctor_id, admin_id],
        );

        if (doctor.length === 0) {
          return res.status(404).json({
            message: "Doctor not found in your admin",
          });
        }

        if (normalize(doctor[0].branch) !== normalize(userBranch)) {
          return res.status(403).json({
            message: "Doctor belongs to another branch",
          });
        }

        finalDoctorId = doctor_id;
      }

      // ==============================
      // ✅ INSERT VISIT
      // ==============================
      const [result] = await db.query(
        `INSERT INTO ipd_doctor_visits 
        (admin_id, ipd_id, doctor_id, visit_date, visit_notes, visit_charge)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          admin_id,
          ipd_id,
          finalDoctorId,
          visit_date,
          visit_notes || null,
          visit_charge ? Number(visit_charge) : 0,
        ],
      );

      await regenerateBill(ipd_id);

      return res.status(201).json({
        message: "Doctor visit created successfully",
        visitId: result.insertId,
      });
    } catch (error) {
      console.error("CREATE VISIT ERROR:", error);

      if (error.code === "ER_BAD_NULL_ERROR") {
        return res.status(400).json({
          message: "Missing required fields",
        });
      }

      if (error.code === "ER_TRUNCATED_WRONG_VALUE") {
        return res.status(400).json({
          message: "Invalid data format",
        });
      }

      return res.status(500).json({
        message: "Internal server error",
      });
    }
  },
);

// ==============================
// ✅ GET ALL VISITS ✅
// ==============================
router.get(
  "/getall/doctor-visits/",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;

      const admin_id = role === "admin" ? id : adminId;

      // ==============================
      // ✅ GET USER BRANCH (for receptionist/doctor)
      // ==============================
      let userBranch = null;

      if (role !== "admin") {
        const [user] = await db.query(
          `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
          [id, admin_id],
        );

        if (user.length === 0) {
          return res.status(403).json({ message: "User not found" });
        }

        userBranch = user[0].branch;
      }

      // ==============================
      // ✅ BASE QUERY
      // ==============================
      let query = `
        SELECT 
          v.*, 
          s.name AS doctor_name,
          s.branch AS doctor_branch
        FROM ipd_doctor_visits v
        INNER JOIN staff s 
          ON v.doctor_id = s.id 
          AND s.admin_id = v.admin_id
        WHERE v.admin_id = ?
      `;

      let params = [admin_id];

      // ==============================
      // 👨‍⚕️ DOCTOR → only his visits
      // ==============================
      if (role === "doctor") {
        query += ` AND v.doctor_id = ?`;
        params.push(id);
      }

      // ==============================
      // 🧑‍💼 RECEPTIONIST → branch filter
      // ==============================
      if (role === "receptionist") {
        query += ` AND s.branch = ?`;
        params.push(userBranch);
      }

      // ==============================
      // 👤 CLIENT → only their visits
      // (assumes v.patient_id exists)
      // ==============================
      if (role === "client") {
        query += ` AND v.patient_id = ?`;
        params.push(id);
      }

      // ==============================
      // ✅ ORDER
      // ==============================
      query += ` ORDER BY v.visit_date DESC`;

      const [rows] = await db.query(query, params);

      return res.json(rows);
    } catch (error) {
      console.error("GET VISITS ERROR:", error);
      return res.status(500).json({
        message: "Internal server error",
      });
    }
  },
);

// ==============================
// ✅ GET VISITS BY ID ✅
// ==============================
router.get(
  "/get/doctor-visit/:id",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    try {
      const { id: visitId } = req.params;
      const { role, id, adminId } = req.user;

      const admin_id = role === "admin" ? id : adminId;

      // ==============================
      // ✅ GET USER BRANCH (if not admin)
      // ==============================
      let userBranch = null;

      if (role !== "admin") {
        const [user] = await db.query(
          `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
          [id, admin_id],
        );

        if (user.length === 0) {
          return res.status(403).json({ message: "User not found" });
        }

        userBranch = user[0].branch;
      }

      // ==============================
      // ✅ GET VISIT + DOCTOR INFO
      // ==============================
      const [rows] = await db.query(
        `SELECT 
          v.*, 
          s.name AS doctor_name,
          s.branch AS doctor_branch
         FROM ipd_doctor_visits v
         INNER JOIN staff s 
           ON v.doctor_id = s.id 
           AND s.admin_id = v.admin_id
         WHERE v.id = ? AND v.admin_id = ?`,
        [visitId, admin_id],
      );

      if (rows.length === 0) {
        return res.status(404).json({
          message: "Visit not found",
        });
      }

      const visit = rows[0];

      // ==============================
      // 👨‍⚕️ DOCTOR CHECK
      // ==============================
      if (role === "doctor" && visit.doctor_id !== id) {
        return res.status(403).json({
          message: "You can only view your own visits",
        });
      }

      // ==============================
      // 🧑‍💼 RECEPTIONIST CHECK (branch)
      // ==============================
      if (
        role === "receptionist" &&
        normalize(visit.doctor_branch) !== normalize(userBranch)
      ) {
        return res.status(403).json({
          message: "You can only view visits from your branch",
        });
      }

      // ==============================
      // 👤 CLIENT CHECK (only own visits)
      // ==============================
      if (role === "client" && visit.patient_id !== id) {
        return res.status(403).json({
          message: "You can only view your own visit",
        });
      }

      return res.json(visit);
    } catch (error) {
      console.error("GET VISIT BY ID ERROR:", error);

      return res.status(500).json({
        message: "Internal server error",
      });
    }
  },
);

// ==============================
// ✅ GET VISITS BY IPD ID ✅
// ==============================
router.get(
  "/get/doctor-visits/byipd/:ipd_id",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    try {
      const { ipd_id } = req.params;
      const { role, id, adminId } = req.user;

      const admin_id = role === "admin" ? id : adminId;

      let userBranch = null;

      // 👨‍⚕️ staff roles only
      if (role === "doctor" || role === "receptionist") {
        const [user] = await db.query(
          `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
          [id, admin_id],
        );

        if (user.length === 0) {
          return res.status(403).json({ message: "User not found" });
        }

        userBranch = user[0].branch;
      }

      if (role === "client") {
        const [client] = await db.query(
          `SELECT id FROM clients WHERE id = ?`,
          [id],
        );

        if (client.length === 0) {
          return res.status(403).json({ message: "Client not found" });
        }
      }

      // ==============================
      // ✅ CHECK IPD (admin + branch + client)
      // ==============================
      let ipd;

      if (role === "client") {
        [ipd] = await db.query(
          `SELECT
        id,
        branch_name,
        client_id,
        admin_id
     FROM ipd_admissions
     WHERE id = ?
       AND client_id = ?`,
          [ipd_id, id]
        );
      } else {
        [ipd] = await db.query(
          `SELECT
        id,
        branch_name,
        client_id,
        admin_id
     FROM ipd_admissions
     WHERE id = ?
       AND admin_id = ?`,
          [ipd_id, admin_id]
        );
      }

      if (ipd.length === 0) {
        return res.status(404).json({
          message: "Invalid IPD or access denied",
        });
      }

      if (ipd.length === 0) {
        return res.status(404).json({
          message: "Invalid IPD or access denied",
        });
      }

      // 🧑‍💼 Branch restriction (non-admin)
      if (
        role !== "admin" &&
        role !== "client" &&
        normalize(ipd[0].branch_name) !== normalize(userBranch)
      ) {
        return res.status(403).json({
          message: "IPD belongs to another branch",
        });
      }

      // 👤 CLIENT restriction (only own IPD)
      if (role === "client" && ipd[0].client_id !== id) {
        return res.status(403).json({
          message: "You can only access your own IPD records",
        });
      }

      // ==============================
      // ✅ BASE QUERY
      // ==============================
      let query = `
  SELECT
    v.*,
    s.name AS doctor_name,
    s.branch AS doctor_branch
  FROM ipd_doctor_visits v
  INNER JOIN staff s
    ON v.doctor_id = s.id
    AND s.admin_id = v.admin_id
  WHERE v.ipd_id = ?
`;

      let params = [ipd_id];

      if (role !== "client") {
        query += ` AND v.admin_id = ?`;
        params.push(admin_id);
      }

      // ==============================
      // 👨‍⚕️ DOCTOR → only his visits
      // ==============================
      if (role === "doctor") {
        query += ` AND v.doctor_id = ?`;
        params.push(id);
      }

      // ==============================
      // 🧑‍💼 RECEPTIONIST → same branch doctors
      // ==============================
      if (role === "receptionist") {
        query += ` AND s.branch = ?`;
        params.push(userBranch);
      }

      query += ` ORDER BY v.visit_date DESC`;

      const [rows] = await db.query(query, params);

      return res.json(rows);
    } catch (error) {
      console.error("GET IPD VISITS ERROR:", error);

      return res.status(500).json({
        message: "Internal server error",
      });
    }
  },
);

// ==============================
// ✅ UPDATE VISIT ✅
// ==============================
router.put(
  "/update/doctor-visit/:id",
  authMiddleware,
  allowRoles("admin", "receptionist"), // add "doctor" if needed
  async (req, res) => {
    try {
      const { id: visitId } = req.params;
      const { visit_date, visit_notes, visit_charge } = req.body;
      const { role, id, adminId } = req.user;

      const admin_id = role === "admin" ? id : adminId;

      // ==============================
      // ✅ GET USER BRANCH (for receptionist)
      // ==============================
      let userBranch = null;

      if (role !== "admin") {
        const [user] = await db.query(
          `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
          [id, admin_id],
        );

        if (user.length === 0) {
          return res.status(403).json({ message: "User not found" });
        }

        userBranch = user[0].branch;
      }

      // ==============================
      // ✅ GET VISIT + DOCTOR INFO
      // ==============================
      const [rows] = await db.query(
        `SELECT v.*, s.branch AS doctor_branch
         FROM ipd_doctor_visits v
         INNER JOIN staff s 
           ON v.doctor_id = s.id 
           AND s.admin_id = v.admin_id
         WHERE v.id = ? AND v.admin_id = ?`,
        [visitId, admin_id],
      );

      if (rows.length === 0) {
        return res.status(404).json({ message: "Visit not found" });
      }

      const visit = rows[0];

      // ==============================
      // 🧑‍💼 RECEPTIONIST CHECK
      // ==============================
      if (
        role === "receptionist" &&
        normalize(visit.doctor_branch) !== normalize(userBranch)
      ) {
        return res.status(403).json({
          message: "You can only update visits from your branch",
        });
      }

      // ==============================
      // 👨‍⚕️ DOCTOR CHECK (if you allow doctor)
      // ==============================
      // if (role === "doctor" && visit.doctor_id !== id) {
      //   return res.status(403).json({
      //     message: "You can only update your own visits",
      //   });
      // }

      // ==============================
      // ✅ UPDATE
      // ==============================
      const [result] = await db.query(
        `UPDATE ipd_doctor_visits 
         SET visit_date = ?, visit_notes = ?, visit_charge = ?
         WHERE id = ? AND admin_id = ?`,
        [
          visit_date,
          visit_notes,
          visit_charge ? Number(visit_charge) : 0,
          visitId,
          admin_id,
        ],
      );

      await regenerateBill(visit.ipd_id);

      return res.json({ message: "Visit updated successfully" });
    } catch (error) {
      console.error("UPDATE VISIT ERROR:", error);

      if (error.code === "ER_TRUNCATED_WRONG_VALUE") {
        return res.status(400).json({
          message: "Invalid date or number format",
        });
      }

      return res.status(500).json({
        message: "Internal server error",
      });
    }
  },
);

// ==============================
// ✅ DELETE VISIT ✅
// ==============================
router.delete(
  "/delete/doctor-visit/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const { id: visitId } = req.params;
      const { id, adminId } = req.user;

      const admin_id = adminId;

      // ==============================
      // ✅ GET RECEPTIONIST BRANCH
      // ==============================
      const [user] = await db.query(
        `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
        [id, admin_id],
      );

      if (user.length === 0) {
        return res.status(403).json({
          message: "User not found",
        });
      }

      const userBranch = user[0].branch;

      // ==============================
      // ✅ GET VISIT + DOCTOR INFO
      // ==============================
      const [rows] = await db.query(
        `SELECT v.id, s.branch, s.role AS doctor_role
         FROM ipd_doctor_visits v
         INNER JOIN staff s 
           ON v.doctor_id = s.id 
           AND s.admin_id = v.admin_id
         WHERE v.id = ? AND v.admin_id = ?`,
        [visitId, admin_id],
      );

      if (rows.length === 0) {
        return res.status(404).json({
          message: "Visit not found",
        });
      }

      const visit = rows[0];

      // ==============================
      // 🔒 STRICT VALIDATIONS
      // ==============================
      if (visit.doctor_role !== "doctor") {
        return res.status(403).json({
          message: "Only doctor visits can be deleted",
        });
      }

      if (normalize(visit.branch) !== normalize(userBranch)) {
        return res.status(403).json({
          message: "You can only delete visits from your branch",
        });
      }

      // ==============================
      // ✅ DELETE
      // ==============================
      await db.query(
        `DELETE FROM ipd_doctor_visits 
         WHERE id = ? AND admin_id = ?`,
        [visitId, admin_id],
      );

      return res.json({
        message: "Visit deleted successfully",
      });
    } catch (error) {
      console.error("DELETE VISIT ERROR:", error);

      return res.status(500).json({
        message: "Internal server error",
      });
    }
  },
);

module.exports = router;