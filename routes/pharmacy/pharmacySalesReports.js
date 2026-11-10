// routes/pharmacy/salesReports.js
// Sales reports with flexible date filters + PDF/Excel/CSV export
//
// Endpoints:
//   GET /daily?date=YYYY-MM-DD                → Single day
//   GET /range?start=YYYY-MM-DD&end=YYYY-MM-DD → Custom range
//   GET /monthly?year=YYYY&month=MM           → Full month
//   GET /yearly?year=YYYY                     → Full year
//   GET /custom?period=today|yesterday|week|month|quarter|year
//
// Every endpoint supports:
//   ?format=json (default) | csv | excel | pdf
//   ?group_by=day | week | month | payment_method | staff | medicine
//
// Install once:
//   npm install exceljs pdfkit

const express = require("express");
const router = express.Router();
const db = require("../../db");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
// Branch scoping. Admins may pass ?branch=<name> (the Branch dropdown); staff are always
// pinned to their own staff.branch. With one branch configured nothing is filtered.
const { resolveScope, historyBranchSql, recordScope, sendBranchError } = require("../../utils/pharmacyBranch");

/* Branch guard for the two PDFs that take a sale id (invoice, receipt) — 26 Oct 2026.
   Both checked admin_id only, so a staff member could print any branch's bill by id even
   though the sales list hides other branches. Staff get 404 for another branch's sale, the
   same as for no sale; admin passes for every branch. Mirrors denySaleOutsideBranch in
   pharmacySales.js. Returns true when it has already answered. */
async function denySaleOutsideBranch(req, res, saleId, tenantAdminId) {
  const [rows] = await db.query(
    `SELECT branch FROM pharmacy_sales WHERE id = ? AND admin_id = ? LIMIT 1`,
    [saleId, tenantAdminId]
  );
  if (!rows.length) return false;
  try {
    await recordScope(db, req, rows[0].branch, { notFound: "Sale not found" });
    return false;
  } catch (e) {
    if (sendBranchError(res, e)) return true;
    throw e;
  }
}
// Stock is counted in TABLETS in the database; reorder_level, maximum_stock and the
// prices are per STRIP. These reports therefore convert to strips before comparing
// or valuing anything. See utils/pharmacyStripView.js.
const { stripsOf } = require("../../utils/pharmacyStripView");
const { unitsPerPack } = require("../../utils/pharmacyUnits");

const buildCollectionReportPdf = require("../../utils/buildCollectionReportPdf");
const buildLowStockReportPdf = require("../../utils/buildLowStockReportPdf");

/* ───── Low stock query, shared by /low-stock and /low-stock/pdf (26 Oct 2026) ─────
   reorder_level lives on pharmacy_medicines — one number per medicine, not per branch —
   but stock lives per branch, and a branch can only sell its own batches (POS uses the
   strict batchFilter). So "low" is a per-branch question:

     one branch picked / staff     that branch's stock vs reorder_level   (unchanged)
     single-branch pharmacy        whole stock vs reorder_level           (unchanged)
     multi-branch, All branches    EVERY branch checked on its own — one row per
                                   medicine × branch that is low.

   Before this, "All branches" ADDED every branch's stock together and compared the total
   with reorder_level: Dolo 0 in P2 + 40 in P1 = 40, above a reorder level of 20, so Dolo
   vanished from All even though P2 was out of it. Hence "All shows less than one branch".

   Batches with no branch (stock from before branches) count for no branch in the per-
   branch view, the same as at the POS, where no branch can sell them either. */
function lowStockQuery(tenantAdminId, scope) {
  const perBranch = !!(scope && scope.multi && !scope.filter && scope.branches && scope.branches.length);
  const bKey = scope && scope.filter ? scope.key : null;

  const qtyExpr = "COALESCE(SUM(FLOOR(pmb.quantity_available / GREATEST(COALESCE(pmb.units_per_pack, 1), 1))), 0)";

  let branchJoin = "";
  let branchCol = "NULL";
  let batchBranch = "";
  let groupBranch = "";
  let orderBranch = "";
  const branchParams = [];
  const batchParams = [];

  if (perBranch) {
    // a derived table of this tenant's branches: (name to show, lower-cased key to match)
    branchJoin = "\n         CROSS JOIN (" +
      scope.branches.map(() => "SELECT ? AS branch, ? AS bkey").join(" UNION ALL ") +
      ") br";
    scope.branches.forEach((b) => branchParams.push(b, String(b).trim().toLowerCase()));
    branchCol = "br.branch";
    batchBranch = " AND pmb.branch IS NOT NULL AND LOWER(TRIM(pmb.branch)) = br.bkey";
    groupBranch = "br.branch, br.bkey, ";
    orderBranch = ", br.branch ASC";
  } else if (bKey) {
    batchBranch = " AND pmb.branch IS NOT NULL AND LOWER(TRIM(pmb.branch)) = ?";
    batchParams.push(bKey);
  }

  const sql = `SELECT
            ${branchCol}                AS branch,
            pm.id                       AS pharmacy_medicine_id,
            pm.medicine_data_id         AS medicine_data_id,
            pm.reorder_level            AS reorder_level,
            md.medicine_name            AS medicine_name,
            md.generic_name             AS generic_name,
            md.strength                 AS strength,
            md.dosage_form              AS form,
            ${qtyExpr} AS quantity_available,
            MIN(CASE WHEN pmb.quantity_available > 0 THEN pmb.expiry_date END) AS nearest_expiry,
            COUNT(DISTINCT CASE WHEN pmb.quantity_available > 0 THEN pmb.id END) AS batch_count
         FROM pharmacy_medicines pm
         JOIN medicine_data md
           ON md.id = pm.medicine_data_id${branchJoin}
         LEFT JOIN pharmacy_medicine_batches pmb
           ON pmb.medicine_id = pm.id
          AND pmb.admin_id = ?${batchBranch}
          AND pmb.status = 'active'
          AND (pmb.expiry_date IS NULL OR pmb.expiry_date >= CURDATE())
         WHERE pm.admin_id = ?
           AND pm.status = 'active'
           AND pm.reorder_level IS NOT NULL
           AND pm.reorder_level > 0
         GROUP BY ${groupBranch}pm.id, pm.medicine_data_id, pm.reorder_level,
                  md.medicine_name, md.generic_name, md.strength, md.dosage_form
         HAVING ${qtyExpr} <= pm.reorder_level
         ORDER BY (${qtyExpr} / pm.reorder_level) ASC,
                  pm.reorder_level DESC,
                  md.medicine_name ASC${orderBranch}`;

  // placeholder order: derived-table branches, batch admin_id, batch branch, pm admin_id
  return { sql, params: [...branchParams, tenantAdminId, ...batchParams, tenantAdminId], perBranch };
}
/* ============================================================
   HELPERS
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

function formatCurrency(val) {
  return `₹${Number(val || 0).toFixed(2)}`;
}

function pad(n) { return String(n).padStart(2, "0"); }

// Normalize a "period" shortcut into start/end dates
function periodToDates(period) {
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  switch (period) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      const d = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
      return { start: d, end: d };
    }
    case "week": {
      const w = new Date(now); w.setDate(w.getDate() - 7);
      const s = `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}`;
      return { start: s, end: today };
    }
    case "month": {
      const s = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
      return { start: s, end: today };
    }
    case "quarter": {
      const q = Math.floor(now.getMonth() / 3);
      const s = `${now.getFullYear()}-${pad(q * 3 + 1)}-01`;
      return { start: s, end: today };
    }
    case "year": {
      return { start: `${now.getFullYear()}-01-01`, end: today };
    }
    default:
      return { start: today, end: today };
  }
}

/* ============================================================
   CORE: Fetch aggregated report data
============================================================ */
async function fetchReportData(tenantAdminId, start, end, groupBy = "day", branch = null) {
  // One branch filter, applied to all four queries below. Empty when not filtering.
  const bSale = branch ? historyBranchSql("") : "";
  const bPs   = branch ? historyBranchSql("ps") : "";
  const bp    = branch ? [String(branch).trim().toLowerCase()] : [];
  // 1. Summary totals
  const [summary] = await db.query(
    `SELECT 
       COUNT(*) AS total_sales,
       COALESCE(SUM(grand_total), 0) AS total_revenue,
       COALESCE(SUM(paid_amount), 0) AS total_collected,
       COALESCE(SUM(due_amount), 0) AS total_pending,
       COALESCE(SUM(subtotal), 0) AS total_subtotal,
       COALESCE(SUM(tax_amount), 0) AS total_tax,
       COALESCE(SUM(discount_amount), 0) AS total_discount,
       COALESCE(AVG(grand_total), 0) AS avg_sale_value,
       SUM(CASE WHEN payment_method = 'cash' THEN grand_total ELSE 0 END) AS cash_sales,
       SUM(CASE WHEN payment_method = 'card' THEN grand_total ELSE 0 END) AS card_sales,
       SUM(CASE WHEN payment_method = 'upi' THEN grand_total ELSE 0 END) AS upi_sales,
       SUM(CASE WHEN payment_method = 'credit' THEN grand_total ELSE 0 END) AS credit_sales,
       SUM(CASE WHEN payment_method = 'bank_transfer' THEN grand_total ELSE 0 END) AS bank_sales,
       SUM(CASE WHEN payment_method = 'mixed' THEN grand_total ELSE 0 END) AS mixed_sales,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
       SUM(CASE WHEN status = 'returned' THEN 1 ELSE 0 END) AS returned_count,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count
     FROM pharmacy_sales
     WHERE admin_id = ? 
       AND DATE(sale_date) BETWEEN ? AND ?${bSale}`,
    [tenantAdminId, start, end, ...bp]
  );

  // 2. Grouped breakdown
  let groupClause, groupLabel;
  switch (groupBy) {
  case "week":
    groupClause = "YEARWEEK(sale_date, 1)";
    groupLabel = "ANY_VALUE(CONCAT('Week ', WEEK(sale_date, 1), ' ', YEAR(sale_date)))";
    break;
  case "month":
    groupClause = "DATE_FORMAT(sale_date, '%Y-%m')";
    groupLabel = "ANY_VALUE(DATE_FORMAT(sale_date, '%b %Y'))";
    break;
  case "payment_method":
    groupClause = "payment_method";
    groupLabel = "payment_method";
    break;
  case "staff":
    groupClause = "sold_by";
    groupLabel = "sold_by";
    break;
  case "day":
  default:
    groupClause = "DATE(sale_date)";
    groupLabel = "DATE(sale_date)";
}

  const [breakdown] = await db.query(
    `SELECT 
       ${groupClause} AS group_key,
       ${groupLabel} AS group_label,
       COUNT(*) AS total_sales,
       SUM(grand_total) AS total_revenue,
       SUM(paid_amount) AS total_collected,
       SUM(due_amount) AS total_pending,
       SUM(tax_amount) AS total_tax
     FROM pharmacy_sales
     WHERE admin_id = ? 
       AND DATE(sale_date) BETWEEN ? AND ?
       AND status = 'completed'${bSale}
     GROUP BY ${groupClause}
     ORDER BY ${groupClause} ASC`,
    [tenantAdminId, start, end, ...bp]
  );

  // 3. Top selling medicines
  const [topMedicines] = await db.query(
    `SELECT 
       psi.medicine_id, 
       md.medicine_name,
       md.brand_name,
       SUM(psi.quantity) AS units_sold,
       SUM(psi.total_amount) AS revenue,
       COUNT(DISTINCT psi.sale_id) AS transactions
     FROM pharmacy_sale_items psi
     JOIN pharmacy_sales ps          ON ps.id = psi.sale_id
     JOIN pharmacy_medicines pm      ON pm.id = psi.medicine_id
     JOIN medicine_data md           ON md.id = pm.medicine_data_id
     WHERE ps.admin_id = ? 
       AND DATE(ps.sale_date) BETWEEN ? AND ?
       AND ps.status = 'completed'${bPs}
     GROUP BY psi.medicine_id
     ORDER BY revenue DESC
     LIMIT 10`,
    [tenantAdminId, start, end, ...bp]
  );

  // 4. Detailed transactions
  const [transactions] = await db.query(
    `SELECT 
       ps.id, ps.sale_number, ps.sale_date,
       ps.customer_name, ps.customer_phone,
       ps.subtotal, ps.discount_amount, ps.tax_amount, ps.grand_total,
       ps.paid_amount, ps.due_amount,
       ps.payment_method, ps.payment_status, ps.status,
       s.name AS sold_by_name
     FROM pharmacy_sales ps
     LEFT JOIN staff s ON s.id = ps.sold_by
     WHERE ps.admin_id = ? 
       AND DATE(ps.sale_date) BETWEEN ? AND ?${bPs}
     ORDER BY ps.sale_date DESC`,
    [tenantAdminId, start, end, ...bp]
  );

  return {
    summary: summary[0],
    breakdown,
    topMedicines,
    transactions,
  };
}

