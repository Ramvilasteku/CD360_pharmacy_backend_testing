const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");
const { regenerateBill } = require("./ipdBillsRoutes");

/* =========================================================
    CREATE MISC CHARGE (Receptionist)
    ========================================================= */
router.post(
  "/post/misc-charges",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId } = req.user;

      let { ipd_id, charge_date, description, charge_amount } = req.body;

      if (!ipd_id || !charge_date || !description) {
        return res.status(400).json({
          message: "ipd_id, charge_date & description required",
        });
      }

      /* ================= NORMALIZE ================= */
      description = description.trim().replace(/\s+/g, " ").toLowerCase();

      charge_amount = charge_amount ?? 0;

      if (charge_amount < 0) {
        return res.status(400).json({
          success: false,
          message: "charge_amount cannot be negative",
        });
      }

      const today = new Date().toISOString().split("T")[0];
      if (charge_date > today) {
        return res.status(400).json({
          success: false,
          message: "Future date not allowed",
        });
      }

      await conn.beginTransaction();

      /* ================= VALIDATE IPD ================= */
      const [[ipd]] = await conn.query(
        `SELECT id, status, admission_date, discharge_date, branch_name
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

      if (["discharged", "cancelled", "closed"].includes(ipd.status)) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Cannot add charges for this IPD status",
        });
      }

      if (charge_date < ipd.admission_date) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "charge_date before admission",
        });
      }

      if (ipd.discharge_date && charge_date > ipd.discharge_date) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "charge_date after discharge",
        });
      }

      /* ================= VALIDATE RECEPTIONIST BRANCH ================= */
      const [[staff]] = await conn.query(
        `SELECT branch 
   FROM staff
   WHERE id = ? AND admin_id = ?`,
        [req.user.id, adminId],
      );

      if (!staff) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "Receptionist not found",
        });
      }

      // receptionist branch
      const receptionistBranch = staff.branch;

      // ipd branch
      const ipdBranch = ipd.branch_name;

      // 🚫 Branch mismatch
      if (
        (receptionistBranch || "").trim().toLowerCase() !==
        (ipdBranch || "").trim().toLowerCase()
      ) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only add charges to your branch IPD patients",
        });
      }

      /* ================= DUPLICATE CHECK ================= */
      //   const [[existing]] = await conn.query(
      //     `SELECT id FROM ipd_miscellaneous_charges
      //      WHERE ipd_id = ?
      //        AND charge_date = ?
      //        AND admin_id = ?
      //        AND LOWER(description) = ?`,
      //     [ipd_id, charge_date, adminId, description]
      //   );

      //   if (existing) {
      //     await conn.rollback();
      //     return res.status(400).json({
      //       success: false,
      //       message: "Same description already exists for this date",
      //     });
      //   }

      /* ================= INSERT ================= */
      const [result] = await conn.query(
        `INSERT INTO ipd_miscellaneous_charges
            (admin_id, ipd_id, charge_date, description, charge_amount)
            VALUES (?, ?, ?, ?, ?)`,
        [adminId, ipd_id, charge_date, description, charge_amount],
      );

      await conn.commit();
      await regenerateBill(ipd_id);

      res.status(201).json({
        success: true,
        message: "Misc charge added",
        id: result.insertId,
      });
    } catch (err) {
      await conn.rollback();
      console.error(err);
      res.status(500).json({ message: "Failed to add charge" });
    } finally {
      conn.release();
    }
  },
);

/* =========================================================
    GET MISC CHARGES (Admin + Receptionist)
    ========================================================= */
