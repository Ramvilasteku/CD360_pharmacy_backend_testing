// routes/Pharmacy/pharmacyProcurementReports.js
//
// PROCUREMENT REPORTS — pick a report, a date range and (admin) a branch, preview it, then download
// the same data as CSV or PDF.
//
// Mount in server.js:
//   const pharmacyProcurementReports = require("./routes/Pharmacy/pharmacyProcurementReports.js");
//   app.use("/api/pharmacy/procurement-reports", pharmacyProcurementReports);
//
//   GET /get/report-types   the reports this user may open, their filters, the date ranges, branches
//   GET /get/report         one page of the report (whole documents) + totals over EVERY match
//   GET /download/report    the whole report as a file: ?format=csv | pdf
//   GET /get/chart          amount over time + top 5, for the same filters (no paging)
//   GET /get/suppliers      the supplier picker (purchase-side reports)
//
//   Query (both report endpoints):
//     type     purchase_orders | generated_orders | b2b_orders | sales_orders | purchase_transfers
//              | purchase_returns | supplier_payments
//     range    last_7_days | last_15_days | last_30_days | current_month | previous_month | custom
//     start, end   YYYY-MM-DD (custom only)
//     branch   admin only: a branch name, or empty / "all" for every branch. Ignored for staff.
//     status, order_type, payment_status, method   the report's own filters (see /get/report-types)
//     supplier_id   purchase-side reports only (Purchase / Generated Orders, Supplier Payments, Purchase Returns)
//     q        search: whole documents whose number, supplier / buyer, invoice, medicine, batch … match
//     page, limit  preview only (documents per page, 5–100)
//     charts   download only: 0 = no charts in the PDF (the screen sends 0 when its charts are hidden)
//     orientation  PDF only: landscape (default) | portrait — both A4
//
// ONE QUERY BUILDER FOR EVERYTHING
//   Each report is an entry in REPORTS: an inner SELECT that returns one row per document LINE with
//   the same core columns (doc_id, doc_no, doc_date, branch_key, status, first_line, line_id …).
//   buildWhere() adds the date / branch / filter conditions to it. The preview, the totals, the CSV
//   and the PDF all go through buildWhere() → the file is always exactly what the preview showed.
//
// RULES
//   • Tenant: admin_id always comes from the login (req.user), never from the request.
//   • Branch: utils/pharmacyBranch.resolveScope — staff always get their OWN branch (read from the
//     database; a branch in the request is ignored). Admin: all branches, or the one they pick.
//     A pharmacy with one branch (or none) has no branch filter at all.
//   • Access: pharmacy.reports.view to preview, + pharmacy.reports.export to download, AND the view
//     permission of the screen the data comes from (purchase / b2b_sales / sales / purchase_transfer /
//     purchase_return). A report the user can't open is not offered, and is refused if asked for.
//   • Dates: the ranges are worked out in India time (that is how the pharmacy screens stamp them).
//     Custom: real dates, start ≤ end, not in the future, at most MAX_RANGE_DAYS days.
//   • Amounts and quantities leave out documents that don't count (cancelled orders, cancelled /
//     pending bills, rejected / cancelled transfers…) — unless that status is what was filtered on.
//     Document and line counts always include everything that matched.
//   • A document's own figures (its total, paid, due) sit on its FIRST line only, and every CSV row says
//     whether it is "In totals" — so adding up a column over the rows marked Yes (Excel SUMIF / filter)
//     gives exactly the preview's total.
//   • Access is checked here again, strictly: a permission or role switched off in the role screen
//     (status = 0) no longer opens a report, even though the shared allowPermissions() still counts it.
//   • Downloads: at most MAX_PARALLEL_DOWNLOADS at a time (the pool has 10 connections); if the browser
//     goes away mid-download its database connection is destroyed at once, never left waiting.
//   • Relative ranges (Last 7 days …) are pinned to the day of the preview (as_of), so paging or
//     downloading just after midnight still gives the window that was previewed.
//   • Quantities: purchases are in strips (+ free strips); stock and sales are counted in tablets
//     (utils/pharmacyUnits.js). Old sale lines without sale_unit are read the way readSaleLine reads them.
//
// No new tables. Reads only.

const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
const { resolveScope, sendBranchError } = require("../../utils/pharmacyBranch");

const PERM = { view: "pharmacy.reports.view", export: "pharmacy.reports.export" };

const MAX_RANGE_DAYS = 366;
const PDF_MAX_LINES = 5000;
const DEFAULT_LIMIT = 10;
// Charts on the PDF's first page (small: amount over time + top 5). false = charts on screen only.
const PDF_CHARTS = true;
const SEARCH_MAX = 100;
const MAX_PARALLEL_DOWNLOADS = 3; // per server process — leaves the rest of the pool to the app
const QUERY_TIMEOUT_MS = 60 * 1000; // preview / totals
const STREAM_TIMEOUT_MS = 10 * 60 * 1000; // one whole file
let activeDownloads = 0;

/* ============================================================
   Small helpers
============================================================ */
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const httpError = (status, message, extra) => new HttpError(status, message, extra);

const clean = (v) => (v === undefined || v === null ? "" : String(v).trim());
const pad2 = (n) => String(n).padStart(2, "0");
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

const isAdminUser = (req) => String((req.user && req.user.role) || "").toLowerCase() === "admin";

/**
 * The staff member's permission keys, read strictly: only ACTIVE role assignments, roles and
 * role-permission rows of THIS tenant count. (allowPermissions() also runs first, for the login and the
 * module gate, but it doesn't look at role_permissions.status — so a switched-off permission would pass.)
 * Admins: null = everything.
 */
async function strictPermissions(req) {
  if (isAdminUser(req)) return null;
  const adminId = req.user.adminId;
  const [rows] = await db.query(
    {
      sql: `SELECT DISTINCT LOWER(p.permission_key) AS k
              FROM user_role_assignments ura
              JOIN roles r             ON r.id = ura.role_id AND r.admin_id = ? AND r.status = 1
              JOIN role_permissions rp ON rp.role_id = ura.role_id AND rp.admin_id = ? AND rp.status = 1
              JOIN permissions p       ON p.id = rp.permission_id AND p.is_active = 1
             WHERE ura.user_id = ? AND ura.user_type = 'staff' AND ura.status = 1`,
      timeout: QUERY_TIMEOUT_MS,
    },
    [adminId, adminId, req.user.id]
  );
  return new Set(rows.map((r) => r.k));
}

/** Route guard: the report permissions this endpoint needs, checked strictly. Sets req.reportCan(perm). */
const reportAccess = (...required) => async (req, res, next) => {
  try {
    const perms = await strictPermissions(req);
    req.reportCan = (perm) => perms === null || perms.has(perm);
    if (!required.every(req.reportCan)) {
      const download = required.includes(PERM.export);
      return res.status(403).json({ success: false, message: download ? "You don't have permission to download reports." : "You don't have access to reports." });
    }
    return next();
  } catch (err) {
    console.error("Report access check failed:", err);
    return res.status(500).json({ success: false, message: "Could not check your access. Please try again." });
  }
};
const userCan = (req, perm) => !!(req.reportCan && req.reportCan(perm));

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (res.headersSent) {
      // part of a file is already out: break the response so the browser shows a failed download,
      // never a file that just stops
      if (!res.destroyed) console.error("Procurement report error after headers were sent:", err);
      res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, message: err.message, ...(err.extra || {}) });
    }
    if (sendBranchError(res, err)) return;
    console.error("Procurement report error:", err);
    return res.status(500).json({ success: false, message: "Could not build the report. Please try again." });
  }
};