async function fetchPharmacyInfo(tenantAdminId) {
  const [rows] = await db.query(
    `SELECT name, mobile, address, company_name 
     FROM admins WHERE id = ? LIMIT 1`,
    [tenantAdminId]
  );
  return rows[0] || {};
}

/* ============================================================
   EXPORTERS
============================================================ */

// CSV export
function exportCSV(res, data, filename) {
  const { summary, transactions } = data;

  let csv = "Sales Report Summary\n";
  csv += `Total Sales,${summary.total_sales}\n`;
  csv += `Total Revenue,${summary.total_revenue}\n`;
  csv += `Total Collected,${summary.total_collected}\n`;
  csv += `Total Pending,${summary.total_pending}\n`;
  csv += `Total Tax,${summary.total_tax}\n`;
  csv += `Total Discount,${summary.total_discount}\n`;
  csv += "\nTransactions\n";
  csv += "Sale Number,Date,Customer,Phone,Subtotal,Discount,Tax,Grand Total,Paid,Due,Method,Status,Staff\n";
  
  transactions.forEach(t => {
    csv += [
      t.sale_number,
      new Date(t.sale_date).toISOString().split("T")[0],
      `"${(t.customer_name || "Walk-in").replace(/"/g, '""')}"`,
      t.customer_phone || "",
      t.subtotal,
      t.discount_amount,
      t.tax_amount,
      t.grand_total,
      t.paid_amount,
      t.due_amount,
      t.payment_method,
      t.status,
      `"${(t.sold_by_name || "").replace(/"/g, '""')}"`,
    ].join(",") + "\n";
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
  return res.send(csv);
}

// Excel export
async function exportExcel(res, data, filename, meta = {}) {
  const { summary, breakdown, topMedicines, transactions } = data;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Caredesk360";
  workbook.created = new Date();

  // SHEET 1: Summary
  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.columns = [
    { header: "Metric", key: "metric", width: 30 },
    { header: "Value", key: "value", width: 20 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.getRow(1).fill = {
    type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" }
  };
  summarySheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };

  summarySheet.addRows([
    { metric: "Report Period", value: `${meta.start} to ${meta.end}` },
    { metric: "Pharmacy", value: meta.pharmacyName || "" },
    { metric: "Generated At", value: new Date().toLocaleString("en-IN") },
    {},
    { metric: "Total Sales", value: summary.total_sales },
    { metric: "Total Revenue", value: formatCurrency(summary.total_revenue) },
    { metric: "Total Collected", value: formatCurrency(summary.total_collected) },
    { metric: "Total Pending", value: formatCurrency(summary.total_pending) },
    { metric: "Total Tax (GST)", value: formatCurrency(summary.total_tax) },
    { metric: "Total Discount", value: formatCurrency(summary.total_discount) },
    { metric: "Avg Sale Value", value: formatCurrency(summary.avg_sale_value) },
    {},
    { metric: "Cash Sales", value: formatCurrency(summary.cash_sales) },
    { metric: "Card Sales", value: formatCurrency(summary.card_sales) },
    { metric: "UPI Sales", value: formatCurrency(summary.upi_sales) },
    { metric: "Bank Transfer", value: formatCurrency(summary.bank_sales) },
    { metric: "Credit Sales", value: formatCurrency(summary.credit_sales) },
    { metric: "Mixed", value: formatCurrency(summary.mixed_sales) },
    {},
    { metric: "Completed", value: summary.completed_count },
    { metric: "Cancelled", value: summary.cancelled_count },
    { metric: "Returned", value: summary.returned_count },
  ]);

  // SHEET 2: Breakdown by period
  const breakdownSheet = workbook.addWorksheet("Breakdown");
  breakdownSheet.columns = [
    { header: "Period", key: "period", width: 20 },
    { header: "Sales Count", key: "count", width: 15 },
    { header: "Revenue", key: "revenue", width: 18 },
    { header: "Collected", key: "collected", width: 18 },
    { header: "Pending", key: "pending", width: 18 },
    { header: "Tax", key: "tax", width: 15 },
  ];
  breakdownSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  breakdownSheet.getRow(1).fill = {
    type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" }
  };

  breakdown.forEach(b => {
    breakdownSheet.addRow({
      period: String(b.group_label),
      count: b.total_sales,
      revenue: Number(b.total_revenue),
      collected: Number(b.total_collected),
      pending: Number(b.total_pending),
      tax: Number(b.total_tax),
    });
  });

  // SHEET 3: Top Medicines
  const medSheet = workbook.addWorksheet("Top Medicines");
  medSheet.columns = [
    { header: "Medicine", key: "name", width: 30 },
    { header: "Brand", key: "brand", width: 20 },
    { header: "Units Sold", key: "units", width: 15 },
    { header: "Transactions", key: "txn", width: 15 },
    { header: "Revenue", key: "revenue", width: 18 },
  ];
  medSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  medSheet.getRow(1).fill = {
    type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" }
  };

  topMedicines.forEach(m => {
    medSheet.addRow({
      name: m.medicine_name,
      brand: m.brand_name || "",
      units: m.units_sold,
      txn: m.transactions,
      revenue: Number(m.revenue),
    });
  });

  // SHEET 4: All Transactions
  const txSheet = workbook.addWorksheet("Transactions");
  txSheet.columns = [
    { header: "Sale #", key: "sale_number", width: 20 },
    { header: "Date", key: "date", width: 12 },
    { header: "Customer", key: "customer", width: 25 },
    { header: "Phone", key: "phone", width: 15 },
    { header: "Subtotal", key: "subtotal", width: 12 },
    { header: "Discount", key: "discount", width: 12 },
    { header: "Tax", key: "tax", width: 12 },
    { header: "Grand Total", key: "total", width: 14 },
    { header: "Paid", key: "paid", width: 12 },
    { header: "Due", key: "due", width: 12 },
    { header: "Method", key: "method", width: 10 },
    { header: "Status", key: "status", width: 12 },
    { header: "Sold By", key: "staff", width: 20 },
  ];
  txSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  txSheet.getRow(1).fill = {
    type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" }
  };

  transactions.forEach(t => {
    txSheet.addRow({
      sale_number: t.sale_number,
      date: new Date(t.sale_date).toLocaleDateString("en-IN"),
      customer: t.customer_name || "Walk-in",
      phone: t.customer_phone || "",
      subtotal: Number(t.subtotal),
      discount: Number(t.discount_amount),
      tax: Number(t.tax_amount),
      total: Number(t.grand_total),
      paid: Number(t.paid_amount),
      due: Number(t.due_amount),
      method: t.payment_method,
      status: t.status,
      staff: t.sold_by_name || "",
    });
  });

  // Freeze headers on all sheets
  [summarySheet, breakdownSheet, medSheet, txSheet].forEach(s => {
    s.views = [{ state: "frozen", ySplit: 1 }];
  });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  await workbook.xlsx.write(res);
  return res.end();
}

// PDF export
function exportPDF(res, data, filename, meta = {}) {
  const { summary, breakdown, topMedicines, transactions } = data;

  const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
  doc.pipe(res);

  // ⭐ swallow render errors so the response doesn't double-fault
  doc.on("error", (err) => {
    console.error("PDF stream error:", err);
    try { res.end(); } catch {}
  });

  try {
    // … all your existing drawing code …
    doc.end();
  } catch (err) {
    console.error("PDF render error:", err);
    try { doc.end(); } catch {}
    try { if (!res.writableEnded) res.end(); } catch {}
  }
}


/* ============================================================
   ROUTE: Main dispatcher
   Handles all report types via query params
============================================================ */
async function handleReport(req, res, start, end) {
  try {
    const tenantAdminId = getTenantAdminId(req);
    const { format = "json", group_by = "day" } = req.query;

    // Validate dates
    if (!start || !end) {
      return res.status(400).json({
        success: false, message: "start and end dates are required",
      });
    }

    const startDate = new Date(start);
    const endDate = new Date(end);
    if (isNaN(startDate) || isNaN(endDate)) {
      return res.status(400).json({
        success: false, message: "Invalid date format. Use YYYY-MM-DD",
      });
    }
    if (startDate > endDate) {
      return res.status(400).json({
        success: false, message: "start date cannot be after end date",
      });
    }

    // Cap range to 2 years
    const diffDays = (endDate - startDate) / (1000 * 60 * 60 * 24);
    if (diffDays > 730) {
      return res.status(400).json({
        success: false, message: "Range cannot exceed 2 years",
      });
    }

    // Which branch this report covers. Admins pick one with the Branch dropdown and may
    // leave it on "All branches"; staff are always pinned to their own branch.
    let scope;
    try {
      scope = await resolveScope(db, req, { wanted: req.query.branch });
    } catch (e) {
      if (sendBranchError(res, e)) return;
      throw e;
    }
    const branch = scope.filter ? scope.key : null;

    const data = await fetchReportData(tenantAdminId, start, end, group_by, branch);
    const pharmacy = await fetchPharmacyInfo(tenantAdminId);
    const branchTag = scope.branch ? `_${String(scope.branch).replace(/[^\w-]+/g, "-")}` : "";
    const filename = `sales_report_${start}_to_${end}${branchTag}`;
    const meta = {
      start, end,
      branch: scope.branch || null,
      pharmacyName: pharmacy.company_name || pharmacy.name || "",
    };

    // Route to exporter
    switch (format.toLowerCase()) {
      case "csv":
        return exportCSV(res, data, filename);
      case "excel":
      case "xlsx":
        return await exportExcel(res, data, filename, meta);
      case "pdf":
        return exportPDF(res, data, filename, meta);
      case "json":
      default:
        return res.json({
          success: true,
          period: { start, end, days: Math.round(diffDays) + 1 },
          group_by,
          branch: scope.branch || null,
          branches: scope.branches || [],
          ...data,
        });
    }
  } catch (err) {
    console.error("Report error:", err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false, message: "Failed to generate report", error: err.message,
      });
    }
  }
}

/* ============================================================
   ENDPOINTS
============================================================ */

// 1. Daily report
router.get(
  "/daily",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    return handleReport(req, res, date, date);
  }
);

// 2. Date range
router.get(
  "/range",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    const { start, end } = req.query;
    return handleReport(req, res, start, end);
  }
);

