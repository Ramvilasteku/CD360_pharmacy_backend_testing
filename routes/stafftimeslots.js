const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

// 1.CREATE STAFF TIME SLOT  (Allowed: admin, staff)
// STAFF: Create own time-slot checked adminid of client
router.post(
  "/staff/time-slots",
  authMiddleware,
  allowRoles("receptionist", "doctor"),
  async (req, res) => {
    let { doctorName, slot_date, slot_time_from, slot_time_to } = req.body;

    // 🔹 Trim values
    doctorName = doctorName?.trim();
    slot_date = slot_date?.trim();
    slot_time_from = slot_time_from?.trim();
    slot_time_to = slot_time_to?.trim();

    if (!slot_date || !slot_time_from || !slot_time_to) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    try {
      const loggedInStaffId = req.user.id;
      const adminId = req.user.adminId;
      const role = req.user.role;

      // 🔒 BLOCK doctorName when doctor is logged in
      if (role === "doctor" && doctorName) {
        return res.status(400).json({
          message: "Doctors cannot create slots for other doctors"
        });
      }

      let doctorId;

      // 🔹 Doctor logged in → use own ID
      if (role === "doctor") {
        doctorId = loggedInStaffId;
      }

      // 🔹 Receptionist → find doctor by name
      if (role === "receptionist") {
        if (!doctorName) {
          return res.status(400).json({ message: "Doctor name is required" });
        }

        const [doctorRows] = await db.query(
          `SELECT id 
           FROM staff 
           WHERE name = ? 
             AND role = 'doctor'
             AND admin_id = ?`,
          [doctorName, adminId]
        );

        if (doctorRows.length === 0) {
          return res.status(404).json({ message: "Doctor not found" });
        }

        doctorId = doctorRows[0].id;
      }

      // 🔹 Insert time slot
      const [result] = await db.query(
        `INSERT INTO staff_time_slots
          (admin_id, staff_id, slot_date, slot_time_from, slot_time_to, is_booked)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [adminId, doctorId, slot_date, slot_time_from, slot_time_to]
      );

      return res.status(201).json({
        message: "Time slot created successfully",
        slotId: result.insertId
      });

    } catch (error) {
      console.error("Staff slot creation error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);


//2. create bulk time slots for staff
router.post(
  "/staff/time-slots/bulk",
  authMiddleware,
  allowRoles("receptionist", "doctor"),
  async (req, res) => {
    try {
      let { doctorName, slots } = req.body;

      if (!Array.isArray(slots) || slots.length === 0) {
        return res.status(400).json({ message: "Slots array is required" });
      }

      const loggedInStaffId = req.user.id;
      const adminId = req.user.adminId;
      const role = req.user.role;

      // 🔒 Doctors cannot create slots for others
      if (role === "doctor" && doctorName) {
        return res.status(400).json({
          message: "Doctors cannot create slots for other doctors"
        });
      }

      let doctorId;

      // 🔹 Doctor logged in → own ID
      if (role === "doctor") {
        doctorId = loggedInStaffId;
      }

      // 🔹 Receptionist → flexible doctor match
      if (role === "receptionist") {
        doctorName = doctorName?.trim();

        if (!doctorName) {
          return res.status(400).json({ message: "Doctor name is required" });
        }

        // 🔹 Normalize input
       const searchText = doctorName
  .toLowerCase()
  .replace(/\s+/g, "")
  .replace(/\./g, "")
  .replace(/,/g, "")
  .replace("dr", "dr");

const [doctorRows] = await db.query(
  `
  SELECT id, name
  FROM staff
  WHERE role = 'doctor'
    AND admin_id = ?
    AND status = 1
    AND (
      LOWER(
        REPLACE(REPLACE(REPLACE(name, ' ', ''), '.', ''), ',', '')
      ) LIKE ?
      OR LOWER(
        REPLACE(REPLACE(REPLACE(SUBSTRING_INDEX(name, ',', 1), ' ', ''), '.', ''), ',', '')
      ) LIKE ?
      OR LOWER(
        REPLACE(REPLACE(REPLACE(branch, ' ', ''), '.', ''), ',', '')
      ) LIKE ?
    )
  LIMIT 1
  `,
  [
    adminId,
    `%${searchText}%`,
    `%${searchText}%`,
    `%${searchText}%`
  ]
);


        if (!doctorRows.length) {
          return res.status(404).json({ message: "Doctor not found" });
        }

        doctorId = doctorRows[0].id;
      }

      // 🔹 Prepare bulk insert
      const values = slots.map((slot, index) => {
        const slot_date = slot.slot_date?.trim();
        const slot_time_from = slot.slot_time_from?.trim();
        const slot_time_to = slot.slot_time_to?.trim();

        if (!slot_date || !slot_time_from || !slot_time_to) {
          throw new Error(`Invalid slot data at index ${index}`);
        }

        return [
          adminId,
          doctorId,
          slot_date,
          slot_time_from,
          slot_time_to,
          0 // is_booked
        ];
      });

      // 🔹 Bulk insert
      await db.query(
        `
        INSERT INTO staff_time_slots
          (admin_id, staff_id, slot_date, slot_time_from, slot_time_to, is_booked)
        VALUES ?
        `,
        [values]
      );

      return res.status(201).json({
        success: true,
        message: "Bulk time slots created successfully",
        totalSlots: values.length
      });

    } catch (error) {
      console.error("Bulk slot creation error:", error);
      return res.status(500).json({
        message: error.message || "Internal server error"
      });
    }
  }
);



//3. get to timeslots of all doctor when receptionist login or sigle doctor  when doctor login
router.get(
  "/staff/time-slots/today",
  authMiddleware,
  allowRoles("receptionist", "doctor"),
  async (req, res) => {
    try {
      const staffId = req.user.id;
      const adminId = req.user.adminId;
      const role = req.user.role;

      // 🔹 Get today's date (YYYY-MM-DD)
      const today = new Date().toISOString().split("T")[0];

      let query = "";
      let params = [];

      // 🔹 Doctor → only own slots
      if (role === "doctor") {
        query = `
          SELECT 
            sts.id,
            sts.slot_date,
            sts.slot_time_from,
            sts.slot_time_to,
            sts.is_booked,
            s.name AS doctor_name,
            s.branch
          FROM staff_time_slots sts
          JOIN staff s ON s.id = sts.staff_id
          WHERE sts.staff_id = ?
            AND sts.admin_id = ?
            AND sts.slot_date = ?
          ORDER BY sts.slot_time_from
        `;
        params = [staffId, adminId, today];
      }

      // 🔹 Receptionist → all doctors under admin
      if (role === "receptionist") {
        query = `
          SELECT 
            sts.id,
            sts.slot_date,
            sts.slot_time_from,
            sts.slot_time_to,
            sts.is_booked,
            s.id AS doctor_id,
            s.name AS doctor_name,
            s.branch
          FROM staff_time_slots sts
          JOIN staff s ON s.id = sts.staff_id
          WHERE sts.admin_id = ?
            AND s.role = 'doctor'
            AND sts.slot_date = ?
          ORDER BY s.name, sts.slot_time_from
        `;
        params = [adminId, today];
      }

      const [slots] = await db.query(query, params);

      return res.json({
        date: today,
        totalSlots: slots.length,
        slots
      });

    } catch (error) {
      console.error("Get today's slots error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);



// 4. doctor or receptionist update timeslots
router.put(
  "/staff/time-slots/update",
  authMiddleware,
  allowRoles("receptionist", "doctor"),
  async (req, res) => {
    try {
      let {
        doctorName,
        slot_date,
        old_from,
        old_to,
        new_from,
        new_to
      } = req.body;

      // 🔹 Trim inputs
      doctorName = doctorName?.trim();
      slot_date = slot_date?.trim();
      old_from = old_from?.trim();
      old_to = old_to?.trim();
      new_from = new_from?.trim();
      new_to = new_to?.trim();

      if (!slot_date || !old_from || !old_to || !new_from || !new_to) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const loggedInStaffId = req.user.id;
      const adminId = req.user.adminId;
      const role = req.user.role;

      let doctorId;

      // 👨‍⚕️ Doctor → update own slots only
      if (role === "doctor") {
        if (doctorName) {
          return res.status(400).json({
            message: "Doctors cannot update slots for other doctors"
          });
        }
        doctorId = loggedInStaffId;
      }

      // 🧑‍💼 Receptionist → doctor under SAME admin
      if (role === "receptionist") {
        if (!doctorName) {
          return res.status(400).json({ message: "Doctor name is required" });
        }

        const [doctorRows] = await db.query(
          `SELECT id 
           FROM staff 
           WHERE name = ?
             AND role = 'doctor'
             AND admin_id = ?`,
          [doctorName, adminId]
        );

        if (doctorRows.length === 0) {
          return res.status(404).json({ message: "Doctor not found" });
        }

        doctorId = doctorRows[0].id;
      }

      // 🔒 Conflict check (same admin + same doctor)
      const [conflicts] = await db.query(
        `SELECT id FROM staff_time_slots
         WHERE admin_id = ?
           AND staff_id = ?
           AND slot_date = ?
           AND is_booked = 0
           AND (
             (slot_time_from < ? AND slot_time_to > ?) OR
             (slot_time_from < ? AND slot_time_to > ?) OR
             (slot_time_from >= ? AND slot_time_to <= ?)
           )
           AND NOT (slot_time_from = ? AND slot_time_to = ?)`,
        [
          adminId,
          doctorId,
          slot_date,
          new_to, new_to,
          new_from, new_from,
          new_from, new_to,
          old_from, old_to
        ]
      );

      if (conflicts.length > 0) {
        return res.status(400).json({
          message: "New time slot conflicts with existing slot"
        });
      }

      // 🔁 Update slot
      const [result] = await db.query(
        `UPDATE staff_time_slots
         SET slot_time_from = ?, slot_time_to = ?
         WHERE admin_id = ?
           AND staff_id = ?
           AND slot_date = ?
           AND slot_time_from = ?
           AND slot_time_to = ?
           AND is_booked = 0`,
        [
          new_from,
          new_to,
          adminId,
          doctorId,
          slot_date,
          old_from,
          old_to
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          message: "Slot not found or already booked"
        });
      }

      return res.json({
        message: "Time slot updated successfully"
      });

    } catch (error) {
      console.error("Staff slot update error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);



// 5. DELETE time slot (doctor or receptionist
router.delete(
  "/staff/time-slots/delete",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    try {
      let { doctorName, slot_date, slot_time_from, slot_time_to } = req.body;

      // 🔹 Trim inputs
      doctorName = doctorName?.trim();
      slot_date = slot_date?.trim();
      slot_time_from = slot_time_from?.trim();
      slot_time_to = slot_time_to?.trim();

      if (!slot_date || !slot_time_from || !slot_time_to) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const loggedInStaffId = req.user.id;
      const adminId = req.user.adminId;
      const role = req.user.role;

      let doctorId;

      // 👨‍⚕️ Doctor → delete own slots only
      if (role === "doctor") {
        if (doctorName) {
          return res.status(400).json({
            message: "Doctors cannot delete slots for other doctors"
          });
        }
        doctorId = loggedInStaffId;
      }

      // 🧑‍💼 Receptionist → doctor under SAME admin
      if (role === "receptionist") {
        if (!doctorName) {
          return res.status(400).json({
            message: "Doctor name is required"
          });
        }

        const [doctorRows] = await db.query(
          `SELECT id 
           FROM staff 
           WHERE name = ?
             AND role = 'doctor'
             AND admin_id = ?`,
          [doctorName, adminId]
        );

        if (doctorRows.length === 0) {
          return res.status(404).json({ message: "Doctor not found" });
        }

        doctorId = doctorRows[0].id;
      }

      // 🗑 Delete only unbooked slot
      const [result] = await db.query(
        `DELETE FROM staff_time_slots
         WHERE admin_id = ?
           AND staff_id = ?
           AND slot_date = ?
           AND slot_time_from = ?
           AND slot_time_to = ?
           AND is_booked = 0`,
        [
          adminId,
          doctorId,
          slot_date,
          slot_time_from,
          slot_time_to
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          message: "Slot not found or already booked"
        });
      }

      return res.json({
        message: "Time slot deleted successfully"
      });

    } catch (error) {
      console.error("Staff slot delete error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

//Unbooked Slots by Date (Doctor / Receptionist / Client)
router.get(
  "/staff/time-slots/unbooked/filter",
  authMiddleware,
  allowRoles("doctor", "receptionist", "client"),
  async (req, res) => {
    try {
      let { date, doctorId, branch } = req.query;
      const role = req.user.role;
      const adminId = req.user.adminId;
      const staffId = req.user.id;

      // 🔹 Normalize branch from query
      branch = branch ? branch.trim().toLowerCase() : null;

      let enforcedBranch = null;

      /* ===============================
         👨‍⚕️ DOCTOR VALIDATION
      =============================== */
      if (role === "doctor") {
        if (doctorId && Number(doctorId) !== staffId) {
          return res.status(403).json({
            message: "You are not allowed to view other doctors' slots",
          });
        }

        if (branch) {
          return res.status(403).json({
            message: "Doctors cannot filter by branch",
          });
        }
      }

      /* ===============================
         🧑‍💼 RECEPTIONIST VALIDATION
      =============================== */
      if (role === "receptionist") {
        const [[receptionist]] = await db.query(
          `
          SELECT TRIM(LOWER(branch)) AS branch
          FROM staff
          WHERE id = ?
            AND admin_id = ?
            AND role = 'receptionist'
            AND status = 1
          `,
          [staffId, adminId]
        );

        if (!receptionist) {
          return res.status(403).json({ message: "Invalid receptionist" });
        }

        enforcedBranch = receptionist.branch;

        // ❌ Block other branch
        if (branch && branch !== enforcedBranch) {
          return res.status(403).json({
            message: "You are not allowed to view other branch doctors",
          });
        }

        // ❌ Block other-branch doctorId
        if (doctorId) {
          const [[doctor]] = await db.query(
            `
            SELECT id
            FROM staff
            WHERE id = ?
              AND role = 'doctor'
              AND TRIM(LOWER(branch)) = ?
            `,
            [doctorId, enforcedBranch]
          );

          if (!doctor) {
            return res.status(403).json({
              message: "Other branch doctor slots are not visible for receptionist",
            });
          }
        }
      }

      /* ===============================
         👤 CLIENT VALIDATION
      =============================== */
      if (role === "client" && !branch) {
        return res.status(400).json({
          message: "branch is required for client",
        });
      }

      /* ===============================
         MAIN QUERY
      =============================== */
      let query = `
        SELECT
          sts.id,
          DATE_FORMAT(sts.slot_date, '%Y-%m-%d') AS slot_date,
          sts.slot_time_from,
          sts.slot_time_to,
          sts.is_booked,
          s.id AS doctor_id,
          s.name AS doctor_name,
          s.branch
        FROM staff_time_slots sts
        JOIN staff s ON s.id = sts.staff_id
        WHERE sts.admin_id = ?
          AND sts.is_booked = 0
          AND s.role = 'doctor'
      `;

      const params = [adminId];

      if (role === "doctor") {
        query += ` AND s.id = ? `;
        params.push(staffId);
      }

      if (role === "receptionist") {
        query += ` AND TRIM(LOWER(s.branch)) = ? `;
        params.push(enforcedBranch);

        if (doctorId) {
          query += ` AND s.id = ? `;
          params.push(Number(doctorId));
        }
      }

      if (role === "client") {
        query += ` AND TRIM(LOWER(s.branch)) = ? `;
        params.push(branch);

        if (doctorId) {
          query += ` AND s.id = ? `;
          params.push(Number(doctorId));
        }
      }

      if (date) {
        query += ` AND sts.slot_date = ? `;
        params.push(date);
      }

      query += ` ORDER BY s.name, sts.slot_time_from `;

      const [slots] = await db.query(query, params);

      return res.status(200).json({
        date: date || null,
        branch:
          role === "receptionist"
            ? enforcedBranch
            : role === "client"
            ? branch
            : null,
        doctorId: doctorId ? Number(doctorId) : null,
        totalUnbookedSlots: slots.length,
        slots,
      });
    } catch (error) {
      console.error("Filtered unbooked slots error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);













module.exports = router;
