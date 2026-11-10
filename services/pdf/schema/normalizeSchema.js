/*
====================================================================
services/pdf/schema/normalizeSchema.js

THE CORE OF THE DYNAMIC RENDERER.

Every form in your `forms` table has a different `form_schema`, so the
PDF layout has to be derived from the schema, not hard-coded. This
module turns any schema shape into ONE canonical render spec that the
HTML renderer understands:

  {
    title, subtitle,
    sections: [{
      title, description, pageBreak,
      blocks: [
        { kind:"grid",   fields:[{label,value,width}] }
        { kind:"textarea", label, value, size }
        { kind:"options",  label, options:[{label,checked}], columns, other }
        { kind:"static",   text }
        { kind:"acks",     items:[{text,initials}] }
        { kind:"sigs",     pairs:[{caption,sig,date}] }
        { kind:"table",    columns, rows }
        { kind:"kv",       rows:[{label,value}] }   // last-resort
      ]
    }]
  }

TWO INPUT PATHS
---------------
1. The schema says what it is  -> obeyed exactly (field.type, field.options,
   field.width, section.title, section.pageBreak...). This is the path you
   want; see README for the small set of hints FormBuilder should save.
2. The schema is thin (labels only, no types) -> types are INFERRED from
   the label and the option shape, so old forms already in the table still
   print as forms rather than as a flat list. Inference rules are all in
   inferType()/blocking below and are deliberately conservative.

Nothing here is specific to any one form. Add a form in FormBuilder and
its PDF follows automatically.
====================================================================
*/

const { createResolver, escapeHtml } = require("../fieldValues");

/* ------------------------------------------------------------------ */
/* type vocabulary                                                     */
/* ------------------------------------------------------------------ */

const TYPE_ALIASES = {
    text: "input", string: "input", email: "input", tel: "input", phone: "input",
    number: "input", date: "input", time: "input", datetime: "input",
    select: "input", dropdown: "input",

    textarea: "textarea", longtext: "textarea", multiline: "textarea",
    address: "textarea", notes: "textarea",

    radio: "radio", radiogroup: "radio",
    checkbox: "checkbox", checkboxes: "checkbox", checkboxgroup: "checkbox",
    multiselect: "checkbox",

    // yes_no is what FieldEditor.jsx actually emits (26 uses in formSchemas.js)
    boolean: "boolean", toggle: "boolean", yesno: "boolean", yes_no: "boolean",
    yesorno: "boolean", consent: "boolean",

    file: "file", upload: "file", attachment: "file", image: "file",

    paragraph: "static", static: "static", html: "static", info: "static",
    description: "static", label: "static", heading: "static", note: "static",

    signature: "signature", sign: "signature", draw: "signature",

    acknowledgement: "acks", acknowledgements: "acks", initials: "acks",

    table: "table", grid: "table", matrix: "table",

    divider: "break", pagebreak: "break", sectionbreak: "break"
};

const LONG_TEXT_HINTS = /(address|history|condition|injur|surger|limitation|allerg|medication|describe|details|reason|remark|comment|note|concern|diagnos|symptom|goal|expectation|pregnan)/i;

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* Table cells are injected as HTML, so anything from the DB is escaped here. */
const escapeCell = (v) => escapeHtml(v).replace(/\r?\n/g, "<br>");

function fieldKey(f) {
    return f.id || f.name || f.key || f.field_id || f.label;
}

function fieldLabel(f) {
    const l = f.label || f.title || f.name || String(fieldKey(f) || "");
    return String(l).replace(/^\w/, (c) => c.toUpperCase());
}

function fieldOptions(f) {
    const raw = f.options || f.choices || f.values || f.items;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((o) => (o && typeof o === "object" ? o.label ?? o.value ?? o.text : o))
        .filter((o) => o !== undefined && o !== null && String(o).trim() !== "")
        .map(String);
}

/** Trusts an explicit type; otherwise infers from options + label. */
function inferType(f) {
    const declared = norm(f.type || f.field_type || f.inputType);
    if (declared && TYPE_ALIASES[declared]) return TYPE_ALIASES[declared];

    const label = String(fieldLabel(f));
    const options = fieldOptions(f);

    if (options.length) {
        return f.multiple || f.multi || declared === "checkbox" ? "checkbox" : "radio";
    }
    if (/signature|signed by/i.test(label)) return "signature";
    if (/^initials?$/i.test(label.trim())) return "input";
    if (/\?\s*$/.test(label)) return "textarea";
    if (LONG_TEXT_HINTS.test(label)) return "textarea";
    if (f.rows && Number(f.rows) > 1) return "textarea";
    return "input";
}

