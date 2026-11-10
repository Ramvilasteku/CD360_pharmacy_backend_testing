// routes/Pharmacy/pharmacyPurchaseReturns.js
//
// Purchase returns — stock going BACK to the supplier (expired, damaged, wrong item, excess,
// recalled…), against a debit note (credit on what you owe them) or a refund.
//
// Mount in server.js:
//   app.use("/api/pharmacy/purchase-returns", require("./routes/Pharmacy/pharmacyPurchaseReturns.js"));
//
// Needs sql/2026-10-22_purchase_returns.sql (columns, the 'debit_note' payment method, permissions).
//
//   GET    /getall/returns            list (search, supplier_id, status, settlement, date_from, date_to, page, limit, branch)
//   GET    /get/return/:id            one return: lines, set-offs against purchase orders
//   GET    /getall/suppliers          suppliers with what you owe them and their open credit
//   GET    /getall/orders             received orders to return against (search, supplier_id)
//   GET    /get/returnable            what can go back: ?purchase_id=  (a received order's lines)
//                                                    or ?supplier_id= (that supplier's batches in stock)
//   POST   /preview/return            check a return and work out the money — writes nothing
//   POST   /post/return               return the stock (one transaction)
//   POST   /apply/credit/:id          set a debit note's open credit off against unpaid orders
//   PATCH  /cancel/return/:id         undo a return: stock back on the shelf, credit taken back
//   GET    /pdf/return/:id            the debit note (A4 PDF)
//
// ------------------------------------------------------------------------------------------------
// RULES
//   • Units (utils/pharmacyUnits.js): a line goes back in strips (or whole packs for a 1-per-pack
//     item), or in loose tablets from an opened strip. Stock leaves the batch in TABLETS through
//     recordMove() (type 'purchase_return'), so the shelf and the ledger always agree.
//   • Never more than the batch holds in this branch, and — for a batch that came in on a purchase
//     order — never more than that order line brought in, less what has already gone back.
//   • Value: rate per strip BEFORE GST. Default = what you actually paid on that bill:
//     (line total − line GST) ÷ strips paid for — so the discount % and the scheme are already
//     off. A batch with no purchase line uses the batch's purchase price. The rate can be changed
//     (some suppliers credit expired stock at a different rate); GST is added on top.
//     An order line can never be credited for more than it cost, less earlier returns.
//   • Settlement
//       debit_note  the value is set off against what you owe the supplier: first the order the
//                   stock came in on, then their other unpaid orders, oldest first. Each set-off is
//                   a pharmacy_payments row (method 'debit_note', reference = the return number),
//                   so the order's paid / due / status move exactly like a payment. Whatever is left
//                   stays as OPEN CREDIT with the supplier (Apply credit later, from the return).
//       refund      the supplier pays the money back (method + reference); orders are untouched.
//   • Branch (utils/pharmacyBranch.js): stock leaves the branch you work in; the admin of a
//     multi-branch pharmacy picks one.
//   • One step: confirm = stock out + debit note. A mistake is undone with Cancel (stock back in as
//     an 'adjustment', the debit-note set-offs removed from the orders).
// ------------------------------------------------------------------------------------------------

const express = require("express");
const router = express.Router();
const PDFDocument = require("pdfkit");
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
const { unitsPerPack, packWord, describeStock, plural, money, rate4 } = require("../../utils/pharmacyUnits");
const { recordMove, istNow, istToday } = require("../../utils/pharmacyStock");
const { resolveScope, batchFilter, sendBranchError } = require("../../utils/pharmacyBranch");

const FILE_VERSION = "pharmacyPurchaseReturns v1.0 (2026-10-22)";
console.log(`[pharmacy] ${FILE_VERSION} loaded`);

const PERM = {
  view: "pharmacy.purchase_return.view",
  create: "pharmacy.purchase_return.create",
  edit: "pharmacy.purchase_return.edit",
};

const REASONS = {
  expired: "Expired",
  near_expiry: "Near expiry",
  damaged: "Damaged / broken",
  wrong_item: "Wrong item supplied",
  excess: "Excess supply",
  recalled: "Batch recalled",
  other: "Other",
};
const REFUND_METHODS = { cash: "Cash", upi: "UPI", bank_transfer: "Bank transfer", card: "Card", other: "Other" };
const SETTLEMENTS = ["debit_note", "refund"];
const MAX_LINES = 200;
const NEAR_EXPIRY_DAYS = 90;

/* ============================================================
   Small helpers
============================================================ */
function httpError(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}

function sendError(res, err, label, fallback) {
  if (sendBranchError(res, err)) return undefined;
  const status = Number(err.status) || 500;
  if (status >= 500) console.error(label, err);
  return res.status(status).json({
    success: false,
    message: status >= 500 ? fallback : err.message,
    ...(err.extra ? { details: err.extra } : {}),
  });
}

const getTenantAdminId = (req) => {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
};

const has = (o, k) => o && o[k] !== undefined && o[k] !== null && String(o[k]).trim() !== "";
const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const toDay = (v) => {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return isIso(s) ? s : null;
};
const cleanText = (v, max = 255) => {
  const t = v == null ? "" : String(v).trim();
  return t ? t.slice(0, max) : null;
};
const parseId = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `Invalid ${what} id`);
  return n;
};
const inr = (n) => money(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const daysBetween = (fromIso, toIso) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);

const medicineLabel = (r) =>
  [r.brand_name || r.medicine_name, r.strength].filter(Boolean).join(" ") || `Medicine #${r.medicine_id}`;

const MED_COLS = `md.medicine_name, md.brand_name, md.strength, md.dosage_form,
                  pm.unit, pm.pack_size, pm.manufacturer, pm.gst_percentage AS med_gst,
                  pm.units_per_pack AS med_upp, pm.medicine_code`;
const MED_JOIN = `JOIN pharmacy_medicines pm ON pm.id = b.medicine_id AND pm.admin_id = b.admin_id
                  LEFT JOIN medicine_data md ON md.id = pm.medicine_data_id`;

