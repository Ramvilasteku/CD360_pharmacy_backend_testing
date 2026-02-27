const express = require("express");
const router  = express.Router();
const db      = require("../db");
const path = require("path");

const { authMiddleware }          = require("../middlewares/authMiddleware");
const { allowRoles }              = require("../middlewares/roleMiddleware");
const { sendPrescriptionEmail }   = require("../utils/mailer");
const buildPrescriptionPDF        = require("../utils/buildPrescriptionPdf");

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
      `SELECT id, amount FROM medicines
       WHERE id IN (${placeholders}) AND admin_id = ?`,
      [...ids, adminId]
    );
    rows.forEach(r => { amountMap[r.id] = Number(r.amount ?? 0); });
  }

  return medicines.map(m => {
    const unitAmount  = amountMap[m.medicine_id] ?? Number(m.amount ?? 0);
    const qty         = Number(m.quantity ?? 1);
    const totalAmount = unitAmount * qty;

    return {
      ...m,
      amount:       unitAmount,    // unit price
      total_amount: totalAmount,   // unit price × quantity
    };
  });
}

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
        ap.selected_branch  AS branch
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

  const medicines     = safeParse(rx.medicines_json);
  const tests         = safeParse(rx.tests_json);
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

  /* ── BUILD PDF ── */
  const pdfBuffer = await buildPrescriptionPDF({
    clinic: {
      name:    rx.clinic_name    || "—",
      logo:    clinicLogoUrl, // ✅ URL for PDF
      email:   rx.clinic_email   || "—",
      phone:   rx.clinic_phone   || "—",
      address: rx.clinic_address || "—",
    },
    branch:  rx.branch || "—",
    patient: { id: rx.patient_id, name: rx.patient_name || "—" },
    doctor:  {
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
    notes: rx.notes || "",
    description: rx.description || "",
  });

  /* ── SEND EMAIL ── */
  await sendPrescriptionEmail(
    rx.patient_email,
    {
      patientName: rx.patient_name || "Patient",
      doctorName:  rx.doctor_name  || "—",
      clinicName:  rx.clinic_name  || "HealthCare Clinic",

      clinicLogoPath: clinicLogoPath,


      clinicPhone: rx.clinic_phone || "",
      clinicEmail: rx.clinic_email || "",
      date: new Date().toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      }),
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
      tests     = [],
      notes,
      description,
    } = req.body;

    if (!patient_id)
      return res.status(400).json({ success: false, message: "patient_id is required" });

    const resolvedDoctorId =
      req.user.role === "doctor" ? req.user.id : (doctor_id ?? null);

    /* ── Enrich medicines with amount from medicines table ── */
    const enrichedMedicines = await enrichMedicinesWithAmount(medicines, adminId);

    console.log("[CREATE] Enriched medicines:", JSON.stringify(enrichedMedicines, null, 2));

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
        JSON.stringify(consultation_types  ?? []),
        JSON.stringify(enrichedMedicines),          // ← enriched with amount
        JSON.stringify(tests               ?? []),
        notes       ?? null,
        description ?? null,
      ]
    );

    const prescriptionId = result.insertId;

    try {
      await sendMailForPrescription(prescriptionId);
    } catch (mailErr) {
      console.warn(`[CREATE] Mail failed for #${prescriptionId}:`, mailErr.message);
    }

    res.status(201).json({
      success: true,
      message: "Prescription saved successfully",
      data: { prescription_id: prescriptionId },
    });
  } catch (err) {
    console.error("Create prescription error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   📋 LIST PRESCRIPTIONS
═══════════════════════════════════════════════════════════════════ */

router.get("/", authMiddleware, allowRoles("admin", "doctor"), async (req, res) => {
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
    const { patient_id, appointment_id } = req.query;

    if (!patient_id || !appointment_id)
      return res.status(400).json({
        success: false,
        message: "patient_id and appointment_id are required",
      });

    /* 1️⃣ Exact match: patient + appointment */
    let [[rx]] = await db.execute(
      `SELECT p.*, c.name AS patient_name, s.name AS doctor_name
       FROM prescriptions p
       LEFT JOIN clients c ON c.id = p.patient_id
       LEFT JOIN staff   s ON s.id = p.doctor_id
       WHERE p.patient_id = ? AND p.appointment_id = ?
       ORDER BY p.created_at DESC LIMIT 1`,
      [patient_id, appointment_id]
    );

    /* 2️⃣ Fallback: latest prescription for this patient */
    if (!rx) {
      [[rx]] = await db.execute(
        `SELECT p.*, c.name AS patient_name, s.name AS doctor_name
         FROM prescriptions p
         LEFT JOIN clients c ON c.id = p.patient_id
         LEFT JOIN staff   s ON s.id = p.doctor_id
         WHERE p.patient_id = ?
         ORDER BY p.created_at DESC LIMIT 1`,
        [patient_id]
      );
    }

    if (!rx) return res.json({ success: true, data: null });

    const medicines     = safeParse(rx.medicines_json);
    const tests         = safeParse(rx.tests_json);
    const consultations = safeParse(rx.consultation_type_json);

    /* Enrich any legacy rows that don't yet have amount stored */
    const enrichedMedicines = await Promise.all(
      medicines.map(async (m) => {
        if (m.amount != null) return m;
        const [[med]] = await db.execute(
          `SELECT amount FROM medicines WHERE id = ?`,
          [m.medicine_id]
        );
        const unitAmount = Number(med?.amount ?? 0);
        const qty        = Number(m.quantity ?? 1);
        return { ...m, amount: unitAmount, total_amount: unitAmount * qty };
      })
    );

    res.json({
      success: true,
      data: {
        id:            rx.id,
        consultations,
        medicines:     enrichedMedicines,
        tests:         tests.map(t => ({ ...t, cost: t.cost ?? 0 })),
      },
    });
  } catch (err) {
    console.error("by-appointment error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

/* Style A: query params  ?patient_id=X&appointment_id=Y */
router.get("/by-appointment", authMiddleware, (req, res) =>
  byAppointmentHandler(req, res)
);

/* Style B: path params  /by-appointment/:patientId/:appointmentId */
router.get("/by-appointment/:patientId/:appointmentId", authMiddleware, (req, res) => {
  req.query.patient_id     = req.params.patientId;
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
        id:            rx.id,
        consultations: safeParse(rx.consultation_type_json),
        medicines:     safeParse(rx.medicines_json),  // already enriched
        tests:         safeParse(rx.tests_json),
      },
    });
  } catch (err) {
    console.error("patient latest error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   🔍 GET SINGLE PRESCRIPTION
═══════════════════════════════════════════════════════════════════ */

router.get("/:id", authMiddleware, allowRoles("admin", "doctor"), async (req, res) => {
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
          ap.status          AS appointment_status
       FROM prescriptions p
       LEFT JOIN clients      c  ON c.id  = p.patient_id
       LEFT JOIN staff        s  ON s.id  = p.doctor_id
       LEFT JOIN admins       a  ON a.id  = p.admin_id
       LEFT JOIN appointments ap ON ap.id = p.appointment_id
       WHERE p.id = ?`,
      [req.params.id]
    );

    if (!rx) return res.status(404).json({ success: false, message: "Prescription not found" });

    const SITE_URL   = process.env.SITE_URL || "http://localhost:5000";
    const clinicLogo = rx.clinic_logo_filename
      ? `${SITE_URL}/Images/${rx.clinic_logo_filename}`
      : null;

    res.json({
      success: true,
      data: {
        id: rx.id,
        appointment: {
          id:               rx.appointment_id    || null,
          appointment_date: rx.appointment_date  || null,
          status:           rx.appointment_status || null,
        },
        branch:  rx.branch || rx.doctor_branch || "—",
        patient: { id: rx.patient_id, name: rx.patient_name || "—" },
        doctor:  rx.doctor_id
          ? { id: rx.doctor_id, name: rx.doctor_name || "—", qualification: rx.doctor_qualification || "" }
          : null,
        clinic: {
          name:    rx.clinic_name    || "—",
          logo:    clinicLogo,
          email:   rx.clinic_email   || "—",
          phone:   rx.clinic_phone   || "—",
          address: rx.clinic_address || "—",
        },
        /* medicines already have amount + total_amount stored in JSON */
        medicines:     safeParse(rx.medicines_json),
        tests:         safeParse(rx.tests_json),
        consultations: safeParse(rx.consultation_type_json),
        notes:         rx.notes       || "",
        description:   rx.description || "",
        created_at:    rx.created_at,
        updated_at:    rx.updated_at  || null,
      },
    });
  } catch (err) {
    console.error("Get prescription error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   ✏️  UPDATE PRESCRIPTION
   Re-enriches medicines with fresh amount from medicines table.
═══════════════════════════════════════════════════════════════════ */

router.put("/:id", authMiddleware, allowRoles("admin", "doctor"), async (req, res) => {
  try {
    const adminId = getAdminId(req.user);
    const { id }  = req.params;

    const {
      medicines     = [],
      tests         = [],
      notes,
      description,
      consultation_types,
      appointment_id,
    } = req.body;

    /* ── Enrich medicines with amount from medicines table ── */
    const enrichedMedicines = await enrichMedicinesWithAmount(medicines, adminId);

    console.log("[UPDATE] Enriched medicines:", JSON.stringify(enrichedMedicines, null, 2));

    const [result] = await db.execute(
      `UPDATE prescriptions
       SET appointment_id         = ?,
           consultation_type_json = ?,
           medicines_json         = ?,
           tests_json             = ?,
           notes                  = ?,
           description            = ?,
           updated_at             = NOW()
       WHERE id = ? AND admin_id = ?`,
      [
        appointment_id ?? null,
        JSON.stringify(consultation_types ?? []),
        JSON.stringify(enrichedMedicines),           // ← enriched with amount
        JSON.stringify(tests              ?? []),
        notes       ?? null,
        description ?? null,
        id,
        adminId,
      ]
    );

    if (!result.affectedRows)
      return res.status(404).json({ success: false, message: "Prescription not found" });

    try {
      await sendMailForPrescription(id);
    } catch (mailErr) {
      console.warn(`[UPDATE] Mail failed for #${id}:`, mailErr.message);
    }

    res.json({ success: true, message: "Prescription updated successfully" });
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

module.exports = router;