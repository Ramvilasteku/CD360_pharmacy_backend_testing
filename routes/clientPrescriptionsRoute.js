const express = require("express");
const router  = express.Router();
const db      = require("../db");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles }     = require("../middlewares/roleMiddleware");

/* ───────── Safe JSON Parser ───────── */
const safeParse = (value) => {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return value;
};

/* =====================================================
   GET /api/client/prescriptions
   List all prescriptions for logged-in client
===================================================== */
router.get(
  "/",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;
      const adminId  = req.user.adminId;

      const [rows] = await db.execute(
        `SELECT
           p.id,
           p.created_at,

           JSON_LENGTH(p.consultation_type_json) AS consultation_count,
           JSON_LENGTH(p.medicines_json)         AS medicine_count,
           JSON_LENGTH(p.tests_json)             AS test_count,

           COALESCE(s.name, '')          AS doctor_name,
           COALESCE(s.qualification, '') AS doctor_qualification,
           COALESCE(s.branch, '')        AS branch,

           -- ✅ APPOINTMENT DATA (FIX)
           ap.id               AS appointment_id,
           ap.appointment_date AS appointment_date

         FROM prescriptions p

         LEFT JOIN staff s
           ON s.id = p.doctor_id
          AND s.admin_id = p.admin_id

         -- ✅ JOIN APPOINTMENTS
         LEFT JOIN appointments ap
           ON ap.id = p.appointment_id

         WHERE p.patient_id = ?
           AND p.admin_id   = ?
         ORDER BY p.created_at DESC`,
        [clientId, adminId]
      );

      res.json({
        success: true,
        data: rows,
      });

    } catch (err) {
      console.error("Client list prescriptions error:", err);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

router.get(
  "/fhir/medication-request",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;
      const adminId = req.user.adminId;

      const [rows] = await db.execute(
        `SELECT
           p.id,
           p.created_at,
           p.medicines_json,
           p.tests_json,
           p.notes,
           p.description,

           COALESCE(s.name, '') AS doctor_name,
           COALESCE(s.qualification, '') AS doctor_qualification,
           COALESCE(s.branch, '') AS branch,

           ap.id AS appointment_id,
           ap.appointment_date

         FROM prescriptions p

         LEFT JOIN staff s
           ON s.id = p.doctor_id
          AND s.admin_id = p.admin_id

         LEFT JOIN appointments ap
           ON ap.id = p.appointment_id

         WHERE p.patient_id = ?
           AND p.admin_id = ?
         ORDER BY p.created_at DESC`,
        [clientId, adminId]
      );

      // 🔄 Convert to FHIR Bundle
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

            // 👤 Patient
            subject: {
              reference: `Patient/${clientId}`
            },

            // 👨‍⚕️ Doctor
            requester: r.doctor_name
              ? {
                  display: `${r.doctor_name} (${r.doctor_qualification})`
                }
              : undefined,

            authoredOn: r.created_at,

            // 🧠 Diagnosis
            reasonCode: r.description
              ? [{ text: r.description }]
              : [],

            // 📝 Notes
            note: r.notes
              ? [{ text: r.notes }]
              : [],

            // 💊 Medicines
            contained: medicines.map((m, i) => ({
              resourceType: "Medication",
              id: `med-${i + 1}`,
              code: {
                text: m.name || JSON.stringify(m)
              }
            })),

            // 🧪 Tests
            supportingInfo: tests.map((t) => ({
              display: t.name || JSON.stringify(t)
            })),

            // 🔗 Appointment reference
            encounter: r.appointment_id
              ? {
                  reference: `Encounter/${r.appointment_id}`,
                  display: `Visit on ${r.appointment_date}`
                }
              : undefined
          }
        };
      });

      const bundle = {
        resourceType: "Bundle",
        type: "searchset",
        total: entries.length,
        entry: entries
      };

      res.setHeader("Content-Type", "application/fhir+json");

      res.status(200).json(bundle);

    } catch (err) {
      console.error("FHIR client prescriptions error:", err);

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

/* =====================================================
   GET /api/client/prescriptions/:id
   Full prescription (Preview Compatible Structure)
===================================================== */
router.get(
  "/:id",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;
      const adminId  = req.user.adminId;
      const { id }   = req.params;

      const [[rx]] = await db.execute(
        `SELECT
           p.*,

           -- Doctor
           COALESCE(s.id, NULL)          AS doctor_id,
           COALESCE(s.name, '')          AS doctor_name,
           COALESCE(s.qualification, '') AS doctor_qualification,
           COALESCE(s.branch, '')        AS doctor_branch,

           -- Clinic
           COALESCE(a.name, '')    AS clinic_name,
           COALESCE(a.address, '') AS clinic_address,
           COALESCE(a.email, '')   AS clinic_email,
           COALESCE(a.mobile, '')  AS clinic_phone,

           -- Appointment
           ap.id               AS appointment_id,
           ap.appointment_date AS appointment_date

         FROM prescriptions p

         LEFT JOIN staff s
           ON s.id = p.doctor_id
          AND s.admin_id = p.admin_id

         LEFT JOIN appointments ap
           ON ap.id = p.appointment_id

         INNER JOIN admins a
           ON a.id = p.admin_id

         WHERE p.id         = ?
           AND p.patient_id = ?
           AND p.admin_id   = ?`,
        [id, clientId, adminId]
      );

      if (!rx) {
        return res.status(404).json({
          success: false,
          message: "Prescription not found",
        });
      }

      res.json({
        success: true,
        data: {
          id: rx.id,
          created_at: rx.created_at,

          /* ───── Patient ───── */
          patient: {
            id: clientId,
            name: req.user.name,
          },

          /* ───── Doctor ───── */
          doctor: rx.doctor_id
            ? {
                id: rx.doctor_id,
                name: rx.doctor_name,
                qualification: rx.doctor_qualification,
              }
            : null,

          /* ───── Branch ───── */
          branch: rx.doctor_branch || "—",

          /* ───── Appointment ───── */
          appointment: rx.appointment_id
            ? {
                id: rx.appointment_id,
                appointment_date: rx.appointment_date,
              }
            : null,

          /* ───── Clinic ───── */
          clinic: {
            name: rx.clinic_name,
            address: rx.clinic_address,
            email: rx.clinic_email,
            phone: rx.clinic_phone,
            logo: null,
          },

          /* ───── Sections ───── */
          consultations: safeParse(rx.consultation_type_json),
          medicines:     safeParse(rx.medicines_json),
          tests:         safeParse(rx.tests_json),

          notes: rx.notes || "",
          description: rx.description || "",
        },
      });

    } catch (err) {
      console.error("Client get prescription error:", err);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

router.get(
  "/fhir/medication-request/:id",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;
      const adminId = req.user.adminId;
      const { id } = req.params;

      const [[rx]] = await db.execute(
        `SELECT
           p.*,

           COALESCE(s.id, NULL) AS doctor_id,
           COALESCE(s.name, '') AS doctor_name,
           COALESCE(s.qualification, '') AS doctor_qualification,
           COALESCE(s.branch, '') AS doctor_branch,

           COALESCE(a.name, '') AS clinic_name,
           COALESCE(a.address, '') AS clinic_address,
           COALESCE(a.email, '') AS clinic_email,
           COALESCE(a.mobile, '') AS clinic_phone,

           ap.id AS appointment_id,
           ap.appointment_date

         FROM prescriptions p

         LEFT JOIN staff s
           ON s.id = p.doctor_id
          AND s.admin_id = p.admin_id

         LEFT JOIN appointments ap
           ON ap.id = p.appointment_id

         INNER JOIN admins a
           ON a.id = p.admin_id

         WHERE p.id = ?
           AND p.patient_id = ?
           AND p.admin_id = ?`,
        [id, clientId, adminId]
      );

      if (!rx) {
        return res.status(404).json({
          resourceType: "OperationOutcome",
          issue: [
            {
              severity: "error",
              code: "not-found",
              diagnostics: "Prescription not found"
            }
          ]
        });
      }

      // 🔄 Parse JSON safely
      const medicines = safeParse(rx.medicines_json);
      const tests = safeParse(rx.tests_json);

      // ✅ FHIR Response
      const response = {
        resourceType: "MedicationRequest",
        id: String(rx.id),

        status: "active",
        intent: "order",

        // 👤 Patient
        subject: {
          reference: `Patient/${clientId}`,
          display: req.user.name
        },

        // 👨‍⚕️ Doctor
        requester: rx.doctor_id
          ? {
              reference: `Practitioner/${rx.doctor_id}`,
              display: `${rx.doctor_name} (${rx.doctor_qualification})`
            }
          : undefined,

        authoredOn: rx.created_at,

        // 🏥 Clinic (Organization)
        performer: [
          {
            display: rx.clinic_name
          }
        ],

        // 🔗 Appointment → Encounter
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

        // 💊 Medicines
        contained: medicines.map((m, i) => ({
          resourceType: "Medication",
          id: `med-${i + 1}`,
          code: {
            text: m.name || JSON.stringify(m)
          }
        })),

        // 🧪 Tests
        supportingInfo: tests.map((t) => ({
          display: t.name || JSON.stringify(t)
        }))
      };

      res.setHeader("Content-Type", "application/fhir+json");

      res.status(200).json(response);

    } catch (err) {
      console.error("FHIR prescription detail error:", err);

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

module.exports = router;