router.get(
  "/getall/misc-charges",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;

      const finalAdminId = role === "admin" ? id : adminId;

      const { id: chargeId, ipd_id, date, from_date, to_date } = req.query;

      let where = `1 = 1`;
        let params = [];

        /* ================= ROLE FILTER ================= */

        if (role === "admin") {
          where += ` AND mc.admin_id = ?`;
          params.push(id);
        }

        else if (role === "receptionist") {
          where += ` AND mc.admin_id = ?`;
          params.push(adminId);
        }

        else if (role === "client") {
          where += ` AND i.client_id = ?`;
          params.push(id);
        }

      // =====================================================
      // ✅ RECEPTIONIST → BRANCH FILTER (UNCHANGED LOGIC)
      // =====================================================
      if (role === "receptionist") {
        const [[staff]] = await db.query(
          `SELECT branch 
              FROM staff
              WHERE id = ? AND admin_id = ?`,
          [id, finalAdminId],
        );

        if (!staff) {
          return res.status(404).json({
            success: false,
            message: "Receptionist not found",
          });
        }

        where += ` AND LOWER(TRIM(i.branch_name)) = ?`;
        params.push((staff.branch || "").trim().toLowerCase());
      }

      // =====================================================
      // ✅ FILTERS
      // =====================================================
      if (ipd_id) {
        where += " AND mc.ipd_id = ?";
        params.push(ipd_id);
      }

      if (date) {
        where += " AND mc.charge_date = ?";
        params.push(date);
      } else if (from_date && to_date) {
        where += " AND mc.charge_date BETWEEN ? AND ?";
        params.push(from_date, to_date);
      } else if (from_date) {
        where += " AND mc.charge_date >= ?";
        params.push(from_date);
      } else if (to_date) {
        where += " AND mc.charge_date <= ?";
        params.push(to_date);
      }

      // =====================================================
      // ✅ SINGLE
      // =====================================================
      if (chargeId) {
        where += " AND mc.id = ?";
        params.push(chargeId);

        const [[row]] = await db.query(
          `SELECT 
                  mc.*, 
                  i.client_id,
                  i.branch_name
              FROM ipd_miscellaneous_charges mc
              JOIN ipd_admissions i 
                ON i.id = mc.ipd_id
              WHERE ${where}`,
          params,
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

      // =====================================================
      // ✅ MULTIPLE
      // =====================================================
      const [rows] = await db.query(
        `SELECT 
                mc.*, 
                i.client_id,
                i.branch_name
            FROM ipd_miscellaneous_charges mc
            JOIN ipd_admissions i 
              ON i.id = mc.ipd_id
            WHERE ${where}
            ORDER BY mc.charge_date DESC`,
        params,
      );

      return res.json({
        success: true,
        count: rows.length,
        data: rows,
      });
    } catch (err) {
      console.error(err);

      return res.status(500).json({
        message: "Fetch failed",
      });
    }
  },
);

/* =========================================================
    UPDATE MISC CHARGE (Receptionist)
    ========================================================= */
