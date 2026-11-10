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

/* Price of a test: accepts "amount" (or "cost"), blank → null so callers
   can decide between "use 0" (create) and "keep current" (update). */
function readAmount(body = {}) {
  const raw = body.amount ?? body.cost;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
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
      const amount = readAmount(req.body);

      if (!test_name) {
        return res.status(400).json({
          success: false,
          message: "Test name is required",
        });
      }
      if (Number.isNaN(amount)) {
        return res.status(400).json({ success: false, message: "Amount must be a number" });
      }

      const [result] = await db.execute(
        `
        INSERT INTO tests (test_name, test_type, description, amount, admin_id)
        VALUES (?, ?, ?, ?, ?)
        `,
        [
          test_name,
          test_type || null,
          description || null,
          amount ?? 0,
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
        SELECT id, test_name, test_type, description, created_at, amount
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
   2️⃣b QUICK ADD TEST  (the "+" button in the Rx pad's Tests section)
   Returns the full row; if a test with the same name already exists
   for this clinic, returns that one with duplicate: true.
===================================================== */
router.post(
  "/quick-add",
  authMiddleware,
  allowRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);
      const { test_name, test_type, description } = req.body;
      const amount = readAmount(req.body);

      if (!test_name || !String(test_name).trim()) {
        return res.status(400).json({ success: false, message: "Test name is required" });
      }
      if (Number.isNaN(amount)) {
        return res.status(400).json({ success: false, message: "Amount must be a number" });
      }

      const [existing] = await db.execute(
        `
        SELECT id, test_name, test_type, description, amount, created_at
        FROM tests
        WHERE LOWER(TRIM(test_name)) = LOWER(TRIM(?))
          AND admin_id = ?
        LIMIT 1
        `,
        [test_name, adminId]
      );

      if (existing.length > 0) {
        return res.status(200).json({
          success: true,
          duplicate: true,
          message: "Test already exists",
          data: existing[0],
        });
      }

      const [result] = await db.execute(
        `
        INSERT INTO tests (test_name, test_type, description, amount, admin_id)
        VALUES (?, ?, ?, ?, ?)
        `,
        [String(test_name).trim(), test_type || null, description || null, amount ?? 0, adminId]
      );

      const [rows] = await db.execute(
        `SELECT id, test_name, test_type, description, amount, created_at
         FROM tests WHERE id = ?`,
        [result.insertId]
      );

      res.status(201).json({
        success: true,
        duplicate: false,
        message: "Test added successfully",
        data: rows[0],
      });
    } catch (error) {
      console.error("Quick add test error:", error);
      res.status(500).json({ success: false, message: "Server error" });
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
      const amount = readAmount(req.body);
      if (Number.isNaN(amount)) {
        return res.status(400).json({ success: false, message: "Amount must be a number" });
      }

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

      /* amount not sent → keep the current price */
      await db.execute(
        `
        UPDATE tests
        SET test_name = ?, test_type = ?, description = ?, amount = COALESCE(?, amount)
        WHERE id = ? AND admin_id = ?
        `,
        [
          test_name,
          test_type || null,
          description || null,
          amount,
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