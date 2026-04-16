const express = require("express");
const router = express.Router();
const db = require("../db.js");
const nodemailer = require("nodemailer"); // npm i nodemailer
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* ============================================================
   Helper
============================================================ */
function getAdminIdFromUser(user) {
  return user.role === "admin" ? user.id : user.adminId;
}

/* ============================================================
   Mailer setup (configure via .env)
   MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS, MAIL_FROM
============================================================ */
const transporter = nodemailer.createTransport({
  host:   process.env.MAIL_HOST  || "smtp.gmail.com",
  port:   Number(process.env.MAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

/* ============================================================
   Helper: Build plain-text prescription email body
============================================================ */
function buildEmailHtml({ patient, doctor, diagnosis, notes, description, medicines, tests, clinic }) {
  const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });

  const medRows = (medicines || []).map((m, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${m.medicine_name}</strong></td>
      <td>${m.type || ""}</td>
      <td>${m.strength || ""}${m.unit || ""}</td>
      <td>${m.amount || ""}</td>
      <td>${m.when_to_take || ""}</td>
      <td>${m.duration ? m.duration + " days" : "—"}</td>
      <td>${m.description || "—"}</td>
    </tr>`).join("");

  const testRows = (tests || []).map((t, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${t.test_name}</strong></td>
      <td>${t.test_type || ""}</td>
      <td>${t.description || "—"}</td>
    </tr>`).join("");

  return `
  <div style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;color:#1a1a2e;">
    <div style="background:linear-gradient(135deg,#1a6b5a,#2eb89a);padding:24px 32px;border-radius:12px 12px 0 0;">
      <h1 style="color:#fff;font-size:22px;margin:0;">${clinic?.name || "HealthCare Clinic"}</h1>
      <p style="color:rgba(255,255,255,0.8);font-size:13px;margin:4px 0 0;">${clinic?.tagline || "Compassionate Care, Expert Treatment"}</p>
    </div>
    <div style="background:#fff;border:1px solid #d4ede8;padding:28px 32px;">
      <p style="font-size:12px;color:#888;text-align:right;">Date: ${today}</p>

      <table style="width:100%;background:#f0faf7;border-radius:10px;padding:14px;font-size:13px;margin-bottom:20px;">
        <tr>
          <td><strong style="color:#2eb89a;font-size:11px;text-transform:uppercase;">Patient</strong><br/>${patient?.name || "—"} (ID: ${patient?.id || "—"})</td>
          <td><strong style="color:#2eb89a;font-size:11px;text-transform:uppercase;">Doctor</strong><br/>Dr. ${doctor?.name || "—"}</td>
        </tr>
        ${diagnosis ? `<tr><td colspan="2" style="padding-top:10px;"><strong style="color:#c88a00;font-size:11px;text-transform:uppercase;">Diagnosis</strong><br/>${diagnosis}</td></tr>` : ""}
      </table>

      ${medicines?.length ? `
      <h3 style="color:#1a6b5a;border-bottom:2px solid #2eb89a;padding-bottom:6px;font-size:14px;">℞ Medicines</h3>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px;">
        <thead>
          <tr style="background:#1a6b5a;color:#fff;">
            <th style="padding:7px 8px;text-align:left;">#</th>
            <th style="padding:7px 8px;text-align:left;">Medicine</th>
            <th style="padding:7px 8px;text-align:left;">Type</th>
            <th style="padding:7px 8px;text-align:left;">Strength</th>
            <th style="padding:7px 8px;text-align:left;">Dose</th>
            <th style="padding:7px 8px;text-align:left;">When</th>
            <th style="padding:7px 8px;text-align:left;">Duration</th>
            <th style="padding:7px 8px;text-align:left;">Notes</th>
          </tr>
        </thead>
        <tbody>${medRows}</tbody>
      </table>` : ""}

      ${tests?.length ? `
      <h3 style="color:#1a6b5a;border-bottom:2px solid #2eb89a;padding-bottom:6px;font-size:14px;">🔬 Tests</h3>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px;">
        <thead>
          <tr style="background:#1a6b5a;color:#fff;">
            <th style="padding:7px 8px;text-align:left;">#</th>
            <th style="padding:7px 8px;text-align:left;">Test Name</th>
            <th style="padding:7px 8px;text-align:left;">Type</th>
            <th style="padding:7px 8px;text-align:left;">Instructions</th>
          </tr>
        </thead>
        <tbody>${testRows}</tbody>
      </table>` : ""}

      ${notes ? `<div style="background:#fffbf0;border-left:3px solid #f0b429;padding:10px 14px;border-radius:0 8px 8px 0;font-size:12.5px;margin-bottom:10px;"><strong>Notes:</strong> ${notes}</div>` : ""}
      ${description ? `<div style="background:#fffbf0;border-left:3px solid #f0b429;padding:10px 14px;border-radius:0 8px 8px 0;font-size:12.5px;"><strong>Instructions:</strong> ${description}</div>` : ""}
    </div>
    <div style="background:#f0faf7;border-radius:0 0 12px 12px;padding:14px 32px;display:flex;justify-content:space-between;align-items:center;border:1px solid #d4ede8;border-top:none;">
      <span style="font-size:15px;font-weight:700;color:#1a6b5a;">${clinic?.name || "HealthCare Clinic"}</span>
      <span style="font-size:11px;color:#999;">${clinic?.email || ""} · ${clinic?.address || ""}</span>
    </div>
  </div>`;
}

/* ============================================================
   1️⃣  CREATE PRESCRIPTION
   POST /api/prescriptions
   Body: { patient_id, doctor_id, diagnosis, notes, description, medicines_json[], tests_json[] }
============================================================ */
router.post(
  "/",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);
      const {
        patient_id,
        doctor_id,
        diagnosis,
        notes,
        description,
        medicines_json,
        tests_json,
      } = req.body;

      if (!patient_id) {
        return res.status(400).json({ success: false, message: "patient_id is required" });
      }

      const [result] = await db.execute(
        `INSERT INTO prescriptions
          (patient_id, doctor_id, admin_id, medicines_json, tests_json, notes, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          patient_id,
          doctor_id   || null,
          adminId,
          JSON.stringify(medicines_json || []),
          JSON.stringify(tests_json     || []),
          notes       || null,
          description || null,
        ]
      );

      res.status(201).json({
        success: true,
        message: "Prescription saved successfully",
        data: { id: result.insertId },
      });
    } catch (err) {
      console.error("Create prescription error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.post(
  "/fhir/medication-request",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);

      // ✅ Validate FHIR resource
      if (req.body.resourceType !== "MedicationRequest") {
        return res.status(400).json({
          resourceType: "OperationOutcome",
          issue: [{
            severity: "error",
            code: "invalid",
            diagnostics: "Expected MedicationRequest resource"
          }]
        });
      }

      const patientRef = req.body.subject?.reference;
      const doctorRef = req.body.requester?.reference;

      const patient_id = patientRef?.split("/")[1];
      const doctor_id = doctorRef?.split("/")[1];

      if (!patient_id) {
        return res.status(400).json({
          resourceType: "OperationOutcome",
          issue: [{
            severity: "error",
            code: "required",
            diagnostics: "Patient reference is required"
          }]
        });
      }

      // 🧠 Extract medicines
      const medicines = req.body.contained || [];

      // 🧠 Extract notes
      const notes = req.body.note?.map(n => n.text).join(", ");

      // 🧠 Extract diagnosis
      const diagnosis = req.body.reasonCode?.[0]?.text || null;

      // 🧠 Extract tests (optional)
      const tests = req.body.supportingInfo || [];

      const [result] = await db.execute(
        `INSERT INTO prescriptions
          (patient_id, doctor_id, admin_id, medicines_json, tests_json, notes, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          patient_id,
          doctor_id || null,
          adminId,
          JSON.stringify(medicines),
          JSON.stringify(tests),
          notes || null,
          diagnosis || null,
        ]
      );

      const prescriptionId = result.insertId;

      // ✅ FHIR Headers
      res.setHeader("Content-Type", "application/fhir+json");
      res.setHeader("Location", `/fhir/MedicationRequest/${prescriptionId}`);

      // ✅ FHIR Response
      res.status(201).json({
        resourceType: "MedicationRequest",
        id: String(prescriptionId),
        status: "active",
        intent: "order",
        subject: {
          reference: `Patient/${patient_id}`
        },
        requester: doctor_id
          ? { reference: `Practitioner/${doctor_id}` }
          : undefined,
        authoredOn: new Date().toISOString(),
        reasonCode: diagnosis
          ? [{ text: diagnosis }]
          : [],
        note: notes
          ? [{ text: notes }]
          : []
      });

    } catch (err) {
      console.error("FHIR Prescription error:", err);

      res.status(500).json({
        resourceType: "OperationOutcome",
        issue: [{
          severity: "error",
          code: "exception",
          diagnostics: "Server error"
        }]
      });
    }
  }
);

