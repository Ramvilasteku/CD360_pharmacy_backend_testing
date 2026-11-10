/*
====================================================================
services/pdf/pdfTemplates.js

One template per printed form, so each PDF comes out looking like its
paper original rather than like a generic key/value dump.

HOW A FORM IS MATCHED
---------------------
Each entry has a `match(submission)`. The first that returns true wins.
Matching is on the form name and the schema title, both normalised, so
"Additional Clinic Forms" and "additional_clinic_forms" both hit.

ADDING A TEMPLATE
-----------------
1. Write `render(submission, data, opts)` using the components in
   pdfKit.js — section, fieldRow, checkGrid, initialList, table,
   checklist, signRow, paragraph, bullets, image.
2. Push it onto TEMPLATES above the generic one.
3. Nothing else changes; buildSubmissionHtml dispatches automatically.

`data` is submission.form_data. Read values by the field `name` from
formSchemas.js — the template decides the layout, the schema decides
the content, and the submission supplies the answers.

Anything with no template falls through to renderGeneric(), which walks
whatever schema it is given. That is the safety net: a form built in
FormBuilder still prints correctly the day it is created, just without
a bespoke layout.
====================================================================
*/

const K = require("./pdfKit");

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const nameOf = (submission) => [
    submission.form_name,
    submission.form_schema && submission.form_schema.title
].map(norm).join(" ");


/* ==================================================================
   ADDITIONAL CLINIC FORMS
   Norwood chart · session tracker · treatment plan · photography
   consent · billing
================================================================== */

function renderAdditionalClinicForms(submission, data, opts) {
    const doc = opts.includeDoctorOnly !== false;

    const parts = [];

    /* --- Norwood reference chart + staging --- */
    parts.push(K.section("Male Pattern Baldness (Hamilton-Norwood Scale)", `
    ${K.image("/Images/norwood-scale.png", "Reference only — the stage selected below.", "112mm")}
    ${doc ? `
    <div class="blk" style="margin-top:3mm">
      <div class="blabel">Hamilton-Norwood Stage</div>
      ${K.checkGrid(
        ["I","II","II A","III","III Vertex","IV","V","VI","VII","Advanced","Vertex Advanced","Frontal Advanced"],
        data.norwood_scale, 4
      )}
    </div>` : ""}
  `));

    /* --- Session tracker --- */
    if (doc) {
        parts.push(K.section("Treatment Session Tracker &amp; Follow-up", `
      ${K.table(
        ["Date", "Treatment / Procedure", "Session #", "Notes / Response"],
        data.session_log, 10
      )}
      ${K.block("Follow-up Notes", data.followup_notes)}
      ${K.signRow([
        ["Doctor Signature", data.tracker_doctor_signature || data.doctor_signature],
        ["Date", data.tracker_date]
      ])}
    `));
    }

    /* --- Treatment plan --- */
    if (doc) {
        parts.push(K.section("Treatment Plan", `
      ${K.block("Recommended Treatments / Procedures", data.recommended_treatments)}
      ${K.table(["Treatment", "Sessions", "Interval", "Expected Results"], data.treatment_table, 4)}
      ${K.block("Home Care / Instructions", data.home_care_instructions)}
    `));
    }

    /* --- Photography consent (the only patient-facing part) --- */
    parts.push(K.section("Clinical Photography Consent", `
    ${K.paragraph("I consent to the use of my photographs for clinical documentation, analysis, and follow-up purposes. My identity will be kept confidential.")}
    <div class="blabel">Photography Consent</div>
    ${K.checkGrid(["Yes, I Consent", "No, I Do Not Consent"], data.photography_consent, 2)}
  `));

    /* --- Billing --- */
    if (doc) {
        parts.push(K.section("Billing Information", `
      ${K.fieldRow([["Consultation Fee", data.consultation_fee], ["Procedure Cost", data.procedure_cost]])}
      ${K.fieldRow([["Products", data.products_cost], ["Discount", data.discount]])}
      ${K.fieldRow([["Total Amount", data.total_amount, 50]])}
      <div class="blabel" style="margin-top:2mm">Payment Mode</div>
      ${K.checkGrid(["Cash", "Card", "UPI", "Net Banking"], data.payment_mode, 4)}
      ${K.fieldRow([["Received By", data.received_by], ["Date", data.billing_date]])}
    `));
    }

    parts.push(K.submissionFooter(submission));

    return K.page("Additional Clinic Forms", null, parts.join(""));
}


