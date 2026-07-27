const express = require("express");
const router = express.Router();
const db = require("../db");

const { sendOTP } = require("../services/whatsappservice.js");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");
const sendEmail = require("../utils/sendEmail.js");
const multer = require("multer");
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

const fs = require("fs");
const path = require("path");
const { v4: uuid } = require("uuid");

const UPLOAD_BASE = path.join(__dirname, "..", "Images", "companies");


const ACCESS_WINDOW_HOURS = 4; // adjust as needed

const otpStore = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}


// In-memory store: documentId -> { status, requestedBy, requestedAt, respondedAt }
// Resets on server restart. Works correctly only with a single Node process.
const accessRequests = new Map();

function getAccessRecord(documentId) {
  return accessRequests.get(String(documentId)) || { status: "none" };
}

function isAccessExpired(record) {
  if (!record.respondedAt) return true;
  const elapsedMs = Date.now() - record.respondedAt;
  return elapsedMs > ACCESS_WINDOW_HOURS * 60 * 60 * 1000;
}

function hasLiveApproval(documentId, userId) {
  const record = getAccessRecord(documentId);
  return (
    record.status === "approved" &&
    record.requestedBy === userId &&
    !isAccessExpired(record)
  );
}


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
  if (user.role === "admin") return user.id;
  return user.adminId ?? user.admin_id ?? null;
}

function getUploadPath(user) {
  if (user.role === "client") {
    // CHANGED: client folders keyed by client id, not admin id (which is now null)
    return path.join(UPLOAD_BASE, "clients", `client_${user.id}`, "documents");
  }

  const adminId = getAdminId(user);
  const base = path.join(UPLOAD_BASE, `admin_${adminId}`);

  if (user.role === "admin")
    return path.join(base, "admin", `admin_${adminId}`, "documents");

  if (user.role === "doctor")
    return path.join(base, "staff", `staff_${user.id}`, "documents");

  if (user.role === "receptionist")
    return path.join(base, "staff", `staff_${user.id}`, "documents");
}


