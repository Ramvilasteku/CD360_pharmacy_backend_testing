const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const db = require("../db");
const { sendOTP } = require("../services/whatsappservice.js");

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
    let { email, password } = req.body;

    // ✅ TRIM INPUTS
    email = email?.trim();
    password = password?.trim();

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
        return res.status(403).json({ message: "Your account is inactive.Please Contact Admin" });
    }

    // STAFF
    if (!user) {
      const [staff] = await db.query(
        "SELECT * FROM staff WHERE email = ? LIMIT 1",
        [email]
      );

      if (staff.length) {
        user = staff[0];
        role = user.role;
        if (user.status !== 1)
          return res.status(403).json({ message: "Your account is inactive.Please Contact Admin" });
      }
    }

    // CLIENT
    if (!user) {
      const [clients] = await db.query(
        "SELECT * FROM patients WHERE email = ? LIMIT 1",
        [email]
      );

      if (clients.length) {
        user = clients[0];
        role = "client";
        if (user.status !== 1)
          return res.status(403).json({ message: "Your account is inactive. Please Register" });
      }
    }

    if (!user)
      return res.status(401).json({ message: "Invalid credentials" });

    // ✅ IMPORTANT: compare trimmed password
    const ok = await bcrypt.compare(password, user.password);

    if (!ok)
      return res.status(401).json({ message: "Invalid credentials" });

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
    // await transporter.sendMail({
    //   from: `"Caredesk360" <${process.env.EMAIL_USER}>`,
    //   to: email,
    //   subject: "Your One-Time Password (OTP) for Login",
    //   html: `
    //     <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f5f7fa; padding: 24px;">
    //       <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; padding: 24px; border-radius: 6px; box-shadow: 0 2px 6px #1a73e86f;">

    //         <h2 style="color: #2c3e50; margin-top: 0;">Login Verification (OTP)</h2>

    //  <p style="color: #555; font-size: 14px; line-height: 1.6;">
    //   This verification code is required to confirm your identity and securely access hospital services.
    // </p>

    //         <div style="text-align: center; margin: 24px 0;">
    //           <span style="display: inline-block; font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #1a73e8;">
    //             ${otp}
    //           </span>
    //         </div>

    //         <p style="color: #555; font-size: 14px; line-height: 1.6;">
    //           This OTP is valid for <strong>10 minutes</strong>. For security reasons, do not share this code with anyone.
    //         </p>

    //         <p style="color: #555; font-size: 14px; line-height: 1.6;">
    //           If you did not attempt to log in, you can safely ignore this email.
    //         </p>

    //         <p style="margin-top: 32px; font-size: 13px; color: #777;">
    //           Regards,<br />
    //           <strong>Caredesk360</strong>
    //         </p>
    //       </div>

    //       <p style="text-align: center; margin-top: 12px; font-size: 12px; color: #999;">
    //         This is an automated message. Please do not reply.
    //       </p>
    //     </div>
    //   `,
    // });

    let phone = String(user.mobile);

    if (phone.length === 10) {
      phone = "91" + phone;
    }

    await sendOTP(phone, otp);

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
      secure: true, // REQUIRED on HTTPS
      sameSite: "None",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.json({ message: "OTP sent to your whatsapp" });
  } catch (err) {
    console.error("Login Error:", err);
    return res.status(500).json({ message: "Login failed" });
  }
};

/* ===================== LOGIN (NO OTP – TESTING ONLY) ===================== */
// exports.loginWithoutOtp = async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     if (!email || !password)
//       return res.status(400).json({ message: "Email & password required" });

//     let user = null;
//     let role = null;

//     // ADMIN
//     const [admins] = await db.query(
//       "SELECT * FROM admins WHERE email = ? LIMIT 1",
//       [email]
//     );
//     if (admins.length) {
//       user = admins[0];
//       role = "admin";
//       if (user.status !== 1)
//         return res.status(403).json({ message: "Admin inactive" });
//     }

//     // STAFF
//     if (!user) {
//       const [staff] = await db.query(
//         "SELECT * FROM staff WHERE email = ? LIMIT 1",
//         [email]
//       );
//       if (staff.length) {
//         user = staff[0];
//         role = user.role; // doctor | receptionist
//         if (user.status !== 1)
//           return res.status(403).json({ message: "Staff inactive" });
//       }
//     }

