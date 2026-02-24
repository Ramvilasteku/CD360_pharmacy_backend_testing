const mysql = require("mysql2/promise");

const db = mysql.createPool({
  host: "45.194.3.179",
  user: "healthcare_user",
  password: "StrongPassword@123",
  database: "healthcare_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // ✅ FORCE IST FOR ALL QUERIES
  timezone: "+05:30",
  dateStrings: ["DATE"],
});

// const db = mysql.createPool({
//   host: "localhost",
//   user: "root",
//   password: "root",
//   database: "healthcare",
//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0,
//   dateStrings: ["DATE"],
// });


module.exports = db;