// 3. Monthly
router.get(
  "/monthly",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    const now = new Date();
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);

    if (month < 1 || month > 12) {
      return res.status(400).json({ success: false, message: "month must be 1-12" });
    }

    const start = `${year}-${pad(month)}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${year}-${pad(month)}-${pad(lastDay)}`;

    return handleReport(req, res, start, end);
  }
);

// 4. Yearly
router.get(
  "/yearly",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    // Default group_by to month for yearly
    if (!req.query.group_by) req.query.group_by = "month";
    return handleReport(req, res, start, end);
  }
);

// 5. Preset periods
router.get(
  "/custom",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    const period = req.query.period || "today";
    const validPeriods = ["today", "yesterday", "week", "month", "quarter", "year"];
    if (!validPeriods.includes(period)) {
      return res.status(400).json({
        success: false,
        message: `Invalid period. Use: ${validPeriods.join(", ")}`,
      });
    }
    const { start, end } = periodToDates(period);
    return handleReport(req, res, start, end);
  }
);

// Helper: fetch logo as buffer (works with file path OR URL)
async function getLogoBuffer(logoSource) {
  if (!logoSource) return null;
 
  try {
    // Check if it's a URL
    if (
      logoSource.startsWith("http://") ||
      logoSource.startsWith("https://")
    ) {
      const response = await axios.get(logoSource, {
        responseType: "arraybuffer",
        timeout: 5000,
      });
      return Buffer.from(response.data);
    }
 
    // Otherwise treat as file path
    let filePath = logoSource;
 
    // If relative, resolve from project root
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(process.cwd(), logoSource);
    }
 
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath);
    }
 
    return null;
  } catch (err) {
    console.error("Logo fetch error:", err.message);
    return null;
  }
}
 
router.get(
  "/:id/invoice/pdf",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
 
      if (!id || isNaN(Number(id))) {
        return res.status(400).json({
          success: false,
          message: "Invalid sale ID",
        });
      }
 
      // ============================================================
      // 1. FETCH SALE + PHARMACY + CUSTOMER
      // ============================================================
 
      if (await denySaleOutsideBranch(req, res, id, tenantAdminId)) return;
      const [saleRows] = await db.query(
        `
        SELECT 
          ps.id,
          ps.sale_number,
          ps.customer_id,
          ps.customer_name,
          ps.customer_phone,
          ps.prescription_id,
          ps.doctor_name,
          ps.sale_date,
          ps.subtotal,
          ps.discount_amount,
          ps.tax_amount,
          ps.grand_total,
          ps.paid_amount,
          ps.due_amount,
          ps.payment_method,
          ps.payment_status,
          ps.status,
          
          a.company_name AS pharmacy_name,
          a.company_logo AS pharmacy_logo,
          a.address      AS pharmacy_address,
          a.mobile       AS pharmacy_phone,
          a.email        AS pharmacy_email,
          
          cp.email    AS customer_email,
          cp.age      AS customer_age,
          cp.gender   AS customer_gender
          
        FROM pharmacy_sales ps
        LEFT JOIN admins a                 ON a.id  = ps.admin_id
        LEFT JOIN pharmacy_customer_pos cp ON cp.id = ps.customer_id
        WHERE ps.id = ? AND ps.admin_id = ?
        LIMIT 1
        `,
        [id, tenantAdminId]
      );
 
      if (!saleRows.length) {
        return res.status(404).json({
          success: false,
          message: "Sale not found",
        });
      }
 
      const sale = saleRows[0];
 
      // ============================================================
      // 2. FETCH SALE ITEMS
      // ============================================================
 
      const [items] = await db.query(
        `
        SELECT 
          psi.quantity,
          psi.unit_price,
          psi.discount_amount,
          psi.gst_percentage,
          psi.tax_amount,
          psi.total_amount,
          md.medicine_name,
          pm.hsn_code,
          pmb.mrp,
          pmb.batch_number,
          pmb.expiry_date
        FROM pharmacy_sale_items psi
        JOIN pharmacy_medicines pm          ON pm.id  = psi.medicine_id
        JOIN medicine_data md               ON md.id  = pm.medicine_data_id
        JOIN pharmacy_medicine_batches pmb  ON pmb.id = psi.batch_id
        WHERE psi.sale_id = ?
        ORDER BY psi.id ASC
        `,
        [id]
      );
 
      if (!items.length) {
        return res.status(404).json({
          success: false,
          message: "No items found for this sale",
        });
      }
 
      // ============================================================
      // 3. FETCH LOGO (before PDF starts)
      // ============================================================
 
      const logoBuffer = await getLogoBuffer(sale.pharmacy_logo);
 
      // ============================================================
      // 4. GENERATE PDF
      // ============================================================
 
      const doc = new PDFDocument({
        size: "A4",
        margin: 40,
        bufferPages: true,
      });
 
      const filename = `Invoice-${sale.sale_number}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
 
      doc.pipe(res);
 
      // ============================================================
      // 5. TOP CENTERED LABEL
      // ============================================================
 
      doc
        .fontSize(8)
        .fillColor("#666666")
        .text("ORIGINAL FOR RECIPIENT", 40, 30, {
          align: "center",
          width: 515,
        });
 
      // ============================================================
      // 6. PHARMACY LOGO + CONTACT
      // ============================================================
 
      if (logoBuffer) {
        // Display logo (max 150x60 dimensions)
        try {
          doc.image(logoBuffer, 40, 50, {
            fit: [150, 60],
            align: "left",
          });
        } catch (imgErr) {
          console.error("Logo render error:", imgErr.message);
          // Fallback to text if image is corrupt
          doc
            .fontSize(24)
            .fillColor("#2D606C")
            .font("Helvetica-Bold")
            .text(sale.pharmacy_name || "Pharmacy", 40, 55);
        }
      } else {
        // No logo — fall back to text
        doc
          .fontSize(24)
          .fillColor("#2D606C")
          .font("Helvetica-Bold")
          .text(sale.pharmacy_name || "Pharmacy", 40, 55);
      }
 
      // Pharmacy contact info (right of logo)
      doc
        .fontSize(9)
        .fillColor("#000000")
        .font("Helvetica")
        .text(`Phone: ${sale.pharmacy_phone || ""}`, 40, 115);
 
      doc.text(`Email: ${sale.pharmacy_email || ""}`, 40, 130);
 
      // Horizontal separator
      doc
        .moveTo(40, 150)
        .lineTo(555, 150)
        .strokeColor("#000000")
        .lineWidth(1)
        .stroke();
 
      // ============================================================
      // 7. BILL TO + INVOICE DETAILS
      // ============================================================
 
      const billToY = 165;
 
      // LEFT: BILL TO
      doc
        .rect(40, billToY, 260, 100)
        .strokeColor("#000000")
        .lineWidth(0.5)
        .stroke();
 
      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .fillColor("#000000")
        .text("BILL TO", 50, billToY + 8);
 
      let billY = billToY + 24;
 
      doc
        .fontSize(9)
        .font("Helvetica")
        .text(
          sale.customer_name || "Walk-in Customer",
          50,
          billY,
          { width: 245 }
        );
      billY += 16;
 
      doc.text(`Phone: ${sale.customer_phone || "-"}`, 50, billY);
      billY += 14;
 
      if (sale.customer_email) {
        doc.text(
          `Email: ${sale.customer_email}`,
          50,
          billY,
          { width: 245 }
        );
        billY += 14;
      }
 
      if (sale.customer_age || sale.customer_gender) {
        const parts = [];
        if (sale.customer_age) parts.push(`Age: ${sale.customer_age}`);
        if (sale.customer_gender)
          parts.push(`Gender: ${sale.customer_gender}`);
        doc.text(parts.join("  |  "), 50, billY);
      }
 
      // RIGHT: Invoice details
      doc
        .rect(300, billToY, 255, 100)
        .strokeColor("#000000")
        .lineWidth(0.5)
        .stroke();
 
      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .text(`Invoice No: ${sale.id}`, 310, billToY + 8);
 
      const dateStr = new Date(sale.sale_date).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
 
      doc
        .fontSize(9)
        .font("Helvetica")
        .text(`Invoice Date: ${dateStr}`, 310, billToY + 26);
 
      doc.text(`Sale No: ${sale.sale_number}`, 310, billToY + 42);
 
      if (sale.doctor_name) {
        doc.text(`Doctor: ${sale.doctor_name}`, 310, billToY + 58);
      }
 
      if (sale.prescription_id) {
        doc.text(
          `Prescription: #${sale.prescription_id}`,
          310,
          billToY + 74
        );
      }
 
      // ============================================================
      // 8. ITEMS TABLE HEADER (TEAL #2D606C)
      // ============================================================
 
      const tableTop = 285;
      const tableHeaderHeight = 25;
 
      const cols = {
        sl:       { x: 40,  w: 30  },
        item:     { x: 70,  w: 130 },
        hsn:      { x: 200, w: 50  },
        qty:      { x: 250, w: 55  },
        mrp:      { x: 305, w: 55  },
        rate:     { x: 360, w: 65  },
        tax:      { x: 425, w: 65  },
        amount:   { x: 490, w: 65  },
      };
 
      // Table header background — teal
      doc
        .rect(40, tableTop, 515, tableHeaderHeight)
        .fillColor("#2D606C")
        .fill();
 
      doc
        .fillColor("#FFFFFF")
        .fontSize(9)
        .font("Helvetica-Bold");
 
      const headerTextY = tableTop + 8;
      doc.text("#", cols.sl.x + 5, headerTextY);
      doc.text("Items", cols.item.x + 5, headerTextY);
      doc.text("HSN", cols.hsn.x + 5, headerTextY);
      doc.text("Quantity", cols.qty.x + 5, headerTextY);
      doc.text("MRP", cols.mrp.x + 5, headerTextY);
      doc.text("Rate Per Unit", cols.rate.x + 5, headerTextY);
      doc.text("Tax Per Unit", cols.tax.x + 5, headerTextY);
      doc.text("Amount", cols.amount.x + 5, headerTextY);
 
      // ============================================================
      // 9. ITEMS TABLE ROWS
      // ============================================================
 
      let currentY = tableTop + tableHeaderHeight;
      const rowHeight = 25;
 
      doc.fillColor("#000000").fontSize(9).font("Helvetica");
 
      let totalQty = 0;
 
      items.forEach((item, idx) => {
        if (idx % 2 === 0) {
          doc
            .rect(40, currentY, 515, rowHeight)
            .fillColor("#F5F9FA")
            .fill();
        }
 
        doc.fillColor("#000000");
        const rowTextY = currentY + 8;
 
        doc.text(String(idx + 1), cols.sl.x + 5, rowTextY);
 
        doc.text(
          item.medicine_name || "-",
          cols.item.x + 5,
          rowTextY,
          { width: cols.item.w - 10, ellipsis: true }
        );
 
        doc.text(item.hsn_code || "-", cols.hsn.x + 5, rowTextY);
 
        doc.text(
          `${item.quantity} Nos`,
          cols.qty.x + 5,
          rowTextY
        );
 
        doc.text(
          `₹${Number(item.mrp || 0).toFixed(2)}`,
          cols.mrp.x + 5,
          rowTextY
        );
 
        doc.text(
          `₹${Number(item.unit_price).toFixed(2)}`,
          cols.rate.x + 5,
          rowTextY
        );
 
        const taxPerUnit =
          item.quantity > 0
            ? Number(item.tax_amount) / item.quantity
            : 0;
 
        doc.text(
          `₹${taxPerUnit.toFixed(2)} (${item.gst_percentage}%)`,
          cols.tax.x + 5,
          rowTextY,
          { width: cols.tax.w - 10 }
        );
 
        doc.text(
          `₹${Number(item.total_amount).toFixed(2)}`,
          cols.amount.x + 5,
          rowTextY
        );
 
        totalQty += item.quantity;
        currentY += rowHeight;
      });
 
      // Table outer border
      doc
        .rect(40, tableTop, 515, currentY - tableTop)
        .strokeColor("#000000")
        .lineWidth(0.5)
        .stroke();
 
      // Vertical column separators
      Object.values(cols).slice(1).forEach((col) => {
        doc
          .moveTo(col.x, tableTop)
          .lineTo(col.x, currentY)
          .stroke();
      });
 
      // ============================================================
      // 10. TOTAL ROW
      // ============================================================
 
      const totalRowY = currentY;
 
      doc
        .rect(40, totalRowY, 515, rowHeight)
        .strokeColor("#000000")
        .lineWidth(0.5)
        .stroke();
 
      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .fillColor("#000000")
        .text("Total", 100, totalRowY + 8);
 
      doc.text(
        totalQty.toFixed(2),
        cols.qty.x + 5,
        totalRowY + 8
      );
 
      doc.text(
        `₹${Number(sale.grand_total).toFixed(2)}`,
        cols.amount.x + 5,
        totalRowY + 8
      );
 
      Object.values(cols).slice(1).forEach((col) => {
        doc
          .moveTo(col.x, totalRowY)
          .lineTo(col.x, totalRowY + rowHeight)
          .stroke();
      });
 
      currentY = totalRowY + rowHeight + 15;
 
      // ============================================================
      // 11. RECEIVED / BALANCE ROW
      // ============================================================
 
      doc
        .rect(40, currentY, 257, 30)
        .strokeColor("#000000")
        .lineWidth(0.5)
        .stroke();
 
      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .text("Received Amount:", 50, currentY + 10);
 
      doc
        .font("Helvetica")
        .text(
          `₹${Number(sale.paid_amount).toFixed(2)}`,
          150,
          currentY + 10
        );
 
      doc
        .rect(298, currentY, 257, 30)
        .strokeColor("#000000")
        .lineWidth(0.5)
        .stroke();
 
      doc
        .font("Helvetica-Bold")
        .text("Balance:", 308, currentY + 10);
 
      doc
        .font("Helvetica")
        .text(
          `₹${Number(sale.due_amount).toFixed(2)}`,
          380,
          currentY + 10
        );
 
      currentY += 45;
 
      // ============================================================
      // 12. PAYMENT INFO
      // ============================================================
 
      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .fillColor("#000000")
        .text("Payment Method:", 50, currentY);
 
      doc
        .font("Helvetica")
        .text(
          sale.payment_method.toUpperCase(),
          150,
          currentY
        );
 
      doc
        .font("Helvetica-Bold")
        .text("Payment Status:", 300, currentY);
 
      doc
        .font("Helvetica")
        .fillColor(
          sale.payment_status === "paid"
            ? "#2E7D32"
            : sale.payment_status === "partial"
            ? "#F57C00"
            : "#D32F2F"
        )
        .text(
          sale.payment_status.toUpperCase(),
          395,
          currentY
        );
 
      doc.fillColor("#000000");
 
      // ============================================================
      // 13. FOOTER — Thank you note
      // ============================================================
 
      doc
        .fontSize(10)
        .font("Helvetica-Oblique")
        .fillColor("#666666")
        .text(
          "~ Thank You For Your Business ~",
          40,
          780,
          { align: "center", width: 515 }
        );
 
      // ============================================================
      // 14. FINALIZE
      // ============================================================
 
      doc.end();
 
    } catch (err) {
      console.error("Invoice PDF generation error:", err);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: "Failed to generate invoice PDF",
          ...(process.env.NODE_ENV !== "production" && {
            error: err.message,
          }),
        });
      }
    }
  }
);
 
 // Helper: fetch logo as buffer (works with file path OR URL)
