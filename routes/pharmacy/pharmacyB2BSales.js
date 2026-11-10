// routes/pharmacy/pharmacyB2BSales.js
//
// B2B (wholesale) sales: sell to ANY other pharmacy, not only to admins on CareDesk.
//
// NO NEW TABLES AND NO NEW COLUMNS. Everything lives in the tables you already have:
//
//   the invoice        pharmacy_sales        sale_number "B2B-2026-0001" marks a B2B invoice
//   its lines          pharmacy_sale_items   one row per batch used; quantity is in TABLETS
//   money received     pharmacy_payments     sale_id = the invoice (a removed payment is reversed
//                                            with a negative row, the way the table is meant to be used)
//   stock              pharmacy_medicine_batches.quantity_available (tablets) + pharmacy_stock_transactions
//
//   Things those tables have no column for - who the buyer is (GSTIN, address, drug licence), the
//   seller's GSTIN / bank details / terms, the pay-by date - are written as a small JSON block in
//   pharmacy_sales.notes. The block always starts with {"b2b":1 so it is easy to spot. The text you
//   type as "notes" on the invoice is inside it too. How each LINE was sold is on the line itself
//   (pharmacy_sale_items.sale_unit / units_per_pack / tablets). Invoices made before that column
//   existed kept it in the notes block ("lines"); they are still read from there, as they were printed.
//
//   INVOICES    GET    /get                         paged list (+ a summary of ALL matches)
//               GET    /get/:id                     one invoice: lines + payments
//               POST   /create                      issue an invoice -> takes the stock out
//               PATCH  /cancel/:id                  cancel it -> puts the stock back
//   PAYMENTS    POST   /payment/:id                 money received
//               DELETE /payment/:id/:paymentId      reverses it (adds a negative row)
//   HELPERS     GET    /defaults                    your business details + the buyers you sold to before
//               GET    /medicine-search             what can be sold, with strips + loose tablets
//   DOCUMENT    GET    /pdf/:id                     the tax invoice (?download=1 to force a download)
//               GET    /send-info/:id               who it goes to + the wording
//               POST   /send-email/:id              email it to the buyer
//               POST   /share-link/:id              a 30-day link for WhatsApp
//               GET    /shared/:token/:filename     the PDF behind that link (no login)
//
// QUANTITY TYPE  (the shared rules: utils/pharmacyUnits.js)
//   Stock is counted in TABLETS. Each batch knows its own tablets per strip (units_per_pack). A line is
//   sold either
//     by the STRIP   quantity x the batch's units_per_pack tablets leave it, whole strips only, or
//     by the TABLET  quantity tablets leave the batch.
//   A medicine with 1 per pack (a bottle, a tube) is sold by the pack only.
//   The batch's selling_price is the price of ONE STRIP (as on the supplier invoice and the MRP), so the
//   strip rate starts as the selling price and a tablet's rate as selling price / units_per_pack (4 dp).
//   A rate above the MRP of the unit sold (strip: mrp, tablet: mrp / units_per_pack) is refused.
//
//   A line is filled from the earliest-expiring batches first (or from the one batch the user
//   picked), in the user's branch; each batch used becomes its own invoice line.
//
// BRANCH: with two or more branches staff sell from their own branch; the admin names one (`branch`).
//
// GST: a tax invoice. Rates are exclusive. The invoice discount is spread over the lines in
// proportion to their value BEFORE tax is worked out. CGST + SGST when buyer and seller are in
// the same state (the first two digits of the GSTIN), IGST when they are not. The total is rounded
// to a whole rupee.
//
// Permissions (the same keys the B2B screens check): pharmacy.b2b_sales.view / .create / .edit.

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const db = require("../../db");
const { buildB2BInvoicePdf } = require("../../utils/buildB2BInvoicePdf");
const { sendB2BInvoiceEmail, defaultSubject, defaultMessage } = require("../../utils/Sendb2binvoiceemail");
const { isValidEmail, parseEmailList } = require("../../utils/sendPurchaseOrderEmail");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
const {
  money, rate4, unitsPerPack, packWord, plural, splitTablets, describeStock, describeSaleQty, readSaleLine, mrpFor,
} = require("../../utils/pharmacyUnits");
const { recordMove, allocate } = require("../../utils/pharmacyStock");
const { resolveScope, BranchError } = require("../../utils/pharmacyBranch");

const PERM = {
  view: "pharmacy.b2b_sales.view",
  create: "pharmacy.b2b_sales.create",
  edit: "pharmacy.b2b_sales.edit",
};

/* ============================================================
   Small helpers
============================================================ */
const getTenantAdminId = (req) => (req.user.role === "admin" ? req.user.id : req.user.adminId);
const getUserId = (req) => req.user.id;

const toInt = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? d : n;
};
const pad = (n, w = 4) => String(n).padStart(w, "0");
const clean = (v) => {
  const s = v === undefined || v === null ? "" : String(v).trim();
  return s === "" ? null : s;
};
const cut = (v, n) => {
  const s = clean(v);
  return s === null ? null : s.slice(0, n);
};

const dayString = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00`).getTime());
const nowStamp = () => {
  const d = new Date();
  return `${dayString(d)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
};
const asDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) return dayString(v);
  return String(v).slice(0, 10);
};

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
// the pharmacy_payments.payment_method enum
const PAY_METHODS = ["cash", "card", "upi", "bank_transfer", "other"];
// pharmacy_sales.payment_method has no "other": anything outside its enum is stored as "mixed"
const SALE_PAY_METHODS = ["cash", "card", "upi", "bank_transfer", "credit", "mixed"];
const saleMethod = (m) => (SALE_PAY_METHODS.includes(m) ? m : "mixed");
const QTY_TYPES = ["strip", "tablet"];
const PREFIX = "B2B";
const IS_B2B = `s.sale_number LIKE '${PREFIX}-%'`;

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const fail = (res, err, fallback) => {
  if (err instanceof HttpError || err instanceof BranchError || (err && err.status >= 400 && err.status < 500)) {
    return res.status(err.status).json({ success: false, message: err.message, ...(err.extra || {}) });
  }
  console.error(fallback, err);
  return res.status(500).json({ success: false, message: fallback });
};

/* ============================================================
   Branch: which invoices this user sees
============================================================ */
// Staff of a multi-branch pharmacy see their branch's invoices (and the old ones made before
// invoices had a branch). The admin sees all, or the branch they picked.
const branchWhere = (scope, alias = "s") =>
  scope && scope.filter
    ? { sql: ` AND (${alias}.branch IS NULL OR TRIM(${alias}.branch) = '' OR LOWER(TRIM(${alias}.branch)) = ?)`, params: [scope.key] }
    : { sql: "", params: [] };

const readScope = (q, req, wanted) => resolveScope(q, req, { wanted, forWrite: false });

/** the word for the unit of a rate / quantity: "strip", "tablet", "bottle" */
const unitWord = (saleUnit, word) => (saleUnit === "tablet" ? "tablet" : saleUnit === "pack" && word === "strip" ? "pack" : word);

const SELLABLE_BATCH = `b.admin_id = ? AND b.status = 'active' AND b.expiry_date >= ? AND b.quantity_available > 0`;

/* ============================================================
   The arithmetic of an invoice - pure, so it can be tested alone
============================================================ */
/**
 * rows: [{ quantity, unit_price, gst_percentage }]  (one per batch line)
 * Returns the rows with their amounts, and the totals.
 */