/* ============================================================
   Dates (India time)
============================================================ */
const istToday = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
const validDay = (v) => {
  const s = clean(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const prettyDay = (ymd) => (ymd ? `${pad2(Number(ymd.slice(8, 10)))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}` : "");

const RANGES = [
  { key: "last_7_days", label: "Last 7 days" },
  { key: "last_15_days", label: "Last 15 days" },
  { key: "last_30_days", label: "Last 30 days" },
  { key: "current_month", label: "Current month" },
  { key: "previous_month", label: "Previous month" },
  { key: "custom", label: "Custom range" },
];

function resolveRange(q) {
  const key = clean(q.range) || "last_7_days";
  const realToday = istToday();
  // a relative range is pinned to the day the preview was made (sent back as as_of)
  let today = realToday;
  if (key !== "custom" && clean(q.as_of)) {
    const asOf = validDay(q.as_of);
    if (!asOf || asOf > realToday || daysBetween(asOf, realToday) > 31) throw httpError(400, "This preview is out of date. Press Preview report again.");
    today = asOf;
  }
  const monthStart = `${today.slice(0, 8)}01`;
  let start;
  let end = today;
  switch (key) {
    case "last_7_days":
      start = addDays(today, -6);
      break;
    case "last_15_days":
      start = addDays(today, -14);
      break;
    case "last_30_days":
      start = addDays(today, -29);
      break;
    case "current_month":
      start = monthStart;
      break;
    case "previous_month":
      end = addDays(monthStart, -1);
      start = `${end.slice(0, 8)}01`;
      break;
    case "custom": {
      start = validDay(q.start);
      end = validDay(q.end);
      if (!clean(q.start) || !clean(q.end)) throw httpError(400, "Choose both a start date and an end date.");
      if (!start || !end) throw httpError(400, "Dates must be real dates (YYYY-MM-DD).");
      if (start > end) throw httpError(400, "The start date must be on or before the end date.");
      if (end > realToday) throw httpError(400, "The end date can't be in the future.");
      if (start < "2000-01-01") throw httpError(400, "The start date is too far back.");
      if (daysBetween(start, end) + 1 > MAX_RANGE_DAYS) {
        throw httpError(400, `A custom range can cover at most ${MAX_RANGE_DAYS} days. Choose a shorter range.`);
      }
      break;
    }
    default:
      throw httpError(400, "Choose a valid date range.");
  }
  const meta = RANGES.find((r) => r.key === key);
  return { key, label: meta.label, start, end, asOf: today, text: `${prettyDay(start)} – ${prettyDay(end)}` };
}

/** DATETIME from mysql2 (a Date in server-local time, or a string) → "YYYY-MM-DD HH:MM" as stored. */
const dtText = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())} ${pad2(v.getHours())}:${pad2(v.getMinutes())}`;
  }
  return String(v).slice(0, 16);
};
const dayText = (v) => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  return String(v).slice(0, 10);
};

/* ============================================================
   Labels
============================================================ */
const L = {
  po_status: { draft: "Draft", ordered: "Ordered", received: "Received", cancelled: "Cancelled" },
  order_type: { out_of_stock: "Stock-based", new_order: "New order" },
  pay_status: { unpaid: "Unpaid", partial: "Part paid", paid: "Paid" },
  sale_status: {
    completed: "Completed",
    pending: "Pending",
    partially_returned: "Part returned",
    returned: "Returned",
    cancelled: "Cancelled",
  },
  b2b_status: { completed: "Issued", cancelled: "Cancelled" },
  trf_status: { in_transit: "In transit", received: "Received", rejected: "Rejected", cancelled: "Cancelled" },
  ret_status: { pending: "Pending", completed: "Completed", cancelled: "Cancelled" },
  method: {
    cash: "Cash",
    card: "Card",
    upi: "UPI",
    bank_transfer: "Bank transfer",
    credit: "Credit",
    mixed: "Mixed",
    other: "Other",
    debit_note: "Debit note",
  },
  settlement: { debit_note: "Debit note", refund: "Refund" },
  unit: { strip: "Strip", tablet: "Tablet", pack: "Pack" },
};
const options = (map) => Object.entries(map).map(([value, label]) => ({ value, label }));

/* ============================================================
   Shared SQL pieces
============================================================ */
// "Dolo 650 650 mg" style name, as the transfer screen shows it
const MED_NAME = (lineIdCol, medIdCol) => `CASE WHEN ${lineIdCol} IS NULL THEN NULL ELSE TRIM(CONCAT(
    COALESCE(NULLIF(md.brand_name, ''), NULLIF(md.medicine_name, ''), CONCAT('Medicine #', ${medIdCol})),
    IF(md.strength IS NULL OR md.strength = '', '', CONCAT(' ', md.strength)))) END`;

// who did it: the tenant admin (id = admin_id) or one of their staff
const PERSON = (idCol, adminCol, staffAlias, adminAlias) =>
  `CASE WHEN ${idCol} IS NULL THEN NULL WHEN ${idCol} = ${adminCol} THEN COALESCE(${adminAlias}.name, 'Admin')
        ELSE COALESCE(${staffAlias}.name, CONCAT('User #', ${idCol})) END`;

const JSON_STR = (col, pathExpr) =>
  `NULLIF(IF(JSON_VALID(${col}), JSON_UNQUOTE(JSON_EXTRACT(${col}, '${pathExpr}')), NULL), 'null')`;

/* ============================================================
   Column helpers
   type: text | enum | datetime | date | int | money | rate | pct
   level: doc (same on every line of a document) | line
   firstOnly: a document figure printed on its first line only (so column sums are right)
   pdf: width weight in the PDF line table (0 = not in the PDF table)
============================================================ */
const col = (key, label, type, o = {}) => ({
  key,
  label,
  short: o.short || label,
  tip: o.tip || null,
  type,
  level: o.level || "line",
  labels: o.labels || null,
  firstOnly: !!o.firstOnly,
  pdf: o.pdf || 0,
  pdfP: o.pdfP, // width in a PORTRAIT PDF (0 = left out there); unset = same as pdf
  csv: o.csv !== false,
});
const doc = (key, label, type, o = {}) => col(key, label, type, { ...o, level: "doc" });

/* ============================================================
   THE REPORTS
   Every inner SELECT returns, per line: doc_id, doc_no, doc_date, branch_key, status, first_line, line_id
   plus its own columns. `counted` = statuses whose quantities / amounts are added up.
============================================================ */
function purchaseOrderReport({ generated }) {
  const LINE_TOTAL = `CASE WHEN i.id IS NULL THEN NULL WHEN i.total_amount > 0 THEN i.total_amount
      ELSE ROUND(i.quantity * i.purchase_price - COALESCE(i.discount_amount, 0) + COALESCE(i.tax_amount, 0), 2) END`;
  const UPP = `GREATEST(1, COALESCE(NULLIF(i.units_per_pack, 0), NULLIF(m.units_per_pack, 0), 1))`;
  return {
    key: generated ? "generated_orders" : "purchase_orders",
    label: generated ? "Generated Orders" : "Purchase Orders",
    group: "Purchases",
    description: generated
      ? "Orders made from Generate PO (low / out-of-stock items), with their lines."
      : "Every purchase order with its lines, supplier and payment position.",
    perm: "pharmacy.purchase.view",
    docWord: ["order", "orders"],
    dateLabel: "PO date",
    filters: [
      { key: "status", label: "Status", column: "status", options: options(L.po_status) },
      ...(generated ? [] : [{ key: "order_type", label: "Order type", column: "order_type", options: options(L.order_type) }]),
      { key: "payment_status", label: "Payment", column: "payment_status", options: options(L.pay_status) },
    ],
    counted: ["draft", "ordered", "received"],
    supplier: true,
    search: ["doc_no", "invoice_number", "supplier", "supplier_gstin", "medicine", "batch", "hsn"],
    searchHint: "Search PO no., invoice, supplier, medicine or batch",
    chart: {
      metric: "Order value",
      value: "CASE WHEN x.first_line = 1 THEN x.doc_grand END",
      topTitle: "Top suppliers",
      topLabel: "x.supplier",
      topValue: "CASE WHEN x.first_line = 1 THEN x.doc_grand END",
    },
    inner: (adminId) => ({
      sql: `
        SELECT po.id AS doc_id, po.purchase_number AS doc_no, po.purchase_date AS doc_date,
               po.branch AS branch, LOWER(TRIM(po.branch)) AS branch_key, po.status AS status,
               po.order_type, po.payment_status, po.supplier_id,
               s.supplier_name AS supplier, s.gst_number AS supplier_gstin,
               po.invoice_number, po.invoice_date, po.expected_delivery_date,
               po.grand_total AS doc_grand, po.paid_amount AS doc_paid, po.due_amount AS doc_due,
               (i.id IS NULL OR i.id = (SELECT MIN(i2.id) FROM pharmacy_purchase_items i2 WHERE i2.purchase_id = po.id)) AS first_line,
               i.id AS line_id, ${MED_NAME("i.id", "i.medicine_id")} AS medicine, m.hsn_code AS hsn,
               i.batch_number AS batch, i.expiry_date AS expiry,
               i.quantity AS qty, COALESCE(i.free_quantity, 0) AS free_qty,
               CASE WHEN i.id IS NULL THEN NULL ELSE ${UPP} END AS upp,
               CASE WHEN i.id IS NULL THEN NULL ELSE (i.quantity + COALESCE(i.free_quantity, 0)) * ${UPP} END AS tablets,
               i.purchase_price AS rate, i.mrp, i.discount_amount AS discount,
               ${LINE_TOTAL} - COALESCE(i.tax_amount, 0) AS taxable,
               i.gst_percentage AS gst_pct, i.tax_amount AS gst_amount, ${LINE_TOTAL} AS line_total
          FROM pharmacy_purchase_orders po
          LEFT JOIN pharmacy_suppliers s     ON s.id = po.supplier_id AND s.admin_id = po.admin_id
          LEFT JOIN pharmacy_purchase_items i ON i.purchase_id = po.id
          LEFT JOIN pharmacy_medicines m      ON m.id = i.medicine_id
          LEFT JOIN medicine_data md          ON md.id = m.medicine_data_id
         WHERE po.admin_id = ?${generated ? " AND po.order_type = 'out_of_stock'" : ""}`,
      params: [adminId],
    }),
    columns: [
      doc("doc_no", "PO number", "text", { short: "PO No." }),
      doc("doc_date", "PO date", "datetime"),
      doc("branch", "Branch (deliver to)", "text", { short: "Branch" }),
      doc("supplier", "Supplier", "text"),
      doc("supplier_gstin", "Supplier GSTIN", "text", { short: "GSTIN" }),
      doc("order_type", "Order type", "enum", { labels: L.order_type, short: "Type" }),
      doc("invoice_number", "Supplier invoice no.", "text", { short: "Invoice" }),
      doc("invoice_date", "Supplier invoice date", "date", { short: "Invoice date" }),
      doc("expected_delivery_date", "Expected delivery", "date", { short: "Expected" }),
      doc("status", "Order status", "enum", { labels: L.po_status, short: "Status" }),
      doc("payment_status", "Payment status", "enum", { labels: L.pay_status, short: "Payment" }),
      doc("doc_grand", "PO total", "money", { firstOnly: true, tip: "Order total incl. GST, other charges and order discount" }),
      doc("doc_paid", "Paid", "money", { firstOnly: true }),
      doc("doc_due", "Due", "money", { firstOnly: true }),
      col("medicine", "Medicine", "text", { pdf: 4 }),
      col("hsn", "HSN", "text", { pdf: 1.1 }),
      col("batch", "Batch", "text", { pdf: 1.3 }),
      col("expiry", "Expiry", "date", { pdf: 1.3 }),
      col("qty", "Qty (strips)", "int", { short: "Qty", tip: "Strips ordered", pdf: 0.9 }),
      col("free_qty", "Free (strips)", "int", { short: "Free", pdf: 0.8 }),
      col("upp", "Tablets per strip", "int", { short: "Per strip" }),
      col("tablets", "Tablets (incl. free)", "int", { short: "Tablets", tip: "(Qty + free) × tablets per strip" }),
      col("rate", "Rate per strip", "rate", { short: "Rate", pdf: 1.2 }),
      col("mrp", "MRP per strip", "money", { short: "MRP" }),
      col("discount", "Discount", "money", { short: "Disc.", pdf: 1 }),
      col("taxable", "Taxable value", "money", { short: "Taxable" }),
      col("gst_pct", "GST %", "pct", { pdf: 0.8 }),
      col("gst_amount", "GST amount", "money", { short: "GST", pdf: 1.1 }),
      col("line_total", "Line amount", "money", { short: "Amount", pdf: 1.4 }),
    ],
    view: {
      party: "supplier",
      partySub: ["supplier_gstin"],
      chips: ["status", "payment_status", ...(generated ? [] : ["order_type"])],
      meta: ["invoice_number", "invoice_date", "expected_delivery_date"],
      amounts: ["doc_grand", "doc_paid", "doc_due"],
      lines: [
        { key: "medicine", sub: ["hsn", "batch", "expiry"] },
        { key: "qty", sub: ["free_qty", "tablets"] },
        { key: "rate" },
        { key: "gst_amount", sub: ["gst_pct"] },
        { key: "line_total" },
      ],
    },
    totals: [
      { key: "documents", label: "Orders", type: "int" },
      { key: "lines", label: "Lines", type: "int" },
      { key: "qty", label: "Strips", type: "int", sum: "qty" },
      { key: "free_qty", label: "Free strips", type: "int", sum: "free_qty" },
      { key: "taxable", label: "Taxable", type: "money", sum: "taxable" },
      { key: "gst_amount", label: "GST", type: "money", sum: "gst_amount" },
      { key: "doc_grand", label: "Order value", type: "money", docSum: "doc_grand" },
      { key: "doc_paid", label: "Paid", type: "money", docSum: "doc_paid" },
      { key: "doc_due", label: "Due", type: "money", docSum: "doc_due" },
    ],
  };
}

function saleReport({ b2b }) {
  const LEGACY_B2B = `LEFT(ps.notes, 8) = '{"b2b":1'`;
  const BATCH_UPP = `GREATEST(1, COALESCE(NULLIF(b.units_per_pack, 0), 1))`;
  // pharmacyUnits.readSaleLine, in SQL
  const SALE_UNIT = `CASE WHEN i.id IS NULL THEN NULL WHEN i.sale_unit IS NOT NULL THEN i.sale_unit
      WHEN ${LEGACY_B2B} THEN 'tablet' WHEN ${BATCH_UPP} > 1 THEN 'strip' ELSE 'pack' END`;
  const TABLETS = `CASE WHEN i.id IS NULL THEN NULL
      WHEN i.sale_unit IS NOT NULL THEN COALESCE(i.tablets,
           IF(i.sale_unit = 'tablet', i.quantity, i.quantity * GREATEST(1, COALESCE(NULLIF(i.units_per_pack, 0), ${BATCH_UPP}))))
      WHEN ${LEGACY_B2B} THEN i.quantity
      ELSE i.quantity * ${BATCH_UPP} END`;
  const LINE_TOTAL = `CASE WHEN i.id IS NULL THEN NULL WHEN i.total_amount > 0 THEN i.total_amount
      ELSE ROUND(i.quantity * i.unit_price - COALESCE(i.discount_amount, 0) + COALESCE(i.tax_amount, 0), 2) END`;
  const word = b2b ? "Invoice" : "Bill";
  const party = b2b ? "Buyer" : "Customer";
  return {
    key: b2b ? "b2b_orders" : "sales_orders",
    label: b2b ? "B2B Orders" : "Sales Orders",
    group: "Sales",
    description: b2b
      ? "B2B tax invoices to other businesses, line by line, with buyer GSTIN and payments."
      : "Retail (POS) bills, line by line. Parked drafts are not included.",
    perm: b2b ? "pharmacy.b2b_sales.view" : "pharmacy.sales.view",
    docWord: b2b ? ["invoice", "invoices"] : ["bill", "bills"],
    dateLabel: b2b ? "Invoice date" : "Bill date",
    filters: [
      { key: "status", label: "Status", column: "status", options: options(b2b ? L.b2b_status : L.sale_status) },
      { key: "payment_status", label: "Payment", column: "payment_status", options: options(L.pay_status) },
    ],
    counted: b2b ? ["completed"] : ["completed", "partially_returned", "returned"],
    search: ["doc_no", "party", "party_phone", "party_gstin", "medicine", "batch", "hsn"],
    searchHint: b2b ? "Search invoice no., buyer, GSTIN, medicine or batch" : "Search bill no., customer, phone, medicine or batch",
    chart: {
      metric: b2b ? "Invoice value" : "Bill value",
      value: "CASE WHEN x.first_line = 1 THEN x.doc_grand END",
      topTitle: "Top medicines",
      topLabel: "x.medicine",
      topValue: "x.line_total",
    },
    inner: (adminId) => ({
      sql: `
        SELECT ps.id AS doc_id, ps.sale_number AS doc_no, ps.sale_date AS doc_date,
               ps.branch AS branch, LOWER(TRIM(ps.branch)) AS branch_key, ps.status AS status,
               ps.payment_status, ps.payment_method,
               COALESCE(NULLIF(ps.customer_name, ''), ${JSON_STR("ps.notes", "$.buyer.name")}) AS party,
               ${b2b ? JSON_STR("ps.notes", "$.buyer.gstin") : "NULL"} AS party_gstin,
               ps.customer_phone AS party_phone, ps.doctor_name,
               ${PERSON("ps.sold_by", "ps.admin_id", "st", "a")} AS sold_by,
               ps.grand_total AS doc_grand, ps.paid_amount AS doc_paid, ps.due_amount AS doc_due,
               (i.id IS NULL OR i.id = (SELECT MIN(i2.id) FROM pharmacy_sale_items i2 WHERE i2.sale_id = ps.id)) AS first_line,
               i.id AS line_id, ${MED_NAME("i.id", "i.medicine_id")} AS medicine, m.hsn_code AS hsn,
               b.batch_number AS batch, b.expiry_date AS expiry,
               ${SALE_UNIT} AS sale_unit, i.quantity AS qty, ${TABLETS} AS tablets,
               i.unit_price AS rate, i.discount_amount AS discount,
               ${LINE_TOTAL} - COALESCE(i.tax_amount, 0) AS taxable,
               i.gst_percentage AS gst_pct, i.tax_amount AS gst_amount, ${LINE_TOTAL} AS line_total
          FROM pharmacy_sales ps
          LEFT JOIN pharmacy_sale_items i        ON i.sale_id = ps.id
          LEFT JOIN pharmacy_medicine_batches b  ON b.id = i.batch_id
          LEFT JOIN pharmacy_medicines m         ON m.id = i.medicine_id
          LEFT JOIN medicine_data md             ON md.id = m.medicine_data_id
          LEFT JOIN staff st                     ON st.id = ps.sold_by AND st.admin_id = ps.admin_id
          LEFT JOIN admins a                     ON a.id = ps.admin_id
         WHERE ps.admin_id = ?
           AND ${b2b ? "ps.sale_number LIKE 'B2B-%'" : "ps.sale_number NOT LIKE 'B2B-%' AND ps.sale_number NOT LIKE 'DRAFT-%' AND ps.status <> 'draft'"}`,
      params: [adminId],
    }),
    columns: [
      doc("doc_no", `${word} number`, "text", { short: `${word} No.` }),
      doc("doc_date", `${word} date`, "datetime"),
      doc("branch", "Branch", "text"),
      doc("party", party, "text"),
      ...(b2b ? [doc("party_gstin", "Buyer GSTIN", "text", { short: "GSTIN" })] : []),
      doc("party_phone", "Phone", "text"),
      ...(b2b ? [] : [doc("doctor_name", "Doctor", "text")]),
      ...(b2b ? [] : [doc("payment_method", "Payment method", "enum", { labels: L.method, short: "Paid by" })]),
      doc("status", `${word} status`, "enum", { labels: b2b ? L.b2b_status : L.sale_status, short: "Status" }),
      doc("payment_status", "Payment status", "enum", { labels: L.pay_status, short: "Payment" }),
      doc("sold_by", "Sold by", "text"),
      doc("doc_grand", `${word} total`, "money", { firstOnly: true }),
      doc("doc_paid", "Paid", "money", { firstOnly: true }),
      doc("doc_due", "Due", "money", { firstOnly: true }),
      col("medicine", "Medicine", "text", { pdf: 4 }),
      col("hsn", "HSN", "text", { pdf: 1.1 }),
      col("batch", "Batch", "text", { pdf: 1.3 }),
      col("expiry", "Expiry", "date", { pdf: 1.3 }),
      col("sale_unit", "Sold as", "enum", { labels: L.unit, pdf: 0.9 }),
      col("qty", "Qty", "int", { tip: "In the unit it was sold as", pdf: 0.7 }),
      col("tablets", "Tablets", "int", { tip: "Tablets that left stock", pdf: 0.9 }),
      col("rate", "Rate", "rate", { tip: "Price of one unit sold", pdf: 1.1 }),
      col("discount", "Discount", "money", { short: "Disc.", pdf: 0.9 }),
      col("taxable", "Taxable value", "money", { short: "Taxable" }),
      col("gst_pct", "GST %", "pct", { pdf: 0.8 }),
      col("gst_amount", "GST amount", "money", { short: "GST", pdf: 1 }),
      col("line_total", "Line amount", "money", { short: "Amount", pdf: 1.3 }),
    ],
    view: {
      party: "party",
      partySub: b2b ? ["party_gstin", "party_phone"] : ["party_phone", "doctor_name"],
      chips: ["status", "payment_status"],
      meta: b2b ? ["sold_by"] : ["payment_method", "sold_by"],
      amounts: ["doc_grand", "doc_paid", "doc_due"],
      lines: [
        { key: "medicine", sub: ["hsn", "batch", "expiry"] },
        { key: "qty", sub: ["sale_unit", "tablets"] },
        { key: "rate", sub: ["discount"] },
        { key: "gst_amount", sub: ["gst_pct"] },
        { key: "line_total" },
      ],
    },
    totals: [
      { key: "documents", label: b2b ? "Invoices" : "Bills", type: "int" },
      { key: "lines", label: "Lines", type: "int" },
      { key: "tablets", label: "Tablets sold", type: "int", sum: "tablets" },
      { key: "taxable", label: "Taxable", type: "money", sum: "taxable" },
      { key: "gst_amount", label: "GST", type: "money", sum: "gst_amount" },
      { key: "doc_grand", label: b2b ? "Invoice value" : "Bill value", type: "money", docSum: "doc_grand" },
      { key: "doc_paid", label: "Received", type: "money", docSum: "doc_paid" },
      { key: "doc_due", label: "Due", type: "money", docSum: "doc_due" },
    ],
  };
}

function transferReport() {
  const UPP = `GREATEST(1, COALESCE(NULLIF(b.units_per_pack, 0), 1))`;
  return {
    key: "purchase_transfers",
    label: "Purchase Transfers",
    group: "Stock",
    description: "Branch-to-branch stock transfers with each batch sent. Staff see transfers from or to their branch.",
    perm: "pharmacy.purchase_transfer.view",
    docWord: ["transfer", "transfers"],
    dateLabel: "Sent date",
    filters: [{ key: "status", label: "Status", column: "status", options: options(L.trf_status) }],
    counted: ["in_transit", "received"],
    search: ["doc_no", "from_branch", "to_branch", "sent_by", "medicine", "batch", "supplier"],
    searchHint: "Search transfer no., branch, medicine, batch or supplier",
    chart: {
      metric: "Value sent",
      value: "x.value",
      topTitle: "Top routes",
      topLabel: "CONCAT(COALESCE(x.from_branch, '?'), ' → ', COALESCE(x.to_branch, '?'))",
      topValue: "x.value",
    },
    // a transfer involves two branches: it belongs to both
    branchSql: "(x.from_key = ? OR x.to_key = ?)",
    branchParams: (key) => [key, key],
    inner: (adminId) => ({
      sql: `
        SELECT g.first_id AS doc_id, o.reference_number AS doc_no, g.sent_at AS doc_date,
               ${JSON_STR("h.notes", "$.from_branch")} AS from_branch,
               LOWER(TRIM(${JSON_STR("h.notes", "$.from_key")})) AS from_key,
               ${JSON_STR("h.notes", "$.to_branch")} AS to_branch,
               LOWER(TRIM(${JSON_STR("h.notes", "$.to_key")})) AS to_key,
               NULL AS branch_key,
               CASE WHEN c.id IS NULL THEN 'in_transit'
                    WHEN c.transaction_type = 'transfer_in' THEN 'received'
                    ELSE COALESCE(${JSON_STR("c.notes", "$.action")}, 'in_transit') END AS status,
               COALESCE(${JSON_STR("h.notes", "$.by_name")}, ${PERSON("h.created_by", "h.admin_id", "st", "a")}) AS sent_by,
               ${JSON_STR("h.notes", "$.remarks")} AS remarks,
               c.transaction_date AS closed_at,
               ${JSON_STR("c.notes", "$.by_name")} AS closed_by,
               ${JSON_STR("c.notes", "$.reason")} AS close_reason,
               (o.id = g.first_id) AS first_line,
               o.id AS line_id, ${MED_NAME("o.id", "o.medicine_id")} AS medicine,
               b.batch_number AS batch, b.expiry_date AS expiry, sp.supplier_name AS supplier,
               ${UPP} AS upp, o.quantity_out AS tablets,
               FLOOR(o.quantity_out / ${UPP}) AS strips, MOD(o.quantity_out, ${UPP}) AS loose,
               b.purchase_price AS rate,
               ROUND(o.quantity_out / ${UPP} * COALESCE(b.purchase_price, 0), 2) AS value
          FROM pharmacy_stock_transactions o
          JOIN (SELECT reference_number AS ref, MIN(id) AS first_id, MIN(transaction_date) AS sent_at
                  FROM pharmacy_stock_transactions
                 WHERE admin_id = ? AND transaction_type = 'transfer_out'
                 GROUP BY reference_number) g ON g.ref = o.reference_number
          JOIN pharmacy_stock_transactions h ON h.id = g.first_id
          LEFT JOIN (SELECT reference_number AS ref, MIN(id) AS close_id
                       FROM pharmacy_stock_transactions
                      WHERE admin_id = ? AND transaction_type IN ('transfer_in', 'transfer_return')
                      GROUP BY reference_number) cg ON cg.ref = o.reference_number
          LEFT JOIN pharmacy_stock_transactions c ON c.id = cg.close_id
          LEFT JOIN pharmacy_medicine_batches b   ON b.id = o.batch_id
          LEFT JOIN pharmacy_suppliers sp         ON sp.id = b.supplier_id AND sp.admin_id = o.admin_id
          LEFT JOIN pharmacy_medicines m          ON m.id = o.medicine_id
          LEFT JOIN medicine_data md              ON md.id = m.medicine_data_id
          LEFT JOIN staff st                      ON st.id = h.created_by AND st.admin_id = h.admin_id
          LEFT JOIN admins a                      ON a.id = h.admin_id
         WHERE o.admin_id = ? AND o.transaction_type = 'transfer_out'`,
      params: [adminId, adminId, adminId],
    }),
    columns: [
      doc("doc_no", "Transfer number", "text", { short: "Transfer No." }),
      doc("doc_date", "Sent on", "datetime"),
      doc("from_branch", "From branch", "text", { short: "From" }),
      doc("to_branch", "To branch", "text", { short: "To" }),
      doc("status", "Status", "enum", { labels: L.trf_status }),
      doc("sent_by", "Sent by", "text"),
      doc("remarks", "Remarks", "text"),
      doc("closed_at", "Accepted / returned on", "datetime", { short: "Closed on" }),
      doc("closed_by", "Accepted / returned by", "text", { short: "Closed by" }),
      doc("close_reason", "Reason", "text"),
      doc("doc_value", "Transfer value", "money", { firstOnly: true, tip: "At purchase rate" }),
      col("medicine", "Medicine", "text", { pdf: 4 }),
      col("batch", "Batch", "text", { pdf: 1.3 }),
      col("expiry", "Expiry", "date", { pdf: 1.2 }),
      col("supplier", "Supplier (of the batch)", "text", { short: "Supplier", pdf: 2.2 }),
      col("upp", "Tablets per strip", "int", { short: "Per strip" }),
      col("strips", "Strips", "int", { pdf: 0.8 }),
      col("loose", "Loose tablets", "int", { short: "Loose", pdf: 0.8 }),
      col("tablets", "Tablets", "int", { tip: "Total tablets sent", pdf: 0.9 }),
      col("rate", "Purchase rate per strip", "rate", { short: "Rate", pdf: 1.1 }),
      col("value", "Value at purchase rate", "money", { short: "Value", pdf: 1.3 }),
    ],
    docSums: [{ key: "doc_value", from: "value" }],
    view: {
      party: "route",
      partySub: ["sent_by"],
      chips: ["status"],
      meta: ["remarks", "closed_at", "closed_by", "close_reason"],
      amounts: ["doc_value"],
      lines: [
        { key: "medicine", sub: ["batch", "expiry", "supplier"] },
        { key: "tablets", sub: ["strips", "loose"] },
        { key: "rate" },
        { key: "value" },
      ],
    },
    totals: [
      { key: "documents", label: "Transfers", type: "int" },
      { key: "lines", label: "Lines", type: "int" },
      { key: "tablets", label: "Tablets sent", type: "int", sum: "tablets" },
      { key: "value", label: "Value sent", type: "money", sum: "value" },
    ],
  };
}

function purchaseReturnReport() {
  return {
    key: "purchase_returns",
    label: "Purchase Returns",
    group: "Purchases",
    description: "Stock returned to suppliers, with the debit note or refund that settled it.",
    perm: "pharmacy.purchase_return.view",
    docWord: ["return", "returns"],
    dateLabel: "Return date",
    filters: [{ key: "status", label: "Status", column: "status", options: options(L.ret_status) }],
    counted: ["pending", "completed"],
    supplier: true,
    search: ["doc_no", "po_no", "invoice_number", "supplier", "medicine", "batch"],
    searchHint: "Search return no., PO no., supplier, medicine or batch",
    chart: {
      metric: "Return value",
      value: "CASE WHEN x.first_line = 1 THEN x.doc_grand END",
      topTitle: "Top suppliers",
      topLabel: "x.supplier",
      topValue: "CASE WHEN x.first_line = 1 THEN x.doc_grand END",
    },
    inner: (adminId) => ({
      sql: `
        SELECT r.id AS doc_id, r.return_number AS doc_no, r.return_date AS doc_date,
               r.branch AS branch, LOWER(TRIM(r.branch)) AS branch_key, r.status AS status, r.supplier_id,
               s.supplier_name AS supplier, s.gst_number AS supplier_gstin,
               po.purchase_number AS po_no, po.invoice_number,
               r.settlement, r.reason, ${PERSON("r.processed_by", "r.admin_id", "st", "a")} AS processed_by,
               r.total_amount AS doc_grand, r.refund_amount AS doc_refund, r.credit_applied AS doc_credit,
               (ri.id IS NULL OR ri.id = (SELECT MIN(r2.id) FROM pharmacy_return_items r2 WHERE r2.return_id = r.id)) AS first_line,
               ri.id AS line_id, ${MED_NAME("ri.id", "ri.medicine_id")} AS medicine,
               b.batch_number AS batch, b.expiry_date AS expiry,
               CASE WHEN ri.id IS NULL THEN NULL ELSE COALESCE(ri.sale_unit, 'tablet') END AS sale_unit,
               ri.quantity AS qty,
               CASE WHEN ri.id IS NULL THEN NULL ELSE COALESCE(ri.tablets,
                    IF(ri.sale_unit IS NULL OR ri.sale_unit = 'tablet', ri.quantity,
                       ri.quantity * GREATEST(1, COALESCE(NULLIF(ri.units_per_pack, 0), NULLIF(b.units_per_pack, 0), 1)))) END AS tablets,
               ri.unit_price AS rate, ri.gst_percentage AS gst_pct, ri.tax_amount AS gst_amount,
               ri.total_amount AS line_total, ri.reason AS line_reason
          FROM pharmacy_returns r
          LEFT JOIN pharmacy_suppliers s         ON s.id = r.supplier_id AND s.admin_id = r.admin_id
          LEFT JOIN pharmacy_purchase_orders po  ON po.id = r.purchase_id AND po.admin_id = r.admin_id
          LEFT JOIN pharmacy_return_items ri     ON ri.return_id = r.id
          LEFT JOIN pharmacy_medicine_batches b  ON b.id = ri.batch_id
          LEFT JOIN pharmacy_medicines m         ON m.id = ri.medicine_id
          LEFT JOIN medicine_data md             ON md.id = m.medicine_data_id
          LEFT JOIN staff st                     ON st.id = r.processed_by AND st.admin_id = r.admin_id
          LEFT JOIN admins a                     ON a.id = r.admin_id
         WHERE r.admin_id = ? AND r.return_type = 'supplier_return'`,
      params: [adminId],
    }),
    columns: [
      doc("doc_no", "Return number", "text", { short: "Return No." }),
      doc("doc_date", "Return date", "datetime"),
      doc("branch", "Branch", "text"),
      doc("supplier", "Supplier", "text"),
      doc("supplier_gstin", "Supplier GSTIN", "text", { short: "GSTIN" }),
      doc("po_no", "Against PO", "text", { short: "PO No." }),
      doc("invoice_number", "Supplier invoice no.", "text", { short: "Invoice" }),
      doc("settlement", "Settled by", "enum", { labels: L.settlement }),
      doc("reason", "Reason", "text"),
      doc("status", "Status", "enum", { labels: L.ret_status }),
      doc("processed_by", "Processed by", "text"),
      doc("doc_grand", "Return total", "money", { firstOnly: true }),
      doc("doc_refund", "Refunded", "money", { firstOnly: true }),
      doc("doc_credit", "Debit note set off", "money", { firstOnly: true, short: "Set off" }),
      col("medicine", "Medicine", "text", { pdf: 4 }),
      col("batch", "Batch", "text", { pdf: 1.3 }),
      col("expiry", "Expiry", "date", { pdf: 1.2 }),
      col("sale_unit", "Returned as", "enum", { labels: L.unit, short: "As", pdf: 0.9 }),
      col("qty", "Qty", "int", { pdf: 0.7 }),
      col("tablets", "Tablets", "int", { pdf: 0.9 }),
      col("rate", "Rate", "rate", { pdf: 1.1 }),
      col("gst_pct", "GST %", "pct", { pdf: 0.8 }),
      col("gst_amount", "GST amount", "money", { short: "GST", pdf: 1 }),
      col("line_total", "Line amount", "money", { short: "Amount", pdf: 1.3 }),
      col("line_reason", "Line reason", "text", { short: "Why", pdf: 1.4 }),
    ],
    view: {
      party: "supplier",
      partySub: ["supplier_gstin"],
      chips: ["status", "settlement"],
      meta: ["po_no", "invoice_number", "reason", "processed_by"],
      amounts: ["doc_grand", "doc_refund", "doc_credit"],
      lines: [
        { key: "medicine", sub: ["batch", "expiry", "line_reason"] },
        { key: "qty", sub: ["sale_unit", "tablets"] },
        { key: "rate" },
        { key: "gst_amount", sub: ["gst_pct"] },
        { key: "line_total" },
      ],
    },
    totals: [
      { key: "documents", label: "Returns", type: "int" },
      { key: "lines", label: "Lines", type: "int" },
      { key: "tablets", label: "Tablets returned", type: "int", sum: "tablets" },
      { key: "gst_amount", label: "GST", type: "money", sum: "gst_amount" },
      { key: "doc_grand", label: "Return value", type: "money", docSum: "doc_grand" },
      { key: "doc_refund", label: "Refunded", type: "money", docSum: "doc_refund" },
      { key: "doc_credit", label: "Debit notes", type: "money", docSum: "doc_credit" },
    ],
  };
}

function supplierPaymentReport() {
  return {
    key: "supplier_payments",
    label: "Supplier Payments",
    group: "Purchases",
    description: "Money paid to suppliers against purchase orders, including debit notes set off.",
    perm: "pharmacy.purchase.view",
    docWord: ["payment", "payments"],
    dateLabel: "Payment date",
    singleRow: true,
    filters: [{ key: "method", label: "Method", column: "payment_method", options: options({
      cash: L.method.cash, upi: L.method.upi, card: L.method.card, bank_transfer: L.method.bank_transfer,
      other: L.method.other, debit_note: L.method.debit_note,
    }) }],
    counted: null, // every payment counts
    supplier: true,
    search: ["doc_no", "po_no", "invoice_number", "supplier", "reference"],
    searchHint: "Search payment no., PO no., invoice, supplier or reference",
    chart: {
      metric: "Amount paid",
      value: "x.amount",
      topTitle: "By method",
      topLabel: "x.payment_method",
      topLabels: L.method,
      topValue: "x.amount",
    },
    inner: (adminId) => ({
      sql: `
        SELECT p.id AS doc_id, p.payment_number AS doc_no, p.payment_date AS doc_date,
               po.branch AS branch, LOWER(TRIM(po.branch)) AS branch_key, NULL AS status, po.supplier_id,
               s.supplier_name AS supplier, s.gst_number AS supplier_gstin,
               po.purchase_number AS po_no, po.invoice_number,
               p.payment_method, p.transaction_reference AS reference, p.amount, p.notes,
               ${PERSON("p.received_by", "p.admin_id", "st", "a")} AS recorded_by,
               1 AS first_line, p.id AS line_id
          FROM pharmacy_payments p
          JOIN pharmacy_purchase_orders po ON po.id = p.purchase_id AND po.admin_id = p.admin_id
          LEFT JOIN pharmacy_suppliers s   ON s.id = po.supplier_id AND s.admin_id = po.admin_id
          LEFT JOIN staff st               ON st.id = p.received_by AND st.admin_id = p.admin_id
          LEFT JOIN admins a               ON a.id = p.admin_id
         WHERE p.admin_id = ? AND p.purchase_id IS NOT NULL`,
      params: [adminId],
    }),
    columns: [
      // portrait PDF: GSTIN and invoice are left out (they stay in landscape and in the CSV)
      doc("doc_no", "Payment number", "text", { short: "Payment No.", pdf: 1.6, pdfP: 1.5 }),
      doc("doc_date", "Paid on", "datetime", { pdf: 1.5, pdfP: 1.75 }),
      doc("branch", "Branch", "text", { pdf: 1.3, pdfP: 1.25 }),
      doc("supplier", "Supplier", "text", { pdf: 2.6, pdfP: 2.3 }),
      doc("supplier_gstin", "Supplier GSTIN", "text", { short: "GSTIN", pdf: 1.8, pdfP: 0 }),
      doc("po_no", "PO number", "text", { short: "PO No.", pdf: 1.6, pdfP: 1.85 }),
      doc("invoice_number", "Supplier invoice no.", "text", { short: "Invoice", pdf: 1.3, pdfP: 0 }),
      doc("payment_method", "Method", "enum", { labels: L.method, pdf: 1.1, pdfP: 1.55 }),
      doc("reference", "Reference", "text", { pdf: 1.5, pdfP: 1.6 }),
      doc("recorded_by", "Recorded by", "text", { pdf: 1.3, pdfP: 1.3 }),
      doc("notes", "Notes", "text"),
      doc("amount", "Amount", "money", { pdf: 1.3, pdfP: 1.4 }),
    ],
    view: {
      table: ["doc_no", "doc_date", "branch", "supplier", "po_no", "payment_method", "reference", "amount"],
    },
    totals: [
      { key: "documents", label: "Payments", type: "int" },
      { key: "amount", label: "Total", type: "money", sum: "amount" },
      { key: "paid_money", label: "Cash / bank", type: "money", sumSql: "CASE WHEN x.payment_method <> 'debit_note' THEN x.amount END" },
      { key: "paid_debit", label: "Debit notes", type: "money", sumSql: "CASE WHEN x.payment_method = 'debit_note' THEN x.amount END" },
    ],
  };
}

const REPORTS = [
  purchaseOrderReport({ generated: false }),
  purchaseOrderReport({ generated: true }),
  supplierPaymentReport(),
  purchaseReturnReport(),
  transferReport(),
  saleReport({ b2b: true }),
  saleReport({ b2b: false }),
];
const REPORT_BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));

/* ============================================================
   Request → report, range, branch scope, filters
============================================================ */
async function readRequest(req) {
  const type = clean(req.query.type);
  const report = REPORT_BY_KEY.get(type);
  if (!report) throw httpError(400, "Choose a report type.");
  if (!userCan(req, report.perm)) throw httpError(403, `You don't have access to the ${report.label} report.`);

  const range = resolveRange(req.query);
  const scope = await resolveScope(db, req, { wanted: clean(req.query.branch) || undefined });

  const filters = {};
  for (const f of report.filters) {
    const v = clean(req.query[f.key]);
    if (!v || v === "all") continue;
    const opt = f.options.find((o) => o.value === v);
    if (!opt) throw httpError(400, `"${v}" is not a valid ${f.label.toLowerCase()} for this report.`);
    filters[f.key] = opt;
  }

  // supplier (purchase-side reports): must be one of this pharmacy's suppliers
  let supplier = null;
  const sid = clean(req.query.supplier_id);
  if (sid && sid !== "all") {
    if (!report.supplier) throw httpError(400, "This report can't be filtered by supplier.");
    if (!/^\d{1,12}$/.test(sid)) throw httpError(400, "Choose a supplier from the list.");
    const [rows] = await db.query(
      { sql: `SELECT id, supplier_name FROM pharmacy_suppliers WHERE id = ? AND admin_id = ? LIMIT 1`, timeout: QUERY_TIMEOUT_MS },
      [Number(sid), scope.actor.adminId]
    );
    if (!rows.length) throw httpError(400, "That supplier isn't one of yours.");
    supplier = { id: Number(rows[0].id), name: rows[0].supplier_name };
  }

  const search = clean(req.query.q).slice(0, SEARCH_MAX);
  return { report, range, scope, filters, supplier, search };
}

