const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");
const { regenerateBill } = require("./ipdBillsRoutes");

router.post(
  "/post/procedures",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const {
        ipd_id,
        procedure_name,
        procedure_date,
        doctor_id,
        notes,
        procedure_charge,
      } = req.body;

      const { adminId, id: staff_id } = req.user;
      const admin_id = adminId;

      if (!ipd_id || !procedure_name || !procedure_date) {
        return res.status(400).json({
          message: "ipd_id, procedure_name, procedure_date required",
        });
      }

      // =====================================================
      // 🔒 STEP 1: VALIDATE STAFF (ROLE + ADMIN + BRANCH)
      // =====================================================
      const [staff] = await db.query(
        `SELECT admin_id, branch, role 
         FROM staff 
         WHERE id = ?`,
        [staff_id],
      );

      if (staff.length === 0) {
        return res.status(404).json({ message: "Staff not found" });
      }

      const staffData = staff[0];

      // ✅ 1. ADMIN MATCH (MOST IMPORTANT)
      if (staffData.admin_id !== adminId) {
        return res.status(403).json({
          message: "Access denied: Admin mismatch",
        });
      }

      // ✅ 2. ROLE CHECK (EXTRA SECURITY)
      if (staffData.role !== "receptionist") {
        return res.status(403).json({
          message: "Access denied: Only receptionist allowed",
        });
      }

      // ✅ 3. BRANCH VALUE
      const staff_branch = staffData.branch;
      // ✅ Check admin match
      if (staffData.admin_id !== admin_id) {
        return res.status(403).json({
          message: "Invalid admin mapping",
        });
      }

      // ✅ Check role from DB (extra security)
      if (staffData.role !== "receptionist") {
        return res.status(403).json({
          message: "Access denied: Only receptionist allowed",
        });
      }

      // =====================================================
      // 🔒 STEP 2: VALIDATE DOCTOR (ADMIN + OPTIONAL BRANCH)
      // =====================================================
      if (doctor_id) {
        const [doctor] = await db.query(
          `SELECT admin_id, branch 
            FROM staff 
            WHERE id = ? AND role = 'doctor'`,
          [doctor_id],
        );

        if (doctor.length === 0) {
          return res.status(404).json({
            message: "Invalid doctor_id",
          });
        }

        const doctorData = doctor[0];

        // ✅ Admin match
        if (doctorData.admin_id !== admin_id) {
          return res.status(403).json({
            message: "Access denied: Doctor belongs to different admin",
          });
        }

        // ✅ (Recommended) Branch match
        // if (doctorData.branch_name !== staff_branch) {
        //   return res.status(403).json({
        //     message: "Access denied: Doctor belongs to different branch",
        //   });
        // }
      }

      // =====================================================
      // 🔒 STEP 3: VALIDATE IPD (ADMIN + BRANCH)
      // =====================================================
      const [ipd] = await db.query(
        `SELECT admin_id, branch_name 
         FROM ipd_admissions 
         WHERE id = ?`,
        [ipd_id],
      );

      if (ipd.length === 0) {
        return res.status(404).json({
          message: "Invalid IPD",
        });
      }

      const ipdData = ipd[0];

      // ✅ Admin match
      if (ipdData.admin_id !== admin_id) {
        return res.status(403).json({
          message: "Access denied: Different admin",
        });
      }

      // ✅ Branch match
      if (
        (ipdData.branch_name || "").trim().toLowerCase() !==
        (staff_branch || "").trim().toLowerCase()
      ) {
        return res.status(403).json({
          message: "Access denied: Branch mismatch",
        });
      }

      // =====================================================
      // ✅ STEP 3: INSERT PROCEDURE
      // =====================================================
      const [result] = await db.query(
        `INSERT INTO ipd_procedures 
        (admin_id, ipd_id, procedure_name, procedure_date, doctor_id, notes, procedure_charge)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          admin_id,
          ipd_id,
          procedure_name,
          procedure_date,
          doctor_id || null,
          notes || null,
          procedure_charge || 0,
        ],
      );

      await regenerateBill(ipd_id);

      res.status(201).json({
        message: "Procedure created successfully",
        id: result.insertId,
      });
    } catch (err) {
      console.error("Create procedure error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.get(
  "/getall/procedures",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { role, id: userId, adminId } = req.user;
      const admin_id = role === "admin" ? userId : adminId;

      // 👨‍💼 Admin
      if (role === "admin") {
        const [data] = await db.query(
          `SELECT * FROM ipd_procedures 
           WHERE admin_id = ?
           ORDER BY procedure_date DESC`,
          [admin_id],
        );

        return res.json({ data });
      }

      // 🧑‍💻 Receptionist → branch filter
      const [staff] = await db.query(`SELECT branch FROM staff WHERE id = ?`, [
        userId,
      ]);

      const branch = staff[0].branch;

      const [data] = await db.query(
        `SELECT p.*
         FROM ipd_procedures p
         JOIN ipd_admissions ia ON p.ipd_id = ia.id
         WHERE p.admin_id = ?
         AND ia.branch_name = ?
         ORDER BY p.procedure_date DESC`,
        [admin_id, branch],
      );

      res.json({ data });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.get(
  "/get/procedure/:id",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { role, id: userId, adminId } = req.user;

      const admin_id = role === "admin" ? userId : adminId;

      // =====================================================
      // 👨‍💼 ADMIN → DIRECT FETCH
      // =====================================================
      if (role === "admin") {
        const [data] = await db.query(
          `SELECT * FROM ipd_procedures 
           WHERE id = ? AND admin_id = ?`,
          [id, admin_id],
        );

        if (data.length === 0) {
          return res.status(404).json({ message: "Procedure not found" });
        }

        return res.json({ data: data[0] });
      }

      // =====================================================
      // 🧑‍💻 RECEPTIONIST → BRANCH FILTER
      // =====================================================

      // 👉 Get staff branch
      const [staff] = await db.query(`SELECT branch FROM staff WHERE id = ?`, [
        userId,
      ]);

      if (staff.length === 0) {
        return res.status(404).json({ message: "Staff not found" });
      }

      const branch = staff[0].branch;

      // 👉 Fetch only if branch matches
      const [data] = await db.query(
        `SELECT p.*
         FROM ipd_procedures p
         JOIN ipd_admissions ia ON p.ipd_id = ia.id
         WHERE p.id = ?
         AND p.admin_id = ?
         AND ia.branch_name = ?`,
        [id, admin_id, branch],
      );

      if (data.length === 0) {
        return res.status(404).json({
          message: "Procedure not found or access denied",
        });
      }

      res.json({ data: data[0] });
    } catch (err) {
      console.error("Get procedure by ID error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.get(
  "/get/procedure/ipd/:ipd_id",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { ipd_id } = req.params;
      const { role, id: userId, adminId } = req.user;

      const finalAdminId = role === "admin" ? userId : adminId;

      // =====================================================
      // 👨‍💼 ADMIN
      // =====================================================
      if (role === "admin") {
        const [data] = await db.query(
          `SELECT *
           FROM ipd_procedures
           WHERE ipd_id = ?
             AND admin_id = ?
           ORDER BY procedure_date DESC`,
          [ipd_id, finalAdminId]
        );

        return res.json({ data });
      }

      // =====================================================
      // 👤 CLIENT (Centralized Patient)
      // =====================================================
      if (role === "client") {
        // Verify the IPD belongs to the logged-in patient
        const [[ipd]] = await db.query(
          `SELECT id
           FROM ipd_admissions
           WHERE id = ?
             AND client_id = ?`,
          [ipd_id, userId]
        );

        if (!ipd) {
          return res.status(403).json({
            message: "Access denied",
          });
        }

        // Fetch all procedures for this IPD (no admin filter)
        const [data] = await db.query(
          `SELECT *
           FROM ipd_procedures
           WHERE ipd_id = ?
           ORDER BY procedure_date DESC`,
          [ipd_id]
        );

        return res.json({ data });
      }

      // =====================================================
      // 🧑‍💻 RECEPTIONIST → BRANCH FILTER
      // =====================================================
      const [[staff]] = await db.query(
        `SELECT branch
         FROM staff
         WHERE id = ?`,
        [userId]
      );

      if (!staff) {
        return res.status(404).json({
          message: "Staff not found",
        });
      }

      const [data] = await db.query(
        `SELECT p.*
         FROM ipd_procedures p
         JOIN ipd_admissions ia
           ON p.ipd_id = ia.id
         WHERE p.ipd_id = ?
           AND p.admin_id = ?
           AND ia.branch_name = ?
         ORDER BY p.procedure_date DESC`,
        [
          ipd_id,
          finalAdminId,
          staff.branch,
        ]
      );

      return res.json({ data });

    } catch (err) {
      console.error("Get procedures by IPD error:", err);
      return res.status(500).json({
        message: "Server error",
      });
    }
  }
);

router.put(
  "/update/procedure/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { adminId, id: staff_id } = req.user;
      const admin_id = adminId;

      const {
        procedure_name,
        procedure_date,
        doctor_id,
        notes,
        procedure_charge,
      } = req.body;

      // =====================================================
      // 🔒 STEP 1: CHECK PROCEDURE + IPD
      // =====================================================
      const [check] = await db.query(
        `SELECT p.*, ia.branch_name, ia.admin_id 
         FROM ipd_procedures p
         JOIN ipd_admissions ia ON p.ipd_id = ia.id
         WHERE p.id = ? AND p.admin_id = ?`,
        [id, admin_id],
      );

      if (check.length === 0) {
        return res.status(404).json({ message: "Procedure not found" });
      }

      const ipdData = check[0];

      // =====================================================
      // 🔒 STEP 2: VALIDATE STAFF
      // =====================================================
      const [staff] = await db.query(
        `SELECT admin_id, branch, role 
         FROM staff 
         WHERE id = ?`,
        [staff_id],
      );

      if (staff.length === 0) {
        return res.status(404).json({ message: "Staff not found" });
      }

      const staffData = staff[0];

      // ✅ Admin match
      if (staffData.admin_id !== admin_id) {
        return res.status(403).json({ message: "Admin mismatch" });
      }

      // ✅ Role check
      if (staffData.role !== "receptionist") {
        return res.status(403).json({ message: "Only receptionist allowed" });
      }

      const staff_branch = staffData.branch;

      // =====================================================
      // 🔒 STEP 3: BRANCH CHECK
      // =====================================================
      if (ipdData.branch_name !== staff_branch) {
        return res.status(403).json({ message: "Branch mismatch" });
      }

      // =====================================================
      // 🔒 STEP 4: DOCTOR VALIDATION (IF PROVIDED)
      // =====================================================
      if (doctor_id) {
        const [doctor] = await db.query(
          `SELECT admin_id, branch, role 
           FROM staff 
           WHERE id = ?`,
          [doctor_id],
        );

        if (doctor.length === 0 || doctor[0].role !== "doctor") {
          return res.status(404).json({ message: "Invalid doctor" });
        }

        const doctorData = doctor[0];

        if (doctorData.admin_id !== admin_id) {
          return res.status(403).json({
            message: "Doctor belongs to different admin",
          });
        }

        // if (doctorData.branch_name !== staff_branch) {
        //   return res.status(403).json({
        //     message: "Doctor belongs to different branch",
        //   });
        // }
      }

      // =====================================================
      // ✅ STEP 5: UPDATE
      // =====================================================
      await db.query(
        `UPDATE ipd_procedures SET
          procedure_name = ?,
          procedure_date = ?,
          doctor_id = ?,
          notes = ?,
          procedure_charge = ?
         WHERE id = ? AND admin_id = ?`,
        [
          procedure_name || ipdData.procedure_name,
          procedure_date || ipdData.procedure_date,
          doctor_id ?? ipdData.doctor_id,
          notes ?? ipdData.notes,
          procedure_charge ?? ipdData.procedure_charge,
          id,
          admin_id,
        ],
      );

      await regenerateBill(ipdData.ipd_id);

      res.json({ message: "Updated successfully" });
    } catch (err) {
      console.error("Update procedure error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

router.delete(
  "/delete/procedure/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { adminId, id: staff_id } = req.user;
      const admin_id = adminId;

      const [check] = await db.query(
        `SELECT p.id, ia.branch_name
         FROM ipd_procedures p
         JOIN ipd_admissions ia ON p.ipd_id = ia.id
         WHERE p.id = ? AND p.admin_id = ?`,
        [id, admin_id],
      );

      if (check.length === 0) {
        return res.status(404).json({ message: "Not found" });
      }

      const [staff] = await db.query(`SELECT branch FROM staff WHERE id = ?`, [
        staff_id,
      ]);

      if (staff[0].branch !== check[0].branch_name) {
        return res.status(403).json({ message: "Branch mismatch" });
      }

      await db.query(
        `DELETE FROM ipd_procedures WHERE id = ? AND admin_id = ?`,
        [id, admin_id],
      );
      
      await regenerateBill(check[0].ipd_id);

      res.json({ message: "Deleted" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  },
);

module.exports = router;