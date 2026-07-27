const express = require("express");
const router = express.Router();
const db = require("../../db");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");

/* =========================================================
   CREATE PAYMENT (Admin + Receptionist)
========================================================= */
router.post(
  "/post/payments",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { role, id, adminId } = req.user;

      const finalAdminId = role === "admin" ? id : adminId;
      const staffId = role === "receptionist" ? id : null;

      let {
        ipd_id,
        bill_id,
        amount,
        payment_method,
        payment_type = "partial",
        transaction_id,
        notes,
        policy_company,
        policy_number,
        claim_amount = 0,
      } = req.body;

      /* ================= VALIDATION ================= */

      if (!ipd_id || !bill_id) {
  return res.status(400).json({
    success: false,
    message: "ipd_id and bill_id are required",
  });
}

if (
  payment_method !== "insurance" &&
  (!amount || amount <= 0)
) {
  return res.status(400).json({
    success: false,
    message: "Invalid amount",
  });
}

if (
  payment_method === "insurance" &&
  (!claim_amount || claim_amount <= 0)
) {
  return res.status(400).json({
    success: false,
    message: "Invalid claim amount",
  });
}

      // if (amount <= 0) {
      //   return res.status(400).json({
      //     success: false,
      //     message: "Invalid amount",
      //   });
      // }

      await conn.beginTransaction();

      /* ================= STAFF CHECK ================= */

      let userBranch = null;

      if (role === "receptionist") {
        const [[staff]] = await conn.query(
          `SELECT branch FROM staff WHERE id=? AND admin_id=?`,
          [staffId, finalAdminId]
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

      /* ================= IPD VALIDATION ================= */

      const [[ipd]] = await conn.query(
        `SELECT id, admin_id, branch_name, status
         FROM ipd_admissions
         WHERE id=? AND admin_id=? FOR UPDATE`,
        [ipd_id, finalAdminId]
      );

      if (!ipd) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      // if (ipd.status !== "admitted") {
      //   await conn.rollback();

      //   return res.status(400).json({
      //     success: false,
      //     message: "IPD not active",
      //   });
      // }

      /* ================= BRANCH CHECK ================= */

      if (role === "receptionist") {
        if (
          (ipd.branch_name || "").trim().toLowerCase() !==
          (userBranch || "").trim().toLowerCase()
        ) {
          await conn.rollback();

          return res.status(403).json({
            success: false,
            message: "Branch access denied",
          });
        }
      }

      /* ================= PAYMENT METHOD CHECK ================= */

     const validMethods = [
        "cash",
        "upi",
        "card",
        "creditcard",
        "debitcard",
        "insurance",
      ];

      if (!validMethods.includes(payment_method)) {
        await conn.rollback();

        return res.status(400).json({
          success: false,
          message: "Invalid payment method",
        });
      }

      /* =====================================================
         INSURANCE FIELD HANDLING
         ===================================================== */

      if (payment_method === "insurance") {

        // required for insurance
        if (!policy_company || !policy_number) {
          await conn.rollback();

          return res.status(400).json({
            success: false,
            message: "Insurance details required",
          });
        }

        // validate claim amount
      if (Number(claim_amount) <= 0){
          await conn.rollback();

          return res.status(400).json({
            success: false,
            message: "Invalid claim amount",
          });
        }

      } else {

        // clear insurance fields automatically
        policy_company = null;
        policy_number = null;
        claim_amount = 0;
      }

      /* ================= BILL CHECK ================= */

      const [[bill]] = await conn.query(
        `SELECT * FROM ipd_bills
         WHERE id=? AND ipd_id=? AND admin_id=? FOR UPDATE`,
        [bill_id, ipd_id, finalAdminId]
      );

      if (!bill) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "Bill not found",
        });
      }

     /* ================= AMOUNT CHECK ================= */

let actualPayment = 0;

if (payment_method === "insurance") {
  actualPayment = Number(claim_amount || 0);
} else {
  actualPayment = Number(amount || 0);
}

const oldPaidAmount = Number(bill.paid_amount || 0);

const grandTotal = Number(bill.grand_total || 0);

const newPaid =
  Number(bill.paid_amount || 0) + actualPayment;

if (newPaid > grandTotal) {
  await conn.rollback();

  return res.status(400).json({
    success: false,
    message: "Payment exceeds remaining balance",
  });
}

const finalPaidAmount = newPaid;
const finalBalance = grandTotal - newPaid;

let status = "pending";

if (finalPaidAmount > 0 && finalBalance > 0) {
  status = "partial";
}