function priceInvoice(rows, { discount = 0, otherCharges = 0, isIgst = false } = {}) {
  const priced = rows.map((r) => ({ ...r, gross: money((Number(r.quantity) || 0) * (Number(r.unit_price) || 0)) }));
  const subtotal = money(priced.reduce((t, r) => t + r.gross, 0));
  const disc = Math.min(money(discount), subtotal);

  // spread the discount over the lines by value; the last line takes the rounding left over
  let left = disc;
  priced.forEach((r, i) => {
    const share = i === priced.length - 1 ? left : subtotal > 0 ? money((disc * r.gross) / subtotal) : 0;
    r.discount_amount = Math.min(share, r.gross);
    left = money(left - r.discount_amount);
    r.taxable_amount = money(r.gross - r.discount_amount);
    r.tax_amount = money((r.taxable_amount * (Number(r.gst_percentage) || 0)) / 100);
    r.total_amount = money(r.taxable_amount + r.tax_amount);
  });

  const taxable = money(priced.reduce((t, r) => t + r.taxable_amount, 0));
  const tax = money(priced.reduce((t, r) => t + r.tax_amount, 0));
  const other = money(otherCharges);
  const exact = money(taxable + tax + other);
  const grand = Math.round(exact);
  const cgst = isIgst ? 0 : money(tax / 2);
  return {
    rows: priced,
    subtotal,
    discount_amount: disc,
    taxable_amount: taxable,
    cgst_amount: cgst,
    sgst_amount: isIgst ? 0 : money(tax - cgst),
    igst_amount: isIgst ? tax : 0,
    tax_amount: tax,
    other_charges: other,
    round_off: money(grand - exact),
    grand_total: grand,
  };
}

const paymentFields = (grand, paid) => {
  const g = money(grand);
  const p = money(paid);
  const due = Math.max(0, money(g - p));
  return { due_amount: due, payment_status: p <= 0 ? "unpaid" : p >= g ? "paid" : "partial" };
};

const stateCode = (gstin) => {
  const m = /^(\d{2})/.exec(String(gstin || "").trim());
  return m ? m[1] : null;
};

/** Different state codes on both GSTINs -> IGST. Anything missing -> CGST + SGST. */
const isInterState = (sellerGstin, buyerGstin) => {
  const a = stateCode(sellerGstin);
  const b = stateCode(buyerGstin);
  return !!a && !!b && a !== b;
};

/* ============================================================
   The JSON block in pharmacy_sales.notes
============================================================ */
function readMeta(text) {
  const s = String(text || "");
  if (!s.startsWith('{"b2b"')) return { b2b: 0, buyer: {}, seller: {}, lines: [] };
  try {
    const m = JSON.parse(s);
    return { ...m, buyer: m.buyer || {}, seller: m.seller || {}, lines: Array.isArray(m.lines) ? m.lines : [] };
  } catch (_) {
    return { b2b: 0, buyer: {}, seller: {}, lines: [] };
  }
}

/* ============================================================
   Seller details: the account's own, plus what was typed on the last invoice
============================================================ */
async function loadSeller(conn, adminId, last) {
  const [adminRows] = await conn.query(
    `SELECT name, company_name, address, mobile, email FROM admins WHERE id = ? LIMIT 1`,
    [adminId]
  );
  const a = adminRows[0] || {};
  const l = last || {};
  return {
    business_name: a.company_name || a.name || "",
    address: a.address || "",
    phone: a.mobile || "",
    email: a.email || "",
    gstin: l.gstin || "",
    drug_license_number: l.drug_license_number || "",
    bank_details: l.bank_details || "",
    terms: l.terms || "",
  };
}

/** The seller block as it was on the invoice (account details are read fresh). */
async function sellerFor(conn, adminId, meta) {
  return loadSeller(conn, adminId, meta.seller);
}

/* ============================================================
   Reading an invoice back out of the three tables
============================================================ */
function shapeInvoice(sale, itemRows, payRows) {
  const meta = readMeta(sale.notes);
  const b = meta.buyer || {};
  const grand = money(sale.grand_total);
  const subtotal = money(sale.subtotal);
  const disc = money(sale.discount_amount);
  const tax = money(sale.tax_amount);
  const taxable = money(subtotal - disc);
  const other = money(meta.other);
  const igst = !!meta.igst;
  const cgst = igst ? 0 : money(tax / 2);

  const items = itemRows.map((it, i) => {
    // an invoice made before lines had their own unit columns: the line exactly as it was printed
    const L = !it.sale_unit && meta.lines[i] ? meta.lines[i] : null;
    const read = readSaleLine(it, sale, { units_per_pack: it.batch_upp, pack_size: it.pack_size });
    const upp = L && Number(L.u) ? Number(L.u) : read.units_per_pack;
    const word = L && L.w ? String(L.w).toLowerCase() : packWord({ unit: it.unit, pack_size: it.pack_size }, upp);
    const qtyType = L ? (L.t === "tablet" ? "tablet" : upp > 1 ? "strip" : "pack") : read.sale_unit;
    const quantity = L && L.q !== undefined ? Number(L.q) : Number(it.quantity);
    const unitPrice = L && L.r !== undefined ? Number(L.r) : Number(it.unit_price) || 0;
    const total = money(it.total_amount);
    const taxAmt = money(it.tax_amount);
    const stripMrp = L && L.m !== undefined ? money(L.m) : money(it.mrp);
    return {
      id: it.id,
      medicine_id: it.medicine_id,
      batch_id: it.batch_id,
      medicine_name: (L && L.n) || it.brand_name || it.medicine_name || `Medicine #${it.medicine_id}`,
      strength: (L ? L.s : it.strength) || null,
      dosage_form: (L ? L.f : it.dosage_form) || null,
      hsn_code: (L ? L.h : it.hsn_code) || null,
      batch_number: (L ? L.b : it.batch_number) || null,
      expiry_date: (L ? L.e : asDay(it.expiry_date)) || null,
      mrp: stripMrp, // per strip / pack, as printed on it
      qty_type: qtyType, // strip | tablet | pack
      sale_unit: qtyType,
      pack_unit: word,
      rate_unit: unitWord(qtyType, word),
      quantity,
      qty_text: describeSaleQty(qtyType, quantity, word),
      units_per_pack: upp,
      tablets_total: read.tablets,
      unit_price: rate4(unitPrice),
      discount_amount: money(it.discount_amount),
      taxable_amount: money(total - taxAmt),
      gst_percentage: Number(it.gst_percentage) || 0,
      tax_amount: taxAmt,
      total_amount: total,
      legacy: !!L,
    };
  });

  // a reversal is a negative row that names the payment it undoes in transaction_reference
  const reversed = new Set(payRows.filter((p) => Number(p.amount) < 0 && p.transaction_reference).map((p) => p.transaction_reference));
  const payments = payRows.map((p) => ({
    id: p.id,
    payment_number: p.payment_number,
    payment_date: p.payment_date,
    payment_day: asDay(p.payment_date),
    amount: money(p.amount),
    payment_method: p.payment_method,
    transaction_reference: Number(p.amount) < 0 ? null : p.transaction_reference,
    notes: p.notes,
    is_reversal: Number(p.amount) < 0,
    reversed: reversed.has(p.payment_number),
  }));

  return {
    id: sale.id,
    invoice_number: sale.sale_number,
    branch: sale.branch || null,
    invoice_date: asDay(sale.sale_date),
    due_date: meta.due || null,
    buyer_id: null,
    buyer_name: sale.customer_name || b.name || "",
    buyer_phone: sale.customer_phone || b.phone || null,
    buyer_email: b.email || null,
    buyer_address: b.address || null,
    buyer_state: b.state || null,
    buyer_gstin: b.gstin || null,
    buyer_drug_license: b.dl || null,
    is_igst: igst ? 1 : 0,
    subtotal,
    discount_amount: disc,
    taxable_amount: taxable,
    cgst_amount: cgst,
    sgst_amount: igst ? 0 : money(tax - cgst),
    igst_amount: igst ? tax : 0,
    tax_amount: tax,
    other_charges: other,
    round_off: money(grand - money(taxable + tax + other)),
    grand_total: grand,
    paid_amount: money(sale.paid_amount),
    due_amount: money(sale.due_amount),
    payment_status: sale.payment_status,
    status: sale.status === "cancelled" ? "cancelled" : "completed",
    notes: meta.note || null,
    cancel_reason: (meta.cancel && meta.cancel.reason) || null,
    cancelled_at: (meta.cancel && meta.cancel.at) || null,
    created_at: sale.created_at,
    created_by: sale.sold_by,
    items_count: items.length,
    items,
    payments,
  };
}

