/*
====================================================================
controllers/formManagement.controller.js — FULL FILE

Changes from your original, all confined to the submissions section
at the bottom (template/form CRUD above is untouched):

1. BUG FIX — getSubmissionById / deleteSubmission
   Were scoping by `admin_id = req.user.id`. Every other function
   here (createForm, getAdminForms) correctly resolves:
       admin_id = role === "admin" ? id : adminId
   For a receptionist, req.user.id is their own id, not the clinic's
   admin_id, so the WHERE clause never matched -> silent 404. Fixed.

2. BUG FOUND — duplicate `exports.getAllSubmissions`
   Your original file defined this twice (once near the top labeled
   "GET ADMIN FORMS", once again near the bottom). The second
   definition silently overwrote the first in the exports object —
   the first was dead code. Removed the duplicate; kept the working
   version. `getAdminForms` (further down) already covers the same
   query independently, so no functionality is lost.

3. NEW — updateSubmissionData
   PUT /submissions/:id — saves edits to a submission's form_data.
   Previously there was no endpoint for this at all.

4. REWRITTEN — downloadSubmissionPDF
   Was a stub returning JSON. Now generates a real PDF via
   Puppeteer, styled to resemble the clinic's form (header,
   sectioned tables). Requires: npm install puppeteer

   NOTE: PDF/edit-form section grouping is a best-guess normalizer
   based on an assumed form_schema shape
   ([{ title, fields: [{id,label,type,options}] }]). Send a real
   form_schema sample from your `forms` table and I'll tighten this
   to match exactly instead of falling back to a flat layout.
====================================================================
*/

const db = require("../db");
const {
    renderSubmissionPDF,
    buildSubmissionHtml
} = require("../services/pdf/renderSubmissionPDF");


/*
====================================================
GET ALL PDF TEMPLATES
====================================================

GET
/api/form-management/templates

*/

exports.getTemplates = async (req, res) => {

    try {

        const [rows] = await db.query(
            `
            SELECT
                id,
                template_name,
                template_type,
                pdf_file,
                created_at

            FROM form_templates

            WHERE status = 1

            ORDER BY id DESC
            `
        );


        return res.json(rows);


    } catch (err) {

        console.log("Get Templates Error:", err);

        return res.status(500).json({
            message: "Failed to fetch templates"
        });

    }

};





/*
====================================================
GET SINGLE TEMPLATE WITH JSON SCHEMA
====================================================

GET
/api/form-management/templates/:id

*/

exports.getTemplateById = async (req, res) => {

    try {

        const { id } = req.params;


        const [rows] = await db.query(

            `
            SELECT *

            FROM form_templates

            WHERE id=?

            `,

            [id]

        );



        if(rows.length === 0){

            return res.status(404).json({

                message:"Template not found"

            });

        }



        let template = rows[0];



        if(typeof template.form_schema === "string"){

            template.form_schema =
                JSON.parse(template.form_schema);

        }



        return res.json(template);



    } catch(err){


        console.log(
            "Get Template Error:",
            err
        );


        return res.status(500).json({

            message:"Failed to get template"

        });


    }

};






/*
====================================================
DELETE TEMPLATE

Removes a detected/uploaded template from form_templates.
This only ever removes the raw template row — it does NOT
touch any `forms` row that may have already been created
from this template in the past (those are independent once
created, per createForm's copy-on-create behavior).

====================================================

DELETE
/api/form-management/templates/:id

*/

exports.deleteTemplate = async (req, res) => {

    try {

        const { id } = req.params;

        const [existing] = await db.query(
            `
            SELECT id
            FROM form_templates
            WHERE id=?
            `,
            [id]
        );

        if (existing.length === 0) {
            return res.status(404).json({
                message: "Template not found"
            });
        }

        await db.query(
            `
            DELETE FROM form_templates
            WHERE id=?
            `,
            [id]
        );

        return res.json({
            success: true,
            message: "Template deleted successfully"
        });

    } catch (err) {

        console.log("Delete Template Error:", err);

        return res.status(500).json({
            message: "Failed to delete template"
        });

    }

};



