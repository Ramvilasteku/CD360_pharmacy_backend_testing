const nodemailer = require("nodemailer");
const fs   = require("fs");    // ← add this line at top of prescription.route.js
const path = require("path");  // already there
/* ─────────────────────────────────────────────
   TRANSPORTER — pool:true fixes stale connection
   which causes "sometimes sends, sometimes not"
───────────────────────────────────────────── */
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  pool: true,           // ← KEY FIX: reuse connections, prevents stale socket
  maxConnections: 3,
  maxMessages: 100,
  rateLimit: 5,         // max 5 mails/second
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.MAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false, // ← prevents TLS handshake failures on some servers
  },
  family: 4
});

/* ─────────────────────────────────────────────
   Verify SMTP on startup — logs clearly if broken
───────────────────────────────────────────── */
transporter.verify((error) => {
  if (error) {
    console.error("❌ SMTP connection FAILED:", error.message);
    console.error("   Check EMAIL_USER and MAIL_PASS in your .env");
  } else {
    console.log("✅ SMTP ready — mailer connected to Gmail");
  }
});

/* ─────────────────────────────────────────────
   Retry wrapper — retries up to 3 times
   This fixes the "sometimes fails" issue
───────────────────────────────────────────── */
const sendWithRetry = async (mailOptions, retries = 3, delayMs = 2000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`✅ Mail sent to ${mailOptions.to} (attempt ${attempt}) — MessageId: ${info.messageId}`);
      return info;
    } catch (err) {
      console.warn(`⚠ Mail attempt ${attempt}/${retries} failed to ${mailOptions.to}:`, err.message);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw new Error(`Mail failed after ${retries} attempts: ${err.message}`);
      }
    }
  }
};

