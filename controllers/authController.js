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
 
/* ═══════════════════════════════════════════════════════════════
   HELPER: buildUserAccess
   Reads user_role_assignments + roles + role_modules + role_features + role_permissions
   Falls back gracefully if RBAC tables don't have data yet (legacy users)
   ═══════════════════════════════════════════════════════════════ */
async function buildUserAccess(userId, userType, adminId, legacyRole) {
  const access = {
    primaryRole: legacyRole,
    activeRole: legacyRole,
    roles: [],
    roleIds: [],
    modules: [],
    features: [],
    permissions: [],
    adminModules: [],
  };
 
  try {
    // ─── STEP 1: Get all active role assignments for this user ───
    const [assignments] = await db.query(
      `SELECT
         ura.role_id,
         ura.is_primary,
         r.role_key,
         r.role_name
       FROM user_role_assignments ura
       JOIN roles r ON r.id = ura.role_id
       WHERE ura.user_id = ?
         AND ura.user_type = ?
         AND ura.status = 1
         AND r.status = 1 and r.admin_id = ?
       ORDER BY ura.is_primary DESC, ura.created_at ASC`,
      [userId, userType,adminId]
    );
 
    // ─── STEP 2: Populate roles data ───
    if (assignments.length > 0) {
      access.roles = assignments.map((a) => ({
        role_id: a.role_id,
        role_key: a.role_key,
        role_name: a.role_name,
        is_primary: a.is_primary === 1,
      }));
      access.roleIds = assignments.map((a) => a.role_id);
 
      const primary = assignments.find((a) => a.is_primary === 1) || assignments[0];
      access.primaryRole = primary.role_key;

      // Fixed 25 Oct 2026. This line used to be:
      //
      //     access.activeRole = primary.role_key;
      //
      // which threw away the `legacyRole` argument — the role the caller is asking about.
      // switchRole() passes the role being switched TO, and getMyAccess() passes the role
      // already active, and both were silently overwritten with the primary role. Because
      // STEP 4 (modules) and STEPs 5–6 (features, permissions) all read access.activeRole,
      // a role switch changed the label in the UI and nothing else: the user kept their
      // primary role's modules, features and permissions.
      //
      // Now the requested role wins when the user actually holds an active assignment for
      // it, and the primary role is the fallback. A user with one role is unaffected — the
      // requested role IS the primary — so this cannot change behaviour for anyone who has
      // never been given a second role.
      const requested = legacyRole
        ? assignments.find((a) => a.role_key === legacyRole)
        : null;
      access.activeRole = requested ? requested.role_key : primary.role_key;
    } else {
      // ─── FALLBACK: No RBAC assignment exists for this user ───
      // Look up role_id from the roles table using the legacy role name
      let fallbackRoleId = null;
 
      if (userType !== "admin" && legacyRole && adminId) {
        const [roleRows] = await db.query(
          `SELECT id, role_key, role_name
           FROM roles
           WHERE role_key = ?
             AND admin_id = ?
             AND status = 1
           LIMIT 1`,
          [legacyRole, adminId]
        );
 
        if (roleRows.length > 0) {
          fallbackRoleId = roleRows[0].id;
          // console.log(
          //   `[buildUserAccess] Fallback: resolved role_id=${fallbackRoleId} for role_name="${legacyRole}", admin_id=${adminId}`
          // );
        } else {
          console.warn(
            `[buildUserAccess] WARNING: no row in roles table for role_name="${legacyRole}", admin_id=${adminId}. Features/permissions will be empty.`
          );
        }
      }
 
      access.roles = [
        {
          role_id: fallbackRoleId,       // real id from roles table, not null
          role_key: legacyRole,
          role_name: legacyRole,
          is_primary: true,
        },
      ];
      access.roleIds = fallbackRoleId ? [fallbackRoleId] : [];
    }
 
    // ─── STEP 3: Get admin_modules (tenant licensing gate) ───
    const tenantAdminId = userType === "admin" ? userId : adminId;
 
    const [adminModuleRows] = await db.query(
      `SELECT module_keys FROM admin_modules WHERE admin_id = ? AND status = 1`,
      [tenantAdminId]
    );
 
    if (adminModuleRows.length > 0) {
      const data = adminModuleRows[0].module_keys;
      access.adminModules = Array.isArray(data) ? data : JSON.parse(data);
    }
 
    // ─── STEP 4: Get modules for the ACTIVE role ───
    if (userType === "admin") {
      // Admins get all licensed modules directly
      access.modules = access.adminModules;
    } else {
      const [roleModuleRows] = await db.query(
        `SELECT module_keys FROM role_modules
         WHERE admin_id = ? AND role = ? AND status = 1`,
        [adminId, access.activeRole]
      );
 
      if (roleModuleRows.length > 0) {
        const data = roleModuleRows[0].module_keys;
        const roleModules = Array.isArray(data) ? data : JSON.parse(data);
 
        // Intersect with admin_modules (tenant must have licensed the module)
        access.modules = roleModules.filter((m) => access.adminModules.includes(m));
      }
    }
 
    // ─── STEP 5: Get features for active role (from role_features) ───
    //
    // Fixed 25 Oct 2026. This block and STEP 6 below used to read the PRIMARY role:
    //
    //     const primaryRoleObj = access.roles.find((r) => r.is_primary) || access.roles[0];
    //
    // which quietly broke two things that are supposed to work:
    //
    //   • Role switching. switchRole() calls buildUserAccess(..., newRole), and STEP 4 above
    //     already honours access.activeRole for modules — but features and permissions kept
    //     coming from the primary role. So a staff member who switched to their pharmacist
    //     role got the pharmacist's MODULES with their primary role's PERMISSIONS. On the
    //     pharmacy screens that reads as "the page is in the menu but every button is gone".
    //   • Secondary roles. A staff member is meant to hold one primary plus secondaries
    //     (user_role_assignments); only the primary ever granted anything.
    //
    // Now it resolves the role actually in play, falling back to the primary and then to the
    // first assignment, so a user with a single role behaves exactly as before.
    const activeRoleObj =
      access.roles.find((r) => r.role_key === access.activeRole) ||
      access.roles.find((r) => r.is_primary) ||
      access.roles[0];
    const primaryRoleId = activeRoleObj?.role_id;
 
    // console.log(`[buildUserAccess] primaryRoleId=${primaryRoleId}, userType=${userType}, legacyRole=${legacyRole}`);
 
    if (primaryRoleId) {
      const [featureRows] = await db.query(
        `SELECT f.feature_key
         FROM role_features rf
         JOIN features f ON f.id = rf.feature_id
         WHERE rf.role_id = ?
           AND rf.status = 1
           AND f.is_active = 1  AND rf.admin_id = ?`,
        [primaryRoleId,adminId]
      );
      access.features = featureRows.map((r) => r.feature_key);
 
      // ─── STEP 6: Get permissions for active role ───
      const [permRows] = await db.query(
        `SELECT p.permission_key
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ?
           AND rp.status = 1
           AND p.is_active = 1 AND rp.admin_id = ?`,
        [primaryRoleId,adminId]
      );
      access.permissions = permRows.map((r) => r.permission_key);
 
      // console.log(
      //   `[buildUserAccess] features=${access.features.length}, permissions=${access.permissions.length}`
      // );
    }
 
    return access;
  } catch (err) {
    console.error("buildUserAccess Error:", err);
    return access;
  }
}
 