/*
====================================================
CREATE FORM FROM TEMPLATE

Admin clicks Save Form (after possibly editing fields
in the FormBuilder)

INSERT INTO forms

====================================================

POST
/api/form-management/create

BODY:

{
 template_id: 1,
 form_name: "Patient Registration",
 form_type: "registration",
 form_schema: { ...edited schema from the builder... }   // NEW
}

WHY THIS CHANGED:
The old version IGNORED `form_schema` from the request body and
always re-fetched the schema fresh from `form_templates` by
template_id. That meant any fields the admin added/edited/removed
in FormBuilder before clicking "Save form" were silently discarded —
the saved form always ended up identical to the untouched template.

Now `form_schema` (the admin's current, edited version) is used
when present. `template_id` is now optional and only used as a
fallback if no edited schema was sent (e.g. saving without ever
opening the builder).
====================================================
*/

exports.createForm = async(req,res)=>{

    try{

        const {
            template_id,
            form_name,
            form_type,
            form_schema
        } = req.body;

        const { id, role, adminId } = req.user;

        const admin_id =
            role === "admin"
            ? id
            : adminId;

        if(!admin_id){
            return res.status(400).json({
                message:"Admin ID not associated with this user"
            });
        }

        let schema = form_schema;

        if(!schema && template_id){
            const [templateRows] = await db.query(
                `
                SELECT form_schema
                FROM form_templates
                WHERE id=?
                `,
                [template_id]
            );

            if(templateRows.length===0){
                return res.status(404).json({
                    message:"Template not found"
                });
            }

            schema = templateRows[0].form_schema;

            if(typeof schema === "string"){
                schema = JSON.parse(schema);
            }
        }

        if(!schema){
            return res.status(400).json({
                message:"Form schema required"
            });
        }

        const [result] = await db.query(
            `
            INSERT INTO forms
            (
                admin_id,
                form_name,
                form_type,
                form_schema,
                created_by
            )
            VALUES(?,?,?,?,?)
            `,
            [
                admin_id,
                form_name,
                form_type,
                JSON.stringify(schema),
                req.user.id
            ]
        );

        return res.json({
            success:true,
            message:"Form created successfully",
            form_id:result.insertId
        });

    }
    catch(err){
        console.log("Create Form Error:", err);
        return res.status(500).json({
            message:"Form creation failed",
            error:err.message
        });
    }
};








/*
====================================================
UPDATE FORM SCHEMA

Admin edits an EXISTING, already-created form:
- add field
- delete field
- change label
- change type
- reorder fields

This only ever touches the one form identified by :id — the
fields added here never leak into any other form's schema.

====================================================


PUT

/api/form-management/update/:id


BODY:

{
 form_schema:{}
}

*/

exports.updateFormSchema = async(req,res)=>{


    try{


        const {
            id
        } = req.params;



        const {
            form_schema,
            form_name
        } = req.body;


        if(!form_schema){
            return res.status(400).json({
                message:"form_schema is required"
            });
        }


        if(form_name){

            await db.query(

                `
                UPDATE forms

                SET

                form_schema=?,
                form_name=?,
                updated_at=CURRENT_TIMESTAMP


                WHERE id=?

                `,


                [

                    JSON.stringify(form_schema),

                    form_name,

                    id

                ]

            );

        }
        else{

            await db.query(

                `
                UPDATE forms

                SET

                form_schema=?,

                updated_at=CURRENT_TIMESTAMP


                WHERE id=?

                `,


                [

                    JSON.stringify(form_schema),

                    id

                ]

            );

        }




        return res.json({

            success:true,

            message:"Form updated successfully"

        });



    }

    catch(err){


        console.log(
            "Update Form Error:",
            err
        );



        return res.status(500).json({

            message:"Form update failed"

        });


    }


};



