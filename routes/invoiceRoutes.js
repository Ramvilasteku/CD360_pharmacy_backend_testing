const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const db = require("../db");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* ======================================================
   DOWNLOAD INVOICE PDF
====================================================== */
router.get(
  "/invoices/:invoiceId/download",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    try {
      const { invoiceId } = req.params;

      if (!invoiceId || isNaN(invoiceId)) {
        return res.status(400).json({ message: "Invalid invoice ID" });
      }

      /* ===============================
         FETCH INVOICE DATA
      =============================== */
      const [rows] = await db.execute(
        `
        SELECT
          b.id AS bill_id,
          b.appointment_id,
          b.subtotal,
          b.tax,
          b.total_amount,
          b.created_at,
          b.notes,

          a.company_name,
          a.email AS admin_email,
          a.address AS admin_address,
          a.company_logo,

          c.id AS client_id,
          c.name AS client_name,
          c.mobile AS client_mobile,
          c.address AS client_address,

          ap.selected_branch AS appointment_branch,
          ap.staff_id,
          s.name AS doctor_name

        FROM bills b
        INNER JOIN admins a ON a.id = b.admin_id
        INNER JOIN clients c ON c.id = b.client_id
        INNER JOIN appointments ap ON ap.id = b.appointment_id
        INNER JOIN staff s ON s.id = ap.staff_id
        WHERE b.id = ?
        `,
        [invoiceId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Invoice not found" });
      }

      const invoice = rows[0];

      /* ===============================
         PDF SETUP
      =============================== */
      const doc = new PDFDocument({ margin: 50 });
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=invoice_${invoice.bill_id}.pdf`
      );

      doc.pipe(res);

      /* ===============================
         COMPANY LOGO (FIXED)
      =============================== */

      if (invoice.company_logo) {
        const logoPath = path.join(
          __dirname,
          "..",
          "Images",
          invoice.company_logo
        );

        console.log("INVOICE LOGO PATH 👉", logoPath);
        if (fs.existsSync(logoPath)) {
          doc.image(logoPath, 50, 40, {
            fit: [100, 50], // [maxWidth, maxHeight]
            align: "left",
            valign: "top",
          });
        }
      }

      /* ===============================
         INVOICE HEADER
      =============================== */
      doc.fontSize(22).text("INVOICE", 0, 50, { align: "right" }).moveDown(1);

      /* ===============================
         BILLED TO
      =============================== */
      doc
        .fontSize(11)
        .text("BILLED TO:", 50, 140)
        .moveDown(0.5)
        .text(`Patient ID : ${invoice.client_id}`)
        .moveDown(0.3)
        .text(`Name : ${invoice.client_name}`)
        .moveDown(0.3)
        .text(`Mobile No : ${invoice.client_mobile}`)
        .moveDown(0.3)
        .text(`Address : ${invoice.client_address || "-"}`, {
          width: 250,
        });

      /* ===============================
         META INFO
      =============================== */
      doc
        .text(`Bill ID : ${invoice.bill_id}`, 400, 140)
        .moveDown(0.3)
        .text(`Appointment ID : ${invoice.appointment_id}`)
        .moveDown(0.3)
        .text(
          `Date : ${new Date(invoice.created_at).toISOString().split("T")[0]}`
        )
        .moveDown(0.3)
        .text(`Doctor Name: ${invoice.doctor_name}`)
        .moveDown(0.3)
        .text(`Visited Branch : ${invoice.appointment_branch || "N/A"}`);

      /* ===============================
         TABLE HEADER
      =============================== */
      doc.moveTo(50, 260).lineTo(550, 260).stroke();

      doc.fontSize(12).text("Services", 50, 280);
      doc.text("Amount", 460, 280);

      doc.moveTo(50, 300).lineTo(550, 300).stroke();

      /* ===============================
         TABLE ROWS
      =============================== */
      doc
        .fontSize(11)
        .text(`${invoice.notes || "Consultation Charges"}`, 50, 320)
        .text(`${invoice.subtotal} Rs`, 450, 320);

      doc.moveTo(50, 340).lineTo(550, 340).stroke();

      doc.text("Tax", 50, 360).text(`${invoice.tax} Rs`, 450, 360);

      doc.moveTo(50, 380).lineTo(550, 380).stroke();

      doc.fontSize(14).text(`Total : ${invoice.total_amount} Rs`, 400, 410);

      /* ===============================
         FOOTER
      =============================== */
      doc.fontSize(12).text("Thank you!", -226, pageHeight / 1.8, {
        align: "center",
        width: pageWidth,
      });

      /* ===============================
         FOOTER LEFT
      =============================== */
      doc
        .moveUp(0.5)
        .text(`${invoice.company_name} ` || "", 50, 500)
        .moveDown(0.5)
        .text(`${invoice.admin_email}` || "-", { width: 250 })
        .moveDown(0.5)
        .text(`${invoice.admin_address}` || "-", { width: 250 });

      /* ===============================
         FOOTER RIGHT
      =============================== */
      doc
        .text(`${invoice.company_name} ` || "", 410, 515)

        .moveDown(0.5);

      doc.end();
    } catch (error) {
      console.error("PDF ERROR 👉", error);

      if (!res.headersSent) {
        res.status(500).json({
          message: "Failed to generate invoice PDF",
          error: error.message,
        });
      }
    }
  }
);

module.exports = router;