/** LIKE pattern with %, _ and \ taken literally */
const likeAny = (s) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** WHERE for the outer query over the report's inner SELECT (aliased x). */
function buildWhere({ report, range, scope, filters, supplier, search }) {
  const from = `${range.start} 00:00:00`;
  const to = `${addDays(range.end, 1)} 00:00:00`;
  const where = ["x.doc_date >= ?", "x.doc_date < ?"];
  const params = [from, to];
  if (supplier) {
    where.push("x.supplier_id = ?");
    params.push(supplier.id);
  }
  // search keeps WHOLE documents: any document with a field or a line that matches
  if (search && report.search) {
    const inner = report.inner(scope.actor.adminId);
    // lower-cased on both sides: fields read from JSON (branch names, B2B buyer) come back utf8mb4_bin,
    // where LIKE would be case-sensitive
    const like = likeAny(search.toLowerCase());
    where.push(
      `x.doc_id IN (SELECT y.doc_id FROM (${inner.sql}) y WHERE y.doc_date >= ? AND y.doc_date < ?
                     AND (${report.search.map((c) => `LOWER(y.${c}) LIKE ?`).join(" OR ")}))`
    );
    params.push(...inner.params, from, to, ...report.search.map(() => like));
  }
  if (scope.filter) {
    if (report.branchSql) {
      where.push(report.branchSql);
      params.push(...report.branchParams(scope.key));
    } else {
      where.push("x.branch_key = ?");
      params.push(scope.key);
    }
  }
  for (const f of report.filters) {
    if (!filters[f.key]) continue;
    where.push(`x.${f.column} = ?`);
    params.push(filters[f.key].value);
  }
  return { sql: where.join(" AND "), params };
}

