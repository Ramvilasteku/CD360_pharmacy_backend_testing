const mysql = require("mysql2/promise");

// Connection details come from .env (never commit real credentials).
// The fallbacks match the local development setup, so nothing changes
// on a machine that has no DB_* variables set.
const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "root",
  database: process.env.DB_NAME || "caredesk360",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
  queueLimit: 0,
  dateStrings: ["DATE"],
});

module.exports = db;