const express = require("express");
const router = express.Router();
const db = require("../db.js");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* =====================================================
   Helper: Get Admin ID
===================================================== */
function getAdminIdFromUser(user) {
  if (user.role === "admin") return user.id;
  return user.adminId;
}

/* =====================================================
   1️⃣ ADD TEST
===================================================== */
router.post(
  "/",
  authMiddleware,
  allowRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);

      const { test_name, test_type, description } = req.body;

      if (!test_name) {
        return res.status(400).json({
          success: false,
          message: "Test name is required",
        });
      }

      const [result] = await db.execute(
        `
        INSERT INTO tests (test_name, test_type, description, admin_id)
        VALUES (?, ?, ?, ?)
        `,
        [
          test_name,
          test_type || null,
          description || null,
          adminId,
        ]
      );

      res.status(201).json({
        success: true,
        message: "Test added successfully",
        data: { id: result.insertId },
      });

    } catch (error) {
      console.error("Add test error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

/* =====================================================
   2️⃣ GET ALL TESTS
===================================================== */
router.get(
  "/",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);

      const [rows] = await db.execute(
        `
        SELECT id, test_name, test_type, description, created_at
        FROM tests
        WHERE admin_id = ?
        ORDER BY created_at DESC
        `,
        [adminId]
      );

      res.json({
        success: true,
        data: rows,
      });

    } catch (error) {
      console.error("Get tests error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

/* =====================================================
   3️⃣ UPDATE TEST
===================================================== */
router.put(
  "/:id",
  authMiddleware,
  allowRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);
      const { id } = req.params;
      const { test_name, test_type, description } = req.body;

      const [existing] = await db.execute(
        `SELECT id FROM tests WHERE id = ? AND admin_id = ?`,
        [id, adminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Test not found",
        });
      }

      await db.execute(
        `
        UPDATE tests
        SET test_name = ?, test_type = ?, description = ?
        WHERE id = ? AND admin_id = ?
        `,
        [
          test_name,
          test_type || null,
          description || null,
          id,
          adminId,
        ]
      );

      res.json({
        success: true,
        message: "Test updated successfully",
      });

    } catch (error) {
      console.error("Update test error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

/* =====================================================
   4️⃣ DELETE TEST
===================================================== */
router.delete(
  "/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);
      const { id } = req.params;

      const [result] = await db.execute(
        `DELETE FROM tests WHERE id = ? AND admin_id = ?`,
        [id, adminId]
      );

      if (!result.affectedRows) {
        return res.status(404).json({
          success: false,
          message: "Test not found",
        });
      }

      res.json({
        success: true,
        message: "Test deleted successfully",
      });

    } catch (error) {
      console.error("Delete test error:", error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

module.exports = router;
