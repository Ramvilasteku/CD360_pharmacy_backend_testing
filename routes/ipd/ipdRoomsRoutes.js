const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");

//
// =====================  CREATE ROOM =====================
//
router.post(
  "/post/room",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { ward_type_id, room_number, branch_name } = req.body;
      const admin_id =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      if (!room_number || room_number.trim() === "") {
        return res.status(400).json({ message: "Room number is required" });
      }

      if (!branch_name || branch_name.trim() === "") {
        return res.status(400).json({ message: "Branch number is required" });
      }

      if (!ward_type_id) {
        return res.status(400).json({ message: "Ward type is required" });
      }

      // ✅ Check ward type exists
      const [ward] = await db.execute(
        `SELECT id FROM ipd_ward_type
         WHERE id = ? AND admin_id = ?`,
        [ward_type_id, admin_id],
      );

      if (ward.length === 0) {
        return res.status(400).json({ message: "Invalid ward type" });
      }

      const formattedRoomNumber = room_number.trim().toUpperCase();
      const formattedBranch = branch_name.trim();

      const [existingRoom] = await db.execute(
        `SELECT id
   FROM ipd_rooms
   WHERE admin_id = ?
   AND branch_name = ?
   AND UPPER(TRIM(room_number)) = ?`,
        [admin_id, formattedBranch, formattedRoomNumber],
      );

      if (existingRoom.length > 0) {
        return res.status(400).json({
          message: "Room number already exists in this branch",
        });
      }

      // ✅ Insert room
      const [result] = await db.execute(
        `INSERT INTO ipd_rooms
   (admin_id, ward_type_id, room_number, branch_name)
   VALUES (?, ?, ?, ?)`,
        [admin_id, ward_type_id, formattedRoomNumber, formattedBranch],
      );

      return res.status(201).json({
        success: true,
        message: "Room created successfully",
        data: {
          id: result.insertId,
          room_number,
          ward_type_id,
        },
      });
    } catch (error) {
      console.error("CREATE ROOM ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

//
//  ===================== GET ALL ROOMS (WITH WARD TYPE NAME) =====================
//
router.get(
  "/getall/rooms",
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

        branch_name = staffRows[0].branch;
      }

      let query = `
  SELECT r.id,
       r.room_number,
       r.created_at,
       r.ward_type_id,
       w.ward_type_name,
       r.branch_name
  FROM ipd_rooms r
  LEFT JOIN ipd_ward_type w
  ON r.ward_type_id = w.id
  WHERE r.admin_id = ?
`;

      let params = [admin_id];

      if (req.user.role === "receptionist") {
        query += ` AND r.branch_name = ?`;
        params.push(branch_name);
      }

      query += ` ORDER BY r.created_at DESC`;

      const [rows] = await db.execute(query, params);
      return res.status(200).json({
        success: true,
        count: rows.length,
        data: rows,
      });
    } catch (error) {
      console.error("GET ROOMS ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

//
//  ===================== GET SINGLE ROOM =====================
//
router.get(
  "/get/room/:id",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const admin_id =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      // 🔹 1. Get branch if receptionist
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

      // 🔹 2. Build query
      let query = `
        SELECT r.id, r.room_number, r.created_at,
               w.ward_type_name, r.branch_name
        FROM ipd_rooms r
        LEFT JOIN ipd_ward_type w
        ON r.ward_type_id = w.id
        WHERE r.id = ? AND r.admin_id = ?
      `;

      let params = [id, admin_id];

      // 🔹 3. Apply branch filter
      if (req.user.role === "receptionist") {
        query += ` AND r.branch_name = ?`;
        params.push(branch_name);
      }

      // 🔹 4. Execute query (YOU MISSED THIS)
      const [rows] = await db.execute(query, params);

      // 🔹 5. Check result
      if (rows.length === 0) {
        return res.status(404).json({ message: "Room not found" });
      }

      return res.status(200).json({
        success: true,
        data: rows[0],
      });
    } catch (error) {
      console.error("GET ROOM ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);
//
// =====================  UPDATE ROOM =====================
//
router.put(
  "/update/room/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { ward_type_id, room_number } = req.body;

      const admin_id =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      if (!room_number || room_number.trim() === "") {
        return res.status(400).json({ message: "Room number is required" });
      }

      if (!ward_type_id) {
        return res.status(400).json({ message: "Ward type is required" });
      }

      // 🔹 Get ward + branch
      const [ward] = await db.execute(
        `SELECT id, branch_name FROM ipd_ward_type
         WHERE id = ? AND admin_id = ?`,
        [ward_type_id, admin_id],
      );

      if (ward.length === 0) {
        return res.status(400).json({ message: "Invalid ward type" });
      }

      const branch_name = ward[0].branch_name;

      const formattedRoomNumber = room_number.trim().toUpperCase();

      const [duplicate] = await db.execute(
        `SELECT id
   FROM ipd_rooms
   WHERE admin_id = ?
   AND branch_name = ?
   AND UPPER(TRIM(room_number)) = ?
   AND id != ?`,
        [admin_id, branch_name, formattedRoomNumber, id],
      );

      if (duplicate.length > 0) {
        return res.status(400).json({
          message: "Room number already exists in this branch",
        });
      }

      // 🔹 Update with branch sync
      const [result] = await db.execute(
        `UPDATE ipd_rooms
   SET ward_type_id = ?,
       room_number = ?,
       branch_name = ?
   WHERE id = ? AND admin_id = ?`,
        [ward_type_id, formattedRoomNumber, branch_name, id, admin_id],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Room not found" });
      }

      return res.status(200).json({
        success: true,
        message: "Room updated successfully",
      });
    } catch (error) {
      console.error("UPDATE ROOM ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

//
//  ===================== DELETE ROOM =====================
//

router.delete(
  "/delete/room/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const admin_id =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      const [result] = await db.execute(
        `DELETE FROM ipd_rooms
         WHERE id = ? AND admin_id = ?`,
        [id, admin_id],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: "Room not found" });
      }

      return res.status(200).json({
        success: true,
        message: "Room deleted successfully",
      });
    } catch (error) {
      console.error("DELETE ROOM ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

module.exports = router;

module.exports = router;