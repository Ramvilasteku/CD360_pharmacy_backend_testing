// utils/buildCollectionReportPdf.js
//
// Clean, plain, black-only PDF for the Daily Collection & Credit Dues report.
// - Company name + address at the top (header)
// - Everything else: plain black text, uniform font size (10pt)
// - No colored bars, no colored tiles, no accent colors
//
// Returns Promise<Buffer>.

const PDFDocument = require("pdfkit");
const fs = require("fs");

/* ───── layout constants ───── */
const PAGE_MARGIN = 40;
const FS           = 10;   // one font size everywhere
const FS_TITLE     = 14;   // company name only

/* ───── helpers ───── */
const money = (n) =>
  "Rs. " + Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtDate = (d) => {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
    });
  } catch { return String(d); }
};

/* ───── main ───── */
async function buildCollectionReportPdf({ clinic, period, data }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: PAGE_MARGIN,
        info: {
          Title: `Daily Collection Report ${period.start_date}_${period.end_date}`,
          Author: clinic?.name || "Pharmacy",
        },
      });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      /* set base font + color once; stays black throughout */
      doc.font("Helvetica").fontSize(FS).fillColor("#000");

      drawHeader(doc, clinic, period);
      drawCollectionByMethod(doc, data.collection_summary);
      drawSalesSummary(doc, data.sales_summary);
      drawCreditDues(doc, data.credit_dues);
      drawCustomers(doc, data.credit_dues.customers || []);
      drawFooter(doc);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* ─────────────────────────────────────────────────────────
   HEADER — company name + address only
───────────────────────────────────────────────────────── */
function drawHeader(doc, clinic, period) {
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const y = PAGE_MARGIN;

  /* Logo (if available) — small, left side */
  let textX = PAGE_MARGIN;
  if (clinic?.logo_path && fs.existsSync(clinic.logo_path)) {
    try {
      doc.image(clinic.logo_path, PAGE_MARGIN, y, { fit: [50, 50] });
      textX = PAGE_MARGIN + 60;
    } catch { /* ignore bad logo */ }
  }

  /* Company name — only element with a larger size */
  doc.font("Helvetica-Bold").fontSize(FS_TITLE).fillColor("#000");
  doc.text(clinic?.name || "Pharmacy", textX, y, {
    width: pageWidth - (textX - PAGE_MARGIN),
    align: "left",
  });

  /* Company address + contact — same base font size */
  doc.font("Helvetica").fontSize(FS);
  const addrLines = [];
  if (clinic?.address) addrLines.push(clinic.address);

  const contactBits = [];
  if (clinic?.phone) contactBits.push("Phone: " + clinic.phone);
  if (clinic?.email) contactBits.push("Email: " + clinic.email);
  if (contactBits.length) addrLines.push(contactBits.join("  |  "));

  if (clinic?.gstin) addrLines.push("GSTIN: " + clinic.gstin);

  addrLines.forEach((line) => {
    doc.text(line, textX, doc.y, { width: pageWidth - (textX - PAGE_MARGIN) });
  });

  /* Space, then horizontal rule */
  const headerBottom = Math.max(doc.y, y + 50) + 6;
  doc.moveTo(PAGE_MARGIN, headerBottom)
     .lineTo(doc.page.width - PAGE_MARGIN, headerBottom)
     .lineWidth(0.5).strokeColor("#000").stroke();

  doc.y = headerBottom + 8;

  /* Report title (same font size, bold, centered) */
  doc.font("Helvetica-Bold").fontSize(FS);
  doc.text("Daily Collection & Credit Dues Report", PAGE_MARGIN, doc.y, {
    width: pageWidth, align: "center",
  });
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(FS);
  doc.text(
    "Period: " + (period.label || `${period.start_date} to ${period.end_date}`),
    { width: pageWidth, align: "center" }
  );
  doc.text("Generated: " + fmtDate(new Date()), { width: pageWidth, align: "center" });

  doc.moveDown(1);
}

/* ─────────────────────────────────────────────────────────
   SECTION TITLE (plain, bold, same font size, underlined)
───────────────────────────────────────────────────────── */
function sectionTitle(doc, text) {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(FS).fillColor("#000");
  doc.text(text, PAGE_MARGIN, doc.y);
  const underlineY = doc.y + 1;
  doc.moveTo(PAGE_MARGIN, underlineY)
     .lineTo(doc.page.width - PAGE_MARGIN, underlineY)
     .lineWidth(0.3).strokeColor("#000").stroke();
  doc.font("Helvetica").fontSize(FS);
  doc.moveDown(0.6);
}

/* ─────────────────────────────────────────────────────────
   Key : Value row (plain black, aligned right for value)
───────────────────────────────────────────────────────── */
function kv(doc, label, value, { bold = false } = {}) {
  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const y = doc.y;
  const valW = 150;

  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(FS).fillColor("#000");
  doc.text(label, PAGE_MARGIN, y, { width: pageWidth - valW });
  doc.text(String(value), PAGE_MARGIN + pageWidth - valW, y, {
    width: valW, align: "right",
  });
  doc.moveDown(0.1);
}

