// utils/buildLowStockReportPdf.js
//
// Plain, black-only PDF for the Low Stock / Reorder Alert report.
// - Company name + address at the top (header)
// - Everything else: plain black text, uniform font size (10pt)
// - No colored bars, no colored tiles, no accent colors
// Returns Promise<Buffer>.

const PDFDocument = require("pdfkit");
const fs = require("fs");

const PAGE_MARGIN = 40;
const FS          = 10;   // uniform
const FS_TITLE    = 14;   // company name only

const fmtDate = (d) => {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
    });
  } catch { return String(d); }
};

async function buildLowStockReportPdf({ clinic, summary, items }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: PAGE_MARGIN,
        info: {
          Title: `Low Stock Reorder Alert`,
          Author: clinic?.name || "Pharmacy",
        },
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.font("Helvetica").fontSize(FS).fillColor("#000");

      drawHeader(doc, clinic);
      drawSummary(doc, summary);
      drawTable(doc, items);
      drawFooter(doc);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* ─── Header ─── */
function drawHeader(doc, clinic) {
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const y = PAGE_MARGIN;

  let textX = PAGE_MARGIN;
  if (clinic?.logo_path && fs.existsSync(clinic.logo_path)) {
    try {
      doc.image(clinic.logo_path, PAGE_MARGIN, y, { fit: [50, 50] });
      textX = PAGE_MARGIN + 60;
    } catch { /* ignore */ }
  }

  doc.font("Helvetica-Bold").fontSize(FS_TITLE).fillColor("#000");
  doc.text(clinic?.name || "Pharmacy", textX, y, {
    width: pageWidth - (textX - PAGE_MARGIN),
    align: "left",
  });

  doc.font("Helvetica").fontSize(FS);
  const addrLines = [];
  if (clinic?.address) addrLines.push(clinic.address);
  const contactBits = [];
  if (clinic?.phone) contactBits.push("Phone: " + clinic.phone);
  if (clinic?.email) contactBits.push("Email: " + clinic.email);
  if (contactBits.length) addrLines.push(contactBits.join("  |  "));

  addrLines.forEach((line) => {
    doc.text(line, textX, doc.y, { width: pageWidth - (textX - PAGE_MARGIN) });
  });

  const headerBottom = Math.max(doc.y, y + 50) + 6;
  doc.moveTo(PAGE_MARGIN, headerBottom)
     .lineTo(doc.page.width - PAGE_MARGIN, headerBottom)
     .lineWidth(0.5).strokeColor("#000").stroke();

  doc.y = headerBottom + 8;

  doc.font("Helvetica-Bold").fontSize(FS);
  doc.text("Low Stock / Reorder Alert", PAGE_MARGIN, doc.y, {
    width: pageWidth, align: "center",
  });
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(FS);
  doc.text("Generated: " + fmtDate(new Date()), { width: pageWidth, align: "center" });
  doc.moveDown(1);
}

/* ─── Section title ─── */
function sectionTitle(doc, text) {
  if (doc.y > doc.page.height - 100) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(FS).fillColor("#000");
  doc.text(text, PAGE_MARGIN, doc.y);
  const underlineY = doc.y + 1;
  doc.moveTo(PAGE_MARGIN, underlineY)
     .lineTo(doc.page.width - PAGE_MARGIN, underlineY)
     .lineWidth(0.3).strokeColor("#000").stroke();
  doc.font("Helvetica").fontSize(FS);
  doc.moveDown(0.6);
}

/* ─── Summary ─── */
function drawSummary(doc, s) {
  sectionTitle(doc, "Reorder Summary");

  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const kv = (label, value, bold = false) => {
    const y = doc.y;
    const valW = 150;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(FS).fillColor("#000");
    doc.text(label, PAGE_MARGIN, y, { width: pageWidth - valW });
    doc.text(String(value), PAGE_MARGIN + pageWidth - valW, y, {
      width: valW, align: "right",
    });
    doc.moveDown(0.1);
  };

  kv("Items needing reorder", s.total_items, true);
  kv("  Out of stock (CRITICAL)", s.out_of_stock);
  kv("  High urgency",            s.high);
  kv("  Medium urgency",          s.medium);
  kv("  Low urgency",             s.low);
  doc.moveDown(0.3);
  kv("Total suggested units to order", s.total_suggested_units, true);
  doc.moveDown(1);
}

/* ─── Items table ─── */
function drawTable(doc, items) {
  if (!items || items.length === 0) {
    sectionTitle(doc, "Items to Reorder");
    doc.font("Helvetica").fontSize(FS).fillColor("#000");
    doc.text("No items need reordering at this time.", PAGE_MARGIN, doc.y);
    return;
  }

  sectionTitle(doc, "Items to Reorder (" + items.length + ")");

  const pageWidth = doc.page.width - PAGE_MARGIN * 2;

  /* Column widths — row totals must equal pageWidth */
  const cols = [
    { key: "name",      label: "Medicine",     w: 150, align: "left"  },
    { key: "strength",  label: "Strength",     w:  55, align: "left"  },
    { key: "form",      label: "Form",         w:  40, align: "left"  },
    { key: "available", label: "Avail",        w:  40, align: "right" },
    { key: "reorder",   label: "Reorder",      w:  48, align: "right" },
    { key: "pct",       label: "Stock %",      w:  48, align: "right" },
    { key: "urgency",   label: "Urgency",      w:  55, align: "left"  },
    { key: "suggested", label: "Order Qty",    w: pageWidth - 150 - 55 - 40 - 40 - 48 - 48 - 55, align: "right" },
  ];

  const headerRow = {
    name: "Medicine", strength: "Strength", form: "Form",
    available: "Avail", reorder: "Reorder", pct: "Stock %",
    urgency: "Urgency", suggested: "Order Qty",
  };

  drawRow(doc, cols, headerRow, { bold: true, underline: true });

  let totalOrder = 0;
  items.forEach((it) => {
    if (doc.y > doc.page.height - 60) {
      doc.addPage();
      drawRow(doc, cols, headerRow, { bold: true, underline: true });
    }
    totalOrder += it.suggested_order;
    drawRow(doc, cols, {
      name:      it.medicine_name,
      strength:  it.strength || "—",
      form:      it.form || "—",
      available: it.quantity_available,
      reorder:   it.reorder_level,
      pct:       it.stock_pct + "%",
      urgency:   it.urgency,
      suggested: it.suggested_order,
    });
  });

  /* Total row */
  doc.moveDown(0.2);
  const sepY = doc.y;
  doc.moveTo(PAGE_MARGIN, sepY)
     .lineTo(doc.page.width - PAGE_MARGIN, sepY)
     .lineWidth(0.3).strokeColor("#000").stroke();
  doc.moveDown(0.3);

  drawRow(doc, cols, {
    name: "TOTAL", strength: "", form: "", available: "", reorder: "",
    pct: "", urgency: "", suggested: totalOrder,
  }, { bold: true });

  /* Note on urgency scale */
  doc.moveDown(1);
  doc.font("Helvetica").fontSize(FS - 1).fillColor("#000");
  doc.text(
    "Urgency: CRITICAL = out of stock · HIGH ≤ 25% · MEDIUM ≤ 50% · LOW ≤ 100%.  " +
    "Order Qty = reorder level × 2 − current stock.",
    PAGE_MARGIN, doc.y, { width: pageWidth, align: "left" }
  );
}

function drawRow(doc, cols, row, { bold = false, underline = false } = {}) {
  const y = doc.y;
  let x = PAGE_MARGIN;

  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(FS).fillColor("#000");

  cols.forEach((col) => {
    doc.text(String(row[col.key] ?? ""), x, y, {
      width: col.w,
      align: col.align,
      lineBreak: false,
      ellipsis: true,
    });
    x += col.w;
  });

  const rowBottom = y + FS + 2;
  if (underline) {
    doc.moveTo(PAGE_MARGIN, rowBottom)
       .lineTo(doc.page.width - PAGE_MARGIN, rowBottom)
       .lineWidth(0.3).strokeColor("#000").stroke();
  }
  doc.y = rowBottom + 2;
}

/* ─── Footer ─── */
function drawFooter(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.height - 25;
    const pageWidth = doc.page.width - PAGE_MARGIN * 2;
    doc.font("Helvetica").fontSize(FS).fillColor("#000");
    doc.text(
      `Page ${i + 1} of ${range.count}`,
      PAGE_MARGIN, bottom,
      { width: pageWidth, align: "center", lineBreak: false }
    );
  }
}

module.exports = buildLowStockReportPdf;