// NEW helper — checks if this admin's clinic has ever had an appointment with this client
async function adminHasAccessToClientDoc(adminId, clientId) {
  const [rows] = await db.execute(
    `SELECT 1 FROM appointments WHERE admin_id = ? AND client_id = ? LIMIT 1`,
    [adminId, clientId]
  );
  return rows.length > 0;
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

      const adminId = getAdminId(user);

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      let clientId;


      if (role === "client") {

        clientId = user.id;
      } else {

        clientId = req.body.client_id;

        if (!clientId) {
          return res.status(400).json({
            message: "client_id is required",
          });
        }


        const [client] = await db.execute(
          `SELECT id FROM clients WHERE id = ? `,
          [clientId]
        );

        if (!client.length) {
          return res.status(403).json({
            message: "Invalid client for this admin",
          });
        }
      }


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
// router.get(
//   "/documents",
//   authMiddleware,
//   allowRoles("admin", "receptionist", "doctor", "client"),
//   async (req, res) => {
//     const user = req.user;
//     const adminId = getAdminId(user);

//     let sql = `SELECT * FROM documents WHERE admin_id = ?`;
//     let params = [adminId];

//     if (["doctor", "receptionist"].includes(user.role)) {
//       sql += ` AND staff_id = ?`;
//       params.push(user.id);
//     }

//     if (user.role === "client") {
//       sql += ` AND (client_id = ?)`;
//       params.push(user.id);
//     }

//     const [rows] = await db.execute(sql, params);
//     res.json(rows);
//   }
// );

router.get(
  "/documents",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    const user = req.user;

    let sql;
    let params = [];

    if (user.role === "client") {
      // Client sees all of their documents across all admins
      sql = `SELECT * FROM documents WHERE client_id = ?`;
      params = [user.id];
    } else {
      const adminId = getAdminId(user);

      sql = `SELECT * FROM documents WHERE admin_id = ?`;
      params = [adminId];

      if (["doctor", "receptionist"].includes(user.role)) {
        sql += ` AND staff_id = ?`;
        params.push(user.id);
      }
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

      const [rows] = await db.execute(`
  SELECT
    c.id AS client_id,
    c.name AS client_name,

    d.id AS document_id,
    d.file_name,
    d.file,
    d.uploaded_at,

    d.role AS uploaded_by_role,
    s.name AS uploaded_by_staff

  FROM clients c

  LEFT JOIN documents d
    ON d.client_id = c.id

  LEFT JOIN staff s
    ON d.staff_id = s.id

  ORDER BY c.id, d.uploaded_at DESC
`);

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

      const [rows] = await db.execute(`
    SELECT
      c.id AS client_id,
      c.name AS client_name,

      d.id AS document_id,
      d.file_name,
      d.file,
      d.uploaded_at,
      d.admin_id,

      s.name AS staff_name,
      d.staff_id

    FROM clients c
    LEFT JOIN documents d
      ON d.client_id = c.id

    LEFT JOIN staff s
      ON d.staff_id = s.id
`);

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

    if (!clientId) {
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
  WHERE d.client_id = ?
  ORDER BY d.uploaded_at DESC
  `,
      [clientId]
    );

    res.json(rows);
  }
);

/* ===============================
   DOCUMENT  IMAGE VIEW
================================ */
// router.get(
//   "/documents/view/:id",
//   authMiddleware,
//   allowRoles("admin", "receptionist", "doctor", "client"),
//   async (req, res) => {
//     const user = req.user;
//     const adminId = getAdminId(user);

//     const [rows] = await db.execute("SELECT * FROM documents WHERE id = ?", [
//       req.params.id,
//     ]);

//     if (!rows.length) return res.sendStatus(404);

//     const doc = rows[0];

//     if (doc.admin_id !== adminId) return res.sendStatus(403);

//     if (
//       user.role !== "admin" &&
//       doc.staff_id !== user.id &&
//       doc.client_id !== user.id
//     ) {
//       return res.sendStatus(403);
//     }

//     const filePath = path.join(__dirname, "..", "Images", doc.file);
//     if (!fs.existsSync(filePath)) return res.sendStatus(404);

//     res.sendFile(filePath);
//   }
// );

router.get(
  "/documents/view/:id",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    try {
      const user = req.user;

      const [rows] = await db.execute(
        "SELECT * FROM documents WHERE id = ?",
        [req.params.id]
      );

      if (!rows.length) {
        return res.sendStatus(404);
      }

      const doc = rows[0];

      // ===========================
      // CLIENT
      // ===========================
      if (user.role === "client") {
        if (doc.client_id !== user.id) {
          return res.sendStatus(403);
        }
      }

      // ===========================
      // ADMIN / DOCTOR / RECEPTIONIST
      // ===========================
      else {
        const adminId = getAdminId(user);

        if (doc.admin_id !== adminId) {
          return res.sendStatus(403);
        }

        if (
          user.role !== "admin" &&
          doc.staff_id !== user.id
        ) {
          return res.sendStatus(403);
        }
      }

      const filePath = path.join(__dirname, "..", "Images", doc.file);

      if (!fs.existsSync(filePath)) {
        return res.sendStatus(404);
      }

      res.sendFile(filePath);

    } catch (err) {
      console.error(err);
      res.sendStatus(500);
    }
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
      const docId = req.params.id;

      const [rows] = await db.execute(
        `
        SELECT *
        FROM documents
        WHERE id = ?
          AND client_id = ?
          AND role = 'client'
        `,
        [docId, clientId]
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

// router.get(
//   "/documents/view-safe/:id",
//   authMiddleware,
//   allowRoles("admin", "doctor", "client", "receptionist"),
//   async (req, res) => {
//     try {
//       const user = req.user;
//       const adminId = getAdminId(user);

//       const [rows] = await db.execute("SELECT * FROM documents WHERE id = ?", [
//         req.params.id,
//       ]);

//       if (!rows.length) return res.sendStatus(404);

//       const doc = rows[0];

//       // 🔒 Must belong to same admin
//       if (doc.admin_id !== adminId) {
//         return res.sendStatus(403);
//       }

//       // 🔒 Client can view only own documents
//       if (user.role === "client" && doc.client_id !== user.id) {
//         return res.sendStatus(403);
//       }

//       // ✅ Admin & Staff allowed
//       const filePath = path.join(__dirname, "..", "Images", doc.file);
//       if (!fs.existsSync(filePath)) return res.sendStatus(404);

//       res.sendFile(filePath);
//     } catch (err) {
//       console.error("VIEW SAFE ERROR:", err);
//       res.sendStatus(500);
//     }
//   }
// );

router.get(
  "/documents/view-safe/:id",
  authMiddleware,
  allowRoles("admin", "doctor", "client", "receptionist"),
  async (req, res) => {
    try {
      const user = req.user;

      const [rows] = await db.execute(
        "SELECT * FROM documents WHERE id = ?",
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Document not found" });
      }

      const doc = rows[0];

      if (user.role === "client") {
        if (Number(doc.client_id) !== Number(user.id)) {
          return res.status(403).json({ message: "Forbidden" });
        }
      } else {
        const adminId = getAdminId(user);

        console.log({
          userRole: user.role,
          userId: user.id,
          adminId,
          documentAdminId: doc.admin_id,
        });

        let hasAccess;
        if (doc.admin_id !== null) {
          hasAccess = Number(doc.admin_id) === Number(adminId);
        } else {
          hasAccess = await adminHasAccessToClientDoc(adminId, doc.client_id);
        }

        if (!hasAccess) {
          return res.status(403).json({ message: "Forbidden" });
        }

        // REMOVED: doc.staff_id !== user.id ownership check.
        // Any admin/doctor/receptionist under the same admin can attempt
        // to view any client document, gated by OTP below.

        const key = `${doc.id}_${user.id}`;
        const otp = otpStore.get(key);

        if (!otp) {
          return res.status(403).json({
            message: "OTP verification required to view this document.",
            otpRequired: true,
          });
        }
        if (!otp.verified) {
          return res.status(403).json({
            message: "OTP not verified. Please verify the OTP first.",
            otpRequired: true,
          });
        }
        if (Date.now() > otp.verifiedExpiresAt) {
          otpStore.delete(key);
          return res.status(403).json({
            message: "OTP expired. Please request a new one.",
            otpRequired: true,
          });
        }
      }

      const filePath = path.join(__dirname, "..", "Images", doc.file);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: "File not found" });
      }

      const ext = path.extname(filePath).toLowerCase();

      let contentType = "application/octet-stream";

      if (ext === ".pdf") {
        contentType = "application/pdf";
      }
      else if (ext === ".jpg" || ext === ".jpeg") {
        contentType = "image/jpeg";
      }
      else if (ext === ".png") {
        contentType = "image/png";
      }
      else if (ext === ".doc" || ext === ".docx") {
        contentType = "application/msword";
      }


      // force browser view
      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${doc.file}"`
      );

      res.sendFile(filePath);
    } catch (err) {
      console.error("VIEW SAFE ERROR:", err);
      res.status(500).json({ message: "Server error" });
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

      const [rows] = await db.execute(
        "SELECT * FROM documents WHERE id = ?",
        [req.params.id]
      );

      if (!rows.length) {
        return res.sendStatus(404);
      }

      const doc = rows[0];

      // ==========================
      // CLIENT
      // ==========================
      if (user.role === "client") {
        // Client can download only their own documents
        if (doc.client_id !== user.id) {
          return res.sendStatus(403);
        }
      }

      // ==========================
      // ADMIN / DOCTOR / RECEPTIONIST
      // ==========================
      else {
        const adminId = getAdminId(user);
        if (doc.admin_id !== adminId) {
          return res.sendStatus(403);
        }

        if (["doctor", "receptionist", "admin"].includes(user.role) && doc.role === "client") {
          if (!hasLiveApproval(doc.id, user.id)) {
            const record = getAccessRecord(doc.id);
            return res.status(403).json({
              message: record.status === "approved" && isAccessExpired(record)
                ? "Access window has expired, please request access again"
                : "Access not granted by client",
              accessRequired: true,
            });
          }
        }
      }

      const filePath = path.join(__dirname, "..", "Images", doc.file);

      if (!fs.existsSync(filePath)) {
        return res.sendStatus(404);
      }

      res.download(filePath, doc.file_name);
    } catch (err) {
      console.error("DOWNLOAD SAFE ERROR:", err);
      res.sendStatus(500);
    }
  }
);