/*
====================================================
GET FORM DETAILS FOR EDIT / PREVIEW

Returns the schema for ONE specific form, scoped to
that form's own id — this is what the Preview and Edit
buttons on the forms list call.

====================================================

GET

/api/form-management/form/:id

*/

exports.getFormById = async(req,res)=>{


    try{


        const {
            id
        }=req.params;



        const [rows] = await db.query(

            `
            SELECT

                id,

                form_name,

                form_type,

                form_schema


            FROM forms


            WHERE id=?

            `,


            [
                id
            ]

        );



        if(rows.length===0){

            return res.status(404).json({

                message:"Form not found"

            });

        }




        let form = rows[0];



        if(typeof form.form_schema==="string"){

            form.form_schema =
            JSON.parse(form.form_schema);

        }




        return res.json(form);



    }
    catch(err){


        console.log(
            "Get Form Error:",
            err
        );


        return res.status(500).json({

            message:"Failed to fetch form"

        });


    }


};








/*
====================================================
DELETE FORM

====================================================

DELETE

/api/form-management/delete/:id

*/

exports.deleteForm = async(req,res)=>{


    try{


        const {
            id
        } = req.params;




        await db.query(

            `
            DELETE FROM forms

            WHERE id=?

            `,

            [
                id
            ]

        );




        return res.json({

            success:true,

            message:"Form deleted successfully"

        });



    }

    catch(err){


        console.log(
            "Delete Form Error:",
            err
        );



        return res.status(500).json({

            message:"Delete failed"

        });


    }


};


// =====================================
// GET ALL FORM SUBMISSIONS
// =====================================
//
// GET
// /api/form-management/submissions
//
// (NOTE: this was previously defined twice in the file — once
// under a "GET ADMIN FORMS" comment near the top, once again here.
// The duplicate has been removed; this is the single surviving,
// correctly role-scoped version.)
//
// =====================================

exports.getAllSubmissions = async(req,res)=>{

    try{

        const {
            id,
            role,
            adminId
        } = req.user;


        const admin_id =
            role === "admin"
            ? id
            : adminId;


        const [rows] = await db.query(
            `
            SELECT

                fs.id,
                fs.form_id,
                fs.client_id,
                fs.form_data,
                fs.created_at,

                f.form_name,
                f.form_type,

                c.name AS client_name,
                c.email,
                c.mobile


            FROM form_submissions fs


            LEFT JOIN forms f
            ON fs.form_id = f.id


            LEFT JOIN clients c
            ON fs.client_id = c.id


            WHERE f.admin_id=?


            ORDER BY fs.id DESC

            `,
            [
                admin_id
            ]
        );



        rows.forEach(row=>{

            if(typeof row.form_data === "string"){

                row.form_data =
                JSON.parse(row.form_data);

            }

        });



        return res.json(rows);


    }
    catch(err){

        console.log(
            "Get Submissions Error:",
            err
        );


        return res.status(500).json({

            message:"Failed to fetch submissions"

        });

    }

};