if (finalBalance === 0) {
  status = "paid";
}
else {

  if (newPaid > 0 && finalBalance > 0) {
    status = "partial";
  }

  if (finalBalance === 0) {
    status = "paid";
  }

}
        

      /* ================= RECEIPT ================= */

      const receipt_number = `RCPT-${Date.now()}-${Math.floor(
        Math.random() * 1000
      )}`;

      if (transaction_id) {
        const [[exists]] = await conn.query(
          `SELECT id FROM ipd_payments WHERE transaction_id=?`,
          [transaction_id]
        );

        if (exists) {
          await conn.rollback();

          return res.status(400).json({
            success: false,
            message: "Duplicate transaction",
          });
        }
      }

      /* ================= INSERT PAYMENT ================= */

     /* ================= INSERT PAYMENT ================= */

const storedAmount =
  payment_method === "insurance"
    ? Number(claim_amount)
    : Number(amount);

const [result] = await conn.query(
  `INSERT INTO ipd_payments
  (
    admin_id,
    ipd_id,
    bill_id,
    amount,
    payment_method,
    payment_type,
    transaction_id,
    receipt_number,
    received_by,
    notes,
    policy_company,
    policy_number,
    claim_amount
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    finalAdminId,
    ipd_id,
    bill_id,
    storedAmount,
    payment_method,
    payment_type,
    transaction_id,
    receipt_number,
    staffId,
    notes,
    policy_company,
    policy_number,
    claim_amount,
  ]
);

      /* ================= UPDATE BILL ================= */

    await conn.query(
  `UPDATE ipd_bills
   SET
     paid_amount=?,
     balance_amount=?,
     bill_status=?
   WHERE id=?`,
  [
    finalPaidAmount,
    finalBalance,
    status,
    bill_id,
  ]
);

      await conn.commit();

    return res.status(201).json({
  success: true,
  message: "Payment added successfully",
  payment_id: result.insertId,
  receipt_number,
  paid_amount: finalPaidAmount,
  balance: finalBalance,
  status,
});

    } catch (err) {

      await conn.rollback();

      console.error("CREATE PAYMENT ERROR:", err);

      return res.status(500).json({
        success: false,
        message: "Server error",
      });

    } finally {

      conn.release();
    }
  }
);

/* =========================================================
   GET PAYMENTS
========================================================= */
router.get(
  "/getall/payments",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;
      const { ipd_id, bill_id, date, from_date, to_date } = req.query;

      let query = `
        SELECT
          p.*,
          b.grand_total,
          b.discount,
          b.paid_amount AS bill_paid,
          b.balance_amount,
          b.bill_status,
          i.branch_name,
          c.name AS patient_name
        FROM ipd_payments p
        INNER JOIN ipd_bills b
          ON b.id = p.bill_id
        INNER JOIN ipd_admissions i
          ON i.id = p.ipd_id
        LEFT JOIN clients c
          ON c.id = i.client_id
        WHERE 1=1
      `;

      const params = [];

      /* ================= ROLE FILTER ================= */

      if (role === "admin") {
        query += " AND p.admin_id=?";
        params.push(id);
      }

      if (role === "receptionist") {
        query += " AND p.admin_id=?";
        params.push(adminId);

        const [[staff]] = await db.query(
          `SELECT branch FROM staff WHERE id=?`,
          [id]
        );

        if (staff?.branch) {
          query += " AND i.branch_name=?";
          params.push(staff.branch);
        }
      }

      if (role === "client") {
        query += `
          AND p.ipd_id IN (
            SELECT id
            FROM ipd_admissions
            WHERE client_id=?
          )
        `;
        params.push(id);
      }

      /* ================= FILTERS ================= */

      if (ipd_id) {
        query += " AND p.ipd_id=?";
        params.push(ipd_id);
      }

      if (bill_id) {
        query += " AND p.bill_id=?";
        params.push(bill_id);
      }

      if (date) {
        query += " AND DATE(p.created_at)=?";
        params.push(date);
      }

      if (from_date && to_date) {
        query += " AND DATE(p.created_at) BETWEEN ? AND ?";
        params.push(from_date, to_date);
      }

      query += " ORDER BY p.bill_id ASC, p.id ASC";

      const [payments] = await db.query(query, params);

      const runningPaid = {};
      const billTotals = {};

      const result = payments.map((payment) => {
        const billKey = payment.bill_id;

        if (!runningPaid[billKey]) {
          runningPaid[billKey] = 0;
          billTotals[billKey] = Number(payment.grand_total || 0);
        }

        const paid =
          payment.payment_method === "insurance"
            ? Number(payment.claim_amount || 0)
            : Number(payment.amount || 0);

        runningPaid[billKey] += paid;

        const runningBalance = Math.max(
          0,
          Number(
            (
              billTotals[billKey] - runningPaid[billKey]
            ).toFixed(2)
          )
        );

        return {
          ...payment,

          // Running values after this payment
          paid_till_now: Number(runningPaid[billKey].toFixed(2)),
          running_balance: runningBalance,

          // Current bill values from DB
          current_paid: Number(payment.bill_paid || 0),
          current_balance: Number(payment.balance_amount || 0),
          grand_total: Number(payment.grand_total || 0),
        };
      });

      result.sort((a, b) => b.id - a.id);

      return res.json({
        success: true,
        count: result.length,
        data: result,
      });

    } catch (err) {
      console.error("GET PAYMENTS ERROR:", err);

      return res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

/* =========================================================
   UPDATE PAYMENT
========================================================= */
router.put(
  "/update/payments/:id",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { role, id, adminId } = req.user;
      const paymentId = req.params.id;

      const {
        amount,
        notes,
        payment_method,
        policy_company,
        policy_number,
        claim_amount,
      } = req.body;

      const finalAdminId = role === "admin" ? id : adminId;

      await conn.beginTransaction();

      /* ================= GET PAYMENT ================= */
      const [[payment]] = await conn.query(
        `SELECT * FROM ipd_payments WHERE id=? FOR UPDATE`,
        [paymentId]
      );

      if (!payment) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Payment not found",
        });
      }

      /* ================= ADMIN CHECK ================= */
      if (payment.admin_id !== finalAdminId) {
        await conn.rollback();
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      /* ================= RECEPTIONIST BRANCH CHECK ================= */
      if (role === "receptionist") {
        const [[staff]] = await conn.query(
          `SELECT branch FROM staff WHERE id=? AND admin_id=?`,
          [id, finalAdminId]
        );

        if (!staff) {
          await conn.rollback();
          return res.status(403).json({
            success: false,
            message: "Invalid staff",
          });
        }

        const [[ipd]] = await conn.query(
          `SELECT branch_name FROM ipd_admissions WHERE id=?`,
          [payment.ipd_id]
        );

        if (
        (ipd?.branch_name || "").trim().toLowerCase() !==
        (staff?.branch || "").trim().toLowerCase()
      ) {
          await conn.rollback();
          return res.status(403).json({
            success: false,
            message: "Branch access denied",
          });
        }
      }

      /* ================= GET BILL ================= */
      const [[bill]] = await conn.query(
        `SELECT * FROM ipd_bills WHERE id=? FOR UPDATE`,
        [payment.bill_id]
      );

      if (!bill) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: "Bill not found",
        });
      }

      

      /* ================= VALIDATIONS ================= */

const validMethods = [
  "cash",
  "upi",
  "card",
  "creditcard",
  "debitcard",
  "insurance",
];

if (payment_method && !validMethods.includes(payment_method)) {
  await conn.rollback();

  return res.status(400).json({
    success: false,
    message: "Invalid payment method",
  });
}

const finalMethod =
  payment_method || payment.payment_method;

/* ================= INSURANCE VALIDATION ================= */

let finalPolicyCompany =
  policy_company !== undefined
    ? policy_company
    : payment.policy_company;

let finalPolicyNumber =
  policy_number !== undefined
    ? policy_number
    : payment.policy_number;

let finalClaimAmount =
  claim_amount !== undefined
    ? Number(claim_amount)
    : Number(payment.claim_amount || 0);

if (finalMethod === "insurance") {
  if (!finalPolicyCompany || !finalPolicyNumber) {
    await conn.rollback();

    return res.status(400).json({
      success: false,
      message: "Insurance details required",
    });
  }

  if (finalClaimAmount <= 0) {
    await conn.rollback();

    return res.status(400).json({
      success: false,
      message: "Invalid claim amount",
    });
  }
} else {
  finalPolicyCompany = null;
  finalPolicyNumber = null;
  finalClaimAmount = 0;

  if (
    amount !== undefined &&
    Number(amount) <= 0
  ) {
    await conn.rollback();

    return res.status(400).json({
      success: false,
      message: "Invalid amount",
    });
  }
}

/* ================= RECALCULATE BILL ================= */

const oldActualPayment =
  payment.payment_method === "insurance"
    ? Number(payment.claim_amount || 0)
    : Number(payment.amount || 0);

const finalAmount =
  amount !== undefined
    ? Number(amount)
    : Number(payment.amount || 0);

const newActualPayment =
  finalMethod === "insurance"
    ? finalClaimAmount
    : finalAmount;

const newPaid =
  Number(bill.paid_amount || 0) -
  oldActualPayment +
  newActualPayment;

const balance =
  Number(bill.total_amount || 0) -
  newPaid;

let status = "pending";

if (newPaid > 0 && balance > 0) {
  status = "partial";
}

if (balance <= 0) {
  status = "paid";
}

/* ================= DYNAMIC UPDATE ================= */

let updateFields = [];
let values = [];

if (amount !== undefined) {
  updateFields.push("amount=?");
  values.push(amount);
}

if (notes !== undefined) {
  updateFields.push("notes=?");
  values.push(notes);
}

if (payment_method !== undefined) {
  updateFields.push("payment_method=?");
  values.push(payment_method);
}

/* insurance fields always updated */

updateFields.push("policy_company=?");
values.push(finalPolicyCompany);

updateFields.push("policy_number=?");
values.push(finalPolicyNumber);

updateFields.push("claim_amount=?");
values.push(finalClaimAmount);

if (updateFields.length === 0) {
  await conn.rollback();

  return res.status(400).json({
    success: false,
    message: "No fields to update",
  });
}

values.push(paymentId);

/* ================= UPDATE PAYMENT ================= */

await conn.query(
  `UPDATE ipd_payments
   SET ${updateFields.join(", ")}
   WHERE id=?`,
  values
);

/* ================= UPDATE BILL ================= */

await conn.query(
  `UPDATE ipd_bills
   SET
     paid_amount=?,
     balance_amount=?,
     bill_status=?
   WHERE id=?`,
  [
    newPaid,
    balance,
    status,
    bill.id,
  ]
);

      /* ================= UPDATE BILL ================= */
      await conn.query(
        `UPDATE ipd_bills
         SET paid_amount=?, balance_amount=?, bill_status=?
         WHERE id=?`,
        [newPaid, balance, status, bill.id]
      );

      await conn.commit();

      res.json({
        success: true,
        message: "Payment updated successfully",
        newPaid,
        balance,
        status,
      });

    } catch (err) {
      await conn.rollback();
      console.error("UPDATE PAYMENT ERROR:", err);

      res.status(500).json({
        success: false,
        message: "Server error",
      });

    } finally {
      conn.release();
    }
  }
);


/**
 * GET /get/bill/payment-receipt/:payment_id
 *
 * Generates a clean single-page payment receipt PDF for a specific
 * IPD payment, matching the hospital bill layout shown in the UI mockup.
 *
 * Auth: admin | receptionist | client
 */

router.get(
  "/get/bill/payment-receipt/:payment_id",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { payment_id } = req.params;
      const { role, id, adminId } = req.user;

      /* ----------------------------------------------------------------
         1. Payment + hospital (admin) details
      ---------------------------------------------------------------- */
      const [[payment]] = await db.query(
        `SELECT p.*,
                a.company_name,
                a.company_logo,
                a.address AS admin_address,
                a.mobile  AS admin_mobile,
                a.email   AS admin_email
         FROM   ipd_payments p
         JOIN   admins       a ON a.id = p.admin_id
         WHERE  p.id = ?`,
        [payment_id]
      );
      if (!payment) return res.status(404).json({ message: "Payment not found" });

      /* ----------------------------------------------------------------
         2. Role-based access control
      ---------------------------------------------------------------- */
      if (role === "admin") {
        if (Number(payment.admin_id) !== Number(id)) {
          return res.status(403).json({ message: "Access denied" });
        }
      } else if (role === "receptionist") {
        if (Number(payment.admin_id) !== Number(adminId)) {
          return res.status(403).json({ message: "Access denied" });
        }
        const [[staff]] = await db.query(`SELECT branch FROM staff WHERE id = ?`, [id]);
        if (staff?.branch) {
          const [[admissionCheck]] = await db.query(
            `SELECT branch_name FROM ipd_admissions WHERE id = ?`,
            [String(payment.ipd_id)]
          );
          if (admissionCheck?.branch_name !== staff.branch) {
            return res.status(403).json({ message: "Access denied - branch mismatch" });
          }
        }
      } else if (role === "client") {
        const [[ownerCheck]] = await db.query(
          `SELECT id FROM ipd_admissions WHERE id = ? AND client_id = ?`,
          [String(payment.ipd_id), Number(id)]
        );
        if (!ownerCheck) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      /* ----------------------------------------------------------------
         3. Bill totals
      ---------------------------------------------------------------- */
      const [[bill]] = await db.query(
        `SELECT total_amount, discount, paid_amount, balance_amount, bill_status
         FROM   ipd_bills WHERE id = ?`,
        [payment.bill_id]
      ).catch(() => [[{}]]);
      const b = bill || {};

      /* ----------------------------------------------------------------
         4. Admission + Patient
         FIX: ipd_admissions.id is VARCHAR(20) — cast explicitly
              client_id is INT — joined to clients table directly
      ---------------------------------------------------------------- */
      const [[adm]] = await db.query(
        `SELECT
            ia.id               AS ipd_id,
            ia.client_id,
            ia.doctor_id,
            ia.bed_id,
            ia.branch_name,
            ia.admission_date,
            ia.discharge_date,
            ia.admission_reason,
            ia.status           AS admission_status,

            c.id                AS c_id,
            c.name              AS patient_name,
            c.email             AS patient_email,
            c.mobile            AS patient_mobile,
            c.address           AS patient_address,
            c.gender,
            c.dob,
            c.blood_group,

            bd.bed_number
         FROM   ipd_admissions ia
         LEFT JOIN clients c  ON c.id  = ia.client_id
         LEFT JOIN ipd_beds    bd ON bd.id = ia.bed_id
         WHERE  ia.id = ?`,
        [String(payment.ipd_id)]
      ).catch((e) => {
        console.error("[receipt] admission query error:", e.message);
        return [[{}]];
      });
      const a = adm || {};

      // Debug: log what we got so you can verify in console
      console.log("[receipt] ipd_id used for query:", String(payment.ipd_id));
      console.log("[receipt] admission row:", JSON.stringify({
        ipd_id: a.ipd_id,
        client_id: a.client_id,
        patient_name: a.patient_name,
        patient_mobile: a.patient_mobile,
        bed_number: a.bed_number,
      }));

      /* ----------------------------------------------------------------
         5. Consultant from doctor_id
      ---------------------------------------------------------------- */
      let consultant = "";
      try {
        if (a.doctor_id) {
          const [[dr]] = await db.query(
            `SELECT name, qualification FROM staff WHERE id = ? AND role = 'doctor' LIMIT 1`,
            [a.doctor_id]
          );
          if (dr) {
            consultant = dr.qualification ? `${dr.name} (${dr.qualification})` : dr.name;
          }
        }
      } catch { /* ignore */ }

      /* ----------------------------------------------------------------
         6. Received-by staff name
      ---------------------------------------------------------------- */
      let receivedBy = "";
      if (payment.received_by) {
        try {
          const [[st]] = await db.query(`SELECT name FROM staff WHERE id = ? LIMIT 1`, [payment.received_by]);
          if (st) receivedBy = st.name;
        } catch { /* ignore */ }
      }

      /* ----------------------------------------------------------------
         7. Logo buffer
         FIX: company_logo stores relative path like:
              "companies/admin_132977/admin/logo/filename.png"
              The Images folder sits at the server ROOT, not relative to
              this route file. We use process.cwd() as the primary path.
      ---------------------------------------------------------------- */
      let logoBuffer = null;
      if (payment.company_logo) {
        // Normalise: strip any leading slash or "Images/" prefix already in the value
        const logoRelative = payment.company_logo
          .replace(/^\/+/, "")                   // strip leading slashes
          .replace(/^Images[/\\]/i, "");          // strip "Images/" prefix if stored that way

        const logoCandidates = [
          // ✅ PRIMARY: server root / Images / relative-path
          path.join(process.cwd(), "Images", logoRelative),
          // Fallback: one level up from this route file
          path.join(__dirname, "..", "Images", logoRelative),
          // Fallback: two levels up
          path.join(__dirname, "../..", "Images", logoRelative),
          // Fallback: treat as absolute (if stored as full OS path)
          payment.company_logo,
        ];

        for (const candidate of logoCandidates) {
          try {
            if (fs.existsSync(candidate)) {
              logoBuffer = fs.readFileSync(candidate);
              console.log("[receipt] logo loaded:", candidate);
              break;
            }
          } catch (e) {
            console.warn("[receipt] logo candidate failed:", candidate, e.message);
          }
        }
        if (!logoBuffer) {
          console.warn("[receipt] logo NOT FOUND. Tried:\n", logoCandidates.join("\n "));
        }
      }

      
      const hasLogo = !!logoBuffer;

      /* ----------------------------------------------------------------
         8. Helpers / layout constants
      ---------------------------------------------------------------- */
      const PAGE_W = 595.28;
      const ML     = 45;
      const MR     = 45;
      const CW     = PAGE_W - ML - MR;

      const fmt = (v) =>
        `Rs. ${Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

      const fmtDate = (d) =>
        d ? new Date(d).toLocaleDateString("en-IN",
              { day: "2-digit", month: "short", year: "numeric" }) : "-";

      const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : "-";

      const ageStr = (() => {
        if (!a.dob) return "-";
        const y = Math.floor((Date.now() - new Date(a.dob)) / 3.15576e10);
        return isNaN(y) || y < 0 ? "-" : `${y} yrs`;
      })();

      const F  = "Helvetica";
      const FB = "Helvetica-Bold";

      /* ----------------------------------------------------------------
         9. PDF init
      ---------------------------------------------------------------- */
      const doc = new PDFDocument({ margin: 0, size: "A4", bufferPages: true });
      res.setHeader("Content-Type", "application/pdf");
res.setHeader(
  "Content-Disposition",
  `attachment; filename=IPD_${payment.ipd_id}_Receipt_${payment.receipt_number}.pdf`
);   
doc.pipe(res);

      const hRule = (y, color = "#cccccc", lw = 0.5) =>
        doc.moveTo(ML, y).lineTo(ML + CW, y).strokeColor(color).lineWidth(lw).stroke();

      let Y = 38;

      /* ================================================================
         HEADER
      ================================================================ */
      let textStartX = ML;
      if (hasLogo) {
        try {
          doc.image(logoBuffer, ML, Y, { fit: [52, 52] });
          textStartX = ML + 62;
        } catch (e) {
          console.warn("[receipt] logo render failed:", e.message);
        }
      }

      doc.font(FB).fontSize(20).fillColor("#000000")
         .text(payment.company_name || "Hospital Name", textStartX, Y, { lineBreak: false });

      const contactLines = [
        payment.admin_address || "",
        [payment.admin_mobile, payment.admin_email].filter(Boolean).join("   |   "),
      ].filter(Boolean);

      if (contactLines.length) {
        doc.font(F).fontSize(8.5).fillColor("#444444")
           .text(contactLines.join("\n"), textStartX, Y + 26,
                 { lineBreak: true, width: PAGE_W - textStartX - MR - 160 });
      }

      const RX = PAGE_W - MR - 150;
      doc.font(FB).fontSize(9).fillColor("#000000")
         .text("PAYMENT RECEIPT", RX, Y, { width: 150, align: "right", lineBreak: false });
      doc.font(F).fontSize(8).fillColor("#555555")
         .text(`Receipt No: ${payment.receipt_number}`,          RX, Y + 14, { width: 150, align: "right", lineBreak: false })
         .text(`Admission Date: ${fmtDate(payment.payment_date)}`,  RX, Y + 26, { width: 150, align: "right", lineBreak: false })
         .text(`Admission No: ${payment.ipd_id}`,               RX, Y + 38, { width: 150, align: "right", lineBreak: false });

      Y += hasLogo ? 62 : 54;
      Y += contactLines.length * 12;

      hRule(Y, "#888888", 0.7);
      Y += 12;

      /* ================================================================
         PATIENT INFO — two-column grid
      ================================================================ */
      const HALF   = CW * 0.52;
      const RX_COL = ML + HALF + 12;
      const RW_COL = CW - HALF - 12;
      const INFO_H = 15;

      const leftInfo = [

        { label : "Admission No:",    value: `${payment.ipd_id}` },
        { label: "Patient Name:",    value: a.patient_name    || "-" },
        { label: "Mobile:",          value: a.patient_mobile  || "-" },
        { label: "Address:",         value: a.patient_address || "-" },
        { label: "Doctor:",          value: consultant  || "-" },
       
      ];

      const rightInfo = [
        { label: "Gender:",   value: `${a.gender ? "" + cap(a.gender) : ""}` },
        { label: "Blood Group:",    value: a.blood_group    || "-" },
        // { label: "Hospital No.:",   value: `IPD-${payment.ipd_id}` },
        // { label: "Bed No.:",        value: a.bed_id || (a.bed_id ? `Bed-${a.bed_id}` : "-") },
        { label: "Admission:",      value: fmtDate(a.admission_date) },
        { label: "Discharge:",      value: fmtDate(a.discharge_date) },
        { label: "Mode of Payment:", value: cap(payment.payment_method || "-") },
      ];

     let infoY = Y;
leftInfo.forEach(({ label, value }) => {
  if (!label && !value) {
    infoY += INFO_H;
    return;
  }

  const isAddress = label === "Address:";
  const displayValue = String((value || "").toString().trim() || "-");

  // For address: truncate to fit width instead of wrapping
  const addressMaxChars = 45; // fits within HALF - 116 at fontSize 8.5
  const finalValue = isAddress && displayValue.length > addressMaxChars
    ? displayValue.substring(0, addressMaxChars) + "..."
    : displayValue;

  // ✅ Reset PDFKit cursor BEFORE each text call
  doc.text("", ML, infoY);

  doc.font(FB).fontSize(8.5).fillColor("#000000")
     .text(label, ML, infoY, { width: 110, lineBreak: false });

  doc.font(F).fontSize(8.5).fillColor("#222222")
     .text(finalValue, ML + 112, infoY, {
       width: HALF - 116,
       lineBreak: false,   // ← ALWAYS false, no wrapping
     });

  infoY += INFO_H;
});

let rightY = Y;
rightInfo.forEach(({ label, value }) => {
  // ✅ Reset PDFKit cursor BEFORE each text call
  doc.text("", RX_COL, rightY);

  doc.font(FB).fontSize(8.5).fillColor("#000000")
     .text(label, RX_COL, rightY, { width: 100, lineBreak: false });

  doc.font(F).fontSize(8.5).fillColor("#222222")
     .text(String(value), RX_COL + 102, rightY, { width: RW_COL - 106, lineBreak: false });

  rightY += INFO_H;
});

Y += Math.max(leftInfo.length, rightInfo.length) * INFO_H + 14;

      /* ================================================================
         TABLE — dynamic height, no fixed empty rows
         Columns: SR# | PARTICULARS | RATE | DISCOUNT | AMOUNT
      ================================================================ */
      const COLS = [
        { label: "SR#",         x:   0, w:  30, align: "center" },
        { label: "PARTICULARS", x:  34, w: 226, align: "left"   },
        { label: "RATE",        x: 264, w:  72, align: "right"  },
        { label: "AMOUNT",      x: 416, w:  88, align: "right"  },
      ];

      const HEAD_H     = 20;
      const DATA_ROW_H = 30;

      const payTypeLabel = {
        advance : "Advance Payment",
        partial : "Partial Payment",
        final   : "Final Settlement",
        refund  : "Refund",
      }[payment.payment_type] || "Payment";

      const totalBillAmt  = Number(b.total_amount || 0);
      const totalDiscount = Number(b.discount      || 0);
      const discountShare = totalBillAmt > 0
        ? (Number(payment.amount) / totalBillAmt) * totalDiscount
        : 0;

      // Build only actual data rows — no empty padding
    const isInsurancePayment =
  payment.payment_method?.toLowerCase() === "insurance";

      const tableRows = isInsurancePayment
        ? [{
            sr: 1,
            particulars:
              "Insurance / Med Claim - " +
              (payment.policy_company || "") +
              (payment.policy_number
                ? ` (${payment.policy_number})`
                : ""),
            rate: fmt(payment.claim_amount),
            amount: fmt(payment.claim_amount),
          }]
        : [{
            sr: 1,
            particulars:
              payTypeLabel +
              (payment.notes
                ? " - " + payment.notes.substring(0, 55)
                : ""),
            rate: fmt(payment.amount),
            amount: fmt(payment.amount),
          }];

      const TABLE_TOP = Y;

      // Header row
      doc.rect(ML, Y, CW, HEAD_H).fill("#c8c8c8");
      COLS.forEach((col) => {
        doc.font(FB).fontSize(8.5).fillColor("#000000")
           .text(col.label, ML + col.x, Y + 7, { width: col.w, align: col.align });
      });
      Y += HEAD_H;

      // Data rows — only as many as needed
      tableRows.forEach((row, i) => {
        doc.rect(ML, Y, CW, DATA_ROW_H).fill(i % 2 === 0 ? "#ffffff" : "#f7f7f7");

        // ← only 4 values now, no discount
        [row.sr, row.particulars, row.rate, row.amount].forEach((val, ci) => {
          const col = COLS[ci];
          doc.font(F).fontSize(8).fillColor("#1a1a1a")
            .text(String(val), ML + col.x, Y + 4,
                  { width: col.w, align: col.align, lineBreak: false });
        });

        doc.moveTo(ML, Y + DATA_ROW_H).lineTo(ML + CW, Y + DATA_ROW_H)
          .strokeColor("#dddddd").lineWidth(0.3).stroke();
        Y += DATA_ROW_H;
      });

      // Outer border around entire table (header + data rows only)
      doc.rect(ML, TABLE_TOP, CW, HEAD_H + tableRows.length * DATA_ROW_H)
         .strokeColor("#999999").lineWidth(0.6).stroke();

      Y += 10;

     /* ================================================================
   NOTE (left) + SUMMARY (right)
================================================================ */
const SUM_W     = CW * 0.44;
const SUM_X     = ML + CW - SUM_W;
const SUM_ROW_H = 17;

// Tax from query param — not stored in DB
const taxRate       = parseFloat(req.query.tax_rate || 0);
let displayAmount = Number(payment.amount || 0);

if (payment.payment_type === "insurance") {
  displayAmount = Number(payment.claim_amount || 0);
}
 
const taxAmount     = parseFloat(((displayAmount * taxRate) / 100).toFixed(2));
const grandTotal    = parseFloat((displayAmount + taxAmount).toFixed(2));

// Note text — left side
doc.font(F).fontSize(8).fillColor("#333333")
   .text(
     "If you have any questions regarding this receipt,\nyou can contact us on our given address.",
     ML, Y + 10, { width: CW * 0.50 }
   );

// Summary lines — right side
const summaryLines = [
  { label: "Amount Paid:",        value: fmt(displayAmount)                      },
  ...(taxRate > 0 ? [
    { label: `Tax (${taxRate}%):`, value: fmt(taxAmount)                         },
  ] : []),
  { label: "Total:",              value: fmt(grandTotal), bold: true             },
];

let sy = Y + 4;
summaryLines.forEach(({ label, value, bold }) => {
  doc.font(bold ? FB : F).fontSize(8.5).fillColor(bold ? "#000000" : "#555555")
     .text(label, SUM_X, sy, { width: SUM_W * 0.55, align: "right", lineBreak: false });
  doc.font(bold ? FB : F).fontSize(8.5).fillColor("#000000")
     .text(value, SUM_X + SUM_W * 0.57, sy, { width: SUM_W * 0.43, align: "right", lineBreak: false });
  if (bold) {
    doc.moveTo(SUM_X, sy - 3).lineTo(SUM_X + SUM_W, sy - 3)
       .strokeColor("#999999").lineWidth(0.4).stroke();
  }
  sy += SUM_ROW_H;
});

Y += summaryLines.length * SUM_ROW_H + 20;



// const txLine = [
//   `Receipt No: ${payment.receipt_number}`,
//   `Type: ${cap(payment.payment_type || "-")}`,
//   payment.transaction_id ? `Txn: ${payment.transaction_id}` : null,
//   `Date: ${fmtDate(payment.payment_date)}`,
// ].filter(Boolean).join("    |    ");

// doc.font(F).fontSize(7.5).fillColor("#555555").text(txLine, ML, Y, { width: CW });

// Y += 28;

/* ================================================================
   SIGNATURE
================================================================ */
hRule(Y, "#cccccc", 0.4);
Y += 14;

doc.font(F).fontSize(7.5).fillColor("#777777")
   .text(
     "This is a computer-generated receipt and does not require a physical signature.",
     ML, Y, { width: CW * 0.58 }
   );

const SIG_X2 = PAGE_W - MR - 170;
doc.moveTo(SIG_X2, Y + 28).lineTo(SIG_X2 + 160, Y + 28)
   .strokeColor("#aaaaaa").lineWidth(0.7).stroke();
doc.font(FB).fontSize(8).fillColor("#000000")
   .text(receivedBy || "Authorized Signatory", SIG_X2, Y + 19,
         { width: 160, align: "center", lineBreak: false });
doc.font(F).fontSize(7).fillColor("#888888")
   .text("Digitally Signed", SIG_X2, Y + 31, { width: 160, align: "center" });

Y += 52;

/* ================================================================
   BOTTOM STRIP
================================================================ */
hRule(Y, "#888888", 0.5);
Y += 8;
doc.font(F).fontSize(7).fillColor("#888888")
   .text(
     `${payment.company_name || ""}    |    ${fmtDate(payment.payment_date)}    |    ${payment.receipt_number}`,
     ML, Y, { width: CW, align: "center" }
   );

doc.end();

    } catch (err) {
      console.error("Payment receipt PDF error:", err);
      res.status(500).json({ message: "Receipt generation failed", error: err.message });
    }
  }
);

module.exports = router;