async function getLogoBuffer(logoSource) {
  if (!logoSource) return null;
 
  try {
    if (
      logoSource.startsWith("http://") ||
      logoSource.startsWith("https://")
    ) {
      const response = await axios.get(logoSource, {
        responseType: "arraybuffer",
        timeout: 5000,
      });
      return Buffer.from(response.data);
    }
 
    let filePath = logoSource;
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(process.cwd(), logoSource);
    }
 
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath);
    }
 
    return null;
  } catch (err) {
    console.error("Logo fetch error:", err.message);
    return null;
  }
}
 
// Helper: Number to Indian words
function numberToWordsIndian(num) {
  if (num === 0) return "ZERO";
 
  const ones = [
    "", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN",
    "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN",
    "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN",
    "NINETEEN",
  ];
  const tens = [
    "", "", "TWENTY", "THIRTY", "FORTY", "FIFTY",
    "SIXTY", "SEVENTY", "EIGHTY", "NINETY",
  ];
 
  function twoDigit(n) {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? " " + ones[n % 10] : "");
  }
 
  function threeDigit(n) {
    let str = "";
    if (n >= 100) {
      str = ones[Math.floor(n / 100)] + " HUNDRED ";
      n = n % 100;
    }
    if (n > 0) str += twoDigit(n);
    return str.trim();
  }
 
  const rupees = Math.floor(num);
  let n = rupees;
  let words = "";
 
  const crore = Math.floor(n / 10000000);
  n = n % 10000000;
  const lakh = Math.floor(n / 100000);
  n = n % 100000;
  const thousand = Math.floor(n / 1000);
  n = n % 1000;
 
  if (crore) words += threeDigit(crore) + " CRORE ";
  if (lakh) words += threeDigit(lakh) + " LAKH ";
  if (thousand) words += threeDigit(thousand) + " THOUSAND ";
  if (n) words += threeDigit(n);
 
  return words.trim();
}
 
// Helper: fetch logo as buffer
async function getLogoBuffer(logoSource) {
  if (!logoSource) return null;
 
  try {
    if (
      logoSource.startsWith("http://") ||
      logoSource.startsWith("https://")
    ) {
      const response = await axios.get(logoSource, {
        responseType: "arraybuffer",
        timeout: 5000,
      });
      return Buffer.from(response.data);
    }
 
    let filePath = logoSource;
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(process.cwd(), logoSource);
    }
 
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath);
    }
 
    return null;
  } catch (err) {
    console.error("Logo fetch error:", err.message);
    return null;
  }
}
 
// Helper: Number to Indian words
function numberToWordsIndian(num) {
  if (num === 0) return "ZERO";
 
  const ones = [
    "", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN",
    "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN",
    "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN",
    "NINETEEN",
  ];
  const tens = [
    "", "", "TWENTY", "THIRTY", "FORTY", "FIFTY",
    "SIXTY", "SEVENTY", "EIGHTY", "NINETY",
  ];
 
  function twoDigit(n) {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? " " + ones[n % 10] : "");
  }
 
  function threeDigit(n) {
    let str = "";
    if (n >= 100) {
      str = ones[Math.floor(n / 100)] + " HUNDRED ";
      n = n % 100;
    }
    if (n > 0) str += twoDigit(n);
    return str.trim();
  }
 
  const rupees = Math.floor(num);
  let n = rupees;
  let words = "";
 
  const crore = Math.floor(n / 10000000);
  n = n % 10000000;
  const lakh = Math.floor(n / 100000);
  n = n % 100000;
  const thousand = Math.floor(n / 1000);
  n = n % 1000;
 
  if (crore) words += threeDigit(crore) + " CRORE ";
  if (lakh) words += threeDigit(lakh) + " LAKH ";
  if (thousand) words += threeDigit(thousand) + " THOUSAND ";
  if (n) words += threeDigit(n);
 
  return words.trim();
}
 