/* ------------------------------------------------------------------ */
/* schema -> sections of raw fields                                    */
/* ------------------------------------------------------------------ */

function extractSections(formSchema) {
    if (!formSchema) return [];

    let root = formSchema;

    // { title, sections:[...] } / { title, fields:[...] } / { pages:[...] }
    if (!Array.isArray(root) && typeof root === "object") {
        if (Array.isArray(root.sections)) root = root.sections;
        else if (Array.isArray(root.pages)) {
            return root.pages.flatMap((page, i) => {
                const secs = Array.isArray(page.sections) ? page.sections : [page];
                return secs.map((s, j) => ({
                    title: s.title || s.name || page.title || "",
                    description: s.description || s.help || null,
                    pageBreak: i > 0 && j === 0,
                    fields: s.fields || s.elements || []
                }));
            });
        } else if (Array.isArray(root.fields)) root = root.fields;
        else if (Array.isArray(root.elements)) root = root.elements;
    }

    if (Array.isArray(root)) {
        if (!root.length) return [];

        // Shape A — [{ title, fields:[...] }]
        if (root.some((s) => Array.isArray(s.fields) || Array.isArray(s.elements))) {
            return root.map((s) => ({
                title: s.title || s.name || s.section || "",
                description: s.description || s.help || s.subtitle || null,
                pageBreak: Boolean(s.pageBreak || s.pageBreakBefore || s.newPage),
                layout: s.layout || null,
                fields: s.fields || s.elements || []
            }));
        }

        // Shape B — flat [{ id, label, section }]
        const bySection = {};
        const order = [];
        root.forEach((f) => {
            const name = f.section || f.group || f.step || "";
            if (!(name in bySection)) {
                bySection[name] = [];
                order.push(name);
            }
            bySection[name].push(f);
        });
        return order.map((name) => ({
            title: name,
            description: null,
            pageBreak: false,
            fields: bySection[name]
        }));
    }

    // Shape C — { "Section title": [fields] }
    if (typeof root === "object") {
        return Object.entries(root).map(([title, fields]) => ({
            title,
            description: null,
            pageBreak: false,
            fields: Array.isArray(fields) ? fields : []
        }));
    }

    return [];
}

/**
 * No usable schema at all: synthesise sections from form_data keys by
 * shared first word ("Emergency name" + "Emergency mobile" -> Emergency),
 * so legacy submissions still print grouped instead of as one long list.
 */
function sectionsFromData(formData) {
    const entries = Object.entries(formData || {});
    if (!entries.length) return [];

    const counts = {};
    entries.forEach(([k]) => {
        const w = k.trim().split(/\s+/);
        if (w.length > 1) counts[w[0]] = (counts[w[0]] || 0) + 1;
    });

    const groups = {};
    const order = [];

    entries.forEach(([key, value]) => {
        const w = key.trim().split(/\s+/);
        const prefix = w.length > 1 && counts[w[0]] >= 2 ? w[0] : null;
        const title = prefix ? prefix.replace(/^\w/, (c) => c.toUpperCase()) : "Details";
        const label = prefix ? w.slice(1).join(" ") : key;

        if (!groups[title]) {
            groups[title] = [];
            order.push(title);
        }

        groups[title].push({
            id: key,
            label: label.replace(/^\w/, (c) => c.toUpperCase()),
            type: Array.isArray(value) ? "checkbox" : undefined,
            options: Array.isArray(value) ? value.map(String) : undefined
        });
    });

    return order.map((title) => ({
        title,
        description: null,
        pageBreak: false,
        fields: groups[title]
    }));
}

/* ------------------------------------------------------------------ */
/* field -> normalized field with its value                            */
/* ------------------------------------------------------------------ */

// Paragraph labels that are pure boilerplate in formSchemas.js — printing
// them as a heading above the consent text just adds noise.
const GENERIC_PARAGRAPH_LABEL =
    /^(consent statement|declaration|statement|note|notes|information|disclaimer|terms)$/i;

