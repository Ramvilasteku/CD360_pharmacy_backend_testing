const express = require("express");
const router = express.Router();
const db = require("../db.js");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* ============================================================================
   Helper: Get Admin ID Based On Logged User
============================================================================ */
function getAdminIdFromUser(user) {
  // If logged user is ADMIN
  if (user.role === "admin") {
    return user.id; // 🔥 admin id stored in user.id
  }

  // If doctor / receptionist / staff
  return user.adminId; // 🔥 linked admin id
}

/* ============================================================================
   1️⃣ ADD MEDICINE
============================================================================ */
/* ================= ADD MEDICINE ================= */
router.post(
  "/",
  authMiddleware,
  allowRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const {
        medicine_name,
        type,
        strength,
        unit,
        quantity,
        amount,
        when_to_take,
        duration,
        description,
      } = req.body;

      if (!medicine_name || !medicine_name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Medicine name is required",
        });
      }

      // Check for duplicate medicine name
      const [existing] = await db.execute(
        `
        SELECT id
        FROM medicines
        WHERE LOWER(TRIM(medicine_name)) = LOWER(TRIM(?))
        LIMIT 1
        `,
        [medicine_name]
      );

      if (existing.length > 0) {
        return res.status(409).json({
          success: false,
          message: "Medicine already exists",
        });
      }

      const [result] = await db.execute(
        `
        INSERT INTO medicines
        (
          medicine_name,
          type,
          strength,
          unit,
          quantity,
          amount,
          when_to_take,
          duration,
          description,
          admin_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          medicine_name.trim(),
          type || null,
          strength || null,
          unit || null,
          quantity || 1,
          amount || 0,
          when_to_take ? JSON.stringify(when_to_take) : null,
          duration || null,
          description || null,
          null,
        ]
      );

      res.status(201).json({
        success: true,
        message: "Medicine added successfully",
        data: {
          id: result.insertId,
        },
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);


/* ============================================================================
   2️⃣ GET ALL MEDICINES
============================================================================ */
router.get(
  "/search-all",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const search = req.query.search || "";

      const [rows] = await db.execute(
        `
        SELECT *
        FROM medicines
        WHERE medicine_name LIKE ?
        ORDER BY medicine_name ASC
        `,
        [`%${search}%`]
      );

      res.json({
        success: true,
        data: rows,
      });

    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

router.get(
  "/search",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {

      const search = req.query.search || "";
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const page = Number(req.query.page) || 1;

      const offset = (page - 1) * limit;


      const [rows] = await db.execute(`
        SELECT *
        FROM medicines
        WHERE medicine_name LIKE ?
        ORDER BY medicine_name ASC
        LIMIT ${limit} OFFSET ${offset}
      `, [
        `%${search}%`
      ]);


      res.json({
        success: true,
        data: rows
      });


    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false
      });
    }
  }
);

router.get(
  "/options",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const [rows] = await db.execute(`
        SELECT
          type,
          strength,
          unit,
          duration,
          when_to_take
        FROM medicines
      `);

      const parsed = rows.map((row) => ({
        ...row,
        when_to_take:
          typeof row.when_to_take === "string"
            ? JSON.parse(row.when_to_take)
            : row.when_to_take || [],
      }));

      const unique = (key) => [
        ...new Set(parsed.map((m) => m[key]).filter(Boolean)),
      ];

      const whenOptions = [
        ...new Set(parsed.flatMap((m) => m.when_to_take || [])),
      ];

      res.json({
        success: true,
        options: {
          types: unique("type"),
          strengths: unique("strength"),
          units: unique("unit"),
          durations: unique("duration"),
          when_to_take: whenOptions,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({
        success: false,
      });
    }
  }
);

/* ============================================================================
   3️⃣ UPDATE MEDICINE
============================================================================ */
/* ================= UPDATE MEDICINE ================= */
router.put(
  "/:id",
  authMiddleware,
  allowRoles("admin", "doctor"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);
      const { id } = req.params;

      const {
        medicine_name,
        type,
        strength,
        unit,
        quantity,
        amount,
        when_to_take,
        duration,
        description,
      } = req.body;

      await db.execute(
        `
        UPDATE medicines
        SET
          medicine_name = ?,
          type = ?,
          strength = ?,
          unit = ?,
          quantity = ?,
          amount = ?,
          when_to_take = ?,
          duration = ?,
          description = ?
        WHERE id = ? AND admin_id = ?
        `,
        [
          medicine_name,
          type || null,
          strength || null,
          unit || null,
          quantity || 1,
          amount || 0,
          when_to_take ? JSON.stringify(when_to_take) : null,
          duration || null,
          description || null,
          id,
          adminId,
        ]
      );

      res.json({ success: true, message: "Medicine updated" });

    } catch (error) {
      console.error(error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);


/* ============================================================================
   4️⃣ DELETE MEDICINE
============================================================================ */
router.delete(
  "/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = getAdminIdFromUser(req.user);
      const { id } = req.params;

      const [result] = await db.execute(
        `DELETE FROM medicines WHERE id = ? AND admin_id = ?`,
        [id, adminId]
      );

      if (!result.affectedRows) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found",
        });
      }

      return res.json({
        success: true,
        message: "Medicine deleted successfully",
      });

    } catch (error) {
      console.error("Delete medicine error:", error);
      return res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

module.exports = router;
