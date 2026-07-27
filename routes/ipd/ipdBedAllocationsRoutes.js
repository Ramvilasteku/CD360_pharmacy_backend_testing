const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");

//
// ============== POST ALLOCATED BED BY RECEPTIONIST ONLY, HIS RESPECTIVE BRANCH ALLOCATED BED CAN POST  =====================
//
router.post(
  "/post/allocate-bed",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      const { ipd_id, bed_id, start_time } = req.body;
      const { id } = req.user;

      // 🔥 1. Validation
      if (!ipd_id || !bed_id || !start_time) {
        return res.status(400).json({
          success: false,
          error: "VALIDATION_ERROR",
          message: "ipd_id, bed_id and start_time are required",
        });
      }

      await connection.beginTransaction();

      // 🔥 2. Get bed details
      const [bed] = await connection.query(
        "SELECT id, admin_id, bed_status, branch_name FROM ipd_beds WHERE id = ?",
        [bed_id],
      );

      if (bed.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          error: "BED_NOT_FOUND",
          message: "Bed not found",
        });
      }

      const { admin_id, bed_status, branch_name } = bed[0];

      // ❌ Prevent allocation if already occupied
      if (bed_status === "occupied") {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          error: "BED_OCCUPIED",
          message: "Bed is already occupied",
        });
      }

      // 🔥 3. Branch validation (VERY IMPORTANT)
      const [staffRows] = await connection.query(
        "SELECT branch FROM staff WHERE id = ?",
        [id],
      );

      if (staffRows.length === 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          error: "STAFF_NOT_FOUND",
          message: "Staff not found",
        });
      }

      const staffBranch = staffRows[0].branch.trim().toLowerCase();
      const bedBranch = (branch_name || "").trim().toLowerCase();

      if (staffBranch !== bedBranch) {
        await connection.rollback();
        return res.status(403).json({
          success: false,
          error: "ACCESS_DENIED",
          message: "You can only allocate beds in your branch",
        });
      }

      // 🔥 4. Validate IPD
      const [ipd] = await connection.query(
        "SELECT id FROM ipd_admissions WHERE id = ? AND admin_id = ?",
        [ipd_id, admin_id],
      );

      if (ipd.length === 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          error: "INVALID_IPD",
          message: "Invalid IPD for this admin",
        });
      }

      // 🔥 5. Check active allocation (extra safety)
      const [active] = await connection.query(
        "SELECT id FROM ipd_bed_allocations WHERE bed_id = ? AND allocation_status = 'active'",
        [bed_id],
      );

      if (active.length > 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          error: "ALREADY_ALLOCATED",
          message: "Bed already allocated",
        });
      }

      /* =====================================================
   COMPLETE OLD ACTIVE BED
===================================================== */

      const [oldAllocations] = await connection.query(
        `SELECT id, bed_id
   FROM ipd_bed_allocations
   WHERE ipd_id = ?
     AND allocation_status = 'active'`,
        [ipd_id],
      );

      for (const old of oldAllocations) {

        // complete old allocation
        await connection.query(
          `UPDATE ipd_bed_allocations
     SET
       end_time = ?,
       allocation_status = 'completed'
     WHERE id = ?`,
          [start_time, old.id],
        );

        // free old bed
        await connection.query(
          `UPDATE ipd_beds
     SET bed_status = 'available'
     WHERE id = ?`,
          [old.bed_id],
        );
      }

      /* =====================================================
         INSERT NEW ALLOCATION
      ===================================================== */

      await connection.query(
        `INSERT INTO ipd_bed_allocations
   (
     admin_id,
     ipd_id,
     bed_id,
     start_time
   )
   VALUES (?, ?, ?, ?)`,
        [
          admin_id,
          ipd_id,
          bed_id,
          start_time,
        ],
      );

      /* =====================================================
         OCCUPY NEW BED
      ===================================================== */

      await connection.query(
        `UPDATE ipd_beds
   SET bed_status = 'occupied'
   WHERE id = ?`,
        [bed_id],
      );


      await connection.commit();

      return res.status(201).json({
        success: true,
        message: "Bed allocated successfully",
      });
    } catch (error) {
      await connection.rollback();
      console.error("ALLOCATE ERROR:", error);

      return res.status(500).json({
        success: false,
        error: "SERVER_ERROR",
        message: "Failed to allocate bed",
        details: error.message,
      });
    } finally {
      connection.release();
    }
  },
);

