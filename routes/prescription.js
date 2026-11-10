const express = require("express");
const router = express.Router();
const db = require("../db");
const path = require("path");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");
const { sendPrescriptionEmail } = require("../utils/mailer");
const buildPrescriptionPDF = require("../utils/buildPrescriptionPdf");
const { suggestPrescription, AiError } = require("../services/aiPrescription");
const fs = require("fs-extra");

const { v4: uuid } = require("uuid");

const generatePrescriptionPdf = require("../utils/generatePrescriptionPdf");

const { uploadPrescription, uploadAndGenerateUrl } =
  require("../services/aceCloudStorage");

const { sendPrescription } =
  require("../services/whatsappservice");

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════════ */

const getAdminId = (user) =>
  user.role === "admin" ? user.id : user.adminId;

const safeParse = (value) => {
  if (!value) return [];
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return []; }
  }
  return value;
};

/* ─────────────────────────────────────────────────────────────────
   DYNAMIC RX — chief-complaint templates

   Every time a prescription is saved with a chief complaint, its
   diagnosis / notes / treatment plan / medicines / tests are stored
   as the default Rx for that complaint (per clinic + doctor).
   Next time the doctor picks the same complaint, the pad is filled
   from it and the doctor edits whatever differs for that patient.
───────────────────────────────────────────────────────────────── */

/* "  Fever   with Chills " → "fever with chills" */
const complaintKey = (text) =>
  String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 255);

