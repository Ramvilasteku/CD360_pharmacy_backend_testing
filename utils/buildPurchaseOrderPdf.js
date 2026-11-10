// utils/buildPurchaseOrderPdf.js
//
// A purchase order as a one-or-more page A4 PDF, ready to attach to an email or hand to a
// supplier on WhatsApp. Returns a Buffer; nothing is written to disk.
//
// This is the copy the SUPPLIER receives, so it is deliberately plain: black text on white,
// one sans-serif face (Helvetica), thin black rules, and only what is needed to fill the
// order - who it is from, who it is for, the PO number / dates / deliver-to branch, and the
// medicines. Plain text blocks (no boxes). The table is
//   # / Medicine (+ its pack, e.g. "10's") / Qty (strips) / Free / Rate per strip / Amount
// with the order value (before tax) under it. Tax and payments are settled on the supplier's invoice.
//
//   const pdf = await buildPurchaseOrderPdf({
//     order,      // pharmacy_purchase_orders row (purchase_number, purchase_date, notes, expected_delivery_date, branch)
//     items,      // [{ brand_name, medicine_name, strength, dosage_form, medicine_code, quantity, free_quantity,
//                 //    purchase_price, units_per_pack, pack_size, pack_word }]
//     supplier,   // pharmacy_suppliers row (supplier_name, contact_person, phone, email, address, city, state, pincode)
//     company,    // { name, address, phone, email }   - the pharmacy placing the order
//     logoPath,   // accepted for compatibility but not drawn (the PDF is colourless)
//   });

const PDFDocument = require("pdfkit");

const BLACK = "#000000";
const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const ML = 40;
const MR = 40;
const CW = PAGE_W - ML - MR;
const FOOTER_H = 34;
const MAX_Y = PAGE_H - FOOTER_H - 14;

// table columns: [key, label, width, align]
const COL_W = { n: 24, qty: 80, free: 44, rate: 84, amt: 84 };
const COLS = [
  ["n", "#", COL_W.n, "left"],
  ["med", "MEDICINE", CW - COL_W.n - COL_W.qty - COL_W.free - COL_W.rate - COL_W.amt, "left"],
  ["qty", "QTY (STRIPS)", COL_W.qty, "right"],
  ["free", "FREE", COL_W.free, "right"],
  ["rate", "RATE / STRIP", COL_W.rate, "right"],
  ["amt", "AMOUNT", COL_W.amt, "right"],
];