//
// ==============  GET ALL ALLOCATED BEDS IF ADMIN LOGIN NO NEED BRANCH  =====================
// ============== IF RECEPTIONIST LOGIN HE ONLY GET HIS RESPECTIVE BRANCH ALLOCATED BEDS  =====================
//
router.get(
  "/getall/allocated-beds",
  authMiddleware,

  // ✅ Added client role
  allowRoles("admin", "receptionist", "doctor", "client"),

  async (req, res) => {
    try {

      const { role, id, adminId } = req.user;

      const admin_id = role === "admin" ? id : adminId;

      let query = `
  SELECT
    a.*,
    b.bed_number,
    b.branch_name,
    r.room_number,
    i.client_id,
    i.doctor_id,
    i.status AS ipd_status
  FROM ipd_bed_allocations a

  INNER JOIN ipd_beds b
    ON a.bed_id = b.id

  LEFT JOIN ipd_rooms r
    ON b.room_id = r.id

  LEFT JOIN ipd_admissions i
    ON a.ipd_id = i.id

  WHERE
`;

      let params = [];

      // Client is centralized (NO admin filter)
      if (role === "client") {
        query += ` i.client_id = ? `;
        params.push(id);
      } else {
        // Existing logic for admin/receptionist/doctor
        query += ` a.admin_id = ? `;
        params.push(admin_id);
      }

      /* =========================================
         RECEPTIONIST / DOCTOR BRANCH FILTER
      ========================================= */
      if (
        role === "receptionist" ||
        role === "doctor"
      ) {

        const [staffRows] = await db.execute(
          `SELECT branch
           FROM staff
           WHERE id = ?`,
          [id]
        );

        if (staffRows.length === 0) {
          return res.status(400).json({
            success: false,
            error: "STAFF_NOT_FOUND",
            message: "Staff not found",
          });
        }

        const branch =
          (staffRows[0].branch || "")
            .trim()
            .toLowerCase();

        query += `
          AND LOWER(TRIM(b.branch_name)) = ?
        `;

        params.push(branch);

        /* =========================================
           DOCTOR FILTER
        ========================================= */
        if (role === "doctor") {

          query += `
            AND i.doctor_id = ?
          `;

          params.push(id);
        }
      }


      query += `
        ORDER BY a.created_at DESC
      `;

      const [rows] = await db.execute(
        query,
        params
      );

      return res.json({
        success: true,
        count: rows.length,
        data: rows,
      });

    } catch (error) {

      console.error(
        "GET ALL ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "SERVER_ERROR",
        message: "Failed to fetch allocations",
      });
    }
  }
);

//
// ==============  GET SINGLE ALLOCATED BED IF ADMIN LOGIN NO NEED BRANCH  =====================
// ============== IF RECEPTIONIST LOGIN HE ONLY GET HIS RESPECTIVE BRANCH ALLOCATED BED  =====================
//
router.get(
  "/get/allocated-bed/:id",
  authMiddleware,
  // ✅ Added client role
  allowRoles("admin", "receptionist", "doctor", "client"),

  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;
      const { id: allocationId } = req.params;

      if (!allocationId) {
        return res.status(400).json({
          success: false,
          error: "INVALID_ID",
          message: "Allocation ID is required",
        });
      }

      // ✅ Admin uses own ID
      // ✅ Others use adminId
      const admin_id =
        role === "admin" ? id : adminId;

      let query = `
        SELECT 
          a.*,
          b.bed_number,
          b.branch_name,
          r.room_number,
          i.client_id,
          i.doctor_id,
          i.status AS ipd_status
        FROM ipd_bed_allocations a
        INNER JOIN ipd_beds b ON a.bed_id = b.id
        LEFT JOIN ipd_rooms r ON b.room_id = r.id
        LEFT JOIN ipd_admissions i ON a.ipd_id = i.id
        WHERE a.id = ? 
        AND a.admin_id = ?
      `;

      let params = [allocationId, admin_id];

      /* =========================================
         RECEPTIONIST + DOCTOR FILTER
      ========================================= */
      if (
        role === "receptionist" ||
        role === "doctor"
      ) {
        const [staffRows] = await db.execute(
          "SELECT branch FROM staff WHERE id = ?",
          [id]
        );

        if (staffRows.length === 0) {
          return res.status(400).json({
            success: false,
            error: "STAFF_NOT_FOUND",
            message: "Staff not found",
          });
        }

        const branch =
          staffRows[0].branch
            .trim()
            .toLowerCase();

        query += `
          AND LOWER(TRIM(b.branch_name)) = ?
        `;

        params.push(branch);

        // ✅ Doctor sees only own patients
        if (role === "doctor") {
          query += ` AND i.doctor_id = ?`;
          params.push(id);
        }
      }

      /* =========================================
         CLIENT FILTER
         Client can see ONLY own allocation
      ========================================= */
      if (role === "client") {
        query += ` AND i.client_id = ?`;
        params.push(id);
      }

      const [rows] = await db.execute(
        query,
        params
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "NOT_FOUND",
          message:
            "Allocation not found or access denied",
        });
      }

      return res.json({
        success: true,
        data: rows[0],
      });

    } catch (error) {
      console.error("GET ONE ERROR:", error);

      return res.status(500).json({
        success: false,
        error: "SERVER_ERROR",
        message: "Failed to fetch allocation",
      });
    }
  }
);

