/*
====================================================================
services/pdf/buildSubmissionHtml.js

Dispatcher. Picks the template that matches this form and hands it the
submission; falls back to the generic renderer when there isn't one.

    submission -> pickTemplate() -> template.render() -> HTML

Same export and signature as before, so renderSubmissionPDF.js and the
HTML preview route need no changes.

The layout lives in pdfTemplates.js, the components in pdfKit.js.
====================================================================
*/

const { pickTemplate, renderGeneric } = require("./pdfTemplates");

function buildSubmissionHtml(submission, opts = {}) {

    // Both are JSON columns; parse defensively for rows written as TEXT
    // so one malformed row can't take down a download.
    let schema = submission.form_schema;
    if (typeof schema === "string") {
        try { schema = JSON.parse(schema); } catch (e) { schema = null; }
    }

    let data = submission.form_data;
    if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (e) { data = {}; }
    }

    const row = { ...submission, form_schema: schema, form_data: data || {} };

    const template = pickTemplate(row);

    if (template) {
        return template.render(row, row.form_data, opts);
    }

    return renderGeneric(row, row.form_data, opts);
}

module.exports = { buildSubmissionHtml };