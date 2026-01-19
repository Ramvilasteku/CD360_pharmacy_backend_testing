const mysql = require("mysql2/promise");

const db = mysql.createPool({
  host: "localhost",
  user: "healthcare_user",
  password: "Strongpassword@123",
  database: "healthcare_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: ["DATE"],
});

module.exports = db;
