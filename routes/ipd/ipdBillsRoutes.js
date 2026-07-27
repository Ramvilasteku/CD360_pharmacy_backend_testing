const express = require("express");
const router = express.Router();
const db = require("../../db");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");

async function regenerateBill(ipd_id) {
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    /* 🔥 Totals */
    const [[bed]] = await conn.query(
      `SELECT SUM(charge_amount) total
       FROM ipd_bed_charges
       WHERE ipd_id=?`,
      [ipd_id],
    );

    const [[nursing]] = await conn.query(
      `SELECT SUM(charge_amount) total
       FROM ipd_nursing_charges
       WHERE ipd_id=?`,
      [ipd_id],
    );

    const [[misc]] = await conn.query(
      `SELECT SUM(charge_amount) total
       FROM ipd_miscellaneous_charges
       WHERE ipd_id=?`,
      [ipd_id],
    );

    const [[doctor]] = await conn.query(
      `SELECT SUM(visit_charge) total
       FROM ipd_doctor_visits
       WHERE ipd_id=?`,
      [ipd_id],
    );

    const [[procedure]] = await conn.query(
      `SELECT SUM(procedure_charge) total
       FROM ipd_procedures
       WHERE ipd_id=?`,
      [ipd_id],
    );

    const [[pharmacy]] = await conn.query(
      `SELECT SUM(total_price) total
       FROM ipd_pharmacy_issues
       WHERE ipd_id=?`,
      [ipd_id],
    );

    const [[lab]] = await conn.query(
      `SELECT SUM(test_charge) total
       FROM ipd_lab_tests
       WHERE ipd_id=?`,
      [ipd_id],
    );

    const totals = {
      bed: Number(bed.total || 0),
      nursing: Number(nursing.total || 0),
      misc: Number(misc.total || 0),
      doctor: Number(doctor.total || 0),
      procedure: Number(procedure.total || 0),
      pharmacy: Number(pharmacy.total || 0),
      lab: Number(lab.total || 0),
    };

    const total =
      totals.bed +
      totals.nursing +
      totals.misc +
      totals.doctor +
      totals.procedure +
      totals.pharmacy +
      totals.lab;

    /* 🔍 Existing Bill */
   const [[bill]] = await conn.query(
      `SELECT id, discount, gst_percentage, paid_amount
       FROM ipd_bills
       WHERE ipd_id=?`,
      [ipd_id],
    );

    // No bill created yet → nothing to update
    if (!bill) {
      await conn.commit();
      return false;
    }

    const discountPercent = Number(bill.discount || 0);
    const gstPercent = Number(bill.gst_percentage || 18);
    const paid = Number(bill.paid_amount || 0);

    const discount_amount = total * discountPercent / 100;
    const taxable_amount = total - discount_amount;
    const gst_amount = taxable_amount * gstPercent / 100;
    const grand_total = taxable_amount + gst_amount;
    const balance = grand_total - paid;

    let status = "pending";

    if (paid > 0 && balance > 0) {
      status = "partial";
    }

    if (balance <= 0) {
      status = "paid";
    }

    const billData = {
      summary: {
        ...totals,
        total,
        discount_percent: discountPercent,
        discount_amount,
        taxable_amount,
        gst_percent: gstPercent,
        gst_amount,
        grand_total,
        paid,
        balance,
      },
    };

    await conn.query(
      `UPDATE ipd_bills
       SET
         total_amount = ?,
         taxable_amount = ?,
         grand_total = ?,
         balance_amount = ?,
         bill_status = ?,
         bill_data = ?
       WHERE ipd_id = ?`,
      [total, taxable_amount, grand_total, balance, status, JSON.stringify(billData), ipd_id],
    );

    await conn.commit();

    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* =========================================================
   CREATE BILL (Receptionist Only)
========================================================= */
/* =========================================================
   CREATE BILL (Admin + Receptionist)
========================================================= */
router.post(
  "/post/bills",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { role, id, adminId } = req.user;

      const finalAdminId = role === "admin" ? id : adminId;
      const staffId = role === "receptionist" ? id : null;

      let { ipd_id, discount = 0 } = req.body;

      /* =========================================================
         BASIC VALIDATION
      ========================================================= */
      if (!ipd_id) {
        return res.status(400).json({
          success: false,
          message: "ipd_id is required",
        });
      }

      discount = Number(discount);

      if (isNaN(discount) || discount < 0 || discount > 100) {
        return res.status(400).json({
          success: false,
          message: "Invalid discount — must be a percentage between 0 and 100",
        });
      }

      await conn.beginTransaction();

      /* =========================================================
         STAFF CHECK (RECEPTIONIST ONLY)
      ========================================================= */
      let userBranch = null;

      if (role === "receptionist") {
        const [[staff]] = await conn.query(
          `SELECT branch FROM staff WHERE id=? AND admin_id=?`,
          [staffId, finalAdminId],
        );

        if (!staff) {
          await conn.rollback();
          return res.status(403).json({
            success: false,
            message: "Invalid staff",
          });
        }

        userBranch = staff.branch;
      }

      /* =========================================================
         VALIDATE IPD
      ========================================================= */
      const [[ipd]] = await conn.query(
        `SELECT id, admin_id, status, branch_name
         FROM ipd_admissions
         WHERE id=? AND admin_id=? FOR UPDATE`,
        [ipd_id, finalAdminId],
      );

      if (!ipd) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      if (ipd.admin_id !== finalAdminId) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      /* =========================================================
         BRANCH CHECK
      ========================================================= */
      if (role === "receptionist") {
        if (
          (ipd.branch_name || "").trim().toLowerCase() !==
          (userBranch || "").trim().toLowerCase()
        ) {
          await conn.rollback();
          return res.status(403).json({
            success: false,
            message: "Different branch access denied",
          });
        }
      }

      /* =========================================================
         STATUS CHECK
      ========================================================= */
      if (ipd.status !== "admitted") {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "IPD not active",
        });
      }

      /* =========================================================
         BED CHECK
      ========================================================= */
      const [[bed]] = await conn.query(
        `SELECT id FROM ipd_bed_allocations
         WHERE ipd_id=? AND admin_id=? 
         AND allocation_status='active' AND end_time IS NULL
         FOR UPDATE`,
        [ipd_id, finalAdminId],
      );

      if (!bed) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "No active bed allocation",
        });
      }

      /* =========================================================
         ACTIVE BILL CHECK
      ========================================================= */
      const [[exists]] = await conn.query(
        `SELECT id FROM ipd_bills 
         WHERE ipd_id=? AND bill_status!='paid'`,
        [ipd_id],
      );

      if (exists) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Active bill already exists",
        });
      }

      /* =========================================================
         🔥 FETCH ALL CHARGES
      ========================================================= */
      const [bedCharges] = await conn.query(
        `SELECT * FROM ipd_bed_charges WHERE ipd_id=?`,
        [ipd_id],
      );

      const [pharmacy] = await conn.query(
        `SELECT * FROM ipd_pharmacy_issues WHERE ipd_id=?`,
        [ipd_id],
      );

      const [lab] = await conn.query(
        `SELECT * FROM ipd_lab_tests WHERE ipd_id=?`,
        [ipd_id],
      );

      const [doctor] = await conn.query(
        `SELECT * FROM ipd_doctor_visits WHERE ipd_id=?`,
        [ipd_id],
      );

      const [procedures] = await conn.query(
        `SELECT * FROM ipd_procedures WHERE ipd_id=?`,
        [ipd_id],
      );

      const [nursing] = await conn.query(
        `SELECT * FROM ipd_nursing_charges WHERE ipd_id=?`,
        [ipd_id],
      );

      const [misc] = await conn.query(
        `SELECT * FROM ipd_miscellaneous_charges WHERE ipd_id=?`,
        [ipd_id],
      );

      /* =========================================================
         🔥 CALCULATE TOTALS
      ========================================================= */
      const sum = (arr, key) =>
        arr.reduce((a, b) => a + Number(b[key] || 0), 0);

      const totals = {
        bed_total: sum(bedCharges, "charge_amount"),
        pharmacy_total: sum(pharmacy, "total_price"),
        lab_total: sum(lab, "test_charge"),
        doctor_total: sum(doctor, "visit_charge"),
        procedure_total: sum(procedures, "procedure_charge"),
        nursing_total: sum(nursing, "charge_amount"),
        misc_total: sum(misc, "charge_amount"),
      };

      const total_amount = Object.values(totals).reduce((a, b) => a + b, 0);

      const gst_percentage = 18; // matches column default; change if you take it from req.body
      const discount_amount = total_amount * discount / 100;
      const taxable_amount = total_amount - discount_amount;
      const gst_amount = taxable_amount * gst_percentage / 100;
      const grand_total = taxable_amount + gst_amount;
      const balance_amount = grand_total;

      /* =========================================================
         🔥 BUILD JSON
      ========================================================= */
      const bill_data = {
        bed_charges: bedCharges,
        pharmacy,
        lab_tests: lab,
        doctor_visits: doctor,
        procedures,
        nursing_charges: nursing,
        misc_charges: misc,
        totals,
      };

      /* =========================================================
         🚀 INSERT BILL
      ========================================================= */
      const [result] = await conn.query(
        `INSERT INTO ipd_bills
         (admin_id, ipd_id, discount, gst_percentage, total_amount, taxable_amount, grand_total, balance_amount, bill_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          finalAdminId,
          ipd_id,
          discount,
          gst_percentage,
          total_amount,
          taxable_amount,
          grand_total,
          balance_amount,
          JSON.stringify(bill_data),
        ],
      );

      await conn.commit();

      return res.status(201).json({
        success: true,
        message: "Bill created successfully",
        bill_id: result.insertId,
        total_amount,
        balance_amount,
      });
    } catch (err) {
      await conn.rollback();

      console.error("CREATE BILL ERROR:", err);

      return res.status(500).json({
        success: false,
        message: "Server error",
      });
    } finally {
      conn.release();
    }
  },
);

/* =========================================================
   GET BILL (Admin + Receptionist + Patient)
========================================================= */
router.get(
  "/getall/bills",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;
      const { ipd_id } = req.query;

      const { bill_id, date, from_date, to_date, branch } = req.query;

      let query = `SELECT * FROM ipd_bills WHERE 1=1`;
      let params = [];

      /* =====================================================
         🔒 ROLE BASED ACCESS
      ===================================================== */
      /* =====================================================
   🔒 ROLE BASED ACCESS
===================================================== */
      let receptionistBranch = null;

      if (role === "admin") {
        query += " AND admin_id=?";
        params.push(id);
      } else if (role === "receptionist") {
        query += " AND admin_id=?";
        params.push(adminId);

        /* =========================================
     GET RECEPTIONIST BRANCH
  ========================================= */
        const [[staff]] = await db.query(
          `SELECT branch
            FROM staff
            WHERE id = ? AND admin_id = ?`,
          [id, adminId],
        );

        if (!staff) {
          return res.status(403).json({
            success: false,
            message: "Invalid staff",
          });
        }

        receptionistBranch = (staff.branch || "").trim().toLowerCase();

        /* =========================================
     FILTER ONLY SAME BRANCH IPDs
  ========================================= */
        query += ` AND ipd_id IN (
    SELECT id
    FROM ipd_admissions
    WHERE LOWER(TRIM(branch_name)) = ?
  )`;

        params.push(receptionistBranch);
      } else if (role === "client") {
        query += ` AND ipd_id IN (
    SELECT id
    FROM ipd_admissions
    WHERE client_id=?
  )`;

        params.push(id);
      }

      /* =====================================================
         🔍 FILTER: IPD ID (optional now)
      ===================================================== */
      if (ipd_id) {
      query += `
        AND ipd_id IN (
          SELECT id
          FROM ipd_admissions
          WHERE id = ?
          AND status = 'admitted'
        )
      `;
      params.push(ipd_id);
      }

      /* =====================================================
         🔍 FILTER: BILL ID (MAIN CHANGE)
         Works independently
      ===================================================== */
      if (bill_id) {
        query += " AND id=?";
        params.push(bill_id);
      }

      /* =====================================================
         🔍 FILTER: DATE
      ===================================================== */
      if (date) {
        query += " AND DATE(created_at)=?";
        params.push(date);
      }

      /* =====================================================
         🔍 FILTER: DATE RANGE
      ===================================================== */
      if (from_date && to_date) {
        query += " AND DATE(created_at) BETWEEN ? AND ?";
        params.push(from_date, to_date);
      }

      /* =====================================================
         🔍 FILTER: BRANCH
      ===================================================== */
      if (branch) {
        query += ` AND ipd_id IN (
          SELECT id FROM ipd_admissions 
          WHERE LOWER(branch_name)=LOWER(?)
        )`;
        params.push(branch);
      }

      /* =====================================================
         🔥 DEFAULT: TODAY FILTER
         Only if NO filters passed
      ===================================================== */
      if (!bill_id && !ipd_id && !date && !from_date && !to_date && !branch) {
        // query += " AND DATE(created_at)=CURDATE()";
      }

      const [bills] = await db.query(query, params);

      if (!bills.length) {
        return res.json({
          success: true,
          count: 0,
          data: [],
        });
      }

      /* =====================================================
         🔥 FETCH CHARGES
      ===================================================== */
      const result = [];

      for (const bill of bills) {
        const [bedCharges] = await db.query(
          `SELECT * FROM ipd_bed_charges WHERE ipd_id=?`,
          [bill.ipd_id],
        );

        const [pharmacy] = await db.query(
          `SELECT * FROM ipd_pharmacy_issues WHERE ipd_id=?`,
          [bill.ipd_id],
        );

        const [lab] = await db.query(
          `SELECT * FROM ipd_lab_tests WHERE ipd_id=?`,
          [bill.ipd_id],
        );

        const [doctor] = await db.query(
          `SELECT * FROM ipd_doctor_visits WHERE ipd_id=?`,
          [bill.ipd_id],
        );

        const [procedures] = await db.query(
          `SELECT * FROM ipd_procedures WHERE ipd_id=?`,
          [bill.ipd_id],
        );

        const [nursing] = await db.query(
          `SELECT * FROM ipd_nursing_charges WHERE ipd_id=?`,
          [bill.ipd_id],
        );

        const [misc] = await db.query(
          `SELECT * FROM ipd_miscellaneous_charges WHERE ipd_id=?`,
          [bill.ipd_id],
        );

        const sum = (arr, key) =>
          arr.reduce((a, b) => a + Number(b[key] || 0), 0);

        const totals = {
          bed_total: sum(bedCharges, "charge_amount"),
          pharmacy_total: sum(pharmacy, "total_price"),
          lab_total: sum(lab, "test_charge"),
          doctor_total: sum(doctor, "visit_charge"),
          procedure_total: sum(procedures, "procedure_charge"),
          nursing_total: sum(nursing, "charge_amount"),
          misc_total: sum(misc, "charge_amount"),
        };

      const gross_amount = Object.values(totals).reduce(
        (a, b) => a + b,
        0
      );

      const discount_percent = Number(bill.discount || 0);
      const gst_percentage = Number(bill.gst_percentage || 18);
      const paid_amount = Number(bill.paid_amount || 0);

      const discount_amount = gross_amount * discount_percent / 100;
      const taxable_amount = gross_amount - discount_amount;
      const gst_amount = taxable_amount * gst_percentage / 100;
      const grand_total = taxable_amount + gst_amount;
      const balance_amount = grand_total - paid_amount;

       result.push({
  bill_summary: {
    id: bill.id,
    ipd_id: bill.ipd_id,

    gross_amount,
    total_amount: gross_amount,

    discount_percent,
    discount_amount,

    taxable_amount,
    gst_percentage,
    gst_amount,

    grand_total,
    paid_amount,
    balance_amount,

    bill_status: bill.bill_status,
    created_at: bill.created_at,
  },
  charges: {
    bed_charges: bedCharges,
    pharmacy,
    lab_tests: lab,
    doctor_visits: doctor,
    procedures,
    nursing_charges: nursing,
    misc_charges: misc,
  },
  totals,
});
      }

      return res.json({
        success: true,
        count: result.length,
        data: result,
      });
    } catch (err) {
      console.error("GET BILL ERROR:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch bill",
      });
    }
  },
);

/* =========================================================
   UPDATE DISCOUNT (Receptionist Only)
========================================================= */
router.put(
  "/update/discount/:ipd_id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId, id: staffId } = req.user;
      const { discount } = req.body;
      const { ipd_id } = req.params;

      if (discount === undefined || isNaN(discount) || discount < 0 || discount > 100) {
        return res.status(400).json({
          success: false,
          message: "Invalid discount — must be a percentage between 0 and 100",
        });
      }

      await conn.beginTransaction();

      /* =========================================
         🔒 GET STAFF (BRANCH CHECK)
      ========================================= */
      const [[staff]] = await conn.query(
        `SELECT branch FROM staff WHERE id=? AND admin_id=?`,
        [staffId, adminId],
      );

      if (!staff) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Invalid staff",
        });
      }

      /* =========================================
         🔒 GET BILL
      ========================================= */
      const [[bill]] = await conn.query(
        `SELECT * FROM ipd_bills WHERE ipd_id=? AND admin_id=? FOR UPDATE`,
        [ipd_id, adminId],
      );

      if (!bill) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Bill not found",
        });
      }

      /* =========================================
         🔒 GET IPD (BRANCH VALIDATION)
      ========================================= */
      const [[ipd]] = await conn.query(
        `SELECT branch_name FROM ipd_admissions WHERE id=?`,
        [ipd_id],
      );

      if (!ipd) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      if (
        (ipd.branch_name || "").trim().toLowerCase() !==
        (staff.branch || "").trim().toLowerCase()
      ) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Branch access denied",
        });
      }

      const total = Number(bill.total_amount);
      const gstPercent = Number(bill.gst_percentage || 18);

      /* =========================================
         🔄 RECALCULATE
      ========================================= */
      const paid = Number(bill.paid_amount);
      const discount_amount = total * discount / 100;
      const taxable_amount = total - discount_amount;
      const gst_amount = taxable_amount * gstPercent / 100;
      const grand_total = taxable_amount + gst_amount;
      const balance = grand_total - paid;

      let status = "pending";
      if (paid > 0 && balance > 0) status = "partial";
      if (balance <= 0) status = "paid";

      /* =========================================
         🚀 UPDATE
      ========================================= */
      await conn.query(
        `UPDATE ipd_bills 
         SET discount=?, taxable_amount=?, grand_total=?, balance_amount=?, bill_status=? 
         WHERE ipd_id=?`,
        [discount, taxable_amount, grand_total, balance, status, ipd_id],
      );

      await conn.commit();

      return res.json({
        success: true,
        message: "Discount updated successfully",
        new_balance: balance,
        status,
      });
    } catch (err) {
      await conn.rollback();
      console.error("DISCOUNT ERROR:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to update discount",
      });
    } finally {
      conn.release();
    }
  },
);

/* =========================================================
   ADD PAYMENT (Receptionist Only)
========================================================= */
router.put(
  "/update/pay/:ipd_id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ message: "Invalid amount" });
      }

      await conn.beginTransaction();

      const [[bill]] = await conn.query(
        `SELECT * FROM ipd_bills WHERE ipd_id=? FOR UPDATE`,
        [req.params.ipd_id],
      );

      if (!bill) {
        await conn.rollback();
        return res.status(404).json({ message: "Bill not found" });
      }

     const newPaid = Number(bill.paid_amount) + Number(amount);
      const grand_total = Number(bill.grand_total) || (Number(bill.total_amount) - Number(bill.discount));
      const balance = grand_total - newPaid;

      let status = "pending";
      if (newPaid > 0 && balance > 0) status = "partial";
      if (balance <= 0) status = "paid";

      await conn.query(
        `UPDATE ipd_bills
         SET paid_amount=?, balance_amount=?, bill_status=?
         WHERE ipd_id=?`,
        [newPaid, balance, status, req.params.ipd_id],
      );

      await conn.commit();

      res.json({ success: true, message: "Payment added" });
    } catch (err) {
      await conn.rollback();
      res.status(500).json({ success: false });
    } finally {
      conn.release();
    }
  },
);

/* =========================================================
   GENERATE BILL (Receptionist Only)
========================================================= */
// router.post(
//   "/generate/:ipd_id",
//   authMiddleware,
//   allowRoles("receptionist"),
//   async (req, res) => {
//     const conn = await db.getConnection();

//     try {
//       const { ipd_id } = req.params;

//       await conn.beginTransaction();

//       /* 🔥 Totals */
//       const [[bed]] = await conn.query(
//         `SELECT SUM(charge_amount) total FROM ipd_bed_charges WHERE ipd_id=?`,
//         [ipd_id]
//       );

//       const [[nursing]] = await conn.query(
//         `SELECT SUM(charge_amount) total FROM ipd_nursing_charges WHERE ipd_id=?`,
//         [ipd_id]
//       );

//       const [[misc]] = await conn.query(
//         `SELECT SUM(charge_amount) total FROM ipd_miscellaneous_charges WHERE ipd_id=?`,
//         [ipd_id]
//       );

//       const [[doctor]] = await conn.query(
//         `SELECT SUM(visit_charge) total FROM ipd_doctor_visits WHERE ipd_id=?`,
//         [ipd_id]
//       );

//       const [[procedure]] = await conn.query(
//         `SELECT SUM(procedure_charge) total FROM ipd_procedures WHERE ipd_id=?`,
//         [ipd_id]
//       );

//       const [[pharmacy]] = await conn.query(
//         `SELECT SUM(total_price) total FROM ipd_pharmacy_issues WHERE ipd_id=?`,
//         [ipd_id]
//       );

//       const totals = {
//         bed: bed.total || 0,
//         nursing: nursing.total || 0,
//         misc: misc.total || 0,
//         doctor: doctor.total || 0,
//         procedure: procedure.total || 0,
//         pharmacy: pharmacy.total || 0,
//       };

//       const total =
//         totals.bed +
//         totals.nursing +
//         totals.misc +
//         totals.doctor +
//         totals.procedure +
//         totals.pharmacy;

//       const [[bill]] = await conn.query(
//         `SELECT discount, paid_amount FROM ipd_bills WHERE ipd_id=?`,
//         [ipd_id]
//       );

//       if (!bill) {
//         await conn.rollback();
//         return res.status(404).json({ message: "Bill not created yet" });
//       }

//       const discount = bill.discount || 0;
//       const paid = bill.paid_amount || 0;
//       const balance = total - discount - paid;

//       let status = "pending";
//       if (paid > 0 && balance > 0) status = "partial";
//       if (balance <= 0) status = "paid";

//       const billData = {
//         summary: {
//           ...totals,
//           total,
//           discount,
//           paid,
//           balance,
//         },
//       };

//       await conn.query(
//         `UPDATE ipd_bills SET
//           total_amount=?,
//           bed_total=?,
//           nursing_total=?,
//           misc_total=?,
//           doctor_visit_total=?,
//           procedure_total=?,
//           pharmacy_total=?,
//           balance_amount=?,
//           bill_status=?,
//           bill_data=?
//          WHERE ipd_id=?`,
//         [
//           total,
//           totals.bed,
//           totals.nursing,
//           totals.misc,
//           totals.doctor,
//           totals.procedure,
//           totals.pharmacy,
//           balance,
//           status,
//           JSON.stringify(billData),
//           ipd_id,
//         ]
//       );

//       await conn.commit();

//       res.json({
//         success: true,
//         total,
//         balance,
//         status,
//       });

//     } catch (err) {
//       await conn.rollback();
//       console.error("GENERATE BILL ERROR:", err);
//       res.status(500).json({ success: false });
//     } finally {
//       conn.release();
//     }
//   }
// );
/* ═══════════════════════════════════════════════════════════
   FONT SETUP — Auto-download TTF fonts to OS temp dir
   Downloads once, cached on disk, reused across restarts.
═══════════════════════════════════════════════════════════ */
const FONT_CACHE_DIR = path.join(os.tmpdir(), "invoice_fonts");
const FONTS = {
  regular: {
    url: "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf",
    file: path.join(FONT_CACHE_DIR, "NotoSans-Regular.ttf"),
  },
  bold: {
    url: "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans/NotoSans-Bold.ttf",
    file: path.join(FONT_CACHE_DIR, "NotoSans-Bold.ttf"),
  },
};

// Ensure cache dir exists
if (!fs.existsSync(FONT_CACHE_DIR))
  fs.mkdirSync(FONT_CACHE_DIR, { recursive: true });

const ensureFonts = async () => {
  const missing = Object.values(FONTS).filter((f) => !fs.existsSync(f.file));
  if (missing.length === 0) return true; // already cached

  console.log("[invoice-pdf] Downloading fonts to:", FONT_CACHE_DIR);
  try {
    await Promise.all(
      missing.map(async (font) => {
        const response = await axios.get(font.url, {
          responseType: "arraybuffer",
        });
        fs.writeFileSync(font.file, Buffer.from(response.data));
        console.log("[invoice-pdf] Font saved:", font.file);
      }),
    );
    return true;
  } catch (e) {
    console.warn(
      "[invoice-pdf] Font download failed, using Helvetica:",
      e.message,
    );
    return false;
  }
};

const registerFonts = (doc, fontsReady) => {
  if (!fontsReady) return;
  doc.registerFont("AppFont", FONTS.regular.file);
  doc.registerFont("AppFont-Bold", FONTS.bold.file);
};

const F = (ready) => (ready ? "AppFont" : "Helvetica");
const FB = (ready) => (ready ? "AppFont-Bold" : "Helvetica-Bold");
/* ═══════════════════════════════════════════════════════════
   LAYOUT CONSTANTS
═══════════════════════════════════════════════════════════ */
const PAGE_W = 595;
const PAGE_H = 842;
const M = 36;
const CW = PAGE_W - M * 2;
const HEADER_H = 120;
const FOOTER_H = 64;
const ROW_H = 20;
const BODY_TOP = HEADER_H + 14;
const BODY_BTM = PAGE_H - FOOTER_H - 10;

/* ═══════════════════════════════════════════════════════════
   COLOURS
═══════════════════════════════════════════════════════════ */
const C = {
  primary: "#1a3c5e",
  accent: "#2980b9",
  stripe: "#f0f6fb",
  border: "#b8cfe0",
  text: "#1a1a2e",
  muted: "#666",
  white: "#ffffff",
  red: "#c0392b",
  green: "#1e8449",
  orange: "#d35400",
};

/* ═══════════════════════════════════════════════════════════
   FONT REGISTRATION
   Noto Sans supports ₹ and all Indian Unicode glyphs.
   Download: https://fonts.google.com/noto/specimen/Noto+Sans
   Place files at:
     <project_root>/fonts/NotoSans-Regular.ttf
     <project_root>/fonts/NotoSans-Bold.ttf
═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════ */

// ₹ renders correctly with Noto Sans
const fmt = (n) =>
  `Rs. ${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

const fmtDate = (d) => {
  if (!d) return "-";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(d);
  }
};

const cap = (s) =>
  s ? s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "-";

const sumArr = (arr, key) =>
  (arr || []).reduce((a, r) => a + Number(r[key] || 0), 0);

/* ═══════════════════════════════════════════════════════════
   ROUTE: GET /invoice-pdf/:bill_id
═══════════════════════════════════════════════════════════ */
router.get(
  "/get/bill/invoice-pdf/:bill_id",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { bill_id } = req.params;

      /* ────────────────────────────────────────────────────
         1. Bill + Admin
      ──────────────────────────────────────────────────── */
      const [[bill]] = await db.query(
        `SELECT b.*,
                a.name         AS admin_name,
                a.company_name,
                a.company_logo,
                a.address      AS admin_address,
                a.mobile       AS admin_mobile,
                a.email        AS admin_email
         FROM   ipd_bills b
         JOIN   admins    a ON a.id = b.admin_id
         WHERE  b.id = ?`,
        [bill_id],
      );
      if (!bill) return res.status(404).json({ message: "Bill not found" });

      /* ────────────────────────────────────────────────────
         2. IPD Admission + Client
      ──────────────────────────────────────────────────── */
      const [[admissionRow]] = await db
        .query(
          `SELECT ia.id              AS ipd_id,
                ia.admission_date,
                ia.discharge_date,
                ia.admission_reason,
                ia.branch_name,
                ia.status          AS admission_status,
                c.name             AS patient_name,
                c.mobile           AS patient_mobile,
                c.email            AS patient_email,
                c.gender,
                c.dob,
                c.blood_group,
                c.address          AS patient_address
         FROM   ipd_admissions ia
         LEFT JOIN clients c ON c.id = ia.client_id
         WHERE  ia.id = ?`,
          [bill.ipd_id],
        )
        .catch(() => [[null]]);

      const admission = admissionRow || {};

      /* ────────────────────────────────────────────────────
         3. Treating Doctors
      ──────────────────────────────────────────────────── */
      const [doctorRows] = await db
        .query(
          `SELECT s.id            AS doctor_id,
                s.name          AS doctor_name,
                s.qualification AS doctor_qual,
                s.branch        AS doctor_branch,
                ia.admission_date AS first_seen
         FROM   ipd_admissions ia
         JOIN   staff s ON s.id = ia.doctor_id AND s.role = 'doctor'
         WHERE  ia.id = ?

         UNION

         SELECT s.id            AS doctor_id,
                s.name          AS doctor_name,
                s.qualification AS doctor_qual,
                s.branch        AS doctor_branch,
                MIN(dv.visit_date) AS first_seen
         FROM   ipd_doctor_visits dv
         JOIN   staff s ON s.id = dv.doctor_id AND s.role = 'doctor'
         WHERE  dv.ipd_id = ?
         GROUP BY s.id, s.name, s.qualification, s.branch

         ORDER BY first_seen ASC, doctor_name ASC`,
          [bill.ipd_id, bill.ipd_id],
        )
        .catch(() => [[]]);

      const seenDoctorIds = new Set();
      const uniqueDoctorRows = doctorRows.filter((dr) => {
        if (seenDoctorIds.has(dr.doctor_id)) return false;
        seenDoctorIds.add(dr.doctor_id);
        return true;
      });

      const primaryDoctor = uniqueDoctorRows[0] || {};
      const doctorName = primaryDoctor.doctor_name || "";
      const doctorQual = primaryDoctor.doctor_qual || "";

      /* ────────────────────────────────────────────────────
         3b. Receptionist
      ──────────────────────────────────────────────────── */
      let receptionistName = "";
      try {
        const [[receptionistRow]] = await db.query(
          `SELECT s.name FROM staff s
           WHERE s.role = 'receptionist' AND s.admin_id = ? LIMIT 1`,
          [bill.admin_id],
        );
        if (receptionistRow) receptionistName = receptionistRow.name || "";
      } catch (e) {
        console.warn("[invoice-pdf] could not fetch receptionist:", e.message);
      }

      /* ────────────────────────────────────────────────────
         4. Parse bill_data (supports legacy shape A / B / C)
      ──────────────────────────────────────────────────── */
      let bd = {};
      try {
        bd =
          typeof bill.bill_data === "string"
            ? JSON.parse(bill.bill_data)
            : (bill.bill_data ?? {});
      } catch {
        bd = {};
      }

      let charges, totals;
      if (bd?.data?.[0]) {
        charges = bd.data[0].charges ?? {};
        totals = bd.data[0].totals ?? {};
      } else if (bd?.charges) {
        charges = bd.charges;
        totals = bd.totals ?? {};
      } else {
        charges = bd;
        totals = bd.totals ?? {};
      }

      const bedRows = charges.bed_charges || [];
      const pharmRows = charges.pharmacy || [];
      const labRows = charges.lab_tests || [];
      const drRows = charges.doctor_visits || [];
      const procRows = charges.procedures || [];
      const nursRows = charges.nursing_charges || [];
      const miscRows = charges.misc_charges || [];

      console.log("bill_data =", JSON.stringify(charges, null, 2));


      const bedTotal =
        Number(totals.bed_total) || sumArr(bedRows, "charge_amount");
      const pharmTotal =
        Number(totals.pharmacy_total) || sumArr(pharmRows, "total_price");
      const labTotal =
        Number(totals.lab_total) || sumArr(labRows, "test_charge");
      const drTotal =
        Number(totals.doctor_total) || sumArr(drRows, "visit_charge");
      const procTotal =
        Number(totals.procedure_total) || sumArr(procRows, "procedure_charge");
      const nursTotal =
        Number(totals.nursing_total) || sumArr(nursRows, "charge_amount");
      const miscTotal =
        Number(totals.misc_total) || sumArr(miscRows, "charge_amount");

      /* ────────────────────────────────────────────────────
         5. Logo
      ──────────────────────────────────────────────────── */
      let logoBuffer = null;
      if (bill.company_logo) {
        const logoCandidates = [
          path.join(__dirname, "../..", "Images", bill.company_logo),
          path.join(__dirname, "..", "Images", bill.company_logo),
          path.join(process.cwd(), "Images", bill.company_logo),
        ];
        for (const candidate of logoCandidates) {
          try {
            if (fs.existsSync(candidate)) {
              logoBuffer = fs.readFileSync(candidate);
              console.log("[invoice-pdf] logo loaded:", candidate);
              break;
            }
          } catch (e) {
            console.warn(
              "[invoice-pdf] logo candidate failed:",
              candidate,
              e.message,
            );
          }
        }
        if (!logoBuffer) {
          console.warn(
            "[invoice-pdf] logo NOT FOUND. Tried:",
            logoCandidates.join(" | "),
          );
        }
      }
      const hasLogo = !!logoBuffer;

      /* ────────────────────────────────────────────────────
         6. PDF init
      ──────────────────────────────────────────────────── */
      const doc = new PDFDocument({ margin: 0, size: "A4", bufferPages: true });

      // Register Noto Sans fonts
      registerFonts(doc);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename=invoice_${bill.id}.pdf`,
      );
      doc.pipe(res);

      const invoiceNo = `INV-${String(bill.id).padStart(5, "0")}`;
      let Y = BODY_TOP;

      /* ══════════════════════════════════════════════════════
         HEADER (first page only)
      ══════════════════════════════════════════════════════ */
      const drawHeader = () => {
        doc.rect(0, 0, PAGE_W, HEADER_H).fill(C.primary);
        doc.rect(0, HEADER_H - 4, PAGE_W, 4).fill(C.accent);

        let tx = M;
        if (hasLogo) {
          try {
            doc.image(logoBuffer, M, 14, { fit: [56, 56] });
            tx = M + 64;
          } catch (e) {
            console.error("[invoice-pdf] header logo render error:", e.message);
          }
        }
        const LEFT_TEXT_W = 310 - (tx - M);

        doc
          .font(FB())
          .fontSize(13)
          .fillColor(C.white)
          .text(bill.company_name || "Hospital", tx, 16, {
            width: LEFT_TEXT_W,
            lineBreak: false,
          });

        const addrText = (bill.admin_address || "").trim();
        let addrBottomY = 34;
        if (addrText) {
          doc
            .font(F())
            .fontSize(7.5)
            .fillColor("#cde")
            .text(addrText, tx, 34, { width: LEFT_TEXT_W });
          addrBottomY =
            34 + doc.heightOfString(addrText, { width: LEFT_TEXT_W });
        }

        const contact = [bill.admin_mobile, bill.admin_email]
          .filter(Boolean)
          .join("  |  ");
        if (contact) {
          doc
            .font(F())
            .fontSize(7.5)
            .fillColor("#cde")
            .text(contact, tx, addrBottomY + 3, {
              width: LEFT_TEXT_W,
              lineBreak: false,
            });
        }

        const RX = PAGE_W - M - 150;
        doc
          .font(FB())
          .fontSize(22)
          .fillColor(C.white)
          .text("INVOICE", RX, 14, { width: 150, align: "right" });
        doc
          .font(F())
          .fontSize(9)
          .fillColor("#cde")
          .text(invoiceNo, RX, 46, { width: 150, align: "right" })
          .text(`IPD  ID: ${bill.ipd_id}`, RX, 58, {
            width: 150,
            align: "right",
          })
          .text(`Date: ${fmtDate(bill.created_at)}`, RX, 70, {
            width: 150,
            align: "right",
          });

        const badgeColor =
          { paid: C.green, partial: C.orange, pending: C.red }[
            bill.bill_status
          ] || C.muted;
      };

      drawHeader();

      /* ══════════════════════════════════════════════════════
         PAGE BREAK GUARD
      ══════════════════════════════════════════════════════ */
      const ensureSpace = (need) => {
        if (Y + need > BODY_BTM) {
          doc.addPage();
          Y = M + 10;
        }
      };

      /* ══════════════════════════════════════════════════════
         IPD INFO PANEL
      ══════════════════════════════════════════════════════ */
      const drawIpdInfoPanel = () => {
        const HALF = CW / 2;
        const COL_HALF = HALF - 6;
        const LX = M;
        const RX_COL = M + HALF + 6;
        const TITLE_H = 20;

        let ageStr = "-";
        if (admission.dob) {
          const ms = Date.now() - new Date(admission.dob).getTime();
          const yrs = Math.floor(ms / (365.25 * 24 * 3600 * 1000));
          if (!isNaN(yrs) && yrs >= 0) ageStr = `${yrs} yrs`;
        }

        const leftLines = [
          { label: "Patient", value: admission.patient_name || "-" },
          { label: "Mobile", value: admission.patient_mobile || "-" },
          {
            label: "Gender / Age",
            value: `${cap(admission.gender || "-")}  /  ${ageStr}`,
          },
          { label: "Blood Group", value: admission.blood_group || "-" },
          { label: "IPD No.", value: `#${bill.ipd_id}` },
          { label: "Branch", value: admission.branch_name || "-" },
          { label: "Admitted", value: fmtDate(admission.admission_date) },
          { label: "Discharged", value: fmtDate(admission.discharge_date) },
          { label: "Status", value: cap(admission.admission_status || "-") },
          {
            label: "Reason",
            value: (admission.admission_reason || "-").substring(0, 55),
          },
        ];

        const drList =
          uniqueDoctorRows.length > 0
            ? uniqueDoctorRows
            : [{ doctor_name: "-", doctor_qual: "", doctor_branch: "" }];

        const PANEL_H =
          TITLE_H + Math.max(leftLines.length * 16, drList.length * 30) + 14;

        ensureSpace(PANEL_H + 16);

        doc.rect(M, Y, CW, PANEL_H).fill(C.stripe);
        doc
          .rect(M, Y, CW, PANEL_H)
          .strokeColor(C.border)
          .lineWidth(0.5)
          .stroke();

        doc.rect(LX, Y, COL_HALF, TITLE_H).fill(C.accent);
        doc
          .font(FB())
          .fontSize(8.5)
          .fillColor(C.white)
          .text("PATIENT & ADMISSION DETAILS", LX + 8, Y + 5, {
            width: COL_HALF - 10,
            lineBreak: false,
          });

        doc.rect(RX_COL, Y, COL_HALF, TITLE_H).fill(C.primary);
        doc
          .font(FB())
          .fontSize(8.5)
          .fillColor(C.white)
          .text("TREATING DOCTORS", RX_COL + 8, Y + 5, {
            width: COL_HALF - 10,
            lineBreak: false,
          });

        doc
          .moveTo(M + HALF, Y + TITLE_H)
          .lineTo(M + HALF, Y + PANEL_H)
          .strokeColor(C.border)
          .lineWidth(0.5)
          .stroke();

        let lY = Y + TITLE_H + 8;
        leftLines.forEach(({ label, value }) => {
          doc
            .font(FB())
            .fontSize(7.5)
            .fillColor(C.muted)
            .text(label + ":", LX + 8, lY, { width: 78, lineBreak: false });
          doc
            .font(F())
            .fontSize(7.5)
            .fillColor(C.text)
            .text(String(value), LX + 88, lY, {
              width: COL_HALF - 96,
              lineBreak: false,
            });
          lY += 16;
        });

        let rY = Y + TITLE_H + 8;
        drList.forEach((dr, idx) => {
          doc.roundedRect(RX_COL + 8, rY + 2, 15, 15, 3).fill(C.accent);
          doc
            .font(FB())
            .fontSize(7)
            .fillColor(C.white)
            .text(String(idx + 1), RX_COL + 8, rY + 4, {
              width: 15,
              align: "center",
              lineBreak: false,
            });

          doc
            .font(FB())
            .fontSize(9)
            .fillColor(C.primary)
            .text(dr.doctor_name || "-", RX_COL + 28, rY, {
              width: COL_HALF - 36,
              lineBreak: false,
            });

          const sub = [dr.doctor_qual, dr.doctor_branch]
            .filter(Boolean)
            .join("  ·  ");
          if (sub) {
            doc
              .font(F())
              .fontSize(7.5)
              .fillColor(C.muted)
              .text(sub, RX_COL + 28, rY + 12, {
                width: COL_HALF - 36,
                lineBreak: false,
              });
          }

          if (idx < drList.length - 1) {
            doc
              .moveTo(RX_COL + 8, rY + 26)
              .lineTo(RX_COL + COL_HALF - 8, rY + 26)
              .strokeColor(C.border)
              .lineWidth(0.3)
              .stroke();
          }
          rY += 30;
        });

        Y += PANEL_H + 16;
      };

      drawIpdInfoPanel();

      /* ══════════════════════════════════════════════════════
         DRAW TABLE HELPER
      ══════════════════════════════════════════════════════ */
      const drawTable = (title, cols, rows, subT) => {
        if (!rows || rows.length === 0) return;

        ensureSpace(20 + 20 + ROW_H + ROW_H + 16);

        doc.rect(M, Y, CW, 20).fill(C.primary);
        doc
          .font(FB())
          .fontSize(9.5)
          .fillColor(C.white)
          .text(title, M + 8, Y + 5, { width: CW - 16 });
        Y += 20;

        doc.rect(M, Y, CW, 20).fill(C.accent);
        cols.forEach((col) => {
          doc
            .font(FB())
            .fontSize(8)
            .fillColor(C.white)
            .text(col.label, M + col.x, Y + 6, {
              width: col.w,
              align: col.align || "left",
            });
        });
        Y += 20;

        rows.forEach((cells, idx) => {
          ensureSpace(ROW_H + 2);
          doc.rect(M, Y, CW, ROW_H).fill(idx % 2 === 0 ? C.white : C.stripe);
          doc.rect(M, Y, 3, ROW_H).fill(C.accent);
          cells.forEach((val, ci) => {
            const col = cols[ci];
            doc
              .font(F())
              .fontSize(8)
              .fillColor(C.text)
              .text(String(val ?? "-"), M + col.x, Y + 6, {
                width: col.w,
                align: col.align || "left",
                lineBreak: false,
              });
          });
          Y += ROW_H;
        });

        ensureSpace(ROW_H + 16);
        doc.rect(M, Y, CW, ROW_H).fill(C.stripe);
        doc
          .moveTo(M, Y)
          .lineTo(M + CW, Y)
          .strokeColor(C.border)
          .lineWidth(0.5)
          .stroke();
        doc
          .font(FB())
          .fontSize(8.5)
          .fillColor(C.primary)
          .text(`${title} Total`, M + 8, Y + 6, { width: CW * 0.6 })
          .text(fmt(subT), M + 8, Y + 6, { width: CW - 16, align: "right" });
        Y += ROW_H;
        doc
          .moveTo(M, Y)
          .lineTo(M + CW, Y)
          .strokeColor(C.border)
          .lineWidth(0.4)
          .stroke();
        Y += 16;
      };

      /* ══════════════════════════════════════════════════════
         CHARGE TABLES
      ══════════════════════════════════════════════════════ */
      drawTable(
        "Bed Charges",
        [
          { label: "#", x: 4, w: 22, align: "center" },
          { label: "Date", x: 30, w: 74, align: "left" },
          { label: "Type", x: 108, w: 95, align: "left" },
          { label: "Hours Used", x: 207, w: 60, align: "center" },
          { label: "Rate / Day", x: 271, w: 85, align: "right" },
          { label: "Amount", x: 431, w: 88, align: "right" },
        ],
        bedRows.map((b, i) => [
          i + 1,
          fmtDate(b.charge_date),
          cap(b.charge_type),
          `${b.hours_used || 0} hrs`,
          fmt(b.rate_per_day),
          fmt(b.charge_amount),
        ]),
        bedTotal,
      );

      drawTable(
        "Pharmacy",
        [
          { label: "#", x: 4, w: 22, align: "center" },
          { label: "Medicine", x: 30, w: 140, align: "left" },
          { label: "Issue Date", x: 174, w: 80, align: "left" },
          { label: "Qty", x: 258, w: 38, align: "center" },
          { label: "Unit Price", x: 300, w: 85, align: "right" },
          { label: "Total", x: 431, w: 88, align: "right" },
        ],
        pharmRows.map((p, i) => [
          i + 1,
          cap(p.medicine_name),
          fmtDate(p.issue_date),
          p.quantity,
          fmt(p.unit_price),
          fmt(p.total_price),
        ]),
        pharmTotal,
      );

      drawTable(
        "Lab Tests",
        [
          { label: "#", x: 4, w: 22, align: "center" },
          { label: "Test Name", x: 30, w: 200, align: "left" },
          { label: "Date", x: 234, w: 82, align: "left" },
          { label: "Status", x: 320, w: 80, align: "center" },
          { label: "Amount", x: 431, w: 88, align: "right" },
        ],
        labRows.map((l, i) => [
          i + 1,
          l.test_name || "-",
          fmtDate(l.test_date),
          cap(l.result_status || "pending"),
          fmt(l.test_charge ?? 0),
        ]),
        labTotal,
      );

      /* ══════════════════════════════════════════════════════
   DOCTOR VISITS TABLE
══════════════════════════════════════════════════════ */
      drawTable(
        "Doctor Visits",
        [
          { label: "#", x: 4, w: 22, align: "center" },
          { label: "Doctor", x: 30, w: 205, align: "left" },
          { label: "Visit Date", x: 239, w: 88, align: "left" },
          { label: "Visits", x: 331, w: 46, align: "center" },
          { label: "Amount", x: 431, w: 88, align: "right" },
        ],

        await Promise.all(
          drRows.map(async (d, i) => {
            let doctorName = "-";

            try {
              if (d.doctor_id) {
                const [[doctor]] = await db.query(
                  `SELECT name
             FROM staff
             WHERE id = ? AND role = 'doctor'
             LIMIT 1`,
                  [d.doctor_id],
                );

                if (doctor) {
                  doctorName = doctor.name;
                }
              }
            } catch (e) {
              console.error("Doctor fetch error:", e.message);
            }

            return [
              i + 1,
              doctorName,
              fmtDate(d.visit_date || d.charge_date),
              d.visit_count ?? 1,
              fmt(d.visit_charge ?? 0),
            ];
          }),
        ),

        drTotal,
      );
      drawTable(
        "Procedures",
        [
          { label: "#", x: 4, w: 22, align: "center" },
          { label: "Procedure", x: 30, w: 210, align: "left" },
          { label: "Date", x: 244, w: 84, align: "left" },
          { label: "Charge", x: 332, w: 82, align: "right" },
          { label: "Amount", x: 431, w: 88, align: "right" },
        ],
        procRows.map((p, i) => [
          i + 1,
          p.procedure_name || p.description || "-",
          fmtDate(p.procedure_date || p.charge_date),
          fmt(p.procedure_charge ?? 0),
          fmt(p.procedure_charge ?? 0),
        ]),
        procTotal,
      );

      drawTable(
        "Nursing Charges",
        [
          { label: "#", x: 4, w: 22, align: "center" },
          { label: "Description", x: 30, w: 282, align: "left" },
          { label: "Date", x: 316, w: 88, align: "left" },
          { label: "Amount", x: 431, w: 88, align: "right" },
        ],
        nursRows.map((n, i) => [
          i + 1,
          n.description || n.service_name || "-",
          fmtDate(n.charge_date),
          fmt(n.charge_amount),
        ]),
        nursTotal,
      );

      drawTable(
        "Miscellaneous Charges",
        [
          { label: "#", x: 4, w: 22, align: "center" },
          { label: "Description", x: 30, w: 282, align: "left" },
          { label: "Date", x: 316, w: 88, align: "left" },
          { label: "Amount", x: 431, w: 88, align: "right" },
        ],
        miscRows.map((m, i) => [
          i + 1,
          m.description || "-",
          fmtDate(m.charge_date),
          fmt(m.charge_amount),
        ]),
        miscTotal,
      );

      /* ══════════════════════════════════════════════════════
         PAYMENT SUMMARY BOX
         Box on RIGHT side of page.
         Label left-aligned + Amount right-aligned, both inside box.
      ══════════════════════════════════════════════════════ */
      const discountPercent = Number(bill.discount || 0);
      const gstPercent = Number(bill.gst_percentage || 18);
      const discountAmount = Number(bill.total_amount) * discountPercent / 100;
      const taxableAmount = Number(bill.total_amount) - discountAmount;
      const gstAmount = taxableAmount * gstPercent / 100;
      const grandTotal = Number(bill.grand_total) || (taxableAmount + gstAmount);

      const summaryRows = [
        { label: "Bed Charges", value: bedTotal, show: bedTotal > 0 },
        { label: "Pharmacy", value: pharmTotal, show: pharmTotal > 0 },
        { label: "Lab Tests", value: labTotal, show: labTotal > 0 },
        { label: "Doctor Visits", value: drTotal, show: drTotal > 0 },
        { label: "Procedures", value: procTotal, show: procTotal > 0 },
        { label: "Nursing", value: nursTotal, show: nursTotal > 0 },
        { label: "Miscellaneous", value: miscTotal, show: miscTotal > 0 },
        { divider: true },
        { label: "Sub Total", value: bill.total_amount, show: true },
        {
          label: `Discount (${discountPercent}%)`,
          value: discountAmount,
          show: discountPercent > 0,
          red: true,
        },
        { label: "Taxable Amount", value: taxableAmount, show: true },
        {
          label: `GST (${gstPercent}%)`,
          value: gstAmount,
          show: gstPercent > 0,
        },
        { label: "Grand Total", value: grandTotal, show: true, bold: true },
        {
          label: "Amount Paid",
          value: bill.paid_amount,
          show: true,
          green: true,
        },
        {
          label: "Balance Due",
          value: bill.balance_amount,
          show: true,
          bold: true,
          red: Number(bill.balance_amount) > 0,
        },
      ].filter((r) => r.divider || r.show);

      const BOX_W = 260;
      const ROW_H2 = 19;
      const BOX_H = summaryRows.length * ROW_H2 + 28;
      const BOX_X = M; // right-aligned on page

      ensureSpace(BOX_H + 70);

      /* Box background + border */
      doc.roundedRect(BOX_X, Y, BOX_W, BOX_H, 5).fill(C.stripe);
      doc
        .roundedRect(BOX_X, Y, BOX_W, BOX_H, 5)
        .strokeColor(C.border)
        .lineWidth(0.5)
        .stroke();

      /* Title bar */
      doc.roundedRect(BOX_X, Y, BOX_W, 22, 5).fill(C.accent);
      doc.rect(BOX_X, Y + 10, BOX_W, 12).fill(C.accent);
      doc
        .font(FB())
        .fontSize(9)
        .fillColor(C.white)
        .text("Payment Summary", BOX_X, Y + 6, {
          width: BOX_W,
          align: "center",
        });

      /* Inner padding constants */
      const LABEL_X = BOX_X + 10;
      const LABEL_W = BOX_W - 20;

      let sy = Y + 28;
      summaryRows.forEach((r) => {
        if (r.divider) {
          doc
            .moveTo(BOX_X + 8, sy + 3)
            .lineTo(BOX_X + BOX_W - 8, sy + 3)
            .strokeColor(C.border)
            .lineWidth(0.6)
            .stroke();
          sy += ROW_H2;
          return;
        }

        const valColor = r.green ? C.green : r.red ? C.red : C.text;
        const fontName = r.bold ? FB() : F();
        const fontSize = r.bold ? 9 : 8.5;
        const labelColor = r.bold ? C.primary : C.muted;

        /* Label — left inside box */
        doc
          .font(fontName)
          .fontSize(fontSize)
          .fillColor(labelColor)
          .text(r.label, LABEL_X, sy, {
            width: LABEL_W,
            align: "left",
            lineBreak: false,
          });

        /* Amount — right inside box */
        doc
          .font(fontName)
          .fontSize(fontSize)
          .fillColor(valColor)
          .text(fmt(r.value), LABEL_X, sy, {
            width: LABEL_W,
            align: "right",
            lineBreak: false,
          });

        sy += ROW_H2;
      });

      Y += BOX_H + 22;

      /* ══════════════════════════════════════════════════════
         NOTE + SIGNATURE BLOCK
      ══════════════════════════════════════════════════════ */
      ensureSpace(55);
      doc
        .font(F())
        .fontSize(8)
        .fillColor(C.muted)
        .text(
          "Note: This is a computer-generated invoice and does not require a physical signature.",
          M,
          Y,
          { width: CW * 0.55 },
        );

      const SIG_X = PAGE_W - M - 200;
      const SIG_W = 200;
      doc
        .moveTo(SIG_X, Y + 46)
        .lineTo(SIG_X + SIG_W, Y + 46)
        .strokeColor(C.border)
        .lineWidth(0.8)
        .stroke();
      doc
        .font(FB())
        .fontSize(8)
        .fillColor(C.primary)
        .text(receptionistName || "Receptionist", SIG_X, Y + 37, {
          width: SIG_W,
          align: "center",
        });

      doc
        .font(F())
        .fontSize(7)
        .fillColor(C.muted)
        .text(" Electronically Signatured", SIG_X, Y + 48, {
          width: SIG_W,
          align: "center",
        });

      /* ══════════════════════════════════════════════════════
         FOOTER — last page only
      ══════════════════════════════════════════════════════ */
      const totalPages = doc.bufferedPageRange().count;
      const F_LOGO_W = 36;
      const F_LEFT_W = 148;
      const F_LEFT_X = M;
      const F_RIGHT_W = 148;
      const F_RIGHT_X = PAGE_W - M - F_RIGHT_W;
      const lastPageIndex = totalPages - 1;

      doc.switchToPage(lastPageIndex);
      const fy = PAGE_H - FOOTER_H;

      doc.rect(0, fy, PAGE_W, FOOTER_H).fill(C.primary);
      doc.rect(0, fy, PAGE_W, 3).fill(C.accent);

      let logoEndX = F_LEFT_X;
      if (hasLogo) {
        try {
          doc.image(logoBuffer, F_LEFT_X, fy + 9, { fit: [30, 30] });
          logoEndX = F_LEFT_X + F_LOGO_W;
        } catch (e) {
          console.error("[invoice-pdf] footer logo render error:", e.message);
        }
      }
      const compW = F_LEFT_W - (logoEndX - F_LEFT_X);
      doc
        .font(FB())
        .fontSize(9)
        .fillColor(C.white)
        .text(bill.company_name || "", logoEndX + 4, fy + 11, {
          width: compW,
          lineBreak: false,
        });
      doc
        .font(F())
        .fontSize(7)
        .fillColor("#cde")
        .text(bill.admin_address || "", logoEndX + 4, fy + 23, {
          width: compW,
          lineBreak: false,
        });

      doc
        .font(F())
        .fontSize(7.5)
        .fillColor("#cde")
        .text(bill.admin_mobile || "", F_RIGHT_X, fy + 9, {
          width: F_RIGHT_W,
          align: "right",
          lineBreak: false,
        })
        .text(bill.admin_email || "", F_RIGHT_X, fy + 21, {
          width: F_RIGHT_W,
          align: "right",
          lineBreak: false,
        });
      doc
        .font(FB())
        .fontSize(7.5)
        .fillColor(C.white)
        .text(
          `Page ${lastPageIndex + 1} of ${totalPages}`,
          F_RIGHT_X,
          fy + 33,
          { width: F_RIGHT_W, align: "right", lineBreak: false },
        );

      const signRuleY = fy + FOOTER_H - 16;
      doc
        .font(F())
        .fontSize(6.5)
        .fillColor("#6fa3c0")
        .text(
          `Electronically generated  ·  ${fmtDate(bill.created_at)}  ·  ${invoiceNo}`,
          M,
          signRuleY + 2,
          { width: CW, align: "center", lineBreak: false },
        );

      doc.end();
    } catch (err) {
      console.error("Invoice PDF error:", err);
      res
        .status(500)
        .json({ message: "PDF generation failed", error: err.message });
    }
  },
);