/* ─────────────────────────────────────────────
   APPOINTMENT CONFIRMED
───────────────────────────────────────────── */
const sendAppointmentEmail = async (to, data) => {
  const {
    clientName,
    doctorName,
    branchName,
    receptionistPhone,
    date,
    fromTime,
    toTime,
  } = data;

   if (!pdfBuffer || pdfBuffer.length < 500) {
    throw new Error(`PDF buffer invalid for patient ${patientName}`);
  }

  const attachments = [
    {
      filename: `Prescription-${patientName}.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf",
    },
  ];
  // ✅ ADD THIS BLOCK (ONLY THIS)
  if (clinicLogo) {
    attachments.push({
      filename: "clinic-logo.png",
      path: clinicLogo,     // ← LOCAL FILE PATH
      cid: "clinic-logo",   // ← MUST MATCH img src
    });
  }
  await sendWithRetry({
    from: `"CareDesk 360" <${process.env.EMAIL_USER}>`,
    to,
    subject: "Appointment Confirmed",
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Appointment Confirmed</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f6f8; font-family:Arial, Helvetica, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8; padding:20px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 4px 10px rgba(0,0,0,0.05);">
          <tr>
            <td style="background:#2563eb; padding:16px 24px; color:#ffffff;">
              <h2 style="margin:0; font-size:20px;">Appointment Confirmation</h2>
            </td>
          </tr>
          <tr>
            <td style="padding:24px; color:#111827;">
              <p style="margin-top:0; font-size:15px;">Hello <b>${clientName}</b>,</p>
              <p style="font-size:14px; line-height:1.6;">
                Your appointment has been <b style="color:#16a34a;">successfully booked</b>.
                Please find the details below:
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; border-collapse:collapse;">
                <tr>
                  <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Doctor</b></td>
                  <td style="padding:10px; border:1px solid #e5e7eb;">${doctorName}</td>
                </tr>
                <tr>
                  <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Branch</b></td>
                  <td style="padding:10px; border:1px solid #e5e7eb;">${branchName}</td>
                </tr>
                <tr>
                  <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Date</b></td>
                  <td style="padding:10px; border:1px solid #e5e7eb;">${date}</td>
                </tr>
                <tr>
                  <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Time</b></td>
                  <td style="padding:10px; border:1px solid #e5e7eb;">${fromTime} – ${toTime}</td>
                </tr>
              </table>
              <p style="font-size:14px; line-height:1.6;">
                Please arrive at the right time. If you need to reschedule, contact our reception.
              </p>
              <p style="font-size:14px; color:#111827;">
                📞 <b>Phone:</b>
                ${receptionistPhone
                  .split(",")
                  .map((phone) => `<a href="tel:${phone.trim()}" style="color:#2563eb; text-decoration:none;">${phone.trim()}</a>`)
                  .join(", ")}
              </p>
              <p style="margin-bottom:0; font-size:14px;">Thank you for choosing <b>CareDesk 360</b>.</p>
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb; padding:14px 24px; font-size:12px; color:#6b7280; text-align:center;">
              © ${new Date().getFullYear()} CareDesk 360. All rights reserved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  });
};

/* ─────────────────────────────────────────────
   APPOINTMENT STATUS UPDATE
───────────────────────────────────────────── */
const sendAppointmentStatusEmail = async (to, data) => {
  const {
    clientName,
    doctorName,
    branchName,
    date,
    receptionistPhone,
    fromTime,
    toTime,
    status,
    statusColor,
  } = data;

  await sendWithRetry({
    from: `"CareDesk 360" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Appointment ${status}`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Appointment Status Updated</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f6f8; font-family:Arial, Helvetica, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8; padding:20px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0"
          style="background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 4px 10px rgba(0,0,0,0.05);">
          <tr>
            <td style="background:${statusColor}; padding:16px 24px; color:#ffffff;">
              <h2 style="margin:0; font-size:20px;">Appointment Status ${status}</h2>
            </td>
          </tr>
          <tr>
            <td style="padding:24px; color:#111827;">
              <p>Hello <b>${clientName}</b>,</p>
              <p>Your appointment status has been updated to:</p>
              <p>
                <span style="display:inline-block; padding:8px 14px; background:${statusColor}; color:#ffffff; border-radius:999px; font-weight:bold;">
                  ${status}
                </span>
              </p>
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0; border-collapse:collapse;">
                <tr>
                  <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Doctor</b></td>
                  <td style="padding:10px; border:1px solid #e5e7eb;">${doctorName || "-"}</td>
                </tr>
                <tr>
                  <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Branch</b></td>
                  <td style="padding:10px; border:1px solid #e5e7eb;">${branchName || "-"}</td>
                </tr>
                <tr>
                  <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Date</b></td>
                  <td style="padding:10px; border:1px solid #e5e7eb;">${date || "-"}</td>
                </tr>
                <tr>
                  <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Time</b></td>
                  <td style="padding:10px; border:1px solid #e5e7eb;">${fromTime || "-"} – ${toTime || "-"}</td>
                </tr>
              </table>
              <p style="font-size:14px; line-height:1.6;">
                Please arrive at the right time. If you need to reschedule, contact our reception.
              </p>
              <p style="font-size:14px; color:#111827;">
                📞 <b>Phone:</b>
                ${receptionistPhone
                  .split(",")
                  .map((phone) => `<a href="tel:${phone.trim()}" style="color:#2563eb; text-decoration:none;">${phone.trim()}</a>`)
                  .join(", ")}
              </p>
              <p>Thank you for choosing <b>CareDesk 360</b>.</p>
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb; padding:14px 24px; font-size:12px; color:#6b7280; text-align:center;">
              © ${new Date().getFullYear()} CareDesk 360. All rights reserved.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  });
};

/* ─────────────────────────────────────────────
   PRESCRIPTION EMAIL
───────────────────────────────────────────── */
const sendPrescriptionEmail = async (to, data, pdfBuffer) => {
  const {
    patientName,
    doctorName,
    clinicName,
    clinicLogoPath,
    clinicPhone,
    clinicEmail,
    date,
  } = data;
 
  /* ── Guard: reject broken PDF ── */
  if (!pdfBuffer || pdfBuffer.length < 500) {
    throw new Error(
      `PDF buffer invalid for ${patientName} — size: ${pdfBuffer?.length ?? 0} bytes`
    );
  }
 
  /* ── Check logo file exists on disk ── */
  const logoExists = clinicLogoPath && fs.existsSync(clinicLogoPath);
 
  /* ── Build attachments array ── */
  const attachments = [
    {
      filename:    `Prescription-${patientName}.pdf`,
      content:     pdfBuffer,
      contentType: "application/pdf",
    },
  ];
 
  /* ── Attach logo as CID inline image (only if file exists) ── */
  if (logoExists) {
    const ext      = path.extname(clinicLogoPath).toLowerCase().replace(".", ""); // png / jpg
    const mimeType = ext === "png" ? "image/png" : "image/jpeg";
    attachments.push({
      filename:    `clinic-logo.${ext}`,
      path:        clinicLogoPath,  // nodemailer reads from disk
      cid:         "clinic-logo",   // matches src="cid:clinic-logo" in HTML
      contentType: mimeType,
    });
  }
 
  await sendWithRetry({
    from:        `"${clinicName}" <${process.env.EMAIL_USER}>`,
    to,
    subject:     `Your Prescription — ${clinicName}`,
    attachments,
    html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Prescription</title>
</head>
<body style="margin:0; padding:0; background-color:#e8f0f2;
             font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
 
  <table width="100%" cellpadding="0" cellspacing="0" border="0"
    style="background:#e8f0f2; padding:32px 0;">
    <tr>
      <td align="center">
 
        <!-- MAIN CARD -->
        <table width="620" cellpadding="0" cellspacing="0" border="0"
          style="max-width:620px; width:100%; border-radius:14px; overflow:hidden;
                 box-shadow:0 8px 32px rgba(0,0,0,0.12);">
 
          <!-- ══ HEADER — 3 COLUMNS ══ -->
          <tr>
            <td style="background:#3f6f7a; padding:0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
 
                  <!-- COL 1: Logo + Clinic Name -->
                  <td width="34%" valign="middle"
                    style="padding:24px 16px 24px 24px;
                           border-right:1px solid rgba(255,255,255,0.15);">
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        ${logoExists ? `
                        <td style="padding-right:10px; vertical-align:middle;">
                          <img
                            src="cid:clinic-logo"
                            alt="${clinicName}"
                            width="44"
                            height="44"
                            style="display:block; width:44px; height:44px;
                                   object-fit:contain; border-radius:6px;
                                   background:#ffffff; padding:3px;" />
                        </td>` : ""}
                        <td style="vertical-align:middle;">
                          <div style="color:#ffffff; font-size:15px; font-weight:700;
                                      letter-spacing:0.3px; line-height:1.3;">
                            ${clinicName}
                          </div>
                         
                        </td>
                      </tr>
                    </table>
                  </td>
 
                  <!-- COL 2: Date + Patient -->
                  <td width="33%" valign="middle" align="center"
                    style="padding:24px 14px;
                           border-right:1px solid rgba(255,255,255,0.15);">
                    <div style="color:rgba(255,255,255,0.6); font-size:9px;
                                text-transform:uppercase; letter-spacing:1px; font-weight:700;">
                      Prescribed Date
                    </div>
                    <div style="color:#ffffff; font-size:14px; font-weight:700; margin-top:5px;">
                      ${date}
                    </div>
                    <div style="margin-top:12px; border-top:1px solid rgba(255,255,255,0.15);
                                padding-top:10px;">
                      <div style="color:rgba(255,255,255,0.6); font-size:9px;
                                  text-transform:uppercase; letter-spacing:1px; font-weight:700;">
                        Patient
                      </div>
                      <div style="color:#ffffff; font-size:13px; font-weight:600; margin-top:4px;">
                        ${patientName}
                      </div>
                    </div>
                  </td>
 
                  <!-- COL 3: Doctor -->
                  <td width="33%" valign="middle" align="center"
                    style="padding:24px 14px;">
                    <div style="color:rgba(255,255,255,0.6); font-size:9px;
                                text-transform:uppercase; letter-spacing:1px; font-weight:700;">
                      Attending Doctor
                    </div>
                    <div style="color:#ffffff; font-size:14px; font-weight:700; margin-top:5px;">
                      ${doctorName}
                    </div>
                   
                  </td>
 
                </tr>
              </table>
            </td>
          </tr>
 
 
         
 
          <!-- ══ GREETING ══ -->
          <tr>
            <td style="background:#dff0f3; padding:13px 28px;
                       border-bottom:2px solid #b2d8df;">
              <p style="margin:0; font-size:14px; color:#1a5f6e; font-weight:500;">
                Hello, <strong>${patientName}</strong> &#128075; &mdash; Your prescription from
                <strong>${clinicName}</strong> is ready.
              </p>
            </td>
          </tr>
 
          <!-- ══ BODY ══ -->
          <tr>
            <td style="background:#ffffff; padding:28px 28px;">
 
              <p style="margin:0 0 20px; font-size:14px; color:#37474f; line-height:1.75;">
                Please find your prescription attached to this email as a
                <strong>PDF document</strong>. It has been issued by your doctor
                after your recent consultation.
              </p>
 
              <!-- Details card -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="border:1px solid #d8eaed; border-radius:10px;
                       overflow:hidden; margin-bottom:20px;">
                <tr>
                  <td colspan="2" style="background:#3f6f7a; padding:10px 20px;">
                    <span style="color:#ffffff; font-size:10px; font-weight:700;
                                 text-transform:uppercase; letter-spacing:1px;">
                      Prescription Details
                    </span>
                  </td>
                </tr>
                <tr>
                  <td width="38%" style="padding:10px 20px; background:#f4fafb;
                      border-bottom:1px solid #e0eef0; font-size:10px; color:#6b9ea8;
                      font-weight:700; text-transform:uppercase; letter-spacing:0.7px;">
                    Patient
                  </td>
                  <td style="padding:10px 20px; background:#f4fafb;
                      border-bottom:1px solid #e0eef0; font-size:13px;
                      color:#1a3a40; font-weight:600;">
                    ${patientName}
                  </td>
                </tr>
                <tr>
                  <td width="38%" style="padding:10px 20px; background:#ffffff;
                      border-bottom:1px solid #e0eef0; font-size:10px; color:#6b9ea8;
                      font-weight:700; text-transform:uppercase; letter-spacing:0.7px;">
                    Doctor
                  </td>
                  <td style="padding:10px 20px; background:#ffffff;
                      border-bottom:1px solid #e0eef0; font-size:13px;
                      color:#1a3a40; font-weight:600;">
                    ${doctorName}
                  </td>
                </tr>
                <tr>
                  <td width="38%" style="padding:10px 20px; background:#f4fafb;
                      border-bottom:1px solid #e0eef0; font-size:10px; color:#6b9ea8;
                      font-weight:700; text-transform:uppercase; letter-spacing:0.7px;">
                    Clinic
                  </td>
                  <td style="padding:10px 20px; background:#f4fafb;
                      border-bottom:1px solid #e0eef0; font-size:13px;
                      color:#1a3a40; font-weight:600;">
                    ${clinicName}
                  </td>
                </tr>
                <tr>
                  <td width="38%" style="padding:10px 20px; background:#ffffff;
                      font-size:10px; color:#6b9ea8; font-weight:700;
                      text-transform:uppercase; letter-spacing:0.7px;">
                    Date
                  </td>
                  <td style="padding:10px 20px; background:#ffffff;
                      font-size:13px; color:#1a3a40; font-weight:600;">
                    ${date}
                  </td>
                </tr>
              </table>
 
              <!-- Attachment note -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:#f0faf8; border:1px solid #b2ddd6;
                       border-radius:8px; margin-bottom:20px;">
                <tr>
                  <td style="padding:14px 18px;">
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="font-size:20px; padding-right:12px; vertical-align:middle;">
                          &#128206;
                        </td>
                        <td style="vertical-align:middle;">
                          <div style="font-size:13px; color:#1a5f4a; font-weight:600;">
                            Prescription-${patientName}.pdf attached
                          </div>
                          <div style="font-size:11px; color:#4a8a7a; margin-top:2px;">
                            Download and print for your records or show at the pharmacy.
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
 
              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding-top:4px;">
                    <a href="https://caredesk360.com/login"
                      style="display:inline-block; background:#3f6f7a; color:#ffffff;
                             font-size:13px; font-weight:700; text-decoration:none;
                             padding:12px 32px; border-radius:8px; letter-spacing:0.3px;">
                      View Prescription in Dashboard
                    </a>
                  </td>
                </tr>
              </table>
 
            </td>
          </tr>
 
          <!-- ══ FOOTER ══ -->
          <tr>
            <td style="background:#2d5560; padding:0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
 
                  <!-- Left: Logo + Clinic Name -->
                  <td valign="middle" style="padding:18px 24px;">
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        ${logoExists ? `
                        <td style="padding-right:10px; vertical-align:middle;">
                          <img
                            src="cid:clinic-logo"
                            alt="${clinicName}"
                            width="34"
                            height="34"
                            style="display:block; width:34px; height:34px;
                                   object-fit:contain; border-radius:5px;
                                   background:#ffffff; padding:2px;" />
                        </td>` : ""}
                        <td style="vertical-align:middle;">
                          <div style="color:#ffffff; font-size:13px; font-weight:700;">
                            ${clinicName}
                          </div>
                          <div style="color:rgba(255,255,255,0.45); font-size:10px; margin-top:2px;">
                            &copy; ${new Date().getFullYear()} All rights reserved.
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
 
                  <!-- Right: Contact -->
                  <td valign="middle" align="right" style="padding:18px 24px;">
                    ${clinicPhone ? `
                    <div style="color:rgba(250, 246, 246, 0.8); font-size:11px; margin-bottom:5px;">
                      &#128222; ${clinicPhone}
                    </div>` : ""}
                    ${clinicEmail ? `
                    <div style="color:rgba(250, 250, 250, 0.8); font-size:11px;">
                      &#9993; ${clinicEmail}
                    </div>` : ""}
                  </td>
 
                </tr>
              </table>
            </td>
          </tr>
 
        </table>
 
      </td>
    </tr>
  </table>
 
</body>
</html>`,
  });
};

module.exports = { sendAppointmentEmail, sendAppointmentStatusEmail, sendPrescriptionEmail };