/** The statuses whose quantities / amounts are added up — null = every row counts. */
function countedStatuses(report, filters) {
  if (!report.counted) return null;
  // filtering ON a status that normally doesn't count → show its figures
  if (filters.status && !report.counted.includes(filters.status.value)) return null;
  return report.counted;
}

/** SQL condition for "this row's quantities / amounts are added up". */
function countedSql(report, filters) {
  const list = countedStatuses(report, filters);
  return list ? `x.status IN (${list.map((s) => `'${s}'`).join(", ")})` : "1 = 1";
}

/* ============================================================
   Queries
============================================================ */
async function queryTotals(q, ctx, adminId) {
  const { report, filters } = ctx;
  const inner = report.inner(adminId);
  const w = buildWhere(ctx);
  const C = countedSql(report, filters);
  const parts = [
    "COUNT(DISTINCT x.doc_id) AS doc_count",
    "COUNT(x.line_id) AS line_count",
    `COUNT(DISTINCT CASE WHEN NOT (${C}) THEN x.doc_id END) AS excluded_count`,
  ];
  for (const t of report.totals) {
    if (t.key === "documents" || t.key === "lines") continue;
    if (t.sum) parts.push(`COALESCE(SUM(CASE WHEN ${C} THEN x.${t.sum} END), 0) AS \`${t.key}\``);
    else if (t.docSum) parts.push(`COALESCE(SUM(CASE WHEN ${C} AND x.first_line = 1 THEN x.${t.docSum} END), 0) AS \`${t.key}\``);
    else if (t.sumSql) parts.push(`COALESCE(SUM(CASE WHEN ${C} THEN ${t.sumSql} END), 0) AS \`${t.key}\``);
  }
  const [[row]] = await q.query(
    { sql: `SELECT ${parts.join(", ")} FROM (${inner.sql}) x WHERE ${w.sql}`, timeout: QUERY_TIMEOUT_MS },
    [...inner.params, ...w.params]
  );
  const totals = report.totals.map((t) => {
    const raw = Number(t.key === "documents" ? row.doc_count : t.key === "lines" ? row.line_count : row[t.key]) || 0;
    return { key: t.key, label: t.label, type: t.type, value: t.type === "money" ? money(raw) : Math.round(raw) };
  });
  return {
    documents: Number(row.doc_count) || 0,
    lines: Number(row.line_count) || 0,
    excluded: Number(row.excluded_count) || 0,
    totals,
  };
}