async function fetchInvoice(conn, id, adminId, scope = null) {
  const bw = branchWhere(scope);
  const [rows] = await conn.query(
    `SELECT s.* FROM pharmacy_sales s WHERE s.id = ? AND s.admin_id = ? AND ${IS_B2B}${bw.sql} LIMIT 1`,
    [id, adminId, ...bw.params]
  );
  if (!rows.length) return null;
  const [items] = await conn.query(
    `SELECT i.*,
            b.batch_number, b.expiry_date, b.mrp, b.units_per_pack AS batch_upp,
            m.unit, m.pack_size, m.hsn_code,
            md.medicine_name, md.brand_name, md.strength, md.dosage_form
       FROM pharmacy_sale_items i
       LEFT JOIN pharmacy_medicine_batches b ON b.id = i.batch_id
       LEFT JOIN pharmacy_medicines m ON m.id = i.medicine_id
       LEFT JOIN medicine_data md ON md.id = m.medicine_data_id
      WHERE i.sale_id = ?
      ORDER BY i.id ASC`,
    [id]
  );
  const [payments] = await conn.query(
    `SELECT id, payment_number, payment_date, amount, payment_method, transaction_reference, notes
       FROM pharmacy_payments
      WHERE sale_id = ? AND admin_id = ?
      ORDER BY payment_date ASC, id ASC`,
    [id, adminId]
  );
  return shapeInvoice(rows[0], items, payments);
}

/* ============================================================
   DEFAULTS - your business details + the buyers you sold to before
============================================================ */
router.get("/defaults", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const adminId = getTenantAdminId(req);
    const [rows] = await db.query(
      `SELECT s.customer_name, s.customer_phone, s.notes, s.status, s.due_amount
         FROM pharmacy_sales s
        WHERE s.admin_id = ? AND ${IS_B2B}
        ORDER BY s.id DESC
        LIMIT 300`,
      [adminId]
    );
    let last = null;
    const seen = new Map();
    for (const r of rows) {
      const m = readMeta(r.notes);
      if (!last && m.seller && Object.keys(m.seller).length) last = m.seller;
      const b = m.buyer || {};
      const name = r.customer_name || b.name;
      if (!name) continue;
      const key = (b.gstin || r.customer_phone || b.phone || String(name).toLowerCase()).toString().toLowerCase();
      let e = seen.get(key);
      if (!e) {
        e = {
          buyer_name: name,
          phone: r.customer_phone || b.phone || null,
          email: b.email || null,
          address: b.address || null,
          state: b.state || null,
          gst_number: b.gstin || null,
          drug_license_number: b.dl || null,
          invoice_count: 0,
          outstanding: 0,
        };
        seen.set(key, e);
      }
      if (r.status !== "cancelled") {
        e.invoice_count += 1;
        e.outstanding = money(e.outstanding + Number(r.due_amount || 0));
      }
    }
    return res.json({
      success: true,
      data: { seller: await loadSeller(db, adminId, last), buyers: [...seen.values()].slice(0, 100) },
    });
  } catch (err) {
    return fail(res, err, "Failed to load your details");
  }
});

/* ============================================================
   MEDICINE SEARCH - what can be sold, and how much of it
============================================================ */
router.get("/medicine-search", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const adminId = getTenantAdminId(req);
    // selling takes stock out → the admin of a multi-branch pharmacy must say which branch
    const scope = await resolveScope(db, req, { wanted: req.query.branch, forWrite: true });
    const bw = scope.filter ? { sql: ` AND b.branch IS NOT NULL AND LOWER(TRIM(b.branch)) = ?`, params: [scope.key] } : { sql: "", params: [] };
    const today = dayString();
    const limit = Math.min(50, Math.max(1, toInt(req.query.limit, 20)));
    const q = clean(req.query.q);
    const where = [
      `m.admin_id = ?`,
      `m.status = 'active'`,
      `EXISTS (SELECT 1 FROM pharmacy_medicine_batches b WHERE b.medicine_id = m.id AND ${SELLABLE_BATCH}${bw.sql})`,
    ];
    const params = [adminId, adminId, today, ...bw.params];
    if (q) {
      where.push(
        `(md.medicine_name LIKE ? OR md.brand_name LIKE ? OR md.generic_name LIKE ? OR m.medicine_code LIKE ? OR m.barcode LIKE ?)`
      );
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [meds] = await db.query(
      `SELECT m.id AS medicine_id, m.medicine_code, m.hsn_code, m.gst_percentage, m.unit, m.pack_size, m.units_per_pack,
              m.selling_price, md.medicine_name, md.brand_name, md.generic_name, md.dosage_form, md.strength
         FROM pharmacy_medicines m
         LEFT JOIN medicine_data md ON md.id = m.medicine_data_id
        WHERE ${where.join(" AND ")}
        ORDER BY COALESCE(md.brand_name, md.medicine_name) ASC
        LIMIT ?`,
      [...params, limit]
    );
    if (!meds.length) return res.json({ success: true, data: [], branch: scope.branch });

    const ids = meds.map((m) => m.medicine_id);
    const [batches] = await db.query(
      `SELECT b.id, b.medicine_id, b.batch_number, b.expiry_date, b.mrp, b.selling_price, b.quantity_available,
              b.units_per_pack, b.storage_location
         FROM pharmacy_medicine_batches b
        WHERE ${SELLABLE_BATCH}${bw.sql} AND b.medicine_id IN (${ids.map(() => "?").join(",")})
        ORDER BY b.expiry_date ASC, b.id ASC`,
      [adminId, today, ...bw.params, ...ids]
    );

    // the price of ONE STRIP in a batch: its selling price, else its MRP, else the medicine's price
    const stripPrice = (b, m) =>
      Number(b.selling_price) > 0 ? Number(b.selling_price) : Number(b.mrp) > 0 ? Number(b.mrp) : Number(m.selling_price) || 0;

    const data = meds.map((m) => {
      const mine = batches.filter((b) => Number(b.medicine_id) === Number(m.medicine_id));
      const first = mine[0] || {};
      const upp = unitsPerPack(first.units_per_pack ? first : m);
      const word = packWord(m, upp);
      const total = mine.reduce((t, b) => t + (Number(b.quantity_available) || 0), 0);
      // strips are sold whole from one batch, so count them batch by batch
      const wholeStrips = mine.reduce((t, b) => t + splitTablets(b.quantity_available, unitsPerPack(b)).strips, 0);
      const strip = stripPrice(first, m);
      const label = [m.brand_name || m.medicine_name, m.strength].filter(Boolean).join(" ");
      return {
        medicine_id: m.medicine_id,
        name: label || m.medicine_name || `Medicine #${m.medicine_id}`,
        medicine_name: m.medicine_name,
        brand_name: m.brand_name,
        generic_name: m.generic_name,
        strength: m.strength,
        dosage_form: m.dosage_form,
        medicine_code: m.medicine_code,
        hsn_code: m.hsn_code,
        gst_percentage: Number(m.gst_percentage) || 0,
        unit: word,
        pack_size: m.pack_size,
        units_per_pack: upp,
        can_sell_loose: upp > 1,
        mrp: money(first.mrp),
        mrp_tablet: upp > 1 && Number(first.mrp) > 0 ? mrpFor("tablet", first.mrp, upp) : null,
        strip_rate: rate4(strip),
        tablet_rate: upp > 1 ? rate4(strip / upp) : null,
        stock_tablets: total,
        stock_strips: wholeStrips,
        stock_loose: Math.max(0, total - mine.reduce((t, b) => t + splitTablets(b.quantity_available, unitsPerPack(b)).strips * unitsPerPack(b), 0)),
        stock_text: describeStock(total, upp, word),
        batches: mine.map((b) => {
          const t = Number(b.quantity_available) || 0;
          const bu = unitsPerPack(b);
          const sp = stripPrice(b, m);
          const parts = splitTablets(t, bu);
          return {
            id: b.id,
            batch_number: b.batch_number,
            expiry_date: asDay(b.expiry_date),
            units_per_pack: bu,
            storage_location: b.storage_location || null,
            mrp: money(b.mrp),
            selling_price: money(b.selling_price),
            strip_rate: rate4(sp),
            tablet_rate: bu > 1 ? rate4(sp / bu) : null,
            strips: parts.strips,
            loose: parts.loose,
            tablets: t,
            stock_text: describeStock(t, bu, packWord(m, bu)),
          };
        }),
      };
    });
    return res.json({ success: true, data, branch: scope.branch });
  } catch (err) {
    return fail(res, err, "Failed to search medicines");
  }
});

