// utils/sendB2BInvoiceEmail.js
//
// Emails a B2B invoice PDF to the buyer, through the same Gmail SMTP account as the rest of the
// backend (EMAIL_USER / MAIL_PASS). Replies go to the pharmacy's own address.
//
//   await sendB2BInvoiceEmail({ to, cc, subject, message, invoice, seller, pdfBuffer, mailer? });
//
// `mailer` is only for tests: anything with sendMail(options) → Promise.

const nodemailer = require("nodemailer");
const { isValidEmail, parseEmailList } = require("./sendPurchaseOrderEmail");

let shared = null;
function getTransporter() {
  if (!shared) {
    shared = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      rateLimit: 5,
      auth: { user: process.env.EMAIL_USER, pass: process.env.MAIL_PASS },
      tls: { rejectUnauthorized: false },
      family: 4,
    });
  }
  return shared;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const day = (d) => {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(String(d).length === 10 ? `${d}T00:00:00` : d);
  return Number.isNaN(dt.getTime()) ? String(d).slice(0, 10) : dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
const rs = (v) => `Rs. ${(Math.round((Number(v) || 0) * 100) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function defaultSubject(invoice, seller) {
  return `Invoice ${invoice.invoice_number}${seller && seller.business_name ? ` — ${seller.business_name}` : ""}`;
}

function defaultMessage(invoice, seller) {
  const due = Number(invoice.due_amount) || 0;
  return [
    `Dear ${invoice.buyer_name || "Sir/Madam"},`,
    "",
    `Please find our invoice ${invoice.invoice_number} dated ${day(invoice.invoice_date)} attached, for ${rs(invoice.grand_total)}.${
      due > 0 ? ` The balance due is ${rs(due)}${invoice.due_date ? `, payable by ${day(invoice.due_date)}` : ""}.` : ""
    }`,
    "",
    "Thank you for your business.",
    (seller && seller.business_name) || "",
  ]
    .filter((l, i, a) => !(l === "" && i === a.length - 1))
    .join("\n");
}

function buildHtml({ invoice, seller, message }) {
  const body = esc(message).replace(/\n/g, "<br/>");
  const row = (k, v) =>
    v
      ? `<tr><td style="padding:6px 0;font-size:13px;color:#000;width:40%">${esc(k)}</td><td style="padding:6px 0;font-size:13px;color:#000;font-weight:bold">${esc(v)}</td></tr>`
      : "";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:600px;padding:20px">
  <div style="font-size:14px;line-height:1.7;color:#000">${body}</div>
  <table cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px;border-top:1px solid #000;border-bottom:1px solid #000;width:100%">
    ${row("Invoice number", invoice.invoice_number)}
    ${row("Date", day(invoice.invoice_date))}
    ${row("Total", rs(invoice.grand_total))}
    ${Number(invoice.due_amount) > 0 ? row("Balance due", rs(invoice.due_amount)) : ""}
    ${row("Due date", invoice.due_date ? day(invoice.due_date) : "")}
  </table>
  <div style="font-size:12px;color:#000;margin-top:10px">The full invoice is attached as <b>${esc(invoice.invoice_number)}.pdf</b>.</div>
  <div style="font-size:12px;color:#000;margin-top:18px;line-height:1.6">
    <b>${esc((seller && seller.business_name) || "")}</b>
    ${seller && seller.phone ? `<br/>Ph: ${esc(seller.phone)}` : ""}${seller && seller.email ? `<br/>${esc(seller.email)}` : ""}
  </div>
</div></body></html>`;
}

async function sendB2BInvoiceEmail({ to, cc, subject, message, invoice, seller, pdfBuffer, mailer }) {
  if (!pdfBuffer || pdfBuffer.length < 500) throw new Error("The PDF could not be produced");
  const recipients = Array.isArray(to) ? to : parseEmailList(to);
  if (!recipients || !recipients.length) throw new Error("No valid email address to send to");

  const mail = {
    from: `"${String((seller && seller.business_name) || "CareDesk 360").replace(/"/g, "")}" <${process.env.EMAIL_USER}>`,
    to: recipients.join(", "),
    subject: subject && String(subject).trim() ? String(subject).trim() : defaultSubject(invoice, seller),
    html: buildHtml({ invoice, seller, message: message && String(message).trim() ? String(message) : defaultMessage(invoice, seller) }),
    attachments: [{ filename: `${invoice.invoice_number}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
  };
  if (cc && cc.length) mail.cc = (Array.isArray(cc) ? cc : parseEmailList(cc) || []).join(", ") || undefined;
  if (seller && seller.email && isValidEmail(seller.email)) mail.replyTo = seller.email;

  const m = mailer || getTransporter();
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const info = await m.sendMail(mail);
      return { to: recipients, messageId: info && info.messageId };
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw new Error(`Email failed: ${lastErr.message}`);
}

module.exports = { sendB2BInvoiceEmail, defaultSubject, defaultMessage };