/*
====================================================
LIST THE ADMIN'S CREATED FORMS

GET /api/form-management/forms

WHY THIS EXISTS
---------------
Formslist.jsx was calling /form-management/admin/forms to render "your
forms". That endpoint (getAdminForms, just below) queries
form_submissions, not forms — so the list showed one row per PATIENT
SUBMISSION, repeated the same form once per submission, and handed
`fs.id` to the Preview / Edit / Delete buttons. Those buttons pass that
id to /form/:id and /delete/:id, which look up the `forms` table, so a
submission id was being used as a form id: at best a 404, at worst
deleting an unrelated form.

This is the endpoint that list actually wanted. It returns one row per
form, plus section/field counts so the UI can show them without
shipping the whole schema down the wire.
====================================================
*/
exports.getForms = async (req, res) => {
    try {
        const { id, role, adminId } = req.user;
        const admin_id = role === "admin" ? id : adminId;

        if (!admin_id) {
            return res.status(400).json({
                message: "Admin ID not associated with this user"
            });
        }

        const [rows] = await db.query(
            `
            SELECT
                f.id,
                f.form_name,
                f.form_type,
                f.description,
                f.form_schema,
                f.created_at,
                f.updated_at,

                (
                    SELECT COUNT(*)
                    FROM form_submissions fs
                    WHERE fs.form_id = f.id
                ) AS submission_count

            FROM forms f

            WHERE f.admin_id = ?
            AND f.status = 1

            ORDER BY f.id DESC
            `,
            [admin_id]
        );

        const forms = rows.map((row) => {
            let schema = row.form_schema;

            if (typeof schema === "string") {
                try {
                    schema = JSON.parse(schema);
                } catch (e) {
                    schema = null;
                }
            }

            const sections =
                schema && Array.isArray(schema.sections) ? schema.sections
                : Array.isArray(schema) ? [{ fields: schema }]
                : schema && Array.isArray(schema.fields) ? [{ fields: schema.fields }]
                : [];

            const field_count = sections.reduce(
                (total, section) => total + (section.fields || []).length,
                0
            );

            // the schema itself is not sent — the list only needs counts
            const { form_schema, ...rest } = row;

            return {
                ...rest,
                section_count: sections.length,
                field_count
            };
        });

        return res.json(forms);

    } catch (err) {
        console.log("Get Forms Error:", err);
        return res.status(500).json({
            message: "Failed to fetch forms"
        });
    }
};


/*
====================================================
GET ADMIN FORMS
====================================================
*/
exports.getAdminForms = async (req, res) => {
    try {
        const admin_id = req.user.id;

        const [rows] = await db.query(
            `
            SELECT
                fs.id, fs.form_id, fs.client_id, fs.form_data,
                fs.submitted_by, fs.created_at,
                f.form_name, f.form_type,
                c.name AS client_name, c.email, c.mobile
            FROM form_submissions fs
            LEFT JOIN forms f ON fs.form_id = f.id
            LEFT JOIN clients c ON fs.client_id = c.id
            WHERE fs.admin_id=?
            ORDER BY fs.id DESC
            `,
            [admin_id]
        );

        rows.forEach(row => {
            if (typeof row.form_data === "string") {
                row.form_data = JSON.parse(row.form_data);
            }
        });

        return res.json(rows);
    } catch (err) {
        console.log("Get Admin Forms Error:", err);
        return res.status(500).json({ message: "Failed to fetch submissions" });
    }
};
// NOTE (pre-existing, not introduced by this patch): this function
// scopes by fs.admin_id = req.user.id, same pattern that was wrong
// in getSubmissionById/deleteSubmission. If receptionists should
// also see the admin dashboard forms list via this endpoint, it
// needs the same role === "admin" ? id : adminId fix. Left as-is
// since you didn't flag this one — say the word and I'll patch it
// too.


// --------------------------------------------------------------
// GET SINGLE SUBMISSION (fixed admin_id scoping)
// --------------------------------------------------------------
exports.getSubmissionById = async (req, res) => {
    try {
        const { id } = req.params;
        const { role, id: userId, adminId } = req.user;
        const admin_id = role === "admin" ? userId : adminId;

        const [rows] = await db.query(
            `
            SELECT
                fs.*,

                f.form_name,
                f.form_type,
                f.form_schema,
                f.description AS form_description,

                c.name          AS client_name,
                c.email,
                c.mobile,
                c.email         AS client_email,
                c.mobile        AS client_mobile,
                c.address       AS client_address,
                c.gender        AS client_gender,
                c.dob           AS client_dob,
                c.blood_group   AS client_blood_group

            FROM form_submissions fs

            LEFT JOIN forms f
            ON fs.form_id = f.id

            LEFT JOIN clients c
            ON fs.client_id = c.id

            WHERE fs.id = ?
            AND fs.admin_id = ?
            `,
            [id, admin_id]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                message: "Submission not found"
            });
        }

        let submission = rows[0];

        if (typeof submission.form_data === "string") {
            submission.form_data = JSON.parse(submission.form_data);
        }

        if (typeof submission.form_schema === "string") {
            submission.form_schema = JSON.parse(submission.form_schema);
        }

        return res.json(submission);

    } catch (err) {
        console.log("Get Submission Error:", err);
        return res.status(500).json({
            message: "Failed to get submission"
        });
    }
};


