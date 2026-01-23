const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");
const multer = require("multer");
const fs = require("fs");
const nodemailer = require("nodemailer");

const path = require("path");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* -----------------------------
   ADMIN ID GENERATOR
------------------------------ */
function generateStaffId() {
  const fixedDigit = "2";
  const randomFive = Math.floor(Math.random() * 90000) + 10000;
  return fixedDigit + randomFive;
}

/* ===============================
   MULTER CONFIG (STAFF PHOTO)
================================ */
const BASE_UPLOAD_DIR = path.join(__dirname, "..", "Images", "companies");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 🔹 support both admin & other roles
    const adminId = req.user?.adminId || req.user?.id;

    if (!adminId) {
      return cb(new Error("Admin ID missing from token"));
    }

    // 🔹 Get staffId from multiple sources
    const staffId = req.generatedStaffId  // new staff creation
                 || req.params.id         // admin updating staff
                 || req.user.id;          // ✅ staff updating self

    if (!staffId) {
      return cb(new Error("Staff ID missing"));
    }

    const uploadPath = path.join(
      BASE_UPLOAD_DIR,
      `admin_${adminId}`,
      "staff",
      `staff_${staffId}`,
      "profile_photo"
    );

    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `profile${ext}`);
  },
});

const uploadStaffPhoto = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/jpg"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only PNG, JPG, JPEG allowed"));
    }
    cb(null, true);
  },
});

/* ================= EMAIL CONFIG ================= */

const transporter = nodemailer.createTransport({
  host: "smtp.zoho.in", // or smtp.zoho.com
  port: 465,
  secure: true,
  auth: {
    user: "info@ridgeveda.com",
    pass: process.env.ZOHO_APP_PASS, // Zoho SMTP App Password
  },
});

