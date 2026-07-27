const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");
const { regenerateBill } = require("./ipdBillsRoutes");

/* =========================================================
   CREATE PHARMACY ISSUE (Receptionist Only)
========================================================= */
router.post(
  "/post/pharmacy",
  authMiddleware,
  allowRoles("receptionist", "doctor"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId, id: staffId } = req.user;

      let {
        ipd_id,
        medicine_name,
        quantity,
        unit_price,
        issue_date,
      } = req.body;

      /* =========================================================
         BASIC VALIDATION
      ========================================================= */
      if (!ipd_id || !medicine_name || quantity === undefined) {
        return res.status(400).json({
          success: false,
          message: "ipd_id, medicine_name, quantity required",
        });
      }

      medicine_name = medicine_name
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();

      if (!medicine_name) {
        return res.status(400).json({
          success: false,
          message: "medicine_name cannot be empty",
        });
      }

      quantity = Number(quantity);
      unit_price = Number(unit_price ?? 0);

      if (quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: "quantity must be greater than 0",
        });
      }

      if (unit_price < 0) {
        return res.status(400).json({
          success: false,
          message: "unit_price cannot be negative",
        });
      }

      const total_price = quantity * unit_price;

      /* =========================================================
         DATE VALIDATION (FIXED)
      ========================================================= */
      const today = new Date().toISOString().slice(0, 10);

      if (issue_date && isNaN(Date.parse(issue_date))) {
        return res.status(400).json({
          success: false,
          message: "Invalid date format",
        });
      }

      const finalDate = issue_date
        ? new Date(issue_date).toISOString().slice(0, 10)
        : today;

      if (finalDate > today) {
        return res.status(400).json({
          success: false,
          message: "Future date not allowed",
        });
      }

      await conn.beginTransaction();

      /* =========================================================
         GET STAFF (BRANCH CHECK)
      ========================================================= */
            const [[staff]] = await conn.query(
            `SELECT branch, role, status
            FROM staff
            WHERE id = ?
              AND admin_id = ?
              AND status = 1`,
            [staffId, adminId]
          );

      if (!staff) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Invalid staff",
        });
      }

      /* =========================================================
         VALIDATE IPD (LOCKED)
      ========================================================= */
      const [[ipd]] = await conn.query(
        `SELECT id, status, admission_date, discharge_date, branch_name
         FROM ipd_admissions
         WHERE id = ? AND admin_id = ?
         FOR UPDATE`,
        [ipd_id, adminId]
      );

      if (!ipd) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Invalid ipd_id",
        });
      }

      /* =========================================================
         BRANCH VALIDATION (STRICT)
      ========================================================= */
    /* =========================================================
   BRANCH VALIDATION (STRICT)
========================================================= */

if (!staff.branch || !ipd.branch_name) {
  await conn.rollback();

  return res.status(400).json({
    success: false,
    message: "Branch configuration missing",
  });
}