//     // CLIENT
//     if (!user) {
//       const [clients] = await db.query(
//         "SELECT * FROM clients WHERE email = ? LIMIT 1",
//         [email]
//       );
//       if (clients.length) {
//         user = clients[0];
//         role = "client";
//         if (user.status !== 1)
//           return res.status(403).json({ message: "Client inactive" });
//       }
//     }

//     if (!user) return res.status(401).json({ message: "Invalid credentials" });

//     const ok = await bcrypt.compare(password, user.password);
//     if (!ok) return res.status(401).json({ message: "Invalid credentials" });

//     // 🔑 JWT (OTP SKIPPED)
//     const payload = {
//       id: user.id,
//       role,
//       name: user.name,
//       otpVerified: true, // 👈 directly verified
//     };
//     if (role !== "admin") payload.adminId = user.admin_id;

//     const token = jwt.sign(payload, process.env.JWT_SECRET, {
//       expiresIn: "1d",
//     });

//     res.cookie("token", token, {
//       httpOnly: true,
//       secure: process.env.NODE_ENV === "production",
//       sameSite: "strict",
//       maxAge: 24 * 60 * 60 * 1000,
//     });

//     return res.json({
//       message: "Login successful (OTP skipped)",
//       user: {
//         id: user.id,
//         name: user.name,
//         role,
//         adminId: role !== "admin" ? user.admin_id : null,
//       },
//     });
//   } catch (err) {
//     console.error("Login Test Error:", err);
//     return res.status(500).json({ message: "Login failed" });
//   }
// };

/* ===================== VERIFY OTP ===================== */
exports.verifyOtp = async (req, res) => {
  try {
    const { otp } = req.body;
    const { id, role, name, adminId } = req.user;
    let branch = req.user.branch || null;
    let clientId = null;        // ← single declaration, let
    console.log("✅ NEW verifyOtp running"); // ← if you don't see this, old code is running

    if (!otp) return res.status(400).json({ message: "OTP required" });

    const [otpRows] = await db.query(
      `SELECT * FROM login_otp
       WHERE user_id = ? AND role = ? AND otp = ? AND otp_expiry > NOW()`,
      [id, role, otp]
    );

    if (!otpRows.length) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    await db.query("DELETE FROM login_otp WHERE user_id = ? AND role = ?", [id, role]);

    // fetch fresh branch from DB
    if (role !== "admin" && role !== "client") {
      const [staffRows] = await db.query(
        `SELECT branch FROM staff WHERE id = ? LIMIT 1`,
        [id]
      );
      if (staffRows.length > 0) {
        branch = staffRows[0].branch;            // ← reassignment works because let
      }
    }

    if (role === "client") {
      const [clientRows] = await db.query(
        `
    SELECT 
      c.id AS client_id
    FROM patients p
    INNER JOIN clients c 
      ON p.email COLLATE utf8mb4_0900_ai_ci = c.email COLLATE utf8mb4_0900_ai_ci
    WHERE p.id = ?
    LIMIT 1
    `,
        [id]
      );

      if (clientRows.length > 0) {
        branch = clientRows[0].branch;
        clientId = clientRows[0].client_id;
      }
    }

    // 🔑 FINAL TOKEN
    const payload = {
      id: role === "client" ? clientId : id,
      role,
      name,
      branch,
      clientId,
      otpVerified: true
    };
    if (role !== "admin") payload.adminId = adminId;

    const newToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1d" });

    res.cookie("token", newToken, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 24 * 60 * 60 * 1000,
    });

    // MODULE LOGIC
    let modules = [];

    if (role === "admin") {
      const [rows] = await db.query(
        `SELECT module_keys FROM admin_modules WHERE admin_id = ? AND status = 1`,
        [id]
      );
      if (rows.length > 0) {
        const data = rows[0].module_keys;
        modules = Array.isArray(data) ? data : JSON.parse(data);
      }
    } else {
      const [rows] = await db.query(
        `SELECT module_keys FROM role_modules WHERE admin_id = ? AND role = ? AND status = 1`,
        [adminId, role]
      );
      if (rows.length > 0) {
        const data = rows[0].module_keys;
        modules = Array.isArray(data) ? data : JSON.parse(data);
      }
    }

    return res.json({
      message: "OTP verified successfully",
      user: {
        id, name, role,
        adminId: role !== "admin" ? adminId : undefined,
        branch,
        clientId,
        modules,
      },
    });

  } catch (err) {
    console.error("OTP Verify Error:", err);
    return res.status(500).json({ message: "OTP verification failed" });
  }
};