function prepareField(f, R) {
    const key = fieldKey(f);
    const label = fieldLabel(f);
    const type = inferType(f);
    const options = fieldOptions(f);
    const candidates = [key, label, f.label, f.name].filter(Boolean);

    return {
        raw: f,
        key,
        label,
        type,
        options,
        required: Boolean(f.required),
        doctorOnly: Boolean(f.doctorOnly),
        width: f.width || (f.colSpan === 2 || f.fullWidth ? "full" : null),
        // paragraph: the prose lives in `description` in every real schema
        text: f.description || f.text || f.content || f.help || label,
        // everything else: `description` is helper text under the label
        hint: type === "static" ? null : (f.description || f.help || null),
        candidates,
        value: R.raw(candidates),
        R
    };
}

/* ------------------------------------------------------------------ */
/* fields -> blocks                                                    */
/* ------------------------------------------------------------------ */

const YESNO = new Set(["yes", "no"]);

function isYesNoField(f) {
    if (f.type === "boolean") return true;
    if ((f.type === "radio" || f.type === "checkbox") && f.options.length &&
        f.options.length <= 2 && f.options.every((o) => YESNO.has(norm(o)))) return true;
    return false;
}

function isLongOptionGroup(f) {
    if (f.type !== "checkbox" && f.type !== "radio") return false;
    if (!f.options.length) return false;
    const avg = f.options.reduce((a, o) => a + o.length, 0) / f.options.length;
    return avg > 55;
}

function columnsFor(options) {
    const longest = options.reduce((m, o) => Math.max(m, o.length), 0);
    if (longest <= 22) return 3;
    if (longest <= 44) return 2;
    return 1;
}

function textareaSize(f) {
    const rows = Number(f.raw.rows || 0);
    if (rows >= 5) return "lg";
    if (rows >= 3) return "md";
    const len = String(f.value == null ? "" : f.value).length;
    if (len > 220) return "lg";
    if (/history|condition|injur|surger|limitation|describe|concern/i.test(f.label)) return "md";
    return "sm";
}

function optionBlock(f) {
    const options = f.options.map((o) => ({
        label: o,
        checked: f.R.isChecked(f.candidates, o)
    }));

    /*
      "Other: ______" is only correct when the schema means "other, please
      specify". A plain option literally called "Other" — gender: Male /
      Female / Other — is a real choice and must stay a checkbox, otherwise
      Gender renders a stray blank line. So it becomes a fill-in only when
      the field has a satellite <key>_other text field, or a value exists, or
      the option text itself asks for specifics.
    */
    const otherValue = f.R.getExact([
        `${f.key} other`,
        `${f.key} other value`,
        `${f.label} other`,
        `other ${f.label}`
    ]);
    const otherOption = f.options.find((o) => /^other\b/i.test(o.trim()));
    const hasOther = Boolean(
        otherOption &&
        (f.hasOtherSatellite || otherValue || /specify|please|:|_/i.test(otherOption))
    );

    return {
        kind: "options",
        label: f.label,
        hint: f.hint,
        // radio = pick exactly one -> circle; checkbox = pick many -> square
        control: f.type === "radio" ? "radio" : "checkbox",
        columns: columnsFor(f.options),
        options: hasOther ? options.filter((o) => !/^other/i.test(o.label)) : options,
        other: hasOther || otherValue ? { value: otherValue } : null
    };
}

function ackBlock(f) {
    const bag = f.value;
    const participantInitials = f.R.getExact([
        `${f.key} initials`, `${f.label} initials`, "Participant initials", "Initials"
    ]);

    const initialsFor = (text, index) => {
        if (bag && !Array.isArray(bag) && typeof bag === "object") {
            const hit = Object.entries(bag).find(([k, v]) => {
                const nk = norm(k);
                return v && (nk === String(index) || nk === norm(text).slice(0, nk.length || 1) ||
                    norm(text).startsWith(nk.slice(0, 14)));
            });
            if (hit) return typeof hit[1] === "string" && hit[1].length <= 6
                ? hit[1] : (participantInitials || "&#10003;");
        }

        const list = Array.isArray(bag) ? bag.map(String) : f.R.selected(f.candidates);
        const ticked = list.some((s) => {
            const a = norm(s);
            if (!a) return false;
            // stored as indexes: [0,1,2] or ["1","2"]
            if (/^\d+$/.test(a)) return Number(a) === index || Number(a) === index + 1;
            // stored as the statement text (possibly truncated)
            return a.length > 2 &&
                (norm(text).startsWith(a.slice(0, 14)) || a.startsWith(norm(text).slice(0, 14)));
        });
        return ticked ? (participantInitials || "&#10003;") : "";
    };

    return {
        kind: "acks",
        label: f.label,
        items: f.options.map((text, i) => ({ text, initials: initialsFor(text, i) }))
    };
}

