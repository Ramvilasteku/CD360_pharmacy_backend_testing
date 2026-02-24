const express = require("express");
const router = express.Router();
const db = require("../db");

// =============================
// 🏢 COMPANY REGISTRATION CRUD
// =============================

// ➤ CREATE
router.post("/post", async (req, res) => {
  try {
    const {
      full_name,
      hospital_name,
      mobile,
      email,
      address,
    } = req.body;

    const [result] = await db.execute(
      `INSERT INTO company_registrations 
       (full_name, hospital_name, mobile, email, address) 
       VALUES (?, ?, ?, ?, ?)`,
      [full_name, hospital_name, mobile, email, address],
    );

    res.status(201).json({ message: "Company created", id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ➤ READ ALL
router.get("/get", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM company_registrations ORDER BY created_at DESC",
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ➤ READ ONE
router.get("/getbyid/:id", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM company_registrations WHERE id = ?",
      [req.params.id],
    );

    if (rows.length === 0)
      return res.status(404).json({ message: "Not found" });

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ➤ UPDATE
router.put("/update/:id", async (req, res) => {
  try {
    const { full_name, hospital_name, mobile, email, address,  } =
      req.body;

    await db.execute(
      `UPDATE company_registrations 
       SET full_name=?, hospital_name=?, mobile=?, email=?, address=?
       WHERE id=?`,
      [full_name, hospital_name, mobile, email, address, req.params.id],
    );

    res.json({ message: "Company updated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ➤ DELETE
router.delete("/delete/:id", async (req, res) => {
  try {
    await db.execute("DELETE FROM company_registrations WHERE id=?", [
      req.params.id,
    ]);
    res.json({ message: "Company deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