/* ======================================================
   CREATE STAFF (TEXT + PHOTO IN ONE REQUEST)
====================================================== */
router.post(
  "/staff/create",
  authMiddleware,
  allowRoles("admin"),
  uploadStaffPhoto.single("profile_photo"), // ✅ MUST BE FIRST
  async (req, res) => {
    try {
      const admin_id = req.user.id; // from cookie
      req.generateStaffId = generateStaffId();

      // ✅ NOW req.body IS AVAILABLE
      const {
        name,
        email,
        password,
        mobile,
        address,
        role,
        branch,
        qualification,
        date_of_joining,
        status,
      } = req.body;

      if (!name) return res.status(400).json({ error: "Name is required" });
      if (!email) return res.status(400).json({ error: "Email is required" });
      if (!password)
        return res.status(400).json({ error: "Password is required" });
      if (!mobile) return res.status(400).json({ error: "Mobile is required" });
      if (!role) return res.status(400).json({ error: "Role is required" });
      if (!branch) return res.status(400).json({ error: "Branch is required" });
      if (!qualification)
        return res.status(400).json({ error: "Qualification is required" });
      if (!date_of_joining)
        return res.status(400).json({ error: "Date of joining  is required" });

      const normalizedEmail = email.trim().toLowerCase();

      const [exists] = await db.execute(
        "SELECT id FROM staff WHERE email = ?",
        [normalizedEmail]
      );

      if (exists.length) {
        return res.status(409).json({ error: "Email already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      // 1️⃣ Insert staff FIRST (without photo)
      const [result] = await db.execute(
        `
        INSERT INTO staff
        (admin_id,id, name, email, password, mobile, address, role, branch, qualification, date_of_joining, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          admin_id,
          req.generateStaffId,
          name,
          normalizedEmail,
          hashedPassword,
          mobile,
          address || null,
          role,
          branch,
          qualification || null,
          date_of_joining,
          status ?? 1,
        ]
      );

      // 2️⃣ Build photo path AFTER staffId exists
      const staffId = req.generateStaffId;
      let photoPath = null;
      if (req.file) {
        photoPath = `companies/admin_${admin_id}/staff/staff_${staffId}/profile_photo/${req.file.filename}`;
        await db.execute("UPDATE staff SET profile_photo = ? WHERE id = ?", [
          photoPath,
          staffId,
        ]);
      }

      // 3️⃣ SEND EMAIL (same route) ✅
      const mailOptions = {
        from: '"Ridgeveda Info" <info@ridgeveda.com>',
        to: normalizedEmail,
        subject: "Your Staff Account Credentials",
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
      };

      transporter
        .sendMail(mailOptions)
        .then((info) => console.log("Staff email sent:", info.response))
        .catch((err) => console.error("Email error:", err.message));

      return res.status(201).json({
        success: true,
        message: "Staff created successfully",
        staff_id: staffId,
        profile_photo: photoPath,
        image_url: photoPath
          ? `${req.protocol}://${req.get("host")}/Images/${photoPath}`
          : null,
      });
    } catch (error) {
      console.error("CREATE STAFF ERROR:", error);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

/* ======================================================
   UPDATE STAFF PROFILE (WITH / WITHOUT PHOTO)
====================================================== */
router.put(
  "/staff/update/:id",
  authMiddleware,
  allowRoles("admin"),
  uploadStaffPhoto.single("profile_photo"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const adminId = req.user.id;

      const [rows] = await db.execute(
        "SELECT * FROM staff WHERE id = ? AND admin_id = ?",
        [id, adminId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Staff not found" });
      }

      const staff = rows[0];

      const photoPath = req.file
        ? `companies/admin_${adminId}/staff/staff_${id}/profile_photo/${req.file.filename}`
        : staff.profile_photo;

      await db.execute(
        `
        UPDATE staff SET
          name = ?,
          email = ?,
          mobile = ?,
          address = ?,
          role = ?,
          branch = ?,
          qualification = ?,
          date_of_joining = ?,
          status = ?,
          profile_photo = ?
        WHERE id = ?
        `,
        [
          req.body.name || staff.name,
          req.body.email || staff.email,
          req.body.mobile || staff.mobile,
          req.body.address || staff.address,
          req.body.role || staff.role,
          req.body.branch || staff.branch,
          req.body.qualification || staff.qualification,
          req.body.date_of_joining || staff.date_of_joining,
          req.body.status ?? staff.status,
          photoPath,
          id,
        ]
      );

      res.json({
        success: true,
        message: "Staff profile updated successfully",
        profile_photo: photoPath,
        image_url: photoPath
          ? `${req.protocol}://${req.get("host")}/Images/${photoPath}`
          : null,
      });
    } catch (err) {
      console.error("UPDATE STAFF ERROR:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* ======================================================
   UPDATE STAFF PROFILE (WITH PHOTO)
====================================================== */

router.put(
  "/staff/self/edit",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  uploadStaffPhoto.single("profile_photo"),
  async (req, res) => {
    try {
      const staffId = req.user.id;       // from cookie
      const adminId = req.user.adminId; // from cookie

      /* ✅ Verify staff exists under same admin */
      const [rows] = await db.execute(
        "SELECT * FROM staff WHERE id = ? AND admin_id = ?",
        [staffId, adminId]
      );

      if (!rows.length) {
        return res.status(404).json({
          message: "Staff not found or unauthorized",
        });
      }

      const staff = rows[0];

      /* ✅ Handle profile photo */
      const photoPath = req.file
        ? `companies/admin_${adminId}/staff/staff_${staffId}/profile_photo/${req.file.filename}`
        : staff.profile_photo;

      /* ✅ Update allowed fields ONLY */
      await db.execute(
        `
        UPDATE staff SET
          name = ?,
          mobile = ?,
          address = ?,
          branch = ?,
          qualification = ?,
          profile_photo = ?
        WHERE id = ? AND admin_id = ?
        `,
        [
          req.body.name || staff.name,
          req.body.mobile || staff.mobile,
          req.body.address || staff.address,
          req.body.branch || staff.branch,
          req.body.qualification || staff.qualification,
          photoPath,
          staffId,
          adminId,
        ]
      );

      res.json({
        success: true,
        message: "Profile updated successfully",
        profile_photo: photoPath,
        image_url: photoPath
          ? `${req.protocol}://${req.get("host")}/Images/${photoPath}`
          : null,
      });
    } catch (error) {
      console.error("STAFF SELF UPDATE ERROR:", error);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* ======================================================
   GET STAFF (ADMIN WISE)
====================================================== */
router.get(
  "/staff/get",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const adminId = req.user.id;
    const [rows] = await db.execute("SELECT * FROM staff WHERE admin_id = ?", [
      adminId,
    ]);
    res.json({ success: true, data: rows });
  }
);

/* ======================================================
   GET STAFF BY ROLE (ADMIN WISE)
====================================================== */
router.get(
  "/staff/role",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;
      const { role } = req.query;

      let query = "SELECT * FROM staff WHERE admin_id = ?";
      let params = [adminId];

      if (role) {
        query += " AND role = ?";
        params.push(role);
      }

      const [rows] = await db.execute(query, params);

      res.json({
        success: true,
        data: rows,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// GET THE STAFF ID WISE DETAILS
router.get(
  "/staff/get/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;
      const staffId = req.params.id;

      if (!staffId) {
        return res.status(400).json({ error: "Staff ID is required" });
      }

      const [rows] = await db.execute(
        "SELECT * FROM staff WHERE id = ? AND admin_id = ?",
        [staffId, adminId]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Staff not found" });
      }

      return res.json({
        success: true,
        data: rows[0],
      });
    } catch (error) {
      console.error("GET STAFF BY ID ERROR:", error);
      return res.status(500).json({ error: "Server error" });
    }
  }
);
// GET THE STAFF ID WISE DETAILS

/* ======================================================
   GET BRANCH DOCTORS (RECEPTIONIST ONLY)
====================================================== */
router.get(
  "/staff/branch-doctors",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const receptionistId = req.user.id;

      // 1️⃣ Get receptionist details
      const [receptionistRows] = await db.execute(
        `SELECT admin_id, branch 
         FROM staff 
         WHERE id = ? AND role = 'receptionist'`,
        [receptionistId]
      );

      if (!receptionistRows.length) {
        return res.status(404).json({
          success: false,
          message: "Receptionist not found",
        });
      }

      const { admin_id, branch } = receptionistRows[0];

      // 2️⃣ Fetch doctors from same admin + same branch
      const [doctors] = await db.execute(
        `SELECT id, name, email, mobile, branch, qualification, status, profile_photo
         FROM staff
         WHERE role = 'doctor'
           AND admin_id = ?
           AND branch = ?
         ORDER BY name ASC`,
        [admin_id, branch]
      );

      res.json({
        success: true,
        branch,
        total_doctors: doctors.length,
        data: doctors.map((doc) => ({
          ...doc,
          image_url: doc.profile_photo
            ? `${req.protocol}://${req.get("host")}/Images/${doc.profile_photo}`
            : null,
        })),
      });
    } catch (error) {
      console.error("FETCH BRANCH DOCTORS ERROR:", error);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/* ======================================================
   GET STAFF SELF (DOCTORS AND RECEPTIONIST)
====================================================== */
router.get(
  "/staff/self",
  authMiddleware,
  allowRoles("receptionist", "doctor"),
  async (req, res) => {
    const staffId = req.user.id;

    const [rows] = await db.execute("SELECT * FROM staff WHERE id = ?", [
      staffId,
    ]);

    res.json({ success: true, data: rows[0] });
  }
);

/* ======================================================
   DELETE STAFF
====================================================== */
router.delete(
  "/staff/delete/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const adminId = req.user.id;

    const [rows] = await db.execute(
      "SELECT * FROM staff WHERE id = ? AND admin_id = ?",
      [req.params.id, adminId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Staff not found" });
    }

    await db.execute("DELETE FROM staff WHERE id = ?", [req.params.id]);

    res.json({ success: true, message: "Staff deleted successfully" });
  }
);

/* ======================================================
   GET STAFF to clients
====================================================== */

router.get(
  "/staff/doctors/client",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;

      // 1️⃣ Get admin_id linked to this client
      const [[client]] = await db.execute(
        "SELECT admin_id FROM clients WHERE id = ?",
        [clientId]
      );

      if (!client) {
        return res.status(404).json({
          success: false,
          message: "Client not found",
        });
      }

      const adminId = client.admin_id;

      // 2️⃣ Fetch staff using admin_id
      const [staff] = await db.execute(
        "SELECT * FROM staff WHERE admin_id = ?",
        [adminId]
      );

      res.json({
        success: true,
        data: staff,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);


//count available doctor of branch 

router.get(
  "/available-doctors",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const staffId = req.user.id;      // receptionist id
      const adminId = req.user.adminId;

      /* -------------------------------
         1️⃣ Get receptionist branch
      -------------------------------- */
      const [staffRows] = await db.execute(
        `
        SELECT branch
        FROM staff
        WHERE id = ? AND admin_id = ?
        `,
        [staffId, adminId]
      );

      if (!staffRows.length) {
        return res.status(404).json({
          success: false,
          message: "Receptionist not found",
        });
      }

      const branch = staffRows[0].branch;

      /* -------------------------------
         2️⃣ Get available doctors
      -------------------------------- */
      const [doctors] = await db.execute(
        `
        SELECT
          s.id AS doctorId,
          s.name AS doctorName,
          s.qualification AS specialization,

          COALESCE(slots.availableSlots, 0) AS availableSlots,
          COALESCE(appts.todayAppointments, 0) AS todayAppointments

        FROM staff s

        /* Available slots today */
        LEFT JOIN (
          SELECT
            staff_id,
            COUNT(id) AS availableSlots
          FROM staff_time_slots
          WHERE slot_date = CURDATE()
            AND is_booked = 0
          GROUP BY staff_id
        ) slots ON slots.staff_id = s.id

        /* Today's appointments */
        LEFT JOIN (
          SELECT
            staff_id,
            COUNT(id) AS todayAppointments
          FROM appointments
          WHERE appointment_date = CURDATE()
            AND status IN ('pending','assigned','approved','completed')
          GROUP BY staff_id
        ) appts ON appts.staff_id = s.id

        WHERE
          s.admin_id = ?
          AND s.role = 'doctor'
          AND s.branch = ?
          AND COALESCE(slots.availableSlots, 0) > 0

        LIMIT 3
        `,
        [adminId, branch]
      );

      return res.json({
        success: true,
        data: doctors,
      });
    } catch (error) {
      console.error("Available doctors error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

/* ======================================================
   GET STAFF to clients
====================================================== */

router.get(
  "/staff/doctors/client",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;

      // 1️⃣ Get admin_id linked to this client
      const [[client]] = await db.execute(
        "SELECT admin_id FROM clients WHERE id = ?",
        [clientId]
      );

      if (!client) {
        return res.status(404).json({
          success: false,
          message: "Client not found",
        });
      }

      const adminId = client.admin_id;

      // 2️⃣ Fetch staff using admin_id
      const [staff] = await db.execute(
        "SELECT * FROM staff WHERE admin_id = ?",
        [adminId]
      );

      res.json({
        success: true,
        data: staff,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

//count no of doctors of receptionist branch or all doctors count for admin 
router.get(
  "/staff/doctors/count",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const role = req.user.role;
      const adminId =
        role === "admin" ? req.user.id : req.user.adminId;

      let totalDoctors = 0;
      let branch = "ALL";

      // =========================
      // ADMIN → ALL doctors
      // =========================
      if (role === "admin") {
        const [[result]] = await db.execute(
          `
          SELECT COUNT(*) AS total
          FROM staff
          WHERE admin_id = ?
            AND role = 'doctor'
            AND status = 1
          `,
          [adminId]
        );

        totalDoctors = result.total;
      }

      // =========================
      // RECEPTIONIST → SAME branch
      // =========================
      if (role === "receptionist") {
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

        const [[result]] = await db.execute(
          `
          SELECT COUNT(*) AS total
          FROM staff
          WHERE admin_id = ?
            AND role = 'doctor'
            AND branch = ?
            AND status = 1
          `,
          [adminId, branch]
        );

        totalDoctors = result.total;
      }

      res.json({
        success: true,
        role,
        branch,
        totalDoctors,
      });
    } catch (error) {
      console.error("Doctor count error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch doctor count",
      });
    }
  }
);

module.exports = router;