// ======================================================== 
// UPDATE ALLOCATED BED IF ADMIN LOGIN NO NEED BRANCH 
// IF RECEPTIONIST LOGIN HE ONLY UPDATE HIS RESPECTIVE BRANCH ALLOCATED BED 
// IF UPDATE STATUS IS COMPLETED IN ALLOCATION BEDS TABLE
// THEN IN BEDS TABEL STATUSE BECOME OCCOUIER TO ACTIVE
// ======================================================== 


router.put(
  "/update/allocated-bed/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      const { id: allocationId } = req.params;
      const { bed_id, start_time, end_time, allocation_status } = req.body;
      const { role, id, adminId } = req.user;

      const admin_id = role === "admin" ? id : adminId;

      // 🔥 1. Validate input
      if (!bed_id || !start_time) {
        return res.status(400).json({
          success: false,
          error: "VALIDATION_ERROR",
          message: "bed_id and start_time are required",
        });
      }

      if (
        allocation_status &&
        !["active", "completed"].includes(allocation_status)
      ) {
        return res.status(400).json({
          success: false,
          error: "INVALID_STATUS",
          message: "allocation_status must be 'active' or 'completed'",
        });
      }

      if (end_time && new Date(start_time) >= new Date(end_time)) {
        return res.status(400).json({
          success: false,
          error: "INVALID_TIME",
          message: "start_time must be less than end_time",
        });
      }

      // 🔥 2. Get allocation
      const [existing] = await connection.query(
        `SELECT a.*, b.id AS old_bed_id, b.branch_name
         FROM ipd_bed_allocations a
         INNER JOIN ipd_beds b ON a.bed_id = b.id
         WHERE a.id = ? AND a.admin_id = ?`,
        [allocationId, admin_id],
      );

      if (existing.length === 0) {
        return res.status(404).json({
          success: false,
          error: "NOT_FOUND",
          message: "Allocation not found",
        });
      }

      // ❌ Prevent update if already completed
      if (existing[0].allocation_status === "completed") {
        return res.status(400).json({
          success: false,
          error: "ALREADY_COMPLETED",
          message: "This allocation is already completed",
        });
      }

      const old_bed_id = existing[0].old_bed_id;

      // 🔥 3. Branch validation
      if (role !== "admin") {
        const [staffRows] = await connection.query(
          `SELECT branch FROM staff WHERE id = ?`,
          [id],
        );

        if (staffRows.length === 0) {
          return res.status(400).json({
            success: false,
            error: "STAFF_NOT_FOUND",
            message: "Staff not found",
          });
        }

        const staffBranch = staffRows[0].branch.trim().toLowerCase();
        const bedBranch = (existing[0].branch_name || "").trim().toLowerCase();

        if (staffBranch !== bedBranch) {
          return res.status(403).json({
            success: false,
            error: "ACCESS_DENIED",
            message: "You can only update allocations in your branch",
          });
        }
      }

      // 🔥 4. Start transaction
      await connection.beginTransaction();

      // 🔥 5. Bed transfer
      if (bed_id !== old_bed_id) {
        const [bed] = await connection.query(
          `SELECT id, admin_id FROM ipd_beds WHERE id = ?`,
          [bed_id],
        );

        if (bed.length === 0) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            error: "BED_NOT_FOUND",
            message: "New bed not found",
          });
        }

        if (bed[0].admin_id !== admin_id) {
          await connection.rollback();
          return res.status(403).json({
            success: false,
            error: "INVALID_BED",
            message: "Bed does not belong to your admin",
          });
        }

        const [active] = await connection.query(
          `SELECT id FROM ipd_bed_allocations
           WHERE bed_id = ? AND allocation_status = 'active'`,
          [bed_id],
        );

        if (active.length > 0) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            error: "BED_OCCUPIED",
            message: "Selected bed is already occupied",
          });
        }

        // free old bed
        await connection.query(
          `UPDATE ipd_beds SET bed_status = 'available' WHERE id = ?`,
          [old_bed_id],
        );

        // occupy new bed
        await connection.query(
          `UPDATE ipd_beds SET bed_status = 'occupied' WHERE id = ?`,
          [bed_id],
        );
      }

      // 🔥 6. Handle status
      let final_status = allocation_status || existing[0].allocation_status;
      let final_end_time = end_time || existing[0].end_time;

      if (final_status === "completed") {
        if (!final_end_time) {
          final_end_time = new Date();
        }

        await connection.query(
          `UPDATE ipd_beds SET bed_status = 'available' WHERE id = ?`,
          [bed_id],
        );
      }

      // 🔥 7. Update
      await connection.query(
        `UPDATE ipd_bed_allocations
         SET bed_id = ?, start_time = ?, end_time = ?, allocation_status = ?
         WHERE id = ?`,
        [bed_id, start_time, final_end_time, final_status, allocationId],
      );

      /* =====================================================
        UPDATE BED ID IN BED CHARGES
      ===================================================== */

      await connection.query(
        `UPDATE ipd_bed_charges
        SET bed_id = ?
        WHERE bed_allocation_id = ?`,
        [bed_id, allocationId],
      )
      await connection.commit();

      return res.status(200).json({
        success: true,
        message: "Bed allocation updated successfully",
      });
    } catch (error) {
      await connection.rollback();

      console.error("UPDATE ERROR:", error);

      return res.status(500).json({
        success: false,
        error: "SERVER_ERROR",
        message: "Something went wrong while updating allocation",
        details: error.message,
      });
    } finally {
      connection.release();
    }
  },
);

