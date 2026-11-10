/* ───────────────────────────────────────────────────────────────────
   PATCH for backend/routes/prescription.routes.js
   Two edits, nothing else in the file changes. server.js needs no change.
─────────────────────────────────────────────────────────────────── */

/* 1. With the other requires at the top, add: */




/* 2. Add this route (anywhere among the other routes — it sat just above
      the "SEND MAIL HELPER" block in the original): */

/* ═══════════════════════════════════════════════════════════════════
   ✨ AI SUGGESTION  — POST /api/prescriptions/ai-suggest
   body: { chief_complaint, patient_id?, extra_notes? }
   Returns a draft (diagnosis, plan, medicines matched to your catalogue,
   tests) for the doctor to review. Saves nothing to the prescription.
═══════════════════════════════════════════════════════════════════ */

