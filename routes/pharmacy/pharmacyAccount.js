// routes/Pharmacy/pharmacyAccount.js
//
// The signed-in pharmacy staff member's own things — what the pharmacy shell (sidebar, top bar,
// My profile, Attendance, role switch) needs. Works for ANY role (pharmacist, chemist, cashier,
// a role made later): every endpoint reads only the caller's own rows, using the id and admin id
// from their login (req.user), never from the request.
//
// Mount in server.js (one line):
//   app.use("/api/pharmacy/account", require("./routes/Pharmacy/pharmacyAccount.js"));
//
//   GET  /get/company              { company_name, company_logo }
//   GET  /get/profile              the staff member's own record (no password)
//   PUT  /update/profile           name, email, mobile, qualification, address
//   PUT  /update/password          { current_password, new_password }
//   POST /update/photo             multipart "photo" (PNG / JPG, up to 2 MB)
//   DELETE /delete/photo           back to the initial
//   GET  /get/attendance/today     today's row (IST) or null
//   GET  /getall/attendance        ?month=YYYY-MM  → the month's rows + totals
//   POST /post/clock-in            today's clock-in (IST)
//   POST /post/clock-out           today's clock-out, hours and status (IST)
//   POST /switch-role              hands over to authController.switchRole
//
// Why its own routes: the existing staff routes (/api/staff/self, /api/attendance/*,
// /api/company-info) only let doctor / receptionist in (allowRoles), so a pharmacist is refused
// there. Those files are left as they are. Attendance uses the same staff_attendance table and
// the same rules as routes/staffAttendance.js (IST dates; present ≥ 6 h, half day ≥ 4 h), so the
// admin's attendance screens see these rows like any other.

const express = require("express");
const router = express.Router();
const db = require("../../db");
const { authMiddleware } = require("../../middlewares/authMiddleware");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const bcrypt = require("bcryptjs"); // the same library the login checks passwords with
const authController = require("../../controllers/authController");

const FILE_VERSION = "pharmacyAccount v1.3 (2026-10-23)";
console.log(`[pharmacy] ${FILE_VERSION} loaded`);

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */
const isAdmin = (req) => req.user?.userType === "admin" || req.user?.role === "admin";

/* The admin this user works for (an admin is their own). */
const getTenantAdminId = (req) => (isAdmin(req) ? req.user.id : req.user.adminId);

/* Attendance and profile belong to staff; an admin login has neither here. */
const staffOnly = (req, res, next) => {
  if (isAdmin(req)) return res.status(403).json({ success: false, message: "This is for staff logins" });
  if (!req.user?.id) return res.status(401).json({ success: false, message: "Sign in again" });
  return next();
};

/* India time, the way staffAttendance.js stamps it. */
const istDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
const istTime = (d = new Date()) => d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }); // HH:mm:ss

/* present ≥ 6 h, half day ≥ 4 h, else absent — same as staffAttendance.js */
const statusFor = (hours) => (hours >= 6 ? "present" : hours >= 4 ? "half_day" : "absent");

const ATT_COLS = `id, DATE_FORMAT(date, '%Y-%m-%d') AS date, clock_in, clock_out, total_hours, status`;

const fail = (res, where, err, msg) => {
  console.error(`[pharmacyAccount] ${where}:`, err);
  return res.status(500).json({ success: false, message: msg });
};

