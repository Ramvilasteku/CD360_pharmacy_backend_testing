const express = require("express");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const db = require("../db");

const router = express.Router();
const saltRounds = 10;
const OTP_EXPIRY_MIN = 10;

/* =====================================
   OTP GENERATOR (6 DIGIT)
===================================== */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* =====================================
   MAIL CONFIG
===================================== */
const transporter = nodemailer.createTransport({
 host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: "caredesk360@gmail.com",
    pass: process.env.MAIL_PASS,
  },
});

/* =====================================
   SEND OTP EMAIL
===================================== */
async function sendOtpEmail(email, otp) {
  await transporter.sendMail({
    from: '"CareDesk 360" <info@ridgeveda.com>',
    to: email,
    subject: "Password Reset OTP",
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Password Reset OTP</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f6f8; font-family: Arial, Helvetica, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8; padding:20px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="480" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden;">
          
          <!-- Header -->
          <tr>
            <td style="background:#2563eb; color:#ffffff; padding:20px; text-align:center;">
              <h2 style="margin:0; font-size:22px;">Password Reset</h2>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:24px; color:#333333;">
              <p style="margin-top:0; font-size:15px;">
                Hello,
              </p>

              <p style="font-size:15px; line-height:1.6;">
                You requested to reset your password. Use the OTP below to proceed:
              </p>

              <!-- OTP Box -->
              <div style="text-align:center; margin:24px 0;">
                <span style="
                  display:inline-block;
                  background:#f1f5f9;
                  color:#111827;
                  font-size:28px;
                  font-weight:bold;
                  letter-spacing:6px;
                  padding:12px 24px;
                  border-radius:6px;
                ">
                  ${otp}
                </span>
              </div>

              <p style="font-size:14px; color:#555555;">
                This OTP is valid for <strong>${OTP_EXPIRY_MIN} minutes</strong>.
              </p>

              <p style="font-size:14px; color:#555555;">
                If you did not request a password reset, please ignore this email.
              </p>

              <p style="margin-bottom:0; font-size:14px;">
                Thanks,<br />
                <strong>CareDesk 360 Support Team</strong>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc; padding:16px; text-align:center; font-size:12px; color:#777777;">
              © ${new Date().getFullYear()} CareDesk 360. All rights reserved.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
  });
}

/* =====================================
   FIND USER BY EMAIL
===================================== */
async function findUserByEmail(email) {
  let rows;

  // ADMIN
  [rows] = await db.execute("SELECT id FROM admins WHERE email = ?", [email]);
  if (rows.length) return { id: rows[0].id, role: "admin" };

  // DOCTOR / RECEPTIONIST (staff table)
  [rows] = await db.execute(
    "SELECT id, role FROM staff WHERE email = ? AND role IN ('doctor','receptionist')",
    [email]
  );
  if (rows.length) return { id: rows[0].id, role: rows[0].role };

  // CLIENT
  [rows] = await db.execute("SELECT id FROM clients WHERE email = ?", [email]);
  if (rows.length) return { id: rows[0].id, role: "client" };

  return null;
}

/* =====================================
   1️⃣ SEND / RESEND OTP
===================================== */
router.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "email required" });
    }

    // Delete expired OTPs
    await db.execute("DELETE FROM forgot_password WHERE otp_expiry <= NOW()");

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: "Email not found" });
    }

    const otp = generateOTP();
    const expiry = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000);

    // Insert or Update (same row)
    await db.execute(
      `
      INSERT INTO forgot_password (user_id, role, otp, otp_expiry)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        otp = VALUES(otp),
        otp_expiry = VALUES(otp_expiry)
      `,
      [user.id, user.role, otp, expiry]
    );

    await sendOtpEmail(email, otp);

    res.json({
      message: "OTP sent successfully ✅",
      user_id: user.id,
      role: user.role,
      expires_in_minutes: OTP_EXPIRY_MIN,
    });
  } catch (err) {
    console.error("FORGOT PASSWORD ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =====================================
   2️⃣ VERIFY OTP
===================================== */
router.post("/auth/verify-otp", async (req, res) => {
  try {
    const { user_id, role, otp } = req.body;

    if (!user_id || !role || !otp) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const [rows] = await db.execute(
      `
      SELECT * FROM forgot_password
      WHERE user_id = ?
      AND role = ?
      AND otp = ?
      AND otp_expiry > NOW()
      `,
      [user_id, role, otp]
    );

    if (!rows.length) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    res.json({ message: "OTP verified ✅" });
  } catch (err) {
    console.error("VERIFY OTP ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* =====================================
   3️⃣ RESET PASSWORD
===================================== */
router.post("/auth/reset-password", async (req, res) => {
  try {
    const { email, otp, password } = req.body;

    if (!email || !otp || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const [rows] = await db.execute(
      `
      SELECT * FROM forgot_password
      WHERE user_id = ?
      AND role = ?
      AND otp = ?
      AND otp_expiry > NOW()
      `,
      [user.id, user.role, otp]
    );

    if (!rows.length) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // UPDATE PASSWORD BASED ON ROLE
    if (user.role === "admin") {
      await db.execute("UPDATE admins SET password = ? WHERE id = ?", [
        hashedPassword,
        user.id,
      ]);
    }

    if (user.role === "doctor" || user.role === "receptionist") {
      await db.execute("UPDATE staff SET password = ? WHERE id = ?", [
        hashedPassword,
        user.id,
      ]);
    }

    if (user.role === "client") {
      await db.execute("UPDATE clients SET password = ? WHERE id = ?", [
        hashedPassword,
        user.id,
      ]);
    }

    // DELETE OTP AFTER RESET
    await db.execute(
      "DELETE FROM forgot_password WHERE user_id = ? AND role = ?",
      [user.id, user.role]
    );

    res.json({ message: "Password reset successful 🔒" });
  } catch (err) {
    console.error("RESET PASSWORD ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