/** Consent matrix: a run of Yes/No fields becomes one table. */
function yesNoTableBlock(fields, sectionTitle = "") {
    const itemHeader =
        fields[0].raw.itemHeader ||
        (/consent/i.test(sectionTitle) ? "Consent Item"
            : /screening|history|question/i.test(sectionTitle) ? "Question"
            : sectionTitle || "Item");

    const rows = fields.map((f) => {
        const state = f.R.tri(f.candidates);
        // exact-only: a fuzzy match here would pick up the answer itself
        // ("s_surgery initials" ~ "s_surgery") and print "No" as initials
        const initials = f.R.getExact([
            `${f.key} initials`,
            `${f.label} initials`,
            "Participant initials",
            "Initials"
        ]);
        return { label: f.label, state, initials: state === null ? "" : initials };
    });

    // Only keep the Initials column if this form actually collects them
    const wantsInitials =
        rows.some((r) => r.initials) ||
        fields.some((f) => f.raw.initials || f.raw.requireInitials);

    const columns = [
        { label: itemHeader, width: null },
        { label: "Yes", width: "64px", center: true },
        { label: "No", width: "64px", center: true },
        ...(wantsInitials ? [{ label: "Initials", width: "110px", center: true }] : [])
    ];

    return {
        kind: "table",
        columns,
        rows: rows.map((r) => [
            { html: r.label, item: true },
            { checkbox: r.state === true, control: "radio", center: true },
            { checkbox: r.state === false, control: "radio", center: true },
            ...(wantsInitials ? [{ html: r.initials, center: true }] : [])
        ])
    };
}

/**
 * Explicit `type: "table"` field.
 *
 * formSchemas.js uses two variants:
 *   a) columns only  — { columns:["Date","Treatment","Session #","Notes"] }
 *      A log the doctor fills in. Submitted value is expected to be an array
 *      of rows (objects keyed by column, or arrays). With no value we print
 *      blank ruled rows so the printout is still usable on paper.
 *   b) columns + rows — a fixed matrix (row label per line, e.g. a consent
 *      grid). Then the row label becomes the first column.
 */
function schemaTableBlock(f) {
    const cols = (f.raw.columns || f.raw.cols || []).map((c) =>
        typeof c === "object"
            ? {
                  label: c.label || c.title || c.key,
                  key: c.key || c.label,
                  width: c.width || null,
                  center: c.center
              }
            : { label: String(c), key: String(c), width: null }
    );

    const rowLabels = (f.raw.rows || f.raw.items || []).map((r) =>
        typeof r === "object" ? r.label || r.title || r.key : String(r)
    );

    const value = f.value;
    const isYesNoCol = (c) => YESNO.has(norm(c.label));

    /* ---- variant (a): a log, rows come from the submitted data ---- */
    if (!rowLabels.length) {
        const dataRows = Array.isArray(value) ? value : [];

        const cells = (row) =>
            cols.map((c) => {
                const v = Array.isArray(row)
                    ? row[cols.indexOf(c)]
                    : row?.[c.key] ?? row?.[c.label] ?? row?.[norm(c.label)];
                return {
                    html: v === undefined || v === null ? "" : escapeCell(v),
                    center: c.center
                };
            });

        const blankCount = Math.max(
            Number(f.raw.rowCount || 0) || 0,
            dataRows.length ? 0 : 4
        );

        return {
            kind: "table",
            columns: cols.map((c) => ({
                label: c.label,
                width: c.width,
                center: c.center
            })),
            rows: [
                ...dataRows.map(cells),
                ...Array.from({ length: blankCount }, () =>
                    cols.map((c) => ({ html: "", center: c.center }))
                )
            ]
        };
    }

    /* ---- variant (b): fixed matrix ---- */
    const cellValue = (rowLabel, col) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const rowObj = value[rowLabel] ?? value[norm(rowLabel)];
            if (rowObj && typeof rowObj === "object") {
                return rowObj[col.key] ?? rowObj[col.label];
            }
            if (rowObj !== undefined) {
                // { "Website Use": "Yes" } against Yes / No columns
                if (isYesNoCol(col)) return norm(rowObj) === norm(col.label);
                return rowObj;
            }
        }
        return f.R.getExact([`${f.key} ${rowLabel} ${col.label}`, `${rowLabel} ${col.label}`]);
    };

    return {
        kind: "table",
        columns: [
            { label: f.raw.itemHeader || f.label },
            ...cols.map((c) => ({
                label: c.label,
                width: c.width || (isYesNoCol(c) ? "64px" : null),
                center: c.center ?? isYesNoCol(c)
            }))
        ],
        rows: rowLabels.map((rl) => [
            { html: escapeCell(rl), item: true },
            ...cols.map((c) => {
                const v = cellValue(rl, c);
                if (typeof v === "boolean" || isYesNoCol(c)) {
                    return {
                        checkbox: v === true || norm(v) === "yes",
                        control: isYesNoCol(c) ? "radio" : "checkbox",
                        center: true
                    };
                }
                return {
                    html: v === undefined || v === null ? "" : escapeCell(v),
                    center: c.center
                };
            })
        ])
    };
}

