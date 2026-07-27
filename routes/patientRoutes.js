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

router.post(
  "/patient/create",
  async (req, res) => {
    try {
      req.generateClientId = generateClientId();
    //   const admin_id =
    //     req.user.role === "admin" ? req.user.id : req.user.adminId;

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
        "SELECT id FROM patients WHERE email = ?",
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
        `INSERT INTO patients
        (id, name, email, password, mobile, address, gender, dob, blood_group, status)
        VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
        message: "User created successfully",
        id: req.generateClientId,
      });
    } catch (err) {
      console.error("PATIENT CREATE ERROR:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

module.exports = router;