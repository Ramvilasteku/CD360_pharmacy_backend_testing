const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

const saltRounds = 10;

/* -----------------------------
   ADMIN ID GENERATOR
------------------------------ */
function generateAdminId() {
  const fixedDigit = "1";
  const randomFive = Math.floor(Math.random() * 90000) + 10000;
  return fixedDigit + randomFive;
}

/* -----------------------------
   MULTER CONFIG (COMPANY LOGO)
------------------------------ */
const BASE_UPLOAD_DIR = path.join(__dirname, "..", "images", "companies");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const adminId = req.generatedAdminId;
    if (!adminId) return cb(new Error("Admin ID not generated"), null);

    const uploadPath = path.join(
      BASE_UPLOAD_DIR,
      `admin_${adminId}`,
      "admin",
      "logo"
    );

    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },

  filename: (req, file, cb) => {
  const ext = path.extname(file.originalname);
  const baseName = path.basename(file.originalname, ext);

  cb(null, `${baseName}-${Date.now()}${ext}`);
},
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ["image/png", "image/jpeg", "image/jpg"];
  if (!allowedTypes.includes(file.mimetype)) {
    return cb(new Error("Only PNG, JPG, JPEG images allowed"), false);
  }
  cb(null, true);
};

const uploadCompanyLogo = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

/* ======================================================
   CREATE NEW ADMIN (WITH COMPANY LOGO)
====================================================== */
router.post(
  "/admin/create",
  (req, res, next) => {
    req.generatedAdminId = generateAdminId();
    next();
  },
  uploadCompanyLogo.single("company_logo"),
  async (req, res) => {
    try {
      const { name, email, password, mobile, address, status, company_name } =
        req.body;

      if (!name || !email || !password || !mobile) {
        return res.status(400).json({
          error: "name, email, password, mobile required",
        });
      }

      const normalizedEmail = email.trim().toLowerCase();

      // Check email uniqueness
      const [existing] = await db.execute(
        "SELECT id FROM admins WHERE email = ?",
        [normalizedEmail]
      );
      if (existing.length) {
        return res.status(409).json({ error: "Email already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, saltRounds);

      // Store RELATIVE path only
      const companyLogoPath = req.file
        ? `companies/admin_${req.generatedAdminId}/admin/logo/${req.file.filename}`
        : null;

      await db.execute(
        `
        INSERT INTO admins
        (id, name, email, password, mobile, address, status, company_name, company_logo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          req.generatedAdminId,
          name,
          normalizedEmail,
          hashedPassword,
          mobile,
          address || null,
          status ?? 1,
          company_name || null,
          companyLogoPath,
        ]
      );

      return res.status(201).json({
        message: "Admin created successfully",
        admin_id: req.generatedAdminId,
        company_logo: companyLogoPath,
      });
    } catch (error) {
      console.error("CREATE ADMIN ERROR:", error);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

/* ======================================================
   GET ALL ADMINS
====================================================== */
router.get("/admin/get", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM admins");
    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
});

/* ======================================================
   GET ADMIN BY ID
====================================================== */
router.get(
  "/admin/get/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const [rows] = await db.execute("SELECT * FROM admins WHERE id = ?", [
        id,
      ]);

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Admin not found",
        });
      }

      return res.status(200).json({
        success: true,
        data: rows[0],
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: "Server error",
      });
    }
  }
);

/* ======================================================
   UPDATE ADMIN (WITH LOGO CHANGE HERE)
====================================================== */
router.put(
  "/admin/update/:id",
  (req, res, next) => {
    // reuse admin id for folder path
    req.generatedAdminId = req.params.id;
    next();
  },
  uploadCompanyLogo.single("company_logo"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name, email, mobile, address, status, company_name } = req.body;

      // Check admin exists
      const [existing] = await db.execute("SELECT * FROM admins WHERE id = ?", [
        id,
      ]);

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Admin not found",
        });
      }

      // If new logo uploaded → update path, else keep old
      const companyLogoPath = req.file
        ? `companies/admin_${id}/admin/logo/${req.file.filename}`
        : existing[0].company_logo;

      await db.execute(
        `
        UPDATE admins
        SET 
          name = ?,
          email = ?,
          mobile = ?,
          address = ?,
          status = ?,
          company_name = ?,
          company_logo = ?
        WHERE id = ?
        `,
        [
          name || existing[0].name,
          email || existing[0].email,
          mobile || existing[0].mobile,
          address || existing[0].address,
          status ?? existing[0].status,
          company_name || existing[0].company_name,
          companyLogoPath,
          id,
        ]
      );

      return res.status(200).json({
        success: true,
        message: "Admin updated successfully",
        company_logo: companyLogoPath,
      });
    } catch (error) {
      console.error("UPDATE ADMIN ERROR:", error);
      return res.status(500).json({
        success: false,
        error: "Server error",
      });
    }
  }
);

/* ======================================================
   GET COMPANY INFO TO CLIENT AND STAFF (DOCTOR, RECEPTIONIST)
====================================================== */
router.get(
  "/company-info",
  authMiddleware,
  allowRoles("client", "doctor", "receptionist"),
  async (req, res) => {
    try {
      const { adminId } = req.user;

      if (!adminId) {
        return res.status(400).json({
          success: false,
          message: "Admin ID not associated with this user",
        });
      }

      const [rows] = await db.execute(
        "SELECT id AS adminId, company_name, company_logo FROM admins WHERE id = ?",
        [adminId]
      );

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Admin not found",
        });
      }

      return res.status(200).json({
        success: true,
        data: rows[0],
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  }
);

/* ======================================================
   DELETE ADMIN
====================================================== */
router.delete("/admin/delete/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await db.execute("SELECT * FROM admins WHERE id = ?", [
      id,
    ]);

    if (!existing.length) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    await db.execute("DELETE FROM admins WHERE id = ?", [id]);

    return res.status(200).json({
      success: true,
      message: "Admin deleted successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
});

module.exports = router;