/*
  formSchemas.js defines BOTH an option group containing "Other" and a
  separate text field for the value:

      { name:"evening_session",       type:"radio", options:[..., "Other"] }
      { name:"evening_session_other", type:"text",  label:"Other timing (specify)" }

  optionBlock() already prints that value on the "Other: ____" line, so the
  standalone field must be skipped or it appears twice.
*/
function otherSatelliteKeys(fields) {
    const consumed = new Set();
    const groupsWithSatellite = new Set();

    fields.forEach((f) => {
        if (f.type !== "radio" && f.type !== "checkbox") return;
        if (!f.options.some((o) => /^other\b/i.test(String(o).trim()))) return;

        const wanted = [norm(`${f.key}other`), norm(`${f.key}othervalue`)];
        fields.forEach((g) => {
            if (g !== f && wanted.includes(norm(g.key))) {
                consumed.add(g.key);
                groupsWithSatellite.add(f.key);
            }
        });
    });

    return { consumed, groupsWithSatellite };
}

function buildBlocks(allFields, sectionTitle = "") {
    const { consumed, groupsWithSatellite } = otherSatelliteKeys(allFields);
    const fields = allFields
        .filter((f) => !consumed.has(f.key))
        .map((f) =>
            groupsWithSatellite.has(f.key) ? { ...f, hasOtherSatellite: true } : f
        );

    const blocks = [];
    let grid = null;

    const flushGrid = () => {
        if (grid && grid.fields.length) blocks.push(grid);
        grid = null;
    };

    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];

        /* --- consent matrix: run of 3+ yes/no fields --- */
        if (isYesNoField(f)) {
            const run = [];
            let j = i;
            while (j < fields.length && isYesNoField(fields[j])) run.push(fields[j++]);
            if (run.length >= 3) {
                flushGrid();
                blocks.push(yesNoTableBlock(run, sectionTitle));
                i = j - 1;
                continue;
            }
        }

        switch (f.type) {
            case "input": {
                if (!grid) grid = { kind: "grid", fields: [] };
                grid.fields.push({
                    label: f.label.endsWith(":") ? f.label : `${f.label}:`,
                    value: f.R.get(f.candidates),
                    // long labels squeeze the value into an unreadable column
                    width: f.width === "full" ? "full" : (f.label.length > 26 ? "full" : "half")
                });
                break;
            }

            case "boolean": {
                // Rendered as the paper form does it: two boxes, one ticked.
                if (!grid) grid = { kind: "grid", fields: [] };
                const state = f.R.tri(f.candidates);
                grid.fields.push({
                    label: f.label.endsWith(":") ? f.label : `${f.label}:`,
                    yesNo: state,
                    control: "radio", // one answer only
                    width: "half"
                });
                break;
            }

            case "textarea": {
                flushGrid();
                blocks.push({
                    kind: "textarea",
                    label: f.label,
                    hint: f.hint,
                    value: f.R.getMultiline(f.candidates),
                    size: textareaSize(f)
                });
                break;
            }

            case "radio":
            case "checkbox": {
                flushGrid();
                if (f.type === "acks" || isLongOptionGroup(f)) blocks.push(ackBlock(f));
                else if (f.options.length) blocks.push(optionBlock(f));
                else blocks.push({
                    kind: "grid",
                    fields: [{ label: `${f.label}:`, value: f.R.get(f.candidates), width: "half" }]
                });
                break;
            }

            case "acks": {
                flushGrid();
                blocks.push(ackBlock(f));
                break;
            }

            case "static": {
                flushGrid();
                const heading =
                    f.label &&
                    f.label !== f.text &&
                    !GENERIC_PARAGRAPH_LABEL.test(f.label.trim()) &&
                    norm(f.label) !== norm(sectionTitle)
                        ? f.label
                        : null;
                blocks.push({ kind: "static", heading, text: f.text });
                break;
            }

            case "signature": {
                flushGrid();
                const next = fields[i + 1];
                let date = null;
                if (next && next.type === "input" && /date/i.test(next.label)) {
                    date = next.R.get(next.candidates);
                    i++;
                } else {
                    date = f.R.get([`${f.key} date`, `${f.label} date`, `${f.label.replace(/signature/i, "").trim()} date`]);
                }
                blocks.push({
                    kind: "sigs",
                    pairs: [{ caption: f.label, sig: f.R.signature(f.candidates), date }]
                });
                break;
            }

            case "file": {
                flushGrid();
                blocks.push({
                    kind: "file",
                    label: f.label,
                    value: f.value === undefined || f.value === null ? "" : String(f.value)
                });
                break;
            }

            case "table": {
                flushGrid();
                blocks.push(schemaTableBlock(f));
                break;
            }

            case "break": {
                flushGrid();
                blocks.push({ kind: "break" });
                break;
            }

            default: {
                if (!grid) grid = { kind: "grid", fields: [] };
                grid.fields.push({
                    label: `${f.label}:`,
                    value: f.R.get(f.candidates),
                    width: "half"
                });
            }
        }
    }

    flushGrid();

    // merge two consecutive single signature blocks side by side? No —
    // the paper forms stack them, one per line, so keep them separate.
    return blocks;
}