/* ═══════════════════════════════════════════════════════════════
   LOGIN (SEND OTP VIA WHATSAPP)
   ═══════════════════════════════════════════════════════════════ */
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
    let userType = null;
 
    // ADMIN
    const [admins] = await db.query(
      "SELECT * FROM admins WHERE email = ? LIMIT 1",
      [email]
    );
 
    if (admins.length) {
      user = admins[0];
      role = "admin";
      userType = "admin";
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
        userType = "staff";
        if (user.status !== 1)
          return res.status(403).json({ message: "Your account is inactive.Please Contact Admin" });
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
        userType = "client";
        if (user.status !== 1)
          return res.status(403).json({ message: "Your account is inactive. Please Contact Admin" });
      }
    }
 
    if (!user)
      return res.status(401).json({ message: "Invalid credentials" });
 
    // ✅ IMPORTANT: compare trimmed password
    const ok = await bcrypt.compare(password, user.password);
 
    if (!ok)
      return res.status(401).json({ message: "Invalid credentials" });
 
    // 📱 WhatsApp number is required to deliver the OTP
    let phone = String(user.mobile || "").replace(/\D/g, "");
 
    if (!phone) {
      return res.status(400).json({
        message: "No mobile number on this account. Please contact Admin",
      });
    }
 
    if (phone.length === 10) {
      phone = "91" + phone;
    }
 
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
 
    // 📧 EMAIL OTP (COMMENTED OUT — replaced with WhatsApp)
    // await transporter.sendMail({
    //   from: `"Caredesk360" <${process.env.EMAIL_USER}>`,
    //   to: email,
    //   subject: "Your One-Time Password (OTP) for Login",
    //   html: `
    //     <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f5f7fa; padding: 24px;">
    //       <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; padding: 24px; border-radius: 6px; box-shadow: 0 2px 6px #1a73e86f;">
    //         <h2 style="color: #2c3e50; margin-top: 0;">Login Verification (OTP)</h2>
    //         <p style="color: #555; font-size: 14px; line-height: 1.6;">
    //           This verification code is required to confirm your identity and securely access hospital services.
    //         </p>
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
 
    // 📱 SEND OTP VIA WHATSAPP
    await sendOTP(phone, otp);
 
    // 🔑 JWT (OTP NOT VERIFIED YET) — includes userType for downstream use
    const payload = {
      id: user.id,
      role,
      userType,
      name: user.name,
      branch: user.branch || null,
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
 
/* ═══════════════════════════════════════════════════════════════
   VERIFY OTP — builds full RBAC data + backward compat
   ═══════════════════════════════════════════════════════════════ */
exports.verifyOtp = async (req, res) => {
  try {
    const { otp } = req.body;
    const { id, role, userType, name, adminId } = req.user;
    let branch = req.user.branch || null;
 
    // console.log("✅ NEW verifyOtp with RBAC support");
 
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
 
    // fetch fresh branch from DB for staff
    if (role !== "admin" && role !== "client") {
      const [staffRows] = await db.query(
        `SELECT branch FROM staff WHERE id = ? LIMIT 1`,
        [id]
      );
      if (staffRows.length > 0) {
        branch = staffRows[0].branch;
      }
    }
 
    // ─── Determine userType (fallback for old JWTs) ───
    const resolvedUserType =
      userType ||
      (role === "admin" ? "admin" : role === "client" ? "client" : "staff");
 
    // ─── Build full RBAC access data ───
    const access = await buildUserAccess(
      id,
      resolvedUserType,
      role === "admin" ? id : adminId,
      role
    );
 
    // ─── Build JWT payload with BOTH legacy and new fields ───
    const payload = {
      // Legacy fields (backward compatibility with 334 allowRoles calls)
      id,
      role: access.activeRole,
      name,
      branch,
      otpVerified: true,
 
      // New RBAC fields
      userType: resolvedUserType,
      activeRole: access.activeRole,
      primaryRole: access.primaryRole,
      roles: access.roles.map((r) => r.role_key),
      roleIds: access.roleIds,
    };
 
    if (role !== "admin") payload.adminId = adminId;
 
    const newToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1d" });
 
    res.cookie("token", newToken, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 24 * 60 * 60 * 1000,
    });
 
    // ─── Fetch plan_type to match getMyAccess shape ───
    const [adminRows] = await db.query(
      `SELECT plan_type FROM admins WHERE id = ? LIMIT 1`,
      [role === "admin" ? id : adminId]
    );
    const plan_type = adminRows[0]?.plan_type || null;
 
    // ─── Return response with legacy + new fields ───
    return res.json({
      message: "OTP verified successfully",
      user: {
        id,
        name,
        userType: resolvedUserType,
        role: access.activeRole,
        activeRole: access.activeRole,
        primaryRole: access.primaryRole,
        adminId: role !== "admin" ? adminId : undefined,
        branch,
        roles: access.roles,
        plan_type,
        modules: access.modules,
        features: access.features,
        permissions: access.permissions,
        adminModules: access.adminModules,
      },
    });
  } catch (err) {
    console.error("OTP Verify Error:", err);
    return res.status(500).json({ message: "OTP verification failed" });
  }
};
 