/* ─────────────────────────────────────────────────────────
   1. Collection by Method
───────────────────────────────────────────────────────── */
function drawCollectionByMethod(doc, cs) {
  sectionTitle(doc, "1. Collection by Payment Method");

  const methods = [
    ["Cash",          cs.by_method.cash],
    ["UPI",           cs.by_method.upi],
    ["Card",          cs.by_method.card],
    ["Bank Transfer", cs.by_method.bank_transfer],
    ["Mixed",         cs.by_method.mixed],
    ["Credit",        cs.by_method.credit],
  ];

  methods.forEach(([label, m]) => {
    const amt = Number(m?.amount || 0);
    const cnt = Number(m?.count || 0);
    kv(doc, `${label}  (${cnt} payment${cnt === 1 ? "" : "s"})`, money(amt));
  });

  doc.moveDown(0.3);
  kv(doc, `TOTAL COLLECTED  (${cs.total_payments} payments)`,
     money(cs.total_collected), { bold: true });

  doc.moveDown(1);
}

/* ─────────────────────────────────────────────────────────
   2. Sales Summary
───────────────────────────────────────────────────────── */
function drawSalesSummary(doc, s) {
  sectionTitle(doc, "2. Sales Summary");

  kv(doc, "Bills completed",            s.bill_count);
  kv(doc, "Gross sales",                money(s.gross_sales));
  kv(doc, "Less: Returns",              money(s.returns));
  kv(doc, "Net sales",                  money(s.net_sales), { bold: true });
  doc.moveDown(0.3);
  kv(doc, "Collected at sale",          money(s.collected_at_sale));
  kv(doc, "Credit added (new dues)",    money(s.credit_added));

  doc.moveDown(1);
}

/* ─────────────────────────────────────────────────────────
   3. Credit Dues (All-time)
───────────────────────────────────────────────────────── */
function drawCreditDues(doc, cd) {
  sectionTitle(doc, "3. Outstanding Credit Dues (All-time)");

  kv(doc, "Total outstanding",       money(cd.total_outstanding), { bold: true });
  kv(doc, "Customers with dues",     cd.customer_count);
  kv(doc, "Unpaid / partial bills",  cd.bill_count);

  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").fontSize(FS);
  doc.text("Ageing breakdown:", PAGE_MARGIN, doc.y);
  doc.font("Helvetica");
  doc.moveDown(0.2);

  const buckets = [
    ["0 - 30 days",   cd.aging["0-30"]],
    ["31 - 60 days",  cd.aging["31-60"]],
    ["61 - 90 days",  cd.aging["61-90"]],
    ["Over 90 days",  cd.aging["90+"]],
  ];
  buckets.forEach(([label, b]) => {
    kv(doc, `  ${label}  (${b.count} bill${b.count === 1 ? "" : "s"})`,
       money(b.amount));
  });

  doc.moveDown(1);
}

/* ─────────────────────────────────────────────────────────
   4. Customer-wise Outstanding Table
───────────────────────────────────────────────────────── */
function drawCustomers(doc, customers) {
  if (!customers || customers.length === 0) return;

  sectionTitle(doc, "4. Customer-wise Outstanding");

  const pageWidth = doc.page.width - PAGE_MARGIN * 2;

  const cols = [
    { key: "name",   label: "Customer",   w: 150, align: "left"  },
    { key: "phone",  label: "Phone",      w:  90, align: "left"  },
    { key: "bills",  label: "Bills",      w:  40, align: "right" },
    { key: "age",    label: "Oldest",     w:  70, align: "right" },
    { key: "bucket", label: "Bucket",     w:  60, align: "left"  },
    { key: "due",    label: "Amount Due", w: pageWidth - 150 - 90 - 40 - 70 - 60, align: "right" },
  ];

  const headerRow = {
    name: "Customer", phone: "Phone", bills: "Bills",
    age: "Oldest", bucket: "Bucket", due: "Amount Due",
  };

  /* header row */
  drawTableRow(doc, cols, headerRow, { bold: true, underline: true });

  /* data rows */
  let total = 0;
  customers.forEach((c) => {
    if (doc.y > doc.page.height - 60) {
      doc.addPage();
      drawTableRow(doc, cols, headerRow, { bold: true, underline: true });
    }
    const amt = Number(c.total_due || 0);
    total += amt;
    drawTableRow(doc, cols, {
      name:   c.customer_name || "—",
      phone:  c.customer_phone || "—",
      bills:  c.sales_count,
      age:    `${c.days_old} d`,
      bucket: c.aging_bucket,
      due:    money(amt),
    });
  });

  /* total row */
  doc.moveDown(0.2);
  const sepY = doc.y;
  doc.moveTo(PAGE_MARGIN, sepY)
     .lineTo(doc.page.width - PAGE_MARGIN, sepY)
     .lineWidth(0.3).strokeColor("#000").stroke();
  doc.moveDown(0.3);

  drawTableRow(doc, cols, {
    name: "TOTAL", phone: "", bills: "", age: "", bucket: "",
    due: money(total),
  }, { bold: true });
}

function drawTableRow(doc, cols, row, { bold = false, underline = false } = {}) {
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

/* ─────────────────────────────────────────────────────────
   FOOTER — page number on every page
───────────────────────────────────────────────────────── */
function drawFooter(doc) {
  const range = doc.bufferedPageRange(); // { start, count }
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

module.exports = buildCollectionReportPdf;