/* ============================================================
   INVOICE LIST  (paged; the summary covers every match, not just the page)
============================================================ */
router.get("/get", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const adminId = getTenantAdminId(req);
    const q = req.query;
    const scope = await readScope(db, req, q.branch);
    const page = Math.max(1, toInt(q.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(q.limit, 20)));

    const bw = branchWhere(scope);
    const where = [`s.admin_id = ?`, IS_B2B + bw.sql];
    const params = [adminId, ...bw.params];
    if (clean(q.search)) {
      const like = `%${String(q.search).trim()}%`;
      // the buyer's GSTIN is inside the notes block
      where.push(`(s.sale_number LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ? OR s.notes LIKE ?)`);
      params.push(like, like, like, like);
    }
    if (clean(q.status)) {
      if (!["completed", "cancelled"].includes(q.status)) throw new HttpError(400, "Unknown status");
      where.push(q.status === "cancelled" ? `s.status = 'cancelled'` : `s.status <> 'cancelled'`);
    }
    if (clean(q.payment_status)) {
      if (!["unpaid", "partial", "paid"].includes(q.payment_status)) throw new HttpError(400, "Unknown payment status");
      where.push(`s.payment_status = ?`);
      params.push(q.payment_status);
    }
    if (clean(q.date_from)) {
      if (!isDay(q.date_from)) throw new HttpError(400, "date_from must be YYYY-MM-DD");
      where.push(`DATE(s.sale_date) >= ?`);
      params.push(q.date_from);
    }
    if (clean(q.date_to)) {
      if (!isDay(q.date_to)) throw new HttpError(400, "date_to must be YYYY-MM-DD");
      where.push(`DATE(s.sale_date) <= ?`);
      params.push(q.date_to);
    }
    const W = where.join(" AND ");

    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM pharmacy_sales s WHERE ${W}`, params);
    const [[sum]] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.grand_total ELSE 0 END), 0) AS value,
              COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.paid_amount ELSE 0 END), 0) AS paid,
              COALESCE(SUM(CASE WHEN s.status <> 'cancelled' THEN s.due_amount ELSE 0 END), 0) AS due,
              COALESCE(SUM(CASE WHEN s.status <> 'cancelled' AND s.payment_status <> 'paid' THEN 1 ELSE 0 END), 0) AS open
         FROM pharmacy_sales s WHERE ${W}`,
      params
    );
    const [rows] = await db.query(
      `SELECT s.*, (SELECT COUNT(*) FROM pharmacy_sale_items i WHERE i.sale_id = s.id) AS items_count
         FROM pharmacy_sales s
        WHERE ${W}
        ORDER BY s.sale_date DESC, s.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    const data = rows.map((s) => {
      const meta = readMeta(s.notes);
      return {
        id: s.id,
        invoice_number: s.sale_number,
        branch: s.branch || null,
        invoice_date: asDay(s.sale_date),
        due_date: meta.due || null,
        buyer_id: null,
        buyer_name: s.customer_name || (meta.buyer && meta.buyer.name) || "",
        buyer_phone: s.customer_phone || (meta.buyer && meta.buyer.phone) || null,
        buyer_gstin: (meta.buyer && meta.buyer.gstin) || null,
        subtotal: money(s.subtotal),
        discount_amount: money(s.discount_amount),
        tax_amount: money(s.tax_amount),
        grand_total: money(s.grand_total),
        paid_amount: money(s.paid_amount),
        due_amount: money(s.due_amount),
        payment_status: s.payment_status,
        status: s.status === "cancelled" ? "cancelled" : "completed",
        created_at: s.created_at,
        items_count: Number(s.items_count),
      };
    });
    return res.json({
      success: true,
      data,
      pagination: { page, limit, total: Number(total), total_pages: Math.max(1, Math.ceil(Number(total) / limit)) },
      summary: {
        count: Number(total),
        value: money(sum.value),
        paid: money(sum.paid),
        due: money(sum.due),
        open: Number(sum.open),
      },
    });
  } catch (err) {
    return fail(res, err, "Failed to load invoices");
  }
});

router.get("/get/:id", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const adminId = getTenantAdminId(req);
    const scope = await readScope(db, req, req.query.branch);
    const inv = await fetchInvoice(db, req.params.id, adminId, scope);
    if (!inv) throw new HttpError(404, "Invoice not found");
    return res.json({ success: true, data: inv });
  } catch (err) {
    return fail(res, err, "Failed to load the invoice");
  }
});

/* ============================================================
   CREATE - issue an invoice and take the stock out
============================================================ */
function readBuyer(raw) {
  const b = raw || {};
  const name = clean(b.buyer_name);
  if (!name) throw new HttpError(400, "Enter the buyer's name");
  const phoneRaw = clean(b.phone);
  const phone = phoneRaw ? phoneRaw.replace(/[\s\-()]/g, "") : null;
  if (phone && !/^\+?\d{7,15}$/.test(phone)) throw new HttpError(400, "That phone number doesn't look right");
  const email = clean(b.email);
  if (email && !isValidEmail(email)) throw new HttpError(400, "That isn't a valid email address");
  const gst = clean(b.gst_number) ? String(b.gst_number).trim().toUpperCase() : null;
  if (gst && !GSTIN_RE.test(gst)) throw new HttpError(400, "The buyer's GSTIN must be 15 characters, like 36ABCDE1234F1Z5");
  return {
    name: name.slice(0, 150),
    phone: phone ? phone.slice(0, 15) : null,
    email: email ? email.toLowerCase().slice(0, 150) : null,
    address: cut(b.address, 300),
    state: cut(b.state, 60),
    gstin: gst,
    dl: cut(b.drug_license_number, 60),
  };
}

function readSeller(raw) {
  const s = raw || {};
  const gst = clean(s.gstin) ? String(s.gstin).trim().toUpperCase() : null;
  if (gst && !GSTIN_RE.test(gst)) throw new HttpError(400, "Your GSTIN must be 15 characters, like 36ABCDE1234F1Z5");
  return {
    gstin: gst || undefined,
    drug_license_number: cut(s.drug_license_number, 60) || undefined,
    bank_details: cut(s.bank_details, 400) || undefined,
    terms: cut(s.terms, 600) || undefined,
  };
}

function readInvoiceBody(body) {
  const b = body || {};
  const buyer = readBuyer(b.buyer);
  const seller = readSeller(b.seller);

  const invoiceDate = b.invoice_date ? String(b.invoice_date).slice(0, 10) : dayString();
  if (!isDay(invoiceDate)) throw new HttpError(400, "The invoice date isn't valid");
  const dueDate = b.due_date ? String(b.due_date).slice(0, 10) : null;
  if (dueDate && !isDay(dueDate)) throw new HttpError(400, "The due date isn't valid");
  if (dueDate && dueDate < invoiceDate) throw new HttpError(400, "The due date can't be before the invoice date");

  const discount = Number(b.discount_amount || 0);
  const other = Number(b.other_charges || 0);
  if (!Number.isFinite(discount) || discount < 0) throw new HttpError(400, "Discount can't be negative");
  if (!Number.isFinite(other) || other < 0) throw new HttpError(400, "Other charges can't be negative");

  if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, "Add at least one medicine");
  if (b.items.length > 100) throw new HttpError(400, "An invoice can have up to 100 lines");

  const items = b.items.map((it, i) => {
    const at = `Line ${i + 1}`;
    const medicineId = toInt(it.medicine_id, 0);
    if (!medicineId) throw new HttpError(400, `${at}: choose a medicine`);
    const qtyType = String(it.qty_type || "strip").toLowerCase();
    if (!QTY_TYPES.includes(qtyType)) throw new HttpError(400, `${at}: quantity type must be strip or tablet`);
    const qty = Number(it.quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw new HttpError(400, `${at}: quantity must be a whole number above 0`);
    // no rate → the batch's own (strip: selling price, tablet: selling price / tablets per strip)
    const noPrice = it.unit_price === undefined || it.unit_price === null || it.unit_price === "";
    const price = noPrice ? null : Number(it.unit_price);
    if (!noPrice && (!Number.isFinite(price) || price < 0)) throw new HttpError(400, `${at}: rate can't be negative`);
    const gst = it.gst_percentage === undefined || it.gst_percentage === "" || it.gst_percentage === null ? null : Number(it.gst_percentage);
    if (gst !== null && (!Number.isFinite(gst) || gst < 0 || gst > 100)) throw new HttpError(400, `${at}: GST must be between 0 and 100`);
    return { medicine_id: medicineId, qty_type: qtyType, quantity: qty, unit_price: price === null ? null : rate4(price), gst, batch_id: toInt(it.batch_id, 0) || null };
  });

  let payment = null;
  if (b.payment && Number(b.payment.amount) > 0) {
    const method = String(b.payment.payment_method || "cash").toLowerCase();
    if (!PAY_METHODS.includes(method)) throw new HttpError(400, "Unknown payment method");
    payment = {
      amount: money(b.payment.amount),
      payment_method: method,
      transaction_reference: cut(b.payment.transaction_reference, 255),
    };
  }
  return { buyer, seller, invoiceDate, dueDate, discount, other, items, payment, note: cut(b.notes, 500) };
}