/* ═══════════════════════════════════════════════════════════════
   SWITCH ROLE (for multi-role users)
   POST /api/switch-role
   ═══════════════════════════════════════════════════════════════ */
exports.switchRole = async (req, res) => {
  try {
    const { role: newRole } = req.body;
    // `roles` is deliberately NOT taken from req.user any more — see the DB check below.
    const { id, name, adminId, userType, branch } = req.user;
 
    if (!newRole) {
      return res.status(400).json({ message: "Role is required" });
    }
 
    // Verify the user actually holds this role — checked against the DATABASE, not the
    // token.
    //
    // Fixed 26 Oct 2026. This used to be:
    //
    //     if (!roles || !roles.includes(newRole)) return 403
    //
    // reading `roles` out of the JWT, which is written at login and then never updated:
    // res.cookie() is only called on login and on a successful switch. getMyAccess()
    // returns a FRESH role list every 60s (usePermissionPolling) but does not re-issue the
    // cookie. So the two drift apart for up to the token's 24h life, and both directions
    // were wrong:
    //
    //   • role assigned AFTER the user logged in → the switcher lists it (fresh redux) but
    //     this check refused it (stale token). That is the 403 on a role the admin can see
    //     assigned in user_role_assignments.
    //   • role REVOKED after login → the stale token still listed it, so the user could
    //     keep switching into a role they no longer hold until the token expired.
    //
    // The assignment table is the authority, so ask it. Same conditions as
    // buildUserAccess STEP 1, so a role that cannot be switched to cannot be built either.
    if (userType === "admin") {
      // An admin has no user_role_assignments row (STEP 1 finds none and the role_id
      // fallback is staff-only), so there is nothing to look up and nothing to switch to.
      if (newRole !== req.user.role) {
        return res.status(403).json({ message: "You don't have access to this role" });
      }
    } else {
      const [heldRows] = await db.query(
        `SELECT 1
           FROM user_role_assignments ura
           JOIN roles r ON r.id = ura.role_id
          WHERE ura.user_id   = ?
            AND ura.user_type = ?
            AND ura.status    = 1
            AND r.role_key    = ?
            AND r.status      = 1
            AND r.admin_id    = ?
          LIMIT 1`,
        [id, userType, newRole, adminId]
      );

      if (heldRows.length === 0) {
        return res.status(403).json({ message: "You don't have access to this role" });
      }
    }
 
    // Build access for the switched-to role
    const access = await buildUserAccess(
      id,
      userType,
      userType === "admin" ? id : adminId,
      newRole
    );
 
    // Override activeRole to the switched-to role
    access.activeRole = newRole;
 
    // Re-fetch modules/features/permissions for the NEW active role
    if (userType !== "admin") {
      const [rows] = await db.query(
        `SELECT module_keys FROM role_modules
         WHERE admin_id = ? AND role = ? AND status = 1`,
        [adminId, newRole]
      );
      if (rows.length > 0) {
        const data = rows[0].module_keys;
        const roleModules = Array.isArray(data) ? data : JSON.parse(data);
        access.modules = roleModules.filter((m) => access.adminModules.includes(m));
      } else {
        access.modules = [];
      }
 
      // Fetch features and permissions for THIS role (not the primary)
      const roleObj = access.roles.find((r) => r.role_key === newRole);
      if (roleObj && roleObj.role_id) {
        const [featureRows] = await db.query(
          `SELECT f.feature_key
           FROM role_features rf
           JOIN features f ON f.id = rf.feature_id
           WHERE rf.role_id = ? AND rf.admin_id = ? AND rf.status = 1 AND f.is_active = 1 `,
          // 26 Oct 2026 — was [roleObj.role_id]: two ? placeholders, one value. mysql2
          // leaves the second ? in the SQL, MySQL answers ER_PARSE_ERROR "near '?'", the
          // catch below turns it into 500 "Failed to switch role", and switching a role
          // NEVER worked. buildUserAccess STEPs 5-6 pass both values; this copy did not.
          [roleObj.role_id, adminId]
        );
        access.features = featureRows.map((r) => r.feature_key);
 
        const [permRows] = await db.query(
          `SELECT p.permission_key
           FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = ? AND rp.admin_id = ? AND rp.status = 1 AND p.is_active = 1`,
          // same missing admin_id value as the features query above
          [roleObj.role_id, adminId]
        );
        access.permissions = permRows.map((r) => r.permission_key);
      }
    }
 
    // Re-sign JWT with new active role
    const payload = {
      id,
      role: newRole,
      name,
      branch,
      otpVerified: true,
      userType,
      activeRole: newRole,
      primaryRole: access.primaryRole,
      roles: access.roles.map((r) => r.role_key),
      roleIds: access.roleIds,
    };
 
    if (userType !== "admin") payload.adminId = adminId;
 
    const newToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1d" });
 
    res.cookie("token", newToken, {
      httpOnly: true,
      secure: true,
      sameSite: "None",
      maxAge: 24 * 60 * 60 * 1000,
    });
 
    return res.json({
      message: "Role switched successfully",
      user: {
        id,
        name,
        role: newRole,
        activeRole: newRole,
        adminId: userType !== "admin" ? adminId : undefined,
        branch,
        modules: access.modules,
        features: access.features,
        permissions: access.permissions,
        roles: access.roles,
        adminModules: access.adminModules,
      },
    });
  } catch (err) {
    console.error("Switch Role Error:", err);
    return res.status(500).json({ message: "Failed to switch role" });
  }
};
 
