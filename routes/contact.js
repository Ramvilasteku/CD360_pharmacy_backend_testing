const express = require("express");
const router = express.Router();
const db = require("../db");


// =============================
// COMPANY REGISTRATIONS CRUD
// =============================


// CREATE
router.post("/post", async (req, res) => {
  try {
    const {
      full_name,
      hospital_name,
      mobile,
      email,
      address,
      plan,
      date,
      time,
    } = req.body;

    const [result] = await db.execute(
      `
      INSERT INTO company_registrations
      (
        full_name,
        hospital_name,
        mobile,
        email,
        address,
        plan,
        preferred_date,
        preferred_time
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        full_name,
        hospital_name,
        mobile,
        email,
        address,
        plan,
        date,
        time,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Registration created successfully",
      id: result.insertId,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


// GET ALL
router.get("/get", async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT *
      FROM company_registrations
      ORDER BY created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});


// GET BY ID
router.get("/getbyid/:id", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT *
      FROM company_registrations
      WHERE id = ?
      `,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        message: "Registration not found",
      });
    }

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});


// UPDATE
router.put("/update/:id", async (req, res) => {
  try {
    const {
      full_name,
      hospital_name,
      mobile,
      email,
      address,
      plan,
      date,
      time,
    } = req.body;

    await db.execute(
      `
      UPDATE company_registrations
      SET
        full_name = ?,
        hospital_name = ?,
        mobile = ?,
        email = ?,
        address = ?,
        plan = ?,
        preferred_date = ?,
        preferred_time = ?
      WHERE id = ?
      `,
      [
        full_name,
        hospital_name,
        mobile,
        email,
        address,
        plan,
        date,
        time,
        req.params.id,
      ]
    );

    res.json({
      success: true,
      message: "Registration updated successfully",
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});


// DELETE
router.delete("/delete/:id", async (req, res) => {
  try {
    await db.execute(
      `
      DELETE FROM company_registrations
      WHERE id = ?
      `,
      [req.params.id]
    );

    res.json({
      success: true,
      message: "Registration deleted successfully",
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

module.exports = router;