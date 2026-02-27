const express    = require("express");
const router     = express.Router();
const path       = require("path");
const fs         = require("fs");
const PDFDocument = require("pdfkit");
const db         = require("../db");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles }     = require("../middlewares/roleMiddleware");

/* ─────────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────────── */
const RS = "Rs.";

const C = {
  primary:    "#3f6f7a",
  accent:     "#3f6f7a",
  accentLight:"#d6eaf8",
  headerText: "#ffffff",
  dark:       "#1a1a2e",
  mid:        "#4a4a6a",
  border:     "#d5d8dc",
  rowAlt:     "#f4f6f9",
  green:      "#ffffff",
  red:        "#c0392b",
  orange:     "#d35400",
  grey:       "#757575",
};

const PAGE_W   = 595.28;
const PAGE_H   = 841.89;
const M_LEFT   = 45;
const M_RIGHT  = PAGE_W - 45;
const USABLE_W = M_RIGHT - M_LEFT;

const COL = {
  item:  { x: M_LEFT + 6,   w: 230 },
  qty:   { x: M_LEFT + 255, w: 45  },
  unit:  { x: M_LEFT + 308, w: 80  },
  total: { x: M_LEFT + 400, w: USABLE_W - 400 - 6 },
};

/* ─────────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────────── */
const safeParse = (v) => {
  if (!v) return null;
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  return v;
};

const fmt = (n) => `${RS} ${Number(n || 0).toFixed(2)}`;

const statusColor = (s) =>
  ({ Paid: C.green, Pending: C.orange, Overdue: C.red, Cancelled: C.grey }[s] || C.mid);

const filledRect = (doc, x, y, w, h, color) => doc.rect(x, y, w, h).fill(color);

const roundedRect = (doc, x, y, w, h, r, fill, stroke) => {
  doc.roundedRect(x, y, w, h, r);
  if (fill)   doc.fillColor(fill).fill();
  if (stroke) doc.strokeColor(stroke).lineWidth(0.5).stroke();
};

const hLine = (doc, y, color = C.border, lw = 0.5) =>
  doc.moveTo(M_LEFT, y).lineTo(M_RIGHT, y).strokeColor(color).lineWidth(lw).stroke();