/* ===================== LOGIN AUTH MIDDLEWARE ===================== */

exports.loginAuth = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: "Authentication required" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // otpVerified may be false here
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
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



// GET /api/all-modules
exports.getAllModules = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
          id,
          module_name,
          module_key,
          status
       FROM modules
       ORDER BY id ASC`
    );

    return res.json(rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to fetch modules",
    });
  }
};


// GET /api/modules
exports.getModules = async (req, res) => {
  try {
    const { role, id, adminId } = req.user;

    // ✅ Decide admin_id
    const admin_id = role === "admin" ? id : adminId;

    const [rows] = await db.query(
      `SELECT module_keys 
       FROM admin_modules 
       WHERE admin_id = ? AND status = 1`,
      [admin_id]
    );

    if (!rows.length) {
      return res.json([]);
    }

    let moduleKeys = rows[0].module_keys;

    // ✅ Parse JSON if needed
    if (typeof moduleKeys === "string") {
      moduleKeys = JSON.parse(moduleKeys);
    }

    return res.json(moduleKeys);

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch modules" });
  }
};


// GET /api/role-modules/:role
exports.getRoleModules = async (req, res) => {

  try {

    const { role } = req.params;

    const {
      id,
      role: userRole,
      adminId
    } = req.user;


    const admin_id =
      userRole === "admin"
        ? id
        : adminId;


    const [rows] = await db.query(
      `
      SELECT module_keys
      FROM role_modules
      WHERE admin_id = ?
      AND role = ?
      AND status = 1
      `,
      [
        admin_id,
        role
      ]
    );


    let modules = [];


    if (rows.length > 0) {

      const data = rows[0].module_keys;

      modules =
        typeof data === "string"
          ? JSON.parse(data)
          : data;

    }


    return res.json({
      modules
    });


  } catch (err) {

    console.error(
      "getRoleModules Error:",
      err
    );


    return res.status(500).json({
      message: "Error fetching role modules",
      error: err.message
    });

  }

};

// POST /api/role-modules

exports.saveRoleModules = async (req, res) => {
  const { role, module_keys } = req.body;
  const { id, role: userRole, adminId } = req.user;

  try {
    const admin_id = userRole === "admin" ? id : adminId;

    await db.query(
      `INSERT INTO role_modules (admin_id, role, module_keys)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         module_keys = VALUES(module_keys),
         updated_at = CURRENT_TIMESTAMP`,
      [admin_id, role, JSON.stringify(module_keys)]
    );

    res.json({ message: "Modules saved successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to save modules" });
  }
};


// PUT /api/role-modules/:role
exports.updateRoleModules = async (req, res) => {
  const { role } = req.params;
  const { module_keys } = req.body;
  const { id, role: userRole, adminId } = req.user;

  try {
    const admin_id = userRole === "admin" ? id : adminId;

    const [result] = await db.query(
      `UPDATE role_modules
       SET module_keys = ?, updated_at = CURRENT_TIMESTAMP
       WHERE admin_id = ? AND role = ?`,
      [JSON.stringify(module_keys), admin_id, role]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Role modules not found" });
    }

    res.json({ message: "Role modules updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Update failed" });
  }
};

// DELETE /api/role-modules/:role
exports.deleteRoleModules = async (req, res) => {
  const { role } = req.params;
  const { id, role: userRole, adminId } = req.user;

  try {
    const admin_id = userRole === "admin" ? id : adminId;

    const [result] = await db.query(
      `DELETE FROM role_modules 
       WHERE admin_id = ? AND role = ?`,
      [admin_id, role]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "No data found to delete" });
    }

    res.json({ message: "Role modules deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Delete failed" });
  }
};