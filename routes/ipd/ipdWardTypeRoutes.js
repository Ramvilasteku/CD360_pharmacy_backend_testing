const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");

//
// ===================== CREATE WARD TYPE =====================
//
router.post(
  "/post/wardtype",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { ward_type_name, branch_name } = req.body;

      const admin_id = req.user.id;

      if (!ward_type_name || ward_type_name.trim() === "") {
        return res.status(400).json({ message: "Ward type name is required" });
      }

      if (!branch_name || branch_name.trim() === "") {
        return res.status(400).json({ message: " branch name is required" });
      }

      const formattedWardType = ward_type_name.trim().toUpperCase();
      const formattedBranch = branch_name.trim();

      const [existingWard] = await db.execute(
        `SELECT id
   FROM ipd_ward_type
   WHERE admin_id = ?
   AND branch_name = ?
   AND UPPER(TRIM(ward_type_name)) = ?`,
        [admin_id, formattedBranch, formattedWardType],
      );

      if (existingWard.length > 0) {
        return res.status(400).json({
          message: "Ward type already exists in this branch",
        });
      }

      const [result] = await db.execute(
        `INSERT INTO ipd_ward_type (admin_id, ward_type_name, branch_name)
   VALUES (?, ?, ?)`,
        [admin_id, formattedWardType, formattedBranch],
      );

      return res.status(201).json({
        success: true,
        message: "Ward type created successfully",
        data: {
          id: result.insertId,
          ward_type_name,
          branch_name,
        },
      });
    } catch (error) {
      console.error("CREATE WARD TYPE ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

//
// ===================== GET ALL WARD TYPES =====================
//
router.get(
  "/getall/wardtype",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const admin_id =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      let branch_name = null;

      if (req.user.role === "receptionist") {
        const [staffRows] = await db.execute(
          `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
          [req.user.id, admin_id],
        );

        if (staffRows.length === 0) {
          return res.status(404).json({ message: "Staff not found" });
        }

        branch_name = staffRows[0].branch;
      }

      let query = `
SELECT id, ward_type_name, branch_name, created_at, updated_at
  FROM ipd_ward_type
  WHERE admin_id = ?
`;

      let params = [admin_id];

      if (req.user.role === "receptionist") {
        query += ` AND branch_name = ?`;
        params.push(branch_name);
      }

      query += ` ORDER BY created_at DESC`;

      const [rows] = await db.execute(query, params);

      return res.status(200).json({
        success: true,
        count: rows.length,
        data: rows,
      });
    } catch (error) {
      console.error("GET ALL ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

//
// ===================== GET SINGLE WARD TYPE =====================
//
router.get(
  "/get/wardtype/:id",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const admin_id =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      let branch_name = null;

      if (req.user.role === "receptionist") {
        const [staffRows] = await db.execute(
          `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
          [req.user.id, admin_id],
        );

        if (staffRows.length === 0) {
          return res.status(404).json({ message: "Staff not found" });
        }

        branch_name = staffRows[0].branch;
      }

      let query = `
  SELECT id, ward_type_name, branch_name, created_at, updated_at
  FROM ipd_ward_type
  WHERE id = ? AND admin_id = ?
`;

      let params = [id, admin_id];

      if (req.user.role === "receptionist") {
        query += ` AND branch_name = ?`;
        params.push(branch_name);
      }

      const [rows] = await db.execute(query, params);

      if (rows.length === 0) {
        return res.status(404).json({ message: "Ward type not found" });
      }

      return res.status(200).json({
        success: true,
        data: rows[0],
      });
    } catch (error) {
      console.error("GET ONE ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

//
// ===================== UPDATE WARD TYPE =====================
//
router.put(
  "/update/wardtype/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const { ward_type_name, branch_name } = req.body;

      const admin_id =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      // ================= VALIDATION =================

      if (!ward_type_name || ward_type_name.trim() === "") {
        return res.status(400).json({
          message: "Ward type name is required",
        });
      }

      if (!branch_name || branch_name.trim() === "") {
        return res.status(400).json({
          message: "Branch name is required",
        });
      }

      const formattedWardType = ward_type_name.trim().toUpperCase();
      const formattedBranch = branch_name.trim();

      const [duplicate] = await db.execute(
        `SELECT id
   FROM ipd_ward_type
   WHERE admin_id = ?
   AND branch_name = ?
   AND UPPER(TRIM(ward_type_name)) = ?
   AND id != ?`,
        [admin_id, formattedBranch, formattedWardType, id],
      );

      if (duplicate.length > 0) {
        return res.status(400).json({
          message: "Ward type already exists in this branch",
        });
      }

      // ================= UPDATE =================

      const [result] = await db.execute(
        `UPDATE ipd_ward_type
   SET ward_type_name = ?,
       branch_name = ?
   WHERE id = ? AND admin_id = ?`,
        [formattedWardType, formattedBranch, id, admin_id],
      );

      // ================= CHECK =================

      if (result.affectedRows === 0) {
        return res.status(404).json({
          message: "Ward type not found",
        });
      }

      // ================= RESPONSE =================

      return res.status(200).json({
        success: true,
        message: "Ward type updated successfully",
      });
    } catch (error) {
      console.error("UPDATE ERROR:", error);

      return res.status(500).json({
        message: "Internal server error",
        error,
      });
    }
  },
);

//
// ===================== DELETE WARD TYPE =====================
//
router.delete(
  "/delete/wardtype/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const admin_id =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      const [result] = await db.execute(
        `DELETE FROM ipd_ward_type
         WHERE id = ? AND admin_id = ?`,
        [id, admin_id],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Ward type not found" });
      }

      return res.status(200).json({
        success: true,
        message: "Ward type deleted successfully",
      });
    } catch (error) {
      console.error("DELETE ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

module.exports = router;