/* ------------------------------------------------------------------ */
/* public                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {object} submission  form_submissions row joined with forms + clients
 * @param {object} [opts]
 *   fallback          extra value source (clientFallback.buildClientFallback)
 *   includeDoctorOnly default true — false hides fields marked doctorOnly in
 *                     formSchemas.js, for a patient-facing copy
 */
function normalizeSchema(submission, opts = {}) {
    const R = createResolver(submission.form_data, opts.fallback);
    const schema = submission.form_schema;
    const includeDoctorOnly = opts.includeDoctorOnly !== false;

    let rawSections = extractSections(schema);
    let inferred = false;

    if (!rawSections.length) {
        rawSections = sectionsFromData(submission.form_data);
        inferred = true;
    }

    const sections = rawSections
        .map((s) => {
            let fields = (s.fields || []).map((f) => prepareField(f, R));

            if (!includeDoctorOnly) fields = fields.filter((f) => !f.doctorOnly);

            const blocks =
                s.layout === "table"
                    ? [yesNoTableBlock(fields, s.title)]
                    : buildBlocks(fields, s.title || "");

            return {
                title: s.title || "",
                description: s.description || null,
                pageBreak: Boolean(s.pageBreak),
                blocks
            };
        })
        // a section whose every field was doctorOnly should disappear entirely,
        // not leave a dangling green bar
        .filter((s) => s.blocks.length);

    const meta =
        schema && !Array.isArray(schema) && typeof schema === "object" ? schema : {};

    return {
        title: meta.title || submission.form_name || "Form",
        subtitle:
            meta.subtitle ||
            meta.tagline ||
            submission.form_description ||
            meta.description ||
            null,
        inferred,
        sections
    };
}

module.exports = {
    normalizeSchema,
    extractSections,
    sectionsFromData,
    inferType,
    TYPE_ALIASES
};