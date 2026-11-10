// routes/pharmacy/suppliers.js

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");

/* ============================================================
   Helper: resolve tenant admin_id from req.user
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

/* ============================================================
   Helper: validate numeric input safely
============================================================ */
function toDecimal(val, fallback = 0) {
  if (val === undefined || val === null || val === "") return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

/* ============================================================
   Helper: basic email validation
============================================================ */
function isValidEmail(email) {
  if (!email) return true; // optional field
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ============================================================
   Helper: basic phone validation (Indian format friendly)
============================================================ */
function isValidPhone(phone) {
  if (!phone) return true; // optional
  const cleaned = phone.replace(/[\s\-\(\)+]/g, "");
  return /^\d{7,15}$/.test(cleaned);
}

/* ============================================================
   Helper: Indian GST number format (15 chars: 2 digit state + 10 char PAN + 3 chars)
============================================================ */
function isValidGSTNumber(gst) {
  if (!gst) return true; // optional
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9]{1}[Z]{1}[0-9A-Z]{1}$/i.test(gst);
}

/* ============================================================
   CREATE supplier
   Access:
     - admin (bypass — tenant owner)
     - any staff role with 'pharmacy.suppliers.create' permission
============================================================ */
router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.suppliers.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      const {
        supplier_name,
        contact_person,
        phone,
        alternate_phone,
        email,
        address,
        city,
        state,
        pincode,
        gst_number,
        drug_license_number,
        opening_balance,
      } = req.body;

      // ── Required field validation ──
      if (!supplier_name || !supplier_name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Supplier name is required",
        });
      }

      const trimmedName = supplier_name.trim();

      if (trimmedName.length > 255) {
        return res.status(400).json({
          success: false,
          message: "Supplier name too long (max 255 characters)",
        });
      }

      // ── Format validation ──
      if (email && !isValidEmail(email.trim())) {
        return res.status(400).json({
          success: false,
          message: "Invalid email format",
        });
      }

      if (phone && !isValidPhone(phone)) {
        return res.status(400).json({
          success: false,
          message: "Invalid phone number format",
        });
      }

      if (alternate_phone && !isValidPhone(alternate_phone)) {
        return res.status(400).json({
          success: false,
          message: "Invalid alternate phone number format",
        });
      }

      if (gst_number && !isValidGSTNumber(gst_number.trim())) {
        return res.status(400).json({
          success: false,
          message: "Invalid GST number format (expected: 22AAAAA0000A1Z5)",
        });
      }

      if (pincode && !/^\d{4,10}$/.test(pincode.trim())) {
        return res.status(400).json({
          success: false,
          message: "Invalid pincode format",
        });
      }

      // ── Duplicate check: same supplier name for same tenant ──
      const [existingName] = await db.query(
        `SELECT id FROM pharmacy_suppliers 
         WHERE admin_id = ? AND supplier_name = ? LIMIT 1`,
        [tenantAdminId, trimmedName]
      );

      if (existingName.length) {
        return res.status(409).json({
          success: false,
          message: `Supplier '${trimmedName}' already exists`,
          existing_id: existingName[0].id,
        });
      }

      // ── Duplicate check: GST number (if provided) ──
      if (gst_number && gst_number.trim()) {
        const [existingGST] = await db.query(
          `SELECT id, supplier_name FROM pharmacy_suppliers 
           WHERE admin_id = ? AND gst_number = ? LIMIT 1`,
          [tenantAdminId, gst_number.trim().toUpperCase()]
        );

        if (existingGST.length) {
          return res.status(409).json({
            success: false,
            message: `GST number already registered to '${existingGST[0].supplier_name}'`,
            existing_id: existingGST[0].id,
          });
        }
      }

      // ── Validate opening balance ──
      const openingBal = toDecimal(opening_balance, 0);
      if (openingBal < 0) {
        return res.status(400).json({
          success: false,
          message: "Opening balance cannot be negative",
        });
      }

      // ── Insert ──
      const [result] = await db.query(
        `INSERT INTO pharmacy_suppliers (
          admin_id, supplier_name, contact_person,
          phone, alternate_phone, email,
          address, city, state, pincode,
          gst_number, drug_license_number,
          opening_balance, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          tenantAdminId,
          trimmedName,
          contact_person?.trim() || null,
          phone?.trim() || null,
          alternate_phone?.trim() || null,
          email?.trim().toLowerCase() || null,
          address?.trim() || null,
          city?.trim() || null,
          state?.trim() || null,
          pincode?.trim() || null,
          gst_number?.trim().toUpperCase() || null,
          drug_license_number?.trim() || null,
          openingBal,
        ]
      );

      // ── Return created row ──
      const [newRow] = await db.query(
        `SELECT id, admin_id, supplier_name, contact_person,
                phone, alternate_phone, email,
                address, city, state, pincode,
                gst_number, drug_license_number,
                opening_balance, status, created_at, updated_at
         FROM pharmacy_suppliers WHERE id = ?`,
        [result.insertId]
      );

      return res.status(201).json({
        success: true,
        message: "Supplier created successfully",
        data: newRow[0],
      });
    } catch (err) {
      console.error("Create supplier error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create supplier",
      });
    }
  }
);

/* ============================================================
   LIST suppliers (with search, filter, pagination)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.suppliers.view' permission
   Query params:
     - search    : matches supplier_name, contact_person, phone, gst, drug_license
     - status    : 'active' | 'inactive'
     - city      : filter by city
     - state     : filter by state
     - page, limit : pagination
     - sort_by   : created_at | supplier_name | city | state | opening_balance
     - sort_order : ASC | DESC
============================================================ */
router.get(
  "/",
  authMiddleware,
  allowPermissions("pharmacy.suppliers.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      const {
        search,
        status,
        city,
        state,
        page = 1,
        limit = 20,
        sort_by = "created_at",
        sort_order = "DESC",
      } = req.query;

      const whereConditions = ["admin_id = ?"];
      const params = [tenantAdminId];

      if (status && ["active", "inactive"].includes(status)) {
        whereConditions.push("status = ?");
        params.push(status);
      }

      if (city && city.trim()) {
        whereConditions.push("city = ?");
        params.push(city.trim());
      }

      if (state && state.trim()) {
        whereConditions.push("state = ?");
        params.push(state.trim());
      }

      if (search && search.trim()) {
        const searchTerm = `%${search.trim()}%`;
        whereConditions.push(`(
          supplier_name LIKE ? OR
          contact_person LIKE ? OR
          phone LIKE ? OR
          alternate_phone LIKE ? OR
          email LIKE ? OR
          gst_number LIKE ? OR
          drug_license_number LIKE ?
        )`);
        params.push(
          searchTerm, searchTerm, searchTerm, searchTerm,
          searchTerm, searchTerm, searchTerm
        );
      }

      const whereClause = whereConditions.join(" AND ");
      const offset = (Number(page) - 1) * Number(limit);

      // Whitelisted sort columns
      const allowedSort = [
        "created_at",
        "updated_at",
        "supplier_name",
        "city",
        "state",
        "opening_balance",
      ];
      const safeSortBy = allowedSort.includes(sort_by) ? sort_by : "created_at";
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      // Total count
      const [countResult] = await db.query(
        `SELECT COUNT(*) as total FROM pharmacy_suppliers WHERE ${whereClause}`,
        params
      );

      // Paginated results
      const [suppliers] = await db.query(
        `SELECT id, supplier_name, contact_person,
                phone, alternate_phone, email,
                address, city, state, pincode,
                gst_number, drug_license_number,
                opening_balance, status, created_at, updated_at
         FROM pharmacy_suppliers
         WHERE ${whereClause}
         ORDER BY ${safeSortBy} ${safeSortOrder}
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), offset]
      );

      return res.json({
        success: true,
        data: suppliers,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: countResult[0].total,
          total_pages: Math.ceil(countResult[0].total / Number(limit)),
        },
      });
    } catch (err) {
      console.error("List suppliers error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch suppliers",
      });
    }
  }
);

