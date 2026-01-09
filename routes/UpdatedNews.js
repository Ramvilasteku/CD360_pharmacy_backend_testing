const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");


async function sendNotificationToReceivers(conn, notification_id, receivers, title, message) {
  for (let r of receivers) {
    await conn.execute(
      `INSERT INTO notification_receivers 
        (notification_id, receiver_role, receiver_id)
       VALUES (?, ?, ?)`,
      [notification_id, r.role, r.id]
    );

    // Emit socket message
    io.to(`${r.role}_${r.id}`).emit("new-notification", {
      notification_id,
      title,
      message,
      role: r.role,
    });
  }
}


//ROUTE: Send to All Staff
router.post(
  "/notifications/all-staff",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const adminId = req.user.id;
      const { title, message } = req.body;

      if (!message) return res.status(400).json({ message: "Message required" });

      await conn.beginTransaction();

      // Insert notification
      const [notif] = await conn.execute(
        `INSERT INTO notifications (sender_role, sender_id, title, message, type)
         VALUES ('admin', ?, ?, ?, 'general')`,
        [adminId, title, message]
      );

      const notification_id = notif.insertId;

      // Get all staff
      const [rows] = await conn.execute(`SELECT id FROM staff `);

      const receivers = rows.map(r => ({ id: r.id, role: 'staff' }));

      // Assign + Send socket
      await sendNotificationToReceivers(conn, notification_id, receivers, title, message);

      await conn.commit();

      res.json({ success: true, message: "Notification sent to all staff" });

    } catch (err) {
      await conn.rollback();
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  }
);

//2. Send to All Clients
router.post(
  "/notifications/all-clients",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const adminId = req.user.id;
      const { title, message } = req.body;

      if (!message) return res.status(400).json({ message: "Message required" });

      await conn.beginTransaction();

      const [notif] = await conn.execute(
        `INSERT INTO notifications (sender_role, sender_id, title, message, type)
         VALUES ('admin', ?, ?, ?, 'general')`,
        [adminId, title, message]
      );

      const notification_id = notif.insertId;

      const [rows] = await conn.execute(`SELECT id FROM clients`);

      const receivers = rows.map(r => ({ id: r.id, role: 'client' }));

      await sendNotificationToReceivers(conn, notification_id, receivers, title, message);

      await conn.commit();

      res.json({ success: true, message: "Notification sent to all clients" });

    } catch (err) {
      await conn.rollback();
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  }
);

// Send to Specific Staff IDs
router.post(
  "/notifications/staff",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const adminId = req.user.id;
      const { title, message, staff_ids } = req.body;

      if (!message || !Array.isArray(staff_ids))
        return res.status(400).json({ message: "Message & staff_ids[] required" });

      await conn.beginTransaction();

      const [notif] = await conn.execute(
        `INSERT INTO notifications (sender_role, sender_id, title, message, type)
         VALUES ('admin', ?, ?, ?, 'general')`,
        [adminId, title, message]
      );

      const notification_id = notif.insertId;

      const receivers = staff_ids.map(id => ({ id, role: "staff" }));

      await sendNotificationToReceivers(conn, notification_id, receivers, title, message);

      await conn.commit();

      res.json({ success: true, message: "Notification sent to selected staff" });

    } catch (err) {
      await conn.rollback();
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  }
);

//4.Send to Specific Client IDs
router.post(
  "/notifications/clients",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const adminId = req.user.id;
      const { title, message, client_ids } = req.body;

      if (!message || !Array.isArray(client_ids))
        return res.status(400).json({ message: "Message & client_ids[] required" });

      await conn.beginTransaction();

      const [notif] = await conn.execute(
        `INSERT INTO notifications (sender_role, sender_id, title, message, type)
         VALUES ('admin', ?, ?, ?, 'general')`,
        [adminId, title, message]
      );

      const notification_id = notif.insertId;

      const receivers = client_ids.map(id => ({ id, role: "client" }));

      await sendNotificationToReceivers(conn, notification_id, receivers, title, message);

      await conn.commit();

      res.json({ success: true, message: "Notification sent to selected clients" });

    } catch (err) {
      await conn.rollback();
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  }
);

//5. Send to BOTH Staff + Clients

router.post(
  "/notifications/mixed",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      const adminId = req.user.id;
      const { title, message, staff_ids = [], client_ids = [] } = req.body;

      await conn.beginTransaction();

      const [notif] = await conn.execute(
        `INSERT INTO notifications (sender_role, sender_id, title, message, type)
         VALUES ('admin', ?, ?, ?, 'general')`,
        [adminId, title, message]
      );

      const notification_id = notif.insertId;

      const receivers = [
        ...staff_ids.map(id => ({ id, role: "staff" })),
        ...client_ids.map(id => ({ id, role: "client" }))
      ];

      // save receivers in DB
      await sendNotificationToReceivers(
        conn,
        notification_id,
        receivers,
        title,
        message
      );

      // 🔔 SOCKET EMIT
      if (global.io) {
        receivers.forEach(({ id }) => {
          global.io.to(id.toString()).emit("new-notification", {
            notification_id,
            title,
            message,
          });
        });
      }

      await conn.commit();

      res.json({ success: true });
    } catch (err) {
      await conn.rollback();
      res.status(500).json({ error: err.message });
    } finally {
      conn.release();
    }
  }
);

//Get unread notification count

router.get("/notifications/unread-count", authMiddleware, async (req, res) => {
  const { id, role } = req.user;

  const [rows] = await db.execute(
    `SELECT COUNT(*) as count
     FROM notification_receivers
     WHERE receiver_id = ? AND receiver_role = ? AND is_read = 0`,
    [id, role]
  );

  res.json({ count: rows[0].count });
});

//Get all notifications for logged-in user

router.get("/notifications", authMiddleware, async (req, res) => {
  const { id, role } = req.user;

  const [rows] = await db.execute(
    `SELECT n.id, n.title, n.message, n.created_at, r.is_read
     FROM notification_receivers r
     JOIN notifications n ON n.id = r.notification_id
     WHERE r.receiver_id = ? AND r.receiver_role = ?
     ORDER BY n.created_at DESC`,
    [id, role]
  );

  res.json(rows);
});

//Mark notification as read

router.put("/notifications/:id/read", authMiddleware, async (req, res) => {
  const { id: receiverId, role } = req.user;
  const { id: notificationId } = req.params;

  await db.execute(
    `UPDATE notification_receivers
     SET is_read = 1, read_at = NOW()
     WHERE notification_id = ? AND receiver_id = ? AND receiver_role = ?`,
    [notificationId, receiverId, role]
  );

  res.json({ success: true });
});


module.exports =router