router.post(
  "/documents/request-access/:id",
  authMiddleware,
  allowRoles("doctor", "receptionist", "admin"),
  async (req, res) => {
    try {
      const user = req.user;
      const docId = req.params.id;

      const [docs] = await db.execute(
        "SELECT * FROM documents WHERE id = ?",
        [docId]
      );

      if (!docs.length) {
        return res.status(404).json({
          message: "Document not found",
        });
      }

      const doc = docs[0];

      const record = getAccessRecord(docId);

      if (
        record.requestedBy &&
        record.requestedBy !== user.id &&
        (
          record.status === "pending" ||
          (record.status === "approved" && !isAccessExpired(record))
        )
      ) {
        return res.status(409).json({
          message:
            "Another staff member currently has an active request/access for this document",
        });
      }

      if (hasLiveApproval(docId, user.id)) {
        return res.status(200).json({
          message: "Access already approved",
          status: "approved",
        });
      }

      accessRequests.set(String(docId), {
        status: "pending",
        requestedBy: user.id,
        requestedAt: Date.now(),
        respondedAt: null,
      });

      return res.status(200).json({
        message: "Access request sent to client",
        status: "pending",
      });

    } catch (err) {
      console.error("REQUEST ACCESS ERROR:", err);
      return res.status(500).json({
        message: "Failed to send access request",
      });
    }
  }
);

