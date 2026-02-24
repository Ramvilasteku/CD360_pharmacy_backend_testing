const express = require("express");
const router = express.Router();
const db = require("../db");

// =============================
// 🎯 DEMO REQUEST CRUD
// =============================

// ➤ CREATE
router.post("/post", async (req, res) => {
  try {
    const { name, email, phone, requirements } = req.body;

    const [result] = await db.execute(
      `INSERT INTO demo_requests (name, email, phone, requirements) 
       VALUES (?, ?, ?, ?)`,
      [name, email, phone, requirements],
    );

    res
      .status(201)
      .json({ message: "Demo request created", id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ➤ READ ALL
router.get("/get", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM demo_requests ORDER BY created_at DESC",
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
      "SELECT * FROM demo_requests WHERE id = ?",
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
    const { name, email, phone, requirements } = req.body;

    await db.execute(
      `UPDATE demo_requests 
       SET name=?, email=?, phone=?, requirements=?
       WHERE id=?`,
      [name, email, phone, requirements,req.params.id],
    );

    res.json({ message: "Demo updated" });
  } catch (err) {
    res.status(500).json({ error: err.message,err });
  }
});

// ➤ DELETE
router.delete("/delete/:id", async (req, res) => {
  try {
    await db.execute("DELETE FROM demo_requests WHERE id=?", [req.params.id]);
    res.json({ message: "Demo deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