router.get(
  "/:id/receipt/pdf",
  authMiddleware,
  allowPermissions("pharmacy.sales.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
 
      if (!id || isNaN(Number(id))) {
        return res.status(400).json({
          success: false,
          message: "Invalid sale ID",
        });
      }
 
      // ============================================================
      // 1. FETCH SALE + PHARMACY + CUSTOMER
      // ============================================================
 
      if (await denySaleOutsideBranch(req, res, id, tenantAdminId)) return;
      const [saleRows] = await db.query(
        `
        SELECT 
          ps.id,
          ps.sale_number,
          ps.customer_name,
          ps.customer_phone,
          ps.doctor_name,
          ps.sale_date,
          ps.subtotal,
          ps.discount_amount,
          ps.tax_amount,
          ps.grand_total,
          ps.paid_amount,
          ps.due_amount,
          ps.payment_method,
          ps.payment_status,
          ps.status,
          
          a.company_name AS pharmacy_name,
          a.company_logo AS pharmacy_logo,
          a.address      AS pharmacy_address,
          a.mobile       AS pharmacy_phone,
          a.email        AS pharmacy_email
          
        FROM pharmacy_sales ps
        LEFT JOIN admins a ON a.id = ps.admin_id
        WHERE ps.id = ? AND ps.admin_id = ?
        LIMIT 1
        `,
        [id, tenantAdminId]
      );
 
      if (!saleRows.length) {
        return res.status(404).json({
          success: false,
          message: "Sale not found",
        });
      }
 
      const sale = saleRows[0];
 
      // ============================================================
      // 2. FETCH SALE ITEMS
      // ============================================================
 
      const [items] = await db.query(
        `
        SELECT 
          psi.quantity,
          psi.unit_price,
          psi.discount_amount,
          psi.gst_percentage,
          psi.tax_amount,
          psi.total_amount,
          md.medicine_name,
          pm.hsn_code,
          pmb.batch_number,
          pmb.expiry_date,
          pmb.mrp
        FROM pharmacy_sale_items psi
        JOIN pharmacy_medicines pm          ON pm.id  = psi.medicine_id
        JOIN medicine_data md               ON md.id  = pm.medicine_data_id
        JOIN pharmacy_medicine_batches pmb  ON pmb.id = psi.batch_id
        WHERE psi.sale_id = ?
        ORDER BY psi.id ASC
        `,
        [id]
      );
 
      if (!items.length) {
        return res.status(404).json({
          success: false,
          message: "No items found for this sale",
        });
      }
 
      // ============================================================
      // 3. FETCH LOGO
      // ============================================================
 
      const logoBuffer = await getLogoBuffer(sale.pharmacy_logo);
 
      // ============================================================
      // 4. DETERMINE PAPER SIZE (Half A4 vs Full A4)
      // ============================================================
      //
      // A4 dimensions: 595 × 842 points
      // Half A4:       595 × 421 points
      //
      // Estimation:
      //   - Fixed sections (header, patient info, totals, footer) ≈ 320 pts
      //   - Each item row ≈ 20 pts
      //
      //   Half A4 usable content: 421 - 30 (top) - 30 (bottom) = 361 pts
      //   Fixed content: 320 pts
      //   Space for items: 361 - 320 = 41 pts
      //   Max items in half A4: 41 / 20 = ~2 items
      //
      //   So threshold: If items > 3, use full A4
      // ============================================================
 
      const ITEMS_THRESHOLD = 3;
      const useFullA4 = items.length > ITEMS_THRESHOLD;
 
      // Custom paper size
      const paperSize = useFullA4
        ? "A4"                      // Full A4: 595 × 842
        : [595, 421];              // Half A4: 595 × 421
 
      // console.log(
      //   `📄 Paper size: ${useFullA4 ? "Full A4" : "Half A4"} (${items.length} items)`
      // );
 
      // ============================================================
      // 5. GENERATE PDF
      // ============================================================
 
      const doc = new PDFDocument({
        size: paperSize,
        margin: 20,
      });
 
      const filename = `Receipt-${sale.sale_number}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
 
      doc.pipe(res);
 
      // ============================================================
      // 6. TOP: Date/Time (compact)
      // ============================================================
 
      const printDate = new Date().toLocaleString("en-IN", {
        day: "numeric",
        month: "numeric",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
 
      doc
        .fontSize(7)
        .fillColor("#000000")
        .font("Helvetica")
        .text(printDate, 20, 15);
 
      doc.text("about:blank", 480, 15);
 
      // ============================================================
      // 7. LOGO + PHARMACY HEADER (compact for half A4)
      // ============================================================
 
      const headerY = 30;
 
      // Logo (smaller for half A4)
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, 30, headerY, {
            fit: [50, 50],
          });
        } catch (imgErr) {
          console.error("Logo error:", imgErr.message);
        }
      }
 
      // Pharmacy name (bold, compact)
      doc
        .fontSize(16)
        .font("Helvetica-Bold")
        .fillColor("#000000")
        .text(
          (sale.pharmacy_name || "PHARMACY").toUpperCase(),
          95,
          headerY + 3,
          { width: 340, align: "left" }
        );
 
      // GST/DL info (below pharmacy name)
      doc
        .fontSize(7)
        .font("Helvetica")
        .text(
          `GST NO : 36ADIPS7039J2ZK    DL.No: TG/17/01/2015-11610`,
          95,
          headerY + 25,
          { width: 340 }
        );
 
      // Right side: Address/Contact
      doc
        .fontSize(7)
        .font("Helvetica")
        .fillColor("#000000")
        .text("Near bus stand", 445, headerY);
 
      doc.text(
        (sale.pharmacy_address || "Sadasivpet - 502291").substring(0, 30),
        445,
        headerY + 9,
        { width: 130 }
      );
 
      doc.text(`Ph: 08455 - 252785`, 445, headerY + 22);
      doc.text(sale.pharmacy_phone || "9866653530", 445, headerY + 31);
 
      if (sale.pharmacy_email) {
        doc
          .fontSize(6)
          .text(sale.pharmacy_email, 445, headerY + 40, { width: 130 });
      }
 
      // Separator line
      doc
        .moveTo(20, 90)
        .lineTo(575, 90)
        .strokeColor("#000000")
        .lineWidth(1)
        .stroke();
 
      // ============================================================
      // 8. "Sale Bill" TITLE (centered)
      // ============================================================
 
      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .fillColor("#000000")
        .text("Sale Bill", 20, 95, {
          align: "center",
          width: 555,
        });
 
      // ============================================================
      // 9. PATIENT INFO BLOCK
      // ============================================================
 
      const infoY = 115;
 
      doc
        .fontSize(8)
        .font("Helvetica")
        .fillColor("#000000");
 
      // Left column
      doc.text("Patient", 20, infoY);
      doc.text(":", 75, infoY);
      doc
        .font("Helvetica-Bold")
        .text(sale.customer_name || "-", 90, infoY);
 
      doc
        .font("Helvetica")
        .text("Bill No", 20, infoY + 12);
      doc.text(":", 75, infoY + 12);
      doc
        .font("Helvetica-Bold")
        .text(sale.sale_number || "-", 90, infoY + 12);
 
      doc
        .font("Helvetica")
        .text("Reg No", 20, infoY + 24);
      doc.text(":", 75, infoY + 24);
      doc
        .font("Helvetica-Bold")
        .text("--", 90, infoY + 24);
 
      // Right column
      doc.font("Helvetica").text("Doctor", 310, infoY);
      doc.text(":", 365, infoY);
      doc
        .font("Helvetica-Bold")
        .text(sale.doctor_name || "-", 380, infoY);
 
      const dateStr = new Date(sale.sale_date).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
 
      doc.font("Helvetica").text("Date", 310, infoY + 12);
      doc.text(":", 365, infoY + 12);
      doc.font("Helvetica-Bold").text(dateStr, 380, infoY + 12);
 
      doc.font("Helvetica").text("Mobile", 310, infoY + 24);
      doc.text(":", 365, infoY + 24);
      doc
        .font("Helvetica-Bold")
        .text(
          `+91 ${sale.customer_phone || "-"}`,
          380,
          infoY + 24
        );
 
      // ============================================================
      // 10. ITEMS TABLE HEADER
      // ============================================================
 
      const tableTop = 160;
      const tableHeaderHeight = 18;
 
      const cols = {
        particular: { x: 20,  w: 130, label: "Particular (s)" },
        batch:      { x: 150, w: 55,  label: "Batch No" },
        exp:        { x: 205, w: 50,  label: "Exp Date" },
        rate:       { x: 255, w: 40,  label: "Rate" },
        qty:        { x: 295, w: 30,  label: "Qty" },
        gross:      { x: 325, w: 55,  label: "Gross(Rs)" },
        cgst:       { x: 380, w: 50,  label: "CGST(Rs)" },
        sgst:       { x: 430, w: 50,  label: "SGST(Rs)" },
        amount:     { x: 480, w: 90,  label: "Amount(Rs)" },
      };
 
      // Header background
      doc
        .rect(20, tableTop, 555, tableHeaderHeight)
        .fillColor("#F0F0F0")
        .fill();
 
      // Header text
      doc
        .fillColor("#000000")
        .fontSize(7)
        .font("Helvetica-Bold");
 
      const headerTextY = tableTop + 5;
      Object.values(cols).forEach((col) => {
        doc.text(col.label, col.x + 3, headerTextY, { width: col.w - 3 });
      });
 
      // Border lines
      doc
        .moveTo(20, tableTop)
        .lineTo(575, tableTop)
        .strokeColor("#000000")
        .lineWidth(0.5)
        .stroke();
 
      doc
        .moveTo(20, tableTop + tableHeaderHeight)
        .lineTo(575, tableTop + tableHeaderHeight)
        .stroke();
 
      // ============================================================
      // 11. ITEMS TABLE ROWS
      // ============================================================
 
      let currentY = tableTop + tableHeaderHeight;
      const rowHeight = 16;
 
      doc
        .fillColor("#000000")
        .fontSize(7)
        .font("Helvetica");
 
      let totalCgst = 0;
      let totalSgst = 0;
 
      items.forEach((item, idx) => {
        const rowTextY = currentY + 5;
 
        doc.text(
          (item.medicine_name || "-").toUpperCase(),
          cols.particular.x + 3,
          rowTextY,
          { width: cols.particular.w - 3, ellipsis: true }
        );
 
        doc.text(
          item.batch_number || "-",
          cols.batch.x + 3,
          rowTextY,
          { width: cols.batch.w - 3 }
        );
 
        const expDate = item.expiry_date
          ? new Date(item.expiry_date).toLocaleDateString("en-US", {
              month: "short",
              year: "numeric",
            }).replace(" ", "-")
          : "-";
        doc.text(expDate, cols.exp.x + 3, rowTextY, {
          width: cols.exp.w - 3,
        });
 
        doc.text(
          Number(item.unit_price).toFixed(2),
          cols.rate.x + 3,
          rowTextY,
          { width: cols.rate.w - 3 }
        );
 
        doc.text(
          String(item.quantity),
          cols.qty.x + 3,
          rowTextY,
          { width: cols.qty.w - 3 }
        );
 
        const gross = Number(item.unit_price) * item.quantity;
        doc.text(
          gross.toFixed(2),
          cols.gross.x + 3,
          rowTextY,
          { width: cols.gross.w - 3 }
        );
 
        const cgst = Number(item.tax_amount) / 2;
        doc.text(
          cgst.toFixed(2),
          cols.cgst.x + 3,
          rowTextY,
          { width: cols.cgst.w - 3 }
        );
 
        const sgst = Number(item.tax_amount) / 2;
        doc.text(
          sgst.toFixed(2),
          cols.sgst.x + 3,
          rowTextY,
          { width: cols.sgst.w - 3 }
        );
 
        doc.text(
          Number(item.total_amount).toFixed(2),
          cols.amount.x + 3,
          rowTextY,
          { width: cols.amount.w - 3 }
        );
 
        totalCgst += cgst;
        totalSgst += sgst;
        currentY += rowHeight;
      });
 
      // Bottom border of items table
      doc
        .moveTo(20, currentY)
        .lineTo(575, currentY)
        .strokeColor("#000000")
        .lineWidth(0.5)
        .stroke();
 
      // ============================================================
      // 12. TOTALS SECTION
      // ============================================================
 
      currentY += 10;
      const totalsX = 380;
      const valueX = 480;
 
      doc
        .fontSize(7)
        .font("Helvetica")
        .fillColor("#000000");
 
      const totalRows = [
        {
          label: "Total Amount :",
          value: `₹${Number(sale.grand_total).toFixed(2)}`,
        },
        {
          label: "Discount(%) :",
          value:
            Number(sale.subtotal) > 0
              ? (
                  (Number(sale.discount_amount) / Number(sale.subtotal)) * 100
                ).toFixed(3)
              : "0.000",
        },
        {
          label: "Discount Amount :",
          value: `₹${Number(sale.discount_amount).toFixed(2)}`,
        },
        {
          label: "Total :",
          value: `₹${(Number(sale.subtotal) - Number(sale.discount_amount)).toFixed(2)}`,
        },
        {
          label: "Round Off :",
          value: `₹${(Math.round(Number(sale.grand_total)) - Number(sale.grand_total)).toFixed(2)}`,
        },
        {
          label: "GST :",
          value: `₹${Number(sale.tax_amount).toFixed(2)}`,
        },
        {
          label: "Paid Amount :",
          value: `₹${Number(sale.paid_amount).toFixed(2)}`,
          bold: true,
        },
        {
          label: "Due Amount :",
          value: `₹${Number(sale.due_amount).toFixed(2)}`,
        },
        {
          label: "Pay Mode :",
          value: sale.payment_method
            ? sale.payment_method.charAt(0).toUpperCase() +
              sale.payment_method.slice(1)
            : "Cash",
        },
      ];
 
      totalRows.forEach((row) => {
        doc
          .font(row.bold ? "Helvetica-Bold" : "Helvetica")
          .text(row.label, totalsX, currentY);
        doc.text(row.value, valueX, currentY, {
          width: 90,
          align: "right",
        });
        currentY += 11;
      });
 
      currentY += 8;
 
      // ============================================================
      // 13. AMOUNT IN WORDS
      // ============================================================
 
      const amountWords = numberToWordsIndian(
        Math.round(Number(sale.paid_amount))
      );
 
      doc
        .fontSize(7)
        .font("Helvetica")
        .text(
          `Paid Amount(In Words) : ${amountWords}`,
          20,
          currentY,
          { width: 555 }
        );
 
      currentY += 15;
 
      // ============================================================
      // 14. NOTES + AUTHORIZED SIGNATURE
      // ============================================================
 
      doc
        .fontSize(6.5)
        .font("Helvetica")
        .fillColor("#000000")
        .text(
          "Note: Damaged / Fridge items once sold cannot be taken back.",
          20,
          currentY,
          { width: 400 }
        );
 
      doc.text(
        "Items cannot be taken back after 14 days. (Bill is Mandatory)",
        20,
        currentY + 10,
        { width: 400 }
      );
 
      // Authorized Signature (right)
      doc
        .fontSize(8)
        .font("Helvetica-Bold")
        .text("Authorized Signature", 440, currentY + 5, {
          align: "right",
          width: 135,
        });
 
      // ============================================================
      // 15. FINALIZE
      // ============================================================
 
      doc.end();
 
    } catch (err) {
      console.error("Receipt PDF generation error:", err);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: "Failed to generate payment receipt",
          ...(process.env.NODE_ENV !== "production" && {
            error: err.message,
          }),
        });
      }
    }
  }
);

// routes/pharmacy/salesReports.js — Daily Collection & Credit Dues
//
// GET /api/pharmacy/sales-reports/daily-collection?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
//
// Accepts a date RANGE (same date for both = single day).
// Returns collection by method + sales summary + outstanding credit dues.

router.get(
  "/daily-collection",
  authMiddleware,
  allowPermissions("pharmacy.reports.view"),
  async (req, res) => {
    try {

    // Branch scoping: admins choose with the Branch dropdown (?branch=), staff are pinned
    // to their own branch. pharmacy_payments has no branch column, so a payment is matched
    // through the sale it settles.
    let scope;
    try {
      scope = await resolveScope(db, req, { wanted: req.query.branch });
    } catch (e) {
      if (sendBranchError(res, e)) return;
      throw e;
    }
    const bKey = scope.filter ? scope.key : null;
    const bp     = bKey ? [bKey] : [];
      const tenantAdminId = getTenantAdminId(req);
      if (!tenantAdminId) {
        return res.status(400).json({ success: false, message: "Admin context missing" });
      }

      // IST-safe today
      const todayIST = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
      ).toISOString().slice(0, 10);

      const start_date = req.query.start_date || req.query.date || todayIST;
      const end_date   = req.query.end_date   || req.query.date || todayIST;

      /* 1. Collection by method (across the date range) */
      const [collectionRows] = await db.query(
        `SELECT payment_method,
                COUNT(*) AS count,
                COALESCE(SUM(amount), 0) AS amount
         FROM pharmacy_payments
         WHERE admin_id = ?${bKey ? ' AND EXISTS (SELECT 1 FROM pharmacy_sales bs WHERE bs.id = pharmacy_payments.sale_id' + historyBranchSql("bs") + ')' : ''}
           AND DATE(payment_date) BETWEEN ? AND ?
         GROUP BY payment_method`,
        [tenantAdminId, ...bp, start_date, end_date]
      );

      const methods = ["cash", "upi", "card", "bank_transfer", "mixed", "credit"];
      const by_method = {};
      let total_collected = 0;
      let total_payments = 0;
      methods.forEach((m) => { by_method[m] = { amount: 0, count: 0 }; });
      collectionRows.forEach((r) => {
        const m = String(r.payment_method || "cash").toLowerCase();
        if (!by_method[m]) by_method[m] = { amount: 0, count: 0 };
        by_method[m].amount = Number(r.amount);
        by_method[m].count = Number(r.count);
        total_collected += Number(r.amount);
        total_payments += Number(r.count);
      });

      /* 2. Sales summary (range) */
      const [[salesAgg]] = await db.query(
        `SELECT COUNT(*) AS bill_count,
                COALESCE(SUM(grand_total), 0) AS gross_sales,
                COALESCE(SUM(paid_amount), 0) AS collected_at_sale,
                COALESCE(SUM(due_amount), 0)  AS credit_added
         FROM pharmacy_sales
         WHERE admin_id = ?
           AND DATE(sale_date) BETWEEN ? AND ?
           AND status = 'completed'`,
        [tenantAdminId, start_date, end_date]
      );

      const [[returnsAgg]] = await db.query(
        `SELECT COALESCE(SUM(grand_total), 0) AS returns_total
         FROM pharmacy_sales
         WHERE admin_id = ?
           AND DATE(sale_date) BETWEEN ? AND ?
           AND status = 'returned'`,
        [tenantAdminId, start_date, end_date, ...bp]
      ).catch(() => [[{ returns_total: 0 }]]);

      const sales_summary = {
        bill_count: Number(salesAgg.bill_count),
        gross_sales: Number(salesAgg.gross_sales),
        returns: Number(returnsAgg.returns_total || 0),
        net_sales: Number(salesAgg.gross_sales) - Number(returnsAgg.returns_total || 0),
        collected_at_sale: Number(salesAgg.collected_at_sale),
        credit_added: Number(salesAgg.credit_added),
      };

      /* 3. Credit dues (ALL-TIME — not restricted to range, since dues are a live balance) */
      const [[duesAgg]] = await db.query(
        `SELECT COALESCE(SUM(due_amount), 0) AS total_outstanding,
                COUNT(DISTINCT customer_id)  AS customer_count,
                COUNT(*)                      AS bill_count
         FROM pharmacy_sales
         WHERE admin_id = ? AND status = 'completed'${bKey ? historyBranchSql("") : ''}
           AND payment_status IN ('unpaid', 'partial')
           AND due_amount > 0`,
        [tenantAdminId, ...bp]
      );

      /* 4. Ageing buckets */
      const [agingBuckets] = await db.query(
        `SELECT
           CASE
             WHEN DATEDIFF(CURDATE(), sale_date) <= 30 THEN '0-30'
             WHEN DATEDIFF(CURDATE(), sale_date) <= 60 THEN '31-60'
             WHEN DATEDIFF(CURDATE(), sale_date) <= 90 THEN '61-90'
             ELSE '90+'
           END AS bucket,
           COUNT(*) AS count,
           COALESCE(SUM(due_amount), 0) AS amount
         FROM pharmacy_sales
         WHERE admin_id = ? AND status = 'completed'${bKey ? historyBranchSql("") : ''}
           AND payment_status IN ('unpaid', 'partial') AND due_amount > 0
         GROUP BY bucket`,
        [tenantAdminId, ...bp]
      );

      const aging = {
        "0-30":  { amount: 0, count: 0 },
        "31-60": { amount: 0, count: 0 },
        "61-90": { amount: 0, count: 0 },
        "90+":   { amount: 0, count: 0 },
      };
      agingBuckets.forEach((b) => {
        aging[b.bucket] = { amount: Number(b.amount), count: Number(b.count) };
      });

      /* 5. Customer-wise outstanding */
      const [customers] = await db.query(
        `SELECT
           s.customer_id,
           s.customer_name,
           s.customer_phone,
           COUNT(*) AS sales_count,
           COALESCE(SUM(s.due_amount), 0) AS total_due,
           MIN(s.sale_date) AS oldest_due_date,
           DATEDIFF(CURDATE(), MIN(s.sale_date)) AS days_old
         FROM pharmacy_sales s
         WHERE s.admin_id = ? AND s.status = 'completed'${bKey ? historyBranchSql("s") : ''}
           AND s.payment_status IN ('unpaid', 'partial') AND s.due_amount > 0
         GROUP BY s.customer_id, s.customer_name, s.customer_phone
         ORDER BY days_old DESC, total_due DESC`,
        [tenantAdminId, ...bp]
      );

      const customersWithBucket = customers.map((c) => ({
        ...c,
        total_due: Number(c.total_due),
        days_old: Number(c.days_old),
        sales_count: Number(c.sales_count),
        aging_bucket:
          Number(c.days_old) <= 30 ? "0-30" :
          Number(c.days_old) <= 60 ? "31-60" :
          Number(c.days_old) <= 90 ? "61-90" : "90+",
      }));

      return res.json({
        success: true,
        data: {
          start_date,
          end_date,
          collection_summary: { by_method, total_collected, total_payments },
          sales_summary,
          credit_dues: {
            total_outstanding: Number(duesAgg.total_outstanding),
            customer_count: Number(duesAgg.customer_count),
            bill_count: Number(duesAgg.bill_count),
            aging,
            customers: customersWithBucket,
          },
        },
      });
    } catch (err) {
      console.error("[Collection report] error:", err);
      return res.status(500).json({ success: false, message: "Failed to generate report" });
    }
  }
);


router.get(
  "/daily-collection/pdf",
  authMiddleware,
  allowPermissions("pharmacy.reports.view"),
  async (req, res) => {
    try {

    // Branch scoping: admins choose with the Branch dropdown (?branch=), staff are pinned
    // to their own branch. pharmacy_payments has no branch column, so a payment is matched
    // through the sale it settles.
    let scope;
    try {
      scope = await resolveScope(db, req, { wanted: req.query.branch });
    } catch (e) {
      if (sendBranchError(res, e)) return;
      throw e;
    }
    const bKey = scope.filter ? scope.key : null;
    const bp     = bKey ? [bKey] : [];
      const tenantAdminId = getTenantAdminId(req);
      if (!tenantAdminId) {
        return res.status(400).send("Admin context missing");
      }
 
      const todayIST = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
      ).toISOString().slice(0, 10);
 
      const start_date = req.query.start_date || req.query.date || todayIST;
      const end_date   = req.query.end_date   || req.query.date || todayIST;
      const is_today = start_date === todayIST && end_date === todayIST;
 
      /* ───── 1. Clinic info ───── */
      const [[clinicRow]] = await db.execute(
      `SELECT company_name, company_logo, address, mobile, email
      FROM admins WHERE id = ? LIMIT 1`,
      [tenantAdminId]
      );
      const clinic = {
        name: clinicRow?.company_name || "Pharmacy",
        address: clinicRow?.address || "",
        phone: clinicRow?.mobile || "",
        email: clinicRow?.email || "",
        gstin: clinicRow?.gstin || "",
        logo_path: clinicRow?.company_logo
          ? path.join(__dirname, "..", "..", "Images", clinicRow.company_logo)
          : null,
      };
 
      /* ───── 2. Collection by method ───── */
      const [collectionRows] = await db.query(
        `SELECT payment_method, COUNT(*) AS count,
                COALESCE(SUM(amount), 0) AS amount
         FROM pharmacy_payments
         WHERE admin_id = ?${bKey ? ' AND EXISTS (SELECT 1 FROM pharmacy_sales bs WHERE bs.id = pharmacy_payments.sale_id' + historyBranchSql("bs") + ')' : ''}
           AND DATE(payment_date) BETWEEN ? AND ?
         GROUP BY payment_method`,
        [tenantAdminId, ...bp, start_date, end_date]
      );
      const methods = ["cash", "upi", "card", "bank_transfer", "mixed", "credit"];
      const by_method = {};
      let total_collected = 0, total_payments = 0;
      methods.forEach((m) => { by_method[m] = { amount: 0, count: 0 }; });
      collectionRows.forEach((r) => {
        const m = String(r.payment_method || "cash").toLowerCase();
        if (!by_method[m]) by_method[m] = { amount: 0, count: 0 };
        by_method[m].amount = Number(r.amount);
        by_method[m].count = Number(r.count);
        total_collected += Number(r.amount);
        total_payments += Number(r.count);
      });
 
      /* ───── 3. Sales summary ───── */
      const [[salesAgg]] = await db.query(
        `SELECT COUNT(*) AS bill_count,
                COALESCE(SUM(grand_total), 0) AS gross_sales,
                COALESCE(SUM(paid_amount), 0) AS collected_at_sale,
                COALESCE(SUM(due_amount), 0)  AS credit_added
         FROM pharmacy_sales
         WHERE admin_id = ? AND DATE(sale_date) BETWEEN ? AND ?${bKey ? historyBranchSql("") : ''}
           AND status = 'completed'`,
        [tenantAdminId, start_date, end_date, ...bp]
      );
      const [[returnsAgg]] = await db.query(
        `SELECT COALESCE(SUM(grand_total), 0) AS returns_total
         FROM pharmacy_sales
         WHERE admin_id = ? AND DATE(sale_date) BETWEEN ? AND ?${bKey ? historyBranchSql("") : ''}
           AND status = 'returned'`,
        [tenantAdminId, start_date, end_date, ...bp]
      ).catch(() => [[{ returns_total: 0 }]]);
 
      const sales_summary = {
        bill_count: Number(salesAgg.bill_count),
        gross_sales: Number(salesAgg.gross_sales),
        returns: Number(returnsAgg.returns_total || 0),
        net_sales: Number(salesAgg.gross_sales) - Number(returnsAgg.returns_total || 0),
        collected_at_sale: Number(salesAgg.collected_at_sale),
        credit_added: Number(salesAgg.credit_added),
      };
 
      /* ───── 4. Credit dues ───── */
      const [[duesAgg]] = await db.query(
        `SELECT COALESCE(SUM(due_amount), 0) AS total_outstanding,
                COUNT(DISTINCT customer_id)  AS customer_count,
                COUNT(*)                      AS bill_count
         FROM pharmacy_sales
         WHERE admin_id = ? AND status = 'completed'${bKey ? historyBranchSql("") : ''}
           AND payment_status IN ('unpaid', 'partial') AND due_amount > 0`,
        [tenantAdminId, ...bp]
      );
 
      const [agingBuckets] = await db.query(
        `SELECT
           CASE
             WHEN DATEDIFF(CURDATE(), sale_date) <= 30 THEN '0-30'
             WHEN DATEDIFF(CURDATE(), sale_date) <= 60 THEN '31-60'
             WHEN DATEDIFF(CURDATE(), sale_date) <= 90 THEN '61-90'
             ELSE '90+'
           END AS bucket,
           COUNT(*) AS count,
           COALESCE(SUM(due_amount), 0) AS amount
         FROM pharmacy_sales
         WHERE admin_id = ? AND status = 'completed'${bKey ? historyBranchSql("") : ''}
           AND payment_status IN ('unpaid', 'partial') AND due_amount > 0
         GROUP BY bucket`,
        [tenantAdminId, ...bp]
      );
      const aging = {
        "0-30":  { amount: 0, count: 0 },
        "31-60": { amount: 0, count: 0 },
        "61-90": { amount: 0, count: 0 },
        "90+":   { amount: 0, count: 0 },
      };
      agingBuckets.forEach((b) => {
        aging[b.bucket] = { amount: Number(b.amount), count: Number(b.count) };
      });
 
      const [customers] = await db.query(
        `SELECT s.customer_id, s.customer_name, s.customer_phone,
                COUNT(*) AS sales_count,
                COALESCE(SUM(s.due_amount), 0) AS total_due,
                MIN(s.sale_date) AS oldest_due_date,
                DATEDIFF(CURDATE(), MIN(s.sale_date)) AS days_old
         FROM pharmacy_sales s
         WHERE s.admin_id = ? AND s.status = 'completed'${bKey ? historyBranchSql("s") : ''}
           AND s.payment_status IN ('unpaid', 'partial') AND s.due_amount > 0
         GROUP BY s.customer_id, s.customer_name, s.customer_phone
         ORDER BY days_old DESC, total_due DESC`,
        [tenantAdminId, ...bp]
      );
      const customersWithBucket = customers.map((c) => ({
        ...c,
        total_due: Number(c.total_due),
        days_old: Number(c.days_old),
        sales_count: Number(c.sales_count),
        aging_bucket:
          Number(c.days_old) <= 30 ? "0-30" :
          Number(c.days_old) <= 60 ? "31-60" :
          Number(c.days_old) <= 90 ? "61-90" : "90+",
      }));
 
      /* ───── 5. Period label ───── */
      let periodLabel;
      if (is_today) {
        periodLabel = `Today — ${new Date(start_date).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}`;
      } else if (start_date === end_date) {
        periodLabel = new Date(start_date).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
      } else {
        periodLabel = `${new Date(start_date).toLocaleDateString("en-IN")} → ${new Date(end_date).toLocaleDateString("en-IN")}`;
      }
 
      /* ───── 6. Build PDF ───── */
      const pdfBuffer = await buildCollectionReportPdf({
        clinic,
        period: { label: periodLabel, start_date, end_date, is_today },
        data: {
          collection_summary: { by_method, total_collected, total_payments },
          sales_summary,
          credit_dues: {
            total_outstanding: Number(duesAgg.total_outstanding),
            customer_count: Number(duesAgg.customer_count),
            bill_count: Number(duesAgg.bill_count),
            aging,
            customers: customersWithBucket,
          },
        },
      });
 
      /* ───── 7. Stream back ───── */
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="collection-${start_date}_to_${end_date}.pdf"`
      );
      res.setHeader("Content-Length", pdfBuffer.length);
      return res.end(pdfBuffer);
    } catch (err) {
      console.error("[Collection report PDF] error:", err);
      return res.status(500).send("Failed to generate PDF");
    }
  }
);