/** One page of whole documents (oldest first) with all their lines. */
async function queryDocuments(q, ctx, adminId, offset, limit) {
  const inner = ctx.report.inner(adminId);
  const w = buildWhere(ctx);
  const [ids] = await q.query(
    {
      sql: `SELECT x.doc_id FROM (${inner.sql}) x WHERE ${w.sql}
             GROUP BY x.doc_id ORDER BY MIN(x.doc_date) ASC, x.doc_id ASC LIMIT ? OFFSET ?`,
      timeout: QUERY_TIMEOUT_MS,
    },
    [...inner.params, ...w.params, limit, offset]
  );
  if (!ids.length) return [];
  const docIds = ids.map((r) => r.doc_id);
  const [rows] = await q.query(
    {
      sql: `SELECT x.* FROM (${inner.sql}) x WHERE ${w.sql} AND x.doc_id IN (?)
             ORDER BY x.doc_date ASC, x.doc_id ASC, x.line_id ASC`,
      timeout: QUERY_TIMEOUT_MS,
    },
    [...inner.params, ...w.params, docIds]
  );
  return groupDocuments(ctx, rows);
}

/**
 * Every matching document, oldest first, in ONE streamed query (files). Same WHERE and the same
 * order as the preview pages; rows of one document arrive together and are grouped as they come.
 */
async function eachDocument(conn, ctx, adminId, onDoc) {
  const inner = ctx.report.inner(adminId);
  const w = buildWhere(ctx);
  const raw = conn.connection || conn; // mysql2/promise PoolConnection → the streaming connection
  const stream = raw
    .query({
      sql: `SELECT x.* FROM (${inner.sql}) x WHERE ${w.sql} ORDER BY x.doc_date ASC, x.doc_id ASC, x.line_id ASC`,
      values: [...inner.params, ...w.params],
      timeout: STREAM_TIMEOUT_MS,
    })
    .stream({ highWaterMark: 500 });
  let batch = [];
  let current = null;
  for await (const row of stream) {
    if (current !== null && row.doc_id !== current) {
      await onDoc(groupDocuments(ctx, batch)[0]);
      batch = [];
    }
    current = row.doc_id;
    batch.push(row);
  }
  if (batch.length) await onDoc(groupDocuments(ctx, batch)[0]);
}

