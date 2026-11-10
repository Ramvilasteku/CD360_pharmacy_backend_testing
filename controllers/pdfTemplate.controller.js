const pdf = require("pdf-parse");
const fs = require("fs");
const db = require("../db");
const { detectFormTemplates } = require("../routes/Forms/formSchemas");


/*
====================================
UPLOAD PDF -> DETECT FORM TYPE(S) -> CREATE TEMPLATE(S)
====================================

POST
/api/pdf-template/upload

WHY THIS CHANGED:
The old version always inserted ONE form_template row using a
hardcoded `patientRegistrationSchema` and template_type "registration",
no matter what PDF was uploaded. That's why Sujok, Yoga, and the
clinic add-on PDFs all became the same "registration" form.

Now the extracted text is scored against every schema in the
formSchemas registry. A single PDF can match more than one form
(e.g. "Additional_Clinic_Forms.pdf" bundles the Treatment Tracker,
Treatment Plan, and Photography Consent & Billing pages together),
so we create one form_template row PER match and return all of them.
The frontend then lets the admin turn each detected template into
an actual form.
*/

exports.uploadPDF = async (req, res) => {

    try {

        const file = req.file;

        if (!file) {
            return res.status(400).json({
                message: "PDF file required"
            });
        }

        // Read uploaded PDF
        const buffer = fs.readFileSync(file.path);

        // Extract PDF Text
        const pdfData = await pdf(buffer);
        const extractedText = pdfData.text;

        // Detect every matching form schema for this PDF
        const detected = detectFormTemplates(extractedText);

        const createdTemplates = [];

        for (const tpl of detected) {

            const templateName = detected.length > 1
                ? `${file.originalname} — ${tpl.label}`
                : file.originalname;

            const [result] = await db.query(
                `
                INSERT INTO form_templates
                (
                    template_name,
                    template_type,
                    pdf_file,
                    form_schema
                )
                VALUES(?,?,?,?)
                `,
                [
                    templateName,
                    tpl.template_type,
                    file.path,
                    JSON.stringify(tpl.schema)
                ]
            );

            createdTemplates.push({
                template_id: result.insertId,
                key: tpl.key,
                label: tpl.label,
                template_type: tpl.template_type,
                matched: tpl.matched,
                schema: tpl.schema
            });

        }

        const anyUnmatched = createdTemplates.some(t => !t.matched);

        res.json({

            message: anyUnmatched
                ? "PDF uploaded. Could not confidently detect the form type, so it was defaulted to Patient Registration — please review the fields."
                : createdTemplates.length > 1
                    ? `PDF uploaded. Detected ${createdTemplates.length} separate forms in this document.`
                    : "PDF uploaded and matched to a known form type.",

            templates: createdTemplates,

            extractedText

        });

    }
    catch (err) {

        console.log("PDF Upload Error:", err);

        res.status(500).json({
            message: "PDF upload failed",
            error: err.message
        });

    }

};