/* ============================================================
   2️⃣  GET ALL PRESCRIPTIONS
   GET /api/prescriptions
============================================================ */
router.get(
  "/fhir/get",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);

      const [rows] = await db.execute(
        `SELECT p.*,
                pt.name     AS patient_name,
                pt.email    AS patient_email,
                s.full_name AS doctor_name
         FROM prescriptions p
         LEFT JOIN patients pt ON pt.id = p.patient_id
         LEFT JOIN staff s ON s.id = p.doctor_id
         WHERE p.admin_id = ?
         ORDER BY p.created_at DESC`,
        [adminId]
      );

      // 🔄 Convert DB → FHIR Bundle
      const entries = rows.map((r) => {
        let medicines = [];
        let tests = [];

        try {
          medicines = JSON.parse(r.medicines_json || "[]");
          tests = JSON.parse(r.tests_json || "[]");
        } catch (e) {}

        return {
          resource: {
            resourceType: "MedicationRequest",
            id: String(r.id),
            status: "active",
            intent: "order",
            subject: {
              reference: `Patient/${r.patient_id}`,
              display: r.patient_name
            },
            requester: r.doctor_id
              ? {
                  reference: `Practitioner/${r.doctor_id}`,
                  display: r.doctor_name
                }
              : undefined,
            authoredOn: r.created_at || new Date().toISOString(),

            // 🧠 Diagnosis
            reasonCode: r.description
              ? [{ text: r.description }]
              : [],

            // 🧠 Notes
            note: r.notes
              ? [{ text: r.notes }]
              : [],

            // 💊 Medicines
            contained: medicines.map((m, index) => ({
              resourceType: "Medication",
              id: `med-${index + 1}`,
              code: {
                text: m.name || JSON.stringify(m)
              }
            })),

            // 🧪 Tests (optional)
            supportingInfo: tests.map((t) => ({
              display: t.name || JSON.stringify(t)
            }))
          }
        };
      });

      // ✅ FHIR Bundle response
      const bundle = {
        resourceType: "Bundle",
        type: "searchset",
        total: entries.length,
        entry: entries
      };

      res.setHeader("Content-Type", "application/fhir+json");

      res.status(200).json(bundle);

    } catch (err) {
      console.error("FHIR get prescriptions error:", err);

      res.status(500).json({
        resourceType: "OperationOutcome",
        issue: [
          {
            severity: "error",
            code: "exception",
            diagnostics: "Server error"
          }
        ]
      });
    }
  }
);