/* ============================================================
   Charts: amount over time + top 5, for exactly the report's filters (counted documents only)
============================================================ */
const bucketFor = (range) => {
  const days = daysBetween(range.start, range.end) + 1;
  return days <= 45 ? "day" : days <= 200 ? "week" : "month";
};
const BUCKET_SQL = {
  day: "DATE_FORMAT(x.doc_date, '%Y-%m-%d')",
  week: "DATE_FORMAT(DATE_SUB(DATE(x.doc_date), INTERVAL WEEKDAY(x.doc_date) DAY), '%Y-%m-%d')", // Monday
  month: "DATE_FORMAT(x.doc_date, '%Y-%m-01')",
};
const weekdayMon = (ymd) => (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7;
const bucketLabel = (bucket, ymd) =>
  bucket === "month" ? `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}` : `${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;

/** Every bucket from start to end (so days with nothing show as 0, not as a gap). */
function allBuckets(bucket, start, end) {
  const out = [];
  let k = bucket === "week" ? addDays(start, -weekdayMon(start)) : bucket === "month" ? `${start.slice(0, 8)}01` : start;
  while (k <= end) {
    out.push(k);
    if (bucket === "day") k = addDays(k, 1);
    else if (bucket === "week") k = addDays(k, 7);
    else {
      const y = Number(k.slice(0, 4));
      const m = Number(k.slice(5, 7));
      k = m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`;
    }
  }
  return out;
}

async function chartData(q, ctx, adminId) {
  const { report } = ctx;
  const ch = report.chart;
  const inner = report.inner(adminId);
  const w = buildWhere(ctx);
  const C = countedSql(report, ctx.filters);
  const bucket = bucketFor(ctx.range);
  const [trendRows] = await q.query(
    {
      sql: `SELECT ${BUCKET_SQL[bucket]} AS b, COALESCE(SUM(CASE WHEN ${C} THEN ${ch.value} END), 0) AS v
              FROM (${inner.sql}) x WHERE ${w.sql} GROUP BY b ORDER BY b`,
      timeout: QUERY_TIMEOUT_MS,
    },
    [...inner.params, ...w.params]
  );
  const [topRows] = await q.query(
    {
      sql: `SELECT COALESCE(${ch.topLabel}, '—') AS label, COALESCE(SUM(CASE WHEN ${C} THEN ${ch.topValue} END), 0) AS v
              FROM (${inner.sql}) x WHERE ${w.sql} GROUP BY label HAVING v <> 0 ORDER BY v DESC, label ASC LIMIT 5`,
      timeout: QUERY_TIMEOUT_MS,
    },
    [...inner.params, ...w.params]
  );
  const got = new Map(trendRows.map((r) => [String(r.b), money(r.v)]));
  return {
    metric: ch.metric,
    bucket,
    trend: allBuckets(bucket, ctx.range.start, ctx.range.end).map((k) => ({ key: k, label: bucketLabel(bucket, k), value: got.get(k) || 0 })),
    top: {
      title: ch.topTitle,
      items: topRows.map((r) => ({ label: (ch.topLabels && ch.topLabels[r.label]) || String(r.label), value: money(r.v) })),
    },
  };
}

/* ============================================================
   Shaping rows (one place → preview, CSV and PDF agree)
============================================================ */
function shapeValue(c, v) {
  if (v === null || v === undefined || v === "") return null;
  switch (c.type) {
    case "datetime":
      return dtText(v);
    case "date":
      return dayText(v);
    case "int":
      return Math.round(Number(v));
    case "money":
      return money(v);
    case "rate":
      return Math.round(Number(v) * 10000) / 10000;
    case "pct":
      return Number(v);
    default:
      return String(v);
  }
}

function groupDocuments(ctx, rows) {
  const { report } = ctx;
  const counted = countedStatuses(report, ctx.filters);
  const docCols = report.columns.filter((c) => c.level === "doc");
  const lineCols = report.columns.filter((c) => c.level === "line");
  const docs = [];
  const byId = new Map();
  for (const r of rows) {
    let d = byId.get(r.doc_id);
    if (!d) {
      const values = {};
      for (const c of docCols) values[c.key] = shapeValue(c, r[c.key]);
      if (report.key === "purchase_transfers") values.route = `${r.from_branch || "?"} → ${r.to_branch || "?"}`;
      d = { doc_id: r.doc_id, counted: !counted || counted.includes(r.status), values, lines: [] };
      byId.set(r.doc_id, d);
      docs.push(d);
    }
    if (!report.singleRow && r.line_id !== null && r.line_id !== undefined) {
      const line = { line_id: r.line_id };
      for (const c of lineCols) line[c.key] = shapeValue(c, r[c.key]);
      d.lines.push(line);
    }
  }
  // document figures added up from its lines (all lines of a document are always fetched together)
  for (const s of report.docSums || []) {
    for (const d of docs) d.values[s.key] = money(d.lines.reduce((a, l) => a + (Number(l[s.from]) || 0), 0));
  }
  return docs;
}

/** A document as flat rows (one per line; doc figures on the first line only) — CSV / PDF. */
function flatRows(report, d) {
  const lines = report.singleRow || !d.lines.length ? [null] : d.lines;
  return lines.map((line, i) => {
    const out = {};
    for (const c of report.columns) {
      if (c.level === "doc") out[c.key] = c.firstOnly && i > 0 ? null : d.values[c.key];
      else out[c.key] = line ? line[c.key] : null;
    }
    out.in_totals = d.counted ? "Yes" : "No";
    return out;
  });
}

/* ============================================================
   Labels for what was applied
============================================================ */
function appliedFilters(ctx) {
  const { report, range, scope, filters } = ctx;
  let branch;
  if (scope.filter) branch = scope.branch;
  else if (scope.multi) branch = "All branches";
  else branch = scope.branch || "All";
  const out = [
    { key: "type", label: "Report", value: report.label },
    { key: "range", label: report.dateLabel, value: range.key === "custom" ? range.text : `${range.label} (${range.text})` },
    { key: "branch", label: "Branch", value: branch },
  ];
  if (ctx.supplier) out.push({ key: "supplier_id", label: "Supplier", value: ctx.supplier.name });
  for (const f of report.filters) if (filters[f.key]) out.push({ key: f.key, label: f.label, value: filters[f.key].label });
  if (ctx.search) out.push({ key: "q", label: "Search", value: `“${ctx.search}”` });
  return out;
}

const publicColumns = (report) =>
  report.columns
    .map((c) => ({ key: c.key, label: c.label, short: c.short, tip: c.tip, type: c.type, level: c.level, labels: c.labels, first_only: c.firstOnly }))
    .concat(report.key === "purchase_transfers" ? [{ key: "route", label: "From → To", short: "Route", type: "text", level: "doc" }] : []);

/* ============================================================
   GET /get/report-types
============================================================ */
router.get(
  "/get/report-types",
  authMiddleware,
  allowPermissions(PERM.view),
  reportAccess(PERM.view),
  handle(async (req, res) => {
    const scope = await resolveScope(db, req, {});
    const types = REPORTS.filter((r) => userCan(req, r.perm)).map((r) => ({
      key: r.key,
      label: r.label,
      group: r.group,
      description: r.description,
      date_label: r.dateLabel,
      doc_word: r.docWord,
      single_row: !!r.singleRow,
      supplier: !!r.supplier,
      search_hint: r.searchHint || "Search",
      filters: r.filters.map((f) => ({ key: f.key, label: f.label, options: f.options })),
    }));
    return res.json({
      success: true,
      data: {
        types,
        ranges: RANGES,
        today: istToday(),
        max_range_days: MAX_RANGE_DAYS,
        pdf_max_lines: PDF_MAX_LINES,
        can_export: userCan(req, PERM.export),
        branch: {
          multi: scope.multi,
          is_admin: scope.actor.isAdmin,
          my_branch: scope.actor.isAdmin ? null : scope.branch,
          branches: scope.actor.isAdmin ? scope.branches : scope.branch ? [scope.branch] : [],
        },
      },
    });
  })
);

/* ============================================================
   GET /get/report   (preview)
============================================================ */
router.get(
  "/get/report",
  authMiddleware,
  allowPermissions(PERM.view),
  reportAccess(PERM.view),
  handle(async (req, res) => {
    const ctx = await readRequest(req);
    const adminId = ctx.scope.actor.adminId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));

    const summary = await queryTotals(db, ctx, adminId);
    const pages = Math.max(1, Math.ceil(summary.documents / limit));
    const safePage = Math.min(page, pages);
    const documents = summary.documents ? await queryDocuments(db, ctx, adminId, (safePage - 1) * limit, limit) : [];

    return res.json({
      success: true,
      data: {
        report: {
          key: ctx.report.key,
          label: ctx.report.label,
          doc_word: ctx.report.docWord,
          single_row: !!ctx.report.singleRow,
          date_label: ctx.report.dateLabel,
        },
        applied: appliedFilters(ctx),
        file_name: fileName(ctx, "x").slice(0, -2), // the download's name without .csv/.pdf — the dialog shows it
        range: { key: ctx.range.key, start: ctx.range.start, end: ctx.range.end },
        as_of: ctx.range.asOf,
        columns: publicColumns(ctx.report),
        view: ctx.report.view,
        counts: { documents: summary.documents, lines: summary.lines, excluded_documents: summary.excluded },
        totals: summary.totals,
        documents,
        pagination: { page: safePage, limit, total: summary.documents, pages },
      },
    });
  })
);

/* ============================================================
   GET /get/chart   (same filters as the report, no paging)
============================================================ */
router.get(
  "/get/chart",
  authMiddleware,
  allowPermissions(PERM.view),
  reportAccess(PERM.view),
  handle(async (req, res) => {
    const ctx = await readRequest(req);
    const data = await chartData(db, ctx, ctx.scope.actor.adminId);
    return res.json({ success: true, data });
  })
);

/* ============================================================
   GET /get/suppliers   the supplier picker (only for users who can open a purchase-side report)
============================================================ */
router.get(
  "/get/suppliers",
  authMiddleware,
  allowPermissions(PERM.view),
  reportAccess(PERM.view),
  handle(async (req, res) => {
    if (!REPORTS.some((r) => r.supplier && userCan(req, r.perm))) throw httpError(403, "You don't have access to supplier reports.");
    const scope = await resolveScope(db, req, {});
    const [rows] = await db.query(
      {
        sql: `SELECT id, supplier_name, gst_number, city, status FROM pharmacy_suppliers
               WHERE admin_id = ? ORDER BY status = 'active' DESC, supplier_name ASC`,
        timeout: QUERY_TIMEOUT_MS,
      },
      [scope.actor.adminId]
    );
    return res.json({
      success: true,
      data: rows.map((r) => ({ id: Number(r.id), name: r.supplier_name, gstin: r.gst_number || null, city: r.city || null, active: r.status === "active" })),
    });
  })
);