// --------------------------------------------------------------
// UPDATE SUBMISSION DATA (new — saves edits made in the "open
// entire form with already filled data" editor)
//
// PUT /api/form-management/submissions/:id
// BODY: { form_data: { ... } }
// --------------------------------------------------------------
// NOTE: your form_submissions table has no `updated_at` column, so the
// previous version of this query threw ER_BAD_FIELD_ERROR on every save.
// To track edit times, run this migration and add the column back to the
// SET clause below:
//   ALTER TABLE form_submissions
//     ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL
//     ON UPDATE CURRENT_TIMESTAMP;
exports.updateSubmissionData = async (req, res) => {
    try {
        const { id } = req.params;
        const { form_data } = req.body;
        const { role, id: userId, adminId } = req.user;
        const admin_id = role === "admin" ? userId : adminId;

        if (!form_data) {
            return res.status(400).json({
                message: "form_data is required"
            });
        }

        const [result] = await db.query(
            `
            UPDATE form_submissions
            SET
                form_data = ?
            WHERE id = ?
            AND admin_id = ?
            `,
            [JSON.stringify(form_data), id, admin_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                message: "Submission not found"
            });
        }

        return res.json({
            success: true,
            message: "Submission updated successfully"
        });

    } catch (err) {
        console.log("Update Submission Error:", err);
        return res.status(500).json({
            message: "Failed to update submission"
        });
    }
};


// --------------------------------------------------------------
// DELETE SUBMISSION (fixed admin_id scoping — same bug as above)
// --------------------------------------------------------------
exports.deleteSubmission = async (req, res) => {
    try {
        const { id } = req.params;
        const { role, id: userId, adminId } = req.user;
        const admin_id = role === "admin" ? userId : adminId;

        const [result] = await db.query(
            `
            DELETE FROM form_submissions
            WHERE id = ?
            AND admin_id = ?
            `,
            [id, admin_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                message: "Submission not found"
            });
        }

        return res.json({
            success: true,
            message: "Submission deleted successfully"
        });

    } catch (err) {
        console.log("Delete Submission Error:", err);
        return res.status(500).json({
            message: "Delete failed"
        });
    }
};


/*
====================================================================
PDF / PREVIEW  (replaces the old pdfkit block: buildSections,
buildGroupedSections, extractFieldsFromSchema, formatValue,
drawFieldRow, drawSectionHeading, checkboxGlyph, measureRowHeight
and the old downloadSubmissionPDF — all of that now lives in
services/pdf/ in a form that works for every form_schema, not just
one shape.)
====================================================================
*/