/* ═══════════════════════════════════════════════════════════════
   GET CURRENT USER ACCESS (for hybrid frontend refresh)
   GET /api/me/access
   ═══════════════════════════════════════════════════════════════ */
exports.getMyAccess = async (req, res) => {
  try {
    const { id, role, activeRole, userType, adminId, name } = req.user;
 
    const resolvedUserType =
      userType ||
      (role === "admin" ? "admin" : role === "client" ? "client" : "staff");
 
    // ─── Build RBAC access using shared helper ───
    const access = await buildUserAccess(
      id,
      resolvedUserType,
      role === "admin" ? id : adminId,
      activeRole || role
    );
 
    // ─── Fetch branch (only for staff — admin/client don't have one) ───
    let branch = null;
    if (resolvedUserType === "staff") {
      const [staffRows] = await db.query(
        `SELECT branch FROM staff WHERE id = ? LIMIT 1`,
        [id]
      );
      branch = staffRows[0]?.branch || null;
    }
 
    // Admins have no role row: grant every active feature under licensed modules
   // Admin bypass — same as getMyAccess
if (resolvedUserType === "admin" && access.adminModules.length) {
  const [adminFeatureRows] = await db.query(
    `SELECT feature_key FROM features
     WHERE module_key IN (?) AND is_active = 1`,
    [access.adminModules]
  );
  access.features = adminFeatureRows.map(r => r.feature_key);

  const [adminPermRows] = await db.query(
    `SELECT permission_key FROM permissions
     WHERE module_key IN (?) AND is_active = 1`,
    [access.adminModules]
  );
  access.permissions = adminPermRows.map(r => r.permission_key);
}
    // ─── Fetch plan_type for the tenant ───
    const tenantAdminId = resolvedUserType === "admin" ? id : adminId;
    const [adminRows] = await db.query(
      `SELECT plan_type FROM admins WHERE id = ? LIMIT 1`,
      [tenantAdminId]
    );
    const plan_type = adminRows[0]?.plan_type || null;
 
    // ─── Return in same shape as verifyOtp ───
    return res.json({
      user: {
        id,
        name,
        userType: resolvedUserType,
        role: access.activeRole,
        activeRole: access.activeRole,
        primaryRole: access.primaryRole,
        adminId: resolvedUserType !== "admin" ? adminId : undefined,
        branch,
        roles: access.roles,
        plan_type,
        modules: access.modules,
        features: access.features,
        permissions: access.permissions,
        adminModules: access.adminModules,
        // The tenant owner passes every allowPermissions() check on the server, so the
        // screens must not hide anything from them either — even a key missing from the
        // permissions table. useAccess reads is_admin: true as "show everything".
        is_admin: resolvedUserType === "admin",
      },
    });
  } catch (err) {
    console.error("Get My Access Error:", err);
    return res.status(500).json({ message: "Failed to fetch access data" });
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
//         role = user.role;
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
 
//     const payload = {
//       id: user.id,
//       role,
//       name: user.name,
//       otpVerified: true,
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
 
/* ═══════════════════════════════════════════════════════════════
   LOGIN AUTH MIDDLEWARE (lenient — allows pre-OTP requests)
   Used for verify-otp endpoint only
   ═══════════════════════════════════════════════════════════════ */
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
 
/* ═══════════════════════════════════════════════════════════════
   LOGOUT
   ═══════════════════════════════════════════════════════════════ */
exports.logout = (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
  });
 
  return res.json({ message: "Logged out successfully" });
};
 
