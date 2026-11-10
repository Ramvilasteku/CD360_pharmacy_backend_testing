// utils/sendPurchaseOrderEmail.js
//
// Emails a purchase order PDF to a supplier. Uses the same Gmail SMTP account as the rest
// of the backend (EMAIL_USER / MAIL_PASS). Replies go to the pharmacy's own address, not to
// that shared mailbox, because the supplier will answer the order.
//
//   await sendPurchaseOrderEmail({ to, cc, subject, message, order, supplier, company, pdfBuffer, mailer? });
//
// `mailer` is only for tests: anything with sendMail(options) → Promise.

const nodemailer = require("nodemailer");

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

const EMAIL_RE = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/;
const isValidEmail = (v) => typeof v === "string" && EMAIL_RE.test(v.trim());

/* "a@x.com, b@y.com" → ["a@x.com","b@y.com"], or null when any one is not an address */
function parseEmailList(value) {
  const list = String(value || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length || list.some((e) => !isValidEmail(e))) return null;
  return [...new Set(list.map((e) => e.toLowerCase()))];
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? String(d).slice(0, 10) : dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

function defaultSubject(order, company) {
  return `Purchase order ${order.purchase_number}${company?.name ? ` — ${company.name}` : ""}`;
}

function defaultMessage(order, supplier, company) {
  const who = supplier?.contact_person || supplier?.supplier_name || "Sir/Madam";
  return [
    `Dear ${who},`,
    "",
    `Please find our purchase order ${order.purchase_number} attached. ${
      order.expected_delivery_date
        ? `We would like to receive it by ${fmtDate(order.expected_delivery_date)}. Kindly confirm the order.`
        : "Kindly confirm the order and let us know when we can expect delivery."
    }`,
    "",
    "Thank you.",
    company?.name || "",
  ]
    .filter((l, i, a) => !(l === "" && i === a.length - 1))
    .join("\n");
}

function buildHtml({ order, supplier, company, message, lineCount }) {
  const body = esc(message).replace(/\n/g, "<br/>");
  const row = (k, v) =>
    v
      ? `<tr><td style="padding:6px 0;font-size:13px;color:#000;width:40%">${esc(k)}</td><td style="padding:6px 0;font-size:13px;color:#000;font-weight:bold">${esc(v)}</td></tr>`
      : "";
  // plain on purpose: black text on white, sans-serif, and no prices - same as the attached PDF
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:600px;padding:20px">
  <div style="font-size:14px;line-height:1.7;color:#000">${body}</div>
  <table cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px;border-top:1px solid #000;border-bottom:1px solid #000;width:100%">
    ${row("PO number", order.purchase_number)}
    ${row("Date", fmtDate(order.purchase_date))}
    ${row("Items", `${lineCount} line${lineCount === 1 ? "" : "s"}`)}
    ${row("Receive by", order.expected_delivery_date ? fmtDate(order.expected_delivery_date) : "")}
    ${row("Deliver to", order.branch ? `${order.branch} branch` : "")}
  </table>
  <div style="font-size:12px;color:#000;margin-top:10px">The full order is attached as <b>${esc(order.purchase_number)}.pdf</b>.</div>
  <div style="font-size:12px;color:#000;margin-top:18px;line-height:1.6">
    <b>${esc(company?.name || "")}</b>
    ${company?.phone ? `<br/>Ph: ${esc(company.phone)}` : ""}${company?.email ? `<br/>${esc(company.email)}` : ""}
  </div>
</div></body></html>`;
}

async function sendPurchaseOrderEmail({ to, cc, subject, message, order, supplier, company, pdfBuffer, lineCount = 0, mailer }) {
  if (!pdfBuffer || pdfBuffer.length < 500) throw new Error("The PDF could not be produced");
  const recipients = Array.isArray(to) ? to : parseEmailList(to);
  if (!recipients || !recipients.length) throw new Error("No valid email address to send to");

  const mail = {
    from: `"${String(company?.name || "CareDesk 360").replace(/"/g, "")}" <${process.env.EMAIL_USER}>`,
    to: recipients.join(", "),
    subject: subject && String(subject).trim() ? String(subject).trim() : defaultSubject(order, company),
    html: buildHtml({ order, supplier, company, message: message && String(message).trim() ? String(message) : defaultMessage(order, supplier, company), lineCount }),
    attachments: [{ filename: `${order.purchase_number}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
  };
  if (cc && cc.length) mail.cc = (Array.isArray(cc) ? cc : parseEmailList(cc) || []).join(", ") || undefined;
  if (company?.email && isValidEmail(company.email)) mail.replyTo = company.email;

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

module.exports = { sendPurchaseOrderEmail, defaultSubject, defaultMessage, isValidEmail, parseEmailList };