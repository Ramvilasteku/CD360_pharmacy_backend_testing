const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* =========================================================
   🔹 HELPERS (Production-Style)
========================================================= */

const normalizeNumber = (v) =>
  v !== undefined && v !== null ? Number(v) : null;

const normalizeString = (v) =>
  typeof v === "string" ? v.trim() : null;

const normalizeLower = (v) =>
  typeof v === "string" ? v.trim().toLowerCase() : null;

const resolveAdminId = (user) =>
  user.role === "admin" ? user.id : user.adminId;

/* =========================================================
   🧾 CREATE BILL (Receptionist Only)
========================================================= */

router.post(
  "/bills",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const receptionistId = req.user.id;
      const adminId = req.user.adminId;

      let {
        appointment_id,
        subtotal,
        tax = 0,
        total_amount,
        notes
      } = req.body;

      appointment_id = normalizeNumber(appointment_id);
      subtotal = normalizeNumber(subtotal);
      tax = normalizeNumber(tax);
      total_amount = normalizeNumber(total_amount);
      notes = normalizeString(notes);

      if (!appointment_id || !subtotal || !total_amount) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields"
        });
      }

      /* 1️⃣ Validate appointment */
      const [appointments] = await db.query(
        `
        SELECT id, client_id, status
        FROM appointments
        WHERE id = ? AND admin_id = ?
        `,
        [appointment_id, adminId]
      );

      if (!appointments.length) {
        return res.status(404).json({
          success: false,
          message: "Appointment not found"
        });
      }

      if (appointments[0].status !== "completed") {
        return res.status(400).json({
          success: false,
          message: "Bill can be created only after appointment is completed"
        });
      }

      /* 2️⃣ Ensure only one bill per appointment */
      const [existing] = await db.query(
        `SELECT id FROM bills WHERE appointment_id=? AND admin_id=?`,
        [appointment_id, adminId]
      );

      if (existing.length) {
        return res.status(409).json({
          success: false,
          message: "Bill already exists for this appointment"
        });
      }

      /* 3️⃣ Create bill */
      const [result] = await db.query(
        `
        INSERT INTO bills
        (admin_id, appointment_id, client_id, staff_id, subtotal, tax, total_amount, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          adminId,
          appointment_id,
          appointments[0].client_id,
          receptionistId,
          subtotal,
          tax,
          total_amount,
          notes
        ]
      );

      return res.status(201).json({
        success: true,
        message: "Bill created successfully",
        bill_id: result.insertId
      });

    } catch (error) {
      console.error("CREATE BILL ERROR:", error);
      res.status(500).json({ success: false, message: "Internal server error" });
    }
  }
);

/* =========================================================
   📄 GET BILLS (Admin | Receptionist | Client)
========================================================= */

// router.get(
//   "/bills",
//   authMiddleware,
//   allowRoles("admin", "receptionist", "client"),
//   async (req, res) => {
//     try {
//       const { role, id: userId } = req.user;
//       const adminId = resolveAdminId(req.user);

//       let { client_id, branch, date } = req.query;

//       client_id = normalizeNumber(client_id);
//       branch = normalizeLower(branch);
//       date = normalizeString(date);

//       let where = ["b.admin_id = ?"];
//       let params = [adminId];

//       /* 🔐 ROLE RULES */

//       if (role === "client") {
//         where.push("b.client_id = ?");
//         params.push(userId);
//       }

//       if ((role === "admin" || role === "receptionist") && client_id) {
//         where.push("b.client_id = ?");
//         params.push(client_id);
//       }

//       /* 📅 DATE FILTER */
//       if (date) {
//         where.push("DATE(b.created_at) = ?");
//         params.push(date);
//       }

//       /* 🏢 BRANCH FILTER (staff table) */
//       if (branch) {
//         where.push("LOWER(s.branch) = ?");
//         params.push(branch);
//       }

//       const [rows] = await db.query(
//         `
//         SELECT
//           b.id AS bill_id,
//           b.appointment_id,
//           b.client_id,
//           b.staff_id,
//           b.subtotal,
//           b.tax,
//           b.total_amount,
//           b.bill_status,
//           b.notes,
//           b.created_at,

//           c.name AS client_name,
//           s.name AS staff_name,
//           s.role AS staff_role,
//           s.branch

//         FROM bills b
//         JOIN clients c ON c.id = b.client_id
//         LEFT JOIN staff s ON s.id = b.staff_id
//         WHERE ${where.join(" AND ")}
//         ORDER BY b.created_at DESC
//         `,
//         params
//       );

//       res.status(200).json({
//         success: true,
//         role,
//         filters: { client_id, branch, date },
//         count: rows.length,
//         bills: rows
//       });

//     } catch (error) {
//       console.error("GET BILLS ERROR:", error);
//       res.status(500).json({ success: false, message: "Internal server error" });
//     }
//   }
// );


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
      branch = normalizeLower(branch);
      date = normalizeString(date);

      let where = ["b.admin_id = ?"];
      let params = [adminId];

      /* =========================
         🔐 ROLE RULES
      ========================== */

      // 👤 Client: only own bills
      if (role === "client") {
        where.push("b.client_id = ?");
        params.push(userId);
      }

      // 🧾 Admin: optional client filter
      if (role === "admin" && client_id) {
        where.push("b.client_id = ?");
        params.push(client_id);
      }

      /* =========================
         🏢 RECEPTIONIST BRANCH LOCK
      ========================== */

      if (role === "receptionist") {
        const [[rec]] = await db.query(
          `SELECT branch
           FROM staff
           WHERE id = ? AND admin_id = ? AND role = 'receptionist' AND status = 1`,
          [userId, adminId]
        );

        if (!rec || !rec.branch) {
          return res.status(403).json({
            success: false,
            message: "Invalid receptionist branch",
          });
        }

        const recBranch = rec.branch.trim().toLowerCase();

        // 🔒 Force appointment branch match
        where.push("LOWER(a.selected_branch) = ?");
        params.push(recBranch);
      }

      /* =========================
         📅 DATE FILTER
      ========================== */

      if (date) {
        where.push("DATE(b.created_at) = ?");
        params.push(date);
      }

      /* =========================
         🏢 ADMIN BRANCH FILTER
         (admin only)
      ========================== */

      if (role === "admin" && branch) {
        where.push("LOWER(a.selected_branch) = ?");
        params.push(branch);
      }

      /* =========================
         📦 FETCH BILLS
      ========================== */

      const [rows] = await db.query(
        `
        SELECT
          b.id AS bill_id,
          b.appointment_id,
          b.client_id,
          b.staff_id,
          b.subtotal,
          b.tax,
          b.total_amount,
          b.bill_status,
          b.notes,
          b.created_at,

          c.name AS client_name,
          s.name AS staff_name,
          s.role AS staff_role,
          a.selected_branch

        FROM bills b
        JOIN clients c ON c.id = b.client_id
        LEFT JOIN staff s ON s.id = b.staff_id
        JOIN appointments a ON a.id = b.appointment_id

        WHERE ${where.join(" AND ")}
        ORDER BY b.created_at DESC
        `,
        params
      );

      return res.status(200).json({
        success: true,
        role,
        count: rows.length,
        bills: rows,
      });

    } catch (error) {
      console.error("GET BILLS ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);


// GET THE BILLS BY ID (Admin | Receptionist | Client)
router.get(
  "/bills/:id",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { role, id: userId } = req.user;
      const adminId = resolveAdminId(req.user);
      const billId = Number(req.params.id);

      if (!billId) {
        return res.status(400).json({
          success: false,
          message: "Invalid bill ID",
        });
      }

      let where = ["b.id = ?", "b.admin_id = ?"];
      let params = [billId, adminId];

      /* 🔐 CLIENT ACCESS LIMIT */
      if (role === "client") {
        where.push("b.client_id = ?");
        params.push(userId);
      }

      const [rows] = await db.query(
        `
        SELECT
          b.id AS bill_id,
          b.appointment_id,
          b.client_id,
          b.staff_id,
          b.subtotal,
          b.tax,
          b.total_amount,
          b.bill_status,
          b.notes,
          b.created_at,

          c.name AS client_name,
          s.name AS staff_name,
          s.role AS staff_role,
          s.branch

        FROM bills b
        JOIN clients c ON c.id = b.client_id
        LEFT JOIN staff s ON s.id = b.staff_id
        WHERE ${where.join(" AND ")}
        LIMIT 1
        `,
        params
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Bill not found or access denied",
        });
      }

      return res.status(200).json({
        success: true,
        bill: rows[0],
      });
    } catch (error) {
      console.error("GET BILL BY ID ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);


/* =========================================================
   ✏️ UPDATE BILL (Admin | Receptionist)
========================================================= */

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
      const senderRole = req.user.role; // 'admin' or 'receptionist'

      let { subtotal, tax, total_amount, bill_status, notes } = req.body;

      subtotal = normalizeNumber(subtotal);
      tax = normalizeNumber(tax);
      total_amount = normalizeNumber(total_amount);
      bill_status = normalizeString(bill_status);
      notes = normalizeString(notes);

      const [billRows] = await connection.query(
        `SELECT id, client_id FROM bills WHERE id=? AND admin_id=?`,
        [bill_id, adminId]
      );

      if (!billRows.length) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: "Bill not found"
        });
      }

      const clientId = billRows[0].client_id;

      const fields = [];
      const params = [];

      if (subtotal !== null) { fields.push("subtotal=?"); params.push(subtotal); }
      if (tax !== null) { fields.push("tax=?"); params.push(tax); }
      if (total_amount !== null) { fields.push("total_amount=?"); params.push(total_amount); }

      if (bill_status) {
        const allowed = ["Pending", "Paid", "Overdue", "Cancelled"];
        if (!allowed.includes(bill_status)) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: "Invalid bill status"
          });
        }
        fields.push("bill_status=?");
        params.push(bill_status);
      }

      if (notes !== null) {
        fields.push("notes=?");
        params.push(notes);
      }

      if (!fields.length) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "No fields provided to update"
        });
      }

      // ✅ Update bill
      await connection.query(
        `
        UPDATE bills
        SET ${fields.join(", ")}
        WHERE id=? AND admin_id=?
        `,
        [...params, bill_id, adminId]
      );

      // ✅ Create notification
      const title = "Bill Updated";
      const message = `Your bill #${bill_id} has been updated. Please review the changes.`;

      const [notificationResult] = await connection.query(
        `
        INSERT INTO notifications (admin_id, sender_role, title, message, type)
        VALUES (?, ?, ?, ?, 'billing')
        `,
        [adminId, senderRole, title, message]
      );

      const notificationId = notificationResult.insertId;

      // ✅ Assign notification to client
      await connection.query(
        `
        INSERT INTO notification_receivers
        (notification_id, receiver_role, receiver_id)
        VALUES (?, 'client', ?)
        `,
        [notificationId, clientId]
      );

     await connection.commit();

     global.io
      .to(clientId.toString())
      .emit("new-notification", {
        title: "Bill Updated",
        message: `Your bill #${bill_id} has been updated.`,
        type: "billing",
        bill_id,
      });


      res.json({
        success: true,
        message: "Bill updated successfully and client notified",
        bill_id
      });

    } catch (error) {
      await connection.rollback();
      console.error("UPDATE BILL ERROR:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error"
      });
    } finally {
      connection.release();
    }
  }
);