/* the migration has to be run first — say so instead of failing on a missing column */
let schemaReady = false;
async function requireSchema(q) {
  if (schemaReady) return;
  const [rows] = await q.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND ((TABLE_NAME = 'pharmacy_returns' AND COLUMN_NAME IN ('supplier_id', 'settlement', 'credit_applied'))
          OR (TABLE_NAME = 'pharmacy_return_items' AND COLUMN_NAME IN ('purchase_item_id', 'reason')))`
  );
  if (Number(rows[0].n) < 5)
    throw httpError(503, "Purchase returns are not set up yet — run sql/2026-10-22_purchase_returns.sql on the database.");
  schemaReady = true;
}

/* rate per strip before GST, from a purchase order line: what you actually paid */
function rateFromPurchaseLine(pi) {
  const qty = Number(pi.quantity) || 0;
  const total = Number(pi.total_amount) || 0;
  const tax = Number(pi.tax_amount) || 0;
  if (qty > 0 && total > 0) return rate4((total - tax) / qty);
  const gross = qty * (Number(pi.purchase_price) || 0);
  if (qty > 0) return rate4((gross - (Number(pi.discount_amount) || 0)) / qty);
  return rate4(pi.purchase_price);
}

/* tablets a purchase line brought in, and what already went back from it (completed returns) */
async function returnedFromLines(conn, adminId, itemIds) {
  const map = new Map();
  if (!itemIds.length) return map;
  const [rows] = await conn.query(
    `SELECT ri.purchase_item_id,
            SUM(COALESCE(ri.tablets, ri.quantity)) AS tablets,
            SUM(ri.total_amount) AS amount
       FROM pharmacy_return_items ri
       JOIN pharmacy_returns r ON r.id = ri.return_id
      WHERE r.admin_id = ? AND r.return_type = 'supplier_return' AND r.status = 'completed'
        AND ri.purchase_item_id IN (?)
      GROUP BY ri.purchase_item_id`,
    [adminId, itemIds]
  );
  for (const r of rows) map.set(Number(r.purchase_item_id), { tablets: Number(r.tablets) || 0, amount: Number(r.amount) || 0 });
  return map;
}

/* a returnable line, as the screen shows it */
function describeLine(b, pi, returned, today) {
  const upp = unitsPerPack(b);
  const word = packWord({ unit: b.unit, units_per_pack: upp }, upp);
  const exp = toDay(b.expiry_date);
  const left = exp ? daysBetween(today, exp) : null;
  const inTablets = pi
    ? ((Number(pi.quantity) || 0) + (Number(pi.free_quantity) || 0)) * (Number(pi.units_per_pack) >= 1 ? Number(pi.units_per_pack) : upp)
    : null;
  const back = returned ? returned.tablets : 0;
  const lineRoom = inTablets == null ? null : Math.max(0, inTablets - back);
  const available = Number(b.quantity_available) || 0;
  const canReturn = lineRoom == null ? available : Math.min(available, lineRoom);
  return {
    batch_id: Number(b.id),
    medicine_id: Number(b.medicine_id),
    medicine: medicineLabel(b),
    dosage_form: b.dosage_form || null,
    manufacturer: b.manufacturer || null,
    batch_number: b.batch_number,
    expiry_date: exp,
    days_to_expiry: left,
    expired: left != null && left < 0,
    near_expiry: left != null && left >= 0 && left <= NEAR_EXPIRY_DAYS,
    storage_location: b.storage_location || null,
    branch: b.branch || null,
    units_per_pack: upp,
    pack_word: word,
    available_tablets: available,
    available_text: describeStock(available, upp, word),
    can_return_tablets: canReturn,
    can_return_text: describeStock(canReturn, upp, word),
    purchase_item_id: pi ? Number(pi.id) : null,
    purchase_id: pi ? Number(pi.purchase_id) : null,
    purchase_number: pi ? pi.purchase_number : null,
    invoice_number: pi ? pi.invoice_number || null : null,
    received_text: pi ? describeStock(inTablets, upp, word) : null,
    returned_text: back ? describeStock(back, upp, word) : null,
    rate: pi ? rateFromPurchaseLine(pi) : rate4(b.purchase_price),
    rate_from: pi ? "bill" : "batch",
    mrp: money(b.mrp),
    gst_percentage: pi && pi.gst_percentage != null ? Number(pi.gst_percentage) : Number(b.med_gst) || 0,
    suggested_reason: left != null && left < 0 ? "expired" : left != null && left <= NEAR_EXPIRY_DAYS ? "near_expiry" : null,
  };
}

async function verifySupplier(conn, adminId, supplierId) {
  const [rows] = await conn.query(
    `SELECT * FROM pharmacy_suppliers WHERE id = ? AND admin_id = ? LIMIT 1`,
    [supplierId, adminId]
  );
  if (!rows.length) throw httpError(404, "Supplier not found");
  return rows[0];
}

/* unpaid orders of a supplier, the linked ones first, then oldest first */
async function unpaidOrders(conn, adminId, supplierId, firstIds, lock) {
  const [rows] = await conn.query(
    `SELECT id, purchase_number, purchase_date, invoice_number, grand_total, paid_amount, status
       FROM pharmacy_purchase_orders
      WHERE admin_id = ? AND supplier_id = ? AND status IN ('ordered', 'received')
        AND grand_total - paid_amount > 0.004
      ORDER BY purchase_date ASC, id ASC
      ${lock ? "FOR UPDATE" : ""}`,
    [adminId, supplierId]
  );
  const first = firstIds.map(Number);
  return [
    ...first.map((id) => rows.find((r) => Number(r.id) === id)).filter(Boolean),
    ...rows.filter((r) => !first.includes(Number(r.id))),
  ];
}

/* how a credit is spread over unpaid orders */
function planSetOff(orders, amount) {
  let left = money(amount);
  const plan = [];
  for (const o of orders) {
    if (left <= 0.004) break;
    const due = money(Number(o.grand_total) - Number(o.paid_amount));
    if (due <= 0.004) continue;
    const take = money(Math.min(due, left));
    plan.push({ purchase_id: Number(o.id), purchase_number: o.purchase_number, invoice_number: o.invoice_number || null, due, apply: take });
    left = money(left - take);
  }
  return { plan, applied: money(amount - left), open: left };
}

/* write the set-offs: one 'debit_note' payment per order, the order's money moved like a payment */
async function writeSetOffs(conn, { adminId, userId, plan, returnNumber, note }) {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  for (const p of plan) {
    const [[po]] = await conn.query(
      `SELECT id, grand_total, paid_amount, status FROM pharmacy_purchase_orders WHERE id = ? AND admin_id = ? FOR UPDATE`,
      [p.purchase_id, adminId]
    );
    const due = money(Number(po.grand_total) - Number(po.paid_amount));
    if (p.apply > due + 0.004) throw httpError(409, `${p.purchase_number} now owes only ₹${inr(due)} — check the return again.`);
    const [[c]] = await conn.query(
      `SELECT COUNT(*) + 1 AS seq FROM pharmacy_payments WHERE admin_id = ? AND DATE(payment_date) = CURDATE()`,
      [adminId]
    );
    const paymentNumber = `PAY-${ymd}-${String(c.seq).padStart(5, "0")}`;
    await conn.query(
      `INSERT INTO pharmacy_payments
         (admin_id, sale_id, purchase_id, payment_number, amount, payment_method, transaction_reference, notes, received_by)
       VALUES (?, NULL, ?, ?, ?, 'debit_note', ?, ?, ?)`,
      [adminId, p.purchase_id, paymentNumber, p.apply, returnNumber, note, userId]
    );
    const newPaid = money(Number(po.paid_amount) + p.apply);
    const newDue = Math.max(0, money(Number(po.grand_total) - newPaid));
    const status = newDue <= 0.001 ? "paid" : newPaid > 0 ? "partial" : "unpaid";
    await conn.query(
      `UPDATE pharmacy_purchase_orders SET paid_amount = ?, due_amount = ?, payment_status = ? WHERE id = ? AND admin_id = ?`,
      [newPaid, newDue, status, p.purchase_id, adminId]
    );
    p.payment_number = paymentNumber;
  }
}

async function nextReturnNumber(conn, adminId, day) {
  const year = String(day).slice(0, 4);
  const [[r]] = await conn.query(
    `SELECT MAX(CAST(SUBSTRING_INDEX(return_number, '-', -1) AS UNSIGNED)) AS n
       FROM pharmacy_returns WHERE admin_id = ? AND return_number LIKE ?`,
    [adminId, `PR-${year}-%`]
  );
  return `PR-${year}-${String((Number(r.n) || 0) + 1).padStart(4, "0")}`;
}

/* ============================================================
   THE CHECK — preview and post run the same function
   body: { purchase_id? | supplier_id, branch?, return_date?, settlement, refund_method?,
           refund_reference?, reason?, notes?,
           lines: [{ batch_id, purchase_item_id?, unit: 'strip'|'tablet'|'pack', quantity,
                     rate? (per strip, before GST), gst_percentage?, reason? }] }
============================================================ */
async function resolveReturn(conn, req, body, apply) {
  const adminId = getTenantAdminId(req);
  const lock = apply ? "FOR UPDATE" : "";
  const today = istToday();
  const problems = [];
  const warnings = [];

  const scope = await resolveScope(conn, req, { wanted: body.branch, forWrite: true });
  const bf = batchFilter(scope, "b");

  /* -- header: an order, or a supplier -- */
  let order = null;
  let supplier;
  if (has(body, "purchase_id")) {
    const id = parseId(body.purchase_id, "purchase order");
    const [rows] = await conn.query(
      `SELECT * FROM pharmacy_purchase_orders WHERE id = ? AND admin_id = ? LIMIT 1 ${lock}`,
      [id, adminId]
    );
    if (!rows.length) throw httpError(404, "Purchase order not found");
    order = rows[0];
    if (order.status !== "received")
      throw httpError(409, `${order.purchase_number} is '${order.status}' — only received orders can be returned.`);
    if (!order.supplier_id) throw httpError(409, `${order.purchase_number} has no supplier.`);
    if (has(body, "supplier_id") && Number(body.supplier_id) !== Number(order.supplier_id))
      throw httpError(400, `${order.purchase_number} is from a different supplier.`);
    supplier = await verifySupplier(conn, adminId, order.supplier_id);
  } else {
    if (!has(body, "supplier_id")) throw httpError(400, "Choose the supplier, or the purchase order the stock came in on.");
    supplier = await verifySupplier(conn, adminId, parseId(body.supplier_id, "supplier"));
  }

  let returnDate = today;
  if (has(body, "return_date")) {
    returnDate = toDay(body.return_date);
    if (!returnDate) throw httpError(400, "return_date must be YYYY-MM-DD");
    if (returnDate > today) throw httpError(400, "The return date can't be in the future.");
    const received = toDay(order?.purchase_date);
    if (received && returnDate < received) throw httpError(400, `The return date can't be before ${order.purchase_number} (${received}).`);
  }

  const settlement = has(body, "settlement") ? String(body.settlement) : "debit_note";
  if (!SETTLEMENTS.includes(settlement)) throw httpError(400, "settlement must be debit_note or refund");
  const refundMethod = has(body, "refund_method") ? String(body.refund_method) : null;
  if (settlement === "refund" && !REFUND_METHODS[refundMethod])
    problems.push(`How did the supplier refund it? Choose ${Object.values(REFUND_METHODS).join(", ")}.`);
  const headerReason = has(body, "reason") ? String(body.reason) : null;
  if (headerReason && !REASONS[headerReason]) throw httpError(400, `reason must be one of: ${Object.keys(REASONS).join(", ")}`);

  /* -- lines -- */
  const input = Array.isArray(body.lines) ? body.lines : [];
  if (!input.length) throw httpError(400, "Add at least one medicine to return.");
  if (input.length > MAX_LINES) throw httpError(400, `Too many lines (max ${MAX_LINES}).`);

  const batchIds = [...new Set(input.map((l) => Number(l && l.batch_id)).filter((n) => Number.isInteger(n) && n > 0))];
  const [batchRows] = batchIds.length
    ? await conn.query(
        `SELECT b.*, ${MED_COLS}
           FROM pharmacy_medicine_batches b ${MED_JOIN}
          WHERE b.admin_id = ? AND b.id IN (?) ${bf.sql}
          ${lock}`,
        [adminId, batchIds, ...bf.params]
      )
    : [[]];
  const batches = new Map(batchRows.map((b) => [Number(b.id), b]));

  // the purchase lines these batches came in on (named on the line, or found by batch)
  const named = input.map((l) => Number(l && l.purchase_item_id)).filter((n) => Number.isInteger(n) && n > 0);
  const [piRows] = batchIds.length
    ? await conn.query(
        `SELECT pi.*, po.purchase_number, po.invoice_number, po.supplier_id, po.status AS po_status, po.purchase_date
           FROM pharmacy_purchase_items pi
           JOIN pharmacy_purchase_orders po ON po.id = pi.purchase_id AND po.admin_id = ?
          WHERE (pi.batch_id IN (?) ${named.length ? "OR pi.id IN (?)" : ""}) AND po.status = 'received'
          ORDER BY pi.id DESC`,
        named.length ? [adminId, batchIds, named] : [adminId, batchIds]
      )
    : [[]];
  const piById = new Map(piRows.map((p) => [Number(p.id), p]));
  const returned = await returnedFromLines(conn, adminId, piRows.map((p) => Number(p.id)));

  const usedTablets = new Map(); // batch → tablets taken by earlier lines of this return
  const usedLine = new Map(); // purchase item → { tablets, amount } taken by earlier lines
  const out = [];

  input.forEach((raw, i) => {
    const l = raw || {};
    const n = i + 1;
    const res = { index: i, problems: [], warnings: [] };
    out.push(res);

    const batchId = Number(l.batch_id);
    const b = batches.get(batchId);
    if (!b) {
      res.problems.push(`Line ${n}: that batch isn't in ${scope.branch ? `the ${scope.branch} branch` : "your stock"}.`);
      return;
    }
    // which purchase line it came in on
    let pi = null;
    if (has(l, "purchase_item_id")) {
      pi = piById.get(Number(l.purchase_item_id)) || null;
      if (!pi || (Number(pi.batch_id) !== batchId && !(Number(pi.medicine_id) === Number(b.medicine_id)
          && String(pi.batch_number || "").toUpperCase() === String(b.batch_number || "").toUpperCase()))) {
        res.problems.push(`Line ${n}: batch ${b.batch_number} didn't come in on that order line.`);
        pi = null;
      }
    } else {
      pi = piRows.find((p) => Number(p.batch_id) === batchId && (!order || Number(p.purchase_id) === Number(order.id))) || null;
    }
    if (order && (!pi || Number(pi.purchase_id) !== Number(order.id)))
      res.problems.push(`Line ${n}: batch ${b.batch_number} didn't come in on ${order.purchase_number}.`);
    if (!order) {
      const from = pi ? Number(pi.supplier_id) : b.supplier_id != null ? Number(b.supplier_id) : null;
      if (from && from !== Number(supplier.id))
        res.problems.push(`Line ${n}: batch ${b.batch_number} came from a different supplier.`);
      else if (!from) res.warnings.push(`Batch ${b.batch_number} has no supplier on record — make sure it came from ${supplier.supplier_name}.`);
    }

    const info = describeLine(b, pi, pi ? returned.get(Number(pi.id)) : null, today);
    Object.assign(res, info);

    // unit and quantity
    const upp = info.units_per_pack;
    let unit = has(l, "unit") ? String(l.unit).toLowerCase() : "strip";
    if (upp <= 1) unit = "pack";
    else if (unit === "pack") unit = "strip";
    if (!["strip", "tablet", "pack"].includes(unit)) {
      res.problems.push(`Line ${n}: unit must be strip or tablet.`);
      unit = "strip";
    }
    const qty = Number(l.quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      res.problems.push(`Line ${n}: enter how many ${plural(unit === "tablet" ? "tablet" : info.pack_word, 2)} go back.`);
    }
    const quantity = Number.isInteger(qty) && qty > 0 ? qty : 0;
    const tablets = unit === "tablet" ? quantity : quantity * upp;

    // never more than the batch holds (counting earlier lines on this return) …
    const before = usedTablets.get(batchId) || 0;
    if (tablets && before + tablets > info.available_tablets)
      res.problems.push(`Line ${n}: only ${info.available_text} left in batch ${b.batch_number}.`);
    usedTablets.set(batchId, before + tablets);

    // … nor more than its order line brought in, less what already went back
    if (pi) {
      const lineUsed = usedLine.get(Number(pi.id)) || { tablets: 0, amount: 0 };
      const inTablets = ((Number(pi.quantity) || 0) + (Number(pi.free_quantity) || 0)) * (Number(pi.units_per_pack) >= 1 ? Number(pi.units_per_pack) : upp);
      const back = (returned.get(Number(pi.id))?.tablets || 0) + lineUsed.tablets;
      if (tablets && back + tablets > inTablets)
        res.problems.push(`Line ${n}: ${pi.purchase_number} brought in ${describeStock(inTablets, upp, info.pack_word)} of batch ${b.batch_number}${back ? `, ${describeStock(back, upp, info.pack_word)} already went back` : ""}.`);
    }

    // rate (per strip, before GST) and GST
    let rate = info.rate;
    if (has(l, "rate")) {
      const r = Number(l.rate);
      if (!Number.isFinite(r) || r < 0) res.problems.push(`Line ${n}: the rate must be a number, 0 or more.`);
      else {
        if (r > info.rate + 0.0001 && info.rate > 0)
          res.warnings.push(`Rate ₹${inr(r)} is more than the ₹${inr(info.rate)} paid per ${info.pack_word} on the bill.`);
        rate = rate4(r);
      }
    }
    let gst = info.gst_percentage;
    if (has(l, "gst_percentage")) {
      const g = Number(l.gst_percentage);
      if (!Number.isFinite(g) || g < 0 || g > 100) res.problems.push(`Line ${n}: GST % must be from 0 to 100.`);
      else gst = g;
    }
    const unitPrice = unit === "tablet" ? rate4(rate / upp) : rate;
    const taxable = money(quantity * unitPrice);
    const tax = money((taxable * gst) / 100);
    const total = money(taxable + tax);

    if (pi) {
      const lineUsed = usedLine.get(Number(pi.id)) || { tablets: 0, amount: 0 };
      const cost = money(pi.total_amount);
      const creditedBefore = money((returned.get(Number(pi.id))?.amount || 0) + lineUsed.amount);
      if (cost > 0 && total > 0 && creditedBefore + total > cost + 0.01)
        res.problems.push(`Line ${n}: ${pi.purchase_number} line cost ₹${inr(cost)}${creditedBefore ? ` and ₹${inr(creditedBefore)} was already credited` : ""} — the credit can't be more.`);
      usedLine.set(Number(pi.id), { tablets: lineUsed.tablets + tablets, amount: money(lineUsed.amount + total) });
    }

    // why it goes back
    let reason = has(l, "reason") ? String(l.reason) : headerReason || info.suggested_reason;
    if (!reason) res.problems.push(`Line ${n}: choose why it goes back.`);
    else if (!REASONS[reason]) {
      res.problems.push(`Line ${n}: reason must be one of: ${Object.keys(REASONS).join(", ")}.`);
      reason = null;
    }
    if (info.expired && reason && reason !== "expired" && reason !== "recalled")
      res.warnings.push(`Batch ${b.batch_number} expired on ${info.expiry_date}.`);

    Object.assign(res, {
      unit,
      quantity,
      tablets,
      tablets_text: describeStock(tablets, upp, info.pack_word),
      rate,
      unit_price: unitPrice,
      gst_percentage: gst,
      taxable,
      tax_amount: tax,
      total_amount: total,
      reason,
      reason_label: reason ? REASONS[reason] : null,
      _batch: b,
      _pi: pi,
    });
  });

  for (const r of out) {
    problems.push(...r.problems);
    for (const w of r.warnings) warnings.push(`Line ${r.index + 1}: ${w}`);
  }

  const totals = {
    taxable: money(out.reduce((s, r) => s + (r.taxable || 0), 0)),
    tax_amount: money(out.reduce((s, r) => s + (r.tax_amount || 0), 0)),
    total_amount: money(out.reduce((s, r) => s + (r.total_amount || 0), 0)),
    tablets: out.reduce((s, r) => s + (r.tablets || 0), 0),
    lines: out.length,
  };
  if (!problems.length && totals.total_amount <= 0) warnings.push("The return is worth ₹0 — no credit will be recorded.");

  /* -- the money: where a debit note goes -- */
  let setOff = { plan: [], applied: 0, open: 0 };
  if (settlement === "debit_note" && totals.total_amount > 0) {
    const first = order ? [order.id] : [...new Set(out.map((r) => r._pi && r._pi.purchase_id).filter(Boolean))];
    const orders = await unpaidOrders(conn, adminId, supplier.id, first, apply);
    setOff = planSetOff(orders, totals.total_amount);
  }

  return {
    adminId,
    scope,
    order,
    supplier,
    returnDate,
    settlement,
    refundMethod,
    refundReference: cleanText(body.refund_reference),
    notes: cleanText(body.notes, 2000),
    lines: out,
    totals,
    setOff,
    problems,
    warnings,
  };
}

