const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");
const { regenerateBill } = require("./ipdBillsRoutes");

/* ===================== CREATE NURSING CHARGE ===================== */
/* Receptionist Only */
router.post(
  "/post/nursing-charges",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId } = req.user;

      let { ipd_id, charge_date, description, charge_amount } = req.body;

      /* ✅ BASIC VALIDATION (existing + safe additions) */
      if (!ipd_id || !charge_date) {
        return res.status(400).json({
          message: "ipd_id & charge_date required",
        });
      }
      // ADD THIS (no impact on existing logic)
      if (description !== undefined && description !== null) {
        description = description
          .trim() // remove start/end spaces
          .replace(/\s+/g, " ") // remove extra spaces inside
          .toLowerCase(); // make case-insensitive

        if (description === "") description = null;
      }

      // Normalize values (no breaking change)
      charge_amount = charge_amount ?? 0;

      /* ✅ NEW: Prevent negative values (safe) */
      if (charge_amount < 0) {
        return res.status(400).json({
          success: false,
          message: "charge_amount cannot be negative",
        });
      }

      /* ✅ NEW: Prevent future date (optional but safe) */
      const today = new Date().toISOString().split("T")[0];
      if (charge_date > today) {
        return res.status(400).json({
          success: false,
          message: "Future date not allowed",
        });
      }

      await conn.beginTransaction();

      /* ✅ 1. Validate IPD belongs to same admin (WITH LOCK - safe upgrade) */
      const [[ipd]] = await conn.query(
        `SELECT id, status, admission_date, discharge_date,branch_name
        FROM ipd_admissions
        WHERE id = ? AND admin_id = ?
        FOR UPDATE`,
        [ipd_id, adminId],
      );

      if (!ipd) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Invalid ipd_id (not under this admin)",
        });
      }

      /* ================= RECEPTIONIST BRANCH VALIDATION ================= */

      const { id: staffId } = req.user;

      // Get receptionist branch
      const [[staff]] = await conn.query(
        `SELECT branch
          FROM staff
          WHERE id = ? AND admin_id = ?`,
        [staffId, adminId],
      );

      if (!staff) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Receptionist not found",
        });
      }

      // Compare receptionist branch with IPD branch
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

      /* ✅ Existing: Prevent after discharge */
      if (ipd.status === "discharged") {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Cannot add charges after discharge",
        });
      }

      // ================= DATE WITHIN IPD STAY =================
      if (charge_date < ipd.admission_date) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "charge_date cannot be before admission_date",
        });
      }

      if (ipd.discharge_date && charge_date > ipd.discharge_date) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "charge_date cannot be after discharge_date",
        });
      }

      // ADD THIS (do not remove existing discharge check)
      if (["cancelled", "closed"].includes(ipd.status)) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Cannot add charges for this IPD status",
        });
      }

      const [[existing]] = await conn.query(
        `SELECT id FROM ipd_nursing_charges
        WHERE ipd_id = ?
            AND charge_date = ?
            AND admin_id = ?
            AND (
            (description IS NULL AND ? IS NULL)
            OR LOWER(TRIM(REPLACE(description, '  ', ' '))) = ?
            )`,
        [ipd_id, charge_date, adminId, description, description],
      );

      if (existing) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Same description already exists for this date",
        });
      }

      /* ✅ INSERT (unchanged logic) */
      const [result] = await conn.query(
        `INSERT INTO ipd_nursing_charges
            (admin_id, ipd_id, charge_date, description, charge_amount)
            VALUES (?, ?, ?, ?, ?)`,
        [adminId, ipd_id, charge_date, description || null, charge_amount],
      );

      await conn.commit();
      await regenerateBill(ipd_id);

      return res.status(201).json({
        success: true,
        message: "Nursing charge added",
        id: result.insertId,
      });
    } catch (err) {
      await conn.rollback();

      /* ✅ NEW: Handle duplicate DB constraint (future-proof) */
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({
          success: false,
          message: "Duplicate charge detected",
        });
      }

      console.error("Create Nursing Charge Error:", err);
      return res.status(500).json({
        message: "Failed to add charge",
      });
    } finally {
      conn.release();
    }
  },
);

/* ===================== GET ALL / SINGLE ===================== */
/* Admin + Receptionist */
// this api gives below filters
//  /ipd/nursing?ipd_id=IPD000003
//      /ipd/nursing?date=2026-04-23
//      /ipd/nursing?ipd_id=IPD000003&date=2026-04-23
//      /ipd/nursing?from_date=2026-04-20&to_date=2026-04-25
//      /ipd/nursing?ipd_id=IPD000003&from_date=2026-04-20&to_date=2026-04-25