// 🗑️ DELETE BILL (Receptionist Only - Pending Bills)

router.delete(
  "/bills/:bill_id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const bill_id = Number(req.params.bill_id);
      const receptionistId = req.user.id;
      const adminId = req.user.adminId;

      if (!bill_id) {
        return res.status(400).json({
          success: false,
          message: "Invalid bill id"
        });
      }

      /* 1️⃣ Check bill ownership & status */
      const [bills] = await db.query(
        `
        SELECT id, bill_status
        FROM bills
        WHERE id = ? AND admin_id = ?
        `,
        [bill_id, adminId]
      );

      if (!bills.length) {
        return res.status(404).json({
          success: false,
          message: "Bill not found"
        });
      }

      if (bills[0].bill_status !== "Pending") {
        return res.status(403).json({
          success: false,
          message: "Only pending bills can be deleted"
        });
      }

      /* 2️⃣ Delete bill */
      await db.query(
        `DELETE FROM bills WHERE id = ? AND admin_id = ?`,
        [bill_id, adminId]
      );

      return res.status(200).json({
        success: true,
        message: "Bill deleted successfully",
        deleted_by: "receptionist",
        bill_id
      });

    } catch (error) {
      console.error("DELETE BILL ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error"
      });
    }
  }
);

module.exports = router;
