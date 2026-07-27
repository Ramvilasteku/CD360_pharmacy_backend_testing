const nodemailer = require("nodemailer");

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
});

async function sendEmail(to, subject, html) {

    try {

        await transporter.sendMail({
            from: `"Hospital Management System" <${process.env.EMAIL_USER}>`,
            to,
            subject,
            html
        });

        console.log("Email sent successfully to:", to);

    } catch (error) {

        console.error("Email Error:", error);
        throw error;

    }

}

module.exports = sendEmail;