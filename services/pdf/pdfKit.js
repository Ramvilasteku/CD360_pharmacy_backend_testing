/*
====================================================================
services/pdf/pdfKit.js

The shared pieces every printed form is built from: the palette, value
formatting, image inlining, and a small set of layout components
(field rows, checkbox grids, ruled write-in lines, signature blocks,
data tables).

Per-form templates in pdfTemplates.js compose these. Nothing in here
knows the name of any particular form.

HEADER COLOUR
-------------
One constant, BAND, used by every section band and every table header.
Change it here and every form follows.
====================================================================
*/

const fs = require("fs");
const path = require("path");

/* ---------------------------- palette --------------------------- */

const BAND = "#437986";        // section bands + table headers
const BAND_TEXT = "#FFFFFF";
const FRAME = "#C9B98B";       // the cream rule around each section body
const INK = "#1F2937";
const MUTED = "#6B7280";
const RULE = "#D8DEE4";        // write-in lines and cell borders

/* ------------------------- image inlining ----------------------- */

const IMAGE_ROOTS = [
    path.join(__dirname, "..", "..", "Images"),
    path.join(__dirname, "..", "..", "images"),
    path.join(__dirname, "..", "..", "public", "Images"),
    path.join(__dirname, "..", "..", "Uploads")
];

const MIME = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"
};

/*
  Chromium gets the page via setContent(), so it has a blank origin: a
  relative src has nothing to resolve against and an absolute one needs
  the server to be reachable from wherever Chromium runs. A broken
  <img> is silent in a PDF, so the bytes are embedded instead.
*/
function inlineImage(src) {
    const value = String(src || "").trim();
    if (!value) return null;
    if (value.startsWith("data:")) return value;
    if (/^https?:\/\//i.test(value)) return value;

    const name = path.basename(value.split("?")[0]);
    const mime = MIME[path.extname(name).toLowerCase()] || "image/png";

    for (const root of IMAGE_ROOTS) {
        const full = path.join(root, name);
        try {
            if (fs.existsSync(full)) {
                return `data:${mime};base64,${fs.readFileSync(full).toString("base64")}`;
            }
        } catch (e) { /* try the next root */ }
    }

    console.log("PDF: image not found for", value, "- looked in", IMAGE_ROOTS);
    return null;
}

/* --------------------------- formatting ------------------------- */

const esc = (v) => String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pad = (n) => String(n).padStart(2, "0");
const dmy = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/*
  Dates print as DD/MM/YYYY, built from LOCAL parts. Two things this
  avoids: String(date) giving "Fri Jul 31 2026 14:15:45 GMT+0530 (India
  Standard Time)" in the middle of a clinical form, and toISOString()
  shifting every date back a day for anyone east of UTC.
*/
function formatDate(value) {
    if (value instanceof Date) return isNaN(value) ? "" : dmy(value);

    const s = String(value ?? "").trim();

    if (ISO_DATE.test(s)) {
        const [y, m, d] = s.split("-");
        return `${d}/${m}/${y}`;
    }
    if (ISO_DATETIME.test(s)) {
        const parsed = new Date(s);
        return isNaN(parsed) ? s : dmy(parsed);
    }
    return s;
}

const looksLikeDate = (v) =>
    v instanceof Date || ISO_DATE.test(String(v)) || ISO_DATETIME.test(String(v));

function val(value) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (looksLikeDate(value)) return formatDate(value);
    if (Array.isArray(value)) {
        return value.map((v) =>
            v && typeof v === "object" ? Object.values(v).join(" · ") : String(v)
        ).join(", ");
    }
    return String(value);
}

/* --------------------------- components ------------------------- */

const BOX_ON = "&#9745;";   // checked
const BOX_OFF = "&#9744;";  // empty

/* A titled band with a bordered body under it. */
const section = (title, inner, opts = {}) => `
<div class="sec ${opts.break ? "brk" : ""}">
  ${title ? `<h2>${esc(title)}</h2>` : ""}
  <div class="secbody">${inner}</div>
</div>`;

/*
  Label + written value on one ruled line. `w` is the share of the row
  this pair takes, so several sit side by side the way they do on the
  printed forms ("City: ___  State: ___  Pin: ___").
*/
const field = (label, value, w = 100) => `
<div class="fld" style="width:${w}%">
  <span class="flabel">${esc(label)}:</span>
  <span class="fline">${esc(val(value)) || "&nbsp;"}</span>
</div>`;

