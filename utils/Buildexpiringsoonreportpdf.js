// utils/buildExpiringSoonReportPdf.js
//
// Plain, black-only PDF for the Expiring Soon report.
// Returns Promise<Buffer>.

const PDFDocument = require("pdfkit");
const fs = require("fs");

const PAGE_MARGIN = 40;
const FS          = 10;
const FS_TITLE    = 14;

const money = (n) =>
  "Rs. " + Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

const fmtDate = (d) => {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
    });
  } catch { return String(d); }
};

const URGENCY_LABEL = {
  EXPIRED: "EXPIRED",
  DANGER:  "≤ 30d",
  WARNING: "31–60d",
  WATCH:   "61–90d",
};

async function buildExpiringSoonReportPdf({ clinic, summary, items }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",     // wider for 10-column table
        margin: PAGE_MARGIN,
        info: {
          Title: `Expiring Soon Report`,
          Author: clinic?.name || "Pharmacy",
        },
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.font("Helvetica").fontSize(FS).fillColor("#000");

      drawHeader(doc, clinic, summary);
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
function drawHeader(doc, clinic, summary) {
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
  doc.text(
    `Expiring Soon — Next ${summary.window_days} Days + Already Expired`,
    PAGE_MARGIN, doc.y,
    { width: pageWidth, align: "center" }
  );
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
  sectionTitle(doc, "Summary — Money at Risk");
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;

  const kv = (label, value, bold = false) => {
    const y = doc.y;
    const valW = 180;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(FS).fillColor("#000");
    doc.text(label, PAGE_MARGIN, y, { width: pageWidth - valW });
    doc.text(String(value), PAGE_MARGIN + pageWidth - valW, y, {
      width: valW, align: "right",
    });
    doc.moveDown(0.1);
  };

  kv("Total value at risk (at cost)", money(s.total_value_at_cost), true);
  kv("Total batches",                  s.total_batches);
  kv("Total units",                    s.total_qty);
  doc.moveDown(0.3);
  kv("  Expired batches",              `${s.buckets.EXPIRED.count}  (${money(s.buckets.EXPIRED.amount)})`);
  kv("  Expiring in ≤ 30 days",        `${s.buckets.DANGER.count}  (${money(s.buckets.DANGER.amount)})`);
  kv("  Expiring in 31–60 days",       `${s.buckets.WARNING.count}  (${money(s.buckets.WARNING.amount)})`);
  kv("  Expiring in 61–90 days",       `${s.buckets.WATCH.count}  (${money(s.buckets.WATCH.amount)})`);
  doc.moveDown(1);
}

/* ─── Items table ─── */
function drawTable(doc, items) {
  if (!items || items.length === 0) {
    sectionTitle(doc, "Expiring Batches");
    doc.font("Helvetica").fontSize(FS).fillColor("#000");
    doc.text("No batches expiring in the window.", PAGE_MARGIN, doc.y);
    return;
  }

  sectionTitle(doc, `Expiring Batches (${items.length})`);

  const pageWidth = doc.page.width - PAGE_MARGIN * 2;

  /* Landscape → more room; column widths sum to pageWidth */
  const cols = [
    { key: "medicine",  label: "Medicine",     w: 170, align: "left"  },
    { key: "strength",  label: "Strength",     w:  60, align: "left"  },
    { key: "form",      label: "Form",         w:  50, align: "left"  },
    { key: "batch",     label: "Batch No.",    w:  85, align: "left"  },
    { key: "expiry",    label: "Expiry",       w:  70, align: "left"  },
    { key: "days",      label: "Days",         w:  40, align: "right" },
    { key: "qty",       label: "Qty",          w:  40, align: "right" },
    { key: "cost",      label: "Unit Cost",    w:  65, align: "right" },
    { key: "value",     label: "Value @ Cost", w:  80, align: "right" },
    { key: "urgency",   label: "Urgency",      w: pageWidth - 170 - 60 - 50 - 85 - 70 - 40 - 40 - 65 - 80, align: "left" },
  ];

  const headerRow = {
    medicine: "Medicine", strength: "Strength", form: "Form",
    batch: "Batch No.", expiry: "Expiry", days: "Days",
    qty: "Qty", cost: "Unit Cost", value: "Value @ Cost", urgency: "Urgency",
  };

  drawRow(doc, cols, headerRow, { bold: true, underline: true });

  let totalValue = 0;
  let totalQty = 0;
  items.forEach((it) => {
    if (doc.y > doc.page.height - 60) {
      doc.addPage();
      drawRow(doc, cols, headerRow, { bold: true, underline: true });
    }
    totalValue += it.value_at_cost;
    totalQty += it.quantity_available;
    drawRow(doc, cols, {
      medicine: it.medicine_name,
      strength: it.strength || "—",
      form: it.form || "—",
      batch: it.batch_number || "—",
      expiry: fmtDate(it.expiry_date),
      days: it.days_to_expiry < 0 ? `${it.days_to_expiry}` : it.days_to_expiry,
      qty: it.quantity_available,
      cost: money(it.purchase_price).replace("Rs. ", ""),
      value: money(it.value_at_cost).replace("Rs. ", ""),
      urgency: URGENCY_LABEL[it.urgency] || it.urgency,
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
    medicine: "TOTAL", strength: "", form: "", batch: "", expiry: "",
    days: "", qty: totalQty, cost: "",
    value: money(totalValue).replace("Rs. ", ""), urgency: "",
  }, { bold: true });

  /* Legend */
  doc.moveDown(1);
  doc.font("Helvetica").fontSize(FS - 1).fillColor("#000");
  doc.text(
    "Urgency: EXPIRED = past date · ≤ 30d = within one month · 31–60d · 61–90d.  " +
    "Value @ Cost = quantity × purchase price (money at risk of being written off).",
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

module.exports = buildExpiringSoonReportPdf;