/* what the screen gets back from a check */
const previewOut = (r) => ({
  can_return: r.problems.length === 0,
  problems: r.problems,
  warnings: r.warnings,
  branch: r.scope.branch || null,
  purchase_id: r.order ? Number(r.order.id) : null,
  purchase_number: r.order ? r.order.purchase_number : null,
  supplier: { id: Number(r.supplier.id), supplier_name: r.supplier.supplier_name },
  return_date: r.returnDate,
  settlement: r.settlement,
  lines: r.lines.map(({ _batch, _pi, ...l }) => l),
  totals: r.totals,
  set_off: r.setOff.plan,
  credit_applied: r.setOff.applied,
  open_credit: r.setOff.open,
});

/* ============================================================
   ONE RETURN, as stored
============================================================ */
async function fetchReturn(q, adminId, id) {
  const [rows] = await q.query(
    `SELECT r.*, s.supplier_name, s.gst_number AS supplier_gst, s.drug_license_number AS supplier_dl,
            s.address AS supplier_address, s.city AS supplier_city, s.state AS supplier_state,
            s.pincode AS supplier_pincode, s.phone AS supplier_phone, s.email AS supplier_email,
            po.purchase_number, po.invoice_number, po.invoice_date
       FROM pharmacy_returns r
       LEFT JOIN pharmacy_suppliers s ON s.id = r.supplier_id AND s.admin_id = r.admin_id
       LEFT JOIN pharmacy_purchase_orders po ON po.id = r.purchase_id AND po.admin_id = r.admin_id
      WHERE r.id = ? AND r.admin_id = ? AND r.return_type = 'supplier_return' LIMIT 1`,
    [id, adminId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const [items] = await q.query(
    `SELECT ri.*, b.batch_number, b.expiry_date, b.storage_location,
            md.medicine_name, md.brand_name, md.strength, md.dosage_form, pm.unit, pm.medicine_code, pm.manufacturer,
            pi.purchase_id AS item_purchase_id, po.purchase_number AS item_purchase_number, po.invoice_number AS item_invoice_number
       FROM pharmacy_return_items ri
       LEFT JOIN pharmacy_medicine_batches b ON b.id = ri.batch_id
       LEFT JOIN pharmacy_medicines pm ON pm.id = ri.medicine_id
       LEFT JOIN medicine_data md ON md.id = pm.medicine_data_id
       LEFT JOIN pharmacy_purchase_items pi ON pi.id = ri.purchase_item_id
       LEFT JOIN pharmacy_purchase_orders po ON po.id = pi.purchase_id
      WHERE ri.return_id = ? ORDER BY ri.id ASC`,
    [id]
  );
  const [setOffs] = await q.query(
    `SELECT p.id, p.payment_number, p.payment_date, p.amount, p.purchase_id, po.purchase_number, po.invoice_number
       FROM pharmacy_payments p
       LEFT JOIN pharmacy_purchase_orders po ON po.id = p.purchase_id
      WHERE p.admin_id = ? AND p.payment_method = 'debit_note' AND p.transaction_reference = ?
      ORDER BY p.id ASC`,
    [adminId, r.return_number]
  );
  const lines = items.map((it) => {
    const upp = Number(it.units_per_pack) >= 1 ? Number(it.units_per_pack) : 1;
    const word = packWord({ unit: it.unit, units_per_pack: upp }, upp);
    const tablets = it.tablets != null ? Number(it.tablets) : Number(it.quantity);
    const taxable = money(Number(it.total_amount) - Number(it.tax_amount || 0));
    return {
      id: Number(it.id),
      medicine_id: Number(it.medicine_id),
      medicine: medicineLabel(it),
      dosage_form: it.dosage_form || null,
      manufacturer: it.manufacturer || null,
      medicine_code: it.medicine_code || null,
      batch_id: Number(it.batch_id),
      batch_number: it.batch_number,
      expiry_date: toDay(it.expiry_date),
      unit: it.sale_unit || "strip",
      quantity: Number(it.quantity),
      units_per_pack: upp,
      pack_word: word,
      tablets,
      tablets_text: describeStock(tablets, upp, word),
      unit_price: Number(it.unit_price),
      rate: it.sale_unit === "tablet" ? rate4(Number(it.unit_price) * upp) : rate4(it.unit_price),
      gst_percentage: Number(it.gst_percentage) || 0,
      taxable,
      tax_amount: money(it.tax_amount),
      total_amount: money(it.total_amount),
      reason: it.reason || null,
      reason_label: REASONS[it.reason] || it.reason || null,
      purchase_item_id: it.purchase_item_id ? Number(it.purchase_item_id) : null,
      purchase_number: it.item_purchase_number || null,
      invoice_number: it.item_invoice_number || null,
    };
  });
  const total = money(r.total_amount);
  const applied = money(r.credit_applied);
  return {
    id: Number(r.id),
    return_number: r.return_number,
    return_date: toDay(r.return_date),
    status: r.status,
    supplier: {
      id: r.supplier_id ? Number(r.supplier_id) : null,
      supplier_name: r.supplier_name || null,
      gst_number: r.supplier_gst || null,
      drug_license_number: r.supplier_dl || null,
      address: [r.supplier_address, r.supplier_city, r.supplier_state, r.supplier_pincode].filter(Boolean).join(", ") || null,
      phone: r.supplier_phone || null,
      email: r.supplier_email || null,
    },
    purchase_id: r.purchase_id ? Number(r.purchase_id) : null,
    purchase_number: r.purchase_number || null,
    invoice_number: r.invoice_number || null,
    invoice_date: toDay(r.invoice_date),
    branch: r.branch || null,
    reason: r.reason || null,
    settlement: r.settlement || "debit_note",
    total_amount: total,
    taxable: money(lines.reduce((s, l) => s + l.taxable, 0)),
    tax_amount: money(lines.reduce((s, l) => s + l.tax_amount, 0)),
    credit_applied: applied,
    open_credit: r.settlement === "debit_note" && r.status === "completed" ? money(total - applied) : 0,
    refund_amount: money(r.refund_amount),
    refund_method: r.refund_method || null,
    refund_method_label: REFUND_METHODS[r.refund_method] || r.refund_method || null,
    refund_reference: r.refund_reference || null,
    notes: r.notes || null,
    processed_by: r.processed_by || null,
    created_at: r.created_at,
    lines,
    set_offs: setOffs.map((p) => ({
      id: Number(p.id),
      payment_number: p.payment_number,
      payment_date: p.payment_date,
      amount: money(p.amount),
      purchase_id: p.purchase_id ? Number(p.purchase_id) : null,
      purchase_number: p.purchase_number || null,
      invoice_number: p.invoice_number || null,
    })),
  };
}

/* ============================================================
   ROUTES
============================================================ */
router.get("/version", (req, res) => res.json({ success: true, file: FILE_VERSION }));

/* list */
router.get("/getall/returns", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    await requireSchema(db);
    const adminId = getTenantAdminId(req);
    const q = req.query;
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const where = ["r.admin_id = ?", "r.return_type = 'supplier_return'"];
    const params = [adminId];

    // several branches: staff see their own branch's returns; the admin all, or one
    const scope = await resolveScope(db, req, { wanted: q.branch, forWrite: false });
    if (scope.filter) {
      where.push("LOWER(TRIM(COALESCE(r.branch, ''))) = ?");
      params.push(scope.key);
    }
    if (has(q, "supplier_id")) {
      where.push("r.supplier_id = ?");
      params.push(Number(q.supplier_id));
    }
    if (has(q, "purchase_id")) {
      where.push("r.purchase_id = ?");
      params.push(Number(q.purchase_id));
    }
    if (["completed", "cancelled"].includes(q.status)) {
      where.push("r.status = ?");
      params.push(q.status);
    }
    if (SETTLEMENTS.includes(q.settlement)) {
      where.push("r.settlement = ?");
      params.push(q.settlement);
    }
    if (q.open_credit === "1") where.push("r.status = 'completed' AND r.settlement = 'debit_note' AND r.total_amount - r.credit_applied > 0.004");
    if (isIso(q.date_from)) {
      where.push("r.return_date >= ?");
      params.push(`${q.date_from} 00:00:00`);
    }
    if (isIso(q.date_to)) {
      where.push("r.return_date <= ?");
      params.push(`${q.date_to} 23:59:59`);
    }
    if (has(q, "search")) {
      const like = `%${String(q.search).trim()}%`;
      where.push(`(r.return_number LIKE ? OR s.supplier_name LIKE ? OR po.purchase_number LIKE ? OR po.invoice_number LIKE ?
                   OR EXISTS (SELECT 1 FROM pharmacy_return_items ri
                                JOIN pharmacy_medicine_batches b ON b.id = ri.batch_id
                                JOIN pharmacy_medicines pm ON pm.id = ri.medicine_id
                                LEFT JOIN medicine_data md ON md.id = pm.medicine_data_id
                               WHERE ri.return_id = r.id
                                 AND (b.batch_number LIKE ? OR md.medicine_name LIKE ? OR md.brand_name LIKE ?)))`);
      params.push(like, like, like, like, like, like, like);
    }
    const whereSql = where.join(" AND ");
    const from = `FROM pharmacy_returns r
                  LEFT JOIN pharmacy_suppliers s ON s.id = r.supplier_id AND s.admin_id = r.admin_id
                  LEFT JOIN pharmacy_purchase_orders po ON po.id = r.purchase_id AND po.admin_id = r.admin_id`;
    const [[sum]] = await db.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN r.status = 'completed' THEN r.total_amount END), 0) AS value,
              COALESCE(SUM(CASE WHEN r.status = 'completed' AND r.settlement = 'debit_note'
                                THEN r.total_amount - r.credit_applied END), 0) AS open_credit
         ${from} WHERE ${whereSql}`,
      params
    );
    const [rows] = await db.query(
      `SELECT r.id, r.return_number, r.return_date, r.status, r.branch, r.reason, r.settlement,
              r.total_amount, r.credit_applied, r.refund_amount, r.refund_method,
              r.supplier_id, s.supplier_name, r.purchase_id, po.purchase_number, po.invoice_number,
              (SELECT COUNT(*) FROM pharmacy_return_items ri WHERE ri.return_id = r.id) AS lines_count,
              (SELECT SUM(COALESCE(ri.tablets, ri.quantity)) FROM pharmacy_return_items ri WHERE ri.return_id = r.id) AS tablets
         ${from} WHERE ${whereSql}
        ORDER BY r.return_date DESC, r.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    return res.json({
      success: true,
      data: rows.map((r) => ({
        ...r,
        return_date: toDay(r.return_date),
        total_amount: money(r.total_amount),
        credit_applied: money(r.credit_applied),
        refund_amount: money(r.refund_amount),
        open_credit: r.status === "completed" && r.settlement === "debit_note" ? money(r.total_amount - r.credit_applied) : 0,
        lines_count: Number(r.lines_count) || 0,
        tablets: Number(r.tablets) || 0,
      })),
      summary: { total: Number(sum.total), value: money(sum.value), open_credit: money(sum.open_credit) },
      pagination: { page, limit, total: Number(sum.total), total_pages: Math.max(1, Math.ceil(Number(sum.total) / limit)) },
      branch: scope.branch || null,
      multi_branch: !!scope.multi,
    });
  } catch (err) {
    return sendError(res, err, "List purchase returns error:", "Failed to load purchase returns");
  }
});