router.get(
  "/documents/access-status/:id",
  authMiddleware,
  allowRoles("doctor", "receptionist", "admin"),
  async (req, res) => {
    try {
      const docId = req.params.id;
      const record = getAccessRecord(docId);

      if (record.requestedBy && record.requestedBy !== req.user.id) {
        return res.json({ status: "none" });
      }
      if (record.status === "approved" && isAccessExpired(record)) {
        return res.json({ status: "expired" });
      }
      res.json({ status: record.status || "none" });
    } catch (err) {
      console.error("ACCESS STATUS ERROR:", err);
      res.status(500).json({ message: "Failed to fetch access status" });
    }
  }
);

router.get(
  "/documents/pending-requests",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;
      const pendingDocIds = [];
      for (const [docId, record] of accessRequests.entries()) {
        if (record.status === "pending") pendingDocIds.push(docId);
      }
      if (!pendingDocIds.length) return res.json({ data: [] });

      const placeholders = pendingDocIds.map(() => "?").join(",");
      const [docs] = await db.execute(
        `SELECT id, file_name, client_id FROM documents WHERE id IN (${placeholders}) AND client_id = ?`,
        [...pendingDocIds, clientId]
      );

      const staffIds = [...new Set(docs.map((d) => accessRequests.get(String(d.id))?.requestedBy).filter(Boolean))];
      let staffMap = {};
      if (staffIds.length) {
        const staffPlaceholders = staffIds.map(() => "?").join(",");
        const [staffRows] = await db.execute(`SELECT id, name FROM staff WHERE id IN (${staffPlaceholders})`, staffIds);
        staffMap = Object.fromEntries(staffRows.map((s) => [s.id, s.name]));
      }
      console.log("Access Requests:", [...accessRequests.entries()]);
      console.log("Pending Doc IDs:", pendingDocIds);
      console.log("Client ID:", clientId);
      console.log("Documents:", docs);
      const data = docs.map((d) => {
        const record = accessRequests.get(String(d.id));
        return {
          request_id: d.id,
          document_id: d.id,
          file_name: d.file_name,
          doctor_name: staffMap[record.requestedBy] || "Staff",
          requested_at: record.requestedAt,
        };
      });

      res.json({ data });
    } catch (err) {
      console.error("PENDING REQUESTS ERROR:", err);
      res.status(500).json({ message: "Failed to fetch pending requests" });
    }
  }
);

