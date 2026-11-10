const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");

/* Helper: resolve tenant admin_id from req.user (same as medicines.js) */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

/* ═══════════════════════════════════════════════════════════
   POST /api/pharmacy/substitutions — log a substitution
   ═══════════════════════════════════════════════════════════ */
router.post(
  "/",
  authMiddleware,
  allowPermissions("pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);  // ✅ use helper
      const cashierId = req.user.id;

      const {
        sale_id = null,
        requested_medicine_data_id,
        substituted_pharmacy_medicine_id,
        reason = "out_of_stock",
      } = req.body;

      // Validate required fields
      if (!requested_medicine_data_id || !substituted_pharmacy_medicine_id) {
        console.log("❌ Missing required fields");
        return res.status(400).json({
          success: false,
          message:
            "requested_medicine_data_id and substituted_pharmacy_medicine_id are required",
        });
      }

      // Validate tenant admin_id resolved properly
      if (!tenantAdminId) {
        console.log("❌ tenantAdminId is undefined — JWT payload issue");
        return res.status(401).json({
          success: false,
          message: "Could not resolve tenant admin",
        });
      }

      // Verify ownership of substituted medicine
      const [[owns]] = await db.query(
        `SELECT id FROM pharmacy_medicines 
         WHERE id = ? AND admin_id = ? AND status = 'active' 
         LIMIT 1`,
        [substituted_pharmacy_medicine_id, tenantAdminId]
      );

      if (!owns) {
        console.log("❌ Ownership check failed", {
          substituted_pharmacy_medicine_id,
          tenantAdminId,
        });
        return res.status(403).json({
          success: false,
          message: "Substituted medicine does not belong to your pharmacy",
        });
      }

      // Verify requested medicine exists in global catalog
      const [[catalog]] = await db.query(
        `SELECT id FROM medicine_data 
         WHERE id = ? AND status = 'active' 
         LIMIT 1`,
        [requested_medicine_data_id]
      );

      if (!catalog) {
        console.log("❌ requested_medicine_data_id not found in catalog");
        return res.status(400).json({
          success: false,
          message: "Requested medicine not found in catalog",
        });
      }

      // Insert the log
      const [result] = await db.query(
        `INSERT INTO pharmacy_substitution_log
         (admin_id, sale_id, requested_medicine_data_id,
          substituted_pharmacy_medicine_id, cashier_id, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          tenantAdminId,
          sale_id,
          requested_medicine_data_id,
          substituted_pharmacy_medicine_id,
          cashierId,
          reason,
        ]
      );

      console.log("✅ Substitution logged, id =", result.insertId);

      return res.status(201).json({
        success: true,
        data: { id: result.insertId },
      });
    } catch (err) {
      console.error("❌ Substitution log error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to log substitution",
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════
   PATCH /:id/link-sale — attach log to completed sale
   ═══════════════════════════════════════════════════════════ */
router.patch(
  "/:id/link-sale",
  authMiddleware,
  allowPermissions("pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);  // ✅ use helper
      const { sale_id } = req.body;

      if (!sale_id) {
        return res.status(400).json({ success: false, message: "sale_id required" });
      }

      // The sale has to be this tenant's. Without this check a log could be attached
      // to another clinic's sale id.
      const [saleRows] = await db.query(
        `SELECT id FROM pharmacy_sales WHERE id = ? AND admin_id = ? LIMIT 1`,
        [sale_id, tenantAdminId]
      );
      if (!saleRows.length) {
        return res.status(404).json({ success: false, message: "Sale not found" });
      }

      const [result] = await db.query(
        `UPDATE pharmacy_substitution_log
         SET sale_id = ?
         WHERE id = ? AND admin_id = ?`,
        [sale_id, req.params.id, tenantAdminId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: "Log not found" });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("Link-sale error:", err);
      return res.status(500).json({ success: false, message: "Link failed" });
    }
  }
);

module.exports = router;