/* first value that is a non-empty string (after trim) */
const firstText = (...vals) => {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

/* ─────────────────────────────────────────────────────────────────
   readNotes(body)
   Accepts BOTH payload shapes so every pad keeps working:
     A) notes: { chiefComplaint, treatmentPlan, doctorNotes, diagnosis }
     B) flat:  chief_complaint, diagnosis, description, notes (string)
───────────────────────────────────────────────────────────────── */
function readNotes(body = {}) {
  const n = body.notes && typeof body.notes === "object" ? body.notes : {};
  return {
    chiefComplaint: firstText(n.chiefComplaint, body.chief_complaint, body.chiefComplaint),
    treatmentPlan:  firstText(n.treatmentPlan, body.description, body.treatment_plan),
    doctorNotes:    firstText(
      n.doctorNotes,
      typeof body.notes === "string" ? body.notes : "",
      body.doctor_notes
    ),
    diagnosis:      firstText(n.diagnosis, body.diagnosis),
  };
}

/* Doctor whose templates we look up first */
const resolveDoctorForLookup = (req) => {
  if (req.user.role === "doctor") return Number(req.user.id) || 0;
  return Number(req.query.doctor_id) || 0;
};

/* ─────────────────────────────────────────────────────────────────
   upsertComplaintTemplate(...)
   Insert or overwrite the template for (admin, doctor, complaint).
   Never throws to the caller's flow — returns true/false.
───────────────────────────────────────────────────────────────── */
async function upsertComplaintTemplate({
  adminId,
  doctorId,
  chiefComplaint,
  diagnosis,
  doctorNotes,
  treatmentPlan,
  medicines,
  tests,
  consultations,          // undefined → keep whatever the template already has
  prescriptionId,
  countUse = true,
}) {
  const key = complaintKey(chiefComplaint);
  if (!adminId || !key) return false;

  const meds = Array.isArray(medicines) ? medicines : [];
  const tsts = Array.isArray(tests) ? tests : [];

  /* nothing clinical to remember */
  if (!meds.length && !tsts.length && !diagnosis && !doctorNotes && !treatmentPlan) {
    return false;
  }

  await db.execute(
    `INSERT INTO rx_complaint_templates
       (admin_id, doctor_id, chief_complaint, complaint_key,
        diagnosis, doctor_notes, treatment_plan,
        medicines_json, tests_json, consultation_type_json,
        use_count, last_prescription_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE
       chief_complaint        = VALUES(chief_complaint),
       diagnosis              = VALUES(diagnosis),
       doctor_notes           = VALUES(doctor_notes),
       treatment_plan         = VALUES(treatment_plan),
       medicines_json         = VALUES(medicines_json),
       tests_json             = VALUES(tests_json),
       consultation_type_json = COALESCE(VALUES(consultation_type_json), consultation_type_json),
       use_count              = use_count + ?,
       last_prescription_id   = VALUES(last_prescription_id),
       updated_at             = NOW()`,
    [
      adminId,
      Number(doctorId) || 0,
      String(chiefComplaint).trim().replace(/\s+/g, " ").slice(0, 255),
      key,
      diagnosis || null,
      doctorNotes || null,
      treatmentPlan || null,
      JSON.stringify(meds),
      JSON.stringify(tsts),
      Array.isArray(consultations) ? JSON.stringify(consultations) : null,
      prescriptionId ?? null,
      countUse ? 1 : 0,
    ]
  );
  return true;
}

/* Save template without ever failing the prescription save */
async function rememberComplaintTemplate(args) {
  try {
    return await upsertComplaintTemplate(args);
  } catch (err) {
    console.warn("[RX-TEMPLATE] Could not save template:", err.message);
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────
   enrichMedicinesWithAmount(medicines, adminId)

   Before storing, look up each medicine's `amount` (unit price)
   from the medicines table and attach it to the JSON object.

   Stored shape per medicine:
   {
     medicine_id,
     medicine_name,
     type, strength, unit, quantity,
     when_to_take, duration, description,
     amount,          ← unit price from medicines table
     total_amount,    ← amount × quantity (total cost for this line)
   }
───────────────────────────────────────────────────────────────── */
async function enrichMedicinesWithAmount(medicines, adminId) {
  if (!Array.isArray(medicines) || medicines.length === 0) return [];

  /* Collect unique medicine IDs that are present */
  const ids = [...new Set(
    medicines.map(m => m.medicine_id).filter(Boolean)
  )];

  /* Fetch all in one query */
  let amountMap = {};
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    const [rows] = await db.execute(
      /* include shared catalogue medicines (admin_id NULL) — that's where
         POST /api/medicines saves them; before, their price came out as 0 */
      `SELECT id, amount FROM medicines
       WHERE id IN (${placeholders}) AND (admin_id = ? OR admin_id IS NULL)`,
      [...ids, adminId]
    );
    rows.forEach(r => { amountMap[r.id] = Number(r.amount ?? 0); });
  }

  return medicines.map(m => {
    const unitAmount = amountMap[m.medicine_id] ?? Number(m.amount ?? 0);
    const qty = Number(m.quantity ?? 1);
    const totalAmount = unitAmount * qty;

    return {
      ...m,
      amount: unitAmount,    // unit price
      total_amount: totalAmount,   // unit price × quantity
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════
   🧠 CHIEF-COMPLAINT TEMPLATES  (dynamic Rx)
   ⚠ Registered before every "/:id" route so "complaint-templates"
     is never read as a prescription id.
═══════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────
   GET /api/prescriptions/complaint-templates?q=fev&doctor_id=5
   Autocomplete list for the chief-complaint box.
   The doctor's own templates come first; complaints only another
   doctor in the clinic has saved are listed after them.
───────────────────────────────────────────────────────────────── */
router.get(
  "/complaint-templates",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const adminId = getAdminId(req.user);
      const doctorId = resolveDoctorForLookup(req);
      const q = complaintKey(req.query.q || "");
      const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

      const [rows] = await db.execute(
        `SELECT
           t.id,
           t.doctor_id,
           t.chief_complaint,
           t.complaint_key,
           t.diagnosis,
           COALESCE(JSON_LENGTH(t.medicines_json), 0) AS medicine_count,
           COALESCE(JSON_LENGTH(t.tests_json), 0)     AS test_count,
           t.use_count,
           t.updated_at,
           s.name AS doctor_name
         FROM rx_complaint_templates t
         LEFT JOIN staff s ON s.id = t.doctor_id
         WHERE t.admin_id = ? AND t.complaint_key LIKE ?
         ORDER BY (t.doctor_id = ?) DESC,
                  (t.complaint_key LIKE ?) DESC,
                  t.use_count DESC,
                  t.updated_at DESC
         LIMIT 60`,
        [adminId, like, doctorId, `${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`]
      );

      /* one row per complaint — the first one wins (own template first) */
      const seen = new Set();
      const data = [];
      for (const r of rows) {
        if (seen.has(r.complaint_key)) continue;
        seen.add(r.complaint_key);
        data.push({
          id: r.id,
          chief_complaint: r.chief_complaint,
          diagnosis: r.diagnosis || "",
          medicine_count: Number(r.medicine_count) || 0,
          test_count: Number(r.test_count) || 0,
          use_count: Number(r.use_count) || 0,
          updated_at: r.updated_at,
          doctor_id: r.doctor_id || null,
          doctor_name: r.doctor_name || null,
          is_own: Number(r.doctor_id) === doctorId,
        });
        if (data.length >= 15) break;
      }

      res.json({ success: true, data });
    } catch (err) {
      console.error("Complaint template list error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

/* ─────────────────────────────────────────────────────────────────
   GET /api/prescriptions/complaint-templates/lookup?complaint=Fever&doctor_id=5
   Full saved Rx for one complaint, ready to drop into the pad.
   Order of preference: this doctor → any doctor in the clinic.
   Medicine prices are refreshed from the medicines table.
───────────────────────────────────────────────────────────────── */
router.get(
  "/complaint-templates/lookup",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const adminId = getAdminId(req.user);
      const doctorId = resolveDoctorForLookup(req);
      const key = complaintKey(req.query.complaint || "");

      if (!key) {
        return res.status(400).json({ success: false, message: "complaint is required" });
      }

      const [[tpl]] = await db.execute(
        `SELECT t.*, s.name AS doctor_name
         FROM rx_complaint_templates t
         LEFT JOIN staff s ON s.id = t.doctor_id
         WHERE t.admin_id = ? AND t.complaint_key = ?
         ORDER BY (t.doctor_id = ?) DESC, t.use_count DESC, t.updated_at DESC
         LIMIT 1`,
        [adminId, key, doctorId]
      );

      if (!tpl) return res.json({ success: true, data: null });

      const medicines = await enrichMedicinesWithAmount(
        safeParse(tpl.medicines_json),
        adminId
      );

      res.json({
        success: true,
        data: {
          id: tpl.id,
          chief_complaint: tpl.chief_complaint,
          diagnosis: tpl.diagnosis || "",
          doctor_notes: tpl.doctor_notes || "",
          treatment_plan: tpl.treatment_plan || "",
          medicines,
          tests: safeParse(tpl.tests_json),
          consultations: safeParse(tpl.consultation_type_json),
          use_count: Number(tpl.use_count) || 0,
          updated_at: tpl.updated_at,
          doctor_id: tpl.doctor_id || null,
          doctor_name: tpl.doctor_name || null,
          source: Number(tpl.doctor_id) === doctorId ? "own" : "clinic",
        },
      });
    } catch (err) {
      console.error("Complaint template lookup error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

/* ─────────────────────────────────────────────────────────────────
   DELETE /api/prescriptions/complaint-templates/:templateId
   Doctors can delete only their own; admins any in the clinic.
───────────────────────────────────────────────────────────────── */
router.delete(
  "/complaint-templates/:templateId",
  authMiddleware,
  allowRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const adminId = getAdminId(req.user);
      const params = [req.params.templateId, adminId];
      let sql = `DELETE FROM rx_complaint_templates WHERE id = ? AND admin_id = ?`;

      if (req.user.role === "doctor") {
        sql += ` AND doctor_id = ?`;
        params.push(Number(req.user.id) || 0);
      }

      const [result] = await db.execute(sql, params);
      if (!result.affectedRows) {
        return res.status(404).json({ success: false, message: "Template not found" });
      }
      res.json({ success: true, message: "Saved Rx removed for this complaint" });
    } catch (err) {
      console.error("Complaint template delete error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   📧 SEND MAIL HELPER
═══════════════════════════════════════════════════════════════════ */


const sendMailForPrescription = async (prescriptionId) => {
  const [rows] = await db.execute(
    `SELECT
        p.id,
        p.notes,
        p.description,
        p.appointment_id,
        p.medicines_json,
        p.tests_json,
        p.consultation_type_json,

        c.id    AS patient_id,
        c.name  AS patient_name,
        c.email AS patient_email,

        s.id            AS doctor_id,
        s.name          AS doctor_name,
        s.qualification AS doctor_qualification,

        a.id           AS admin_id,
        a.company_name AS clinic_name,
        a.company_logo AS clinic_logo_filename,
        a.email        AS clinic_email,
        a.mobile       AS clinic_phone,
        a.address      AS clinic_address,

        ap.id               AS appointment_id,
        ap.appointment_date AS appointment_date,
        ap.selected_branch  AS branch, 
        COALESCE(NULLIF(ap.purpose, ''), p.chief_complaint) AS chief_complaint
     FROM prescriptions p
     LEFT JOIN clients      c  ON c.id  = p.patient_id
     LEFT JOIN staff        s  ON s.id  = p.doctor_id
     LEFT JOIN admins       a  ON a.id  = p.admin_id
     LEFT JOIN appointments ap ON ap.id = p.appointment_id
     WHERE p.id = ?`,
    [prescriptionId]
  );

  if (!rows.length) throw new Error(`Prescription #${prescriptionId} not found`);
  const rx = rows[0];

  if (!rx.patient_email) {
    throw new Error(`Patient email missing for #${prescriptionId}`);
  }

  const medicines = safeParse(rx.medicines_json);
  const tests = safeParse(rx.tests_json);
  const consultations = safeParse(rx.consultation_type_json);

  /* ── LOGO HANDLING (IMPORTANT PART) ── */

  const SITE_URL = process.env.SITE_URL || "http://localhost:5000";

  // ✅ URL → PDF
  const clinicLogoUrl = rx.clinic_logo_filename
    ? `${SITE_URL}/Images/${rx.clinic_logo_filename}`
    : null;

  // ✅ Local file → Email (CID)
  const clinicLogoPath = rx.clinic_logo_filename
    ? path.join(__dirname, "..", "Images", rx.clinic_logo_filename)
    : null;

  /* ── NOTES OBJECT (shared shape with frontend) ── */
  const notesObj = {
    chiefComplaint: rx.chief_complaint || "",
    treatmentPlan: rx.description || "",
    doctorNotes: rx.notes || "",
  };

  /* ── BUILD PDF ── */
  const pdfBuffer = await buildPrescriptionPDF({
    clinic: {
      name: rx.clinic_name || "—",
      logo: clinicLogoUrl, // ✅ URL for PDF
      email: rx.clinic_email || "—",
      phone: rx.clinic_phone || "—",
      address: rx.clinic_address || "—",
    },
    branch: rx.branch || "—",
    patient: { id: rx.patient_id, name: rx.patient_name || "—" },
    doctor: {
      id: rx.doctor_id,
      name: rx.doctor_name || "—",
      qualification: rx.doctor_qualification || "",
    },
    appointment: {
      id: rx.appointment_id,
      appointment_date: rx.appointment_date || null,
    },
    medicines,
    tests,
    consultations,
    notes: notesObj,
  });

  /* ── SEND EMAIL ── */
  await sendPrescriptionEmail(
    rx.patient_email,
    {
      patientName: rx.patient_name || "Patient",
      doctorName: rx.doctor_name || "—",
      clinicName: rx.clinic_name || "HealthCare Clinic",

      clinicLogoPath: clinicLogoPath,


      clinicPhone: rx.clinic_phone || "",
      clinicEmail: rx.clinic_email || "",
      date: new Date().toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      }),
      chiefComplaint: notesObj.chiefComplaint,
      treatmentPlan: notesObj.treatmentPlan,
      doctorNotes: notesObj.doctorNotes,
    },
    pdfBuffer
  );
};

/* ═══════════════════════════════════════════════════════════════════
   📬 MANUAL SEND MAIL
═══════════════════════════════════════════════════════════════════ */

router.post("/send-mail/:id", authMiddleware, async (req, res) => {
  try {
    await sendMailForPrescription(req.params.id);
    res.json({ success: true, message: "Email sent successfully" });
  } catch (err) {
    console.error("Send mail error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post(
  "/:id/send-whatsapp",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {

    let pdf = null;

    try {

      const adminId = getAdminId(req.user);

      const [rows] = await db.execute(

        `SELECT
        p.id,
        p.notes,
        p.description,
        p.appointment_id,
        p.medicines_json,
        p.tests_json,
        p.consultation_type_json,

        c.id    AS patient_id,
        c.name  AS patient_name,
        c.email AS patient_email,
        c.mobile AS whatsapp,

        s.id            AS doctor_id,
        s.name          AS doctor_name,
        s.qualification AS doctor_qualification,

        a.id           AS admin_id,
        a.company_name AS clinic_name,
        a.company_logo AS clinic_logo_filename,
        a.email        AS clinic_email,
        a.mobile       AS clinic_phone,
        a.address      AS clinic_address,

        ap.id               AS appointment_id,
        ap.appointment_date AS appointment_date,
        ap.selected_branch  AS branch, 
        COALESCE(NULLIF(ap.purpose, ''), p.chief_complaint) AS chief_complaint
     FROM prescriptions p
     LEFT JOIN clients      c  ON c.id  = p.patient_id
     LEFT JOIN staff        s  ON s.id  = p.doctor_id
     LEFT JOIN admins       a  ON a.id  = p.admin_id
     LEFT JOIN appointments ap ON ap.id = p.appointment_id
     WHERE p.id = ?`,

        [
          req.params.id
        ]

      );



      if (!rows.length) {

        return res.status(404).json({

          success: false,

          message: "Prescription not found"

        });

      }



      const rx = rows[0];

      if (!rx.whatsapp) {
        return res.status(400).json({
          success: false,
          message: "Patient WhatsApp number not found."
        });
      }

      /* ── Build the fields the payload needs ── */
      const SITE_URL = process.env.SITE_URL || "http://localhost:5000";
      const clinicLogoUrl = rx.clinic_logo_filename
        ? `${SITE_URL}/Images/${rx.clinic_logo_filename}`
        : null;

      const medicines = safeParse(rx.medicines_json);
      const tests = safeParse(rx.tests_json);
      const consultations = safeParse(rx.consultation_type_json);

      const notesObj = {
        chiefComplaint: rx.chief_complaint || "",
        treatmentPlan: rx.description || "",
        doctorNotes: rx.notes || "",
      };



      const payload = {

        // patient: {
        //   id: rx.patient_id,
        //   name: rx.patient_name
        // },

        // doctor: {
        //   id: rx.doctor_id,
        //   name: rx.doctor_name
        // },

        // diagnosis: rx.diagnosis || "",

        // notes: rx.notes || "",

        // description: rx.description || "",

        // medicines: safeParse(rx.medicines_json),

        // tests: safeParse(rx.tests_json),

        // clinic: {

        //   name: rx.admin_name || ""

        // },
        clinic: {
          name: rx.clinic_name || "—",
          logo: clinicLogoUrl, // ✅ URL for PDF
          email: rx.clinic_email || "—",
          phone: rx.clinic_phone || "—",
          address: rx.clinic_address || "—",
        },
        branch: rx.branch || "—",
        patient: { id: rx.patient_id, name: rx.patient_name || "—" },
        doctor: {
          id: rx.doctor_id,
          name: rx.doctor_name || "—",
          qualification: rx.doctor_qualification || "",
        },
        appointment: {
          id: rx.appointment_id,
          appointment_date: rx.appointment_date || null,
        },
        medicines,
        tests,
        consultations,
        notes: notesObj,

      };



      // Generate PDF

      pdf = await generatePrescriptionPdf(payload);



      // Upload PDF

      const upload =

        await uploadAndGenerateUrl(

          pdf.pdfPath,

          pdf.fileName

        );



      // Save URL

      await db.execute(

        `UPDATE prescriptions

                SET prescription_url=?

                WHERE id=?`,

        [

          upload.url,

          rx.id

        ]

      );



      // Send WhatsApp

      const whatsapp =

        await sendPrescription({

          phone: `91${rx.whatsapp}`,

          patientName: rx.patient_name,

          doctorName: rx.doctor_name,

          clinicName: rx.clinic_name || "",

          prescriptionUrl: upload.url

        });



      if (!whatsapp.success) {

        return res.status(500).json({

          success: false,

          message: "Unable to send WhatsApp.",

          error: whatsapp.error

        });

      }



      // Delete temp PDF

      await fs.remove(

        pdf.pdfPath

      );



      res.json({

        success: true,

        message: "Prescription sent successfully.",

        url: upload.url

      });

    }

    catch (err) {

      console.log(err);

      if (pdf) {

        await fs.remove(pdf.pdfPath);

      }

      res.status(500).json({

        success: false,

        message: err.message

      });

    }

  }
);

router.post(
  "/:id/share-whatsapp",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    let pdf = null;
 
    try {
      const adminId = getAdminId(req.user);
 
      /* ── 1. Validate the target number from the request body ── */
      const rawPhone = (req.body.phone || "").toString().trim();
 
      // keep digits only (strip spaces, +, -, etc.)
      let digits = rawPhone.replace(/\D/g, "");
 
      // if a leading country code / zero was included, normalise to 10 digits
      if (digits.length > 10 && digits.startsWith("91")) {
        digits = digits.slice(-10);
      } else if (digits.length === 11 && digits.startsWith("0")) {
        digits = digits.slice(1);
      }
 
      if (digits.length !== 10) {
        return res.status(400).json({
          success: false,
          message: "Please provide a valid 10-digit WhatsApp number.",
        });
      }
 
      const targetPhone = `91${digits}`;
 
      /* ── 2. Fetch the prescription (admin-scoped) ── */
      const [rows] = await db.execute(
        `SELECT
            p.id,
            p.notes,
            p.description,
            p.appointment_id,
            p.medicines_json,
            p.tests_json,
            p.consultation_type_json,
            p.prescription_url,
 
            c.id    AS patient_id,
            c.name  AS patient_name,
 
            s.id            AS doctor_id,
            s.name          AS doctor_name,
            s.qualification AS doctor_qualification,
 
            a.id           AS admin_id,
            a.company_name AS clinic_name,
            a.company_logo AS clinic_logo_filename,
            a.email        AS clinic_email,
            a.mobile       AS clinic_phone,
            a.address      AS clinic_address,
 
            ap.id               AS appointment_id,
            ap.appointment_date AS appointment_date,
            ap.selected_branch  AS branch,
            COALESCE(NULLIF(ap.purpose, ''), p.chief_complaint) AS chief_complaint
         FROM prescriptions p
         LEFT JOIN clients      c  ON c.id  = p.patient_id
         LEFT JOIN staff        s  ON s.id  = p.doctor_id
         LEFT JOIN admins       a  ON a.id  = p.admin_id
         LEFT JOIN appointments ap ON ap.id = p.appointment_id
         WHERE p.id = ? AND p.admin_id = ?`,
        [req.params.id, adminId]
      );
 
      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Prescription not found",
        });
      }
 
      const rx = rows[0];
 
      /* ── 3. Reuse saved URL, or generate + upload if missing ── */
      let prescriptionUrl = rx.prescription_url;
 
      if (!prescriptionUrl) {
        const SITE_URL = process.env.SITE_URL || "http://localhost:5000";
        const clinicLogoUrl = rx.clinic_logo_filename
          ? `${SITE_URL}/Images/${rx.clinic_logo_filename}`
          : null;
 
        const medicines     = safeParse(rx.medicines_json);
        const tests         = safeParse(rx.tests_json);
        const consultations = safeParse(rx.consultation_type_json);
 
        const notesObj = {
          chiefComplaint: rx.chief_complaint || "",
          treatmentPlan:  rx.description     || "",
          doctorNotes:    rx.notes           || "",
        };
 
        const payload = {
          clinic: {
            name:    rx.clinic_name || "—",
            logo:    clinicLogoUrl,
            email:   rx.clinic_email || "—",
            phone:   rx.clinic_phone || "—",
            address: rx.clinic_address || "—",
          },
          branch: rx.branch || "—",
          patient: { id: rx.patient_id, name: rx.patient_name || "—" },
          doctor: {
            id: rx.doctor_id,
            name: rx.doctor_name || "—",
            qualification: rx.doctor_qualification || "",
          },
          appointment: {
            id: rx.appointment_id,
            appointment_date: rx.appointment_date || null,
          },
          medicines,
          tests,
          consultations,
          notes: notesObj,
        };
 
        pdf = await generatePrescriptionPdf(payload);
        const upload = await uploadAndGenerateUrl(pdf.pdfPath, pdf.fileName);
        prescriptionUrl = upload.url;
 
        // persist so future shares reuse it
        await db.execute(
          `UPDATE prescriptions SET prescription_url = ? WHERE id = ?`,
          [prescriptionUrl, rx.id]
        );
      }
 
      /* ── 4. Send to the target number (same prescription template) ── */
      const whatsapp = await sendPrescription({
        phone: targetPhone,
        patientName: rx.patient_name || "Patient",
        doctorName: rx.doctor_name || "—",
        clinicName: rx.clinic_name || "",
        prescriptionUrl,
      });
 
      if (!whatsapp.success) {
        return res.status(500).json({
          success: false,
          message: "Unable to share prescription on WhatsApp.",
          error: whatsapp.error,
        });
      }
 
      // clean up only if we generated a temp file this time
      if (pdf) await fs.remove(pdf.pdfPath);
 
      res.json({
        success: true,
        message: `Prescription shared to ${targetPhone}.`,
        url: prescriptionUrl,
      });
    } catch (err) {
      console.log(err);
      if (pdf) await fs.remove(pdf.pdfPath);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   ➕ CREATE PRESCRIPTION
   Enriches medicines with amount + total_amount before storing.
═══════════════════════════════════════════════════════════════════ */

router.post("/", authMiddleware, async (req, res) => {
  try {
    const adminId = getAdminId(req.user) ?? null;

    const {
      patient_id,
      doctor_id,
      appointment_id,
      consultation_types,
      medicines = [],
      tests = [],
      save_as_template = true,     // dynamic Rx: remember this Rx for the complaint
    } = req.body;

    /* works with notes:{...} object OR flat diagnosis/description/notes fields */
    const {
      chiefComplaint,
      treatmentPlan,
      doctorNotes,
      diagnosis,
    } = readNotes(req.body);

    if (!patient_id)
      return res.status(400).json({ success: false, message: "patient_id is required" });

    const resolvedDoctorId =
      req.user.role === "doctor" ? req.user.id : (doctor_id ?? null);

    /* ── Enrich medicines with amount from medicines table ── */
    const enrichedMedicines = await enrichMedicinesWithAmount(medicines, adminId);

    console.log("[CREATE] Enriched medicines:", JSON.stringify(enrichedMedicines, null, 2));
    /* only overwrite the appointment's purpose with a real complaint —
       an empty one used to blank it out */
    if (appointment_id && chiefComplaint) {
      await db.execute(
        `UPDATE appointments
          SET purpose = ?
          WHERE id = ? AND admin_id = ?`,
        [chiefComplaint, appointment_id, adminId]
      );
    }
    const [result] = await db.execute(
      `INSERT INTO prescriptions
         (admin_id, patient_id, doctor_id, appointment_id, chief_complaint,
          consultation_type_json, medicines_json, tests_json,
          notes, description, diagnosis, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        adminId,
        patient_id,
        resolvedDoctorId,
        appointment_id ?? null,
        chiefComplaint || null,   // prescriptions.chief_complaint
        JSON.stringify(consultation_types ?? []),
        JSON.stringify(enrichedMedicines),
        JSON.stringify(tests ?? []),

        doctorNotes || null,      // prescriptions.notes
        treatmentPlan || null,    // prescriptions.description
        diagnosis || null,        // prescriptions.diagnosis
      ]
    );

    const prescriptionId = result.insertId;

    /* ── Dynamic Rx: remember this Rx for the chief complaint ── */
    const templateSaved =
      save_as_template !== false && save_as_template !== "false"
        ? await rememberComplaintTemplate({
            adminId,
            doctorId: resolvedDoctorId,
            chiefComplaint,
            diagnosis,
            doctorNotes,
            treatmentPlan,
            medicines: enrichedMedicines,
            tests: tests ?? [],
            consultations: consultation_types,   // undefined → template keeps its own
            prescriptionId,
            countUse: true,
          })
        : false;

    try {
      await sendMailForPrescription(prescriptionId);
    } catch (mailErr) {
      console.warn(`[CREATE] Mail failed for #${prescriptionId}:`, mailErr.message);
    }

    res.status(201).json({
      success: true,
      message: "Prescription saved successfully",
      template_saved: templateSaved,
      data: { prescription_id: prescriptionId, template_saved: templateSaved },
    });
  } catch (err) {
    console.error("Create prescription error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post(
  "/fhir/medication-request",
  authMiddleware,
  async (req, res) => {
    try {
      const adminId = getAdminId(req.user) ?? null;

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

      // 🔗 Extract references
      const patientRef = req.body.subject?.reference;
      const doctorRef = req.body.requester?.reference;
      const encounterRef = req.body.encounter?.reference;

      const patient_id = patientRef?.split("/")[1];
      const doctor_id = doctorRef?.split("/")[1];
      const appointment_id = encounterRef?.split("/")[1];

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

      // 🧠 Extract consultation types
      const consultation_types =
        req.body.category?.map(c => c.text) || [];

      // 💊 Extract medicines (with dosage)
      const medicines = (req.body.dosageInstruction || []).map((d, i) => ({
        name: d.text || `Medicine ${i + 1}`,
        dosage: d.timing?.repeat?.frequency || null,
        duration: d.timing?.repeat?.period || null,
        route: d.route?.text || null
      }));

      // 🧪 Extract tests
      const tests =
        req.body.supportingInfo?.map(t => ({
          name: t.display
        })) || [];

      // 📝 Notes & diagnosis
      const notes = req.body.note?.map(n => n.text).join(", ");
      const description = req.body.reasonCode?.[0]?.text || null;

      // 👨‍⚕️ Resolve doctor
      const resolvedDoctorId =
        req.user.role === "doctor" ? req.user.id : (doctor_id ?? null);

      // 💊 Enrich medicines (your logic)
      const enrichedMedicines = await enrichMedicinesWithAmount(
        medicines,
        adminId
      );

      const [result] = await db.execute(
        `INSERT INTO prescriptions
         (admin_id, patient_id, doctor_id, appointment_id,
          consultation_type_json, medicines_json, tests_json,
          notes, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          adminId,
          patient_id,
          resolvedDoctorId,
          appointment_id ?? null,
          JSON.stringify(consultation_types),
          JSON.stringify(enrichedMedicines),
          JSON.stringify(tests),
          notes || null,
          description || null
        ]
      );

      const prescriptionId = result.insertId;

      // 📧 Email (keep your logic)
      try {
        await sendMailForPrescription(prescriptionId);
      } catch (mailErr) {
        console.warn("Mail failed:", mailErr.message);
      }

      // ✅ FHIR Response
      res.setHeader("Content-Type", "application/fhir+json");
      res.setHeader(
        "Location",
        `/fhir/MedicationRequest/${prescriptionId}`
      );

      res.status(201).json({
        resourceType: "MedicationRequest",
        id: String(prescriptionId),
        status: "active",
        intent: "order",

        subject: {
          reference: `Patient/${patient_id}`
        },

        requester: resolvedDoctorId
          ? { reference: `Practitioner/${resolvedDoctorId}` }
          : undefined,

        encounter: appointment_id
          ? { reference: `Encounter/${appointment_id}` }
          : undefined,

        authoredOn: new Date().toISOString(),

        // 🧠 Diagnosis
        reasonCode: description
          ? [{ text: description }]
          : [],

        // 📝 Notes
        note: notes
          ? [{ text: notes }]
          : [],

        // 💊 Medicines (FHIR way)
        dosageInstruction: enrichedMedicines.map((m) => ({
          text: m.medicine_name,
          timing: {
            repeat: {
              frequency: m.when_to_take?.length || 1,
              period: m.duration || 1
            }
          },
          route: {
            text: m.route || "oral"
          }
        })),

        // 🧪 Tests
        supportingInfo: tests.map((t) => ({
          display: t.name
        }))
      });

    } catch (err) {
      console.error("FHIR Prescription error:", err.message);

      res.status(500).json({
        resourceType: "OperationOutcome",
        issue: [{
          severity: "error",
          code: "exception",
          diagnostics: err.message
        }]
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   📋 LIST PRESCRIPTIONS
═══════════════════════════════════════════════════════════════════ */

router.get("/", authMiddleware, allowRoles("admin", "doctor", "receptionist"), async (req, res) => {
  try {
    const adminId = getAdminId(req.user);

    const [rows] = await db.execute(
      `SELECT
         p.id,
         p.patient_id,
         p.doctor_id,
         p.appointment_id,
         p.created_at,
         JSON_LENGTH(p.medicines_json) AS medicine_count,
         JSON_LENGTH(p.tests_json)     AS test_count,
         c.name  AS patient_name,
         ap.appointment_date
       FROM prescriptions p
       LEFT JOIN clients      c  ON c.id  = p.patient_id
       LEFT JOIN appointments ap ON ap.id = p.appointment_id
       WHERE p.admin_id = ?
       ORDER BY p.created_at DESC`,
      [adminId]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("List prescriptions error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

function parseSafe(data) {
  if (!data) return [];

  if (typeof data === "object") return data;

  try {
    return JSON.parse(data);
  } catch (err) {
    console.error("JSON parse error:", err);
    return [];
  }
}
router.get(
  "/fhir/medication-request",
  authMiddleware,
  allowRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const adminId = getAdminId(req.user);

      const [rows] = await db.execute(
        `SELECT
           p.id,
           p.patient_id,
           p.doctor_id,
           p.appointment_id,
           p.created_at,
           p.medicines_json,
           p.tests_json,
           p.notes,
           p.description,

           c.name  AS patient_name,
           ap.appointment_date

         FROM prescriptions p
         LEFT JOIN clients c  ON c.id  = p.patient_id
         LEFT JOIN appointments ap ON ap.id = p.appointment_id
         WHERE p.admin_id = ?
         ORDER BY p.created_at DESC`,
        [adminId]
      );

      // 🔄 Convert DB → FHIR Bundle
      // const entries = rows.map((r) => {
      //   let medicines = [];
      //   let tests = [];

      //   try {
      //     medicines = JSON.parse(r.medicines_json || "[]");
      //     console.log("Parsed medicines for prescription", r.id, medicines);
      //     tests = JSON.parse(r.tests_json || "[]");
      //     console.log("Parsed tests for prescription", r.id, tests);
      //   } catch (e) { }

      //   return {
      //     resource: {
      //       resourceType: "MedicationRequest",
      //       id: String(r.id),

      //       status: "active",
      //       intent: "order",

      //       // 👤 Patient
      //       subject: {
      //         reference: `Patient/${r.patient_id}`,
      //         display: r.patient_name
      //       },

      //       // 👨‍⚕️ Doctor
      //       requester: r.doctor_id
      //         ? {
      //           reference: `Practitioner/${r.doctor_id}`
      //         }
      //         : undefined,

      //       authoredOn: r.created_at,

      //       // 🔗 Appointment → Encounter
      //       encounter: r.appointment_id
      //         ? {
      //           reference: `Encounter/${r.appointment_id}`,
      //           display: `Visit on ${r.appointment_date}`
      //         }
      //         : undefined,

      //       // 🧠 Diagnosis
      //       reasonCode: r.description
      //         ? [{ text: r.description }]
      //         : [],

      //       // 📝 Notes
      //       note: r.notes
      //         ? [{ text: r.notes }]
      //         : [],

      //       // 💊 Medicines (contained)
      //       contained: medicines.map((m, i) => ({
      //         resourceType: "Medication",
      //         id: `med-${i + 1}`,
      //         code: {
      //           text: `${m.medicine_name} ${m.strength || ""}${m.unit || ""}`
      //         }
      //       })),

      //       // 💉 ADD THIS (VERY IMPORTANT)
      //       dosageInstruction: medicines.map((m) => {
      //         const frequency = m.when_to_take?.length || 1;

      //         // extract days from "5 days"
      //         const days = m.duration ? parseInt(m.duration) || 1 : 1;

      //         return {
      //           text: `${m.medicine_name} - ${m.when_to_take?.join(", ")} for ${m.duration}`,

      //           timing: {
      //             repeat: {
      //               frequency,
      //               period: 1,
      //               periodUnit: "d",
      //               boundsDuration: {
      //                 value: days,
      //                 unit: "days"
      //               }
      //             }
      //           },

      //           route: {
      //             text: m.type || "oral"
      //           },

      //           doseAndRate: [
      //             {
      //               doseQuantity: {
      //                 value: m.quantity || 1,
      //                 unit: "tablet"
      //               }
      //             }
      //           ]
      //         };
      //       }),

      //       // 🧪 Tests
      //       supportingInfo: tests.map((t) => ({
      //         display: t.name || JSON.stringify(t)
      //       }))
      //     }
      //   };
      // });

      const entries = [];

      rows.forEach((r) => {
        const medicines = parseSafe(r.medicines_json);

        medicines.forEach((m, i) => {
          const medId = `med-${r.id}-${i + 1}`;

          entries.push({
            resource: {
              resourceType: "MedicationRequest",
              id: `${r.id}-${i + 1}`,

              status: "active",
              intent: "order",

              subject: {
                reference: `Patient/${r.patient_id}`,
                display: r.patient_name
              },

              requester: r.doctor_id
                ? {
                  reference: `Practitioner/${r.doctor_id}`
                }
                : undefined,

              authoredOn: r.created_at,

              encounter: r.appointment_id
                ? {
                  reference: `Encounter/${r.appointment_id}`,
                  display: `Visit on ${r.appointment_date}`
                }
                : undefined,

              // ✅ LINK MEDICINE
              medicationReference: {
                reference: `#${medId}`
              },

              // ✅ DOSAGE
              dosageInstruction: [
                {
                  text: `${m.medicine_name} - ${m.when_to_take?.join(", ")} for ${m.duration}`,

                  timing: {
                    repeat: {
                      frequency: m.when_to_take?.length || 1,
                      period: 1,
                      periodUnit: "d"
                    }
                  },

                  doseAndRate: [
                    {
                      doseQuantity: {
                        value: m.quantity || 1,
                        unit: "tablet"
                      }
                    }
                  ]
                }
              ],

              // ✅ CONTAINED MEDICINE
              contained: [
                {
                  resourceType: "Medication",
                  id: medId,
                  code: {
                    text: `${m.medicine_name} ${m.strength || ""}${m.unit || ""}`
                  }
                }
              ]
            }
          });
        });
      });

      // ✅ FHIR Bundle Response
      const bundle = {
        resourceType: "Bundle",
        type: "searchset",
        total: entries.length,
        entry: entries
      };

      res.setHeader("Content-Type", "application/fhir+json");

      res.status(200).json(bundle);

    } catch (err) {
      console.error("FHIR list prescriptions error:", err.message);

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

/* ═══════════════════════════════════════════════════════════════════
   🔍 BY-APPOINTMENT  — MUST be before /:id

   Supports TWO calling styles — both work:
   A) Query params: GET /api/prescriptions/by-appointment?patient_id=3&appointment_id=7
   B) Path params:  GET /api/prescriptions/by-appointment/3/7

   Logic:
   1. Exact match on patient_id + appointment_id
   2. Fallback: latest prescription for that patient
═══════════════════════════════════════════════════════════════════ */

async function byAppointmentHandler(req, res) {
  try {
    const { appointment_id } = req.query;

    if (!appointment_id) {
      return res.status(400).json({
        success: false,
        message: "appointment_id is required",
      });
    }

    // Find prescription for this appointment
    const [[rx]] = await db.execute(
      `SELECT p.*, c.name AS patient_name, s.name AS doctor_name
       FROM prescriptions p
       LEFT JOIN clients c ON c.id = p.patient_id
       LEFT JOIN staff s ON s.id = p.doctor_id
       WHERE p.appointment_id = ?
       ORDER BY p.id DESC
       LIMIT 1`,
      [appointment_id]
    );

    if (!rx) {
      return res.json({
        success: true,
        data: null,
      });
    }

    const medicines = safeParse(rx.medicines_json);
    const tests = safeParse(rx.tests_json);
    const consultations = safeParse(rx.consultation_type_json);

    const enrichedMedicines = await Promise.all(
      medicines.map(async (m) => {
        if (m.amount != null) return m;

        const [[med]] = await db.execute(
          `SELECT amount FROM medicines WHERE id = ?`,
          [m.medicine_id]
        );

        const amount = Number(med?.amount ?? 0);
        const qty = Number(m.quantity ?? 1);

        return {
          ...m,
          amount,
          total_amount: amount * qty,
        };
      })
    );

    res.json({
      success: true,
      data: {
        id: rx.id,
        patient_name: rx.patient_name,
        doctor_name: rx.doctor_name,
        consultations,
        medicines: enrichedMedicines,
        tests: tests.map(t => ({
          ...t,
          cost: t.cost ?? 0,
        })),
      },
    });

  } catch (err) {
    console.error("by-appointment error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
}

/* Style A: query params  ?patient_id=X&appointment_id=Y */
router.get("/by-appointment", authMiddleware, (req, res) =>
  byAppointmentHandler(req, res)
);

/* Style B: path params  /by-appointment/:patientId/:appointmentId */
router.get("/by-appointment/:patientId/:appointmentId", authMiddleware, (req, res) => {
  req.query.patient_id = req.params.patientId;
  req.query.appointment_id = req.params.appointmentId;
  return byAppointmentHandler(req, res);
});

router.get("/patient/:patientId", authMiddleware, async (req, res) => {
  try {
    const [[rx]] = await db.execute(
      `SELECT p.*, c.name AS patient_name, s.name AS doctor_name
       FROM prescriptions p
       LEFT JOIN clients c ON c.id = p.patient_id
       LEFT JOIN staff   s ON s.id = p.doctor_id
       WHERE p.patient_id = ?
       ORDER BY p.created_at DESC LIMIT 1`,
      [req.params.patientId]
    );

    if (!rx) return res.json({ success: true, data: null });

    res.json({
      success: true,
      data: {
        id: rx.id,
        consultations: safeParse(rx.consultation_type_json),
        medicines: safeParse(rx.medicines_json),  // already enriched
        tests: safeParse(rx.tests_json),
      },
    });
  } catch (err) {
    console.error("patient latest error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get(
  "/fhir/medication-request",
  authMiddleware,
  async (req, res) => {
    try {
      const patientId = req.query.patient;

      if (!patientId) {
        return res.status(400).json({
          resourceType: "OperationOutcome",
          issue: [{
            severity: "error",
            code: "required",
            diagnostics: "patient query param is required"
          }]
        });
      }

      const [[rx]] = await db.execute(
        `SELECT p.*, c.name AS patient_name, s.name AS doctor_name
         FROM prescriptions p
         LEFT JOIN clients c ON c.id = p.patient_id
         LEFT JOIN staff s ON s.id = p.doctor_id
         WHERE p.patient_id = ?
         ORDER BY p.created_at DESC
         LIMIT 1`,
        [patientId]
      );

      if (!rx) {
        return res.json({
          resourceType: "Bundle",
          type: "searchset",
          total: 0,
          entry: []
        });
      }

      // 🔄 Parse safely
      const medicines = safeParse(rx.medicines_json);
      const tests = safeParse(rx.tests_json);
      const consultations = safeParse(rx.consultation_type_json);

      // 🧠 Helper → extract days (from "5 days")
      const getDays = (duration) => {
        if (!duration) return 1;
        const match = duration.match(/\d+/);
        return match ? parseInt(match[0]) : 1;
      };

      // 🧠 Helper → frequency from when_to_take
      const getFrequency = (when) => {
        return Array.isArray(when) ? when.length : 1;
      };

      // 🔁 Convert to FHIR
      const resource = {
        resourceType: "MedicationRequest",
        id: String(rx.id),

        status: "active",
        intent: "order",

        subject: {
          reference: `Patient/${rx.patient_id}`,
          display: rx.patient_name
        },

        requester: rx.doctor_id
          ? {
            reference: `Practitioner/${rx.doctor_id}`,
            display: rx.doctor_name
          }
          : undefined,

        authoredOn: rx.created_at,

        // 🧠 Consultations
        category: consultations.map(c => ({
          text: c.name || JSON.stringify(c)
        })),

        // 💊 Medicines (IMPORTANT)
        contained: medicines.map((m, i) => ({
          resourceType: "Medication",
          id: `med-${i + 1}`,
          code: {
            text: `${m.medicine_name} ${m.strength || ""}${m.unit || ""}`
          }
        })),

        // 💉 REAL DOSAGE (ABDM READY)
        dosageInstruction: medicines.map((m) => {
          const frequency = getFrequency(m.when_to_take);
          const days = getDays(m.duration);

          return {
            text: `${m.medicine_name} ${m.strength || ""}${m.unit || ""} - ${m.when_to_take?.join(", ")} for ${m.duration}`,

            timing: {
              repeat: {
                frequency,
                period: 1,
                periodUnit: "d",
                boundsDuration: {
                  value: days,
                  unit: "days"
                }
              }
            },

            route: {
              text: m.type || "oral"
            },

            doseAndRate: [
              {
                doseQuantity: {
                  value: m.quantity || 1,
                  unit: "tablet"
                }
              }
            ]
          };
        }),

        // 🧪 Tests
        supportingInfo: tests.map((t) => ({
          display: t.test_name || JSON.stringify(t)
        }))
      };

      const bundle = {
        resourceType: "Bundle",
        type: "searchset",
        total: 1,
        entry: [{ resource }]
      };

      res.setHeader("Content-Type", "application/fhir+json");
      res.status(200).json(bundle);

    } catch (err) {
      console.error("FHIR latest prescription error:", err.message);

      res.status(500).json({
        resourceType: "OperationOutcome",
        issue: [{
          severity: "error",
          code: "exception",
          diagnostics: err.message
        }]
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   💊 PHARMACY VIEW OF PRESCRIPTIONS  (H3, 10 Nov 2026)

   Used by Sales → New sale → Existing patient (PrescriptionsPanel.jsx and
   ExistingClient.js). Guarded by pharmacy permissions, not clinic roles, so a
   pharmacist can see a patient's prescriptions without being a doctor or
   receptionist. Everything is scoped to the caller's own pharmacy (admin_id).

   GET /api/prescriptions/pharmacy/get?patient_id=   list, newest first
   GET /api/prescriptions/pharmacy/get/:id           one, with medicines/tests
   GET /api/prescriptions/pharmacy/resolve/:id       each prescribed medicine
        matched to this pharmacy's stock: { data: [...], summary: {...} }
═══════════════════════════════════════════════════════════════════ */
const { allowPermissions } = require("../middlewares/allowPermissions");
const { resolveScope, batchFilter, sendBranchError } = require("../utils/pharmacyBranch");
const { SQL_STRIPS } = require("../utils/pharmacyStripView");

const RX_PHARMACY_VIEW = allowPermissions("pharmacy.sales.view", "pharmacy.sales.create");

router.get("/pharmacy/get", authMiddleware, RX_PHARMACY_VIEW, async (req, res) => {
  try {
    const adminId = getAdminId(req.user);
    const patientId = Number(req.query.patient_id) || 0;
    if (!patientId) {
      return res.status(400).json({ success: false, message: "patient_id is required" });
    }
    const [rows] = await db.query(
      `SELECT p.id, p.patient_id, p.doctor_id, p.appointment_id, p.diagnosis, p.notes,
              p.created_at, p.updated_at,
              s.name AS doctor_name,
              a.appointment_date,
              COALESCE(JSON_LENGTH(p.medicines_json), 0) AS medicine_count,
              COALESCE(JSON_LENGTH(p.tests_json), 0)     AS test_count
         FROM prescriptions p
         JOIN clients c        ON c.id = p.patient_id AND c.admin_id = ?
    LEFT JOIN staff s          ON s.id = p.doctor_id
    LEFT JOIN appointments a   ON a.id = p.appointment_id
        WHERE p.admin_id = ? AND p.patient_id = ?
        ORDER BY p.created_at DESC
        LIMIT 50`,
      [adminId, adminId, patientId]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Pharmacy prescriptions list error:", err);
    return res.status(500).json({ success: false, message: "Couldn't load prescriptions" });
  }
});

async function loadPharmacyRx(adminId, id) {
  const [[rx]] = await db.query(
    `SELECT p.*, s.name AS doctor_name, c.name AS patient_name
       FROM prescriptions p
       JOIN clients c ON c.id = p.patient_id AND c.admin_id = ?
  LEFT JOIN staff s   ON s.id = p.doctor_id
      WHERE p.id = ? AND p.admin_id = ?`,
    [adminId, id, adminId]
  );
  return rx || null;
}

router.get("/pharmacy/get/:id", authMiddleware, RX_PHARMACY_VIEW, async (req, res) => {
  try {
    const rx = await loadPharmacyRx(getAdminId(req.user), req.params.id);
    if (!rx) return res.status(404).json({ success: false, message: "Prescription not found" });
    return res.json({
      success: true,
      data: {
        id: rx.id,
        patient_id: rx.patient_id,
        patient_name: rx.patient_name,
        doctor_id: rx.doctor_id,
        doctor_name: rx.doctor_name,
        diagnosis: rx.diagnosis,
        notes: rx.notes,
        created_at: rx.created_at,
        medicines: safeParse(rx.medicines_json),
        tests: safeParse(rx.tests_json),
      },
    });
  } catch (err) {
    console.error("Pharmacy prescription detail error:", err);
    return res.status(500).json({ success: false, message: "Couldn't load prescription" });
  }
});

router.get("/pharmacy/resolve/:id", authMiddleware, RX_PHARMACY_VIEW, async (req, res) => {
  try {
    const adminId = getAdminId(req.user);
    const rx = await loadPharmacyRx(adminId, req.params.id);
    if (!rx) return res.status(404).json({ success: false, message: "Prescription not found" });

    // Stock comes from the caller's branch (staff) or the branch the admin picked.
    let scope;
    try {
      scope = await resolveScope(db, req, { wanted: req.query.branch });
    } catch (e) {
      if (sendBranchError(res, e)) return;
      throw e;
    }
    const bf = batchFilter(scope, "b");

    const medicines = safeParse(rx.medicines_json);
    const list = Array.isArray(medicines) ? medicines : [];
    const out = [];
    const summary = { total: list.length, in_stock: 0, out_of_stock: 0, not_in_inventory: 0 };

    for (const m of list) {
      const name = String(m.medicine_name || m.name || "").trim();
      const strength = String(m.strength || "").trim();
      let pharm = null;
      if (name) {
        // Exact name first (with or without the strength appended), then brand, then a
        // prefix match — the clinic and pharmacy catalogues name things slightly differently.
        const [cands] = await db.query(
          `SELECT pm.id, pm.manufacturer, pm.pack_size, pm.units_per_pack, pm.gst_percentage,
                  pm.selling_price, pm.prescription_required,
                  md.medicine_name, md.brand_name, md.generic_name, md.strength, md.dosage_form,
                  CASE
                    WHEN LOWER(md.medicine_name) = LOWER(?) THEN 1
                    WHEN LOWER(CONCAT(md.medicine_name, ' ', COALESCE(md.strength, ''))) = LOWER(?) THEN 1
                    WHEN LOWER(md.brand_name) = LOWER(?) THEN 2
                    ELSE 3
                  END AS rank_
             FROM pharmacy_medicines pm
             JOIN medicine_data md ON md.id = pm.medicine_data_id
            WHERE pm.admin_id = ? AND pm.status = 'active'
              AND (LOWER(md.medicine_name) = LOWER(?)
                   OR LOWER(CONCAT(md.medicine_name, ' ', COALESCE(md.strength, ''))) = LOWER(?)
                   OR LOWER(md.brand_name) = LOWER(?)
                   OR md.medicine_name LIKE CONCAT(?, '%'))
            ORDER BY rank_,
                     (? <> '' AND LOWER(COALESCE(md.strength, '')) = LOWER(?)) DESC,
                     md.medicine_name
            LIMIT 1`,
          [name, `${name} ${strength}`.trim(), name, adminId, name, `${name} ${strength}`.trim(), name, name, strength, strength]
        );
        pharm = cands[0] || null;
      }

      let batches = [];
      if (pharm) {
        // Sellable stock only, oldest expiry first (FEFO). Quantities in whole strips,
        // price per strip — what the sale screen's quantity stepper expects.
        const [b] = await db.query(
          `SELECT b.id, b.batch_number, b.expiry_date, b.branch,
                  ${SQL_STRIPS("b.quantity_available", "b.units_per_pack")} AS quantity_available,
                  b.quantity_available AS quantity_available_tablets,
                  b.units_per_pack, b.selling_price, b.mrp
             FROM pharmacy_medicine_batches b
            WHERE b.admin_id = ? AND b.medicine_id = ? AND b.status = 'active'
              AND (b.expiry_date IS NULL OR b.expiry_date >= CURDATE())
              AND ${SQL_STRIPS("b.quantity_available", "b.units_per_pack")} > 0${bf.sql}
            ORDER BY b.expiry_date IS NULL, b.expiry_date ASC, b.id ASC`,
          [adminId, pharm.id, ...bf.params]
        );
        batches = b;
      }

      const in_stock = batches.length > 0;
      if (!pharm) summary.not_in_inventory += 1;
      else if (!in_stock) summary.out_of_stock += 1;
      else summary.in_stock += 1;

      out.push({
        rx_medicine: {
          medicine_id: m.medicine_id || null,
          medicine_name: name,
          strength,
          quantity: Number(m.quantity) || 1,
          when_to_take: m.when_to_take || null,
          duration: m.duration || null,
          description: m.description || null,
        },
        status: !pharm ? "not_in_inventory" : in_stock ? "in_stock" : "out_of_stock",
        in_stock,
        pharmacy_medicine: pharm
          ? {
              id: pharm.id,
              medicine_name: [pharm.medicine_name, pharm.strength].filter(Boolean).join(" "),
              manufacturer: pharm.manufacturer,
              pack_size: pharm.pack_size,
              gst_percentage: Number(pharm.gst_percentage) || 0,
              prescription_required: !!pharm.prescription_required,
            }
          : null,
        batches,
      });
    }

    return res.json({
      success: true,
      prescription: { id: rx.id, doctor_name: rx.doctor_name, created_at: rx.created_at },
      branch: scope && scope.filter ? scope.key : null,
      data: out,
      summary,
    });
  } catch (err) {
    console.error("Pharmacy prescription resolve error:", err);
    return res.status(500).json({ success: false, message: "Couldn't match the prescription to stock" });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   🔍 GET SINGLE PRESCRIPTION
═══════════════════════════════════════════════════════════════════ */

router.get("/:id", authMiddleware, allowRoles("admin", "doctor", "receptionist"), async (req, res) => {
  try {
    const [[rx]] = await db.execute(
      `SELECT
          p.*,
          c.id   AS patient_cid,
          c.name AS patient_name,
          s.id            AS doctor_sid,
          s.name          AS doctor_name,
          s.qualification AS doctor_qualification,
          s.branch        AS doctor_branch,
          a.company_name AS clinic_name,
          a.company_logo AS clinic_logo_filename,
          a.email        AS clinic_email,
          a.mobile       AS clinic_phone,
          a.address      AS clinic_address,
          ap.appointment_date,
          ap.selected_branch AS branch,
          ap.status          AS appointment_status,
          ap.purpose
       FROM prescriptions p
       LEFT JOIN clients      c  ON c.id  = p.patient_id
       LEFT JOIN staff        s  ON s.id  = p.doctor_id
       LEFT JOIN admins       a  ON a.id  = p.admin_id
       LEFT JOIN appointments ap ON ap.id = p.appointment_id
       WHERE p.id = ?`,
      [req.params.id]
    );

    if (!rx) return res.status(404).json({ success: false, message: "Prescription not found" });

    const SITE_URL = process.env.SITE_URL || "http://localhost:5000";
    const clinicLogo = rx.clinic_logo_filename
      ? `${SITE_URL}/Images/${rx.clinic_logo_filename}`
      : null;

    res.json({
      success: true,
      data: {
        id: rx.id,
        appointment: {
          id: rx.appointment_id || null,
          appointment_date: rx.appointment_date || null,
          status: rx.appointment_status || null,
          purpose: rx.purpose || rx.chief_complaint || "",
        },
        chief_complaint: rx.purpose || rx.chief_complaint || "",
        branch: rx.branch || rx.doctor_branch || "—",
        patient: { id: rx.patient_id, name: rx.patient_name || "—" },
        doctor: rx.doctor_id
          ? { id: rx.doctor_id, name: rx.doctor_name || "—", qualification: rx.doctor_qualification || "" }
          : null,
        clinic: {
          name: rx.clinic_name || "—",
          logo: clinicLogo,
          email: rx.clinic_email || "—",
          phone: rx.clinic_phone || "—",
          address: rx.clinic_address || "—",
        },
        /* medicines already have amount + total_amount stored in JSON */
        medicines: safeParse(rx.medicines_json),
        tests: safeParse(rx.tests_json),
        consultations: safeParse(rx.consultation_type_json),
        notes: rx.notes || "",
        description: rx.description || "",
        diagnosis: rx.diagnosis || "",
        created_at: rx.created_at,
        updated_at: rx.updated_at || null,
      },
    });
  } catch (err) {
    console.error("Get prescription error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get(
  "/fhir/medication/:id",
  authMiddleware,
  allowRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const [[rx]] = await db.execute(
        `SELECT
            p.*,
            c.name AS patient_name,
            s.name AS doctor_name,
            s.qualification AS doctor_qualification,
            ap.appointment_date
         FROM prescriptions p
         LEFT JOIN clients c  ON c.id  = p.patient_id
         LEFT JOIN staff   s  ON s.id  = p.doctor_id
         LEFT JOIN appointments ap ON ap.id = p.appointment_id
         WHERE p.id = ?`,
        [req.params.id]
      );

      if (!rx) {
        return res.status(404).json({
          resourceType: "OperationOutcome",
          issue: [{
            severity: "error",
            code: "not-found",
            diagnostics: "Prescription not found"
          }]
        });
      }

      // ✅ Safe parse
      const parseSafe = (data) => {
        if (!data) return [];
        if (typeof data === "object") return data;
        try {
          return JSON.parse(data);
        } catch {
          return [];
        }
      };

      const medicines = parseSafe(rx.medicines_json);
      const tests = parseSafe(rx.tests_json);
      const consultations = parseSafe(rx.consultation_type_json);

      const entries = [];

      medicines.forEach((m, i) => {
        const medId = `med-${rx.id}-${i + 1}`;

        const timings = Array.isArray(m.when_to_take)
          ? m.when_to_take.join(", ")
          : "";

        const days = m.duration ? parseInt(m.duration) || 1 : 1;

        entries.push({
          resource: {
            resourceType: "MedicationRequest",
            id: `${rx.id}-${i + 1}`,

            status: "active",
            intent: "order",

            // 👤 Patient
            subject: {
              reference: `Patient/${rx.patient_id}`,
              display: rx.patient_name
            },

            // 👨‍⚕️ Doctor
            requester: rx.doctor_id
              ? {
                reference: `Practitioner/${rx.doctor_id}`,
                display: rx.doctor_name
              }
              : undefined,

            authoredOn: rx.created_at,

            // 🔗 Encounter
            encounter: rx.appointment_id
              ? {
                reference: `Encounter/${rx.appointment_id}`,
                display: `Visit on ${rx.appointment_date}`
              }
              : undefined,

            // 🧠 Diagnosis
            reasonCode: rx.description
              ? [{ text: rx.description }]
              : [],

            // 📝 Notes
            note: rx.notes
              ? [{ text: rx.notes }]
              : [],

            // ✅ LINK MEDICINE
            medicationReference: {
              reference: `#${medId}`
            },

            // 💊 DOSAGE
            dosageInstruction: [
              {
                text: `${m.medicine_name} - ${timings} for ${m.duration || ""}`,

                timing: {
                  repeat: {
                    frequency: m.when_to_take?.length || 1,
                    period: 1,
                    periodUnit: "d",
                    boundsDuration: {
                      value: days,
                      unit: "days"
                    }
                  }
                },

                route: {
                  text: m.type || "oral"
                },

                doseAndRate: [
                  {
                    doseQuantity: {
                      value: m.quantity || 1,
                      unit: "tablet"
                    }
                  }
                ]
              }
            ],

            // 💊 CONTAINED MEDICATION
            contained: [
              {
                resourceType: "Medication",
                id: medId,
                code: {
                  text: `${m.medicine_name || "Unknown"} ${m.strength || ""}${m.unit || ""}`
                }
              }
            ],

            // 🧪 TESTS
            supportingInfo: tests.map((t) => ({
              display: t.test_name || JSON.stringify(t)
            })),

            // 🧠 CONSULTATIONS
            category: consultations.map((c) => ({
              text: c.name || JSON.stringify(c)
            }))
          }
        });
      });

      // ✅ FHIR Bundle
      const bundle = {
        resourceType: "Bundle",
        type: "collection",
        total: entries.length,
        entry: entries
      };

      res.setHeader("Content-Type", "application/fhir+json");

      res.status(200).json(bundle);

    } catch (err) {
      console.error("FHIR prescription error:", err.message);

      res.status(500).json({
        resourceType: "OperationOutcome",
        issue: [{
          severity: "error",
          code: "exception",
          diagnostics: err.message
        }]
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   ✏️  UPDATE PRESCRIPTION
   Re-enriches medicines with fresh amount from medicines table.
═══════════════════════════════════════════════════════════════════ */

router.put("/:id", authMiddleware, allowRoles("admin", "doctor"), async (req, res) => {
  try {
    const adminId = getAdminId(req.user);
    const { id } = req.params;

    const {
      medicines = [],
      tests = [],
      consultation_types = [],
      appointment_id,
      save_as_template = true,     // dynamic Rx: refresh the template for the complaint
    } = req.body;

    /* works with notes:{...} object OR flat diagnosis/description/notes fields */
    const {
      chiefComplaint,
      treatmentPlan,
      doctorNotes,
      diagnosis,
    } = readNotes(req.body);

    /* ── Enrich medicines with amount from medicines table ── */
    const enrichedMedicines = await enrichMedicinesWithAmount(medicines, adminId);

    console.log("[UPDATE] Enriched medicines:", JSON.stringify(enrichedMedicines, null, 2));

    /* only overwrite the appointment's purpose with a real complaint */
    if (appointment_id && chiefComplaint) {
      await db.execute(
        `
        UPDATE appointments
        SET purpose = ?
        WHERE id = ? AND admin_id = ?
        `,
        [
          chiefComplaint,
          appointment_id,
          adminId
        ]
      );
    }


    const [result] = await db.execute(
      `
UPDATE prescriptions
SET
appointment_id=?,
chief_complaint=?,
consultation_type_json=?,
medicines_json=?,
tests_json=?,
notes=?,
description=?,
diagnosis=?,
updated_at=NOW()
WHERE id=? AND admin_id=?
`,
      [
        appointment_id ?? null,
        chiefComplaint || null,
        JSON.stringify(consultation_types),
        JSON.stringify(enrichedMedicines),
        JSON.stringify(tests),

        doctorNotes || null,
        treatmentPlan || null,
        diagnosis || null,
        id,
        adminId
      ]
    );
    if (!result.affectedRows)
      return res.status(404).json({ success: false, message: "Prescription not found" });

    /* ── Dynamic Rx: the edited Rx becomes the template for its complaint ── */
    let templateSaved = false;
    if (save_as_template !== false && save_as_template !== "false" && chiefComplaint) {
      let templateDoctorId = req.user.role === "doctor" ? req.user.id : null;
      if (!templateDoctorId) {
        const [[owner]] = await db.execute(
          `SELECT doctor_id FROM prescriptions WHERE id = ? AND admin_id = ?`,
          [id, adminId]
        );
        templateDoctorId = owner?.doctor_id ?? null;
      }
      templateSaved = await rememberComplaintTemplate({
        adminId,
        doctorId: templateDoctorId,
        chiefComplaint,
        diagnosis,
        doctorNotes,
        treatmentPlan,
        medicines: enrichedMedicines,
        tests,
        consultations: req.body.consultation_types,   // undefined → template keeps its own
        prescriptionId: Number(id),
        countUse: false,                               // an edit is not a new use
      });
    }

    try {
      await sendMailForPrescription(id);
    } catch (mailErr) {
      console.warn(`[UPDATE] Mail failed for #${id}:`, mailErr.message);
    }

    res.json({
      success: true,
      message: "Prescription updated successfully",
      template_saved: templateSaved,
    });
  } catch (err) {
    console.error("Update prescription error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   🗑️  DELETE PRESCRIPTION
═══════════════════════════════════════════════════════════════════ */

router.delete("/:id", authMiddleware, allowRoles("admin", "doctor"), async (req, res) => {
  try {
    const adminId = getAdminId(req.user);

    const [result] = await db.execute(
      `DELETE FROM prescriptions WHERE id = ? AND admin_id = ?`,
      [req.params.id, adminId]
    );

    if (!result.affectedRows)
      return res.status(404).json({ success: false, message: "Prescription not found" });

    res.json({ success: true, message: "Prescription deleted" });
  } catch (err) {
    console.error("Delete prescription error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post(
  "/ai-suggest",
  authMiddleware,
  allowRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const data = await suggestPrescription({
        adminId: getAdminId(req.user),
        user: req.user,
        chiefComplaint: req.body.chief_complaint,
        patientId: req.body.patient_id || null,
        extraNotes: req.body.extra_notes || "",
      });
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof AiError) {
        return res.status(err.status).json({ success: false, message: err.message });
      }
      console.error("AI suggest error:", err);
      res.status(500).json({ success: false, message: "Could not get an AI suggestion right now." });
    }
  }
);



module.exports = router;