/* ─────────────────────────────────────────────────────────────────
   ROUTE
───────────────────────────────────────────────────────────────── */
router.get(
  "/invoices/:invoiceId/download",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    try {
      const { invoiceId } = req.params;
      if (!invoiceId || isNaN(invoiceId))
        return res.status(400).json({ message: "Invalid invoice ID" });

      const [rows] = await db.execute(
        `SELECT
           b.id               AS bill_id,
           b.appointment_id,
           b.subtotal,
           b.tax,
           b.total_amount,
           b.bill_status,
           b.notes,
           b.created_at,
           b.bill_breakdown_json,
           b.prescription_id,
           a.company_name,
           a.email            AS admin_email,
           a.address          AS admin_address,
           a.mobile           AS admin_mobile,
           a.company_logo,
           c.id               AS client_id,
           c.name             AS client_name,
           c.mobile           AS client_mobile,
           c.address          AS client_address,
           ap.selected_branch AS appointment_branch,
           s.name             AS doctor_name,
           p.consultation_type_json,
           p.medicines_json,
           p.tests_json
         FROM bills b
         INNER JOIN admins       a  ON a.id  = b.admin_id
         INNER JOIN clients      c  ON c.id  = b.client_id
         INNER JOIN appointments ap ON ap.id = b.appointment_id
         INNER JOIN staff        s  ON s.id  = ap.staff_id
         LEFT JOIN prescriptions p  ON p.id  = b.prescription_id
         WHERE b.id = ?`,
        [invoiceId]
      );

      if (!rows.length)
        return res.status(404).json({ message: "Invoice not found" });

      const inv = rows[0];

      const breakdown     = safeParse(inv.bill_breakdown_json);
      const consultations = breakdown?.consultations ?? safeParse(inv.consultation_type_json) ?? [];
      const medicines     = breakdown?.medicines     ?? safeParse(inv.medicines_json)         ?? [];
      const tests         = breakdown?.tests         ?? safeParse(inv.tests_json)             ?? [];
      const hasBreakdown  = consultations.length + medicines.length + tests.length > 0;

      /* ── PDF init ── */
      const doc = new PDFDocument({ margin: 0, size: "A4", bufferPages: true });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=invoice_${inv.bill_id}.pdf`);
      doc.pipe(res);

      /* ──────────────────────────────────────────────────────────
         LAYOUT CONSTANTS
      ────────────────────────────────────────────────────────── */
      const HEADER_H       = 58;   // compact band height on every page
      const FOOTER_H       = 52;
      const FOOTER_RESERVE = FOOTER_H + 10;
      const MAX_Y          = PAGE_H - FOOTER_RESERVE;
      const TH             = 22;   // table column-header row height

      const invNum      = `#INV-${String(inv.bill_id).padStart(5, "0")}`;
      const statusLabel = (inv.bill_status || "Pending").toUpperCase();

      // Resolve logo path once
      const logoFilePath = inv.company_logo
        ? path.join(__dirname, "..", "Images", inv.company_logo)
        : null;
      const hasLogo = logoFilePath && fs.existsSync(logoFilePath);

      /* ──────────────────────────────────────────────────────────
         drawPageHeader(offsetY)
         Draws the navy header band at offsetY on the CURRENT page.
         Returns the Y coordinate immediately below the band.
      ────────────────────────────────────────────────────────── */
     const drawPageHeader = (offsetY) => {
  // Header background
  filledRect(doc, 0, offsetY, PAGE_W, HEADER_H, C.primary);
  filledRect(doc, 0, offsetY, PAGE_W, 3, C.accent);

  // Logo
  let textX = M_LEFT;
  if (hasLogo) {
    doc.image(logoFilePath, M_LEFT, offsetY + 8, { fit: [36, 36] });
    textX = M_LEFT + 44;
  }

  /* ── COMPANY NAME ── */
doc.font("Helvetica-Bold")
  .fontSize(13)
  .fillColor(C.headerText)
  .text(inv.company_name || "", textX, offsetY + 8, {
    width: 240,
  });

/* ── ADDRESS ── */
if (inv.admin_address) {
  doc.font("Helvetica")
    .fontSize(7.5)
    .fillColor("rgba(255,255,255,0.85)")
    .text(inv.admin_address, textX, offsetY + 26, { // ⬅️ was 24
      width: 240,
      lineGap: 2, // ⬅️ adds breathing room between wrapped lines
    });
}

/* ── EMAIL + PHONE ── */
const contact = [inv.admin_email, inv.admin_mobile].filter(Boolean).join("  |  ");
if (contact) {
  doc.font("Helvetica")
    .fontSize(7)
    .fillColor("rgba(255,255,255,0.65)")
    .text(contact, textX, offsetY + 44, { // ⬅️ was 40
      width: 240,
    });
}

  /* ── RIGHT SIDE TITLE ── */
  doc.font("Helvetica-Bold")
    .fontSize(18)
    .fillColor(C.headerText)
    .text("INVOICE", 0, offsetY + 10, {
      align: "right",
      width: M_RIGHT,
    });

  doc.font("Helvetica")
    .fontSize(9)
    .fillColor("rgba(255,255,255,0.75)")
    .text(invNum, 0, offsetY + 32, {
      align: "right",
      width: M_RIGHT,
    });

  /* ── STATUS LABEL ── */
  const pillW = 62;
  const pillX = M_RIGHT - pillW;
  const pillY = offsetY + HEADER_H - 18;

  // doc.font("Helvetica-Bold")
  //   .fontSize(7.5)
  //   .fillColor(C.headerText)
  //   .text(statusLabel, pillX, pillY, {
  //     width: pillW,
  //     align: "center",
  //   });

  return offsetY + HEADER_H;
};

      /* ──────────────────────────────────────────────────────────
         drawTableHeader(y)
         Draws the blue column-label row at y.
         Returns y + TH.
      ────────────────────────────────────────────────────────── */
      const drawTableHeader = (y) => {
        filledRect(doc, M_LEFT, y, USABLE_W, TH, C.accent);
        doc.font("Helvetica-Bold").fontSize(8.5).fillColor(C.headerText)
           .text("ITEM / DESCRIPTION", COL.item.x,  y + 7, { width: COL.item.w })
           .text("QTY",                COL.qty.x,   y + 7, { width: COL.qty.w,  align: "center" })
           .text("UNIT PRICE",         COL.unit.x,  y + 7, { width: COL.unit.w, align: "right"  })
           .text("AMOUNT",             COL.total.x, y + 7, { width: COL.total.w, align: "right" });
        return y + TH;
      };

      /* ══════════════════════════════════════════════════════════
         PAGE 1 — draw header + info cards + begin table
      ══════════════════════════════════════════════════════════ */
      let Y = drawPageHeader(0);     // Y = HEADER_H after this

      // ── Info cards ──────────────────────────────────────────
      const INFO_Y = Y + 14;
      const CARD_W = (USABLE_W / 2) - 6;
      const CARD_H = 96;

      // Left card — Billed To
      roundedRect(doc, M_LEFT, INFO_Y, CARD_W, CARD_H, 5, "#f8fafd", C.border);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(C.accent)
         .text("BILLED TO", M_LEFT + 10, INFO_Y + 10, { characterSpacing: 1 });
      doc.font("Helvetica-Bold").fontSize(12).fillColor(C.dark)
         .text(inv.client_name || "—", M_LEFT + 10, INFO_Y + 22);
      [
        `Patient ID : ${inv.client_id}`,
        `Mobile     : ${inv.client_mobile || "—"}`,
        // `Address    : ${inv.client_address || "—"}`,
      ].forEach((line, i) =>
        doc.font("Helvetica").fontSize(9).fillColor(C.mid)
           .text(line, M_LEFT + 10, INFO_Y + 38 + i * 14, { width: CARD_W - 20 })
      );

      // Right card — Invoice Details
      const RCARDX = M_LEFT + CARD_W + 12;
      roundedRect(doc, RCARDX, INFO_Y, CARD_W, CARD_H, 5, "#f8fafd", C.border);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(C.accent)
         .text("INVOICE DETAILS", RCARDX + 10, INFO_Y + 10, { characterSpacing: 1 });

      const detailDate = new Date(inv.created_at).toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
      });
      [
        ["Bill ID",  inv.bill_id],
        ["Appt ID",  inv.appointment_id],
        ["Date",     detailDate],
        ["Doctor",   inv.doctor_name || "—"],
        ["Branch",   inv.appointment_branch || "—"],
      ].forEach(([k, v], i) => {
        const ry = INFO_Y + 24 + i * 14;
        doc.font("Helvetica-Bold").fontSize(9).fillColor(C.dark)
           .text(k, RCARDX + 10, ry, { width: 55 });
        doc.font("Helvetica").fontSize(9).fillColor(C.mid)
           .text(`: ${v}`, RCARDX + 65, ry, { width: CARD_W - 75 });
      });

      // ── Table starts below info cards ───────────────────────
      Y = INFO_Y + CARD_H + 12;
      Y = drawTableHeader(Y);

      /* ══════════════════════════════════════════════════════════
         TABLE ROW HELPERS
      ══════════════════════════════════════════════════════════ */
      let altRow = false;

      // If content is about to overflow, start a new page with header + table-header
      const ensureSpace = (need = 22) => {
        if (Y + need > MAX_Y) {
          doc.addPage();
          Y = drawPageHeader(0);   // header band at top of new page
          Y += 8;
          Y = drawTableHeader(Y); // column headers right below
          altRow = false;
        }
      };

      const drawSection = (label) => {
        ensureSpace(18);
        filledRect(doc, M_LEFT, Y, USABLE_W, 18, C.accentLight);
        doc.font("Helvetica-Bold").fontSize(8).fillColor(C.accent)
           .text(label, COL.item.x, Y + 5, { characterSpacing: 0.5 });
        Y += 18;
      };

      const drawRow = (name, qty, unitPrice, amount) => {
        const estLines = Math.ceil((name || "").length / 38) || 1;
        const rowH     = Math.max(22, estLines * 13 + 8);
        ensureSpace(rowH);

        if (altRow) filledRect(doc, M_LEFT, Y, USABLE_W, rowH, C.rowAlt);
        filledRect(doc, M_LEFT, Y, 3, rowH, altRow ? C.accentLight : "#e8f0fe");

        doc.font("Helvetica").fontSize(9.5).fillColor(C.dark)
           .text(name || "—", COL.item.x, Y + 6, { width: COL.item.w, lineGap: 1 });
        doc.font("Helvetica").fontSize(9.5).fillColor(C.mid)
           .text(qty != null ? String(qty) : "—",
                 COL.qty.x,   Y + 6, { width: COL.qty.w,  align: "center" })
           .text(unitPrice != null ? fmt(unitPrice) : "—",
                 COL.unit.x,  Y + 6, { width: COL.unit.w, align: "right"  })
           .text(fmt(amount || 0),
                 COL.total.x, Y + 6, { width: COL.total.w, align: "right" });

        Y += rowH;
        doc.moveTo(M_LEFT, Y).lineTo(M_RIGHT, Y)
           .strokeColor(C.border).lineWidth(0.3).stroke();
        altRow = !altRow;
      };

      /* ══════════════════════════════════════════════════════════
         POPULATE ROWS
      ══════════════════════════════════════════════════════════ */
      if (hasBreakdown) {
        if (consultations.length > 0) {
          drawSection("CONSULTATION FEES");
          consultations.forEach(c => drawRow(c.name || "—", null, null, c.cost));
        }
        if (medicines.length > 0) {
          drawSection("MEDICINES");
          medicines.forEach(m => drawRow(
            `${m.name || m.medicine_name || "—"}${m.duration ? `  (${m.duration})` : ""}`,
            m.quantity,
            m.unit_price ?? m.amount,
            m.cost ?? m.total_amount
          ));
        }
        if (tests.length > 0) {
          drawSection("TESTS");
          tests.forEach(t => drawRow(t.name || t.test_name || "—", null, null, t.cost));
        }
      } else {
        drawRow("Consultation / Services", null, null, inv.subtotal);
      }

      /* ══════════════════════════════════════════════════════════
         TOTALS BLOCK
      ══════════════════════════════════════════════════════════ */
      ensureSpace(150);
      Y += 10;
      hLine(doc, Y, C.border, 0.5);
      Y += 12;

      const TOT_X = M_RIGHT - 200;
      const TOT_W = 200;
      const ROW_H = 18;

      const totals = [];
      if (hasBreakdown) {
        const cT = consultations.reduce((s, c) => s + Number(c.cost || 0), 0);
        const mT = medicines.reduce((s, m) => s + Number(m.cost ?? m.total_amount ?? 0), 0);
        const tT = tests.reduce((s, t) => s + Number(t.cost || 0), 0);
        if (consultations.length) totals.push(["Consultation", cT]);
        if (medicines.length)     totals.push(["Medicines",    mT]);
        if (tests.length)         totals.push(["Tests",        tT]);
      }
      totals.push(["Subtotal", Number(inv.subtotal || 0)]);
      totals.push(["Tax",      Number(inv.tax      || 0)]);

      totals.forEach(([label, amount]) => {
        doc.font("Helvetica").fontSize(9.5).fillColor(C.mid)
           .text(label,       TOT_X,             Y, { width: TOT_W - 90 })
           .text(fmt(amount), TOT_X + TOT_W - 90, Y, { width: 84, align: "right" });
        Y += ROW_H;
      });

      Y += 4;
      const GT_H = 28;
      roundedRect(doc, TOT_X - 10, Y, TOT_W + 10, GT_H, 5, C.primary, null);
      doc.font("Helvetica-Bold").fontSize(11).fillColor(C.headerText)
         .text("TOTAL",              TOT_X,             Y + 8, { width: TOT_W - 90 })
         .text(fmt(inv.total_amount), TOT_X + TOT_W - 90, Y + 8, { width: 84, align: "right" });
      Y += GT_H + 14;

      /* ══════════════════════════════════════════════════════════
         NOTES
      ══════════════════════════════════════════════════════════ */
      if (inv.notes) {
        ensureSpace(60);
        roundedRect(doc, M_LEFT, Y, USABLE_W * 0.55, 50, 4, "#fffde7", "#f9a825");
        doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#f57f17")
           .text("NOTES", M_LEFT + 10, Y + 8, { characterSpacing: 1 });
        doc.font("Helvetica").fontSize(9).fillColor(C.mid)
           .text(inv.notes, M_LEFT + 10, Y + 22, { width: USABLE_W * 0.55 - 20 });
        Y += 60;
      }

      /* ══════════════════════════════════════════════════════════
         POST-PROCESS — stamp FOOTER on every buffered page
         (Headers were already drawn live during content generation)
      ══════════════════════════════════════════════════════════ */
      const totalPages = doc.bufferedPageRange().count;
      const ts = new Date().toLocaleString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });

      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);

        const FY = PAGE_H - FOOTER_H;

        filledRect(doc, 0, FY, PAGE_W, FOOTER_H, C.primary);
        filledRect(doc, 0, FY, PAGE_W, 2, C.accent);

        // Left — clinic + contact
        const footerLeft = [inv.company_name, inv.admin_email, inv.admin_mobile]
          .filter(Boolean).join("  ·  ");
        doc.font("Helvetica").fontSize(8).fillColor("rgba(255,255,255,1)")
           .text(footerLeft, M_LEFT, FY + 10, { width: 300, lineBreak: false, ellipsis: true });

        // Center — thank you
      doc.font("Helvetica-Bold")
   .fontSize(8.5)
   .fillColor("rgba(255,255,255,0.65)") // ✅ visible white
   .text("Thank you for choosing us!", 0, FY + 10, {
     align: "center",
     width: PAGE_W,
   });

        // Right — page number
        if (totalPages > 1) {
          doc.font("Helvetica").fontSize(7.5).fillColor("rgba(255,255,255,0.65)")
             .text(`Page ${i + 1} / ${totalPages}`, M_LEFT, FY + 10, {
               width: USABLE_W, align: "right",
             });
        }

        // Status dot + label
        // doc.circle(M_LEFT + 4, FY + 34, 4).fill(statusColor(inv.bill_status));
        // doc.font("Helvetica-Bold").fontSize(8).fillColor("rgba(255,255,255,0.85)")
        //    .text(`Status: ${inv.bill_status || "Pending"}`, M_LEFT + 14, FY + 29);

        // Generated timestamp
        doc.font("Helvetica").fontSize(7.5).fillColor("rgba(255,255,255,0.55)")
           .text(`Generated: ${ts}`, M_LEFT, FY + 29, { width: USABLE_W, align: "right" });
      }

      doc.end();

    } catch (error) {
      console.error("PDF generation error:", error.message);
      if (!res.headersSent)
        res.status(500).json({ message: "Failed to generate invoice PDF", error: error.message });
    }
  }
);

module.exports = router;