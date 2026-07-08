const express = require("express");
const router = express.Router();
const db = require("../db");
const path = require("path");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");
const { sendPrescriptionEmail } = require("../utils/mailer");
const buildPrescriptionPDF = require("../utils/buildPrescriptionPdf");

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
        ap.purpose          AS chief_complaint 
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
      treatmentPlan:  rx.description     || "",
      doctorNotes:    rx.notes           || "",
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
    treatmentPlan:  notesObj.treatmentPlan,    
    doctorNotes:    notesObj.doctorNotes,      
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
      tests = [],
      notes,
      description,
    } = req.body;

    const {
      chiefComplaint,
      treatmentPlan,
      doctorNotes,
    } = notes;

    if (!patient_id)
      return res.status(400).json({ success: false, message: "patient_id is required" });

    const resolvedDoctorId =
      req.user.role === "doctor" ? req.user.id : (doctor_id ?? null);

    /* ── Enrich medicines with amount from medicines table ── */
    const enrichedMedicines = await enrichMedicinesWithAmount(medicines, adminId);

    console.log("[CREATE] Enriched medicines:", JSON.stringify(enrichedMedicines, null, 2));
      if (appointment_id) {
        await db.execute(
          `UPDATE appointments
          SET purpose = ?
          WHERE id = ?`,
          [chiefComplaint || null, appointment_id]
        );
      }
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
        JSON.stringify(consultation_types ?? []),
        JSON.stringify(enrichedMedicines),
        JSON.stringify(tests ?? []),

        doctorNotes || null,      // prescriptions.notes
        treatmentPlan || null,    // prescriptions.description
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
          purpose: rx.purpose || "",
      },
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
  notes = {},
    } = req.body;

    const {
      chiefComplaint,
      treatmentPlan,
      doctorNotes,
    } = notes;

    /* ── Enrich medicines with amount from medicines table ── */
    const enrichedMedicines = await enrichMedicinesWithAmount(medicines, adminId);

    console.log("[UPDATE] Enriched medicines:", JSON.stringify(enrichedMedicines, null, 2));

    if (appointment_id) {
    await db.execute(
        `
        UPDATE appointments
        SET purpose = ?
        WHERE id = ? AND admin_id = ?
        `,
        [
            chiefComplaint || null,
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
consultation_type_json=?,
medicines_json=?,
tests_json=?,
notes=?,
description=?,
updated_at=NOW()
WHERE id=? AND admin_id=?
`,
[
appointment_id ?? null,
JSON.stringify(consultation_types),
JSON.stringify(enrichedMedicines),
JSON.stringify(tests),

doctorNotes || null,
treatmentPlan || null,

id,
adminId
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