/* ------------------------------------------------------------------ */
/* Company                                                              */
/* ------------------------------------------------------------------ */
router.get("/get/company", authMiddleware, async (req, res) => {
  try {
    const adminId = getTenantAdminId(req);
    if (!adminId) return res.status(400).json({ success: false, message: "No pharmacy is linked to this login" });

    const [rows] = await db.query("SELECT company_name, company_logo FROM admins WHERE id = ? LIMIT 1", [adminId]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Pharmacy not found" });

    return res.json({
      success: true,
      data: { company_name: rows[0].company_name || null, company_logo: rows[0].company_logo || null },
    });
  } catch (err) {
    return fail(res, "get/company", err, "Couldn't load the pharmacy details");
  }
});

/* ------------------------------------------------------------------ */
/* My profile                                                           */
/* ------------------------------------------------------------------ */
const PROFILE_COLS = `id, name, email, mobile, address, role, branch, qualification,
  DATE_FORMAT(date_of_joining, '%Y-%m-%d') AS date_of_joining, profile_photo, status`;

const readProfile = async (req) => {
  const [rows] = await db.query(`SELECT ${PROFILE_COLS} FROM staff WHERE id = ? AND admin_id = ? LIMIT 1`, [
    req.user.id,
    getTenantAdminId(req),
  ]);
  return rows[0] || null;
};

router.get("/get/profile", authMiddleware, staffOnly, async (req, res) => {
  try {
    const profile = await readProfile(req);
    if (!profile) return res.status(404).json({ success: false, message: "Your staff record wasn't found" });
    return res.json({ success: true, data: profile });
  } catch (err) {
    return fail(res, "get/profile", err, "Couldn't load your profile");
  }
});

/* Everything on the profile is the staff member's to keep up to date — as on the receptionist
   profile. Email is what they sign in with, so it must stay unique across every login the
   sign-in looks at (admins, staff, clients); the login OTP goes to the mobile. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.put("/update/profile", authMiddleware, staffOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name ?? "").trim();
    const email = String(b.email ?? "").trim().toLowerCase();
    const mobile = String(b.mobile ?? "").replace(/[\s-]/g, "");
    const qualification = String(b.qualification ?? "").trim().slice(0, 150) || null;
    const address = String(b.address ?? "").trim().slice(0, 500) || null;

    if (!name) return res.status(400).json({ success: false, message: "Name can't be empty" });
    if (name.length > 100) return res.status(400).json({ success: false, message: "Name is too long" });
    if (!EMAIL_RE.test(email) || email.length > 150) return res.status(400).json({ success: false, message: "Enter a valid email" });
    if (!/^\+?\d{10,13}$/.test(mobile)) return res.status(400).json({ success: false, message: "Enter a valid mobile number (10 digits)" });

    const id = req.user.id;
    const [[a]] = await db.query("SELECT COUNT(*) AS n FROM admins WHERE LOWER(email) = ?", [email]);
    const [[st]] = await db.query("SELECT COUNT(*) AS n FROM staff WHERE LOWER(email) = ? AND id <> ?", [email, id]);
    let clientCount = 0;
    try {
      const [[c]] = await db.query("SELECT COUNT(*) AS n FROM clients WHERE LOWER(email) = ?", [email]);
      clientCount = c.n;
    } catch (_) {
      /* no clients table here — nothing to clash with */
    }
    if (a.n || st.n || clientCount) {
      return res.status(409).json({ success: false, message: "That email is already used by another login" });
    }

    const [r] = await db.query(
      "UPDATE staff SET name = ?, email = ?, mobile = ?, qualification = ?, address = ? WHERE id = ? AND admin_id = ?",
      [name, email, mobile, qualification, address, id, getTenantAdminId(req)]
    );
    if (!r.affectedRows) return res.status(404).json({ success: false, message: "Your staff record wasn't found" });

    return res.json({ success: true, message: "Profile saved", data: await readProfile(req) });
  } catch (err) {
    return fail(res, "update/profile", err, "Couldn't save your profile");
  }
});

