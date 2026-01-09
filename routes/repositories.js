const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

router.post(
  "/repository",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { client_id, portalname, username, password } = req.body;
      const adminid = req.user.id;

      // check client belongs to admin
      const [client] = await db.execute(
        "SELECT id FROM clients WHERE id=? AND admin_id=?",
        [client_id, adminid]
      );

      if (client.length === 0) {
        return res.status(403).json({ message: "Client not assigned to you" });
      }

      await db.execute(
        `INSERT INTO repository 
         (client_id, portalname, username, password, adminid)
         VALUES (?,?,?,?,?)`,
        [client_id, portalname, username, password, adminid]
      );

      res.status(201).json({ message: "Repository entry created" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.get(
  "/repository",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminid = req.user.id;

      const [data] = await db.execute(
        `SELECT 
            r.id,
            c.name,
            r.portalname,
            r.username,
            r.password,
            r.created_at
         FROM repository r
         JOIN clients c ON r.client_id = c.id
         WHERE r.adminid = ?`,
        [adminid]
      );

      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.get(
  "/repository/client/:clientId",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminid = req.user.id;
      const { clientId } = req.params;

      // Optional safety check: ensure client belongs to admin
      const [client] = await db.execute(
        "SELECT id FROM clients WHERE id = ? AND admin_id = ?",
        [clientId, adminid]
      );

      if (client.length === 0) {
        return res.status(403).json({ message: "Client not assigned to you" });
      }

      const [data] = await db.execute(
        `SELECT 
            r.id,
            c.name AS client_name,
            r.portalname,
            r.username,
            r.password,
            r.created_at
         FROM repository r
         JOIN clients c ON r.client_id = c.id
         WHERE r.adminid = ? AND r.client_id = ?`,
        [adminid, clientId]
      );

      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);


router.put(
  "/repository/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminid = req.user.id;
      const repoId = req.params.id;
      const { portalname, username, password } = req.body;

      const [check] = await db.execute(
        "SELECT id FROM repository WHERE id=? AND adminid=?",
        [repoId, adminid]
      );

      if (check.length === 0) {
        return res.status(403).json({ message: "Access denied" });
      }

      await db.execute(
        `UPDATE repository 
         SET portalname=?, username=?, password=?
         WHERE id=?`,
        [portalname, username, password, repoId]
      );

      res.json({ message: "Repository updated" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.delete(
  "/repository/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminid = req.user.id;
      const repoId = req.params.id;

      const [check] = await db.execute(
        "SELECT id FROM repository WHERE id=? AND adminid=?",
        [repoId, adminid]
      );

      if (check.length === 0) {
        return res.status(403).json({ message: "Access denied" });
      }

      await db.execute(
        "DELETE FROM repository WHERE id=?",
        [repoId]
      );

      res.json({ message: "Repository deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
