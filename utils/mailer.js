const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.zoho.in",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER, // info@ridgeveda.com
    pass: process.env.ZOHO_APP_PASS,  // Zoho app password
  },
});

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

  await transporter.sendMail({
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

          <!-- MAIN CARD -->
          <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 4px 10px rgba(0,0,0,0.05);">

            <!-- HEADER -->
            <tr>
              <td style="background:#2563eb; padding:16px 24px; color:#ffffff;">
                <h2 style="margin:0; font-size:20px;">Appointment Confirmation</h2>
              
              </td>
            </tr>

            <!-- BODY -->
            <tr>
              <td style="padding:24px; color:#111827;">

                <p style="margin-top:0; font-size:15px;">
                  Hello <b>${clientName}</b>,
                </p>

                <p style="font-size:14px; line-height:1.6;">
                  Your appointment has been <b style="color:#16a34a;">successfully booked</b>.  
                  Please find the details below:
                </p>

                <!-- DETAILS TABLE -->
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
  Please arrive at the right time.  
  If you need to reschedule, contact our reception.
</p>

<table cellpadding="0" cellspacing="0" style="margin-top:8px;">
  <tr>

  </tr>
  <tr>
   <td style="font-size:14px; color:#111827; padding-top:4px;">
  📞 <b>Phone:</b>
  ${receptionistPhone
        .split(",")
        .map(
          (phone) => `
        <a href="tel:${phone.trim()}" style="color:#2563eb; text-decoration:none;">
          ${phone.trim()}
        </a>`
        )
        .join(", ")}
</td>

  </tr>
</table>

                <p style="margin-bottom:0; font-size:14px;">
                  Thank you for choosing <b>CareDesk 360</b>.
                </p>

              </td>
            </tr>

            <!-- FOOTER -->
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
  </html>
  `,
  });
};
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

  await transporter.sendMail({
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
        style="background:#ffffff; border-radius:8px; overflow:hidden;
        box-shadow:0 4px 10px rgba(0,0,0,0.05);">

        <tr>
          <td style="background:${statusColor}; padding:16px 24px; color:#ffffff;">
            <h2 style="margin:0; font-size:20px;">Appointment Status ${status}</h2>
          </td>
        </tr>

        <tr>
          <td style="padding:24px; color:#111827;">

            <p>Hello <b>${clientName}</b>,</p>

            <p>Your appointment status has been updated to:</p>

            <!-- STATUS BADGE -->
            <p>
              <span style="
                display:inline-block;
                padding:8px 14px;
                background:${statusColor};
                color:#ffffff;
                border-radius:999px;
                font-weight:bold;
              ">
                ${status}
              </span>
            </p>

            <table width="100%" cellpadding="0" cellspacing="0"
              style="margin:16px 0; border-collapse:collapse;">
              <tr>
                <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Doctor</b></td>
                <td style="padding:10px; border:1px solid #e5e7eb;">${doctorName || "-"
      }</td>
              </tr>
              <tr>
                <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Branch</b></td>
                <td style="padding:10px; border:1px solid #e5e7eb;">${branchName || "-"
      }</td>
              </tr>
              <tr>
                <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Date</b></td>
                <td style="padding:10px; border:1px solid #e5e7eb;">${date || "-"
      }</td>
              </tr>
              <tr>
                <td style="padding:10px; background:#f9fafb; border:1px solid #e5e7eb;"><b>Time</b></td>
                <td style="padding:10px; border:1px solid #e5e7eb;">${fromTime || "-"
      } – ${toTime || "-"}</td>
              </tr>
            </table>


             <p style="font-size:14px; line-height:1.6;">
  Please arrive at the right time.  
  If you need to reschedule, contact our reception.
</p>

<table cellpadding="0" cellspacing="0" style="margin-top:8px;">
  <tr>

  </tr>
  <tr>
   <td style="font-size:14px; color:#111827; padding-top:4px;">
  📞 <b>Phone:</b>
  ${receptionistPhone
        .split(",")
        .map(
          (phone) => `
        <a href="tel:${phone.trim()}" style="color:#2563eb; text-decoration:none;">
          ${phone.trim()}
        </a>`
        )
        .join(", ")}
</td>

  </tr>
</table>
            <p>Thank you for choosing <b>CareDesk 360</b>.</p>

          </td>
        </tr>

        <tr>
          <td style="background:#f9fafb; padding:14px 24px;
            font-size:12px; color:#6b7280; text-align:center;">
            © ${new Date().getFullYear()} CareDesk 360. All rights reserved.
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>

</body>
</html>
`,
  });
};


module.exports = { sendAppointmentEmail, sendAppointmentStatusEmail };
