const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
require("dotenv").config();

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* ================= EMAIL CONFIG ================= */
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: "caredesk360@gmail.com",
    pass: process.env.MAIL_PASS,
  },
});

/* ================= Generates random 6 Digits ID ================= */
function generateClientId() {
  const fixedDigit = "3";
  const random = Math.floor(Math.random() * 90000000) + 10000000;
  return fixedDigit + random;
}
// console.log(generateClientId());

/* =====================================================
   CREATE PATIENT (ADMIN ONLY)
===================================================== */
router.post(
  "/client/create",
  authMiddleware,
  allowRoles("receptionist", "admin"),
  async (req, res) => {
    try {
      req.generateClientId = generateClientId();
      const admin_id =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      const {
        name,
        email,
        password,
        mobile,
        address,
        gender,
        dob,
        blood_group,
        status,
      } = req.body;

      if (!name) return res.status(400).json({ error: "Name is required" });
      if (!email) return res.status(400).json({ error: "Email is required" });
      if (!password)
        return res.status(400).json({ error: "Password is required" });

      if (mobile && !/^\d{10}$/.test(mobile)) {
        return res.status(400).json({
          success: false,
          message: "Invalid mobile number",
        });
      }
      const normalizedEmail = email.trim().toLowerCase();

      // Email uniqueness
      const [exists] = await db.execute(
        "SELECT id FROM clients WHERE email = ?",
        [normalizedEmail]
      );
      if (exists.length) {
        return res.status(400).json({
          success: false,
          message: "Email already exists",
        });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      await db.execute(
        `INSERT INTO clients
        (admin_id,id, name, email, password, mobile, address, gender, dob, blood_group, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          admin_id,
          req.generateClientId,
          name,
          normalizedEmail,
          hashedPassword,
          mobile || null,
          address || null,
          gender || null,
          dob || null,
          blood_group || null,
          status ?? 1,
        ]
      );

      // Send credentials email

      await transporter.sendMail({
        from: '"Healthcare Support Team" <info@ridgeveda.com>',
        to: email,
        subject: "Your Patient Account Access Details",
        html: `
    <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f5f7fa; padding: 24px;">
      <div style="max-width: 520px; margin: 0 auto; background-color: #ffffff; padding: 24px; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,0.05);">

        <h3 style="color: #2c3e50; margin-top: 0;">
          Hello ${name},
        </h3>

        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          Your patient account has been successfully created. Below are your temporary access credentials:
        </p>

        <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 20px 0;">
          <p style="margin: 0; font-size: 14px; color: #333;">
            <strong>Email:</strong> ${normalizedEmail}
          </p>
          <p style="margin: 8px 0 0; font-size: 14px; color: #333;">
            <strong>Temporary Password:</strong> ${password}
          </p>
          <p style="margin: 8px 0 0; font-size: 14px; color: #333;">
            <strong>Login Url:</strong> <a href="https://caredesk360.com/login">click here</a>
          </p>
        </div>

        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          For security reasons, please log in and change your password immediately after your first sign-in.
        </p>

        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          If you did not request this account or believe this email was sent to you in error, please contact our support team immediately.
        </p>

        <p style="margin-top: 32px; font-size: 13px; color: #777;">
          Regards,<br />
          <strong>Healthcare Support Team</strong>
        </p>
      </div>

      <p style="text-align: center; margin-top: 12px; font-size: 12px; color: #999;">
        This is an automated message. Please do not reply to this email.
      </p>
    </div>
  `,
      });

      res.status(201).json({
        success: true,
        message: "Patient created successfully",
        id: req.generateClientId,
        role: `Created by ${req.user.role}`,
      });
    } catch (err) {
      console.error("PATIENT CREATE ERROR:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/*ALL GET METHODS ===================================================== */

/* =====================================================
   GET ALL PATIENTS (ADMIN)
===================================================== */
router.get(
  "/client/get",
  authMiddleware,
  allowRoles("receptionist", "admin"),
  async (req, res) => {
    try {
      const adminId = req.user.adminId ?? req.user.id;

      const [patients] = await db.execute(
        `SELECT *
         FROM clients
         WHERE admin_id = ?
         ORDER BY id DESC`,
        [adminId]
      );

      res.json({ success: true, data: patients });
    } catch (err) {
      console.error(err);
      res.status(500).json({
        success: false,
        message: "Unable to fetch patients",
      });
    }
  }
);

/* =====================================================
   GET PATIENT (Admin or Receptionist or doctor with params only)
===================================================== */
router.get(
  "/client/get/:id",
  authMiddleware, // ✅ MUST be first
  allowRoles("admin", "receptionist", "doctor"), // ✅ ONLY these roles
  async (req, res) => {
    try {
      const patientId = req.params.id;

      const adminId = req.user.adminId ?? req.user.id;

      const [rows] = await db.execute(
        `
        SELECT *
        FROM clients
        WHERE id = ? AND admin_id = ?
        `,
        [patientId, adminId]
      );

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Patient not found",
        });
      }

      // ✅ Always ONE person
      res.json({
        success: true,
        data: rows[0],
      });
    } catch (err) {
      console.error("Get patient error:", err);
      res.status(500).json({
        success: false,
        message: "Failed to fetch patient",
      });
    }
  }
);

/* =====================================================
   GET PATIENT (Self Only)
===================================================== */
router.get(
  "/client/self",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    const [rows] = await db.execute("SELECT * FROM clients WHERE id = ?", [
      req.user.id,
    ]);
    res.json({ success: true, data: rows[0] });
  }
);

/* =====================================================
   PATIENT COUNT (ADMIN / STAFF)
===================================================== */
router.get(
  "/client/count",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    const adminId = req.user.role === "admin" ? req.user.id : req.user.adminId;

    const [[result]] = await db.execute(
      "SELECT COUNT(*) AS total FROM clients WHERE admin_id=?",
      [adminId]
    );

    res.json({ success: true, totalPatients: result.total });
  }
);

/* GET METHOD ENDS ===================================================== */

/* =====================================================
   UPDATE PATIENT (ADMIN OR SELF)
===================================================== */
router.put(
  "/client/update/:id",
  authMiddleware,
  allowRoles("admin", "client", "receptionist"),
  async (req, res) => {
    try {
      const user = req.user;
      const patientId = req.params.id;

      if (user.role === "client" && patientId != user.id) {
        return res.status(403).json({
          success: false,
          message: "Unauthorized",
        });
      }

      const [existing] = await db.execute(
        "SELECT * FROM clients WHERE id = ?",
        [patientId]
      );
      if (!existing.length) {
        return res.status(404).json({ success: false });
      }

      const {
        name,
        email,
        mobile,
        address,
        gender,
        dob,
        blood_group,
        status,
        password,
      } = req.body;

      let hashedPassword = existing[0].password;
      if (password) hashedPassword = await bcrypt.hash(password, 10);

      await db.execute(
        `UPDATE clients SET
          name=?, email=?, password=?, mobile=?, address=?,
          gender=?, dob=?, blood_group=?, status=?
         WHERE id=?`,
        [
          name ?? existing[0].name,
          email ?? existing[0].email,
          hashedPassword,
          mobile ?? existing[0].mobile,
          address ?? existing[0].address,
          gender ?? existing[0].gender,
          dob ?? existing[0].dob,
          blood_group ?? existing[0].blood_group,
          status ?? existing[0].status,
          patientId,
        ]
      );

      res.json({ success: true, message: "Patient updated" });
    } catch (err) {
      res.status(500).json({ success: false });
    }
  }
);

/* =====================================================
   DELETE PATIENT (ADMIN)
===================================================== */
router.delete(
  "/client/delete/:id",
  authMiddleware,
  allowRoles("admin","receptionist"),
  async (req, res) => {
    try {
      const patientId = req.params.id;
      const adminId =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      if (!patientId) {
        return res.status(400).json({
          success: false,
          message: "Invalid patient id",
        });
      }

      // Step 1: Verify patient exists under this admin
      const [rows] = await db.execute(
        "SELECT id, admin_id FROM clients WHERE id = ?",
        [patientId]
      );
      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Patient does not exist",
        });
      }

      // Step 2: Check ownership
      if (rows[0].admin_id !== adminId) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to delete this patient",
        });
      }

      // Step 2: Delete patient
      const [result] = await db.execute(
        "DELETE FROM clients WHERE id = ? AND admin_id = ?",
        [patientId, adminId]
      );

      if (result.affectedRows === 0) {
        return res.status(500).json({
          success: false,
          message: "Delete failed",
        });
      }

      res.status(200).json({
        success: true,
        message: "Patient deleted successfully",
      });
    } catch (error) {
      console.error("Delete patient error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

// get all clients of particular branch 

router.get(
  "/staff/clients",
  authMiddleware,
  allowRoles("receptionist", "doctor"),
  async (req, res) => {
    try {
      // Assuming staffId and adminId are stored in cookies
      const staffId = req.user.id;
      const adminId = req.user.adminId;

      if (!staffId || !adminId) {
        return res.status(400).json({
          success: false,
          message: "Staff ID or Admin ID missing in cookies",
        });
      }

      // Get branch of the staff
      const [staffRows] = await db.execute(
        `SELECT branch FROM staff WHERE id = ? AND admin_id = ? AND status = 1`,
        [staffId, adminId]
      );

      if (staffRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Staff not found or inactive",
        });
      }

      const branch = staffRows[0].branch;

      // Get all clients under the same admin and branch
      // Assuming branch is linked via staff to clients
      const [clients] = await db.execute(
        `SELECT c.*
         FROM clients c
         JOIN staff s ON s.admin_id = c.admin_id
         WHERE c.admin_id = ? AND s.branch = ?
         GROUP BY c.id
         ORDER BY c.id DESC`,
        [adminId, branch]
      );

      res.json({ success: true, data: clients });
    } catch (err) {
      console.error(err);
      res.status(500).json({
        success: false,
        message: "Unable to fetch clients for your branch",
      });
    }
  }
);

//count current month clients
router.get(
  "/client/count/current-month",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const adminId =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      const [[result]] = await db.execute(
        `
        SELECT COUNT(*) AS total
        FROM clients
        WHERE admin_id = ?
          AND MONTH(created_at) = MONTH(CURDATE())
          AND YEAR(created_at) = YEAR(CURDATE())
        `,
        [adminId]
      );

      res.json({
        success: true,
        currentMonthPatients: result.total,
      });
    } catch (error) {
      console.error("Current month client count error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch current month clients",
      });
    }
  }
);

module.exports = router;
