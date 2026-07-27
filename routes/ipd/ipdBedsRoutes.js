const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");

//
// ===================== POST ALL BEDS IF ADMIN LOGIN NO NEED BRANCH  =====================
// ============== IF RECEPTIONIST LOGIN HE ONLY POST HE RESPECTIVE BRANCH BEDS ==============
//
router.post(
  "/post/bed/",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { room_id, bed_number, bed_charge, branch_name } = req.body;
      const { role, id, adminId } = req.user;

      // ✅ Standard admin_id logic (your pattern)
      const admin_id = role === "admin" ? id : adminId;

      if (!room_id) {
        return res.status(400).json({ message: "Room is required" });
      }

      if (!bed_number || bed_number.trim() === "") {
        return res.status(400).json({ message: "Bed number is required" });
      }

      // 🔥 Branch handling
      let final_branch_name;

      if (role === "admin") {
        if (!branch_name || branch_name.trim() === "") {
          return res.status(400).json({
            message: "Branch name is required for admin",
          });
        }

        const cleanBranch = branch_name.trim();

        // ✅ Check if branch exists in staff table for this admin
        const [branchCheck] = await db.execute(
          `SELECT DISTINCT branch 
     FROM staff 
     WHERE admin_id = ? AND branch = ?`,
          [admin_id, cleanBranch],
        );

        if (branchCheck.length === 0) {
          return res.status(400).json({
            message:
              "Invalid branch. This branch does not exist for this admin",
          });
        }

        final_branch_name = cleanBranch;
      } else {
        // receptionist → fetch from staff table
        const [staffRows] = await db.execute(
          `SELECT branch FROM staff WHERE id = ?`,
          [id],
        );

        if (staffRows.length === 0) {
          return res.status(400).json({ message: "Staff not found" });
        }

        final_branch_name = staffRows[0].branch;
      }
      // ✅ Validate room belongs to same admin
      // ✅ Also validate receptionist branch matches room branch

      let roomQuery = `
  SELECT id, branch_name 
  FROM ipd_rooms
  WHERE id = ? AND admin_id = ?
`;

      let roomParams = [room_id, admin_id];

      // 🔥 receptionist branch restriction
      if (role !== "admin") {
        roomQuery += ` AND LOWER(TRIM(branch_name)) = ?`;
        roomParams.push(final_branch_name.trim().toLowerCase());
      }

      const [room] = await db.execute(roomQuery, roomParams);

      if (room.length === 0) {
        return res.status(400).json({
          message: "Invalid room or room does not belong to your branch",
        });
      }

      // ✅ Check duplicate bed number for same admin

      const formattedBedNumber = bed_number.trim().toUpperCase();

      const [existingBed] = await db.execute(
        `SELECT id
   FROM ipd_beds
   WHERE room_id = ?
   AND UPPER(TRIM(bed_number)) = ?`,
        [room_id, formattedBedNumber],
      );

      if (existingBed.length > 0) {
        return res.status(400).json({
          message: "Bed number already exists for this room",
        });
      }

      // ✅ Insert
      const [result] = await db.execute(
        `INSERT INTO ipd_beds 
        (admin_id, room_id, bed_number, bed_charge, branch_name)
        VALUES (?, ?, ?, ?, ?)`,
        [
          admin_id,
          room_id,
          formattedBedNumber,
          bed_charge || 0,
          final_branch_name,
        ],
      );

      return res.status(201).json({
        success: true,
        message: "Bed created successfully",
        data: {
          id: result.insertId,
          formattedBedNumber,
          branch_name: final_branch_name,
        },
      });
    } catch (error) {
      console.error("CREATE BED ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

//
// ===================== GET ALL BEDS IF ADMIN LOGIN NO NEED BRANCH  =====================
// ============== IF RECEPTIONIST LOGIN HE ONLY GET HE RESPECTIVE BRANCH BEDS ==============
//
router.get(
  "/getall/beds/",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;

      const admin_id = role === "admin" ? req.user.id : adminId;

      let query = "";
      let params = [];

      if (role === "admin") {
        // ✅ Admin → all beds
        query = `
          SELECT b.*, r.room_number, w.ward_type_name
          FROM ipd_beds b
          LEFT JOIN ipd_rooms r ON b.room_id = r.id
          LEFT JOIN ipd_ward_type w ON r.ward_type_id = w.id
          WHERE b.admin_id = ?
          ORDER BY b.created_at DESC
        `;
        params = [admin_id];
      } else {
        // 🔥 Receptionist → only their branch
        const [staffRows] = await db.execute(
          `SELECT branch FROM staff WHERE id = ?`,
          [id],
        );

        if (staffRows.length === 0) {
          return res.status(400).json({ message: "Staff not found" });
        }

        const branch = staffRows[0].branch;

        query = `
          SELECT b.*, r.room_number, w.ward_type_name
          FROM ipd_beds b
          LEFT JOIN ipd_rooms r ON b.room_id = r.id
          LEFT JOIN ipd_ward_type w ON r.ward_type_id = w.id
          WHERE b.admin_id = ? AND b.branch_name = ?
          ORDER BY b.created_at DESC
        `;
        params = [admin_id, branch];
      }

      const [rows] = await db.execute(query, params);

      return res.status(200).json({
        success: true,
        count: rows.length,
        data: rows,
      });
    } catch (error) {
      console.error("GET BEDS ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

//
// =====================  GET SINGLE BEDS IF ADMIN LOGIN NO NEED BRANCH  =====================
// ============== IF RECEPTIONIST LOGIN HE ONLY GET HE RESPECTIVE BRANCH BEDS ================
//
router.get(
  "/get/bed/:id",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;
      const { id: bedId } = req.params;

      const admin_id = role === "admin" ? req.user.id : adminId;

      let query = "";
      let params = [];

      if (role === "admin") {
        query = `
          SELECT * FROM ipd_beds
          WHERE id = ? AND admin_id = ?
        `;
        params = [bedId, admin_id];
      } else {
        // 🔥 receptionist → restrict by branch
        const [staffRows] = await db.execute(
          `SELECT branch FROM staff WHERE id = ?`,
          [id],
        );

        if (staffRows.length === 0) {
          return res.status(400).json({ message: "Staff not found" });
        }

        const branch = staffRows[0].branch;

        query = `
          SELECT * FROM ipd_beds
          WHERE id = ? AND admin_id = ? AND branch_name = ?
        `;
        params = [bedId, admin_id, branch];
      }

      const [rows] = await db.execute(query, params);

      if (rows.length === 0) {
        return res.status(404).json({ message: "Bed not found" });
      }

      return res.status(200).json({
        success: true,
        data: rows[0],
      });
    } catch (error) {
      console.error("GET BED ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

//
// =====================  UPDATE SINGLE BEDS IF ADMIN LOGIN NO NEED BRANCH  =====================
// =============== IF RECEPTIONIST LOGIN HE ONLY UPDATE HIS RESPECTIVE BRANCH BEDS ================
//
router.put(
  "/update/bed/:id",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { id: bedId } = req.params;
      const { room_id, bed_number, bed_charge, bed_status } = req.body;
      const { role, id, adminId } = req.user;

      const admin_id = role === "admin" ? req.user.id : adminId;

      // 🔥 Get branch for receptionist
      let branchCondition = "";
      let params = [];

      if (role === "admin") {
        branchCondition = "admin_id = ?";
        params = [admin_id];
      } else {
        const [staffRows] = await db.execute(
          `SELECT branch FROM staff WHERE id = ?`,
          [id],
        );

        if (staffRows.length === 0) {
          return res.status(400).json({ message: "Staff not found" });
        }

        const branch = staffRows[0].branch;

        branchCondition = "admin_id = ? AND branch_name = ?";
        params = [admin_id, branch];
      }

      // 🔥 Check duplicate bed number (excluding current record)
      const formattedBedNumber = bed_number?.trim().toUpperCase();

      if (formattedBedNumber) {
        const [duplicate] = await db.execute(
          `SELECT id
     FROM ipd_beds
     WHERE room_id = ?
     AND UPPER(TRIM(bed_number)) = ?
     AND id != ?`,
          [room_id, formattedBedNumber, bedId],
        );

        if (duplicate.length > 0) {
          return res.status(400).json({
            message: "Bed number already exists for this room",
          });
        }
      }

      // ✅ Check if bed exists and allowed
      const [existing] = await db.execute(
        `SELECT id FROM ipd_beds 
         WHERE id = ? AND ${branchCondition}`,
        [bedId, ...params],
      );

      if (existing.length === 0) {
        return res.status(404).json({
          message: "Bed not found or access denied",
        });
      }

      // ✅ Optional: validate room
      if (room_id) {
        const [room] = await db.execute(
          `SELECT id FROM ipd_rooms WHERE id = ? AND admin_id = ?`,
          [room_id, admin_id],
        );

        if (room.length === 0) {
          return res.status(400).json({ message: "Invalid room" });
        }
      }

      // ✅ Update
      const [result] = await db.execute(
        `UPDATE ipd_beds
         SET room_id = ?, bed_number = ?, bed_charge = ?, bed_status = ?
         WHERE id = ? AND ${branchCondition}`,
        [room_id, formattedBedNumber, bed_charge, bed_status, bedId, ...params],
      );

      return res.status(200).json({
        success: true,
        message: "Bed updated successfully",
      });
    } catch (error) {
      console.error("UPDATE BED ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

//
// =====================  DELETE SINGLE BEDS IF ADMIN LOGIN NO NEED BRANCH  =====================
// =============== IF RECEPTIONIST LOGIN HE ONLY DELETE HIS RESPECTIVE BRANCH BEDS ================
//
router.delete(
  "/delete/bed/:id",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { id: bedId } = req.params;
      const { role, id, adminId } = req.user;

      const admin_id = role === "admin" ? req.user.id : adminId;

      let branchCondition = "";
      let params = [];

      if (role === "admin") {
        branchCondition = "admin_id = ?";
        params = [admin_id];
      } else {
        const [staffRows] = await db.execute(
          `SELECT branch FROM staff WHERE id = ?`,
          [id],
        );

        if (staffRows.length === 0) {
          return res.status(400).json({ message: "Staff not found" });
        }

        const branch = staffRows[0].branch;

        branchCondition = "admin_id = ? AND branch_name = ?";
        params = [admin_id, branch];
      }

      // ✅ Delete
      const [result] = await db.execute(
        `DELETE FROM ipd_beds
         WHERE id = ? AND ${branchCondition}`,
        [bedId, ...params],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          message: "Bed not found or access denied",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Bed deleted successfully",
      });
    } catch (error) {
      console.error("DELETE BED ERROR:", error);
      return res.status(500).json({ message: "Internal server error", error });
    }
  },
);

module.exports = router;