/**
 * Take `line` out of the batches (earliest expiry first, in this branch) through the shared
 * allocate() + recordMove(): the batch and the ledger change together. One row per batch used.
 */
async function takeStock(conn, { adminId, userId, med, line, scope, invoiceId, invoiceNumber }) {
  if (line.qty_type === "tablet") {
    // loose tablets only come out of batches packed in strips; a bottle / tube is sold whole
    const [[x]] = await conn.query(
      `SELECT MAX(units_per_pack) AS u FROM pharmacy_medicine_batches
        WHERE admin_id = ? AND medicine_id = ? AND status = 'active' AND quantity_available > 0`,
      [adminId, med.id]
    );
    if (!(Number(x && x.u) > 1)) {
      throw new HttpError(400, `${med.label} is sold by the ${packWord(med, 1)} only - it has no single tablets`);
    }
  }
  let picks;
  try {
    picks = await allocate(conn, { adminId, medicine: med, saleUnit: line.qty_type, qty: line.quantity, batchId: line.batch_id, scope });
  } catch (e) {
    if (e.status === 409) {
      const word = line.qty_type === "tablet" ? "tablets" : plural(packWord(med, 2), 2);
      const n = e.extra ? e.extra.available : 0;
      throw new HttpError(
        409,
        `Not enough ${med.label}${line.batch_id ? " in that batch" : ""} - only ${n} ${n === 1 ? word.replace(/e?s$/, "") : word} available${scope && scope.filter ? ` in ${scope.branch}` : ""}`,
        { medicine_id: med.id, available: n, sale_unit: line.qty_type }
      );
    }
    throw e;
  }

  const rows = [];
  for (const p of picks) {
    const word = packWord(med, p.units_per_pack);
    if (line.qty_type === "tablet" && p.sale_unit !== "tablet") {
      throw new HttpError(400, `${med.label} is sold by the ${word} only - it has no single tablets`);
    }
    const rate = line.unit_price === null ? p.unit_price : rate4(line.unit_price);
    if (p.max_price !== null && rate > p.max_price + 0.00001) {
      throw new HttpError(
        400,
        `${med.label}: the rate ₹${rate} per ${unitWord(p.sale_unit, word)} is above the MRP (₹${p.max_price} per ${unitWord(p.sale_unit, word)}) of batch ${p.batch.batch_number}`,
        { medicine_id: med.id, batch_id: p.batch.id, max_price: p.max_price }
      );
    }
    await recordMove(conn, {
      adminId,
      userId,
      batchId: p.batch.id,
      tabletsOut: p.tablets,
      type: "sale",
      referenceId: invoiceId,
      referenceNumber: invoiceNumber,
      notes: `B2B invoice ${invoiceNumber} - ${describeSaleQty(p.sale_unit, p.qty, word)}`,
    });
    rows.push({
      medicine_id: med.id,
      batch_id: p.batch.id,
      sale_unit: p.sale_unit,
      quantity: p.qty,
      units_per_pack: p.units_per_pack,
      tablets: p.tablets,
      unit_price: rate,
      gst_percentage: line.gst === null ? Number(med.gst_percentage) || 0 : line.gst,
    });
  }
  return rows;
}

async function nextPaymentNumber(conn, adminId) {
  const d = new Date();
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
  const [[row]] = await conn.query(
    `SELECT COUNT(*) + 1 AS seq FROM pharmacy_payments WHERE admin_id = ? AND payment_number LIKE ?`,
    [adminId, `PAY-${ymd}-%`]
  );
  return `PAY-${ymd}-${pad(row.seq, 5)}`;
}