router.put(
  "/documents/approve-access",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const { requestId } = req.body;
      if (!requestId) return res.status(400).json({ message: "requestId is required" });

      const [rows] = await db.execute("SELECT id FROM documents WHERE id = ? AND client_id = ?", [requestId, req.user.id]);
      if (!rows.length) return res.status(404).json({ message: "Document not found" });

      const record = getAccessRecord(requestId);
      if (!record.requestedBy) return res.status(400).json({ message: "No pending request for this document" });

      accessRequests.set(String(requestId), { ...record, status: "approved", respondedAt: Date.now() });
      res.json({ message: "Access approved" });
    } catch (err) {
      console.error("APPROVE ACCESS ERROR:", err);
      res.status(500).json({ message: "Failed to approve request" });
    }
  }
);

router.put(
  "/documents/reject-access",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const { requestId } = req.body;
      if (!requestId) return res.status(400).json({ message: "requestId is required" });

      const [rows] = await db.execute("SELECT id FROM documents WHERE id = ? AND client_id = ?", [requestId, req.user.id]);
      if (!rows.length) return res.status(404).json({ message: "Document not found" });

      const record = getAccessRecord(requestId);
      accessRequests.set(String(requestId), { ...record, status: "rejected", respondedAt: Date.now() });
      res.json({ message: "Access rejected" });
    } catch (err) {
      console.error("REJECT ACCESS ERROR:", err);
      res.status(500).json({ message: "Failed to reject request" });
    }
  }
);

/* ===============================
   DOWNLOAD DOCUMENT 
================================ */
// router.get(
//   "/documents/:id",
//   authMiddleware,
//   allowRoles("admin", "receptionist", "doctor", "client"),
//   async (req, res) => {
//     const user = req.user;
//     const adminId = getAdminId(user);

//     const [rows] = await db.execute("SELECT * FROM documents WHERE id = ?", [
//       req.params.id,
//     ]);

//     if (!rows.length) return res.sendStatus(404);

//     const doc = rows[0];

//     if (doc.admin_id !== adminId) return res.sendStatus(403);

//     if (
//       user.role !== "admin" &&
//       doc.staff_id !== user.id &&
//       doc.client_id !== user.id
//     ) {
//       return res.sendStatus(403);
//     }

//     const filePath = path.join(__dirname, "..", "Images", doc.file);
//     if (!fs.existsSync(filePath)) return res.sendStatus(404);

//     res.download(filePath, doc.file_name);
//   }
// );


router.get(
  "/documents/check-access/:id",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const user = req.user;

      const [rows] = await db.execute(
        "SELECT * FROM documents WHERE id = ?",
        [req.params.id]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Document not found" });
      }

      const doc = rows[0];

      if (hasLiveApproval(doc.id, user.id)) {
        return res.json({ status: "approved" });
      }

      const record = getAccessRecord(doc.id);

      if (!record) {
        return res.json({ status: "none" });
      }

      if (record.status === "pending") {
        return res.json({ status: "pending" });
      }

      if (record.status === "rejected") {
        return res.json({ status: "rejected" });
      }

      return res.json({ status: "none" });

    } catch (err) {
      console.error(err);
      res.sendStatus(500);
    }
  }
);


router.get(
  "/documents/:id",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    try {
      const user = req.user;

      const [rows] = await db.execute(
        "SELECT * FROM documents WHERE id = ?",
        [req.params.id]
      );

      if (!rows.length) {
        return res.sendStatus(404);
      }

      const doc = rows[0];

      // ==========================
      // CLIENT
      // ==========================
      if (user.role === "client") {
        if (doc.client_id !== user.id) {
          return res.sendStatus(403);
        }
      }

      // ==========================
      // ADMIN / DOCTOR / RECEPTIONIST
      // ==========================
      else {
        const adminId = getAdminId(user);

        // Must belong to same admin
        if (doc.admin_id !== adminId) {
          return res.sendStatus(403);
        }

        // Admin can access all documents under their admin
        if (
          user.role !== "admin" &&
          doc.staff_id !== user.id
        ) {
          return res.sendStatus(403);
        }
      }

      const filePath = path.join(__dirname, "..", "Images", doc.file);

      if (!fs.existsSync(filePath)) {
        return res.sendStatus(404);
      }

      res.download(filePath, doc.file_name);

    } catch (err) {
      console.error(err);
      res.sendStatus(500);
    }
  }
);