/* one */
router.get("/get/return/:id", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    await requireSchema(db);
    const data = await fetchReturn(db, getTenantAdminId(req), parseId(req.params.id, "return"));
    if (!data) return res.status(404).json({ success: false, message: "Return not found" });
    return res.json({ success: true, data });
  } catch (err) {
    return sendError(res, err, "Get purchase return error:", "Failed to load the return");
  }
});

/* suppliers — with what you owe them and their open credit */
router.get("/getall/suppliers", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    await requireSchema(db);
    const adminId = getTenantAdminId(req);
    const [rows] = await db.query(
      `SELECT s.id, s.supplier_name, s.phone, s.gst_number, s.status,
              COALESCE((SELECT SUM(po.grand_total - po.paid_amount) FROM pharmacy_purchase_orders po
                         WHERE po.admin_id = s.admin_id AND po.supplier_id = s.id AND po.status IN ('ordered', 'received')
                           AND po.grand_total - po.paid_amount > 0), 0) AS due,
              COALESCE((SELECT SUM(r.total_amount - r.credit_applied) FROM pharmacy_returns r
                         WHERE r.admin_id = s.admin_id AND r.supplier_id = s.id AND r.return_type = 'supplier_return'
                           AND r.status = 'completed' AND r.settlement = 'debit_note'), 0) AS open_credit
         FROM pharmacy_suppliers s
        WHERE s.admin_id = ?
        ORDER BY s.status = 'active' DESC, s.supplier_name ASC`,
      [adminId]
    );
    return res.json({
      success: true,
      data: rows.map((s) => ({ ...s, due: money(s.due), open_credit: money(s.open_credit) })),
    });
  } catch (err) {
    return sendError(res, err, "Return suppliers error:", "Failed to load suppliers");
  }
});