// routes/pharmacy/salesReports.js — Low Stock / Reorder Alert

router.get(
  "/low-stock",
  authMiddleware,
  allowPermissions("pharmacy.reports.view"),
  async (req, res) => {
    try {

    // Branch scoping: admins choose with the Branch dropdown (?branch=), staff are pinned
    // to their own branch. pharmacy_payments has no branch column, so a payment is matched
    // through the sale it settles.
    let scope;
    try {
      scope = await resolveScope(db, req, { wanted: req.query.branch });
    } catch (e) {
      if (sendBranchError(res, e)) return;
      throw e;
    }
    const bKey = scope.filter ? scope.key : null;
    const bp     = bKey ? [bKey] : [];
      const tenantAdminId = getTenantAdminId(req);
      if (!tenantAdminId) {
        return res.status(400).json({ success: false, message: "Admin context missing" });
      }
 
      /* ───── 1. Fetch low-stock medicines ─────
         Joins:
           pharmacy_medicines         pm  (per-pharmacy list + reorder_level)
           medicine_data              md  (universal name, generic, strength, dosage_form)
           pharmacy_medicine_batches  pmb (available stock + nearest expiry)
         Schema notes:
           • pm.status is enum('active','inactive')
           • md column is `dosage_form` (aliased to `form` for the API)
           • batches link via pmb.medicine_id → pm.id
           • batches have their own status enum('active','expired','blocked')
      */
      const lq = lowStockQuery(tenantAdminId, scope);
      const [rows] = await db.query(lq.sql, lq.params);
 
      /* ───── 2. Enrich each row with urgency + suggested order ───── */
      const items = rows.map((r) => {
        const qty    = Number(r.quantity_available);
        const level  = Number(r.reorder_level);
        const pct    = level > 0 ? (qty / level) * 100 : 0;
        let urgency = "LOW";
        if (qty === 0)        urgency = "CRITICAL";
        else if (pct <= 25)   urgency = "HIGH";
        else if (pct <= 50)   urgency = "MEDIUM";
        else                  urgency = "LOW";
 
        /* Suggested order = replenish up to 2× reorder level, minimum 1 */
        const suggested_order = Math.max(1, (level * 2) - qty);
 
        return {
          branch:               r.branch || null,
          pharmacy_medicine_id: r.pharmacy_medicine_id,
          medicine_data_id:     r.medicine_data_id,
          medicine_name:        r.medicine_name,
          generic_name:         r.generic_name || "",
          strength:             r.strength || "",
          form:                 r.form || "",
          quantity_available:   qty,
          reorder_level:        level,
          batch_count:          Number(r.batch_count),
          nearest_expiry:       r.nearest_expiry,
          stock_pct:            Math.round(pct),
          deficit:              Math.max(0, level - qty),
          suggested_order,
          urgency,
        };
      });
 
      /* ───── 3. Summary buckets ───── */
      const summary = {
        total_items:  items.length,
        out_of_stock: items.filter((i) => i.urgency === "CRITICAL").length,
        high:         items.filter((i) => i.urgency === "HIGH").length,
        medium:       items.filter((i) => i.urgency === "MEDIUM").length,
        low:          items.filter((i) => i.urgency === "LOW").length,
        total_suggested_units: items.reduce((s, i) => s + i.suggested_order, 0),
      };
 
      return res.json({ success: true, data: { summary, items, per_branch: lq.perBranch, branch: scope.branch || null } });
    } catch (err) {
      console.error("[Low stock report] error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to generate low-stock report",
      });
    }
  }
);