router.get(
  "/get/ipd-bill/:ipd_id",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const user = req.user;

      const adminId =
        user.role === "admin"
          ? user.id
          : user.adminId;

      const { ipd_id } = req.params;

      /* =========================================
         VALIDATION
      ========================================= */

      if (!ipd_id) {
        return res.status(400).json({
          success: false,
          message: "ipd_id is required",
        });
      }

      /* =========================================
         FETCH BILL
      ========================================= */

      const [rows] = await db.execute(
        `
        SELECT
          b.id AS bill_id,
          b.ipd_id,
          b.total_amount,
          b.discount,
          b.paid_amount,
          b.balance_amount,
          b.bill_status,
          b.created_at,

          a.client_id,
          a.doctor_id,
          a.status AS admission_status

        FROM ipd_bills b

        INNER JOIN ipd_admissions a
          ON a.id = b.ipd_id

        WHERE b.ipd_id = ?
          AND b.admin_id = ?

        ORDER BY b.id DESC
        LIMIT 1
        `,
        [ipd_id, adminId]
      );

      /* =========================================
         NOT FOUND
      ========================================= */

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "No bill found for this IPD",
        });
      }

      /* =========================================
         CLIENT ACCESS CHECK
      ========================================= */

      if (
        user.role === "client" &&
        rows[0].client_id !== user.id
      ) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      /* =========================================
         RESPONSE
      ========================================= */

      return res.status(200).json({
        success: true,
        data: rows[0],
      });

    } catch (err) {
      console.error("GET IPD BILL ERROR:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch bill",
        err,
      });
    }
  }
);