/* received orders to return against (newest first) — the "Against an order" picker */
router.get("/getall/orders", authMiddleware, allowPermissions(PERM.create), async (req, res) => {
  try {
    await requireSchema(db);
    const adminId = getTenantAdminId(req);
    const q = req.query;
    const where = ["po.admin_id = ?", "po.status = 'received'", "po.supplier_id IS NOT NULL"];
    const params = [adminId];
    const scope = await resolveScope(db, req, { wanted: q.branch, forWrite: false });
    if (scope.filter) {
      where.push("(po.branch IS NULL OR TRIM(po.branch) = '' OR LOWER(TRIM(po.branch)) = ?)");
      params.push(scope.key);
    }
    if (has(q, "supplier_id")) {
      where.push("po.supplier_id = ?");
      params.push(Number(q.supplier_id));
    }
    if (has(q, "search")) {
      const like = `%${String(q.search).trim()}%`;
      where.push("(po.purchase_number LIKE ? OR po.invoice_number LIKE ? OR s.supplier_name LIKE ?)");
      params.push(like, like, like);
    }
    const [rows] = await db.query(
      `SELECT po.id, po.purchase_number, po.invoice_number, po.purchase_date, po.grand_total, po.paid_amount,
              po.supplier_id, s.supplier_name, po.branch,
              (SELECT COUNT(*) FROM pharmacy_purchase_items pi WHERE pi.purchase_id = po.id) AS lines_count,
              (SELECT COALESCE(SUM(r.total_amount), 0) FROM pharmacy_returns r
                WHERE r.admin_id = po.admin_id AND r.purchase_id = po.id AND r.status = 'completed') AS returned_value
         FROM pharmacy_purchase_orders po
         LEFT JOIN pharmacy_suppliers s ON s.id = po.supplier_id AND s.admin_id = po.admin_id
        WHERE ${where.join(" AND ")}
        ORDER BY po.purchase_date DESC, po.id DESC
        LIMIT 50`,
      params
    );
    return res.json({
      success: true,
      data: rows.map((o) => ({
        ...o,
        purchase_date: toDay(o.purchase_date),
        grand_total: money(o.grand_total),
        due: money(Number(o.grand_total) - Number(o.paid_amount)),
        returned_value: money(o.returned_value),
        lines_count: Number(o.lines_count) || 0,
      })),
    });
  } catch (err) {
    return sendError(res, err, "Return orders error:", "Failed to load received orders");
  }
});

