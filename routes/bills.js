const express = require("express");
const router = express.Router();
const db = require("../db");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles }     = require("../middlewares/roleMiddleware");

const normalizeNumber = (v) => (v !== undefined && v !== null ? Number(v) : null);
const normalizeString = (v) => (typeof v === "string" ? v.trim() : null);
const normalizeLower  = (v) => (typeof v === "string" ? v.trim().toLowerCase() : null);
const resolveAdminId  = (user) => (user.role === "admin" ? user.id : user.adminId);

const safeParse = (value) => {
  if (!value) return [];
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return []; }
  }
  return value;
};

/* =========================================================
   🧾 CREATE BILL
========================================================= */
router.post(
  "/bills",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const receptionistId = req.user.id;
      const adminId        = req.user.adminId;

      let {
        appointment_id,
        prescription_id,
        subtotal,
        tax = 0,
        total_amount,
        notes,
        bill_breakdown_json, // ✅ NEW
      } = req.body;

      appointment_id  = normalizeNumber(appointment_id);
      prescription_id = normalizeNumber(prescription_id);
      subtotal        = normalizeNumber(subtotal);
      tax             = normalizeNumber(tax);
      total_amount    = normalizeNumber(total_amount);
      notes           = normalizeString(notes);

      if (!appointment_id || !subtotal || !total_amount) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields: appointment_id, subtotal, total_amount",
        });
      }

      /* 1️⃣ Validate appointment */
      const [appointments] = await db.query(
        `SELECT id, client_id, status FROM appointments WHERE id = ? AND admin_id = ?`,
        [appointment_id, adminId]
      );

      if (!appointments.length)
        return res.status(404).json({ success: false, message: "Appointment not found" });

      if (appointments[0].status !== "completed")
        return res.status(400).json({
          success: false,
          message: "Bill can only be created after appointment is completed",
        });

      /* 2️⃣ One bill per appointment */
      const [existing] = await db.query(
        `SELECT id FROM bills WHERE appointment_id = ? AND admin_id = ?`,
        [appointment_id, adminId]
      );

      if (existing.length)
        return res.status(409).json({
          success: false,
          message: "A bill already exists for this appointment",
        });

      /* 3️⃣ Validate prescription */
      if (prescription_id) {
        const [rxRows] = await db.query(
          `SELECT id FROM prescriptions WHERE id = ? AND admin_id = ?`,
          [prescription_id, adminId]
        );
        if (!rxRows.length)
          return res.status(404).json({
            success: false,
            message: "Prescription not found or access denied",
          });
      }

      /* 4️⃣ Serialize breakdown JSON */
      const breakdownJson = bill_breakdown_json
        ? JSON.stringify(bill_breakdown_json)
        : null;

      /* 5️⃣ Create bill — ✅ now includes bill_breakdown_json */
      const [result] = await db.query(
        `INSERT INTO bills
           (admin_id, appointment_id, prescription_id, client_id, staff_id,
            subtotal, tax, total_amount, notes, bill_breakdown_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          adminId,
          appointment_id,
          prescription_id || null,
          appointments[0].client_id,
          receptionistId,
          subtotal,
          tax,
          total_amount,
          notes,
          breakdownJson, // ✅
        ]
      );

      const billId = result.insertId;

      /* 6️⃣ Notification */
      const title   = "New Bill Created";
      const message = `Your bill for appointment #${appointment_id} has been generated. Total: ₹${total_amount}.`;

      const [notifResult] = await db.query(
        `INSERT INTO notifications
           (admin_id, sender_role, sender_id, title, message, type, created_at)
         VALUES (?, 'receptionist', ?, ?, ?, 'general', NOW())`,
        [adminId, receptionistId, title, message]
      );

      const notification_id = notifResult.insertId;

      await db.query(
        `INSERT INTO notification_receivers (notification_id, receiver_role, receiver_id, is_read)
         VALUES (?, 'client', ?, 0)`,
        [notification_id, appointments[0].client_id]
      );

      await db.query(
        `INSERT INTO notification_receivers (notification_id, receiver_role, receiver_id, is_read)
         VALUES (?, 'admin', ?, 0)`,
        [notification_id, adminId]
      );

      return res.status(201).json({
        success: true,
        message: "Bill created successfully",
        bill_id: billId,
      });

    } catch (error) {
      console.error("CREATE BILL ERROR:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  }
);

/* =========================================================
   📄 GET ALL BILLS
========================================================= */
router.get(
  "/bills",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { role, id: userId } = req.user;
      const adminId = resolveAdminId(req.user);

      let { client_id, branch, date } = req.query;
      client_id = normalizeNumber(client_id);
      branch    = normalizeLower(branch);
      date      = normalizeString(date);

      let where  = ["b.admin_id = ?"];
      let params = [adminId];

      if (role === "client") { where.push("b.client_id = ?"); params.push(userId); }
      if ((role === "admin" || role === "receptionist") && client_id) {
        where.push("b.client_id = ?"); params.push(client_id);
      }
      if (date)   { where.push("DATE(b.created_at) = ?"); params.push(date); }
      if (branch) { where.push("LOWER(s.branch) = ?");    params.push(branch); }

      const [rows] = await db.query(
        `SELECT
           b.id               AS bill_id,
           b.appointment_id,
           b.prescription_id,
           b.client_id,
           b.staff_id,
           b.subtotal,
           b.tax,
           b.total_amount,
           b.bill_status,
           b.notes,
           b.created_at,
           b.bill_breakdown_json,
           c.name             AS client_name,
           s.name             AS staff_name,
           s.role             AS staff_role,
           s.branch,
           p.consultation_type_json,
           p.medicines_json,
           p.tests_json,
           doc.name           AS doctor_name
         FROM bills b
         JOIN clients c            ON c.id   = b.client_id
         LEFT JOIN staff s         ON s.id   = b.staff_id
         LEFT JOIN prescriptions p ON p.id   = b.prescription_id
         LEFT JOIN staff doc       ON doc.id = p.doctor_id
         WHERE ${where.join(" AND ")}
         ORDER BY b.created_at DESC`,
        params
      );

      const bills = rows.map((row) => ({
        ...row,
        // ✅ Use bill_breakdown_json if available, else fallback to prescription JSON
        bill_breakdown_json:    safeParse(row.bill_breakdown_json) || undefined,
        consultations:          safeParse(row.consultation_type_json),
        medicines:              safeParse(row.medicines_json),
        tests:                  safeParse(row.tests_json),
        consultation_type_json: undefined,
        medicines_json:         undefined,
        tests_json:             undefined,
      }));

      res.status(200).json({ success: true, role, count: bills.length, data: bills });

    } catch (error) {
      console.error("GET BILLS ERROR:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  }
);

/* =========================================================
   📄 GET SINGLE BILL
========================================================= */
router.get(
  "/bills/:id",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { role, id: userId } = req.user;
      const adminId = resolveAdminId(req.user);
      const billId  = Number(req.params.id);

      if (!billId)
        return res.status(400).json({ success: false, message: "Invalid bill ID" });

      let where  = ["b.id = ?", "b.admin_id = ?"];
      let params = [billId, adminId];

      if (role === "client") { where.push("b.client_id = ?"); params.push(userId); }

      const [rows] = await db.query(
        `SELECT
           b.id               AS bill_id,
           b.appointment_id,
           b.prescription_id,
           b.client_id,
           b.staff_id,
           b.subtotal,
           b.tax,
           b.total_amount,
           b.bill_status,
           b.notes,
           b.created_at,
           b.bill_breakdown_json,
           c.name             AS client_name,
           s.name             AS staff_name,
           s.role             AS staff_role,
           s.branch,
           p.consultation_type_json,
           p.medicines_json,
           p.tests_json,
           doc.name           AS doctor_name,
           doc.qualification  AS doctor_qualification
         FROM bills b
         JOIN clients c            ON c.id   = b.client_id
         LEFT JOIN staff s         ON s.id   = b.staff_id
         LEFT JOIN prescriptions p ON p.id   = b.prescription_id
         LEFT JOIN staff doc       ON doc.id = p.doctor_id
         WHERE ${where.join(" AND ")}
         LIMIT 1`,
        params
      );

      if (!rows.length)
        return res.status(404).json({ success: false, message: "Bill not found or access denied" });

      const row  = rows[0];
      const breakdown = safeParse(row.bill_breakdown_json);

      const bill = {
        ...row,
        bill_breakdown_json:    breakdown || undefined,
        // ✅ Prefer breakdown data; fallback to prescription JSON
        consultations: breakdown?.consultations ?? safeParse(row.consultation_type_json),
        medicines:     breakdown?.medicines     ?? safeParse(row.medicines_json),
        tests:         breakdown?.tests         ?? safeParse(row.tests_json),
        consultation_type_json: undefined,
        medicines_json:         undefined,
        tests_json:             undefined,
      };

      return res.status(200).json({ success: true, bill });

    } catch (error) {
      console.error("GET BILL BY ID ERROR:", error);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  }
);

/* ── PUT /bill/bills/:bill_id ─────────────────────────────────────
   Updates subtotal, tax, total_amount, bill_status, notes,
   and bill_breakdown_json.

   Rules:
   • "Paid" bills cannot be edited (keeps financial integrity)
   • bill_status can be changed FROM any non-Paid status
   • Sending bill_status = "Paid" is allowed (marks as paid)
───────────────────────────────────────────────────────────────── */

const VALID_STATUSES = ["Pending", "Paid", "Overdue", "Cancelled"];

router.put(
  "/bills/:bill_id",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const bill_id = Number(req.params.bill_id);
      const adminId = resolveAdminId(req.user);

      const {
        subtotal,
        tax,
        total_amount,
        bill_status,          // ← now accepted from frontend
        notes,
        bill_breakdown_json,
      } = req.body;

      /* ── Validate status value ── */
      if (bill_status && !VALID_STATUSES.includes(bill_status)) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Invalid bill_status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        });
      }

      /* ── Fetch current row ── */
      const [rows] = await connection.query(
        `SELECT bill_status FROM bills WHERE id = ? AND admin_id = ?`,
        [bill_id, adminId]
      );

      if (!rows.length) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: "Bill not found" });
      }

      /* ── Block edits on already-Paid bills ── */
      if (rows[0].bill_status === "Paid") {
        await connection.rollback();
        return res.status(403).json({
          success: false,
          message: "Paid bills cannot be edited",
        });
      }

      /* ── Resolve final status: use submitted value or keep existing ── */
      const resolvedStatus = bill_status || rows[0].bill_status;

      /* ── Update ── */
      await connection.query(
        `UPDATE bills
         SET subtotal            = ?,
             tax                 = ?,
             total_amount        = ?,
             bill_status         = ?,
             notes               = ?,
             bill_breakdown_json = ?
         WHERE id = ? AND admin_id = ?`,
        [
          subtotal,
          tax,
          total_amount,
          resolvedStatus,
          notes || null,
          bill_breakdown_json ? JSON.stringify(bill_breakdown_json) : null,
          bill_id,
          adminId,
        ]
      );

      await connection.commit();
      res.json({
        success: true,
        message: "Bill updated successfully",
        data: { bill_status: resolvedStatus },
      });

    } catch (err) {
      await connection.rollback();
      console.error("UPDATE BILL ERROR:", err);
      res.status(500).json({ success: false, message: "Internal server error" });
    } finally {
      connection.release();
    }
  }
);
/* =========================================================
   🗑️ DELETE BILL
========================================================= */
router.delete(
  "/bills/:bill_id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const bill_id        = Number(req.params.bill_id);
      const receptionistId = req.user.id;
      const adminId        = req.user.adminId;

      if (!bill_id)
        return res.status(400).json({ success: false, message: "Invalid bill ID" });

      const [bills] = await db.query(
        `SELECT id, bill_status FROM bills WHERE id = ? AND admin_id = ?`,
        [bill_id, adminId]
      );

      if (!bills.length)
        return res.status(404).json({ success: false, message: "Bill not found" });

      if (bills[0].bill_status !== "Pending")
        return res.status(403).json({
          success: false,
          message: "Only pending bills can be deleted",
        });

      await db.query(`DELETE FROM bills WHERE id = ? AND admin_id = ?`, [bill_id, adminId]);

      return res.status(200).json({
        success: true,
        message: "Bill deleted successfully",
        bill_id,
      });

    } catch (error) {
      console.error("DELETE BILL ERROR:", error);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  }
);

module.exports = router;