router.post("/create", authMiddleware, allowPermissions(PERM.create), async (req, res) => {
  const adminId = getTenantAdminId(req);
  const userId = getUserId(req);
  let conn;
  try {
    const body = readInvoiceBody(req.body);
    // the branch the stock leaves from (staff: their own; admin of several branches: must pick).
    // Read BEFORE the transaction: its first statement must be the lock below, or a plain read would
    // fix the transaction's snapshot before the lock and the next number could be read stale.
    const scope = await resolveScope(db, req, { wanted: req.body && req.body.branch, forWrite: true });
    conn = await db.getConnection();
    await conn.beginTransaction();

    // one invoice-number maker at a time per pharmacy (sale_number has no unique key)
    await conn.query(`SELECT id FROM admins WHERE id = ? FOR UPDATE`, [adminId]);

    const isIgst = isInterState(body.seller.gstin, body.buyer.gstin);

    // the medicines on the invoice
    const ids = [...new Set(body.items.map((i) => i.medicine_id))];
    const [medRows] = await conn.query(
      `SELECT m.id, m.medicine_code, m.hsn_code, m.gst_percentage, m.unit, m.pack_size, m.units_per_pack, m.selling_price,
              md.medicine_name, md.brand_name, md.dosage_form, md.strength
         FROM pharmacy_medicines m
         LEFT JOIN medicine_data md ON md.id = m.medicine_data_id
        WHERE m.admin_id = ? AND m.status = 'active' AND m.id IN (${ids.map(() => "?").join(",")})`,
      [adminId, ...ids]
    );
    const meds = new Map(
      medRows.map((m) => {
        const label = [m.brand_name || m.medicine_name, m.strength].filter(Boolean).join(" ") || `Medicine #${m.id}`;
        return [Number(m.id), { ...m, label, name: m.brand_name || m.medicine_name || label }];
      })
    );
    for (const it of body.items) {
      if (!meds.has(it.medicine_id)) throw new HttpError(400, "One of the medicines is no longer available");
    }

    // the invoice number: B2B-YEAR-0001, next after the ones already issued this year
    const year = new Date().getFullYear();
    const stem = `${PREFIX}-${year}-`;
    const [[{ n }]] = await conn.query(
      `SELECT COUNT(*) AS n FROM pharmacy_sales WHERE admin_id = ? AND sale_number LIKE ?`,
      [adminId, `${stem}%`]
    );
    let seq = Number(n) + 1;
    let invoiceNumber = `${stem}${pad(seq)}`;
    for (let guard = 0; guard < 50; guard++) {
      const [taken] = await conn.query(`SELECT id FROM pharmacy_sales WHERE admin_id = ? AND sale_number = ? LIMIT 1`, [adminId, invoiceNumber]);
      if (!taken.length) break;
      invoiceNumber = `${stem}${pad(++seq)}`;
    }

    // the sale row first (the stock ledger points at it); its totals are filled in below
    const [ins] = await conn.query(
      `INSERT INTO pharmacy_sales
         (admin_id, branch, sale_number, customer_id, customer_name, customer_phone, sale_date,
          subtotal, discount_amount, tax_amount, grand_total, paid_amount, due_amount,
          payment_method, payment_status, status, sold_by, notes)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 0, 0, 0, 0, 0, 'credit', 'unpaid', 'completed', ?, NULL)`,
      [adminId, scope.branch, invoiceNumber, body.buyer.name, body.buyer.phone, `${body.invoiceDate} ${nowStamp().slice(11)}`, userId]
    );
    const invoiceId = ins.insertId;

    // stock out, line by line (each line may split over several batches)
    const lineRows = [];
    for (const it of body.items) {
      const med = meds.get(it.medicine_id);
      const rows = await takeStock(conn, { adminId, userId, med, line: it, scope, invoiceId, invoiceNumber });
      lineRows.push(...rows);
    }

    const totals = priceInvoice(lineRows, { discount: body.discount, otherCharges: body.other, isIgst });
    if (body.payment && body.payment.amount > totals.grand_total + 0.001) {
      throw new HttpError(400, `The payment (₹${body.payment.amount.toFixed(2)}) is more than the invoice total (₹${totals.grand_total.toFixed(2)})`);
    }

    // lines: quantity and rate in the unit sold; sale_unit / units_per_pack / tablets say what left the batch
    for (const r of totals.rows) {
      await conn.query(
        `INSERT INTO pharmacy_sale_items
           (sale_id, medicine_id, batch_id, quantity, sale_unit, units_per_pack, tablets,
            unit_price, discount_amount, gst_percentage, tax_amount, total_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [invoiceId, r.medicine_id, r.batch_id, r.quantity, r.sale_unit, r.units_per_pack, r.tablets,
          rate4(r.unit_price), r.discount_amount, r.gst_percentage, r.tax_amount, r.total_amount]
      );
    }

    let paid = 0;
    if (body.payment) {
      await conn.query(
        `INSERT INTO pharmacy_payments
           (admin_id, sale_id, purchase_id, payment_number, payment_date, amount, payment_method, transaction_reference, notes, received_by)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        [adminId, invoiceId, await nextPaymentNumber(conn, adminId), nowStamp(), body.payment.amount, body.payment.payment_method,
          body.payment.transaction_reference, "Received with the invoice", userId]
      );
      paid = body.payment.amount;
    }
    const pf = paymentFields(totals.grand_total, paid);

    const meta = {
      b2b: 1,
      buyer: body.buyer,
      seller: body.seller,
      igst: isIgst ? 1 : 0,
      due: body.dueDate || undefined,
      other: totals.other_charges || undefined,
      note: body.note || undefined,
    };
    await conn.query(
      `UPDATE pharmacy_sales
          SET subtotal = ?, discount_amount = ?, tax_amount = ?, grand_total = ?,
              paid_amount = ?, due_amount = ?, payment_status = ?, payment_method = ?, notes = ?
        WHERE id = ? AND admin_id = ?`,
      [
        totals.subtotal, totals.discount_amount, totals.tax_amount, totals.grand_total,
        paid, pf.due_amount, pf.payment_status, body.payment ? saleMethod(body.payment.payment_method) : "credit",
        JSON.stringify(meta), invoiceId, adminId,
      ]
    );

    await conn.commit();
    const complete = await fetchInvoice(db, invoiceId, adminId);
    return res.status(201).json({ success: true, message: `Invoice ${invoiceNumber} issued`, data: complete });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    return fail(res, err, "Failed to issue the invoice");
  } finally {
    if (conn) conn.release();
  }
});