/* what can go back */
router.get("/get/returnable", authMiddleware, allowPermissions(PERM.create), async (req, res) => {
  try {
    await requireSchema(db);
    const adminId = getTenantAdminId(req);
    const q = req.query;
    const today = istToday();
    const scope = await resolveScope(db, req, { wanted: q.branch, forWrite: true });
    const bf = batchFilter(scope, "b");

    if (has(q, "purchase_id")) {
      const id = parseId(q.purchase_id, "purchase order");
      const [orders] = await db.query(
        `SELECT po.*, s.supplier_name FROM pharmacy_purchase_orders po
           LEFT JOIN pharmacy_suppliers s ON s.id = po.supplier_id AND s.admin_id = po.admin_id
          WHERE po.id = ? AND po.admin_id = ? LIMIT 1`,
        [id, adminId]
      );
      if (!orders.length) throw httpError(404, "Purchase order not found");
      const order = orders[0];
      if (order.status !== "received")
        throw httpError(409, `${order.purchase_number} is '${order.status}' — only received orders can be returned.`);
      const [items] = await db.query(
        `SELECT pi.*, po.purchase_number, po.invoice_number FROM pharmacy_purchase_items pi
           JOIN pharmacy_purchase_orders po ON po.id = pi.purchase_id
          WHERE pi.purchase_id = ? ORDER BY pi.id ASC`,
        [id]
      );
      const batchIds = items.map((it) => Number(it.batch_id)).filter(Boolean);
      const [bRows] = batchIds.length
        ? await db.query(
            `SELECT b.*, ${MED_COLS} FROM pharmacy_medicine_batches b ${MED_JOIN}
              WHERE b.admin_id = ? AND b.id IN (?) ${bf.sql}`,
            [adminId, batchIds, ...bf.params]
          )
        : [[]];
      const byId = new Map(bRows.map((b) => [Number(b.id), b]));
      const returned = await returnedFromLines(db, adminId, items.map((it) => Number(it.id)));
      const lines = [];
      const elsewhere = [];
      for (const it of items) {
        const b = byId.get(Number(it.batch_id));
        if (!b) {
          if (it.batch_id) elsewhere.push(it.batch_number);
          continue;
        }
        lines.push(describeLine(b, it, returned.get(Number(it.id)), today));
      }
      return res.json({
        success: true,
        data: {
          mode: "order",
          purchase_id: Number(order.id),
          purchase_number: order.purchase_number,
          invoice_number: order.invoice_number || null,
          purchase_date: toDay(order.purchase_date),
          supplier: { id: Number(order.supplier_id), supplier_name: order.supplier_name },
          branch: scope.branch || null,
          lines,
          not_in_branch: elsewhere,
        },
      });
    }

    if (!has(q, "supplier_id")) throw httpError(400, "Choose the supplier or the purchase order.");
    const supplier = await verifySupplier(db, adminId, parseId(q.supplier_id, "supplier"));
    const params = [adminId, supplier.id, supplier.id, adminId, ...bf.params];
    let search = "";
    if (has(q, "search")) {
      const like = `%${String(q.search).trim()}%`;
      search = ` AND (b.batch_number LIKE ? OR md.medicine_name LIKE ? OR md.brand_name LIKE ? OR pm.medicine_code LIKE ?)`;
      params.push(like, like, like, like);
    }
    if (q.expiring === "1") {
      search += " AND b.expiry_date <= DATE_ADD(?, INTERVAL ? DAY)";
      params.push(today, NEAR_EXPIRY_DAYS);
    }
    // this supplier's batches: stamped with the supplier, or received on one of their orders
    const [bRows] = await db.query(
      `SELECT b.*, ${MED_COLS}
         FROM pharmacy_medicine_batches b ${MED_JOIN}
        WHERE b.admin_id = ? AND b.quantity_available > 0
          AND (b.supplier_id = ?
               OR b.id IN (SELECT pi.batch_id FROM pharmacy_purchase_items pi
                             JOIN pharmacy_purchase_orders po ON po.id = pi.purchase_id
                            WHERE po.supplier_id = ? AND po.admin_id = ? AND po.status = 'received' AND pi.batch_id IS NOT NULL))
          ${bf.sql}${search}
        ORDER BY b.expiry_date ASC, b.id ASC
        LIMIT 300`,
      params
    );
    const ids = bRows.map((b) => Number(b.id));
    const [piRows] = ids.length
      ? await db.query(
          `SELECT pi.*, po.purchase_number, po.invoice_number FROM pharmacy_purchase_items pi
             JOIN pharmacy_purchase_orders po ON po.id = pi.purchase_id
            WHERE po.admin_id = ? AND po.status = 'received' AND po.supplier_id = ? AND pi.batch_id IN (?)
            ORDER BY pi.id DESC`,
          [adminId, supplier.id, ids]
        )
      : [[]];
    const returned = await returnedFromLines(db, adminId, piRows.map((p) => Number(p.id)));
    const lines = bRows.map((b) => {
      const pi = piRows.find((p) => Number(p.batch_id) === Number(b.id)) || null; // the latest delivery of it
      return describeLine(b, pi, pi ? returned.get(Number(pi.id)) : null, today);
    });
    return res.json({
      success: true,
      data: {
        mode: "supplier",
        supplier: { id: Number(supplier.id), supplier_name: supplier.supplier_name },
        branch: scope.branch || null,
        lines,
      },
    });
  } catch (err) {
    return sendError(res, err, "Returnable lines error:", "Failed to load what can be returned");
  }
});

/* check — writes nothing */
router.post("/preview/return", authMiddleware, allowPermissions(PERM.create), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await requireSchema(conn);
    const r = await resolveReturn(conn, req, req.body || {}, false);
    return res.json({ success: true, data: previewOut(r) });
  } catch (err) {
    return sendError(res, err, "Preview purchase return error:", "Failed to check the return");
  } finally {
    conn.release();
  }
});