router.post(
  "/documents/send-otp/:id",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {

      const user = req.user;
      const docId = req.params.id;

      const [rows] = await db.execute(
        `
                SELECT
                    d.id,
                    d.client_id,
                    d.file_name,
                    c.email,
                    c.mobile
                FROM documents d
                JOIN clients c
                ON c.id=d.client_id
                WHERE d.id=?
                `,
        [docId]
      );

      if (!rows.length) {
        return res.status(404).json({
          message: "Document not found"
        });
      }

      const doc = rows[0];

      // resolve requester's name + company name based on role
      let requesterName = "A hospital staff member";
      let companyName = "the hospital";

      if (user.role === "admin") {
        const [adminRows] = await db.execute(
          `SELECT name, company_name FROM admins WHERE id = ?`,
          [user.id]
        );
        if (adminRows.length) {
          requesterName = adminRows[0].name;
          companyName = adminRows[0].company_name || companyName;
        }
      } else {
        // doctor / receptionist
        const [staffRows] = await db.execute(
          `
                    SELECT s.name, a.company_name
                    FROM staff s
                    JOIN admins a ON a.id = s.admin_id
                    WHERE s.id = ?
                    `,
          [user.id]
        );
        if (staffRows.length) {
          requesterName = staffRows[0].name;
          companyName = staffRows[0].company_name || companyName;
        }
      }

      const roleLabel =
        user.role === "admin"
          ? "Admin"
          : user.role === "doctor"
            ? "Doctor"
            : "Receptionist";

      const key = `${docId}_${user.id}`;

      const existing = otpStore.get(key);

      if (existing && existing.verified && existing.verifiedExpiresAt > Date.now()) {
        return res.json({
          message: "Already verified",
          alreadyVerified: true,
          validForMs: existing.verifiedExpiresAt - Date.now(),
        });
      }

      if (existing && existing.expiresAt > Date.now()) {
        return res.json({
          message: "OTP already sent",
          expiresIn: Math.floor((existing.expiresAt - Date.now()) / 1000)
        });
      }

      const otp = generateOTP();

      otpStore.set(key, {
        otp,
        verified: false,
        expiresAt: Date.now() + 10 * 60 * 1000,
        documentId: Number(docId),
        userId: user.id,
        role: user.role
      });

      // Send Email
      //             await sendEmail(
      //     doc.email,
      //     "CareDesk360 - Document Verification OTP",
      //     `
      //     <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e5e5e5; border-radius: 8px; overflow: hidden;">

      //         <div style="background-color: #1976d2; color: white; padding: 20px; text-align: center;">
      //             <h2 style="margin: 0;">CareDesk360</h2>
      //             <p style="margin: 8px 0 0;">Secure Document Access Verification</p>
      //         </div>

      //         <div style="padding: 25px; color: #333;">
      //             <p>Hello,</p>

      //             <p>
      //                 <strong>${requesterName}</strong> (${roleLabel} at <strong>${companyName}</strong>)
      //                 has requested access to your document
      //                 "<strong>${doc.file_name}</strong>".
      //             </p>

      //             <p>
      //                 If you approve this request, please share the OTP below with the authorized hospital staff member.
      //             </p>

      //             <div style="
      //                 background: #f4f6f8;
      //                 border: 2px dashed #1976d2;
      //                 border-radius: 8px;
      //                 padding: 18px;
      //                 text-align: center;
      //                 margin: 25px 0;
      //             ">
      //                 <span style="
      //                     font-size: 34px;
      //                     font-weight: bold;
      //                     letter-spacing: 8px;
      //                     color: #1976d2;
      //                 ">
      //                     ${otp}
      //                 </span>
      //             </div>

      //             <p>
      //                 <strong>Document:</strong> ${doc.file_name}<br>
      //                 <strong>Requested by:</strong> ${requesterName} (${roleLabel})<br>
      //                 <strong>Clinic:</strong> ${companyName}
      //             </p>

      //             <p>
      //                 <strong>OTP Validity:</strong> 10 minutes
      //             </p>

      //             <p style="color:#d32f2f;">
      //                 <strong>Important:</strong> Never share this OTP with anyone except an authorized CareDesk360 hospital staff member assisting you.
      //             </p>

      //             <p>
      //                 If you did not expect this request, you can safely ignore this email.
      //             </p>

      //             <br>

      //             <p>
      //                 Regards,<br>
      //                 <strong>CareDesk360 Team</strong>
      //             </p>
      //         </div>

      //         <div style="background:#f5f5f5; text-align:center; padding:12px; font-size:12px; color:#666;">
      //             © ${new Date().getFullYear()} CareDesk360. All rights reserved.
      //         </div>

      //     </div>
      //     `
      // );

      let phone = doc.mobile;

      phone = phone.replace(/\D/g, "");

      if (phone.length === 10) {
        phone = "91" + phone;
      }

      await sendOTP(phone, otp);


      res.json({
        message: "OTP sent successfully"
      });

    } catch (err) {
      console.error(err);

      res.status(500).json({
        message: "Failed to send OTP"
      });
    }
  }
);