// --------------------------------------------------------------
// Shared loader for the PDF + preview handlers.
//
// The extra clients columns are REQUIRED, not cosmetic:
// form.controller.js -> submitForm() deletes full_name / phone /
// email / address / gender / dob out of form_data and writes them to
// `clients` for registration forms, so without these the whole
// Patient Registration section prints blank.
// (Drop any line here whose column doesn't exist in your table.)
// --------------------------------------------------------------
async function loadSubmission(req) {

    const { id } = req.params;
    const { role, id: userId, adminId } = req.user;

    const admin_id = role === "admin" ? userId : adminId;

    if (!admin_id) {
        return {
            error: 400,
            message: "Admin ID not associated with this user"
        };
    }

    const [rows] = await db.query(
        `
        SELECT
            fs.*,

            f.form_name,
            f.form_type,
            f.form_schema,
            f.description AS form_description,

            c.name          AS client_name,
            c.email         AS client_email,
            c.mobile        AS client_mobile,
            c.address       AS client_address,
            c.gender        AS client_gender,
            c.dob           AS client_dob,
            c.blood_group   AS client_blood_group

        FROM form_submissions fs

        LEFT JOIN forms f
        ON fs.form_id = f.id

        LEFT JOIN clients c
        ON fs.client_id = c.id

        WHERE fs.id = ?
        AND fs.admin_id = ?
        `,
        [id, admin_id]
    );

    if (rows.length === 0) {
        return {
            error: 404,
            message: "Submission not found"
        };
    }

    const submission = rows[0];

    // Both are JSON columns, so mysql2 normally returns them parsed.
    // Parse defensively for rows written as TEXT, and never let one
    // malformed row 500 the whole download.
    if (typeof submission.form_data === "string") {
        try {
            submission.form_data = JSON.parse(submission.form_data);
        } catch (e) {
            submission.form_data = {};
        }
    }

    if (typeof submission.form_schema === "string") {
        try {
            submission.form_schema = JSON.parse(submission.form_schema);
        } catch (e) {
            submission.form_schema = null;
        }
    }

    return { submission };
}


// ?scope=patient hides every field marked doctorOnly in formSchemas.js
function pdfRenderOptions(req) {
    return {
        includeDoctorOnly: req.query.scope !== "patient"
    };
}


// --------------------------------------------------------------
// DOWNLOAD SUBMISSION PDF
//
// GET /api/form-management/submissions/:id/pdf
// GET /api/form-management/submissions/:id/pdf?inline=1
// GET /api/form-management/submissions/:id/pdf?scope=patient
//
// Rendered fully to a Buffer before any header is written. The old
// doc.pipe(res) version could not report an error once the first
// byte was out, so a mid-render failure produced a truncated,
// unopenable file.
// --------------------------------------------------------------
exports.downloadSubmissionPDF = async (req, res) => {

    try {

        const { error, message, submission } = await loadSubmission(req);

        if (error) {
            return res.status(error).json({ message });
        }

        const pdfBuffer = await renderSubmissionPDF(
            submission,
            pdfRenderOptions(req)
        );

        const safeName = String(submission.form_name || "form")
            .replace(/[^a-z0-9]+/gi, "-")
            .replace(/^-|-$/g, "")
            .toLowerCase();

        res.set({
            "Content-Type": "application/pdf",
            "Content-Length": pdfBuffer.length,
            "Content-Disposition":
                `${req.query.inline ? "inline" : "attachment"}; filename="${safeName}-${req.params.id}.pdf"`,
            "Cache-Control": "no-store"
        });

        return res.end(pdfBuffer);

    } catch (err) {

        console.log("PDF Download Error:", err);

        if (!res.headersSent) {
            return res.status(500).json({
                message: "PDF generation failed",
                error: err.message
            });
        }

    }

};


// --------------------------------------------------------------
// PREVIEW SUBMISSION AS HTML (no Chromium process)
//
// GET /api/form-management/submissions/:id/preview
//
// Same markup the PDF is built from — instant, so it suits a
// Preview button and makes schema debugging quick.
// --------------------------------------------------------------
exports.previewSubmissionHtml = async (req, res) => {

    try {

        const { error, message, submission } = await loadSubmission(req);

        if (error) {
            return res.status(error).json({ message });
        }

        res.set("Content-Type", "text/html; charset=utf-8");

        return res.send(
            buildSubmissionHtml(submission, pdfRenderOptions(req))
        );

    } catch (err) {

        console.log("Preview Error:", err);

        return res.status(500).json({
            message: "Preview failed",
            error: err.message
        });

    }

};