/* return the stock */
router.post("/post/return", authMiddleware, allowPermissions(PERM.create), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await requireSchema(conn);
    await conn.beginTransaction();
    const r = await resolveReturn(conn, req, req.body || {}, true);
    if (r.problems.length) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: r.problems[0], data: previewOut(r) });
    }
    const userId = req.user.id;
    const returnNumber = await nextReturnNumber(conn, r.adminId, r.returnDate);
    const when = r.returnDate === istToday() ? istNow() : `${r.returnDate} 12:00:00`;
    const reasons = [...new Set(r.lines.map((l) => l.reason_label).filter(Boolean))].join(", ");
    const isRefund = r.settlement === "refund";

    const [ins] = await conn.query(
      `INSERT INTO pharmacy_returns
         (admin_id, return_number, sale_id, patient_id, supplier_id, purchase_id, branch, return_date, return_type,
          reason, total_amount, refund_amount, settlement, credit_applied, refund_method, refund_reference,
          status, processed_by, notes)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, 'supplier_return', ?, ?, ?, ?, 0, ?, ?, 'completed', ?, ?)`,
      [
        r.adminId, returnNumber, r.supplier.id, r.order ? r.order.id : null, r.scope.branch || null, when,
        reasons.slice(0, 255) || null, r.totals.total_amount, isRefund ? r.totals.total_amount : 0, r.settlement,
        isRefund ? r.refundMethod : null, isRefund ? r.refundReference : null, userId, r.notes,
      ]
    );
    const returnId = ins.insertId;

    for (const l of r.lines) {
      await conn.query(
        `INSERT INTO pharmacy_return_items
           (return_id, medicine_id, batch_id, sale_item_id, purchase_item_id, quantity, sale_unit, units_per_pack, tablets,
            unit_price, gst_percentage, tax_amount, reason, total_amount)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          returnId, l.medicine_id, l.batch_id, l._pi ? l._pi.id : null, l.quantity, l.unit, l.units_per_pack, l.tablets,
          l.unit_price, l.gst_percentage, l.tax_amount, l.reason, l.total_amount,
        ]
      );
      // the stock leaves the batch — and the ledger says so (409 if someone sold it meanwhile)
      await recordMove(conn, {
        adminId: r.adminId,
        userId,
        batchId: l.batch_id,
        tabletsOut: l.tablets,
        type: "purchase_return",
        referenceId: returnId,
        referenceNumber: returnNumber,
        notes: `Returned to ${r.supplier.supplier_name} — ${l.reason_label}${l._pi ? ` (${l._pi.purchase_number})` : ""}`,
        date: when,
      });
    }

    if (!isRefund && r.setOff.plan.length) {
      await writeSetOffs(conn, {
        adminId: r.adminId,
        userId,
        plan: r.setOff.plan,
        returnNumber,
        note: `Debit note ${returnNumber} — stock returned to ${r.supplier.supplier_name}`,
      });
      await conn.query(`UPDATE pharmacy_returns SET credit_applied = ? WHERE id = ?`, [r.setOff.applied, returnId]);
    }

    await conn.commit();
    // saved — from here on nothing may turn this into an error (the screen would offer to save it again)
    let data;
    try {
      data = await fetchReturn(db, r.adminId, returnId);
    } catch (e) {
      console.error("Purchase return saved, but reading it back failed:", e);
    }
    if (!data)
      return res.status(201).json({
        success: true,
        message: `${returnNumber} saved — ₹${inr(r.totals.total_amount)}. Open it from Purchase Returns.`,
        data: { id: returnId, return_number: returnNumber, total_amount: r.totals.total_amount, lines: [], set_offs: [] },
      });
    const strips = data.lines.map((l) => l.tablets_text).join(", ");
    return res.status(201).json({
      success: true,
      message:
        `${returnNumber}: ${strips} returned to ${r.supplier.supplier_name} — ₹${inr(data.total_amount)}` +
        (isRefund
          ? ` refund (${REFUND_METHODS[r.refundMethod]})`
          : data.credit_applied > 0
            ? ` debit note, ₹${inr(data.credit_applied)} set off${data.open_credit > 0 ? `, ₹${inr(data.open_credit)} open credit` : ""}`
            : " open credit"),
      data,
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err && err.code === "ER_DUP_ENTRY")
      return res.status(409).json({ success: false, message: "Someone saved a return at the same moment — please try again." });
    return sendError(res, err, "Post purchase return error:", "Failed to return the stock");
  } finally {
    conn.release();
  }
});

/* set open credit off against unpaid orders */
router.post("/apply/credit/:id", authMiddleware, allowPermissions(PERM.create), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await requireSchema(conn);
    const adminId = getTenantAdminId(req);
    const id = parseId(req.params.id, "return");
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT * FROM pharmacy_returns WHERE id = ? AND admin_id = ? AND return_type = 'supplier_return' LIMIT 1 FOR UPDATE`,
      [id, adminId]
    );
    if (!rows.length) throw httpError(404, "Return not found");
    const r = rows[0];
    if (r.status !== "completed") throw httpError(409, `${r.return_number} is cancelled.`);
    if (r.settlement !== "debit_note") throw httpError(409, `${r.return_number} was settled as a refund.`);
    const open = money(Number(r.total_amount) - Number(r.credit_applied));
    if (open <= 0.004) throw httpError(409, `${r.return_number} has no open credit left.`);
    const orders = await unpaidOrders(conn, adminId, r.supplier_id, [], true);
    const setOff = planSetOff(orders, open);
    if (!setOff.plan.length) throw httpError(409, "Nothing is owed to this supplier right now — the credit stays open.");
    const [[s]] = await conn.query(`SELECT supplier_name FROM pharmacy_suppliers WHERE id = ? AND admin_id = ?`, [r.supplier_id, adminId]);
    await writeSetOffs(conn, {
      adminId,
      userId: req.user.id,
      plan: setOff.plan,
      returnNumber: r.return_number,
      note: `Debit note ${r.return_number} — open credit set off${s ? ` (${s.supplier_name})` : ""}`,
    });
    await conn.query(`UPDATE pharmacy_returns SET credit_applied = credit_applied + ? WHERE id = ?`, [setOff.applied, id]);
    await conn.commit();
    const data = await fetchReturn(db, adminId, id);
    return res.json({
      success: true,
      message: `₹${inr(setOff.applied)} set off against ${setOff.plan.map((p) => p.purchase_number).join(", ")}${data.open_credit > 0 ? ` — ₹${inr(data.open_credit)} still open` : ""}`,
      data,
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    return sendError(res, err, "Apply credit error:", "Failed to apply the credit");
  } finally {
    conn.release();
  }
});

