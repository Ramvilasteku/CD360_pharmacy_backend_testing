// utils/buildB2BInvoicePdf.js
//
// A B2B tax invoice as a one-or-more page A4 PDF, ready to download, attach to an email or
// hand to the buyer on WhatsApp. Returns a Buffer; nothing is written to disk.
//
// Plain on purpose, like the purchase-order PDF: black text on white, one sans-serif face
// (Helvetica), thin black rules. Amounts are written "Rs." because the standard PDF fonts have
// no rupee sign.
//
//   const pdf = await buildB2BInvoicePdf({
//     invoice,   // the invoice as the B2B route shapes it (a pharmacy_sales row + buyer details)
//     items,     // one per batch: medicine, batch, qty_type (strip / tablet / pack), quantity, rate
//                //   (per unit sold), mrp (per strip, as printed on it), units_per_pack, GST
//     payments,  // [{ payment_number, payment_date, amount, payment_method }]   (optional)
//     seller,    // { business_name, address, phone, email, gstin, drug_license_number, bank_details, terms }
//   });

const PDFDocument = require("pdfkit");

const BLACK = "#000000";
const GREY = "#555555";
const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const ML = 36;
const MR = 36;
const CW = PAGE_W - ML - MR;
const FOOTER_H = 30;
const MAX_Y = PAGE_H - FOOTER_H - 12;

// table columns: [key, heading, width, align]
const COLS = [
  ["n", "#", 20, "left"],
  ["med", "MEDICINE", CW - 20 - 46 - 62 - 58 - 52 - 44 - 32 - 62, "left"],
  ["hsn", "HSN", 46, "left"],
  ["batch", "BATCH / EXP", 62, "left"],
  ["qty", "QTY", 58, "right"],
  ["rate", "RATE (Rs.)", 52, "right"],
  ["mrp", "MRP (Rs.)", 44, "right"],
  ["gst", "GST %", 32, "right"],
  ["amt", "AMOUNT (Rs.)", 62, "right"],
];

/* ---------- helpers ---------- */
const num = (v) => Number(v) || 0;