/* ============================================================
   GET /download/report?format=csv|pdf
   Read inside one consistent snapshot, so a sale made while the file is being written can't
   make the totals and the rows disagree.
============================================================ */
// "Purchase Orders 24-Sep-2026 to 23-Oct-2026 (Kukatpally).pdf"
const dayForFile = (ymd) => `${ymd.slice(8, 10)}-${MONTHS[Number(ymd.slice(5, 7)) - 1]}-${ymd.slice(0, 4)}`;
const fileName = (ctx, ext) => {
let name = `${ctx.report.label} Report ${ctx.range.start} to ${ctx.range.end}`;;
  if (ctx.scope.filter && ctx.scope.branch) name += ` (${ctx.scope.branch})`;
  if (ctx.supplier) name += ` - ${ctx.supplier.name}`;
  // no trailing dot before the extension ("…Wholesale, Ltd..pdf" → "…Wholesale, Ltd.pdf")
  return `${name.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150).replace(/[.\s]+$/, "")}.${ext}`;
};
/** attachment header that keeps the name readable everywhere, and lets a frontend on another domain read it */
function sendFileHeaders(res, ctx, ext, type) {
  const name = fileName(ctx, ext);
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.setHeader("Cache-Control", "no-store");
}

router.get(
  "/download/report",
  authMiddleware,
  allowPermissions.all(PERM.view, PERM.export),
  reportAccess(PERM.view, PERM.export),
  handle(async (req, res) => {
    const format = clean(req.query.format).toLowerCase();
    // charts hidden on screen → none in the PDF either (PDF_CHARTS stays the master switch)
    const pdfCharts = clean(req.query.charts) !== "0";
    const orientation = clean(req.query.orientation).toLowerCase() || "landscape";
    if (!["landscape", "portrait"].includes(orientation)) throw httpError(400, "Choose landscape or portrait.");
    if (!["csv", "pdf"].includes(format)) throw httpError(400, "Choose CSV or PDF.");
    const ctx = await readRequest(req);
    const adminId = ctx.scope.actor.adminId;
    if (activeDownloads >= MAX_PARALLEL_DOWNLOADS) {
      throw httpError(429, "Several reports are being downloaded right now. Please try again in a minute.");
    }

    activeDownloads += 1;
    let conn = null;
    let gone = false; // the browser went away before the file was complete
    const onClose = () => {
      if (res.writableFinished) return;
      gone = true;
      // never hand a half-read connection back to the pool: drop it
      if (conn) conn.destroy();
    };
    res.on("close", onClose);
    try {
      conn = await db.getConnection();
      if (gone) {
        conn.destroy();
        return;
      }
      await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      const summary = await queryTotals(conn, ctx, adminId);
      if (format === "pdf" && summary.lines > PDF_MAX_LINES) {
        throw httpError(
          422,
          `This report has ${summary.lines.toLocaleString("en-IN")} lines — a PDF can hold up to ${PDF_MAX_LINES.toLocaleString("en-IN")}. Download it as CSV, or choose a shorter date range.`
        );
      }
      if (format === "csv") await writeCsv(res, conn, ctx, adminId);
      else await writePdf(res, conn, { ...ctx, pdfCharts, orientation }, adminId, summary, req);
      if (!gone) await conn.query("COMMIT");
    } catch (err) {
      if (gone) return; // nobody to answer; the connection is already destroyed
      if (conn) {
        try {
          await conn.query("ROLLBACK");
        } catch (_) {
          /* released below */
        }
      }
      throw err;
    } finally {
      activeDownloads -= 1;
      res.off("close", onClose);
      if (conn && !gone) conn.release();
    }
  })
);

/** Wait until the browser has taken what was written — or has gone away (then stop). */
function waitDrain(res) {
  return new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error("client gone"));
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      if (res.destroyed && !res.writableFinished) reject(new Error("client gone"));
      else resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

