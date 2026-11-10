/*
====================================================================
services/pdf/renderers/formHtml.js

Turns the canonical spec from normalizeSchema() into the print HTML.
This file is intentionally dumb: one small function per block kind, no
decisions about what a field "means" — all of that already happened in
the normalizer. That separation is why a new field type only needs a
change in two obvious places.
====================================================================
*/

const { buildCss } = require("../theme");
const { escapeHtml } = require("../fieldValues");

/* ----------------------------- blocks ---------------------------- */

/* "cb" is a square (multi-select), "rb" is a circle (single-select). */
function marker(control, on) {
    const cls = control === "radio" ? "rb" : "cb";
    return `<span class="${cls}${on ? " on" : ""}"></span>`;
}

/* Yes/No prints as two markers with one filled, like the paper form. */
function yesNoCell(state, control = "radio") {
    return `<span class="yn">${marker(control, state === true)}Yes</span>` +
        `<span class="yn">${marker(control, state === false)}No</span>`;
}

function renderGrid(b) {
    return `<div class="grid">${b.fields
        .map((f) => {
            const value = "yesNo" in f ? yesNoCell(f.yesNo, f.control) : f.value || "";
            const cls = "yesNo" in f ? "v plain" : "v";
            return `<div class="f ${f.width || "half"}">
        <span class="l">${escapeHtml(f.label)}</span><span class="${cls}">${value}</span></div>`;
        })
        .join("")}</div>`;
}

function renderTextarea(b) {
    return `<div class="ta">
    <div class="q">${escapeHtml(b.label)}</div>
    ${b.hint ? `<div class="hint">${escapeHtml(b.hint)}</div>` : ""}
    <div class="box ${b.size || "sm"}">${b.value || ""}</div></div>`;
}

function renderOptions(b) {
    const boxes = b.options
        .map(
            (o) => `<span class="opt">${marker(b.control, o.checked)}${escapeHtml(o.label)}</span>`
        )
        .join("");

    const other = b.other
        ? `<span class="other">${marker(b.control, Boolean(b.other.value))}Other:<span class="v">${b.other.value || ""}</span></span>`
        : "";

    return `<div class="optblock">
    ${b.label ? `<div class="sub">${escapeHtml(b.label)}</div>` : ""}
    ${b.hint ? `<div class="hint">${escapeHtml(b.hint)}</div>` : ""}
    <div class="opts c${b.columns || 2}">${boxes}${other}</div></div>`;
}

function renderStatic(b) {
    return `${b.heading ? `<div class="sub">${escapeHtml(b.heading)}</div>` : ""}
  <p class="body">${escapeHtml(b.text).replace(/\r?\n/g, "<br>")}</p>`;
}

/* File upload: show the image when it is one, otherwise the stored name. */
function renderFile(b) {
    const v = String(b.value || "");
    const isImage = /^data:image\//i.test(v) || /\.(png|jpe?g|gif|webp)$/i.test(v);

    return `<div class="ta">
    <div class="q">${escapeHtml(b.label)}</div>
    ${isImage
        ? `<img class="attach" src="${escapeHtml(v)}" alt="">`
        : `<div class="box sm">${v ? escapeHtml(v.split(/[\\/]/).pop()) : "-"}</div>`}
  </div>`;
}

function renderAcks(b) {
    return `${b.label ? `<div class="sub">${escapeHtml(b.label)}</div>` : ""}
  <div class="acks">${b.items
      .map(
          (i) => `<div class="ack"><div class="ini">${i.initials || ""}</div>
      <div class="t">${escapeHtml(i.text)}</div></div>`
      )
      .join("")}</div>`;
}

function renderSigs(b) {
    return `<div class="sigs">${b.pairs
        .map(
            (p) => `
      <div class="sig"><div class="pad">${p.sig || ""}</div>
        <div class="cap">${escapeHtml(p.caption || "Signature")}</div></div>
      <div class="sig"><div class="pad">${p.date || ""}</div><div class="cap">Date</div></div>`
        )
        .join("")}</div>`;
}

function renderTable(b) {
    const head = b.columns
        .map(
            (c) =>
                `<th${c.center ? ' class="c"' : ""}${c.width ? ` style="width:${c.width}"` : ""}>${escapeHtml(c.label)}</th>`
        )
        .join("");

    const body = b.rows
        .map(
            (row) =>
                `<tr>${row
                    .map((cell) => {
                        const cls = `${cell.item ? "item " : ""}${cell.center ? "c" : ""}`.trim();
                        const inner =
                            cell.checkbox !== undefined
                                ? marker(cell.control, cell.checkbox)
                                : cell.html || "";
                        return `<td${cls ? ` class="${cls}"` : ""}>${inner}</td>`;
                    })
                    .join("")}</tr>`
        )
        .join("");

    // A short table splitting across a page break leaves an orphan row under a
    // repeated header; a long log has to be allowed to flow.
    const nosplit = b.rows.length <= 12 ? " nosplit" : "";

    return `<table class="tbl${nosplit}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderKv(b) {
    return `<table class="kv">${b.rows
        .map(
            (r) =>
                `<tr><td class="k">${escapeHtml(r.label)}</td><td>${
                    r.value === undefined || r.value === null || r.value === "" ? "-" : escapeHtml(r.value)
                }</td></tr>`
        )
        .join("")}</table>`;
}

const BLOCKS = {
    grid: renderGrid,
    textarea: renderTextarea,
    options: renderOptions,
    static: renderStatic,
    acks: renderAcks,
    sigs: renderSigs,
    file: renderFile,
    table: renderTable,
    kv: renderKv,
    break: () => `<div style="break-after:page;page-break-after:always"></div>`
};

function renderBlock(b) {
    const fn = BLOCKS[b.kind];
    return fn ? fn(b) : "";
}

function renderSection(s) {
    return `<section class="section${s.pageBreak ? " pb" : ""}">
    ${s.title ? `<div class="sec">${escapeHtml(String(s.title).toUpperCase())}</div>` : ""}
    ${s.description ? `<p class="sec-desc">${escapeHtml(s.description)}</p>` : ""}
    ${s.blocks.map(renderBlock).join("\n")}
  </section>`;
}

/**
 * @param {object} spec  output of normalizeSchema()
 * @param {object} opts  { theme, meta:[{label,value}], showMeta }
 */
function renderFormHtml(spec, opts = {}) {
    const meta = opts.showMeta && opts.meta && opts.meta.length
        ? renderSection({
              title: "Submission Details",
              blocks: [{ kind: "kv", rows: opts.meta }]
          })
        : "";

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(spec.title)}</title>
<style>${buildCss(opts.theme)}</style></head>
<body>
  <div class="brandbar">
    <h1>${escapeHtml(String(spec.title).toUpperCase())}</h1>
    ${spec.subtitle ? `<p>${escapeHtml(spec.subtitle)}</p>` : ""}
  </div>
  ${spec.sections.map(renderSection).join("\n")}
  ${meta}
</body></html>`;
}

module.exports = { renderFormHtml, renderSection, renderBlock };