/* ============================================================
   CANCEL - the stock goes back
============================================================ */
router.patch("/cancel/:id", authMiddleware, allowPermissions(PERM.edit), async (req, res) => {
  const adminId = getTenantAdminId(req);
  const userId = getUserId(req);
  let conn;
  try {
    const reason = cut(req.body && req.body.reason, 255);
    // scope first, outside the transaction: the invoice row lock must be its first statement
    const scope = await readScope(db, req, req.body && req.body.branch);
    const bw = branchWhere(scope);
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT s.* FROM pharmacy_sales s WHERE s.id = ? AND s.admin_id = ? AND ${IS_B2B}${bw.sql} FOR UPDATE`,
      [req.params.id, adminId, ...bw.params]
    );
    if (!rows.length) throw new HttpError(404, "Invoice not found");
    const inv = rows[0];
    if (inv.status === "cancelled") throw new HttpError(409, "This invoice is already cancelled");
    const [[{ n: returns }]] = await conn.query(
      `SELECT COUNT(*) AS n FROM pharmacy_returns WHERE sale_id = ? AND admin_id = ? AND (status IS NULL OR status <> 'cancelled')`,
      [inv.id, adminId]
    );
    if (Number(returns) > 0) {
      throw new HttpError(409, "Goods have been returned against this invoice. Cancel those returns first, then cancel the invoice.");
    }
    if (money(inv.paid_amount) > 0) {
      throw new HttpError(409, "Money has been received against this invoice. Remove the payments first, then cancel it.");
    }

    const meta = readMeta(inv.notes);
    const [items] = await conn.query(
      `SELECT i.*, b.units_per_pack AS batch_upp, b.id AS batch_found, m.unit, m.pack_size
         FROM pharmacy_sale_items i
         LEFT JOIN pharmacy_medicine_batches b ON b.id = i.batch_id AND b.admin_id = ?
         LEFT JOIN pharmacy_medicines m ON m.id = i.medicine_id
        WHERE i.sale_id = ? ORDER BY i.id ASC`,
      [adminId, inv.id]
    );
    for (const it of items) {
      if (!it.batch_found) continue; // the batch itself was removed; nothing to put back into
      // exactly the tablets that left the batch (old invoices: their quantity was already tablets)
      const read = readSaleLine(it, inv, { units_per_pack: it.batch_upp, pack_size: it.pack_size });
      if (!(read.tablets > 0)) continue;
      const word = packWord({ unit: it.unit, pack_size: it.pack_size }, read.units_per_pack);
      await recordMove(conn, {
        adminId,
        userId,
        batchId: it.batch_id,
        tabletsIn: read.tablets,
        type: "return",
        referenceId: inv.id,
        referenceNumber: inv.sale_number,
        notes: `B2B invoice ${inv.sale_number} cancelled - ${describeSaleQty(read.sale_unit, Number(it.quantity) || 0, word)} back to stock`,
      });
    }
    meta.cancel = { reason: reason || undefined, at: nowStamp(), by: userId };
    await conn.query(
      `UPDATE pharmacy_sales SET status = 'cancelled', due_amount = 0, notes = ? WHERE id = ? AND admin_id = ?`,
      [JSON.stringify(meta), inv.id, adminId]
    );
    await conn.commit();
    return res.json({ success: true, message: `Invoice ${inv.sale_number} cancelled`, data: await fetchInvoice(db, inv.id, adminId, scope) });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    return fail(res, err, "Failed to cancel the invoice");
  } finally {
    if (conn) conn.release();
  }
});

/* ============================================================
   PAYMENTS  (pharmacy_payments; a removal is a negative row)
============================================================ */
async function resync(conn, invoiceId, adminId) {
  const [[sale]] = await conn.query(`SELECT grand_total FROM pharmacy_sales WHERE id = ? AND admin_id = ?`, [invoiceId, adminId]);
  const [[{ paid }]] = await conn.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid FROM pharmacy_payments WHERE sale_id = ? AND admin_id = ?`,
    [invoiceId, adminId]
  );
  const pf = paymentFields(sale.grand_total, paid);
  await conn.query(
    `UPDATE pharmacy_sales SET paid_amount = ?, due_amount = ?, payment_status = ? WHERE id = ? AND admin_id = ?`,
    [Math.max(0, money(paid)), pf.due_amount, pf.payment_status, invoiceId, adminId]
  );
}

router.post("/payment/:id", authMiddleware, allowPermissions(PERM.create), async (req, res) => {
  const adminId = getTenantAdminId(req);
  let conn;
  try {
    const b = req.body || {};
    const amount = money(b.amount);
    if (!(amount > 0)) throw new HttpError(400, "Enter an amount above 0");
    const method = String(b.payment_method || "cash").toLowerCase();
    if (!PAY_METHODS.includes(method)) throw new HttpError(400, "Unknown payment method");
    const day = b.payment_date ? String(b.payment_date).slice(0, 10) : dayString();
    if (!isDay(day)) throw new HttpError(400, "The payment date isn't valid");

    const bw = branchWhere(await readScope(db, req, b.branch));
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT s.* FROM pharmacy_sales s WHERE s.id = ? AND s.admin_id = ? AND ${IS_B2B}${bw.sql} FOR UPDATE`,
      [req.params.id, adminId, ...bw.params]
    );
    if (!rows.length) throw new HttpError(404, "Invoice not found");
    const inv = rows[0];
    if (inv.status === "cancelled") throw new HttpError(409, "This invoice is cancelled");
    if (amount > money(inv.due_amount) + 0.001) {
      throw new HttpError(400, `Only ₹${money(inv.due_amount).toFixed(2)} is due on this invoice`);
    }
    await conn.query(
      `INSERT INTO pharmacy_payments
         (admin_id, sale_id, purchase_id, payment_number, payment_date, amount, payment_method, transaction_reference, notes, received_by)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [adminId, inv.id, await nextPaymentNumber(conn, adminId), `${day} ${nowStamp().slice(11)}`, amount, method,
        cut(b.transaction_reference, 255), cut(b.notes, 1000), getUserId(req)]
    );
    await resync(conn, inv.id, adminId);
    await conn.commit();
    return res.status(201).json({ success: true, message: "Payment recorded", data: await fetchInvoice(db, inv.id, adminId) });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    return fail(res, err, "Failed to record the payment");
  } finally {
    if (conn) conn.release();
  }
});

// "Remove" a payment: the table keeps every row, so a negative row that names it undoes it.
router.delete("/payment/:id/:paymentId", authMiddleware, allowPermissions(PERM.edit), async (req, res) => {
  const adminId = getTenantAdminId(req);
  let conn;
  try {
    const bw = branchWhere(await readScope(db, req, req.query.branch));
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT s.* FROM pharmacy_sales s WHERE s.id = ? AND s.admin_id = ? AND ${IS_B2B}${bw.sql} FOR UPDATE`,
      [req.params.id, adminId, ...bw.params]
    );
    if (!rows.length) throw new HttpError(404, "Invoice not found");
    const [pay] = await conn.query(
      `SELECT * FROM pharmacy_payments WHERE id = ? AND sale_id = ? AND admin_id = ? LIMIT 1`,
      [req.params.paymentId, rows[0].id, adminId]
    );
    if (!pay.length) throw new HttpError(404, "Payment not found");
    const p = pay[0];
    if (Number(p.amount) <= 0) throw new HttpError(409, "That entry is already a reversal");
    const [done] = await conn.query(
      `SELECT id FROM pharmacy_payments WHERE sale_id = ? AND admin_id = ? AND amount < 0 AND transaction_reference = ? LIMIT 1`,
      [rows[0].id, adminId, p.payment_number]
    );
    if (done.length) throw new HttpError(409, "That payment has already been removed");
    await conn.query(
      `INSERT INTO pharmacy_payments
         (admin_id, sale_id, purchase_id, payment_number, payment_date, amount, payment_method, transaction_reference, notes, received_by)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [adminId, rows[0].id, await nextPaymentNumber(conn, adminId), nowStamp(), -money(p.amount), p.payment_method,
        p.payment_number, `Reversal of ${p.payment_number}`, getUserId(req)]
    );
    await resync(conn, rows[0].id, adminId);
    await conn.commit();
    return res.json({ success: true, message: "Payment removed", data: await fetchInvoice(db, rows[0].id, adminId) });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    return fail(res, err, "Failed to remove the payment");
  } finally {
    if (conn) conn.release();
  }
});