/* Change your own password: the current one must match first. */
router.put("/update/password", authMiddleware, staffOnly, async (req, res) => {
  try {
    const current = String(req.body?.current_password ?? "");
    const next = String(req.body?.new_password ?? "");
    if (!current) return res.status(400).json({ success: false, message: "Enter your current password" });
    if (next.length < 8) return res.status(400).json({ success: false, message: "The new password needs at least 8 characters" });
    if (next.length > 72) return res.status(400).json({ success: false, message: "The new password is too long" });
    if (!/[A-Za-z]/.test(next) || !/\d/.test(next)) {
      return res.status(400).json({ success: false, message: "Use letters and at least one number in the new password" });
    }

    const [rows] = await db.query("SELECT password FROM staff WHERE id = ? AND admin_id = ? LIMIT 1", [req.user.id, getTenantAdminId(req)]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Your staff record wasn't found" });

    const ok = rows[0].password ? await bcrypt.compare(current, rows[0].password) : false;
    if (!ok) return res.status(400).json({ success: false, message: "Your current password isn't right" });
    if (await bcrypt.compare(next, rows[0].password)) {
      return res.status(400).json({ success: false, message: "The new password is the same as the current one" });
    }

    const hash = await bcrypt.hash(next, 10);
    await db.query("UPDATE staff SET password = ? WHERE id = ?", [hash, req.user.id]);
    return res.json({ success: true, message: "Password changed" });
  } catch (err) {
    return fail(res, "update/password", err, "Couldn't change your password");
  }
});

/* ------------------------------------------------------------------ */
/* Profile photo                                                        */
/* ------------------------------------------------------------------ */
// Same place and naming as the staff photo the admin uploads (routes/staffRoutes.js):
//   Images/companies/admin_<admin>/staff/staff_<id>/profile_photo/profile.<ext>
// and staff.profile_photo holds the part after "Images/", served at /Images/... by server.js.
const IMAGES_DIR = path.join(__dirname, "..", "..", "Images");
const PHOTO_MAX = 2 * 1024 * 1024;

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PHOTO_MAX, files: 1 } }).single("photo");

/* What the file really is, from its first bytes (not what the browser claims). */
const imageExt = (buf) => {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  return null;
};

const photoDir = (req) =>
  path.join(IMAGES_DIR, "companies", `admin_${getTenantAdminId(req)}`, "staff", `staff_${req.user.id}`, "profile_photo");

/* Old profile.* files go, so a PNG replacing a JPG doesn't leave the JPG behind. */
const clearPhotos = (dir) => {
  try {
    for (const f of fs.readdirSync(dir)) if (/^profile\./i.test(f)) fs.unlinkSync(path.join(dir, f));
  } catch (_) {
    /* no folder yet */
  }
};

router.post("/update/photo", authMiddleware, staffOnly, (req, res) => {
  photoUpload(req, res, async (upErr) => {
    try {
      if (upErr) {
        const msg = upErr.code === "LIMIT_FILE_SIZE" ? "The photo is over 2 MB — choose a smaller one" : "Couldn't read that file";
        return res.status(400).json({ success: false, message: msg });
      }
      if (!req.file) return res.status(400).json({ success: false, message: "Choose a photo to upload" });
      const ext = imageExt(req.file.buffer);
      if (!ext) return res.status(400).json({ success: false, message: "Use a PNG or JPG photo" });

      const dir = photoDir(req);
      fs.mkdirSync(dir, { recursive: true });
      clearPhotos(dir);
      fs.writeFileSync(path.join(dir, `profile${ext}`), req.file.buffer);

      const rel = path.relative(IMAGES_DIR, path.join(dir, `profile${ext}`)).split(path.sep).join("/");
      await db.query("UPDATE staff SET profile_photo = ? WHERE id = ? AND admin_id = ?", [rel, req.user.id, getTenantAdminId(req)]);
      return res.json({ success: true, message: "Photo updated", data: await readProfile(req) });
    } catch (err) {
      return fail(res, "update/photo", err, "Couldn't save your photo");
    }
  });
});

router.delete("/delete/photo", authMiddleware, staffOnly, async (req, res) => {
  try {
    clearPhotos(photoDir(req));
    await db.query("UPDATE staff SET profile_photo = NULL WHERE id = ? AND admin_id = ?", [req.user.id, getTenantAdminId(req)]);
    return res.json({ success: true, message: "Photo removed", data: await readProfile(req) });
  } catch (err) {
    return fail(res, "delete/photo", err, "Couldn't remove your photo");
  }
});