/* Several fields across one row. */
const fieldRow = (pairs) => `
<div class="frow">${
    pairs.map(([label, value, w]) => field(label, value, w || (100 / pairs.length)))
        .join("")
}</div>`;

/* A full-width block: heading over a ruled area, for long answers. */
const block = (label, value) => `
<div class="blk">
  <div class="blabel">${esc(label)}</div>
  <div class="bvalue">${esc(val(value)) || "&nbsp;"}</div>
</div>`;

/*
  Options as tick boxes, `cols` across, matching the source layouts —
  four across on the registration form, three on the Sujok consent.
  Every option prints, ticked or not: a consent record has to show what
  was declined as much as what was agreed.
*/
const checkGrid = (options, selected, cols = 4) => {
    const chosen = Array.isArray(selected)
        ? selected.map(String)
        : selected !== undefined && selected !== null && selected !== ""
            ? [String(selected)] : [];

    return `<div class="cgrid" style="grid-template-columns:repeat(${cols},1fr)">${
        options.map((o) => {
            const on = chosen.includes(String(o));
            return `<span class="copt ${on ? "on" : ""}">${on ? BOX_ON : BOX_OFF} ${esc(o)}</span>`;
        }).join("")
    }</div>`;
};

/* "[ initials ] statement" — the acknowledgement style on the consents. */
const initialList = (statements, selected) => {
    const chosen = Array.isArray(selected) ? selected.map(String) : [];

    return `<div class="inits">${
        statements.map((s) => {
            const on = chosen.includes(String(s));
            return `<div class="init"><span class="ibox">${on ? BOX_ON : "&nbsp;"}</span><span>${esc(s)}</span></div>`;
        }).join("")
    }</div>`;
};

/* Signature line(s) — name/date under a rule, as on the paper form. */
const signRow = (pairs) => `
<div class="sigrow">${
    pairs.map(([label, value]) => `
  <div class="sig">
    <div class="sigline">${esc(val(value)) || "&nbsp;"}</div>
    <div class="siglabel">${esc(label)}</div>
  </div>`).join("")
}</div>`;

/* A bordered grid. `rows` is an array of arrays, or of objects keyed by column. */
const table = (columns, rows, emptyRows = 4) => {
    const list = Array.isArray(rows) ? rows : [];

    const body = list.length
        ? list.map((r) => `<tr>${
            columns.map((c, i) => `<td>${esc(val(Array.isArray(r) ? r[i] : r?.[c]))}</td>`).join("")
          }</tr>`).join("")
        : Array.from({ length: emptyRows }).map(() =>
            `<tr>${columns.map(() => "<td>&nbsp;</td>").join("")}</tr>`).join("");

    return `<table class="grid">
  <thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
  <tbody>${body}</tbody>
</table>`;
};

/* Yes / No / Initials checklist — the master consent tables. */
const checklist = (items, data) => `
<table class="grid checklist">
  <thead><tr><th>Consent Item</th><th>Yes</th><th>No</th></tr></thead>
  <tbody>${
    items.map(([label, key]) => {
        const v = String(val(data?.[key]) || "").toLowerCase();
        return `<tr>
      <td>${esc(label)}</td>
      <td class="c">${v === "yes" ? BOX_ON : BOX_OFF}</td>
      <td class="c">${v === "no" ? BOX_ON : BOX_OFF}</td>
    </tr>`;
    }).join("")
  }</tbody>
</table>`;

const paragraph = (text) => `<div class="para">${esc(text)}</div>`;

const bullets = (items) =>
    `<ul class="bul">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;

const image = (src, caption, maxH = "105mm") => {
    const data = inlineImage(src);
    if (!data) return `<div class="muted">[ image unavailable ]</div>`;
    return `<figure class="fig">
  <img src="${data}" style="max-height:${maxH}" />
  ${caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}
</figure>`;
};

/* ----------------------------- shell ---------------------------- */

const CSS = `
@page { size: A4; }
* { box-sizing: border-box; }
body {
  margin:0; color:${INK}; line-height:1.4;
  font-family:"Times New Roman", Georgia, serif; font-size:10pt;
}
.title { text-align:center; font-size:15pt; font-weight:bold; letter-spacing:.4px; margin:0 0 1mm; }
.subtitle { text-align:center; color:${MUTED}; font-size:9.5pt; margin:0 0 5mm; }

