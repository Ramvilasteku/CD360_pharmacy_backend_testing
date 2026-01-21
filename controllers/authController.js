const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const db = require("../db");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: "caredesk360@gmail.com",
    pass: process.env.MAIL_PASS,
  },
});

/* ===================== LOGIN (SEND OTP) ===================== */
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: "Email & password required" });

    let user = null;
    let role = null;

    // ADMIN
    const [admins] = await db.query(
      "SELECT * FROM admins WHERE email = ? LIMIT 1",
      [email]
    );
    if (admins.length) {
      user = admins[0];
      role = "admin";
      if (user.status !== 1)
        return res.status(403).json({ message: "Admin inactive" });
    }

    // STAFF
    if (!user) {
      const [staff] = await db.query(
        "SELECT * FROM staff WHERE email = ? LIMIT 1",
        [email]
      );
      if (staff.length) {
        user = staff[0];
        role = user.role; // doctor | receptionist
        if (user.status !== 1)
          return res.status(403).json({ message: "Staff inactive" });
      }
    }

    // CLIENT
    if (!user) {
      const [clients] = await db.query(
        "SELECT * FROM clients WHERE email = ? LIMIT 1",
        [email]
      );
      if (clients.length) {
        user = clients[0];
        role = "client";
        if (user.status !== 1)
          return res.status(403).json({ message: "Client inactive" });
      }
    }

    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    // 🔐 GENERATE OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);

    await db.query(
      `INSERT INTO login_otp (user_id, role, otp, otp_expiry)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       otp = VALUES(otp),
       otp_expiry = VALUES(otp_expiry),
       created_at = CURRENT_TIMESTAMP`,
      [user.id, role, otp, expiry]
    );

    // 📧 SEND OTP (THIS IS WHERE OTP IS USED FOR SENDING)
    await transporter.sendMail({
      from: `"Caredesk360" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Your One-Time Password (OTP) for Login",
      html: `
        <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f5f7fa; padding: 24px;">
          <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; padding: 24px; border-radius: 6px; box-shadow: 0 2px 6px #1a73e86f;">

            <h2 style="color: #2c3e50; margin-top: 0;">Login Verification (OTP)</h2>

     <p style="color: #555; font-size: 14px; line-height: 1.6;">
      This verification code is required to confirm your identity and securely access hospital services.
    </p>

            <div style="text-align: center; margin: 24px 0;">
              <span style="display: inline-block; font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #1a73e8;">
                ${otp}
              </span>
            </div>

            <p style="color: #555; font-size: 14px; line-height: 1.6;">
              This OTP is valid for <strong>10 minutes</strong>. For security reasons, do not share this code with anyone.
            </p>

            <p style="color: #555; font-size: 14px; line-height: 1.6;">
              If you did not attempt to log in, you can safely ignore this email.
            </p>

            <p style="margin-top: 32px; font-size: 13px; color: #777;">
              Regards,<br />
              <strong>Caredesk360</strong>
            </p>
          </div>

          <p style="text-align: center; margin-top: 12px; font-size: 12px; color: #999;">
            This is an automated message. Please do not reply.
          </p>
        </div>
      `,
    });

    // 🔑 JWT (OTP NOT VERIFIED YET)
    const payload = {
      id: user.id,
      role,
      name: user.name,
      otpVerified: false,
    };
    if (role !== "admin") payload.adminId = user.admin_id;

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.json({ message: "OTP sent to your email" });
  } catch (err) {
    console.error("Login Error:", err);
    return res.status(500).json({ message: "Login failed" });
  }
};

/* ===================== VERIFY OTP ===================== */
exports.verifyOtp = async (req, res) => {
  try {
    const { otp } = req.body;
    const { id, role, name, adminId } = req.user;

    if (!otp) return res.status(400).json({ message: "OTP required" });
    if (!req.user?.otpVerified) {
      return res.status(403).json({
        message: "OTP verification required",
      });
    }

    const [rows] = await db.query(
      `SELECT * FROM login_otp
       WHERE user_id = ?
       AND role = ?
       AND otp = ?
       AND otp_expiry > NOW()`,
      [id, role, otp]
    );

    if (!rows.length)
      return res.status(400).json({ message: "Invalid or expired OTP" });

    await db.query("DELETE FROM login_otp WHERE user_id = ? AND role = ?", [
      id,
      role,
    ]);

    // 🔑 FINAL JWT (OTP VERIFIED)
    const payload = {
      id,
      role,
      name,
      otpVerified: true,
    };
    if (role !== "admin") payload.adminId = adminId;

    const newToken = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    res.cookie("token", newToken, {
      httpOnly: true,
      secure: true,          // REQUIRED on HTTPS
      sameSite: "None",      // 🔑 CRITICAL
      maxAge: 24 * 60 * 60 * 1000,
    });


    return res.json({
      message: "OTP verified successfully",
      user: {
        id,
        name,
        role,
        adminId: role !== "admin" ? adminId : null,
      },
    });
  } catch (err) {
    console.error("OTP Verify Error:", err);
    return res.status(500).json({ message: "OTP verification failed" });
  }
};

/* ===================== LOGOUT ===================== */
exports.logout = (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
  });

  return res.json({ message: "Logged out successfully" });
};
