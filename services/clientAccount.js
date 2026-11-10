const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
require("dotenv").config();

/*
====================================================================
services/clientAccount.js

Shared account plumbing for creating a `clients` row. Lifted out of
routes/clientRoutes.js so the QR registration form creates accounts the
same way the admin panel does: same id format, same bcrypt hashing,
same credentials email.

routes/clientRoutes.js is NOT modified — it keeps its own copies. If you
want a single source of truth later, delete generateClientId() and the
transporter from that file and require them from here instead.
====================================================================
*/

const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
        user: "caredesk360@gmail.com",
        pass: process.env.MAIL_PASS
    }
});

/*
  "3" followed by 8 random digits. Identical to clientRoutes.js so ids
  created through the QR forms and through the admin panel share one
  format.
*/
function generateClientId() {
    const fixedDigit = "3";
    const random = Math.floor(Math.random() * 90000000) + 10000000;
    return fixedDigit + random;
}

/*
  A patient filling a QR form never types a password, but `clients`
  requires one. Generate a readable temporary password and email it,
  exactly like the admin panel does on /client/create.

  I/O/0/1/l are left out — patients type these off a phone screen.
*/
const PW_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ";
const PW_DIGITS = "23456789";

function generateTempPassword() {
    let out = "";

    for (let i = 0; i < 4; i++) {
        out += PW_LETTERS[Math.floor(Math.random() * PW_LETTERS.length)];
    }

    for (let i = 0; i < 4; i++) {
        out += PW_DIGITS[Math.floor(Math.random() * PW_DIGITS.length)];
    }

    return out;
}

function hashPassword(plain) {
    return bcrypt.hash(plain, 10);
}

/*
  Sends the Client ID and temporary password.

  NEVER await this in a request handler in a way that can fail the
  request: the clients row is already committed by then, and a bounced
  email must not turn a successful registration into a 500. Call it and
  attach a .catch(), or use sendClientCredentialsSafe below.
*/
async function sendClientCredentials({ name, email, password, clientId }) {
    return transporter.sendMail({
        from: '"Healthcare Support Team" <info@ridgeveda.com>',
        to: email,
        subject: "Your Patient Account Access Details",
        html: `
    <div style="font-family: Arial, Helvetica, sans-serif; background-color: #f5f7fa; padding: 24px;">
      <div style="max-width: 520px; margin: 0 auto; background-color: #ffffff; padding: 24px; border-radius: 6px; box-shadow: 0 2px 6px rgba(0,0,0,0.05);">

        <h3 style="color: #2c3e50; margin-top: 0;">
          Hello ${name},
        </h3>

        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          Thank you for registering. Below is your Client ID and your temporary access credentials.
        </p>

        <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 20px 0;">
          <p style="margin: 0; font-size: 14px; color: #333;">
            <strong>Client ID:</strong>
            <span style="font-size: 18px; letter-spacing: 1px;">${clientId}</span>
          </p>
          <p style="margin: 8px 0 0; font-size: 14px; color: #333;">
            <strong>Email:</strong> ${email}
          </p>
          <p style="margin: 8px 0 0; font-size: 14px; color: #333;">
            <strong>Temporary Password:</strong> ${password}
          </p>
          <p style="margin: 8px 0 0; font-size: 14px; color: #333;">
            <strong>Login Url:</strong> <a href="https://caredesk360.com/login">click here</a>
          </p>
        </div>

        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          Please keep your Client ID safe — you will be asked for it, along with
          your registered mobile number, whenever you fill in another form at the clinic.
        </p>

        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          For security reasons, please log in and change your password immediately after your first sign-in.
        </p>

        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          If you did not request this account or believe this email was sent to you in error, please contact our support team immediately.
        </p>

        <p style="margin-top: 32px; font-size: 13px; color: #777;">
          Regards,<br />
          <strong>Healthcare Support Team</strong>
        </p>
      </div>

      <p style="text-align: center; margin-top: 12px; font-size: 12px; color: #999;">
        This is an automated message. Please do not reply to this email.
      </p>
    </div>
  `
    });
}

// Fire-and-log wrapper. Never throws, never blocks the response.
function sendClientCredentialsSafe(payload) {
    sendClientCredentials(payload).catch((err) => {
        console.log("Client credentials email failed", payload.email, err.message);
    });
}

module.exports = {
    transporter,
    generateClientId,
    generateTempPassword,
    hashPassword,
    sendClientCredentials,
    sendClientCredentialsSafe
};