/** 1234567.5 → "12,34,567.50" (Indian grouping) */
function inr(v) {
  const n = Math.abs(num(v));
  const [int, dec] = n.toFixed(2).split(".");
  let head = int;
  if (int.length > 3) {
    const last3 = int.slice(-3);
    const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    head = `${rest},${last3}`;
  }
  return `${num(v) < 0 ? "-" : ""}${head}.${dec}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function below1000(n) {
  const parts = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : ""));
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(" ");
}

/** 1234.5 → "Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only" (lakh / crore) */
function rupeesInWords(value) {
  const total = Math.round(Math.abs(num(value)) * 100);
  const rupees = Math.floor(total / 100);
  const paise = total % 100;
  if (rupees === 0 && paise === 0) return "Rupees Zero Only";
  const units = [
    [10000000, "Crore"],
    [100000, "Lakh"],
    [1000, "Thousand"],
  ];
  let n = rupees;
  const words = [];
  for (const [size, name] of units) {
    if (n >= size) {
      words.push(`${below1000(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n > 0) words.push(below1000(n));
  let out = rupees > 0 ? `Rupees ${words.join(" ")}` : "Rupees Zero";
  if (paise) out += ` and ${below1000(paise)} Paise`;
  return `${out} Only`;
}

function fmtDate(d) {
  if (!d) return "-";
  const dt = d instanceof Date ? d : new Date(String(d).length === 10 ? `${d}T00:00:00` : d);
  if (Number.isNaN(dt.getTime())) return String(d).slice(0, 10);
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtExp(d) {
  if (!d) return "";
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const [y, m] = s.split("-");
  return y && m ? `${m}/${y.slice(2)}` : s;
}

const plural = (word, n) => {
  const w = String(word || "strip").toLowerCase();
  if (Number(n) === 1) return w;
  return /(s|x|ch|sh)$/.test(w) ? `${w}es` : `${w}s`;
};
// the line's own words when the route gives them ("2 strips", "7 tablets", "1 bottle")
const packName = (it) => {
  const w = String(it.pack_unit || "strip").toLowerCase();
  return it.qty_type === "pack" && w === "strip" ? "pack" : w;
};
const qtyText = (it) =>
  it.qty_text || `${num(it.quantity)} ${it.qty_type === "tablet" ? plural("tablet", it.quantity) : plural(packName(it), it.quantity)}`;
const rateUnit = (it) => `/${it.rate_unit || (it.qty_type === "tablet" ? "tablet" : packName(it))}`;
/** a rate keeps up to 4 decimals when it has them (a tablet of a Rs. 40 strip of 3 = 13.3333) */
const rateText = (v) => {
  const r = Math.round(Math.abs(num(v)) * 10000) / 10000;
  if (Math.abs(r * 100 - Math.round(r * 100)) < 1e-6) return inr(r);
  const whole = inr(Math.floor(r)).split(".")[0];
  return `${whole}.${(r - Math.floor(r)).toFixed(4).slice(2).replace(/0+$/, "")}`;
};

/** Per-GST-rate breakup, for the small table under the lines. */
function gstBreakup(items) {
  const by = new Map();
  for (const it of items) {
    const r = num(it.gst_percentage);
    const row = by.get(r) || { rate: r, taxable: 0, tax: 0 };
    row.taxable += num(it.taxable_amount);
    row.tax += num(it.tax_amount);
    by.set(r, row);
  }
  return [...by.values()].sort((a, b) => a.rate - b.rate);
}

/* ---------- the builder ---------- */
function buildB2BInvoicePdf({ invoice, items = [], payments = [], seller = {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 36, bottom: 36, left: ML, right: MR }, bufferPages: true, autoFirstPage: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      const igst = !!invoice.is_igst;
      const cancelled = invoice.status === "cancelled";
      doc.info.Title = `Invoice ${invoice.invoice_number}`;
      doc.info.Author = seller.business_name || "";

      const rule = (y, w = 0.6) => doc.lineWidth(w).strokeColor(BLACK).moveTo(ML, y).lineTo(PAGE_W - MR, y).stroke();
      const text = (s, x, y, o = {}) => doc.text(String(s ?? ""), x, y, { lineBreak: false, ...o });

      /* ---------- page header ---------- */
      const drawHeader = (continued = false) => {
        let y = 36;
        if (continued) {
          doc.font(FONT_BOLD).fontSize(10).fillColor(BLACK);
          text(`${seller.business_name || ""}  -  Tax invoice ${invoice.invoice_number} (continued)`, ML, y);
          y += 18;
          rule(y);
          return y + 8;
        }

        // seller (left)
        const leftW = CW * 0.58;
        doc.font(FONT_BOLD).fontSize(15).fillColor(BLACK);
        doc.text(seller.business_name || "Pharmacy", ML, y, { width: leftW });
        let ly = doc.y + 2;
        doc.font(FONT).fontSize(9).fillColor(BLACK);
        const lines = [
          seller.address,
          [seller.phone && `Ph: ${seller.phone}`, seller.email].filter(Boolean).join("   "),
          seller.gstin && `GSTIN: ${seller.gstin}`,
          seller.drug_license_number && `Drug licence: ${seller.drug_license_number}`,
        ].filter(Boolean);
        for (const l of lines) {
          doc.text(l, ML, ly, { width: leftW });
          ly = doc.y + 1;
        }

        // document title + numbers (right)
        const rx = ML + CW * 0.62;
        const rw = CW - CW * 0.62;
        doc.font(FONT_BOLD).fontSize(17).fillColor(BLACK);
        text("TAX INVOICE", rx, y, { width: rw, align: "right" });
        let ry = y + 26;
        const kv = (k, v) => {
          doc.font(FONT).fontSize(9).fillColor(GREY);
          text(k, rx, ry, { width: 70 });
          doc.font(FONT_BOLD).fontSize(9.5).fillColor(BLACK);
          text(v, rx + 72, ry, { width: rw - 72, align: "right" });
          ry += 14;
        };
        kv("Invoice no.", invoice.invoice_number);
        kv("Date", fmtDate(invoice.invoice_date));
        if (invoice.due_date) kv("Due date", fmtDate(invoice.due_date));
        if (cancelled) {
          doc.font(FONT_BOLD).fontSize(10).fillColor(BLACK);
          text("CANCELLED", rx, ry + 2, { width: rw, align: "right" });
          ry += 16;
        }

        y = Math.max(ly, ry) + 8;
        rule(y, 1);
        y += 10;

        // bill to
        doc.font(FONT).fontSize(8).fillColor(GREY);
        text("BILL TO", ML, y);
        doc.font(FONT_BOLD).fontSize(11).fillColor(BLACK);
        doc.text(invoice.buyer_name || "", ML, y + 11, { width: CW * 0.6 });
        let by = doc.y + 1;
        doc.font(FONT).fontSize(9).fillColor(BLACK);
        const buyerLines = [
          invoice.buyer_address,
          invoice.buyer_state,
          invoice.buyer_phone && `Ph: ${invoice.buyer_phone}`,
          invoice.buyer_gstin && `GSTIN: ${invoice.buyer_gstin}`,
          invoice.buyer_drug_license && `Drug licence: ${invoice.buyer_drug_license}`,
        ].filter(Boolean);
        for (const l of buyerLines) {
          doc.text(l, ML, by, { width: CW * 0.6 });
          by = doc.y + 1;
        }
        // supply type (right)
        doc.font(FONT).fontSize(8).fillColor(GREY);
        text("SUPPLY", rx, y, { width: rw, align: "right" });
        doc.font(FONT).fontSize(9).fillColor(BLACK);
        text(igst ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)", rx, y + 11, { width: rw, align: "right" });

        y = Math.max(by, y + 28) + 8;
        return y;
      };

      const drawTableHead = (y) => {
        rule(y, 0.8);
        doc.font(FONT_BOLD).fontSize(7.5).fillColor(BLACK);
        let x = ML;
        for (const [, label, w, align] of COLS) {
          text(label, x + 3, y + 6, { width: w - 6, align });
          x += w;
        }
        rule(y + 20, 0.8);
        return y + 20;
      };

      let y = drawTableHead(drawHeader(false));

      /* ---------- lines ---------- */
      items.forEach((it, i) => {
        const medW = COLS[1][2] - 6;
        const name = it.medicine_name || "";
        const sub = [it.strength, it.dosage_form].filter(Boolean).join("  ");
        doc.font(FONT_BOLD).fontSize(8.5);
        const nameH = doc.heightOfString(name, { width: medW });
        const rowH = Math.max(26, 7 + nameH + (sub ? 10 : 0) + 5);

        if (y + rowH > MAX_Y) {
          doc.addPage();
          y = drawTableHead(drawHeader(true));
        }

        let x = ML;
        const cell = {
          n: String(i + 1),
          hsn: it.hsn_code || "",
          qty: qtyText(it),
          rate: rateText(it.unit_price),
          mrp: num(it.mrp) ? inr(it.mrp) : "",
          gst: num(it.gst_percentage) % 1 ? num(it.gst_percentage).toFixed(1) : String(num(it.gst_percentage)),
          amt: inr(it.taxable_amount),
        };
        for (const [key, , w, align] of COLS) {
          if (key === "med") {
            doc.font(FONT_BOLD).fontSize(8.5).fillColor(BLACK).text(name, x + 3, y + 6, { width: medW });
            if (sub) doc.font(FONT).fontSize(7.5).fillColor(GREY).text(sub, x + 3, y + 6 + nameH + 1, { width: medW, lineBreak: false, ellipsis: true });
          } else if (key === "batch") {
            doc.font(FONT).fontSize(8).fillColor(BLACK).text(it.batch_number || "", x + 3, y + 6, { width: w - 6, lineBreak: false, ellipsis: true });
            if (it.expiry_date) doc.font(FONT).fontSize(7.5).fillColor(GREY).text(`exp ${fmtExp(it.expiry_date)}`, x + 3, y + 16, { width: w - 6, lineBreak: false });
          } else if (key === "mrp" && cell.mrp && it.qty_type === "tablet") {
            // the MRP printed on the pack is per strip; say so on a tablet line
            doc.font(FONT).fontSize(8.5).fillColor(BLACK).text(cell.mrp, x + 3, y + 6, { width: w - 6, align, lineBreak: false });
            doc.font(FONT).fontSize(7).fillColor(GREY).text(`/${packName(it)}`, x + 3, y + 16, { width: w - 6, align, lineBreak: false });
          } else if (key === "rate") {
            doc.font(FONT).fontSize(8.5).fillColor(BLACK).text(cell.rate, x + 3, y + 6, { width: w - 6, align, lineBreak: false });
            doc.font(FONT).fontSize(7).fillColor(GREY).text(rateUnit(it), x + 3, y + 16, { width: w - 6, align, lineBreak: false });
          } else {
            doc
              .font(key === "qty" || key === "amt" ? FONT_BOLD : FONT)
              .fontSize(key === "n" ? 8 : 8.5)
              .fillColor(BLACK)
              .text(cell[key] ?? "", x + 3, y + 6, { width: w - 6, align, lineBreak: false });
          }
          x += w;
        }
        rule(y + rowH, 0.25);
        y += rowH;
      });

      /* ---------- totals + GST breakup ---------- */
      const boxH = 150;
      if (y + boxH > MAX_Y) {
        doc.addPage();
        y = drawHeader(true);
      }
      y += 8;
      const leftW = CW * 0.52;
      const rx = ML + CW * 0.58;
      const rw = CW - CW * 0.58;

      // right: the sums
      let ry = y;
      const sum = (k, v, bold = false, big = false) => {
        doc.font(bold ? FONT_BOLD : FONT).fontSize(big ? 11 : 9).fillColor(BLACK);
        text(k, rx, ry, { width: rw * 0.6 });
        text(v, rx + rw * 0.45, ry, { width: rw * 0.55, align: "right" });
        ry += big ? 18 : 13.5;
      };
      sum("Subtotal", inr(invoice.subtotal));
      if (num(invoice.discount_amount) > 0) sum("Discount", `- ${inr(invoice.discount_amount)}`);
      sum("Taxable value", inr(invoice.taxable_amount));
      if (igst) {
        sum("IGST", inr(invoice.igst_amount));
      } else {
        sum("CGST", inr(invoice.cgst_amount));
        sum("SGST", inr(invoice.sgst_amount));
      }
      if (num(invoice.other_charges) > 0) sum("Other charges", inr(invoice.other_charges));
      if (num(invoice.round_off) !== 0) sum("Round off", inr(invoice.round_off));
      rule(ry + 1, 0.8);
      ry += 5;
      sum("TOTAL (Rs.)", inr(invoice.grand_total), true, true);
      rule(ry - 2, 0.8);
      ry += 2;
      sum("Paid", inr(invoice.paid_amount));
      sum("Balance due", inr(invoice.due_amount), true);

      // left: in words + GST by rate
      let ly = y;
      doc.font(FONT).fontSize(8).fillColor(GREY);
      text("AMOUNT IN WORDS", ML, ly);
      doc.font(FONT_BOLD).fontSize(9).fillColor(BLACK);
      doc.text(rupeesInWords(invoice.grand_total), ML, ly + 11, { width: leftW });
      ly = doc.y + 8;

      const brk = gstBreakup(items);
      if (brk.some((b) => b.rate > 0)) {
        doc.font(FONT_BOLD).fontSize(7.5).fillColor(BLACK);
        const cols = igst
          ? [["GST %", 40], ["Taxable", 80], ["IGST", 70]]
          : [["GST %", 36], ["Taxable", 70], ["CGST", 55], ["SGST", 55]];
        let cx = ML;
        for (const [h, w] of cols) {
          text(h, cx, ly, { width: w, align: h === "GST %" ? "left" : "right" });
          cx += w;
        }
        ly += 11;
        rule(ly - 2, 0.4);
        doc.font(FONT).fontSize(8);
        for (const b of brk) {
          const tax = Math.round(b.tax * 100) / 100;
          const half = Math.round((tax / 2) * 100) / 100;
          const vals = igst ? [`${b.rate}`, inr(b.taxable), inr(tax)] : [`${b.rate}`, inr(b.taxable), inr(half), inr(tax - half)];
          cx = ML;
          cols.forEach(([h, w], k) => {
            text(vals[k], cx, ly, { width: w, align: h === "GST %" ? "left" : "right" });
            cx += w;
          });
          ly += 11;
        }
      }

      y = Math.max(ly, ry) + 6;
      rule(y, 0.6);
      y += 8;

      /* ---------- payments, bank, terms, signature ---------- */
      const blocks = [];
      if (payments.length) {
        blocks.push(["PAYMENTS RECEIVED", payments.map((p) => `${fmtDate(p.payment_date)}  ${String(p.payment_method || "").replace("_", " ")}  Rs. ${inr(p.amount)}`).join("\n")]);
      }
      if (seller.bank_details) blocks.push(["BANK DETAILS", seller.bank_details]);
      if (invoice.notes) blocks.push(["NOTES", invoice.notes]);
      if (seller.terms) blocks.push(["TERMS", seller.terms]);

      for (const [title, body] of blocks) {
        doc.font(FONT).fontSize(8);
        const h = 12 + doc.heightOfString(String(body), { width: CW * 0.62 }) + 6;
        if (y + h > MAX_Y) {
          doc.addPage();
          y = drawHeader(true);
        }
        doc.font(FONT).fontSize(8).fillColor(GREY);
        text(title, ML, y);
        doc.font(FONT).fontSize(8.5).fillColor(BLACK);
        doc.text(String(body), ML, y + 11, { width: CW * 0.62 });
        y = doc.y + 8;
      }

      if (y + 56 > MAX_Y) {
        doc.addPage();
        y = drawHeader(true);
      }
      doc.font(FONT).fontSize(9).fillColor(BLACK);
      text(`For ${seller.business_name || ""}`, ML + CW * 0.55, y + 4, { width: CW * 0.45, align: "right" });
      doc.font(FONT).fontSize(8.5).fillColor(GREY);
      text("Authorised signatory", ML + CW * 0.55, y + 44, { width: CW * 0.45, align: "right" });

      /* ---------- footer on every page ---------- */
      const range = doc.bufferedPageRange();
      for (let p = 0; p < range.count; p++) {
        doc.switchToPage(range.start + p);
        doc.page.margins.bottom = 0; // let the footer sit inside the bottom margin without adding a page
        rule(PAGE_H - FOOTER_H - 4, 0.4);
        doc.font(FONT).fontSize(7.5).fillColor(GREY);
        text("This is a computer generated invoice.", ML, PAGE_H - FOOTER_H + 2, { width: CW * 0.7 });
        text(`Page ${p + 1} of ${range.count}`, ML, PAGE_H - FOOTER_H + 2, { width: CW, align: "right" });
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildB2BInvoicePdf, rupeesInWords, inr };