/* ============================================================
   GET single supplier by ID
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.suppliers.view' permission
============================================================ */
router.get(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.suppliers.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [supplier] = await db.query(
        `SELECT id, admin_id, supplier_name, contact_person,
                phone, alternate_phone, email,
                address, city, state, pincode,
                gst_number, drug_license_number,
                opening_balance, status, created_at, updated_at
         FROM pharmacy_suppliers
         WHERE id = ? AND admin_id = ?`,
        [id, tenantAdminId]
      );

      if (!supplier.length) {
        return res.status(404).json({
          success: false,
          message: "Supplier not found",
        });
      }

      return res.json({
        success: true,
        data: supplier[0],
      });
    } catch (err) {
      console.error("Get supplier error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch supplier",
      });
    }
  }
);

/* ============================================================
   UPDATE supplier
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.suppliers.edit' permission
============================================================ */
router.put(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.suppliers.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
      const {
        supplier_name,
        contact_person,
        phone,
        alternate_phone,
        email,
        address,
        city,
        state,
        pincode,
        gst_number,
        drug_license_number,
        opening_balance,
        status,
      } = req.body;

      // Verify ownership
      const [existing] = await db.query(
        `SELECT id, supplier_name, gst_number 
         FROM pharmacy_suppliers 
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Supplier not found",
        });
      }

      const updates = [];
      const params = [];

      // ── supplier_name ──
      if (supplier_name !== undefined) {
        const trimmedName = supplier_name.trim();

        if (!trimmedName) {
          return res.status(400).json({
            success: false,
            message: "Supplier name cannot be empty",
          });
        }

        if (trimmedName.length > 255) {
          return res.status(400).json({
            success: false,
            message: "Supplier name too long (max 255 characters)",
          });
        }

        // Duplicate check if name changed
        if (trimmedName !== existing[0].supplier_name) {
          const [duplicate] = await db.query(
            `SELECT id FROM pharmacy_suppliers 
             WHERE admin_id = ? AND supplier_name = ? AND id != ? LIMIT 1`,
            [tenantAdminId, trimmedName, id]
          );

          if (duplicate.length) {
            return res.status(409).json({
              success: false,
              message: `Supplier '${trimmedName}' already exists`,
            });
          }
        }

        updates.push("supplier_name = ?");
        params.push(trimmedName);
      }

      // ── Contact / address text fields ──
      const textFields = {
        contact_person,
        address,
        city,
        state,
        drug_license_number,
      };
      for (const [key, val] of Object.entries(textFields)) {
        if (val !== undefined) {
          updates.push(`${key} = ?`);
          params.push(val?.trim() || null);
        }
      }

      // ── phone ──
      if (phone !== undefined) {
        if (phone && !isValidPhone(phone)) {
          return res.status(400).json({
            success: false,
            message: "Invalid phone number format",
          });
        }
        updates.push("phone = ?");
        params.push(phone?.trim() || null);
      }

      // ── alternate_phone ──
      if (alternate_phone !== undefined) {
        if (alternate_phone && !isValidPhone(alternate_phone)) {
          return res.status(400).json({
            success: false,
            message: "Invalid alternate phone number format",
          });
        }
        updates.push("alternate_phone = ?");
        params.push(alternate_phone?.trim() || null);
      }

      // ── email ──
      if (email !== undefined) {
        if (email && !isValidEmail(email.trim())) {
          return res.status(400).json({
            success: false,
            message: "Invalid email format",
          });
        }
        updates.push("email = ?");
        params.push(email?.trim().toLowerCase() || null);
      }

      // ── pincode ──
      if (pincode !== undefined) {
        if (pincode && !/^\d{4,10}$/.test(pincode.trim())) {
          return res.status(400).json({
            success: false,
            message: "Invalid pincode format",
          });
        }
        updates.push("pincode = ?");
        params.push(pincode?.trim() || null);
      }

      // ── gst_number ──
      if (gst_number !== undefined) {
        const gstVal = gst_number?.trim().toUpperCase() || null;

        if (gstVal && !isValidGSTNumber(gstVal)) {
          return res.status(400).json({
            success: false,
            message: "Invalid GST number format",
          });
        }

        // Duplicate GST check (if changed)
        if (gstVal && gstVal !== existing[0].gst_number) {
          const [gstDup] = await db.query(
            `SELECT id, supplier_name FROM pharmacy_suppliers 
             WHERE admin_id = ? AND gst_number = ? AND id != ? LIMIT 1`,
            [tenantAdminId, gstVal, id]
          );

          if (gstDup.length) {
            return res.status(409).json({
              success: false,
              message: `GST number already registered to '${gstDup[0].supplier_name}'`,
            });
          }
        }

        updates.push("gst_number = ?");
        params.push(gstVal);
      }

      // ── opening_balance ──
      if (opening_balance !== undefined) {
        const bal = toDecimal(opening_balance, 0);
        if (bal < 0) {
          return res.status(400).json({
            success: false,
            message: "Opening balance cannot be negative",
          });
        }
        updates.push("opening_balance = ?");
        params.push(bal);
      }

      // ── status ──
      if (status !== undefined) {
        if (!["active", "inactive"].includes(status)) {
          return res.status(400).json({
            success: false,
            message: "Invalid status. Use 'active' or 'inactive'",
          });
        }
        updates.push("status = ?");
        params.push(status);
      }

      if (!updates.length) {
        return res.status(400).json({
          success: false,
          message: "No fields to update",
        });
      }

      params.push(id, tenantAdminId);

      await db.query(
        `UPDATE pharmacy_suppliers 
         SET ${updates.join(", ")} 
         WHERE id = ? AND admin_id = ?`,
        params
      );

      // Return updated row
      const [updated] = await db.query(
        `SELECT id, supplier_name, contact_person,
                phone, alternate_phone, email,
                address, city, state, pincode,
                gst_number, drug_license_number,
                opening_balance, status, created_at, updated_at
         FROM pharmacy_suppliers WHERE id = ?`,
        [id]
      );

      return res.json({
        success: true,
        message: "Supplier updated successfully",
        data: updated[0],
      });
    } catch (err) {
      console.error("Update supplier error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update supplier",
      });
    }
  }
);

/* ============================================================
   SOFT DELETE (set inactive)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.suppliers.delete' permission
   
   NOTE: Never hard-delete a supplier. Historical POs and batches
         reference them for legal/compliance records.
============================================================ */
router.delete(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.suppliers.delete"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [existing] = await db.query(
        `SELECT id, supplier_name FROM pharmacy_suppliers 
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Supplier not found",
        });
      }

      // Check for pending/active purchase orders
      // (uncomment when pharmacy_purchase_orders table exists)
      /*
      const [poCheck] = await db.query(
        `SELECT COUNT(*) as count 
         FROM pharmacy_purchase_orders 
         WHERE supplier_id = ? AND admin_id = ? 
           AND status IN ('draft', 'ordered', 'partial')`,
        [id, tenantAdminId]
      );

      if (poCheck[0].count > 0) {
        return res.status(409).json({
          success: false,
          message: `Cannot deactivate - ${poCheck[0].count} pending purchase orders`,
          pending_orders: poCheck[0].count,
        });
      }
      */

      await db.query(
        `UPDATE pharmacy_suppliers 
         SET status = 'inactive' 
         WHERE id = ? AND admin_id = ?`,
        [id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `Supplier '${existing[0].supplier_name}' has been deactivated`,
      });
    } catch (err) {
      console.error("Delete supplier error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to deactivate supplier",
      });
    }
  }
);