router.put(
  "/update/gst/:ipd_id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId, id: staffId } = req.user;
      const { gst_percentage } = req.body;
      const { ipd_id } = req.params;

      if (
        gst_percentage === undefined ||
        isNaN(gst_percentage) ||
        Number(gst_percentage) < 0 ||
        Number(gst_percentage) > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "GST percentage must be between 0 and 100",
        });
      }

      await conn.beginTransaction();

      const [[staff]] = await conn.query(
        `SELECT branch
         FROM staff
         WHERE id=? AND admin_id=?`,
        [staffId, adminId]
      );

      if (!staff) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Invalid staff",
        });
      }

      const [[bill]] = await conn.query(
        `SELECT id
         FROM ipd_bills
         WHERE ipd_id=? AND admin_id=?`,
        [ipd_id, adminId]
      );

      if (!bill) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Bill not found",
        });
      }

      const [[ipd]] = await conn.query(
        `SELECT branch_name
         FROM ipd_admissions
         WHERE id=?`,
        [ipd_id]
      );

      if (!ipd) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      if (
        (ipd.branch_name || "").trim().toLowerCase() !==
        (staff.branch || "").trim().toLowerCase()
      ) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Branch access denied",
        });
      }

      await conn.query(
        `UPDATE ipd_bills
         SET gst_percentage = ?
         WHERE ipd_id = ?`,
        [Number(gst_percentage), ipd_id]
      );

      await conn.commit();

      // Recalculate bill using new GST %
      await regenerateBill(ipd_id);

      return res.json({
        success: true,
        message: "GST updated successfully",
      });
    } catch (err) {
      await conn.rollback();
      console.error("GST UPDATE ERROR:", err);

      return res.status(500).json({
        success: false,
        message: err.message,
      });
    } finally {
      conn.release();
    }
  }
);

module.exports = {
  router,
  regenerateBill,
};