router.get(
  "/",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);
      const [rows] = await db.execute(
        `SELECT p.*,
                pt.name         AS patient_name,
                pt.email        AS patient_email,
                s.full_name     AS doctor_name
         FROM prescriptions p
         LEFT JOIN patients pt ON pt.id = p.patient_id
         LEFT JOIN staff    s  ON s.id  = p.doctor_id
         WHERE p.admin_id = ?
         ORDER BY p.created_at DESC`,
        [adminId]
      );
      res.json({ success: true, data: rows });
    } catch (err) {
      console.error("Get prescriptions error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);



/* ============================================================
   3️⃣  GET SINGLE PRESCRIPTION
   GET /api/prescriptions/:id
============================================================ */
router.get(
  "/:id",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);
      const [rows] = await db.execute(
        `SELECT p.*,
                pt.name         AS patient_name,
                pt.email        AS patient_email,
                s.full_name     AS doctor_name
         FROM prescriptions p
         LEFT JOIN patients pt ON pt.id = p.patient_id
         LEFT JOIN staff    s  ON s.id  = p.doctor_id
         WHERE p.id = ? AND p.admin_id = ?`,
        [req.params.id, adminId]
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, message: "Prescription not found" });
      }
      res.json({ success: true, data: rows[0] });
    } catch (err) {
      console.error("Get prescription error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/* ============================================================
   4️⃣  UPDATE PRESCRIPTION
   PUT /api/prescriptions/:id
============================================================ */
router.put(
  "/:id",
  authMiddleware,
  allowRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);
      const {
        patient_id, doctor_id, diagnosis,
        notes, description, medicines_json, tests_json,
      } = req.body;

      const [existing] = await db.execute(
        "SELECT id FROM prescriptions WHERE id = ? AND admin_id = ?",
        [req.params.id, adminId]
      );
      if (!existing.length) {
        return res.status(404).json({ success: false, message: "Prescription not found" });
      }

      await db.execute(
        `UPDATE prescriptions
         SET patient_id=?, doctor_id=?, notes=?, description=?,
             medicines_json=?, tests_json=?
         WHERE id=? AND admin_id=?`,
        [
          patient_id,
          doctor_id   || null,
          notes       || null,
          description || null,
          JSON.stringify(medicines_json || []),
          JSON.stringify(tests_json     || []),
          req.params.id,
          adminId,
        ]
      );
      res.json({ success: true, message: "Prescription updated successfully" });
    } catch (err) {
      console.error("Update prescription error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/* ============================================================
   5️⃣  DELETE PRESCRIPTION
   DELETE /api/prescriptions/:id
============================================================ */
router.delete(
  "/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);
      const [result] = await db.execute(
        "DELETE FROM prescriptions WHERE id = ? AND admin_id = ?",
        [req.params.id, adminId]
      );
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, message: "Prescription not found" });
      }
      res.json({ success: true, message: "Prescription deleted successfully" });
    } catch (err) {
      console.error("Delete prescription error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/* ============================================================
   6️⃣  SEND PRESCRIPTION TO PATIENT EMAIL
   POST /api/prescriptions/:id/send-mail
============================================================ */
router.post(
  "/:id/send-mail",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);

      /* Fetch prescription + patient + doctor details */
      const [rows] = await db.execute(
        `SELECT p.*,
                pt.name       AS patient_name,
                pt.email      AS patient_email,
                s.full_name   AS doctor_name
         FROM prescriptions p
         LEFT JOIN patients pt ON pt.id = p.patient_id
         LEFT JOIN staff    s  ON s.id  = p.doctor_id
         WHERE p.id = ? AND p.admin_id = ?`,
        [req.params.id, adminId]
      );

      if (!rows.length) {
        return res.status(404).json({ success: false, message: "Prescription not found" });
      }

      const rx = rows[0];

      if (!rx.patient_email) {
        return res.status(400).json({ success: false, message: "Patient has no email on record" });
      }

      const emailPayload = {
        patient:     { id: rx.patient_id, name: rx.patient_name },
        doctor:      { id: rx.doctor_id,  name: rx.doctor_name  },
        diagnosis:   rx.diagnosis   || "",
        notes:       rx.notes       || "",
        description: rx.description || "",
        medicines:   JSON.parse(rx.medicines_json || "[]"),
        tests:       JSON.parse(rx.tests_json     || "[]"),
        clinic: {
          name:    process.env.CLINIC_NAME    || "HealthCare Clinic",
          tagline: process.env.CLINIC_TAGLINE || "Compassionate Care, Expert Treatment",
          address: process.env.CLINIC_ADDRESS || "123 Medical Street, City",
          email:   process.env.MAIL_FROM      || "clinic@example.com",
        },
      };

      await transporter.sendMail({
        from:    `"${emailPayload.clinic.name}" <${process.env.MAIL_FROM}>`,
        to:      rx.patient_email,
        subject: `Your Prescription from ${emailPayload.clinic.name}`,
        html:    buildEmailHtml(emailPayload),
      });

      res.json({ success: true, message: `Prescription sent to ${rx.patient_email}` });
    } catch (err) {
      console.error("Send mail error:", err);
      res.status(500).json({ success: false, message: "Failed to send email: " + err.message });
    }
  }
);

module.exports = router;