router.get(
  "/low-stock/pdf",
  authMiddleware,
  allowPermissions("pharmacy.reports.view"),
  async (req, res) => {
    try {

    // Branch scoping: admins choose with the Branch dropdown (?branch=), staff are pinned
    // to their own branch. pharmacy_payments has no branch column, so a payment is matched
    // through the sale it settles.
    let scope;
    try {
      scope = await resolveScope(db, req, { wanted: req.query.branch });
    } catch (e) {
      if (sendBranchError(res, e)) return;
      throw e;
    }
    const bKey = scope.filter ? scope.key : null;
    const bp     = bKey ? [bKey] : [];
      const tenantAdminId = getTenantAdminId(req);
      if (!tenantAdminId) {
        return res.status(400).send("Admin context missing");
      }
 
      /* ───── 1. Clinic info ───── */
      const [[clinicRow]] = await db.execute(
        `SELECT company_name, company_logo, address, mobile, email
         FROM admins WHERE id = ? LIMIT 1`,
        [tenantAdminId]
      );
      const clinic = {
        name: clinicRow?.company_name || "Pharmacy",
        address: clinicRow?.address || "",
        phone: clinicRow?.mobile || "",
        email: clinicRow?.email || "",
        logo_path: clinicRow?.company_logo
          ? path.join(__dirname, "..", "..", "Images", clinicRow.company_logo)
          : null,
      };
 
      /* ───── 2. Fetch low-stock medicines ───── */
      const lq = lowStockQuery(tenantAdminId, scope);
      const [rows] = await db.query(lq.sql, lq.params);
 
      /* ───── 3. Enrich ───── */
      const items = rows.map((r) => {
        const qty   = Number(r.quantity_available);
        const level = Number(r.reorder_level);
        const pct   = level > 0 ? (qty / level) * 100 : 0;
        let urgency = "LOW";
        if (qty === 0)        urgency = "CRITICAL";
        else if (pct <= 25)   urgency = "HIGH";
        else if (pct <= 50)   urgency = "MEDIUM";
 
        return {
          // All branches: one row per medicine x branch, so the branch goes beside the name
          medicine_name:      lq.perBranch && r.branch ? `${r.medicine_name} (${r.branch})` : r.medicine_name,
          generic_name:       r.generic_name || "",
          strength:           r.strength || "",
          form:               r.form || "",
          quantity_available: qty,
          reorder_level:      level,
          batch_count:        Number(r.batch_count),
          nearest_expiry:     r.nearest_expiry,
          stock_pct:          Math.round(pct),
          deficit:            Math.max(0, level - qty),
          suggested_order:    Math.max(1, (level * 2) - qty),
          urgency,
        };
      });
 
      const summary = {
        total_items:  items.length,
        out_of_stock: items.filter((i) => i.urgency === "CRITICAL").length,
        high:         items.filter((i) => i.urgency === "HIGH").length,
        medium:       items.filter((i) => i.urgency === "MEDIUM").length,
        low:          items.filter((i) => i.urgency === "LOW").length,
        total_suggested_units: items.reduce((s, i) => s + i.suggested_order, 0),
      };
 
      /* ───── 4. Build PDF ───── */
      const pdfBuffer = await buildLowStockReportPdf({ clinic, summary, items });
 
      /* ───── 5. Stream back ───── */
      const todayISO = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="low-stock-${todayISO}.pdf"`
      );
      res.setHeader("Content-Length", pdfBuffer.length);
      return res.end(pdfBuffer);
    } catch (err) {
      console.error("[Low stock PDF] error:", err);
      return res.status(500).send("Failed to generate PDF");
    }
  }
);

router.get(
  "/expiring-soon",
  authMiddleware,
  allowPermissions("pharmacy.reports.view"),
  async (req, res) => {
    try {

    // Branch scoping: admins choose with the Branch dropdown (?branch=), staff are pinned
    // to their own branch. pharmacy_payments has no branch column, so a payment is matched
    // through the sale it settles.
    let scope;
    try {
      scope = await resolveScope(db, req, { wanted: req.query.branch });
    } catch (e) {
      if (sendBranchError(res, e)) return;
      throw e;
    }
    const bKey = scope.filter ? scope.key : null;
    const bp     = bKey ? [bKey] : [];
      const tenantAdminId = getTenantAdminId(req);
      if (!tenantAdminId) {
        return res.status(400).json({ success: false, message: "Admin context missing" });
      }
 
      /* Optional query filter — ?window=30 | 60 | 90 | 180 (default 90) */
      const window = Math.min(365, Math.max(30, Number(req.query.window) || 90));
 
      /* ───── Fetch batches ─────
         Joins:
           pharmacy_medicine_batches  pmb (batch + qty + expiry + cost)
           pharmacy_medicines         pm  (links to universal medicine_data)
           medicine_data              md  (name, generic, strength, dosage_form)
      */
      const [rows] = await db.query(
        `SELECT
            pmb.branch                  AS branch,
            pmb.id                      AS batch_id,
            pmb.batch_number            AS batch_number,
            pmb.expiry_date             AS expiry_date,
            pmb.manufacturing_date      AS manufacturing_date,
            FLOOR(pmb.quantity_available / GREATEST(COALESCE(pmb.units_per_pack, 1), 1)) AS quantity_available,
            pmb.units_per_pack          AS units_per_pack,
            pmb.quantity_available      AS quantity_available_tablets,
            pmb.purchase_price          AS purchase_price,
            pmb.selling_price           AS selling_price,
            pmb.mrp                     AS mrp,
            pmb.supplier_id             AS supplier_id,
            pmb.status                  AS batch_status,
            DATEDIFF(pmb.expiry_date, CURDATE()) AS days_to_expiry,
            pm.id                       AS pharmacy_medicine_id,
            pm.manufacturer             AS manufacturer,
            pm.pack_size                AS pack_size,
            pm.unit                     AS unit,
            md.medicine_name            AS medicine_name,
            md.generic_name             AS generic_name,
            md.strength                 AS strength,
            md.dosage_form              AS form
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm ON pm.id = pmb.medicine_id
         JOIN medicine_data      md ON md.id = pm.medicine_data_id
         WHERE pmb.admin_id = ?${bKey ? ' AND pmb.branch IS NOT NULL AND LOWER(TRIM(pmb.branch)) = ?' : ''}
           AND pmb.quantity_available > 0
           AND pmb.status IN ('active', 'expired')
           AND pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
         ORDER BY pmb.expiry_date ASC,
                  (FLOOR(pmb.quantity_available / GREATEST(COALESCE(pmb.units_per_pack, 1), 1)) * pmb.purchase_price) DESC`,
        [tenantAdminId, ...bp, window]
      );
 
      /* ───── Enrich with urgency + value ───── */
      const items = rows.map((r) => {
        const days = Number(r.days_to_expiry);
        const qty  = Number(r.quantity_available);
        const cost = Number(r.purchase_price);
        const sellPrice = Number(r.selling_price);
        const value_at_cost  = +(qty * cost).toFixed(2);
        const value_at_sell  = +(qty * sellPrice).toFixed(2);
        const value_at_mrp   = +(qty * Number(r.mrp)).toFixed(2);
 
        let urgency = "WATCH";
        if (days < 0)        urgency = "EXPIRED";
        else if (days <= 30) urgency = "DANGER";
        else if (days <= 60) urgency = "WARNING";
        else                 urgency = "WATCH";
 
        return {
          branch: r.branch ? String(r.branch).trim() : null,
          batch_id: r.batch_id,
          pharmacy_medicine_id: r.pharmacy_medicine_id,
          batch_number: r.batch_number,
          medicine_name: r.medicine_name,
          generic_name: r.generic_name || "",
          strength: r.strength || "",
          form: r.form || "",
          manufacturer: r.manufacturer || "",
          pack_size: r.pack_size || "",
          unit: r.unit || "",
          supplier_id: r.supplier_id,
          manufacturing_date: r.manufacturing_date,
          expiry_date: r.expiry_date,
          days_to_expiry: days,
          quantity_available: qty,
          purchase_price: cost,
          selling_price: sellPrice,
          mrp: Number(r.mrp),
          value_at_cost,
          value_at_sell,
          value_at_mrp,
          urgency,
        };
      });
 
      /* ───── Summary ───── */
      const bucketOf = (u) => ({ amount: 0, count: 0, qty: 0 });
      const buckets = {
        EXPIRED: bucketOf(),
        DANGER:  bucketOf(),
        WARNING: bucketOf(),
        WATCH:   bucketOf(),
      };
      let total_value_at_cost = 0;
      let total_qty = 0;
      items.forEach((it) => {
        const b = buckets[it.urgency];
        b.count += 1;
        b.qty   += it.quantity_available;
        b.amount += it.value_at_cost;
        total_value_at_cost += it.value_at_cost;
        total_qty += it.quantity_available;
      });
 
      const summary = {
        total_batches: items.length,
        total_qty,
        total_value_at_cost: +total_value_at_cost.toFixed(2),
        buckets,
        window_days: window,
      };
 
      return res.json({ success: true, data: { summary, items, multi: !!scope.multi, branch: scope.branch || null } });
    } catch (err) {
      console.error("[Expiring soon report] error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to generate expiring-soon report",
      });
    }
  }
);


router.get(
  "/expiring-soon/pdf",
  authMiddleware,
  allowPermissions("pharmacy.reports.view"),
  async (req, res) => {
    try {

    // Branch scoping: admins choose with the Branch dropdown (?branch=), staff are pinned
    // to their own branch. pharmacy_payments has no branch column, so a payment is matched
    // through the sale it settles.
    let scope;
    try {
      scope = await resolveScope(db, req, { wanted: req.query.branch });
    } catch (e) {
      if (sendBranchError(res, e)) return;
      throw e;
    }
    const bKey = scope.filter ? scope.key : null;
    const bp     = bKey ? [bKey] : [];
      const tenantAdminId = getTenantAdminId(req);
      if (!tenantAdminId) {
        return res.status(400).send("Admin context missing");
      }
 
      const window = Math.min(365, Math.max(30, Number(req.query.window) || 90));
 
      /* ───── 1. Clinic info ───── */
      const [[clinicRow]] = await db.execute(
        `SELECT company_name, company_logo, address, mobile, email
         FROM admins WHERE id = ? LIMIT 1`,
        [tenantAdminId]
      );
      const clinic = {
        name: clinicRow?.company_name || "Pharmacy",
        address: clinicRow?.address || "",
        phone: clinicRow?.mobile || "",
        email: clinicRow?.email || "",
        logo_path: clinicRow?.company_logo
          ? path.join(__dirname, "..", "..", "Images", clinicRow.company_logo)
          : null,
      };
 
      /* ───── 2. Fetch batches ───── */
      const [rows] = await db.query(
        `SELECT
            pmb.branch                  AS branch,
            pmb.id                      AS batch_id,
            pmb.batch_number            AS batch_number,
            pmb.expiry_date             AS expiry_date,
            pmb.manufacturing_date      AS manufacturing_date,
            FLOOR(pmb.quantity_available / GREATEST(COALESCE(pmb.units_per_pack, 1), 1)) AS quantity_available,
            pmb.units_per_pack          AS units_per_pack,
            pmb.quantity_available      AS quantity_available_tablets,
            pmb.purchase_price          AS purchase_price,
            pmb.mrp                     AS mrp,
            DATEDIFF(pmb.expiry_date, CURDATE()) AS days_to_expiry,
            pm.manufacturer             AS manufacturer,
            pm.pack_size                AS pack_size,
            md.medicine_name            AS medicine_name,
            md.strength                 AS strength,
            md.dosage_form              AS form
         FROM pharmacy_medicine_batches pmb
         JOIN pharmacy_medicines pm ON pm.id = pmb.medicine_id
         JOIN medicine_data      md ON md.id = pm.medicine_data_id
         WHERE pmb.admin_id = ?${bKey ? ' AND pmb.branch IS NOT NULL AND LOWER(TRIM(pmb.branch)) = ?' : ''}
           AND pmb.quantity_available > 0
           AND pmb.status IN ('active', 'expired')
           AND pmb.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
         ORDER BY pmb.expiry_date ASC,
                  (FLOOR(pmb.quantity_available / GREATEST(COALESCE(pmb.units_per_pack, 1), 1)) * pmb.purchase_price) DESC`,
        [tenantAdminId, ...bp, window]
      );
 
      /* ───── 3. Enrich ───── */
      const items = rows.map((r) => {
        const days = Number(r.days_to_expiry);
        const qty  = Number(r.quantity_available);
        const cost = Number(r.purchase_price);
        const value_at_cost = +(qty * cost).toFixed(2);
 
        let urgency = "WATCH";
        if (days < 0)        urgency = "EXPIRED";
        else if (days <= 30) urgency = "DANGER";
        else if (days <= 60) urgency = "WARNING";
 
        return {
          batch_number: r.batch_number,
          // All branches in a multi-branch pharmacy: say which branch holds the batch
          medicine_name: scope.multi && !bKey ? `${r.medicine_name} (${r.branch ? String(r.branch).trim() : "No branch"})` : r.medicine_name,
          strength: r.strength || "",
          form: r.form || "",
          manufacturer: r.manufacturer || "",
          pack_size: r.pack_size || "",
          expiry_date: r.expiry_date,
          days_to_expiry: days,
          quantity_available: qty,
          purchase_price: cost,
          mrp: Number(r.mrp),
          value_at_cost,
          urgency,
        };
      });
 
      const buckets = {
        EXPIRED: { amount: 0, count: 0, qty: 0 },
        DANGER:  { amount: 0, count: 0, qty: 0 },
        WARNING: { amount: 0, count: 0, qty: 0 },
        WATCH:   { amount: 0, count: 0, qty: 0 },
      };
      let total_value_at_cost = 0, total_qty = 0;
      items.forEach((it) => {
        const b = buckets[it.urgency];
        b.count += 1; b.qty += it.quantity_available; b.amount += it.value_at_cost;
        total_value_at_cost += it.value_at_cost;
        total_qty += it.quantity_available;
      });
 
      const summary = {
        total_batches: items.length,
        total_qty,
        total_value_at_cost: +total_value_at_cost.toFixed(2),
        buckets,
        window_days: window,
      };
 
      /* ───── 4. Build PDF ───── */
      const pdfBuffer = await buildExpiringSoonReportPdf({ clinic, summary, items });
 
      /* ───── 5. Stream ───── */
      const todayISO = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="expiring-soon-${todayISO}.pdf"`
      );
      res.setHeader("Content-Length", pdfBuffer.length);
      return res.end(pdfBuffer);
    } catch (err) {
      console.error("[Expiring soon PDF] error:", err);
      return res.status(500).send("Failed to generate PDF");
    }
  }
);



module.exports = router;