router.put(
  "/update/misc-charges/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId, id: staffId } = req.user;
      const id = req.params.id;

      let { charge_date, description, charge_amount } = req.body;

      /* ================= NORMALIZE ================= */
      if (description !== undefined) {
        description = description.trim().replace(/\s+/g, " ").toLowerCase();
      }

      /* ================= VALIDATIONS ================= */

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

      /* ================= CHECK CHARGE ================= */
      const [[charge]] = await conn.query(
        `SELECT *
         FROM ipd_miscellaneous_charges
         WHERE id = ?
         FOR UPDATE`,
        [id],
      );

      if (!charge) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "Charge not found",
        });
      }

      /* ================= ADMIN VALIDATION ================= */
      if (charge.admin_id !== adminId) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      /* ================= VALIDATE IPD ================= */
      const [[ipd]] = await conn.query(
        `SELECT
            status,
            admission_date,
            discharge_date,
            branch_name
         FROM ipd_admissions
         WHERE id = ? AND admin_id = ?`,
        [charge.ipd_id, adminId],
      );

      if (!ipd) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      /* ================= RECEPTIONIST VALIDATION ================= */
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

      /* ================= BRANCH VALIDATION ================= */
      if (
        (staff.branch || "").trim().toLowerCase() !==
        (ipd.branch_name || "").trim().toLowerCase()
      ) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only update charges from your branch",
        });
      }

      /* ================= IPD STATUS CHECK ================= */
      if (["discharged", "closed", "cancelled"].includes(ipd.status)) {
        await conn.rollback();

        return res.status(400).json({
          success: false,
          message: "Cannot update charges for this IPD status",
        });
      }

      let fields = [];
      let values = [];

      /* ================= DATE VALIDATION ================= */

      const existingDate = new Date(charge.charge_date)
        .toISOString()
        .split("T")[0];

      if (charge_date !== undefined && charge_date !== existingDate) {
        const admissionDate = new Date(ipd.admission_date)
          .toISOString()
          .split("T")[0];

        if (charge_date < admissionDate) {
          await conn.rollback();

          return res.status(400).json({
            success: false,
            message: "charge_date before admission",
          });
        }

        if (ipd.discharge_date) {
          const dischargeDate = new Date(ipd.discharge_date)
            .toISOString()
            .split("T")[0];

          if (charge_date > dischargeDate) {
            await conn.rollback();

            return res.status(400).json({
              success: false,
              message: "charge_date after discharge",
            });
          }
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

      /* ================= NO CHANGES ================= */
      if (fields.length === 0) {
        await conn.rollback();

        return res.status(400).json({
          success: false,
          message: "No changes detected",
        });
      }

      /* ================= UPDATED_AT ================= */
      fields.push("updated_at = CURRENT_TIMESTAMP");

      /* ================= UPDATE ================= */
      values.push(id, adminId);

      await conn.query(
        `UPDATE ipd_miscellaneous_charges
         SET ${fields.join(", ")}
         WHERE id = ? AND admin_id = ?`,
        values,
      );

      await conn.commit();
      await regenerateBill(charge.ipd_id);

      return res.json({
        success: true,
        message: "Charge updated successfully",
      });
    } catch (err) {
      await conn.rollback();

      console.error("Update Misc Charge Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to update charge",
      });
    } finally {
      conn.release();
    }
  },
);

/* =========================================================
    DELETE MISC CHARGE (Receptionist)
    ========================================================= */
router.delete(
  "/delete/misc-charges/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId, id: staffId } = req.user;
      const id = req.params.id;

      await conn.beginTransaction();

      // =====================================================
      // ✅ GET CHARGE
      // =====================================================
      const [[charge]] = await conn.query(
        `SELECT * 
        FROM ipd_miscellaneous_charges 
        WHERE id = ?
        FOR UPDATE`,
        [id],
      );

      if (!charge) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "Charge not found",
        });
      }

      // =====================================================
      // ✅ ADMIN VALIDATION
      // =====================================================
      if (charge.admin_id !== adminId) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      // =====================================================
      // ✅ GET RECEPTIONIST BRANCH
      // =====================================================
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

      // =====================================================
      // ✅ GET IPD BRANCH
      // =====================================================
      const [[ipd]] = await conn.query(
        `SELECT branch_name,status
         FROM ipd_admissions
         WHERE id = ? AND admin_id = ?`,
        [charge.ipd_id, adminId],
      );

      if (!ipd) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      // =====================================================
      // 🚫 BRANCH VALIDATION
      // =====================================================
      if (
        (staff.branch || "").trim().toLowerCase() !==
        (ipd.branch_name || "").trim().toLowerCase()
      ) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message:
            "Access denied: You can only delete charges from your branch",
        });
      }
      // =====================================================
      // 🚫 DISCHARGED/CLOSED VALIDATION
      // =====================================================
      if (["discharged", "closed", "cancelled"].includes(ipd.status)) {
        await conn.rollback();

        return res.status(400).json({
          success: false,
          message: "Cannot delete charges for this IPD status",
        });
      }
      // =====================================================
      // ✅ DELETE
      // =====================================================
      await conn.query(
        `DELETE FROM ipd_miscellaneous_charges 
         WHERE id = ? AND admin_id = ?`,
        [id, adminId],
      );

      await conn.commit();
      await regenerateBill(charge.ipd_id);
      return res.json({
        success: true,
        message: "Deleted successfully",
      });
    } catch (err) {
      await conn.rollback();

      console.error("Delete Misc Charge Error:", err);

      return res.status(500).json({
        message: "Delete failed",
      });
    } finally {
      conn.release();
    }
  },
);

module.exports = router;