if (
  staff.branch.trim().toLowerCase() !==
  ipd.branch_name.trim().toLowerCase()
) {
  await conn.rollback();

  return res.status(403).json({
    success: false,
    message: "Access denied: Different branch",
  });
}
      /* =========================================================
         STRICT STATUS CHECK
      ========================================================= */
      if (ipd.status !== "admitted") {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Only active (admitted) IPD allowed",
        });
      }

      /* =========================================================
         DATE WITHIN IPD STAY (FIXED)
      ========================================================= */
      const admissionDate = new Date(ipd.admission_date)
        .toISOString()
        .slice(0, 10);

      if (finalDate < admissionDate) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "issue_date cannot be before admission_date",
        });
      }

      if (ipd.discharge_date) {
        const dischargeDate = new Date(ipd.discharge_date)
          .toISOString()
          .slice(0, 10);

        if (finalDate > dischargeDate) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: "issue_date cannot be after discharge_date",
          });
        }
      }

      /* =========================================================
   BED ALLOCATION CHECK (NEW - CRITICAL)
========================================================= */
        const [[bed]] = await conn.query(
        `SELECT id FROM ipd_bed_allocations
        WHERE ipd_id = ?
            AND admin_id = ?
            AND allocation_status = 'active'
            AND end_time IS NULL
        FOR UPDATE`,
        [ipd_id, adminId]
        );

        if (!bed) {
        await conn.rollback();
        return res.status(400).json({
            success: false,
            message: "No active bed allocation found for this IPD",
        });  
}
      
      /* =========================================================
         INSERT
      ========================================================= */
      const [result] = await conn.query(
        `INSERT INTO ipd_pharmacy_issues
        (admin_id, ipd_id, medicine_name, quantity, unit_price, total_price, issue_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          adminId,
          ipd_id,
          medicine_name,
          quantity,
          unit_price,
          total_price,
          finalDate,
        ]
      );

      await conn.commit();
      await regenerateBill(ipd_id);

      return res.status(201).json({
        success: true,
        message: "Pharmacy issue added successfully",
        id: result.insertId,
      });

    } catch (err) {
      await conn.rollback();

      if (err.code === "ER_DUP_ENTRY") {
        return res.status(400).json({
          success: false,
          message: "Duplicate pharmacy entry",
        });
      }

      console.error("Create Pharmacy Issue Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to add pharmacy issue",
      });

    } finally {
      conn.release();
    }
  }
);

/* =========================================================
   GET PHARMACY ISSUES (Admin + Receptionist and all)
========================================================= */
router.get(
  "/getall/ipd-pharmacy",
  authMiddleware,
  allowRoles(
    "admin",
    "receptionist",
    "doctor",
    "client"
  ),
  async (req, res) => {
    try {

      const { role, id, adminId } = req.user;

      const finalAdminId =
        role === "admin"
          ? id
          : adminId;

      const staffId = id;

      const {
        id: issueId,
        ipd_id,
        medicine_name,
        from_date,
        to_date,
        date
      } = req.query;

      let staffBranch = null;

      /* ================= STAFF ================= */

      if (
        role === "receptionist" ||
        role === "doctor"
      ) {
        const [[staff]] = await db.query(
          `SELECT branch
           FROM staff
           WHERE id = ?
             AND admin_id = ?
             AND status = 1`,
          [staffId, finalAdminId]
        );

        if (!staff) {
          return res.status(403).json({
            success: false,
            message: "Invalid staff",
          });
        }

        staffBranch = staff.branch;
      }

     /* ================= CLIENT ================= */

let clientId = null;

        if (role === "client") {

          const [[client]] = await db.query(
            `SELECT id
            FROM clients
            WHERE id = ?`,
            [id]
          );

          if (!client) {
            return res.status(403).json({
              success: false,
              message: "Invalid client",
            });
          }

          clientId = client.id;
        }

      /* ================= WHERE ================= */

     let where = `1 = 1`;
      const params = [];

      /* ================= ROLE FILTER ================= */

      if (role === "admin") {
        where += ` AND p.admin_id = ?`;
        params.push(id);
      }

      else if (role === "receptionist" || role === "doctor") {
        where += ` AND p.admin_id = ?`;
        params.push(adminId);
      }

      else if (role === "client") {
        where += ` AND i.client_id = ?`;
        params.push(clientId);
      }

      /* ================= DOCTOR ================= */

      if (role === "doctor") {
        where += ` AND i.doctor_id = ?`;
        params.push(staffId);
      }

      /* ================= RECEPTIONIST ================= */

      if (role === "receptionist") {

        where += `
          AND LOWER(TRIM(i.branch_name)) = ?
        `;

        params.push(
          staffBranch
            .trim()
            .toLowerCase()
        );
      }

      /* ================= CLIENT ================= */

      if (role === "client") {
        where += ` AND i.client_id = ?`;
        params.push(clientId);
      }

      /* ================= FILTERS ================= */

      if (ipd_id) {
        where += ` AND p.ipd_id = ?`;
        params.push(ipd_id);
      }

      if (medicine_name) {
        where += `
          AND LOWER(p.medicine_name)
          LIKE ?
        `;
        params.push(`%${medicine_name.toLowerCase()}%`);
      }

      if (date) {
        where += `
          AND DATE(p.issue_date) = ?
        `;
        params.push(date);
      }
      else if (from_date && to_date) {
        where += `
          AND DATE(p.issue_date)
          BETWEEN ? AND ?
        `;
        params.push(
          from_date,
          to_date
        );
      }

      /* ================= SINGLE RECORD ================= */

      if (issueId) {

        where += ` AND p.id = ?`;
        params.push(issueId);

        const [[row]] = await db.query(
          `SELECT
              p.*,
              i.client_id,
              i.branch_name,
              i.doctor_id,
              i.status AS ipd_status
           FROM ipd_pharmacy_issues p
           JOIN ipd_admissions i
             ON i.id = p.ipd_id
           WHERE ${where}`,
          params
        );

        if (!row) {
          return res.status(404).json({
            success: false,
            message: "Pharmacy issue not found",
          });
        }

        return res.json({
          success: true,
          data: row,
        });
      }

      /* ================= LIST ================= */

      const [rows] = await db.query(
        `SELECT
            p.*,
            i.client_id,
            i.branch_name,
            i.doctor_id,
            i.status AS ipd_status
         FROM ipd_pharmacy_issues p
         JOIN ipd_admissions i
           ON i.id = p.ipd_id
         WHERE ${where}
         ORDER BY p.issue_date DESC,
                  p.id DESC`,
        params
      );

      return res.json({
        success: true,
        count: rows.length,
        data: rows,
      });

    } catch (err) {

      console.error(
        "Get Pharmacy Issues Error:",
        err
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to fetch pharmacy issues",
      });
    }
  }
);

/* =========================================================
   UPDATE PHARMACY ISSUE (Receptionist Only)
========================================================= */
router.put(
  "/update/pharmacy/:id",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { role, adminId, id: staffId } = req.user;
      const issueId = req.params.id;

      let { medicine_name, quantity, unit_price } = req.body;

      await conn.beginTransaction();

      /* =========================================================
         GET EXISTING ISSUE (LOCK)
      ========================================================= */
      const [[issue]] = await conn.query(
        `SELECT * 
         FROM ipd_pharmacy_issues 
         WHERE id = ? 
         FOR UPDATE`,
        [issueId]
      );

      if (!issue) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "Issue not found",
        });
      }

      if (issue.admin_id !== adminId) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      /* =========================================================
         GET STAFF
      ========================================================= */
      const [[staff]] = await conn.query(
        `SELECT branch, role, status
         FROM staff
         WHERE id = ?
           AND admin_id = ?
           AND status = 1`,
        [staffId, adminId]
      );

      if (!staff) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Invalid staff",
        });
      }

      /* =========================================================
         VALIDATE IPD (LOCK)
      ========================================================= */
      const [[ipd]] = await conn.query(
        `SELECT 
            id,
            status,
            branch_name,
            doctor_id
         FROM ipd_admissions
         WHERE id = ?
           AND admin_id = ?
         FOR UPDATE`,
        [issue.ipd_id, adminId]
      );

      if (!ipd) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      /* =========================================================
         DOCTOR PATIENT CHECK
      ========================================================= */
      if (role === "doctor" && ipd.doctor_id !== staffId) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Access denied: Not your patient",
        });
      }

      /* =========================================================
         BRANCH CHECK
      ========================================================= */
      if (
        !ipd.branch_name ||
        !staff.branch ||
        ipd.branch_name.trim().toLowerCase() !==
          staff.branch.trim().toLowerCase()
      ) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Access denied: Different branch",
        });
      }

      /* =========================================================
         STATUS CHECK
      ========================================================= */
      if (ipd.status !== "admitted") {
        await conn.rollback();

        return res.status(400).json({
          success: false,
          message: "Only active (admitted) IPD allowed",
        });
      }

      /* =========================================================
         BED CHECK
      ========================================================= */
      const [[bed]] = await conn.query(
        `SELECT id
         FROM ipd_bed_allocations
         WHERE ipd_id = ?
           AND admin_id = ?
           AND allocation_status = 'active'
           AND end_time IS NULL
         FOR UPDATE`,
        [issue.ipd_id, adminId]
      );

      if (!bed) {
        await conn.rollback();

        return res.status(400).json({
          success: false,
          message: "No active bed allocation found",
        });
      }

      /* =========================================================
         PREPARE UPDATE
      ========================================================= */
      let fields = [];
      let values = [];

      /* ================= MEDICINE ================= */
      if (medicine_name !== undefined) {
        medicine_name = medicine_name
          .trim()
          .replace(/\s+/g, " ")
          .toLowerCase();

        if (!medicine_name) {
          await conn.rollback();

          return res.status(400).json({
            success: false,
            message: "medicine_name cannot be empty",
          });
        }

        fields.push("medicine_name = ?");
        values.push(medicine_name);
      }

      /* ================= QUANTITY ================= */
      let newQty = issue.quantity;

      if (quantity !== undefined) {
        quantity = Number(quantity);

        if (isNaN(quantity) || quantity <= 0) {
          await conn.rollback();

          return res.status(400).json({
            success: false,
            message: "quantity must be greater than 0",
          });
        }

        newQty = quantity;

        fields.push("quantity = ?");
        values.push(quantity);
      }

      /* ================= UNIT PRICE ================= */
      let newPrice = issue.unit_price;

      if (unit_price !== undefined) {
        unit_price = Number(unit_price);

        if (isNaN(unit_price) || unit_price < 0) {
          await conn.rollback();

          return res.status(400).json({
            success: false,
            message: "unit_price cannot be negative",
          });
        }

        newPrice = unit_price;

        fields.push("unit_price = ?");
        values.push(unit_price);
      }

      /* ================= TOTAL PRICE ================= */
      const newTotal = newQty * newPrice;

      if (
        quantity !== undefined ||
        unit_price !== undefined
      ) {
        fields.push("total_price = ?");
        values.push(newTotal);
      }

      /* ================= NO CHANGE ================= */
      if (fields.length === 0) {
        await conn.rollback();

        return res.status(400).json({
          success: false,
          message: "No changes detected",
        });
      }

      /* ================= UPDATED AT ================= */
      fields.push("updated_at = CURRENT_TIMESTAMP");

      /* =========================================================
         UPDATE QUERY
      ========================================================= */
      values.push(issueId, adminId);

      await conn.query(
        `UPDATE ipd_pharmacy_issues
         SET ${fields.join(", ")}
         WHERE id = ?
           AND admin_id = ?`,
        values
      );

      await conn.commit();
      await regenerateBill(issue.ipd_id);

      return res.json({
        success: true,
        message: "Pharmacy issue updated successfully",
      });

    } catch (err) {
      await conn.rollback();

      console.error("Update Pharmacy Issue Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to update pharmacy issue",
      });

    } finally {
      conn.release();
    }
  }
);

/* =========================================================
   DELETE (OPTIONAL - remove if not needed)
========================================================= */
router.delete(
  "/delete/pharmacy/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId, id: staffId } = req.user;
      const issueId = req.params.id;

      await conn.beginTransaction();

      /* =========================================================
         GET ISSUE (LOCK)
      ========================================================= */
      const [[issue]] = await conn.query(
        `SELECT * FROM ipd_pharmacy_issues 
         WHERE id = ? FOR UPDATE`,
        [issueId]
      );

      if (!issue) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Pharmacy issue not found",
        });
      }

      /* =========================================================
         ADMIN CHECK
      ========================================================= */
      if (issue.admin_id !== adminId) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      /* =========================================================
         GET STAFF (BRANCH CHECK)
      ========================================================= */
      const [[staff]] = await conn.query(
        `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
        [staffId, adminId]
      );

      if (!staff) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Invalid staff",
        });
      }

      /* =========================================================
         VALIDATE IPD (LOCK)
      ========================================================= */
      const [[ipd]] = await conn.query(
        `SELECT id, status, branch_name 
         FROM ipd_admissions
         WHERE id = ? AND admin_id = ?
         FOR UPDATE`,
        [issue.ipd_id, adminId]
      );

      if (!ipd) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      /* =========================================================
         BRANCH CHECK
      ========================================================= */
    if (
  !staff.branch ||
  !ipd.branch_name ||
  staff.branch.trim().toLowerCase() !==
    ipd.branch_name.trim().toLowerCase()
    ) {
    await conn.rollback();
    return res.status(403).json({
        success: false,
        message: "Access denied: Staff and IPD must belong to same branch",
    });
    }

      /* =========================================================
         STATUS CHECK (STRICT)
      ========================================================= */
      if (ipd.status !== "admitted") {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Cannot delete for non-active IPD",
        });
      }

      /* =========================================================
         BED CHECK
      ========================================================= */
      const [[bed]] = await conn.query(
        `SELECT id FROM ipd_bed_allocations
         WHERE ipd_id = ?
           AND admin_id = ?
           AND allocation_status = 'active'
           AND end_time IS NULL
         FOR UPDATE`,
        [issue.ipd_id, adminId]
      );

      if (!bed) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "No active bed allocation found",
        });
      }

      /* =========================================================
         DELETE
      ========================================================= */
      await conn.query(
        `DELETE FROM ipd_pharmacy_issues 
         WHERE id = ? AND admin_id = ?`,
        [issueId, adminId]
      );

      await conn.commit();
      await regenerateBill(issue.ipd_id);

      return res.json({
        success: true,
        message: "Pharmacy issue deleted successfully",
      });

    } catch (err) {
      await conn.rollback();

      console.error("Delete Pharmacy Issue Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to delete pharmacy issue",
      });
    } finally {
      conn.release();
    }
  }
);

module.exports = router;