/* ============================================================
   TOGGLE STATUS (activate / deactivate)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.suppliers.edit' permission
============================================================ */
router.patch(
  "/:id/status",
  authMiddleware,
  allowPermissions("pharmacy.suppliers.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [existing] = await db.query(
        `SELECT id, supplier_name, status 
         FROM pharmacy_suppliers 
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Supplier not found",
        });
      }

      const newStatus =
        existing[0].status === "active" ? "inactive" : "active";

      await db.query(
        `UPDATE pharmacy_suppliers 
         SET status = ? 
         WHERE id = ? AND admin_id = ?`,
        [newStatus, id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `Supplier '${existing[0].supplier_name}' ${newStatus === "active" ? "activated" : "deactivated"}`,
        data: { id: Number(id), status: newStatus },
      });
    } catch (err) {
      console.error("Toggle status error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to toggle status",
      });
    }
  }
);

/* ============================================================
   ACTIVE SUPPLIERS LIST (for dropdowns in PO forms)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.suppliers.view' permission
   Returns lightweight list — id + name only.
============================================================ */
router.get(
  "/lookup/active",
  authMiddleware,
  allowPermissions("pharmacy.suppliers.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      const [rows] = await db.query(
        `SELECT id, supplier_name, contact_person, phone
         FROM pharmacy_suppliers
         WHERE admin_id = ? AND status = 'active'
         ORDER BY supplier_name ASC`,
        [tenantAdminId]
      );

      return res.json({
        success: true,
        data: rows,
        total: rows.length,
      });
    } catch (err) {
      console.error("Active suppliers lookup error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch active suppliers",
      });
    }
  }
);

module.exports = router;