/* ------------------------------------------------------------------ */
/* Attendance                                                           */
/* ------------------------------------------------------------------ */
router.get("/get/attendance/today", authMiddleware, staffOnly, async (req, res) => {
  try {
    const today = istDate();
    const [rows] = await db.query(`SELECT ${ATT_COLS} FROM staff_attendance WHERE staff_id = ? AND date = ? LIMIT 1`, [
      req.user.id,
      today,
    ]);
    return res.json({ success: true, data: rows[0] || null, today, now: istTime() });
  } catch (err) {
    return fail(res, "get/attendance/today", err, "Couldn't load today's attendance");
  }
});

router.get("/getall/attendance", authMiddleware, staffOnly, async (req, res) => {
  try {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || "")) ? req.query.month : istDate().slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    const first = `${month}-01`;
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;

    const [rows] = await db.query(
      `SELECT ${ATT_COLS} FROM staff_attendance
        WHERE staff_id = ? AND date >= ? AND date < ?
        ORDER BY date DESC`,
      [req.user.id, first, next]
    );

    const totals = { days: rows.length, present: 0, half_day: 0, absent: 0, hours: 0 };
    for (const r of rows) {
      if (r.status && totals[r.status] !== undefined) totals[r.status] += 1;
      totals.hours += Number(r.total_hours) || 0;
    }
    totals.hours = Math.round(totals.hours * 100) / 100;

    return res.json({ success: true, month, today: istDate(), data: rows, totals });
  } catch (err) {
    return fail(res, "getall/attendance", err, "Couldn't load your attendance");
  }
});

router.post("/post/clock-in", authMiddleware, staffOnly, async (req, res) => {
  try {
    const now = new Date();
    const date = istDate(now);
    const time = istTime(now);

    const [exists] = await db.query("SELECT id FROM staff_attendance WHERE staff_id = ? AND date = ? LIMIT 1", [req.user.id, date]);
    if (exists.length) return res.status(409).json({ success: false, message: "You've already clocked in today" });

    await db.query("INSERT INTO staff_attendance (admin_id, staff_id, date, clock_in) VALUES (?, ?, ?, ?)", [
      getTenantAdminId(req),
      req.user.id,
      date,
      time,
    ]);
    return res.status(201).json({ success: true, message: "Clocked in", date, clock_in: time });
  } catch (err) {
    return fail(res, "post/clock-in", err, "Couldn't clock you in");
  }
});

router.post("/post/clock-out", authMiddleware, staffOnly, async (req, res) => {
  try {
    const now = new Date();
    const date = istDate(now);
    const time = istTime(now);

    const [rows] = await db.query("SELECT id, clock_in, clock_out FROM staff_attendance WHERE staff_id = ? AND date = ? LIMIT 1", [
      req.user.id,
      date,
    ]);
    if (!rows.length) return res.status(400).json({ success: false, message: "Clock in first — there's no clock-in for today" });
    if (rows[0].clock_out) return res.status(409).json({ success: false, message: "You've already clocked out today" });

    const hours = Math.max(0, +((new Date(`${date}T${time}`) - new Date(`${date}T${rows[0].clock_in}`)) / 3600000).toFixed(2));
    const status = statusFor(hours);

    await db.query("UPDATE staff_attendance SET clock_out = ?, total_hours = ?, status = ? WHERE id = ?", [time, hours, status, rows[0].id]);
    return res.json({ success: true, message: "Clocked out", clock_out: time, total_hours: hours, status });
  } catch (err) {
    return fail(res, "post/clock-out", err, "Couldn't clock you out");
  }
});

/* ------------------------------------------------------------------ */
/* Role switch                                                          */
/* ------------------------------------------------------------------ */
// The switch itself is authController.switchRole (it re-issues the login cookie for the other
// role). Reached from here because /api/switch-role isn't mounted in server.js.
router.post("/switch-role", authController.loginAuth, authController.switchRole);

module.exports = router;