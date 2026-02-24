const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { verifyToken } = require("./authMiddleware");

const router = express.Router();


// ============================
// REGISTER
// ============================
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const hashedPassword = await bcrypt.hash(password, 10);

    await db.execute(
      "INSERT INTO admin_users (name, email, password_hash) VALUES (?, ?, ?)",
      [name, email, hashedPassword]
    );

    res.json({ message: "Admin registered successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================
// LOGIN
// ============================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const [rows] = await db.execute(
      "SELECT * FROM admin_users WHERE email = ?",
      [email]
    );

    if (rows.length === 0)
      return res.status(400).json({ message: "Invalid credentials" });

    const admin = rows[0];

    const validPassword = await bcrypt.compare(password, admin.password_hash);

    if (!validPassword)
      return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: admin.id }, // no role
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      message: "Login successful",
      token,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ============================
// PROTECTED ROUTE
// ============================
router.get("/dashboard", verifyToken, async (req, res) => {
  res.json({
    message: "Welcome Admin",
    adminId: req.admin.id,
  });
});


module.exports = router;