/* ═══════════════════════════════════════════════════════════════
   GET ALL MODULES
   GET /api/all-modules
   ═══════════════════════════════════════════════════════════════ */
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
 
/* ═══════════════════════════════════════════════════════════════
   GET MODULES (for logged-in admin's tenant)
   GET /api/modules
   ═══════════════════════════════════════════════════════════════ */
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
 
/* ═══════════════════════════════════════════════════════════════
   GET ROLE MODULES
   GET /api/role-modules/:role
   ═══════════════════════════════════════════════════════════════ */
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
 
    if(rows.length > 0){
      const data = rows[0].module_keys;
 
      modules =
        typeof data === "string"
        ? JSON.parse(data)
        : data;
    }
 
    return res.json({
      modules
    });
 
  } catch(err){
    console.error(
      "getRoleModules Error:",
      err
    );
 
    return res.status(500).json({
      message:"Error fetching role modules",
      error:err.message
    });
  }
};
 
/* ═══════════════════════════════════════════════════════════════
   SAVE ROLE MODULES
   POST /api/role-modules
   ═══════════════════════════════════════════════════════════════ */
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
 
/* ═══════════════════════════════════════════════════════════════
   UPDATE ROLE MODULES
   PUT /api/role-modules/:role
   ═══════════════════════════════════════════════════════════════ */
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
 
/* ═══════════════════════════════════════════════════════════════
   DELETE ROLE MODULES
   DELETE /api/role-modules/:role
   ═══════════════════════════════════════════════════════════════ */
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