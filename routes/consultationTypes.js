const express = require("express");
const router  = express.Router();
const db      = require("../db.js");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles }     = require("../middlewares/roleMiddleware");

function getAdminId(user) {
  return user.role === "admin" ? user.id : user.adminId;
}

/* ── CREATE ── */
router.post(
  "/",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = getAdminId(req.user);
      const { name, description, cost } = req.body;

      if (!name || cost === undefined) {
        return res.status(400).json({ success: false, message: "Name and cost are required" });
      }

      const [result] = await db.execute(
        `INSERT INTO consultation_types (name, description, cost, admin_id)
         VALUES (?, ?, ?, ?)`,
        [name, description || null, cost, adminId]
      );

      res.status(201).json({
        success: true,
        message: "Consultation type created",
        data: { id: result.insertId },
      });
    } catch (err) {
      console.error("Create consultation type error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/* ── LIST ── */
router.get(
  "/",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const adminId = getAdminId(req.user);

      const [rows] = await db.execute(
        `SELECT id, name, description, cost, created_at, updated_at
         FROM consultation_types
         WHERE admin_id = ?
         ORDER BY created_at DESC`,
        [adminId]
      );

      res.json({ success: true, data: rows });
    } catch (err) {
      console.error("List consultation types error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/* ── UPDATE ── */
router.put(
  "/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = getAdminId(req.user);
      const { id }  = req.params;
      const { name, description, cost } = req.body;

      if (!name || cost === undefined) {
        return res.status(400).json({ success: false, message: "Name and cost are required" });
      }

      const [result] = await db.execute(
        `UPDATE consultation_types
         SET name = ?, description = ?, cost = ?
         WHERE id = ? AND admin_id = ?`,
        [name, description || null, cost, id, adminId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: "Consultation type not found" });
      }

      res.json({ success: true, message: "Consultation type updated" });
    } catch (err) {
      console.error("Update consultation type error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

/* ── DELETE ── */
router.delete(
  "/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = getAdminId(req.user);
      const { id }  = req.params;

      const [result] = await db.execute(
        `DELETE FROM consultation_types WHERE id = ? AND admin_id = ?`,
        [id, adminId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: "Consultation type not found" });
      }

      res.json({ success: true, message: "Consultation type deleted" });
    } catch (err) {
      console.error("Delete consultation type error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

module.exports = router;