/* ==================================================================
   GENERIC — anything without a bespoke template
================================================================== */

function sectionsOf(submission) {
    const s = submission.form_schema;
    if (!s) return [];
    if (Array.isArray(s.sections)) return s.sections;
    if (Array.isArray(s) && s.length && s[0].fields) return s;
    if (Array.isArray(s.fields)) return [{ title: submission.form_name, fields: s.fields }];
    if (Array.isArray(s)) return [{ title: submission.form_name, fields: s }];
    return [];
}

function genericField(f, data) {
    const value = data[f.name];
    const label = f.label || f.name || "";

    if (f.type === "paragraph") return K.paragraph(f.description || label);
    if (f.type === "image") return K.image(f.src, f.caption);

    if (f.type === "table") {
        return `<div class="blk"><div class="blabel">${K.esc(label)}</div>${
            K.table(Array.isArray(f.columns) ? f.columns : [], value)
        }</div>`;
    }

    if (Array.isArray(f.options) && f.options.length) {
        const long = f.options.some((o) => String(o).length > 40);
        return `<div class="blk"><div class="blabel">${K.esc(label)}</div>${
            long ? K.initialList(f.options, value) : K.checkGrid(f.options, value, 3)
        }</div>`;
    }

    if (f.type === "yes_no") {
        return `<div class="blk"><div class="blabel">${K.esc(label)}</div>${
            K.checkGrid(["Yes", "No"], value, 2)
        }</div>`;
    }

    if (f.type === "signature") return K.signRow([[label, value]]);

    const text = K.val(value);
    if (f.type === "textarea" || text.length > 60) return K.block(label, value);

    return K.fieldRow([[label, value, 100]]);
}

function renderGeneric(submission, data, opts) {
    const doc = opts.includeDoctorOnly !== false;

    const body = sectionsOf(submission)
        .map((s) => ({ ...s, fields: (s.fields || []).filter((f) => doc || !f.doctorOnly) }))
        .filter((s) => s.fields.length)
        .map((s) => K.section(s.title || "", `
      ${s.description ? `<div class="para">${K.esc(s.description)}</div>` : ""}
      ${s.fields.map((f) => genericField(f, data)).join("")}
    `))
        .join("");

    const patient = K.section("Patient Details", `
    ${K.fieldRow([["Name", submission.client_name], ["Client ID", submission.client_id]])}
    ${K.fieldRow([
        ["Mobile", submission.client_mobile || submission.mobile],
        ["Email", submission.client_email || submission.email]
    ])}`);

    return K.page(
        submission.form_name || "Form",
        submission.form_description,
        patient + body + K.submissionFooter(submission)
    );
}


/* ==================================================================
   REGISTRY — first match wins
================================================================== */

const TEMPLATES = [
    {
        key: "additional_clinic_forms",
        match: (s) => {
            const n = nameOf(s);
            return n.includes("additionalclinicform")
                || (n.includes("photography") && n.includes("billing"))
                || n.includes("treatmentsessiontracker");
        },
        render: renderAdditionalClinicForms
    }

    /*
      Next up, one per PDF you send:
        patient_registration  — numbered sections, 4-across tick grids,
                                Fitzpatrick table, consent + signatures
        sujok_consent         — clinic letterhead, 3-across therapies,
                                initial boxes, Yes/No/Initials checklist
        yoga_registration     — personal details, batch timings,
                                acknowledgements, master checklist
    */
];

function pickTemplate(submission) {
    return TEMPLATES.find((t) => {
        try { return t.match(submission); } catch (e) { return false; }
    }) || null;
}

module.exports = { TEMPLATES, pickTemplate, renderGeneric };