/* ---------- helpers ---------- */
const num = (v) => Number(v) || 0;
const money = (v) => Math.round(num(v) * 100) / 100;
const inr = (v) => money(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* The pack on the order line: "10's" for a strip of 10, else the label ("100 ml") or the pack word. */
const packText = (it) => {
  const upp = Math.floor(num(it.units_per_pack));
  if (upp > 1) return `${upp}'s`;
  return String(it.pack_size || "").trim() || (it.pack_word ? String(it.pack_word) : "");
};
/* Strip lines say nothing more; a bottle / tube line says what one unit of the quantity is. */
const qtyWord = (it) => {
  const w = String(it.pack_word || "").toLowerCase();
  if (!w || w === "strip") return "";
  return num(it.quantity) === 1 ? w : /(s|x|ch|sh)$/.test(w) ? `${w}es` : `${w}s`;
};

function fmtDate(d) {
  if (!d) return "-";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d).slice(0, 10);
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const label = (it) =>
  [it.brand_name || it.medicine_name, it.strength].filter(Boolean).join(" ") ||
  it.medicine_name ||
  `Medicine #${it.medicine_id}`;

/* Kept for other callers (Indian-style amount in words); not printed on the supplier's copy. */
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function below1000(n) {
  let s = "";
  if (n >= 100) {
    s += `${ONES[Math.floor(n / 100)]} Hundred`;
    n %= 100;
    if (n) s += " ";
  }
  if (n >= 20) {
    s += TENS[Math.floor(n / 10)];
    if (n % 10) s += ` ${ONES[n % 10]}`;
  } else if (n) s += ONES[n];
  return s;
}
function rupeesInWords(value) {
  const total = Math.round(num(value) * 100);
  let rupees = Math.floor(total / 100);
  const paise = total % 100;
  if (rupees === 0 && paise === 0) return "Zero Rupees Only";
  const parts = [];
  for (const [div, name] of [[10000000, "Crore"], [100000, "Lakh"], [1000, "Thousand"]]) {
    if (rupees >= div) {
      parts.push(`${below1000(Math.floor(rupees / div))} ${name}`);
      rupees %= div;
    }
  }
  if (rupees) parts.push(below1000(rupees));
  let out = parts.length ? `${parts.join(" ")} ${total >= 100 && total < 200 && paise === 0 ? "Rupee" : "Rupees"}` : "";
  if (paise) out += `${out ? " and " : ""}${below1000(paise)} Paise`;
  return `${out} Only`;
}

/* ============================================================ */
function buildPurchaseOrderPdf({ order, items = [], supplier = {}, company = {} }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 0, bottom: 0, left: ML, right: ML },
        bufferPages: true,
        info: {
          Title: `Purchase Order ${order.purchase_number}`,
          Author: company.name || "CareDesk 360",
          Subject: `Purchase order to ${supplier.supplier_name || "supplier"}`,
        },
      });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const rule = (y, w = 0.5, x1 = ML, x2 = ML + CW) =>
        doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(w).strokeColor(BLACK).stroke().restore();
      const small = (text, x, y, opts = {}) =>
        doc.font(FONT_BOLD).fontSize(8).fillColor(BLACK).text(text, x, y, { characterSpacing: 1, lineBreak: false, ...opts });

      /* ---------- page furniture ---------- */
      const drawHeader = (continued) => {
        if (continued) {
          doc.font(FONT_BOLD).fontSize(11).fillColor(BLACK).text(company.name || "Purchase Order", ML, 30, { width: CW / 2, lineBreak: false, ellipsis: true });
          doc.font(FONT).fontSize(9).fillColor(BLACK).text(`Purchase order ${order.purchase_number} (continued)`, ML + CW / 2, 31, { width: CW / 2, align: "right", lineBreak: false });
          rule(50, 1);
          return 66;
        }
        const rightW = 190;
        const leftW = CW - rightW - 16;
        let y = 34;
        doc.font(FONT_BOLD).fontSize(17).fillColor(BLACK).text(company.name || "Purchase Order", ML, y, { width: leftW, lineBreak: false, ellipsis: true });
        y += 24;
        doc.font(FONT).fontSize(9);
        if (company.address) {
          const h = Math.min(24, doc.heightOfString(company.address, { width: leftW }));
          doc.text(company.address, ML, y, { width: leftW, height: 24, ellipsis: true });
          y += h + 2;
        }
        const contact = [company.phone && `Ph: ${company.phone}`, company.email].filter(Boolean).join("   |   ");
        if (contact) {
          doc.text(contact, ML, y, { width: leftW, lineBreak: false, ellipsis: true });
          y += 12;
        }
        doc.font(FONT_BOLD).fontSize(17).text("PURCHASE ORDER", PAGE_W - MR - rightW, 34, { width: rightW, align: "right", lineBreak: false });
        doc.font(FONT_BOLD).fontSize(11).text(order.purchase_number, PAGE_W - MR - rightW, 58, { width: rightW, align: "right", lineBreak: false });
        const lineY = Math.max(y + 8, 86);
        rule(lineY, 1.5);
        return lineY + 16;
      };

      const drawTableHead = (y) => {
        rule(y, 1);
        let x = ML;
        doc.font(FONT_BOLD).fontSize(8).fillColor(BLACK);
        for (const [, text, w, align] of COLS) {
          doc.text(text, x + 6, y + 8.5, { width: w - 12, align, lineBreak: false, characterSpacing: 0.4 });
          x += w;
        }
        rule(y + 24, 1);
        return y + 24;
      };

      /* ---------- page 1 ---------- */
      let y = drawHeader(false);

      // two blocks side by side: supplier | order details
      const gap = 16;
      const boxW = (CW - gap) / 2;
      const PAD = 0; // plain text, no boxes
      const boxTop = y;

      const supLines = [
        supplier.contact_person && `Attn: ${supplier.contact_person}`,
        [supplier.address, supplier.city, [supplier.state, supplier.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", "),
        supplier.phone && `Ph: ${supplier.phone}`,
        supplier.email,
      ].filter(Boolean);

      doc.font(FONT).fontSize(9.5);
      const supBodyH = supLines.reduce((h, t) => h + doc.heightOfString(t, { width: boxW - 24 }) + 2, 0);
      // A draft or a cancelled order says so, in plain text, so a copy of it can't pass for a live one.
      const stateLabel = order.status === "cancelled" ? "CANCELLED" : order.status === "draft" ? "DRAFT" : null;
      const detailRows = 3 + (order.branch ? 1 : 0) + (stateLabel ? 1 : 0);
      const boxH = Math.max(18 + detailRows * 16, 42 + supBodyH);

      small("TO (SUPPLIER)", ML + PAD, boxTop);
      doc.font(FONT_BOLD).fontSize(12).fillColor(BLACK).text(supplier.supplier_name || "Supplier not chosen yet", ML + PAD, boxTop + 14, { width: boxW - 24, lineBreak: false, ellipsis: true });
      let sy = boxTop + 32;
      doc.font(FONT).fontSize(9.5).fillColor(BLACK);
      for (const t of supLines) {
        doc.text(t, ML + PAD, sy, { width: boxW - 24 });
        sy += doc.heightOfString(t, { width: boxW - 24 }) + 2;
      }

      const bx = ML + boxW + gap;
      small("ORDER DETAILS", bx, boxTop);
      const details = [
        ["PO number", order.purchase_number],
        ["Date", fmtDate(order.purchase_date)],
        ["Receive by", order.expected_delivery_date ? fmtDate(order.expected_delivery_date) : "As soon as possible"],
        ...(order.branch ? [["Deliver to", `${order.branch} branch`]] : []),
        ...(stateLabel ? [["Status", stateLabel]] : []),
      ];
      let dy = boxTop + 18;
      for (const [k, v] of details) {
        doc.font(FONT).fontSize(9).fillColor(BLACK).text(k, bx, dy, { width: 100, lineBreak: false });
        doc.font(FONT_BOLD).fontSize(9.5).text(String(v), bx + 104, dy - 0.5, { width: boxW - 104, lineBreak: false, ellipsis: true });
        dy += 16;
      }
      y = boxTop + boxH + 14;

      /* ---------- items ---------- */
      doc.font(FONT_BOLD).fontSize(10).fillColor(BLACK).text(`Total items: ${items.length}`, ML, y, { width: CW, lineBreak: false });
      y += 20;
      y = drawTableHead(y);
      let orderValue = 0;
      items.forEach((it, i) => {
        const name = label(it);
        const sub = [packText(it), it.dosage_form, it.medicine_code].filter(Boolean).join("  ·  ");
        const amount = money(num(it.quantity) * num(it.purchase_price));
        orderValue = money(orderValue + amount);
        const medW = COLS[1][2] - 12;
        doc.font(FONT_BOLD).fontSize(10);
        const nameH = doc.heightOfString(name, { width: medW });
        const rowH = Math.max(24, 7 + nameH + (sub ? 12 : 0) + 5);

        if (y + rowH > MAX_Y) {
          doc.addPage();
          y = drawTableHead(drawHeader(true));
        }

        let x = ML;
        const cells = {
          n: String(i + 1),
          qty: String(num(it.quantity)),
          free: num(it.free_quantity) ? String(num(it.free_quantity)) : "-",
          rate: num(it.purchase_price) ? inr(it.purchase_price) : "-",
          amt: amount ? inr(amount) : "-",
        };
        const word = qtyWord(it);
        for (const [key, , w, align] of COLS) {
          if (key === "med") {
            doc.font(FONT_BOLD).fontSize(10).fillColor(BLACK).text(name, x + 6, y + 6, { width: medW });
            if (sub) doc.font(FONT).fontSize(8.5).fillColor(BLACK).text(sub, x + 6, y + 6 + nameH + 1, { width: medW, lineBreak: false, ellipsis: true });
          } else {
            doc.font(key === "qty" || key === "amt" ? FONT_BOLD : FONT).fontSize(10).fillColor(BLACK).text(cells[key], x + 6, y + 6, { width: w - 12, align, lineBreak: false });
            if (key === "qty" && word) doc.font(FONT).fontSize(8).fillColor(BLACK).text(word, x + 6, y + 19, { width: w - 12, align, lineBreak: false });
          }
          x += w;
        }
        rule(y + rowH, 0.3);
        y += rowH;
      });
      rule(y, 1);

      /* ---------- order value (before tax) ---------- */
      if (y + 24 > MAX_Y) {
        doc.addPage();
        y = drawHeader(true);
      }
      const amtX = ML + CW - COL_W.amt;
      doc.font(FONT).fontSize(9.5).fillColor(BLACK).text("Order value (before tax)", ML, y + 7, { width: CW - COL_W.amt - 6, align: "right", lineBreak: false });
      doc.font(FONT_BOLD).fontSize(10.5).fillColor(BLACK).text(inr(orderValue), amtX + 6, y + 6.5, { width: COL_W.amt - 12, align: "right", lineBreak: false });
      y += 22;
      rule(y, 0.5);

      /* ---------- summary, notes, request ---------- */
      const need = 14 + (order.notes ? 56 : 0) + 56;
      if (y + need > MAX_Y) {
        doc.addPage();
        y = drawHeader(true);
      }
      y += 24;

      if (order.notes) {
        small("NOTES", ML, y);
        const nh = doc.font(FONT).fontSize(9.5).heightOfString(String(order.notes), { width: CW });
        doc.font(FONT).fontSize(9.5).fillColor(BLACK).text(String(order.notes), ML, y + 13, { width: CW });
        y += 13 + nh + 14;
      }

      small("PLEASE", ML, y);
      doc.font(FONT).fontSize(9).fillColor(BLACK).text(
        `Confirm this order and the receive-by date. Quote ${order.purchase_number} on your invoice and delivery challan, and supply with batch number and expiry date on every line. Quantities are strips (packs); rates are per strip.${order.branch ? ` Deliver to our ${order.branch} branch.` : ""}`,
        ML, y + 13, { width: CW }
      );

      /* ---------- footer + page numbers on every page ---------- */
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const fy = PAGE_H - FOOTER_H;
        rule(fy, 0.5);
        doc.font(FONT).fontSize(8).fillColor(BLACK)
          .text("Computer-generated purchase order.", ML, fy + 10, { width: CW / 2, lineBreak: false })
          .text(`Page ${i + 1} of ${range.count}`, ML + CW / 2, fy + 10, { width: CW / 2, align: "right", lineBreak: false });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildPurchaseOrderPdf, rupeesInWords };