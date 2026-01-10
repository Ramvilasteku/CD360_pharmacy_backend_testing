const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.zoho.in",
  port: 587,
  secure: false,
  auth: {
    user: "info@ridgeveda.com", // example@gmail.com
    pass: process.env.ZOHO_APP_PASS  // app password
  }
});

const sendAppointmentEmail = async (to, data) => {
  const { clientName, doctorName, branchName, date, fromTime, toTime } = data;

  await transporter.sendMail({
    from: `"Clinic App" <${process.env.EMAIL_USER}>`,
    to,
    subject: "Appointment Confirmed",
    html: `
      <h3>Appointment Confirmation</h3>
      <p>Hello <b>${clientName}</b>,</p>
      <p>Your appointment has been successfully booked.</p>
      <table border="1" cellpadding="8" cellspacing="0">
        <tr><td><b>Doctor</b></td><td> ${doctorName}</td></tr>
        <tr><td><b>Branch</b></td><td>${branchName}</td></tr>
        <tr><td><b>Date</b></td><td>${date}</td></tr>
        <tr><td><b>Time</b></td><td>${fromTime} - ${toTime}</td></tr>
      </table>
      <p>Thank you.</p>
    `
  });
};
const sendAppointmentStatusEmail = async (to, data) => {
  const { clientName, doctorName, branchName, date, fromTime, toTime, status } = data;

  await transporter.sendMail({
    from: `"Clinic App" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Appointment Status: ${status}`,
    html: `
      <h3>Appointment Status Updated</h3>
      <p>Hello <b>${clientName}</b>,</p>
      <p>Your appointment status has been updated to: <b>${status}</b></p>
      <table border="1" cellpadding="8" cellspacing="0">
        <tr><td><b>Doctor</b></td><td>${doctorName || "-"}</td></tr>
        <tr><td><b>Branch</b></td><td>${branchName || "-"}</td></tr>
        <tr><td><b>Date</b></td><td>${date || "-"}</td></tr>
        <tr><td><b>Time</b></td><td>${fromTime || "-"} - ${toTime || "-"}</td></tr>
      </table>
      <p>Thank you.</p>
    `
  });
};


module.exports = { sendAppointmentEmail,sendAppointmentStatusEmail };