/* ---------------- CSV ---------------- */
// A text cell that starts with = + - @ (or a tab / CR) could run as a formula in Excel → prefix a quote.
const csvCell = (c, v) => {
  if (v === null || v === undefined) return "";
  let s;
  if (c.type === "enum") s = (c.labels && c.labels[v]) || String(v);
  else if (c.type === "money") s = Number(v).toFixed(2);
  else s = String(v);
  if ((c.type === "text" || c.type === "enum") && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function writeCsv(res, conn, ctx, adminId) {
  const cols = ctx.report.columns.filter((c) => c.csv).slice();
  sendFileHeaders(res, ctx, "csv", "text/csv; charset=utf-8");
  res.write("﻿"); // so Excel reads ₹ / names in Indian scripts correctly
  // last column: does this row count in the preview totals? (cancelled / pending … don't)
  cols.push({ key: "in_totals", label: "In totals", type: "text" });
  res.write(`${cols.map((c) => csvCell({ type: "text" }, c.label)).join(",")}\r\n`);
  let chunk = "";
  await eachDocument(conn, ctx, adminId, async (d) => {
    if (res.destroyed) throw new Error("client gone");
    for (const row of flatRows(ctx.report, d)) chunk += `${cols.map((c) => csvCell(c, row[c.key])).join(",")}\r\n`;
    if (chunk.length > 64 * 1024) {
      const ok = res.write(chunk);
      chunk = "";
      if (!ok) await waitDrain(res);
    }
  });
  res.end(chunk);
}

/* Two small charts for the PDF's first page: amount over time (columns) and top 5 (bars). Returns the new y. */
function drawPdfCharts(pdf, ch, { x, y, w, text, INK, MUTED, RULE, BAND, stacked = false }) {
  const ACCENT = "#0f766e"; // the app's primary colour (appColors.js)
  const H = 96;
  const gap = stacked ? 8 : 14;
  // side by side (landscape), or one above the other at full width (portrait)
  const lw = stacked ? w : w * 0.6;
  const rw = stacked ? w : w - lw - gap;
  // the PDF always prints complete amounts (no "2.4 Cr" shortening)
  const full = (v) => `Rs. ${inr(v)}`;
  const word = ch.bucket === "day" ? "day" : ch.bucket === "week" ? "week" : "month";

  // left: amount per day / week / month
  pdf.rect(x, y, lw, H).lineWidth(0.5).strokeColor(RULE).stroke();
  text(`${ch.metric} by ${word}`, x + 6, y + 5, { bold: true, size: 8, width: lw - 12 });
  const max = Math.max(0, ...ch.trend.map((t) => t.value));
  text(max ? `highest ${full(max)}` : "nothing counted", x + 6, y + 5, { size: 7, color: MUTED, width: lw - 12, align: "right" });
  const px = x + 8;
  const pw = lw - 16;
  const py = y + 18;
  const ph = H - 34;
  pdf.moveTo(px, py + ph).lineTo(px + pw, py + ph).lineWidth(0.4).strokeColor(RULE).stroke();
  const n = Math.max(1, ch.trend.length);
  const slot = pw / n;
  const bw = Math.max(1, Math.min(18, slot * 0.7));
  ch.trend.forEach((t, i) => {
    if (!max || !t.value) return;
    const h = Math.max(1, (t.value / max) * ph);
    pdf.rect(px + i * slot + (slot - bw) / 2, py + ph - h, bw, h).fillColor(ACCENT).fill();
  });
  if (ch.trend.length) {
    text(ch.trend[0].label, px, py + ph + 3, { size: 6.5, color: MUTED, width: 60 });
    if (ch.trend.length > 2) text(ch.trend[Math.floor(ch.trend.length / 2)].label, px + pw / 2 - 30, py + ph + 3, { size: 6.5, color: MUTED, width: 60, align: "center" });
    text(ch.trend[ch.trend.length - 1].label, px + pw - 60, py + ph + 3, { size: 6.5, color: MUTED, width: 60, align: "right" });
  }

  // right (or below): top 5
  const rx = stacked ? x : x + lw + gap;
  const ty = stacked ? y + H + gap : y;
  pdf.rect(rx, ty, rw, H).lineWidth(0.5).strokeColor(RULE).stroke();
  text(ch.top.title, rx + 6, ty + 5, { bold: true, size: 8, width: rw - 12 });
  const items = ch.top.items.slice(0, 5);
  const tmax = Math.max(0, ...items.map((t) => t.value));
  const labelW = rw * 0.34;
  const valueW = 92; // room for "Rs. 2,43,85,804.12"
  const barX = rx + 6 + labelW + 4;
  const barW = rw - 12 - labelW - valueW - 8;
  if (!items.length) text("Nothing counted in this range.", rx + 6, ty + 22, { size: 7.5, color: MUTED, width: rw - 12 });
  items.forEach((t, i) => {
    const ry = ty + 20 + i * 14.5;
    text(t.label, rx + 6, ry + 1, { size: 7.5, width: labelW });
    pdf.rect(barX, ry + 1, barW, 8).fillColor(BAND).fill();
    if (tmax) pdf.rect(barX, ry + 1, Math.max(1, (t.value / tmax) * barW), 8).fillColor(ACCENT).fill();
    text(full(t.value), rx + rw - 6 - valueW, ry + 1, { size: 7.5, width: valueW, align: "right", bold: true });
  });
  pdf.fillColor(INK);
  return ty + H + 10;
}

/* ---------------- PDF ---------------- */
// Helvetica covers Latin-1 only: ₹ → Rs., → → ->, anything else outside it → ?
const pdfText = (v) =>
  String(v === null || v === undefined ? "" : v)
    .replace(/₹/g, "Rs.")
    .replace(/→/g, "->")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
const inr = (v) => Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rateStr = (v) => {
  const n = Number(v || 0);
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? inr(n) : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
};
const dmy = (ymd) => (ymd ? `${ymd.slice(8, 10)}-${ymd.slice(5, 7)}-${ymd.slice(0, 4)}` : "");
const fmtPdf = (c, v) => {
  if (v === null || v === undefined || v === "") return "";
  switch (c.type) {
    case "money":
      return inr(v);
    case "rate":
      return rateStr(v);
    case "pct":
      return `${Number(v)}%`;
    case "int":
      return Number(v).toLocaleString("en-IN");
    case "date":
      return dmy(v);
    case "datetime":
      return `${dmy(v.slice(0, 10))} ${v.slice(11, 16)}`;
    case "enum":
      return (c.labels && c.labels[v]) || String(v);
    default:
      return String(v);
  }
};
const isNumType = (t) => ["money", "rate", "pct", "int"].includes(t);

async function writePdf(res, conn, ctx, adminId, summary, req) {
  const { report } = ctx;
  const [[company]] = await conn.query(`SELECT name, company_name, address, mobile FROM admins WHERE id = ? LIMIT 1`, [adminId]);
  const companyName = (company && (company.company_name || company.name)) || "Pharmacy";

  // A4, landscape (default) or portrait. Portrait keeps every column: smaller table text, two-line
  // document strip, 4 total boxes per row, charts stacked.
  const portrait = ctx.orientation === "portrait";
  const PW = portrait ? 595.28 : 841.89;
  const PH = portrait ? 841.89 : 595.28;
  const TS = portrait ? 7 : 7.5; // table text
  const HS = portrait ? 6.5 : 7; // table heading
  const M = 28;
  const W = PW - M * 2;
  const BOTTOM = PH - M - 18;
  const INK = "#111827";
  const MUTED = "#6b7280";
  const RULE = "#d1d5db";
  const BAND = "#f3f4f6";

  // bottom margin kept small so the footer line never makes pdfkit start a blank page
  const pdf = new PDFDocument({ size: "A4", layout: portrait ? "portrait" : "landscape", margins: { top: M, left: M, right: M, bottom: 8 }, bufferPages: true, info: { Title: `${report.label} report`, Author: companyName } });
  sendFileHeaders(res, ctx, "pdf", "application/pdf");
  pdf.pipe(res);

  const text = (s, x, y, o = {}) =>
    pdf.font(o.bold ? "Helvetica-Bold" : "Helvetica").fontSize(o.size || 8).fillColor(o.color || INK)
      // one line, cut with "…" when too long (pdfkit only truncates when it has a height)
      .text(pdfText(s), x, y, { width: o.width, align: o.align || "left", lineBreak: false, ellipsis: o.width ? true : undefined, height: o.width ? (o.size || 8) * 1.3 : undefined });

  /* ---- heading (first page) ---- */
  let y = M;
  text(companyName, M, y, { bold: true, size: 15, width: W * 0.6 });
  text(`${report.label} report`, M + W * 0.5, y, { bold: true, size: 13, width: W * 0.5, align: "right" });
  y += 19;
  if (company && company.address) text(company.address, M, y, { size: 8.5, color: MUTED, width: W * 0.6 });
  const who = clean(req.user && req.user.name) || (ctx.scope.actor.isAdmin ? "Admin" : "Staff");
  const nowIst = new Date(Date.now() + 330 * 60 * 1000).toISOString();
  text(`Generated ${dmy(nowIst.slice(0, 10))} ${nowIst.slice(11, 16)} by ${who}`, M + W * 0.5, y, { size: 8.5, color: MUTED, width: W * 0.5, align: "right" });
  y += 16;
  pdf.moveTo(M, y).lineTo(M + W, y).lineWidth(0.8).strokeColor(INK).stroke();
  y += 8;

  // filters
  const applied = appliedFilters(ctx).filter((a) => a.key !== "type");
  text(applied.map((a) => `${a.label}: ${a.value}`).join("     "), M, y, { size: 8.5, width: W });
  y += 16;

  // totals boxes
  const tiles = [
    ...summary.totals.map((t) => ({ label: t.label, value: t.type === "money" ? `Rs. ${inr(t.value)}` : Number(t.value).toLocaleString("en-IN") })),
  ];
  const perRow = Math.min(tiles.length, portrait ? 4 : 6);
  const tw = W / perRow;
  for (let i = 0; i < tiles.length; i += 1) {
    const cx = M + (i % perRow) * tw;
    if (i > 0 && i % perRow === 0) y += 30;
    pdf.rect(cx + 1, y, tw - 2, 27).fillColor(BAND).fill();
    text(tiles[i].label, cx + 6, y + 4, { size: 7, color: MUTED, width: tw - 12 });
    text(tiles[i].value, cx + 6, y + 13, { bold: true, size: 9.5, width: tw - 12 });
  }
  y += 34;
  if (summary.excluded) {
    text(
      `${summary.excluded} ${summary.excluded === 1 ? report.docWord[0] : report.docWord[1]} with a status that doesn't count (cancelled, rejected, pending and so on) are listed but left out of the quantities and amounts.`,
      M, y, { size: 7.5, color: MUTED, width: W }
    );
    y += 12;
  }

  if (PDF_CHARTS && ctx.pdfCharts !== false && summary.documents && report.chart) {
    const ch = await chartData(conn, ctx, adminId);
    y = drawPdfCharts(pdf, ch, { x: M, y, w: W, text, INK, MUTED, RULE, BAND, stacked: portrait });
  }

  /* ---- the table ---- */
  // a column's width share; portrait may use its own (pdfP), and 0 leaves the column out
  const weight = (c) => (portrait && c.pdfP !== undefined ? c.pdfP : c.pdf);
  const tableCols = report.singleRow
    ? report.columns.filter((c) => weight(c) > 0)
    : [{ key: "__n", label: "#", type: "int", pdf: 0.45 }, ...report.columns.filter((c) => c.level === "line" && weight(c) > 0)];
  const totalWeight = tableCols.reduce((a, c) => a + weight(c), 0);
  const widths = tableCols.map((c) => (weight(c) / totalWeight) * W);
  const ROW_H = 13;

  const drawHeader = () => {
    pdf.rect(M, y, W, 15).fillColor(INK).fill();
    let x = M;
    tableCols.forEach((c, i) => {
      text(c.short || c.label, x + 3, y + 4, { bold: true, size: HS, color: "#ffffff", width: widths[i] - 6, align: isNumType(c.type) ? "right" : "left" });
      x += widths[i];
    });
    y += 15;
  };
  const newPage = () => {
    pdf.addPage();
    y = M;
  };
  const ensure = (h, withHeader, label) => {
    if (y + h > BOTTOM) {
      newPage();
      if (label) {
        text(label, M, y, { size: 7, color: MUTED, width: W });
        y += 11;
      }
      if (withHeader) drawHeader();
      return true;
    }
    return false;
  };
  const drawRow = (vals, opts = {}) => {
    let x = M;
    if (opts.shade) pdf.rect(M, y, W, ROW_H).fillColor("#fafafa").fill();
    tableCols.forEach((c, i) => {
      const v = c.key === "__n" ? vals.__n : fmtPdf(c, vals[c.key]);
      text(v, x + 3, y + 3, { size: TS, width: widths[i] - 6, align: isNumType(c.type) ? "right" : "left", bold: opts.bold });
      x += widths[i];
    });
    y += ROW_H;
    pdf.moveTo(M, y).lineTo(M + W, y).lineWidth(0.3).strokeColor(RULE).stroke();
  };

  const colByKey = new Map(report.columns.map((c) => [c.key, c]));
  const docLine = (d) => {
    const v = d.values;
    const bits = [];
    const add = (key) => {
      const c = colByKey.get(key);
      if (c && v[key] !== null && v[key] !== undefined && v[key] !== "") bits.push(fmtPdf(c, v[key]));
    };
    if (report.key === "purchase_transfers") bits.push(v.route);
    else add("branch");
    const partyKey = report.view.party;
    if (partyKey && partyKey !== "route") add(partyKey);
    (report.view.partySub || []).forEach((k) => {
      const c = colByKey.get(k);
      if (c && v[k]) bits.push(`${c.short}: ${fmtPdf(c, v[k])}`);
    });
    (report.view.chips || []).forEach(add);
    (report.view.meta || []).forEach((k) => {
      const c = colByKey.get(k);
      if (c && v[k] !== null && v[k] !== undefined && v[k] !== "") bits.push(`${c.short}: ${fmtPdf(c, v[k])}`);
    });
    if (!d.counted) bits.push("not in totals");
    return bits.join("  ·  ");
  };

  if (!summary.documents) {
    text("No records match these filters.", M, y + 10, { size: 10, color: MUTED, width: W });
  } else if (report.singleRow) {
    drawHeader();
    let n = 0;
    await eachDocument(conn, ctx, adminId, async (d) => {
      if (res.destroyed) throw new Error("client gone");
      ensure(ROW_H, true);
      n += 1;
      drawRow(d.values, { shade: n % 2 === 0 });
    });
  } else {
    await eachDocument(conn, ctx, adminId, async (d) => {
      if (res.destroyed) throw new Error("client gone");
      // document band + table header + at least one line on the same page
      const bandH = portrait ? 30 : 18;
      ensure(bandH + 2 + 15 + ROW_H, false);
      y += 4;
      pdf.rect(M, y, W, bandH).fillColor(BAND).fill();
      const dateCol = colByKey.get("doc_date");
      const amounts = (report.view.amounts || [])
        .map((k) => colByKey.get(k))
        .filter((c) => c && d.values[c.key] !== null && d.values[c.key] !== undefined)
        .map((c) => `${c.short}: Rs. ${inr(d.values[c.key])}`)
        .join("   ");
      if (portrait) {
        // line 1: number + date | amounts; line 2: branch, party, status … across the full width
        text(`${d.values.doc_no}   ${fmtPdf(dateCol, d.values.doc_date)}`, M + 5, y + 5, { bold: true, size: 8.5, width: W * 0.42 });
        text(amounts, M + W * 0.42, y + 5, { bold: true, size: 8, width: W * 0.58 - 5, align: "right" });
        text(docLine(d), M + 5, y + 18, { size: 7.5, width: W - 10 });
      } else {
        text(`${d.values.doc_no}   ${fmtPdf(dateCol, d.values.doc_date)}`, M + 5, y + 5, { bold: true, size: 8.5, width: W * 0.28 });
        text(docLine(d), M + W * 0.28, y + 5.5, { size: 7.5, width: W * 0.42 });
        text(amounts, M + W * 0.7, y + 5, { bold: true, size: 8, width: W * 0.3 - 5, align: "right" });
      }
      y += bandH;
      drawHeader();
      if (!d.lines.length) {
        text("No lines on this document.", M + 5, y + 3, { size: TS, color: MUTED, width: W });
        y += ROW_H;
      }
      d.lines.forEach((line, i) => {
        ensure(ROW_H, true, `${d.values.doc_no} (continued)`);
        drawRow({ ...line, __n: String(i + 1) }, { shade: i % 2 === 1 });
      });
      y += 4;
    });
  }

  /* ---- closing totals ---- */
  if (summary.documents) {
    ensure(18 + summary.totals.length * 12, false);
    y += 8;
    pdf.moveTo(M, y).lineTo(M + W, y).lineWidth(0.8).strokeColor(INK).stroke();
    y += 6;
    text("Report totals", M, y, { bold: true, size: 9, width: W });
    y += 14;
    summary.totals.forEach((t) => {
      text(t.label, M + W - 260, y, { size: 8, color: MUTED, width: 140 });
      text(t.type === "money" ? `Rs. ${inr(t.value)}` : Number(t.value).toLocaleString("en-IN"), M + W - 120, y, { bold: true, size: 8, width: 120, align: "right" });
      y += 12;
    });
  }

  /* ---- page numbers ---- */
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    pdf.switchToPage(i);
    const fy = PH - M - 8;
    pdf.moveTo(M, fy - 4).lineTo(M + W, fy - 4).lineWidth(0.3).strokeColor(RULE).stroke();
    text(`${companyName} · ${report.label} · ${ctx.range.text}`, M, fy, { size: 7, color: MUTED, width: W * 0.7 });
    text(`Page ${i - range.start + 1} of ${range.count}`, M + W * 0.7, fy, { size: 7, color: MUTED, width: W * 0.3, align: "right" });
  }
  // listen BEFORE ending: a browser that left early has already closed, and must not leave us waiting
  const finished = new Promise((resolve, reject) => {
    if (res.destroyed || res.writableFinished) return resolve();
    res.on("finish", resolve);
    res.on("close", resolve);
    pdf.on("error", reject);
  });
  pdf.end();
  await finished;
}

module.exports = router;
// exposed for tests
module.exports._internals = { REPORTS, resolveRange, buildWhere, countedSql, groupDocuments, flatRows, csvCell, allBuckets, fileName };