//
// ==============  DELETE ALLOCATED BED IF ADMIN LOGIN NO NEED BRANCH IF RECEPTIONIST LOGIN =====================
// ==============  HE ONLY DELETE HIS RESPECTIVE BRANCH ALLOCATED BED IF STATUS IS COMPLTED =====================
//
router.delete(
  "/delete/allocated-bed/:id",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    const connection = await db.getConnection();

    try {
      const { id: allocationId } = req.params;
      const { role, id, adminId } = req.user;

      const admin_id = role === "admin" ? id : adminId;

      // 🔥 1. Get allocation + bed + status
      const [existing] = await connection.query(
        `SELECT a.id, a.bed_id, a.allocation_status, b.branch_name
         FROM ipd_bed_allocations a
         INNER JOIN ipd_beds b ON a.bed_id = b.id
         WHERE a.id = ? AND a.admin_id = ?`,
        [allocationId, admin_id],
      );

      if (existing.length === 0) {
        return res.status(404).json({
          success: false,
          error: "NOT_FOUND",
          message: "Allocation not found",
        });
      }

      const { bed_id, allocation_status } = existing[0];
      const bedBranch = (existing[0].branch_name || "").trim().toLowerCase();

      // 🔥 2. ONLY allow delete if completed
      if (allocation_status !== "completed") {
        return res.status(400).json({
          success: false,
          error: "INVALID_STATUS",
          message: "Only completed allocations can be deleted",
        });
      }

      // 🔥 3. Branch validation (receptionist only)
      if (role !== "admin") {
        const [staffRows] = await connection.query(
          `SELECT branch FROM staff WHERE id = ?`,
          [id],
        );

        if (staffRows.length === 0) {
          return res.status(400).json({
            success: false,
            error: "STAFF_NOT_FOUND",
            message: "Staff not found",
          });
        }

        const staffBranch = staffRows[0].branch.trim().toLowerCase();

        if (staffBranch !== bedBranch) {
          return res.status(403).json({
            success: false,
            error: "ACCESS_DENIED",
            message: "You can only delete allocations in your branch",
          });
        }
      }

      // 🔥 4. START TRANSACTION
      await connection.beginTransaction();

      // 🔥 5. Free bed (optional safety — already should be free)
      await connection.query(
        `UPDATE ipd_beds SET bed_status = 'available' WHERE id = ?`,
        [bed_id],
      );

      // 🔥 6. Delete
      const [result] = await connection.query(
        `DELETE FROM ipd_bed_allocations 
         WHERE id = ? AND admin_id = ?`,
        [allocationId, admin_id],
      );

      if (result.affectedRows === 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          error: "DELETE_FAILED",
          message: "Delete failed",
        });
      }

      await connection.commit();

      return res.status(200).json({
        success: true,
        message: "Bed allocation deleted successfully",
      });
    } catch (error) {
      await connection.rollback();
      console.error("DELETE ERROR:", error);

      return res.status(500).json({
        success: false,
        error: "SERVER_ERROR",
        message: "Something went wrong",
        details: error.message,
      });
    } finally {
      connection.release();
    }
  },
);

module.exports = router;
