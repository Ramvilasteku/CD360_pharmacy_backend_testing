const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

const multer = require("multer");
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

const fs = require("fs");
const path = require("path");
const { v4: uuid } = require("uuid");

const UPLOAD_BASE = path.join(__dirname, "..", "Images", "companies");

function normalizeUser(req) {
  const u = req.user || {};

  const role = u.role ?? null;

  // adminId resolution priority
  const adminId =
    role === "admin" ? u.id ?? null : u.adminId ?? u.admin_id ?? null;

  return {
    id: u.id ?? null,
    role,
    adminId,
  };
}

/* ===============================
   HELPERS
================================ */
function getAdminId(user) {
  return user.role === "admin" ? user.id : user.adminId;
}

function getUploadPath(user) {
  const adminId = getAdminId(user);
  const base = path.join(UPLOAD_BASE, `admin_${adminId}`);

  if (user.role === "admin")
    return path.join(base, "admin", `admin_${adminId}`, "documents");

  if (user.role === "doctor")
    return path.join(base, "staff", `staff_${user.id}`, "documents");

  if (user.role === "receptionist")
    return path.join(base, "staff", `staff_${user.id}`, "documents");

  if (user.role === "client")
    return path.join(base, "client", `client_${user.id}`, "documents");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ===============================
   CREATE DOCUMENT
================================ */
router.post(
  "/documents/upload",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  upload.single("file"),
  async (req, res) => {
    try {
      const user = req.user;
      const role = user.role;

      const adminId = role === "admin" ? user.id : user.adminId;

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      let clientId;

      // ----------------------------
      // CLIENT ID RESOLUTION
      // ----------------------------

      if (role === "client") {
        // client can upload ONLY for himself
        clientId = user.id;
      } else {
        // admin / staff must specify client_id
        clientId = req.body.client_id;

        if (!clientId) {
          return res.status(400).json({
            message: "client_id is required",
          });
        }

        // 🔒 verify client belongs to same admin
        const [client] = await db.execute(
          `SELECT id FROM clients WHERE id = ? AND admin_id = ?`,
          [clientId, adminId]
        );

        if (!client.length) {
          return res.status(403).json({
            message: "Invalid client for this admin",
          });
        }
      }

      // ----------------------------
      // FILE STORAGE
      // ----------------------------
      const folder = getUploadPath({
        role,
        id: user.id,
        adminId,
        clientId,
      });

      ensureDir(folder);

      const filename = `${uuid()}${path.extname(req.file.originalname)}`;
      const fullPath = path.join(folder, filename);

      fs.writeFileSync(fullPath, req.file.buffer);

      const relativePath = path
        .relative(path.join(__dirname, "..", "Images"), fullPath)
        .replace(/\\/g, "/");

      // ----------------------------
      // DB INSERT
      // ----------------------------
      const isStaff = ["doctor", "receptionist"].includes(role);

      await db.execute(
        `
        INSERT INTO documents
        (admin_id, staff_id, client_id, role, file_name, file)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          adminId,
          isStaff ? user.id : null,
          clientId,
          role,
          req.file.originalname,
          relativePath,
        ]
      );

      res.json({
        message: "Document uploaded successfully",
      });
    } catch (err) {
      console.error("DOCUMENT UPLOAD ERROR:", err);
      res.status(500).json({
        message: "Upload failed",
        err,
      });
    }
  }
);

/* ===============================
   LIST DOCUMENTS
================================ */
router.get(
  "/documents",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    const user = req.user;
    const adminId = getAdminId(user);

    let sql = `SELECT * FROM documents WHERE admin_id = ?`;
    let params = [adminId];

    if (["doctor", "receptionist"].includes(user.role)) {
      sql += ` AND staff_id = ?`;
      params.push(user.id);
    }

    if (user.role === "client") {
      sql += ` AND (client_id = ?)`;
      params.push(user.id);
    }

    const [rows] = await db.execute(sql, params);
    res.json(rows);
  }
);

/* ===============================
   DOCUMENT VIEW FOR ALL DOC TO ADMIN AND STAFF
================================ */
router.get(
  "/documents/admin-staff",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor"),
  async (req, res) => {
    const adminId = req.user.role === "admin" ? req.user.id : req.user.adminId;

    const [rows] = await db.execute(
      `
      SELECT
        c.id   AS client_id,
        c.name AS client_name,

        d.id   AS document_id,
        d.file_name,
        d.file,
        d.uploaded_at,

        s.name AS uploaded_by_staff

      FROM clients c
      LEFT JOIN documents d
        ON d.client_id = c.id
       AND d.admin_id = ?

      LEFT JOIN staff s
        ON d.staff_id = s.id

      WHERE c.admin_id = ?
      ORDER BY c.id, d.uploaded_at DESC
      `,
      [adminId, adminId]
    );

    /* -------------------------
       GROUP BY CLIENT
    ------------------------- */
    const grouped = {};

    for (const row of rows) {
      if (!grouped[row.client_id]) {
        grouped[row.client_id] = {
          client_id: row.client_id,
          client_name: row.client_name,
          documents: [],
        };
      }

      if (row.document_id) {
        grouped[row.client_id].documents.push({
          id: row.document_id,
          file_name: row.file_name,
          file: row.file,
          uploaded_by_staff: row.uploaded_by_staff,
          created_at: row.created_at,
        });
      }
    }

    res.json(Object.values(grouped));
  }
);


/* ===============================
   DOCUMENT VIEW FOR ALL DOC AND RECEP BY CLIENT
================================ */
router.get(
  "/documents/staff/clients",
  authMiddleware,
  allowRoles("doctor", "receptionist"),
  async (req, res) => {
    try {
      const staffId = req.user.id;
      const adminId = req.user.adminId;

      const [rows] = await db.execute(
        `
        SELECT
          c.id   AS client_id,
          c.name AS client_name,

          d.id   AS document_id,
          d.file_name,
          d.file,
          d.role AS uploaded_by_role,
          d.uploaded_at,

          s.name AS uploaded_by_staff,
          a.name AS uploaded_by_admin

        FROM clients c
        LEFT JOIN documents d
          ON d.client_id = c.id
         AND d.admin_id = ?

        LEFT JOIN staff s
          ON d.staff_id = s.id

        LEFT JOIN admins a
          ON d.admin_id = a.id

        WHERE c.admin_id = ?
        ORDER BY c.id, d.uploaded_at DESC
        `,
        [adminId, adminId]
      );

      /* -------------------------
         GROUP BY CLIENT
      ------------------------- */
      const grouped = {};

      for (const row of rows) {
        if (!grouped[row.client_id]) {
          grouped[row.client_id] = {
            client_id: row.client_id,
            client_name: row.client_name,
            documents: [],
          };
        }

        if (row.document_id) {
          grouped[row.client_id].documents.push({
            id: row.document_id,
            file_name: row.file_name,
            file: row.file, // use view-safe / download-safe
            uploaded_by_role: row.uploaded_by_role, // admin | doctor | receptionist | client
            uploaded_by_name:
              row.uploaded_by_role === "admin"
                ? row.uploaded_by_admin
                : row.uploaded_by_role === "client"
                ? "Client"
                : row.uploaded_by_staff,
            uploaded_at: row.uploaded_at,
          });
        }
      }

      res.status(200).json(Object.values(grouped));
    } catch (err) {
      console.error("STAFF CLIENT DOCUMENT FETCH ERROR:", err);
      res.status(500).json({
        message: "Failed to fetch client documents",
      });
    }
  }
);

/* ===============================
   DOCUMENT VIEW FOR ALL DOC TO STAFF
================================ */
router.get(
  "/documents/staff",
  authMiddleware,
  allowRoles("receptionist", "doctor"),
  async (req, res) => {
    try {
      // If admin → own id
      // If staff → their admin id
      const adminId =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      const [rows] = await db.execute(
        `
        SELECT
          c.id   AS client_id,
          c.name AS client_name,

          d.id   AS document_id,
          d.file_name,
          d.file,
          d.uploaded_at,

          s.name AS uploaded_by_staff,

          CASE
            WHEN d.staff_id IS NOT NULL THEN 'staff'
            WHEN d.admin_id IS NOT NULL THEN 'admin'
            ELSE NULL
          END AS uploaded_by_role

        FROM clients c
        LEFT JOIN documents d
          ON d.client_id = c.id
         AND d.admin_id = ?

        LEFT JOIN staff s
          ON d.staff_id = s.id

        WHERE c.admin_id = ?
        ORDER BY c.id, d.uploaded_at DESC
        `,
        [adminId, adminId]
      );

      /* -------------------------
         GROUP BY CLIENT
      ------------------------- */
      const grouped = {};

      for (const row of rows) {
        if (!grouped[row.client_id]) {
          grouped[row.client_id] = {
            client_id: row.client_id,
            client_name: row.client_name,
            documents: [],
          };
        }

        if (row.document_id) {
          grouped[row.client_id].documents.push({
            id: row.document_id,
            file_name: row.file_name,
            file: row.file,
            uploaded_by_staff: row.uploaded_by_staff,
            uploaded_by_role: row.uploaded_by_role,
            uploaded_at: row.uploaded_at,
          });
        }
      }

      res.status(200).json(Object.values(grouped));
    } catch (error) {
      console.error("Error fetching documents:", error);
      res.status(500).json({ message: "Failed to fetch documents" });
    }
  }
);

router.get(
  "/documents/staff/all",
  authMiddleware,
  allowRoles("receptionist", "doctor"),

  async (req, res) => {
    try {
      const staffId = req.user.id; // logged-in staff
      const adminId = req.user.adminId; // their admin

      const [rows] = await db.execute(
        `
        SELECT
          c.id   AS client_id,
          c.name AS client_name,

          d.id   AS document_id,
          d.file_name,
          d.file,
          d.uploaded_at,

          d.role AS uploaded_by_role,
          s.name AS uploaded_by_staff

        FROM clients c
        LEFT JOIN documents d
          ON d.client_id = c.id
         AND d.admin_id = ?

        LEFT JOIN staff s
          ON d.staff_id = s.id

        WHERE c.admin_id = ?
        ORDER BY c.id, d.uploaded_at DESC
        `,
        [adminId, adminId]
      );

      /* -------------------------
         GROUP BY CLIENT
      ------------------------- */
      const grouped = {};

      for (const row of rows) {
        if (!grouped[row.client_id]) {
          grouped[row.client_id] = {
            client_id: row.client_id,
            client_name: row.client_name,
            documents: [],
          };
        }

        if (row.document_id) {
          grouped[row.client_id].documents.push({
            id: row.document_id,
            file_name: row.file_name,
            file: row.file,
            uploaded_by_role: row.uploaded_by_role, // admin | staff | client
            uploaded_by_staff: row.uploaded_by_staff, // only if staff
            uploaded_at: row.uploaded_at,
          });
        }
      }

      res.status(200).json(Object.values(grouped));
    } catch (error) {
      console.error("STAFF DOCUMENT FETCH ERROR:", error);
      res.status(500).json({
        message: "Failed to fetch documents",
      });
    }
  }
);

router.get(
  "/documents/admin",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      const [rows] = await db.execute(
        `
        SELECT
          c.id   AS client_id,
          c.name AS client_name,

          d.id   AS document_id,
          d.file_name,
          d.file,
          d.uploaded_at,

          s.name AS staff_name,
          d.staff_id

        FROM clients c
        LEFT JOIN documents d
          ON d.client_id = c.id
         AND d.admin_id = ?

        LEFT JOIN staff s
          ON d.staff_id = s.id

        WHERE c.admin_id = ?
        ORDER BY c.id, d.uploaded_at DESC
        `,
        [adminId, adminId]
      );

      const BASE_URL = `${req.protocol}://${req.get("host")}`;

      const grouped = {};

      for (const row of rows) {
        if (!grouped[row.client_id]) {
          grouped[row.client_id] = {
            client_id: row.client_id,
            client_name: row.client_name,
            documents: [],
          };
        }

        if (row.document_id) {
          let uploadedBy = "client";
          let uploadedByName = "Client";

          if (row.staff_id) {
            uploadedBy = "staff";
            uploadedByName = row.staff_name;
          } else if (row.file?.includes("/admin/")) {
            uploadedBy = "admin";
            uploadedByName = "Admin";
          }

          grouped[row.client_id].documents.push({
            id: row.document_id,
            file_name: row.file_name,
            file_url: `${BASE_URL}/Images/${row.file.replace(/^Images\//, "")}`,
            uploaded_by: uploadedBy,
            uploaded_by_name: uploadedByName,
            uploaded_at: row.uploaded_at,
          });
        }
      }

      res.json(Object.values(grouped));
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/* ===============================
   GET THERE OWN CLIENT DOCUMENT WHO IS LOGIN
================================ */
router.get(
  "/documents/client",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    const adminId = req.user.adminId; // from token
    const clientId = req.user.id;

    if (!adminId || !clientId) {
      return res.status(401).json({
        message: "Invalid client session",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        d.id,
        d.file_name,
        d.file,
        d.role AS uploaded_by_role,
        d.uploaded_at,

        s.name AS staff_name,
        a.name AS admin_name

      FROM documents d
      LEFT JOIN staff s ON d.staff_id = s.id
      LEFT JOIN admins a ON d.admin_id = a.id

      WHERE d.admin_id = ?
        AND d.client_id = ?
      ORDER BY d.uploaded_at DESC
      `,
      [adminId, clientId]
    );

    res.json(rows);
  }
);

/* ===============================
   DOCUMENT  IMAGE VIEW
================================ */
router.get(
  "/documents/view/:id",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    const user = req.user;
    const adminId = getAdminId(user);

    const [rows] = await db.execute("SELECT * FROM documents WHERE id = ?", [
      req.params.id,
    ]);

    if (!rows.length) return res.sendStatus(404);

    const doc = rows[0];

    if (doc.admin_id !== adminId) return res.sendStatus(403);

    if (
      user.role !== "admin" &&
      doc.staff_id !== user.id &&
      doc.client_id !== user.id
    ) {
      return res.sendStatus(403);
    }

    const filePath = path.join(__dirname, "..", "Images", doc.file);
    if (!fs.existsSync(filePath)) return res.sendStatus(404);

    res.sendFile(filePath);
  }
);

/* ===============================
   DOWNLOAD DOCUMENT 
================================ */
router.get(
  "/documents/:id",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    const user = req.user;
    const adminId = getAdminId(user);

    const [rows] = await db.execute("SELECT * FROM documents WHERE id = ?", [
      req.params.id,
    ]);

    if (!rows.length) return res.sendStatus(404);

    const doc = rows[0];

    if (doc.admin_id !== adminId) return res.sendStatus(403);

    if (
      user.role !== "admin" &&
      doc.staff_id !== user.id &&
      doc.client_id !== user.id
    ) {
      return res.sendStatus(403);
    }

    const filePath = path.join(__dirname, "..", "Images", doc.file);
    if (!fs.existsSync(filePath)) return res.sendStatus(404);

    res.download(filePath, doc.file_name);
  }
);

/* ===============================
   DELETE DOCUMENT (ROLE BASED) START  =========================
================================ */
/* ===============================
   Admin can DELETE all Documents
================================ */

router.delete(
  "/documents/admin/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;

      const [rows] = await db.execute(
        "SELECT * FROM documents WHERE id = ? AND admin_id = ?",
        [req.params.id, adminId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Document not found" });
      }

      const doc = rows[0];
      const filePath = path.join(__dirname, "..", "Images", doc.file);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      await db.execute("DELETE FROM documents WHERE id = ?", [doc.id]);

      res.json({ message: "Document deleted by admin" });
    } catch (err) {
      console.error("ADMIN DELETE ERROR:", err);
      res.status(500).json({ message: "Delete failed" });
    }
  }
);

/* ===============================
   Staff can DELETE only they uploded Documents
================================ */

router.delete(
  "/documents/staff/:id",
  authMiddleware,
  allowRoles("receptionist", "doctor"),

  async (req, res) => {
    try {
      const staffId = req.user.id;
      const adminId = req.user.adminId;

      const [rows] = await db.execute(
        `
        SELECT * FROM documents
        WHERE id = ?
          AND staff_id = ?
          AND admin_id = ?
        `,
        [req.params.id, staffId, adminId]
      );

      if (!rows.length) {
        return res.status(403).json({
          message: "You can delete only your uploaded documents",
        });
      }

      const doc = rows[0];
      const filePath = path.join(__dirname, "..", "Images", doc.file);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      await db.execute("DELETE FROM documents WHERE id = ?", [doc.id]);

      res.json({ message: "Document deleted by staff" });
    } catch (err) {
      console.error("STAFF DELETE ERROR:", err);
      res.status(500).json({ message: "Delete failed" });
    }
  }
);

/* ===============================
    Client can DELETE only they uploded Documents
  ================================ */
router.delete(
  "/documents/client/:id",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;
      const adminId = req.user.adminId || req.user.admin_id || req.user.id;
      const docId = req.params.id;

      const [rows] = await db.execute(
        `
        SELECT *
        FROM documents
        WHERE id = ?
          AND client_id = ?
          AND admin_id = ?
          AND role = 'client'
        `,
        [docId, clientId, adminId]
      );

      if (!rows.length) {
        return res.status(403).json({
          message: "You can delete only documents uploaded by you",
        });
      }

      const doc = rows[0];

      if (doc.file) {
        const filePath = path.join(__dirname, "..", "Images", doc.file);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }

      await db.execute("DELETE FROM documents WHERE id = ?", [docId]);

      res.json({ message: "Document deleted by client" });
    } catch (err) {
      console.error("CLIENT DELETE ERROR:", err);
      res.status(500).json({ message: "Delete failed" });
    }
  }
);

/* ===============================
   DELETE DOCUMENT (ROLE BASED) ENDS  =========================
================================ */

router.get(
  "/documents/view-safe/:id",
  authMiddleware,
  allowRoles("admin", "doctor", "client", "receptionist"),
  async (req, res) => {
    try {
      const user = req.user;
      const adminId = getAdminId(user);

      const [rows] = await db.execute("SELECT * FROM documents WHERE id = ?", [
        req.params.id,
      ]);

      if (!rows.length) return res.sendStatus(404);

      const doc = rows[0];

      // 🔒 Must belong to same admin
      if (doc.admin_id !== adminId) {
        return res.sendStatus(403);
      }

      // 🔒 Client can view only own documents
      if (user.role === "client" && doc.client_id !== user.id) {
        return res.sendStatus(403);
      }

      // ✅ Admin & Staff allowed
      const filePath = path.join(__dirname, "..", "Images", doc.file);
      if (!fs.existsSync(filePath)) return res.sendStatus(404);

      res.sendFile(filePath);
    } catch (err) {
      console.error("VIEW SAFE ERROR:", err);
      res.sendStatus(500);
    }
  }
);

router.get(
  "/documents/download-safe/:id",
  authMiddleware,
  allowRoles("admin", "doctor", "client", "receptionist"),
  async (req, res) => {
    try {
      const user = req.user;
      const adminId = getAdminId(user);

      const [rows] = await db.execute("SELECT * FROM documents WHERE id = ?", [
        req.params.id,
      ]);

      if (!rows.length) return res.sendStatus(404);

      const doc = rows[0];

      // 🔒 Must belong to same admin
      if (doc.admin_id !== adminId) {
        return res.sendStatus(403);
      }

      // 🔒 Client can download only own documents
      if (user.role === "client" && doc.client_id !== user.id) {
        return res.sendStatus(403);
      }

      const filePath = path.join(__dirname, "..", "Images", doc.file);
      if (!fs.existsSync(filePath)) return res.sendStatus(404);

      res.download(filePath, doc.file_name);
    } catch (err) {
      console.error("DOWNLOAD SAFE ERROR:", err);
      res.sendStatus(500);
    }
  }
);

module.exports = router;