router.post(
  "/documents/verify-otp",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {

    try {

      const { documentId, otp } = req.body;

      const key = `${documentId}_${req.user.id}`;

      console.log("VERIFY KEY:", key);

      console.log(
        "AVAILABLE OTP KEYS:",
        [...otpStore.keys()]
      );

      const data = otpStore.get(key);

      if (!data) {

        return res.status(400).json({
          message: "OTP not found"
        });

      }

      if (Date.now() > data.expiresAt) {

        otpStore.delete(key);

        return res.status(400).json({
          message: "OTP expired"
        });

      }

      if (data.otp !== otp) {

        return res.status(400).json({
          message: "Invalid OTP"
        });

      }

      data.verified = true;
      data.verifiedExpiresAt = Date.now() + ACCESS_WINDOW_HOURS * 60 * 60 * 1000; // CHANGED
      otpStore.set(key, data);

      res.json({
        message: "OTP verified"
      });

    }
    catch (err) {

      console.log(err);

      res.status(500).json({
        message: "Verification failed"
      });

    }

  }
);

router.post(
  "/documents/send-otp/:id",
  authMiddleware,
  allowRoles("admin", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const user = req.user;
      const docId = req.params.id;

      const [rows] = await db.execute(
        `SELECT d.id, d.client_id, c.email
                 FROM documents d
                 JOIN clients c ON c.id = d.client_id
                 WHERE d.id = ?`,
        [docId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Document not found" });
      }

      const doc = rows[0];
      const key = `${docId}_${user.id}`;
      const existing = otpStore.get(key);

      // MUST BE FIRST: still within the 4-hour verified window — don't touch the entry
      if (existing && existing.verified && existing.verifiedExpiresAt > Date.now()) {
        return res.json({
          message: "Already verified",
          alreadyVerified: true,
          validForMs: existing.verifiedExpiresAt - Date.now(),
        });
      }

      // only reached if NOT already verified — safe to check/generate a fresh OTP code
      if (existing && existing.expiresAt > Date.now()) {
        return res.json({
          message: "OTP already sent",
          expiresIn: Math.floor((existing.expiresAt - Date.now()) / 1000),
        });
      }

      const otp = generateOTP();

      otpStore.set(key, {
        otp,
        verified: false,
        expiresAt: Date.now() + 10 * 60 * 1000,
        documentId: Number(docId),
        userId: user.id,
        role: user.role,
      });

      await sendEmail(doc.email, "CareDesk360 - Document Verification OTP", /* ...unchanged template... */);

      res.json({ message: "OTP sent successfully" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to send OTP" });
    }
  }
);

module.exports = router;
