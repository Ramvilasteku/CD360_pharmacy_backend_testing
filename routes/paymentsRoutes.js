const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* ===============================
   HELPERS
================================ */
function getAdminId(user) {
  return user.role === "admin" ? user.id : user.adminId;
}

/* =========================================================
   POST PAYMENT (CLIENT ONLY)
========================================================= */
router.post(
  "/create/payments",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const user = req.user;
      const role = user.role; // admin | receptionist
      const adminId = role === "admin" ? user.id : user.adminId;

      const {
        bill_id,
        appointment_id,
        client_id,
        amount,
        transaction_id,
        payment_method,
      } = req.body;

      /* ----------------------------
         VALIDATIONS
      ---------------------------- */
      if (!bill_id)
        return res.status(400).json({ message: "bill_id is required" });

      if (!appointment_id)
        return res.status(400).json({ message: "appointment_id is required" });

      if (!client_id)
        return res.status(400).json({ message: "client_id is required" });

      if (!amount || Number(amount) <= 0)
        return res.status(400).json({ message: "Valid amount required" });

      if (!transaction_id?.trim())
        return res.status(400).json({ message: "transaction_id is required" });

      if (!payment_method?.trim())
        return res.status(400).json({ message: "payment_method is required" });

      /* ----------------------------
   CHECK EXISTING PAYMENT
---------------------------- */
      const [existing] = await db.execute(
        `
  SELECT id
  FROM payments
  WHERE appointment_id = ?
    AND admin_id = ?
  LIMIT 1
  `,
        [appointment_id, adminId]
      );

      if (existing.length) {
        return res.status(409).json({
          message: "Payment already exists for this appointment",
        });
      }

      /* ----------------------------
         VERIFY BILL OWNERSHIP
      ---------------------------- */
      const [bill] = await db.execute(
        `
        SELECT id
        FROM bills
        WHERE id = ?
          AND client_id = ?
          AND admin_id = ?
        `,
        [bill_id, client_id, adminId]
      );

      if (!bill.length) {
        return res.status(403).json({
          message: "Invalid bill for this client",
        });
      }

      /* ----------------------------
         INSERT PAYMENT
      ---------------------------- */
      const [paymentResult] = await db.execute(
        `
        INSERT INTO payments
        (admin_id, bill_id, appointment_id, client_id, amount, transaction_id, payment_method)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          adminId,
          bill_id,
          appointment_id,
          client_id,
          amount,
          transaction_id,
          payment_method,
        ]
      );

      const paymentId = paymentResult.insertId;

      /* ============================
         NOTIFICATION
      ============================ */
      const senderRole = role;
      const senderId = user.id;

      const title = "New Payment Received";
      const message = `₹${amount} received via ${payment_method}`;

      const [notification] = await db.execute(
        `
  INSERT INTO notifications
    (admin_id, sender_role, sender_id, title, message, type)
  VALUES (?, ?, ?, ?, ?, ?)
  `,
        [adminId, senderRole, senderId, title, message, "payment"]
      );

      const notificationId = notification.insertId;

      // Send notification to Admin
      await db.execute(
        `
        INSERT INTO notification_receivers
          (notification_id, receiver_role, receiver_id)
        VALUES (?, 'admin', ?)
        `,
        [notificationId, adminId]
      );

      /* ============================
         SOCKET EVENT
      ============================ */
      if (global.io) {
        global.io.to(adminId.toString()).emit("new_notification", {
          notificationId,
          title,
          message,
          type: "payment",
          sender_role: senderRole,
          sender_id: senderId,
          payment_id: paymentId,
          bill_id,
          appointment_id,
          amount,
          payment_method,
          transaction_id,
          created_at: new Date(),
        });
      }

      /* ----------------------------
         RESPONSE
      ---------------------------- */
      res.status(201).json({
        message: "Payment recorded & notification sent",
      });
    } catch (err) {
      console.error("PAYMENT CREATE ERROR:", err);
      res.status(500).json({
        message: "Payment creation failed",
        err,
      });
    }
  }
);

/* =========================================================
   LIST PAYMENTS (ADMIN / CLIENT)
========================================================= */
router.get(
  "/get/payments",
  authMiddleware,
  allowRoles("admin", "client", "receptionist"),
  async (req, res) => {
    try {
      const user = req.user;
      const adminId = user.role === "admin" ? user.id : user.adminId;

      let sql = `
        SELECT *
        FROM payments
        WHERE admin_id = ?
      `;
      const params = [adminId];

      // Client should see only their payments
      if (user.role === "client") {
        sql += ` AND client_id = ?`;
        params.push(user.id);
      }

      sql += ` ORDER BY payment_date DESC`;

      const [rows] = await db.execute(sql, params);
      res.json(rows);
    } catch (err) {
      console.error("GET PAYMENTS ERROR:", err);
      res.status(500).json({
        message: "Failed to fetch payments",
        err,
      });
    }
  }
);

/* =========================================================
   GET PAYMENTS BY BRANCH (ADMIN)
========================================================= */
router.get(
  "/get/payments/by-branch",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;
      const { branch } = req.query;

      if (!branch) {
        return res.status(400).json({
          message: "branch is required",
        });
      }

      const [rows] = await db.execute(
        `
        SELECT
          p.id,
          p.bill_id,
          p.client_id,
          p.amount,
          p.transaction_id,
          p.payment_method,
          p.payment_date,
          c.name AS client_name,
          c.branch,
          s.name AS staff_name
        FROM payments p
        JOIN clients c
          ON c.id = p.client_id
         AND c.admin_id = p.admin_id
        JOIN staff s
          ON s.branch = c.branch
         AND s.admin_id = p.admin_id
        WHERE p.admin_id = ?
          AND s.branch = ?
        ORDER BY p.payment_date DESC
        `,
        [adminId, branch]
      );

      res.json(rows);
    } catch (err) {
      console.error("PAYMENTS BY BRANCH ERROR:", err);
      res.status(500).json({
        message: "Failed to fetch payments by branch",
      });
    }
  }
);

module.exports = router;
