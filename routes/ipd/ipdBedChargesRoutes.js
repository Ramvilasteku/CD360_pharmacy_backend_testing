const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");
const { regenerateBill } = require("./ipdBillsRoutes");

async function generateBedCharges(ipd_id, adminId = null) {
  const conn = await db.getConnection();
 
  try {
    await conn.beginTransaction();
 
    /* =====================================================
         GET IPD
      ===================================================== */
 
    const [[ipd]] = await conn.query(
      `SELECT
            id,
            admin_id,
            status,
            branch_name,
            admission_date,
            discharge_date
         FROM ipd_admissions
         WHERE id = ?
         FOR UPDATE`,
      [ipd_id],
    );
 
    if (!ipd) {
      await conn.rollback();
      return 0;
    }
 
    /* =====================================================
         STATUS CHECK
      ===================================================== */
    if (ipd.status !== "admitted" && ipd.status !== "discharged") {
      await conn.rollback();
      return 0;
    }
 
    // dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
 
    const [allocations] = await conn.query(
      `SELECT
            a.id AS allocation_id,
            a.bed_id,
            a.start_time,
 
            COALESCE(
              a.end_time,
              ?
            ) AS end_time,
 
            a.allocation_status,
 
            b.bed_number,
            b.bed_charge,
            b.branch_name AS bed_branch
 
         FROM ipd_bed_allocations a
 
         INNER JOIN ipd_beds b
           ON b.id = a.bed_id
 
         WHERE a.ipd_id = ?
           AND a.admin_id = ?
 
         ORDER BY a.start_time ASC`,
      [ipd.discharge_date || new Date(), ipd_id, adminId],
    );
 
    if (!allocations.length) {
      await conn.rollback();
      return 0;
    }
 
    let insertedCount = 0;
 
    const today = new Date();
 
    today.setHours(0, 0, 0, 0);
 
    /* =====================================================
         PROCESS EACH ALLOCATION
      ===================================================== */
 
    for (const data of allocations) {
      /* -------------------------------------------------
           START / END
        ------------------------------------------------- */
 
      const start = new Date(data.start_time);
 
      const end = new Date(data.end_time);
 
      if (start >= end) {
        continue;
      }
 
      /* =================================================
           DATE ITERATION
        ================================================= */
 
      let currentDay = new Date(start);
 
      currentDay.setHours(0, 0, 0, 0);
 
      const lastDay = new Date(end);
 
      lastDay.setHours(0, 0, 0, 0);
 
      while (currentDay <= lastDay) {
        /* ---------------------------------------------
             SKIP FUTURE DAYS
          --------------------------------------------- */
 
        if (currentDay > today) {
          currentDay.setDate(currentDay.getDate() + 1);
 
          continue;
        }
 
        /* ---------------------------------------------
             CHARGE DATE
          --------------------------------------------- */
 
        const charge_date = currentDay.toLocaleDateString("en-CA");
 
        /* ---------------------------------------------
             DAY TYPE
          --------------------------------------------- */
 
        const isFirstDay = currentDay.toDateString() === start.toDateString();
 
        const isLastDay = currentDay.toDateString() === end.toDateString();
 
        let hours = 0;
 
        /* =============================================
             SAME DAY
          ============================================= */
 
        if (isFirstDay && isLastDay) {
          hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
        } else if (isFirstDay) {
          /* =============================================
             FIRST DAY
          ============================================= */
          const nextDay = new Date(currentDay);
 
          nextDay.setDate(nextDay.getDate() + 1);
 
          nextDay.setHours(0, 0, 0, 0);
 
          hours = (nextDay.getTime() - start.getTime()) / (1000 * 60 * 60);
        } else if (isLastDay) {
          /* =============================================
             LAST DAY
          ============================================= */
          const startOfDay = new Date(currentDay);
 
          startOfDay.setHours(0, 0, 0, 0);
 
          hours = (end.getTime() - startOfDay.getTime()) / (1000 * 60 * 60);
        } else {
          /* =============================================
             FULL MIDDLE DAY
          ============================================= */
          /* 🔥 FORCE EXACT 24 */
          hours = 24;
        }
 
        hours = Math.round(hours * 100) / 100;
 
        if (hours <= 0) {
          currentDay.setDate(currentDay.getDate() + 1);
 
          continue;
        }
 
        /* ---------------------------------------------
             CHARGE LOGIC
          --------------------------------------------- */
 
        let charge_type;
        let charge_amount;
 
        if (hours < 1) {
          charge_type = "hourly";
 
          charge_amount = (Number(data.bed_charge) / 24) * hours;
        } else if (hours <= 12) {
          charge_type = "half_day";
 
          charge_amount = Number(data.bed_charge) / 2;
        } else {
          charge_type = "full_day";
 
          charge_amount = Number(data.bed_charge);
        }
 
        charge_amount = Math.round(charge_amount * 100) / 100;
 
        /* ---------------------------------------------
             DUPLICATE CHECK
          --------------------------------------------- */
 
        /* ---------------------------------------------
     UPSERT (insert new, or correct existing
     row if hours/charge changed)
  --------------------------------------------- */
 
          const [[existing]] = await conn.query(
            `SELECT id, hours_used, charge_type, charge_amount
              FROM ipd_bed_charges
              WHERE ipd_id = ?
                AND bed_allocation_id = ?
                AND charge_date = ?`,
            [ipd_id, data.allocation_id, charge_date],
          );
 
          if (!existing) {
            // First time we've seen this charge_date — insert it
            await conn.query(
              `INSERT INTO ipd_bed_charges
                (admin_id, ipd_id, bed_allocation_id, bed_id, charge_date,
                hours_used, charge_type, rate_per_day, charge_amount)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [adminId, ipd_id, data.allocation_id, data.bed_id, charge_date,
              hours, charge_type, data.bed_charge, charge_amount],
            );
            insertedCount++;
          } else if (
            Number(existing.hours_used) !== hours ||
            existing.charge_type !== charge_type ||
            Number(existing.charge_amount) !== charge_amount
          ) {
            // Day isn't final yet (e.g. "today") — correct the row
            // as more hours accumulate
            await conn.query(
              `UPDATE ipd_bed_charges
                SET hours_used = ?, charge_type = ?, charge_amount = ?
                WHERE id = ?`,
              [hours, charge_type, charge_amount, existing.id],
            );
            insertedCount++; // so regenerateBill still fires
          }
 
        /* ---------------------------------------------
             NEXT DAY
          --------------------------------------------- */
 
        currentDay.setDate(currentDay.getDate() + 1);
      }
    }
 
    if (!ipd) {
        console.log(`[DEBUG] IPD ${ipd_id}: not found`);
        await conn.rollback();
        return 0;
      }
 
      if (ipd.status !== "admitted" && ipd.status !== "discharged") {
        console.log(`[DEBUG] IPD ${ipd_id}: bad status = ${ipd.status}`);
        await conn.rollback();
        return 0;
      }
 
      // ... after allocations query ...
 
      console.log(`[DEBUG] IPD ${ipd_id}: found ${allocations.length} allocations for admin_id=${adminId}`);
 
      if (!allocations.length) {
        await conn.rollback();
        return 0;
      }
     
    /* =====================================================
         COMMIT
      ===================================================== */
 
    await conn.commit();
 
    if (insertedCount > 0) {
      await regenerateBill(ipd_id);
    }
 
    return insertedCount;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Fetch bed charges with filters (ipd_id, bed_charge_id, date, from/to) after validating IPD, allocation, and admin access
// Ensures receptionist/admin belongs to same admin and returns only authorized bed charge records

/* =========================================================
   GET BED CHARGES (Admin + Receptionist)
========================================================= */
router.get(
  "/getall/bed-charges",
  authMiddleware,

  // ✅ Added client role
  allowRoles("admin", "receptionist", "client"),

  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { role, id, adminId } = req.user;

      // ✅ admin uses own id
      // ✅ receptionist/client use adminId
      const finalAdminId = role === "admin" ? id : adminId;

      const { ipd_id, bed_charge_id, from_date, to_date, date } = req.query;

      /* ❌ Prevent conflicting filters */
      if (date && (from_date || to_date)) {
        return res.status(400).json({
          success: false,
          message: "Use either 'date' OR 'from/to'",
        });
      }

      /* =====================================================
         🔍 CHECK IPD EXISTS
      ===================================================== */
      if (ipd_id) {
        const [[ipd]] = await conn.query(
          `SELECT id, admin_id, client_id
           FROM ipd_admissions
           WHERE id = ?`,
          [ipd_id],
        );

        if (!ipd) {
          return res.status(404).json({
            success: false,
            message: "IPD not found",
          });
        }

        // Admin / Receptionist validation
        if (
          role !== "client" &&
          ipd.admin_id !== finalAdminId
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied (IPD mismatch)",
          });
        }

        // Client validation
        if (
          role === "client" &&
          ipd.client_id !== id
        ) {
          return res.status(403).json({
            success: false,
            message: "Access denied",
          });
        }
      }

      /* =====================================================
         🔒 BASE FILTER
      ===================================================== */
      let where = `1=1`;
      let params = [];

      // Admin + Receptionist
      if (role !== "client") {
        where += ` AND bc.admin_id = ?`;
        params.push(finalAdminId);
      }

      /* =====================================================
         🔒 RECEPTIONIST BRANCH FILTER
      ===================================================== */
      if (role === "receptionist") {
        const [[staff]] = await conn.query(
          `SELECT branch, admin_id
           FROM staff
           WHERE id = ?`,
          [id],
        );

        if (!staff || staff.admin_id !== finalAdminId) {
          return res.status(403).json({
            success: false,
            message: "Access denied (staff mismatch)",
          });
        }

        where += " AND LOWER(TRIM(ipd.branch_name)) = ?";

        params.push((staff.branch || "").trim().toLowerCase());
      }

      /* =====================================================
         🔒 CLIENT FILTER
      ===================================================== */
      if (role === "client") {
        where += `
          AND ipd.client_id = ?
        `;
        params.push(id);
      }

      /* =====================================================
         🔍 FILTERS
      ===================================================== */

      if (bed_charge_id) {
        where += " AND bc.id = ?";
        params.push(bed_charge_id);
      }

      if (ipd_id) {
        where += " AND bc.ipd_id = ?";
        params.push(ipd_id);
      }

      /* ✅ Proper date filtering */
      if (date) {
        where += " AND bc.charge_date = ?";
        params.push(date);
      } else if (from_date && to_date) {
        where += " AND bc.charge_date BETWEEN ? AND ?";
        params.push(from_date, to_date);
      } else if (from_date) {
        where += " AND bc.charge_date >= ?";
        params.push(from_date);
      } else if (to_date) {
        where += " AND bc.charge_date <= ?";
        params.push(to_date);
      }

      /* =====================================================
         🔍 FETCH DATA
      ===================================================== */
      const [rows] = await conn.query(
        `SELECT
            bc.*,
            b.bed_number,
            a.start_time,
            a.end_time,
            ipd.branch_name,
            ipd.client_id
         FROM ipd_bed_charges bc

         JOIN ipd_bed_allocations a
  ON a.id = bc.bed_allocation_id

  
         JOIN ipd_beds b
           ON b.id = a.bed_id

         JOIN ipd_admissions ipd
           ON ipd.id = bc.ipd_id

         WHERE ${where}

         ORDER BY bc.charge_date DESC`,
        params,
      );

      /* =====================================================
         ✅ RESPONSE
      ===================================================== */
      return res.json({
        success: true,
        count: rows.length,
        data: rows,
      });
    } catch (err) {
      console.error("GET BED CHARGES ERROR:", err);

      return res.status(500).json({
        success: false,
        message: "Fetch failed",
      });
    } finally {
      conn.release();
    }
  },
);

/* =========================================================
   UPDATE BED CHARGE (Receptionist)
========================================================= */
router.put(
  "/update/bed-charges/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId } = req.user;
      const chargeId = req.params.id;

      const { charge_amount, charge_type, hours_used, rate_per_day } = req.body;

      /* ===============================
         ✅ 1. VALIDATION
      =============================== */
      if (!chargeId || isNaN(chargeId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid charge ID",
        });
      }

      if (
        charge_amount === undefined &&
        charge_type === undefined &&
        hours_used === undefined &&
        rate_per_day === undefined
      ) {
        return res.status(400).json({
          success: false,
          message: "At least one field is required",
        });
      }

      if (
        charge_type &&
        !["hourly", "half_day", "full_day"].includes(charge_type)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid charge type",
        });
      }

      if (hours_used !== undefined && hours_used < 0) {
        return res.status(400).json({
          success: false,
          message: "Hours cannot be negative",
        });
      }

      if (rate_per_day !== undefined && rate_per_day < 0) {
        return res.status(400).json({
          success: false,
          message: "Rate cannot be negative",
        });
      }

      if (charge_amount !== undefined && charge_amount < 0) {
        return res.status(400).json({
          success: false,
          message: "Amount cannot be negative",
        });
      }

      await conn.beginTransaction();

      /* ===============================
         🔍 2. FETCH EXISTING
      =============================== */
      const [[charge]] = await conn.query(
        `SELECT * FROM ipd_bed_charges WHERE id = ? FOR UPDATE`,
        [chargeId],
      );

      if (!charge) {
        await conn.rollback();
        return res.status(404).json({ message: "Charge not found" });
      }

      if (charge.admin_id !== adminId) {
        await conn.rollback();
        return res.status(403).json({ message: "Access denied" });
      }

      /* ===============================
         🔒 3. CHECK IPD STATUS
      =============================== */
      const [[ipd]] = await conn.query(
        `SELECT status, branch_name
   FROM ipd_admissions
   WHERE id = ?`,
        [charge.ipd_id],
      );
      /* ===============================
   🔒 BRANCH VALIDATION
=============================== */

      const { id: staffId } = req.user;

      const [[staff]] = await conn.query(
        `SELECT branch FROM staff
WHERE id = ? AND admin_id = ?`,
        [staffId],
      );

      if (!staff) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "Receptionist not found",
        });
      }

      if (
        (staff.branch || "").trim().toLowerCase() !==
        (ipd.branch_name || "").trim().toLowerCase()
      ) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Access denied: Branch mismatch",
        });
      }

      if (!ipd || ipd.status !== "admitted") {
        await conn.rollback();
        return res.status(400).json({
          message: "Cannot update charges after discharge",
        });
      }

      /* ===============================
         🔒 4. PREVENT PAST EDIT
      =============================== */
      const today = new Date().toISOString().split("T")[0];

      if (charge.charge_date < today) {
        await conn.rollback();
        return res.status(400).json({
          message: "Cannot edit past charges",
        });
      }

      /* ===============================
         🔥 5. FINAL VALUES
      =============================== */
      const finalType = charge_type || charge.charge_type;
      const finalRate = rate_per_day ?? charge.rate_per_day;
      const finalHours =
        hours_used !== undefined ? hours_used : charge.hours_used;

      let finalAmount = charge_amount;

      /* ===============================
         🔥 6. AUTO CALCULATION
      =============================== */
      if (charge_amount === undefined) {
        if (finalType === "hourly") {
          finalAmount = (finalRate / 24) * finalHours;
        } else if (finalType === "half_day") {
          finalAmount = finalRate / 2;
        } else {
          finalAmount = finalRate;
        }
      }

      // ✅ rounding
      finalAmount = Math.round(finalAmount * 100) / 100;

      /* ===============================
         🚀 7. UPDATE
      =============================== */
      await conn.query(
        `UPDATE ipd_bed_charges 
         SET charge_type = ?, rate_per_day = ?, hours_used = ?, charge_amount = ?
         WHERE id = ?`,
        [finalType, finalRate, finalHours, finalAmount, chargeId],
      );

      await conn.commit();
      await regenerateBill(charge.ipd_id);

      return res.json({
        success: true,
        message: "Updated successfully",
        calculated: {
          charge_type: finalType,
          hours_used: finalHours,
          rate_per_day: finalRate,
          charge_amount: finalAmount,
        },
      });
    } catch (err) {
      await conn.rollback();
      console.error(err);

      res.status(500).json({
        success: false,
        message: "Update failed",
      });
    } finally {
      conn.release();
    }
  },
);

/* =========================================================
   DELETE BED CHARGE (Receptionist)
========================================================= */
router.delete(
  "/delete/bed-charges/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { id, adminId } = req.user;
      const chargeId = req.params.id;

      /* ===============================
         ✅ 1. VALIDATION
      =============================== */
      if (!chargeId || isNaN(chargeId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid charge ID",
        });
      }

      await conn.beginTransaction();

      /* ===============================
         🔍 2. VERIFY STAFF
      =============================== */
      const [[staff]] = await conn.query(
        `SELECT admin_id FROM staff WHERE id = ?`,
        [id],
      );

      if (!staff || staff.admin_id !== adminId) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Access denied (staff mismatch)",
        });
      }

      /* ===============================
         🔍 3. FETCH CHARGE
      =============================== */
      const [[charge]] = await conn.query(
        `SELECT id, admin_id, ipd_id, charge_date, bed_allocation_id
         FROM ipd_bed_charges
         WHERE id = ? FOR UPDATE`,
        [chargeId],
      );

      if (!charge) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Charge not found",
        });
      }

      if (charge.admin_id !== adminId) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      /* ===============================
         🔍 4. CHECK IPD
      =============================== */
      const [[ipd]] = await conn.query(
        `SELECT discharge_date, branch_name
          FROM ipd_admissions
         WHERE id = ? AND admin_id = ?`,
        [charge.ipd_id, adminId],
      );

      if (!ipd) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Invalid IPD reference",
        });
      }
      /* ===============================
        🔒 BRANCH VALIDATION
        =============================== */

      const [[staffBranch]] = await conn.query(
        `SELECT branch
   FROM staff
   WHERE id = ? AND admin_id = ?`,
        [id, adminId]
      );

      if (!staffBranch) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "Receptionist not found",
        });
      }

      if (
        (staffBranch.branch || "").trim().toLowerCase() !==
        (ipd.branch_name || "").trim().toLowerCase()
      ) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Access denied: Branch mismatch",
        });
      }
      /* ===============================
         ❌ 5. PREVENT DELETE AFTER DISCHARGE
      =============================== */
      if (ipd.discharge_date) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Cannot delete charges after discharge",
        });
      }

      /* ===============================
         ❌ 6. PREVENT PAST DELETE
      =============================== */
      // const today = new Date().toLocaleDateString("en-CA");

      // if (charge.charge_date < today) {
      //   await conn.rollback();
      //   return res.status(400).json({
      //     success: false,
      //     message: "Cannot delete past charges",
      //   });
      // }

      /* ===============================
         ❌ 7. ONLY LATEST (PER ALLOCATION)
      =============================== */
      // const [[lastCharge]] = await conn.query(
      //   `SELECT id
      //    FROM ipd_bed_charges
      //    WHERE ipd_id = ?
      //      AND bed_allocation_id = ?
      //    ORDER BY charge_date DESC, id DESC
      //    LIMIT 1`,
      //   [charge.ipd_id, charge.bed_allocation_id]
      // );

      // if (!lastCharge || lastCharge.id !== chargeId) {
      //   await conn.rollback();
      //   return res.status(400).json({
      //     success: false,
      //     message: "Only latest charge can be deleted",
      //   });
      // }

      /* ===============================
         🚀 8. DELETE
      =============================== */
      const [result] = await conn.query(
        `DELETE FROM ipd_bed_charges WHERE id = ?`,
        [chargeId],
      );

      if (result.affectedRows === 0) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Delete failed",
        });
      }

      await conn.commit();
      await regenerateBill(charge.ipd_id);
      return res.json({
        success: true,
        message: "Deleted successfully",
        deleted_id: chargeId,
      });
    } catch (err) {
      await conn.rollback();
      console.error("DELETE ERROR:", err);

      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    } finally {
      conn.release();
    }
  },
);

module.exports = {
  router,
  generateBedCharges,
};