router.get(
  "/getall/nursing-charges",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;

      const finalAdminId = role === "admin" ? id : adminId;

      const {
        id: chargeId,
        ipd_id,
        date,
        from_date,
        to_date,
      } = req.query;

      /* =====================================================
         CLIENT -> Validate only by client_id (NO ADMIN)
      ===================================================== */
      if (role === "client" && ipd_id) {
        const [[ipd]] = await db.query(
          `SELECT id, client_id
           FROM ipd_admissions
           WHERE id = ?`,
          [ipd_id]
        );

        if (!ipd) {
          return res.status(404).json({
            success: false,
            message: "IPD not found",
          });
        }

        if (ipd.client_id !== id) {
          return res.status(403).json({
            success: false,
            message: "Access denied",
          });
        }
      }

      /* =====================================================
         ADMIN / RECEPTIONIST -> Validate admin ownership
      ===================================================== */
      if (role !== "client" && ipd_id) {
        const [[ipd]] = await db.query(
          `SELECT id, client_id
           FROM ipd_admissions
           WHERE id = ? AND admin_id = ?`,
          [ipd_id, finalAdminId]
        );

        if (!ipd) {
          return res.status(403).json({
            success: false,
            message: "Access denied: IPD does not belong to your admin",
          });
        }
      }

      /* =====================================================
         BASE WHERE
      ===================================================== */

      let where = "";
      let params = [];

      if (role === "client") {
        where = `i.client_id = ?`;
        params.push(id);
      } else {
        where = `nc.admin_id = ?`;
        params.push(finalAdminId);
      }

      /* =====================================================
         RECEPTIONIST BRANCH FILTER
      ===================================================== */

      if (role === "receptionist") {
        const [[staff]] = await db.query(
          `SELECT branch
           FROM staff
           WHERE id = ? AND admin_id = ?`,
          [id, finalAdminId]
        );

        if (!staff) {
          return res.status(404).json({
            success: false,
            message: "Receptionist not found",
          });
        }

        where += `
          AND LOWER(TRIM(i.branch_name)) = ?
        `;

        params.push((staff.branch || "").trim().toLowerCase());
      }

      /* =====================================================
         FILTERS
      ===================================================== */

      if (ipd_id) {
        where += ` AND nc.ipd_id = ?`;
        params.push(ipd_id);
      }

      if (date) {
        where += ` AND nc.charge_date = ?`;
        params.push(date);
      } else if (from_date && to_date) {
        where += ` AND nc.charge_date BETWEEN ? AND ?`;
        params.push(from_date, to_date);
      }

      if (chargeId) {
        where += ` AND nc.id = ?`;
        params.push(chargeId);

        const [[row]] = await db.query(
          `SELECT
              nc.*,
              i.client_id,
              i.branch_name
           FROM ipd_nursing_charges nc
           JOIN ipd_admissions i
             ON i.id = nc.ipd_id
           WHERE ${where}`,
          params
        );

        if (!row) {
          return res.status(404).json({
            success: false,
            message: "Charge not found",
          });
        }

        return res.json({
          success: true,
          data: row,
        });
      }

      /* =====================================================
         GET ALL
      ===================================================== */

      const [rows] = await db.query(
        `SELECT
            nc.*,
            i.client_id,
            i.branch_name
         FROM ipd_nursing_charges nc
         JOIN ipd_admissions i
           ON i.id = nc.ipd_id
         WHERE ${where}
         ORDER BY nc.charge_date DESC`,
        params
      );

      return res.json({
        success: true,
        count: rows.length,
        data: rows,
      });
    } catch (err) {
      console.error("Get Nursing Charges Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch charges",
      });
    }
  }
);

