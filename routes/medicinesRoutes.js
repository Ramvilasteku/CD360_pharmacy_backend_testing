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
   Search helpers (built for a large catalogue — 2 lakh+ medicines)
============================================================================ */

/* "%" and "_" are wildcards in LIKE; escape them so "Dolo_650" means Dolo_650 */
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => "\\" + c);

/* when_to_take is stored as JSON text — always hand the app a real array */
function parseWhen(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch {
    return value.split(",").map((x) => x.trim()).filter(Boolean);
  }
}
const withParsedWhen = (rows) => rows.map((r) => ({ ...r, when_to_take: parseWhen(r.when_to_take) }));

/* Dropdown values (types, units, durations, when-to-take) change rarely;
   building them reads the whole table, so keep them for 10 minutes and
   rebuild after any add / edit / delete. */
let optionsCache = { at: 0, data: null };
const OPTIONS_TTL_MS = 10 * 60 * 1000;
const clearOptionsCache = () => { optionsCache = { at: 0, data: null }; };

/* Find the matching ids from the medicine_name index alone (fast even when
   few rows match), then load only those rows. Plain "SELECT * … ORDER BY
   medicine_name LIMIT n" made MySQL fetch every row while walking the
   index — ~0.7 s for a search with no matches at 2 lakh rows. */
async function pickMedicines(whereSql, params, limit, offset = 0) {
  const [rows] = await db.execute(
    `SELECT m.*
     FROM medicines m
     JOIN (
       SELECT id FROM medicines
       ${whereSql}
       ORDER BY medicine_name ASC
       LIMIT ${limit} OFFSET ${offset}
     ) pick ON pick.id = m.id
     ORDER BY m.medicine_name ASC`,
    params
  );
  return rows;
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

      clearOptionsCache();

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
   2️⃣ GET ALL MEDICINES  (list / management screens)
   Paged: with 2 lakh medicines, "all" was ~50 MB in one response.
   ?search=&page=1&limit=100   (limit max 500)  → { data, total, page, limit }
============================================================================ */
router.get(
  "/search-all",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const search = String(req.query.search || "").trim();
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const offset = (page - 1) * limit;

      const where = search ? "WHERE medicine_name LIKE ?" : "";
      const params = search ? [`%${likeEscape(search)}%`] : [];

      const rows = await pickMedicines(where, params, limit, offset);
      const [[{ total }]] = await db.execute(
        `SELECT COUNT(*) AS total FROM medicines ${where}`,
        params
      );

      res.json({
        success: true,
        data: withParsedWhen(rows),
        total: Number(total),
        page,
        limit,
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
   SEARCH  (the Rx pad's medicine box)
   ?search=para&page=1&limit=20
   1. names that START with what was typed come first ("para" → Paracetamol…,
      "dolo 650" → Dolo_650 / Dolo-650 / Dolo 650)
   2. then names that CONTAIN every typed word ("dolo 650" → Dolo_650)
   Both use the medicine_name index (see 003_medicines_search_index.sql).
============================================================================ */
router.get(
  "/search",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const search = String(req.query.search || "").trim().replace(/\s+/g, " ").slice(0, 100);
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const offset = (page - 1) * limit;

      /* nothing typed → first medicines A–Z */
      if (!search) {
        const rows = await pickMedicines("", [], limit, offset);
        return res.json({ success: true, data: withParsedWhen(rows) });
      }

      const words = search.split(" ").filter(Boolean).slice(0, 5);
      /* words joined by "_" (LIKE's any-one-character) so "dolo 650"
         also starts-matches "Dolo_650", "Dolo-650" and "Dolo 650" */
      const startsWith = `${words.map(likeEscape).join("_")}%`;
      const containsAll = words.map(() => "medicine_name LIKE ?").join(" AND ");
      const containsParams = words.map((w) => `%${likeEscape(w)}%`);

      /* page 2+ : one simple ordered list (the box only asks for page 1) */
      if (page > 1) {
        const rows = await pickMedicines(`WHERE ${containsAll}`, containsParams, limit, offset);
        return res.json({ success: true, data: withParsedWhen(rows) });
      }

      /* 1) starts with the typed text — fast index range scan */
      const first = await pickMedicines("WHERE medicine_name LIKE ?", [startsWith], limit);

      /* 2) top up with names containing every word */
      let rest = [];
      if (first.length < limit) {
        rest = await pickMedicines(
          `WHERE ${containsAll} AND medicine_name NOT LIKE ?`,
          [...containsParams, startsWith],
          limit - first.length
        );
      }

      res.json({
        success: true,
        data: withParsedWhen([...first, ...rest]),
      });

    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false
      });
    }
  }
);

/* ============================================================================
   OPTIONS  (types, units, durations, when-to-take for the medicine form)
   Before: loaded every medicine row on every form open (~1 s at 2 lakh).
   Now: DISTINCT values only, cached for 10 minutes.
============================================================================ */
const WHEN_ORDER = ["Morning", "Afternoon", "Evening", "Night"];

router.get(
  "/options",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      if (optionsCache.data && Date.now() - optionsCache.at < OPTIONS_TTL_MS) {
        return res.json({ success: true, options: optionsCache.data });
      }

      const distinct = async (col, max = 300) => {
        const [rows] = await db.execute(
          `SELECT DISTINCT ${col} AS v FROM medicines
           WHERE ${col} IS NOT NULL AND ${col} <> ''
           ORDER BY ${col} ASC LIMIT ${max}`
        );
        return rows.map((r) => r.v);
      };

      const [types, strengths, units, durations, whenRaw] = await Promise.all([
        distinct("type"),
        distinct("strength", 500),
        distinct("unit"),
        distinct("duration"),
        distinct("when_to_take", 1000),
      ]);

      const whenSet = new Set(whenRaw.flatMap(parseWhen).map((w) => String(w).trim()).filter(Boolean));
      const when_to_take = [
        ...WHEN_ORDER.filter((w) => whenSet.has(w)),
        ...[...whenSet].filter((w) => !WHEN_ORDER.includes(w)).sort(),
      ];

      const options = { types, strengths, units, durations, when_to_take };
      optionsCache = { at: Date.now(), data: options };

      res.json({
        success: true,
        options,
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

      const [result] = await db.execute(
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

      /* Shared catalogue medicines (admin_id NULL, e.g. everything added via
         POST /) can't be edited by one clinic — say so instead of "updated". */
      if (!result.affectedRows) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found, or it is a shared catalogue medicine that can't be edited here",
        });
      }

      clearOptionsCache();
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

      clearOptionsCache();
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