/* ============================================================
   THE DOCUMENT - PDF, email, WhatsApp link
============================================================ */
const SHARE_DAYS = 30;
const SHARE_PURPOSE = "b2b-pdf";

function toWhatsappNumber(phone) {
  let d = String(phone || "").replace(/\D+/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  const cc = String(process.env.DEFAULT_COUNTRY_CODE || "91").replace(/\D+/g, "");
  if (d.length === 10) d = cc + d;
  else if (d.length === 11 && d.startsWith("0")) d = cc + d.slice(1);
  return d.length >= 11 && d.length <= 15 ? d : null;
}

function publicBase(req) {
  const env = String(process.env.API_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  return env || `${req.protocol}://${req.get("host")}`;
}

async function loadDocumentData(invoiceId, adminId, scope = null) {
  const invoice = await fetchInvoice(db, invoiceId, adminId, scope);
  if (!invoice) return null;
  const [rows] = await db.query(`SELECT notes FROM pharmacy_sales WHERE id = ? AND admin_id = ?`, [invoiceId, adminId]);
  const seller = await sellerFor(db, adminId, readMeta(rows[0] && rows[0].notes));
  return { invoice, items: invoice.items, payments: invoice.payments.filter((p) => !p.is_reversal && !p.reversed), seller };
}

const makePdf = (d) => buildB2BInvoicePdf({ invoice: d.invoice, items: d.items, payments: d.payments, seller: d.seller });
const SEND_PERMS = [PERM.create, PERM.edit];

router.get("/pdf/:id", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const d = await loadDocumentData(req.params.id, getTenantAdminId(req), await readScope(db, req, req.query.branch));
    if (!d) throw new HttpError(404, "Invoice not found");
    const pdf = await makePdf(d);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdf.length);
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${d.invoice.invoice_number}.pdf"`);
    return res.send(pdf);
  } catch (err) {
    return fail(res, err, "Failed to build the PDF");
  }
});

router.get("/send-info/:id", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const d = await loadDocumentData(req.params.id, getTenantAdminId(req), await readScope(db, req, req.query.branch));
    if (!d) throw new HttpError(404, "Invoice not found");
    return res.json({
      success: true,
      data: {
        id: d.invoice.id,
        invoice_number: d.invoice.invoice_number,
        status: d.invoice.status,
        grand_total: d.invoice.grand_total,
        due_amount: d.invoice.due_amount,
        items_count: d.items.length,
        buyer: {
          id: null,
          name: d.invoice.buyer_name,
          email: d.invoice.buyer_email || null,
          phone: d.invoice.buyer_phone || null,
        },
        whatsapp_phone: toWhatsappNumber(d.invoice.buyer_phone),
        company_name: d.seller.business_name,
        default_subject: defaultSubject(d.invoice, d.seller),
        default_message: defaultMessage(d.invoice, d.seller),
      },
    });
  } catch (err) {
    return fail(res, err, "Failed to load the sending details");
  }
});

router.post("/send-email/:id", authMiddleware, allowPermissions(...SEND_PERMS), async (req, res) => {
  try {
    const { to, cc, subject, message } = req.body || {};
    if (to !== undefined && to !== "" && !parseEmailList(to)) throw new HttpError(400, "That isn't a valid email address");
    if (cc && !parseEmailList(cc)) throw new HttpError(400, "One of the Cc addresses isn't valid");

    const d = await loadDocumentData(req.params.id, getTenantAdminId(req), await readScope(db, req, req.body && req.body.branch));
    if (!d) throw new HttpError(404, "Invoice not found");
    if (d.invoice.status === "cancelled") throw new HttpError(409, "This invoice is cancelled");
    const recipients = to ? parseEmailList(to) : isValidEmail(d.invoice.buyer_email) ? [d.invoice.buyer_email.trim()] : null;
    if (!recipients) throw new HttpError(400, "The buyer has no email address on file");

    const pdfBuffer = await makePdf(d);
    let sent;
    try {
      sent = await sendB2BInvoiceEmail({
        to: recipients,
        cc: cc ? parseEmailList(cc) || [] : [],
        subject, message,
        invoice: d.invoice, seller: d.seller, pdfBuffer,
        mailer: req.app && req.app.locals ? req.app.locals.b2bMailer : undefined,
      });
    } catch (e) {
      throw new HttpError(502, e.message || "Couldn't send the email");
    }
    return res.json({ success: true, message: `Sent to ${sent.to.join(", ")}`, data: { status: "sent", to: sent.to } });
  } catch (err) {
    return fail(res, err, "Couldn't send the email");
  }
});

router.post("/share-link/:id", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const adminId = getTenantAdminId(req);
    const d = await loadDocumentData(req.params.id, adminId, await readScope(db, req, req.body && req.body.branch));
    if (!d) throw new HttpError(404, "Invoice not found");
    if (d.invoice.status === "cancelled") throw new HttpError(409, "This invoice is cancelled");
    const token = jwt.sign(
      { purpose: SHARE_PURPOSE, inv: Number(d.invoice.id), admin: Number(adminId) },
      process.env.JWT_SECRET,
      { expiresIn: `${SHARE_DAYS}d` }
    );
    const url = `${publicBase(req)}/api/pharmacy/b2b-sales/shared/${token}/${encodeURIComponent(d.invoice.invoice_number)}.pdf`;
    const due = money(d.invoice.due_amount);
    const message = [
      `Hello${d.invoice.buyer_name ? ` ${d.invoice.buyer_name}` : ""},`,
      "",
      `Invoice ${d.invoice.invoice_number}${d.seller.business_name ? ` from ${d.seller.business_name}` : ""} - ₹${money(d.invoice.grand_total).toFixed(2)}.`,
      ...(due > 0 ? [`Balance due: ₹${due.toFixed(2)}${d.invoice.due_date ? ` by ${asDay(d.invoice.due_date)}` : ""}`] : []),
      `PDF: ${url}`,
      "",
      "Thank you.",
    ].join("\n");
    return res.json({
      success: true,
      data: {
        url,
        message,
        whatsapp_phone: toWhatsappNumber(d.invoice.buyer_phone),
        filename: `${d.invoice.invoice_number}.pdf`,
        expires_in_days: SHARE_DAYS,
      },
    });
  } catch (err) {
    return fail(res, err, "Failed to make the link");
  }
});

router.get("/shared/:token/:filename", async (req, res) => {
  try {
    let claims;
    try {
      claims = jwt.verify(req.params.token, process.env.JWT_SECRET);
    } catch (_) {
      return res.status(410).send("This link has expired or isn't valid. Ask the pharmacy to send it again.");
    }
    if (!claims || claims.purpose !== SHARE_PURPOSE || !claims.inv || !claims.admin) {
      return res.status(410).send("This link has expired or isn't valid. Ask the pharmacy to send it again.");
    }
    const d = await loadDocumentData(claims.inv, claims.admin);
    if (!d || d.invoice.status === "cancelled") return res.status(404).send("This invoice is no longer available.");
    const pdf = await makePdf(d);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdf.length);
    res.setHeader("Content-Disposition", `inline; filename="${d.invoice.invoice_number}.pdf"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.send(pdf);
  } catch (err) {
    console.error("Shared invoice pdf error:", err);
    return res.status(500).send("Couldn't open the invoice.");
  }
});

module.exports = router;
module.exports._test = { priceInvoice, unitsPerPack, splitTablets, describeStock, isInterState, paymentFields, readMeta, saleMethod };