/* undo a return: stock back, set-offs taken back off the orders */
router.patch("/cancel/return/:id", authMiddleware, allowPermissions(PERM.edit), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await requireSchema(conn);
    const adminId = getTenantAdminId(req);
    const id = parseId(req.params.id, "return");
    const why = cleanText(req.body && req.body.reason, 500);
    if (!why) throw httpError(400, "Say why the return is being cancelled.");
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT * FROM pharmacy_returns WHERE id = ? AND admin_id = ? AND return_type = 'supplier_return' LIMIT 1 FOR UPDATE`,
      [id, adminId]
    );
    if (!rows.length) throw httpError(404, "Return not found");
    const r = rows[0];
    if (r.status !== "completed") throw httpError(409, `${r.return_number} is already ${r.status}.`);

    // staff of one branch can only undo that branch's returns
    const scope = await resolveScope(conn, req, { forWrite: false });
    if (scope.filter && r.branch && String(r.branch).trim().toLowerCase() !== scope.key)
      throw httpError(403, `${r.return_number} was returned from the ${r.branch} branch.`);

    // the set-offs come back off the orders (orders locked first, like the payments route)
    const [pays] = await conn.query(
      `SELECT id, purchase_id, amount FROM pharmacy_payments
        WHERE admin_id = ? AND payment_method = 'debit_note' AND transaction_reference = ?`,
      [adminId, r.return_number]
    );
    for (const p of pays) {
      const [[po]] = await conn.query(
        `SELECT id, purchase_number, grand_total, paid_amount FROM pharmacy_purchase_orders WHERE id = ? AND admin_id = ? FOR UPDATE`,
        [p.purchase_id, adminId]
      );
      if (!po) continue;
      const newPaid = money(Number(po.paid_amount) - Number(p.amount));
      if (newPaid < -0.004) throw httpError(409, `${po.purchase_number} has less paid on it than this debit note — check its payments first.`);
      const newDue = Math.max(0, money(Number(po.grand_total) - newPaid));
      const status = newDue <= 0.001 ? "paid" : newPaid > 0 ? "partial" : "unpaid";
      await conn.query(
        `UPDATE pharmacy_purchase_orders SET paid_amount = ?, due_amount = ?, payment_status = ? WHERE id = ? AND admin_id = ?`,
        [Math.max(0, newPaid), newDue, status, po.id, adminId]
      );
      await conn.query(`DELETE FROM pharmacy_payments WHERE id = ? AND admin_id = ?`, [p.id, adminId]);
    }

    // the stock goes back on the shelf
    const [items] = await conn.query(`SELECT * FROM pharmacy_return_items WHERE return_id = ?`, [id]);
    for (const it of items) {
      const tablets = it.tablets != null ? Number(it.tablets) : Number(it.quantity);
      if (tablets > 0)
        await recordMove(conn, {
          adminId,
          userId: req.user.id,
          batchId: it.batch_id,
          tabletsIn: tablets,
          type: "adjustment",
          referenceId: id,
          referenceNumber: r.return_number,
          notes: `Return ${r.return_number} cancelled — stock back on the shelf. ${why}`,
        });
    }

    const stamp = `[${istNow()}] Cancelled: ${why}`;
    await conn.query(
      `UPDATE pharmacy_returns SET status = 'cancelled', credit_applied = 0, notes = CONCAT(COALESCE(notes, ''), IF(notes IS NULL OR notes = '', '', '\n'), ?)
        WHERE id = ?`,
      [stamp, id]
    );
    await conn.commit();
    const data = await fetchReturn(db, adminId, id);
    return res.json({ success: true, message: `${r.return_number} cancelled — the stock is back and the credit was taken back.`, data });
  } catch (err) {
    await conn.rollback().catch(() => {});
    return sendError(res, err, "Cancel purchase return error:", "Failed to cancel the return");
  } finally {
    conn.release();
  }
});

/* ============================================================
   DEBIT NOTE — A4 PDF
============================================================ */
function buildDebitNotePdf(ret, company) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const W = doc.page.width - 80;
    const X = 40;
    const fmt = (d) => {
      if (!d) return "-";
      const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
      return Number.isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    };
    const rs = (n) => `Rs. ${inr(n)}`;

    // header
    doc.font("Helvetica-Bold").fontSize(15).text(company.name || "Pharmacy", X, 40, { width: W * 0.6 });
    doc.font("Helvetica").fontSize(9).fillColor("#333");
    if (company.address) doc.text(company.address, { width: W * 0.6 });
    const contact = [company.phone, company.email].filter(Boolean).join("  |  ");
    if (contact) doc.text(contact, { width: W * 0.6 });
    doc.fillColor("#000").font("Helvetica-Bold").fontSize(16).text(ret.settlement === "refund" ? "PURCHASE RETURN" : "DEBIT NOTE", X, 40, { width: W, align: "right" });
    doc.font("Helvetica").fontSize(9.5)
      .text(`No. ${ret.return_number}`, X, 62, { width: W, align: "right" })
      .text(`Date ${fmt(ret.return_date)}`, { width: W, align: "right" });
    if (ret.status === "cancelled") doc.fillColor("#b00020").font("Helvetica-Bold").text("CANCELLED", { width: W, align: "right" }).fillColor("#000");

    let y = Math.max(doc.y, 100) + 12;
    doc.moveTo(X, y).lineTo(X + W, y).lineWidth(0.8).stroke();
    y += 10;

    // to / against
    const s = ret.supplier || {};
    doc.font("Helvetica-Bold").fontSize(9).text("TO", X, y);
    doc.font("Helvetica-Bold").fontSize(11).text(s.supplier_name || "-", X, y + 12, { width: W * 0.55 });
    doc.font("Helvetica").fontSize(9);
    if (s.address) doc.text(s.address, { width: W * 0.55 });
    if (s.gst_number) doc.text(`GSTIN: ${s.gst_number}`, { width: W * 0.55 });
    if (s.drug_license_number) doc.text(`DL No: ${s.drug_license_number}`, { width: W * 0.55 });
    const leftEnd = doc.y;
    const refs = [...new Set(ret.lines.map((l) => [l.purchase_number, l.invoice_number ? `inv. ${l.invoice_number}` : null].filter(Boolean).join(" / ")).filter(Boolean))];
    doc.font("Helvetica-Bold").fontSize(9).text("AGAINST", X + W * 0.6, y, { width: W * 0.4 });
    doc.font("Helvetica").fontSize(9).text(refs.length ? refs.join("\n") : "Stock from this supplier", X + W * 0.6, y + 12, { width: W * 0.4 });
    if (ret.branch) doc.text(`Branch: ${ret.branch}`, { width: W * 0.4 });
    y = Math.max(leftEnd, doc.y) + 14;

    // table
    const cols = [
      ["#", 18, "left"], ["Item", 138, "left"], ["Batch", 58, "left"], ["Exp.", 36, "left"], ["Qty", 60, "right"],
      ["Rate", 48, "right"], ["Taxable", 54, "right"], ["GST", 44, "right"], ["Amount", W - 456, "right"],
    ];
    const drawHead = () => {
      doc.rect(X, y, W, 18).fill("#f0f0f0").fillColor("#000");
      let cx = X + 4;
      doc.font("Helvetica-Bold").fontSize(8.5);
      for (const [t, w, a] of cols) {
        doc.text(t, cx, y + 5, { width: w - 6, align: a });
        cx += w;
      }
      y += 22;
    };
    drawHead();
    doc.font("Helvetica").fontSize(8.5);
    ret.lines.forEach((l, i) => {
      const name = `${l.medicine}${l.reason_label ? `\n${l.reason_label}` : ""}`;
      const h = Math.max(doc.heightOfString(name, { width: 132 }), 12) + 6;
      if (y + h > doc.page.height - 120) {
        doc.addPage();
        y = 40;
        drawHead();
        doc.font("Helvetica").fontSize(8.5);
      }
      const cells = [
        String(i + 1), name, l.batch_number || "-",
        l.expiry_date ? `${l.expiry_date.slice(5, 7)}/${l.expiry_date.slice(2, 4)}` : "-",
        l.tablets_text, inr(l.rate), inr(l.taxable), `${l.gst_percentage}%\n${inr(l.tax_amount)}`, inr(l.total_amount),
      ];
      let cx = X + 4;
      cols.forEach(([, w, a], k) => {
        doc.text(cells[k], cx, y, { width: w - 6, align: a });
        cx += w;
      });
      y += h;
      doc.moveTo(X, y - 2).lineTo(X + W, y - 2).lineWidth(0.3).strokeColor("#bbb").stroke().strokeColor("#000");
    });

    // totals
    y += 6;
    const tRow = (label, value, bold) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9.5);
      doc.text(label, X + W - 260, y, { width: 150, align: "right" });
      doc.text(value, X + W - 105, y, { width: 105, align: "right" });
      y += bold ? 18 : 14;
    };
    tRow("Taxable value", rs(ret.taxable));
    tRow("GST", rs(ret.tax_amount));
    tRow(ret.settlement === "refund" ? "Refund due" : "Debit note value", rs(ret.total_amount), true);

    // settlement
    y += 8;
    doc.font("Helvetica-Bold").fontSize(9).text("SETTLEMENT", X, y);
    y += 13;
    doc.font("Helvetica").fontSize(9);
    if (ret.status === "cancelled") {
      doc.text("This return was cancelled — the stock was taken back and no credit or refund applies.", X, y, { width: W });
    } else if (ret.settlement === "refund") {
      doc.text(`Refund by ${ret.refund_method_label || "-"}${ret.refund_reference ? `, ref. ${ret.refund_reference}` : ""}.`, X, y, { width: W });
    } else {
      const lines = ret.set_offs.map((p) => `Set off against ${p.purchase_number}${p.invoice_number ? ` (inv. ${p.invoice_number})` : ""}: ${rs(p.amount)}`);
      if (ret.open_credit > 0) lines.push(`Open credit with supplier: ${rs(ret.open_credit)}`);
      if (!lines.length) lines.push("Credit to be adjusted against future bills.");
      doc.text(lines.join("\n"), X, y, { width: W });
    }
    if (ret.notes) {
      doc.moveDown(0.6).font("Helvetica-Bold").text("Notes").font("Helvetica").text(ret.notes, { width: W });
    }

    // signatures
    const sy = doc.page.height - 95;
    doc.moveTo(X, sy).lineTo(X + 170, sy).lineWidth(0.5).stroke();
    doc.moveTo(X + W - 170, sy).lineTo(X + W, sy).stroke();
    doc.font("Helvetica").fontSize(8.5)
      .text("Received by (supplier)", X, sy + 4, { width: 170 })
      .text(`For ${company.name || "the pharmacy"}`, X + W - 170, sy + 4, { width: 170, align: "right" });
    doc.end();
  });
}

router.get("/pdf/return/:id", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    await requireSchema(db);
    const adminId = getTenantAdminId(req);
    const ret = await fetchReturn(db, adminId, parseId(req.params.id, "return"));
    if (!ret) return res.status(404).json({ success: false, message: "Return not found" });
    const [adminRows] = await db.query(`SELECT name, company_name, address, mobile, email FROM admins WHERE id = ? LIMIT 1`, [adminId]);
    const a = adminRows[0] || {};
    const pdf = await buildDebitNotePdf(ret, {
      name: a.company_name || a.name || "",
      address: a.address || "",
      phone: a.mobile || "",
      email: a.email || "",
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${ret.return_number}.pdf"`);
    return res.send(pdf);
  } catch (err) {
    return sendError(res, err, "Debit note PDF error:", "Failed to make the debit note");
  }
});

module.exports = router;