.sec { margin:0 0 5mm; }
.sec.brk { page-break-before: always; }
.sec > h2 {
  background:${BAND}; color:${BAND_TEXT}; margin:0;
  font-size:10pt; font-weight:bold; letter-spacing:.6px;
  text-transform:uppercase; padding:2.2mm 3.5mm;
}
.secbody { border:1px solid ${FRAME}; border-top:none; padding:3.5mm; }

.frow { display:flex; gap:5mm; margin-bottom:2mm; page-break-inside:avoid; }
.fld { display:flex; align-items:baseline; gap:2mm; }
.flabel { font-weight:bold; white-space:nowrap; }
.fline { flex:1; border-bottom:1px solid ${RULE}; min-height:4.6mm; padding:0 1mm; }

.blk { margin-bottom:2.5mm; page-break-inside:avoid; }
.blabel { font-weight:bold; margin-bottom:1mm; }
.bvalue { border-bottom:1px solid ${RULE}; min-height:5mm; padding-bottom:1mm; white-space:pre-wrap; }

.cgrid { display:grid; gap:1.5mm 4mm; margin:1.5mm 0 2.5mm; }
.copt { font-size:9.5pt; }
.copt.on { font-weight:bold; }

.inits { margin:2mm 0; }
.init { display:flex; gap:2.5mm; margin-bottom:1.6mm; page-break-inside:avoid; }
.ibox { display:inline-block; min-width:9mm; border:1px solid ${INK}; text-align:center; }

.sigrow { display:flex; gap:8mm; margin-top:4mm; page-break-inside:avoid; }
.sig { flex:1; }
.sigline { border-bottom:1px solid ${INK}; min-height:7mm; padding-bottom:1mm; }
.siglabel { font-size:9pt; color:${MUTED}; margin-top:1mm; }

table.grid { width:100%; border-collapse:collapse; font-size:9.5pt; margin:1.5mm 0 2mm; }
table.grid th {
  background:${BAND}; color:${BAND_TEXT}; text-align:left;
  font-weight:bold; padding:1.8mm 2.5mm; border:1px solid ${BAND};
}
table.grid td { border:1px solid ${RULE}; padding:1.8mm 2.5mm; vertical-align:top; }
table.grid td.c { text-align:center; width:14mm; }

.para { font-size:9.5pt; text-align:justify; margin:1.5mm 0 2mm; }
.bul { margin:1mm 0 2mm 5mm; padding:0; font-size:9.5pt; }
.bul li { margin-bottom:.8mm; }

.fig { margin:2mm 0 0; text-align:center; }
.fig img { max-width:100%; border:1px solid ${RULE}; }
.fig figcaption { color:${MUTED}; font-size:8.5pt; margin-top:1.5mm; }

.muted { color:${MUTED}; }
.meta { display:flex; flex-wrap:wrap; gap:1.5mm 8mm; font-size:9.5pt; }
.meta span { color:${MUTED}; }
`;

/* Wraps a template's body in the page shell. */
function page(title, subtitle, body) {
    return `<!doctype html>
<html><head><meta charset="utf-8" /><style>${CSS}</style></head>
<body>
  <div class="title">${esc(title || "")}</div>
  ${subtitle ? `<div class="subtitle">${esc(subtitle)}</div>` : ""}
  ${body}
</body></html>`;
}

/* Every form ends with the same provenance block. */
function submissionFooter(submission) {
    return section("Submission Details", `
  <div class="meta">
    <div><span>Patient:</span> <b>${esc(submission.client_name || "—")}</b></div>
    <div><span>Client ID:</span> <b>${esc(submission.client_id || "—")}</b></div>
    <div><span>Submitted on:</span> <b>${esc(formatDate(submission.created_at) || "—")}</b></div>
    <div><span>Submitted by:</span> <b>${esc(submission.submitted_by || "—")}</b></div>
    <div><span>Reference:</span> <b>#${esc(submission.id)}</b></div>
  </div>`);
}

module.exports = {
    BAND, FRAME, INK, MUTED, RULE,
    esc, val, formatDate, inlineImage,
    section, field, fieldRow, block, checkGrid, initialList,
    signRow, table, checklist, paragraph, bullets, image,
    page, submissionFooter, BOX_ON, BOX_OFF
};