/* ===================== UPDATE CHARGE ===================== */
/* Receptionist Only */
router.put(
  "/update/nursing-charges/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId } = req.user;
      const chargeId = req.params.id;

      let { charge_date, description, charge_amount } = req.body;

      /* ================= NORMALIZE ================= */
      if (description !== undefined && description !== null) {
        description = description.trim().replace(/\s+/g, " ").toLowerCase();

        if (description === "") description = null;
      }

      charge_amount = charge_amount ?? undefined;

      if (charge_amount !== undefined && charge_amount < 0) {
        return res.status(400).json({
          success: false,
          message: "charge_amount cannot be negative",
        });
      }

      const today = new Date().toISOString().split("T")[0];
      if (charge_date && charge_date > today) {
        return res.status(400).json({
          success: false,
          message: "Future date not allowed",
        });
      }

      await conn.beginTransaction();

      /* ================= GET EXISTING CHARGE ================= */
      /* ================= CHECK CHARGE EXISTS ================= */
      const [[charge]] = await conn.query(
        `SELECT * FROM ipd_nursing_charges 
        WHERE id = ?
        FOR UPDATE`,
        [chargeId],
      );

      if (!charge) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Charge not found",
        });
      }

      /* ================= CHECK ADMIN OWNERSHIP ================= */
      if (charge.admin_id !== adminId) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Access denied: You cannot modify this charge",
        });
      }

      /* ================= VALIDATE IPD ================= */
      const [[ipd]] = await conn.query(
        `SELECT id, status, admission_date, discharge_date, branch_name
      FROM ipd_admissions
      WHERE id = ? AND admin_id = ?`,
        [charge.ipd_id, adminId],
      );

      if (!ipd) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Access denied: IPD not under your admin",
        });
      }

      /* ================= RECEPTIONIST BRANCH VALIDATION ================= */

      const { id: staffId } = req.user;

      // Get receptionist branch
      const [[staff]] = await conn.query(
        `SELECT branch
          FROM staff
          WHERE id = ?`,
        [staffId],
      );

      if (!staff) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Receptionist not found",
        });
      }

      // Compare receptionist branch with IPD branch
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

      if (["discharged", "cancelled", "closed"].includes(ipd.status)) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Cannot update charges for this IPD status",
        });
      }

      let fields = [];
      let values = [];

      /* ================= DATE VALIDATION ================= */
      if (charge_date !== undefined && charge_date !== charge.charge_date) {
        if (charge_date < ipd.admission_date) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: "charge_date cannot be before admission_date",
          });
        }

        if (ipd.discharge_date && charge_date > ipd.discharge_date) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: "charge_date cannot be after discharge_date",
          });
        }

        fields.push("charge_date = ?");
        values.push(charge_date);
      }

      /* ================= DESCRIPTION ================= */
      if (description !== undefined && description !== charge.description) {
        fields.push("description = ?");
        values.push(description);
      }

      /* ================= AMOUNT ================= */
      if (
        charge_amount !== undefined &&
        charge_amount !== charge.charge_amount
      ) {
        fields.push("charge_amount = ?");
        values.push(charge_amount);
      }

      if (fields.length === 0) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "No changes detected",
        });
      }
      fields.push("updated_at = CURRENT_TIMESTAMP");

      /* ================= DUPLICATE CHECK ================= */
      const newDate = charge_date ?? charge.charge_date;
      const newDesc = description ?? charge.description;

      const [[existing]] = await conn.query(
        `SELECT id FROM ipd_nursing_charges
         WHERE ipd_id = ?
           AND charge_date = ?
           AND admin_id = ?
           AND id != ?
           AND (
             (description IS NULL AND ? IS NULL)
             OR LOWER(description) = LOWER(?)
           )`,
        [charge.ipd_id, newDate, adminId, chargeId, newDesc, newDesc],
      );

      if (existing) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Same description already exists for this date",
        });
      }

      /* ================= UPDATE ================= */
      const query = `
        UPDATE ipd_nursing_charges
        SET ${fields.join(", ")}
        WHERE id = ? AND admin_id = ?
      `;

      values.push(chargeId, adminId);

      await conn.query(query, values);

      await conn.commit();

      await regenerateBill(charge.ipd_id);

      return res.json({
        success: true,
        message: "Charge updated successfully",
      });
    } catch (err) {
      await conn.rollback();
      console.error("Update Charge Error:", err);
      return res.status(500).json({
        message: "Failed to update charge",
      });
    } finally {
      conn.release();
    }
  },
);

/* ===================== DELETE CHARGE ===================== */
/* Receptionist Only */
router.delete(
  "/delete/nursing-charges/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId } = req.user;
      const chargeId = req.params.id;

      await conn.beginTransaction();

      /* ================= CHECK CHARGE EXISTS ================= */
      const [[charge]] = await conn.query(
        `SELECT id, admin_id, ipd_id 
         FROM ipd_nursing_charges 
         WHERE id = ? FOR UPDATE`,
        [chargeId],
      );

      if (!charge) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Nurse Charge not found",
        });
      }

      /* ================= CHECK ADMIN OWNERSHIP ================= */
      if (charge.admin_id !== adminId) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Access denied: Not under your admin",
        });
      }

      /* ================= VALIDATE IPD ================= */
      const [[ipd]] = await conn.query(
        `SELECT id, admin_id, status, branch_name
      FROM ipd_admissions
      WHERE id = ?
      FOR UPDATE`,
        [charge.ipd_id],
      );

      if (!ipd) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Associated IPD not found",
        });
      }

      /* ================= CHECK IPD ADMIN MATCH ================= */
      if (ipd.admin_id !== adminId) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Access denied: IPD not under your admin",
        });
      }

      /* ================= RECEPTIONIST BRANCH VALIDATION ================= */

      const { id: staffId } = req.user;

      // Get receptionist branch
      const [[staff]] = await conn.query(
        `SELECT branch
          FROM staff
          WHERE id = ?`,
        [staffId],
      );

      if (!staff) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Receptionist not found",
        });
      }

      // Compare receptionist branch with IPD branch
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

      /* ================= BLOCK DELETE AFTER CLOSE ================= */
      if (["discharged", "cancelled", "closed"].includes(ipd.status)) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Cannot delete Nurse charge for this IPD status",
        });
      }

      /* ================= DELETE ================= */
      const [result] = await conn.query(
        `DELETE FROM ipd_nursing_charges 
         WHERE id = ? AND admin_id = ?`,
        [chargeId, adminId],
      );

      await conn.commit();
      await regenerateBill(charge.ipd_id);

      return res.json({
        success: true,
        message: "Nurse Charge deleted successfully",
      });
    } catch (err) {
      await conn.rollback();
      console.error("Delete Charge Error:", err);
      return res.status(500).json({
        message: "Failed to delete charge",
      });
    } finally {
      conn.release();
    }
  },
);

module.exports = router;