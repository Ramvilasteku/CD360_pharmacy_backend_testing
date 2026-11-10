// routes/pharmacy/pharmacyPurchaseReceive.js
//
// Pharmacy purchase RECEIVING — stock comes in here, nowhere else.
//
//   Upload the distributor's invoice (CSV / Excel)  ─┐
//   or type the lines in by hand                     ├─► PREVIEW (writes nothing)
//                                                    │     every row resolved to:
//                                                    │       po_line      → a line on the PO
//                                                    │       extra        → catalog medicine not on the PO (added)
//                                                    │       new_medicine → not in catalog → created on confirm
//                                                    │       ambiguous    → matches several medicines, pick one
//                                                    │
//   POST /confirm  ◄──────── receive_body ───────────┘
//     creates new medicines, creates / tops up batches, writes the stock
//     ledger, updates catalog prices, locks the PO as 'received'.
//
// Works two ways:
//   against a purchase order  (purchase_id)  — draft or ordered POs
//   direct, no PO             (supplier_id)  — a received PO is created from the invoice
//
// Catalog is two tables:
//   medicine_data        master record — medicine_name, brand_name, strength, dosage_form
//   pharmacy_medicines   per-tenant row — admin_id, medicine_data_id (NOT NULL), prices, code
// A new medicine is written to medicine_data first, then its id goes into
// pharmacy_medicines.medicine_data_id. Names are always read through the join.
//
// Needs:  npm install multer
//         npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
// Mounted in server.js:
//   app.use("/api/pharmacy/purchase-receive", require("./routes/pharmacy/pharmacyPurchaseReceive.js"))

const express = require("express");
const router = express.Router();
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
const {
  parsePackSize, unitsPerPack, cleanUnitsPerPack, tabletsFromStrips, describeStock, plural, packWord,
} = require("../../utils/pharmacyUnits");
const { resolveScope, batchFilter, branchKey } = require("../../utils/pharmacyBranch");
const { recordMove, ledgerRow } = require("../../utils/pharmacyStock");

const FILE_VERSION = "pharmacyPurchaseReceive v2.0 (2026-10-21)";
console.log(`[pharmacy] ${FILE_VERSION} loaded`);
router.use((req, res, next) => {
  res.set("X-PO-Receive-Version", FILE_VERSION);
  next();
});
router.get("/version", (req, res) => res.json({ success: true, file: FILE_VERSION }));

/* ============================================================
   DESIGN NOTES

   Preview and confirm run the SAME function (resolveReceipt) —
   preview with apply=false (plain reads, no writes), confirm with
   apply=true inside one transaction. What you preview is exactly
   what gets written; confirm re-validates everything.

   Row → medicine matching order:
     item_id  →  medicine_id  →  medicine_code  →  barcode  →  name
   Name matching ignores case, spacing, form words (TAB / CAP / SYP…),
   pack tokens (10'S, 1X10) and units ("DOLO 650 TAB" = "Dolo 650mg").
   No match → the row becomes a NEW medicine, created on confirm.

   Batches: same medicine + batch number already in stock → quantity
   is added to that batch (expiry must match). New batch number →
   new batch. Expired stock is rejected; stock expiring within
   NEAR_EXPIRY_DAYS is allowed with a warning.

   PO lines that aren't in the invoice were not supplied → removed
   from the PO on confirm (missing_lines: "remove", default), or
   receiving is blocked (missing_lines: "block").

   Catalog auto-update (update_catalog: true, default): the medicine's
   purchase price, selling price, GST and HSN are refreshed from the
   invoice — only columns pharmacy_medicines actually has. MRP lives on
   the batch, not the catalog, so it is never written back.

   After confirm the PO is 'received' and locked. Corrections =
   purchase return / stock adjustment, never edits.

   STRIPS IN, TABLETS ON THE SHELF (utils/pharmacyUnits.js)
     A line is bought in whole strips (quantity) + free strips
     (free_quantity), priced per strip. Each line carries
     units_per_pack (tablets in one strip):
       typed on the line → the file's pack column ("1x15" → 15)
       → the PO line's snapshot → the medicine's units_per_pack
       → the medicine's pack_size text → 1
     Tablets into stock = (strips + free) × units_per_pack. The batch
     keeps its own units_per_pack; topping up a batch with another
     pack size is refused — it has to be a new batch number.

   BRANCH: stock lands in the PO's deliver-to branch; with no branch
   on the PO, in the receiver's branch (the admin of a multi-branch
   pharmacy picks one). Existing batches are matched in that branch.

   Catalog sync now also covers tablets per strip (+ the pack label
   when it was only a count), manufacturer, and the shelf when the
   medicine has none. Every change is listed in the preview first.
============================================================ */

const PERM = {
  view: "pharmacy.purchase.receive",
  receive: "pharmacy.purchase.receive",
};

const RECEIVABLE_STATUS = ["draft", "ordered"];
const MAX_ROWS = 500;
const NEAR_EXPIRY_DAYS = 90;

// Extra column values for medicines created from an invoice, if your
// pharmacy_medicines table has required columns this file can't know.
// Unknown keys are ignored.
const NEW_MEDICINE_DEFAULTS = {};

// pharmacy_medicines.category_id is required. A medicine created from an
// invoice goes into (in this order):
//   1. new_medicine.category_id on that row          (picked in the review screen)
//   2. default_category_id in the request body
//   3. NEW_MEDICINE_DEFAULTS.category_id
//   4. the tenant's "Uncategorized" / "General" / "Others" category —
//      "Uncategorized" is created automatically if none exists.
const FALLBACK_CATEGORY_NAME = "Uncategorized";
const FALLBACK_CATEGORY_MATCHES = ["uncategorized", "uncategorised", "general", "others", "other", "miscellaneous", "misc"];

// Names live on medicine_data; every read of pharmacy_medicines that needs a
// name joins through medicine_data_id.
const CATALOG_JOIN = `LEFT JOIN medicine_data md ON md.id = pm.medicine_data_id`;
const CATALOG_NAME_COLS = `md.medicine_name, md.brand_name, md.strength, md.dosage_form`;

/* ============================================================
   Small helpers
============================================================ */

function httpError(status, message, details) {
  const e = new Error(message);
  e.status = status;
  if (details) e.details = details;
  return e;
}

function sendError(res, err, label, fallback) {
  if (err.status) {
    return res.status(err.status).json({
      success: false,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  if (err.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      success: false,
      message: "Duplicate entry — someone saved the same record at the same moment. Preview again and retry.",
      details: { db_error: err.sqlMessage },
    });
  }
  if (["ER_BAD_FIELD_ERROR", "ER_BAD_NULL_ERROR", "ER_NO_DEFAULT_FOR_FIELD", "WARN_DATA_TRUNCATED"].includes(err.code)) {
    console.error(label, err);
    return res.status(500).json({
      success: false,
      message: "The database rejected a value — a column in the query doesn't match the schema.",
      details: { db_error: err.sqlMessage || err.message },
    });
  }
  console.error(label, err);
  return res.status(500).json({ success: false, message: fallback });
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad = (n, w = 2) => String(n).padStart(w, "0");
const has = (o, k) =>
  o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== "" && o[k] !== null && o[k] !== undefined;

function pick(row, keys) {
  if (!row) return null;
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

function computePaymentFields(grandTotal, paidAmount) {
  const gt = money(grandTotal);
  const pa = money(paidAmount);
  const due = Math.max(0, money(gt - pa));
  let payment_status;
  if (pa <= 0) payment_status = "unpaid";
  else if (pa >= gt) payment_status = "paid";
  else payment_status = "partial";
  return { due_amount: due, payment_status };
}

function buildDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function toDate(v) {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? buildDate(+m[1], +m[2], +m[3]) : null;
}

const todayDate = () => toDate(new Date());
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return toDate(new Date(y, m - 1, d + days));
}

function medicineLabel(row) {
  const name = [row.brand_name || row.medicine_name, row.strength].filter(Boolean).join(" ");
  return name || `Medicine #${row.medicine_id || row.id}`;
}

function parseId(value, what) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, `Invalid ${what} id`);
  return id;
}

async function verifySupplier(conn, adminId, supplierId) {
  const id = Number(supplierId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Select a supplier (supplier_id is required for a direct receipt)");
  const [rows] = await conn.query(
    `SELECT id, supplier_name, status FROM pharmacy_suppliers WHERE id = ? AND admin_id = ? LIMIT 1`,
    [id, adminId]
  );
  if (!rows.length) throw httpError(400, `Supplier ${id} not found. Add the supplier first.`);
  if (rows[0].status !== "active") throw httpError(400, `Supplier ${rows[0].supplier_name} is inactive`);
  return rows[0];
}

/* ============================================================
   Schema-aware writes
   Reads the real columns once per table so new medicines and
   catalog updates only touch columns your schema actually has.
============================================================ */
const columnCache = new Map();

async function tableColumns(conn, table) {
  if (columnCache.has(table)) return columnCache.get(table);
  const [rows] = await conn.query("SHOW COLUMNS FROM ??", [table]);
  const map = new Map(rows.map((r) => [r.Field, r]));
  columnCache.set(table, map);
  return map;
}

function statusValueFor(col) {
  if (!col) return undefined;
  const t = String(col.Type).toLowerCase();
  if (t.startsWith("enum")) return t.includes("'active'") ? "active" : undefined;
  if (/int|bool|bit/.test(t)) return 1;
  return "active";
}

function knownValues(cols, values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) if (cols.has(k) && v !== undefined) out[k] = v;
  return out;
}

function missingRequired(cols, data) {
  return [...cols.values()]
    .filter(
      (c) =>
        c.Null === "NO" &&
        c.Default === null &&
        !/auto_increment|DEFAULT_GENERATED|VIRTUAL|STORED/i.test(c.Extra || "") &&
        !(c.Field in data)
    )
    .map((c) => c.Field);
}

async function insertKnown(conn, table, values, what) {
  const cols = await tableColumns(conn, table);
  const data = knownValues(cols, values);
  const missing = missingRequired(cols, data);
  if (missing.length)
    throw httpError(
      400,
      `Can't create ${what}: ${table} needs ${missing.join(", ")}. Add them to NEW_MEDICINE_DEFAULTS in pharmacyPurchaseReceive.js.`
    );
  const [ins] = await conn.query("INSERT INTO ?? SET ?", [table, data]);
  return ins.insertId;
}

/* ============================================================
   Medicine name matching
============================================================ */
const FORM_WORDS = {
  tab: "Tablet", tabs: "Tablet", tablet: "Tablet", tablets: "Tablet",
  cap: "Capsule", caps: "Capsule", capsule: "Capsule", capsules: "Capsule",
  syp: "Syrup", syr: "Syrup", syrup: "Syrup",
  susp: "Suspension", suspension: "Suspension",
  inj: "Injection", injection: "Injection", vial: "Injection", amp: "Injection",
  oint: "Ointment", ointment: "Ointment",
  crm: "Cream", cream: "Cream", gel: "Gel", lotion: "Lotion",
  drop: "Drops", drops: "Drops",
  pwd: "Powder", powder: "Powder", sachet: "Sachet",
  spray: "Spray", soln: "Solution", solution: "Solution",
  inhaler: "Inhaler", rotacap: "Rotacap", rotacaps: "Rotacap", respules: "Respules",
};
const UNIT_RE = /^(\d+(?:\.\d+)?)(mg|mcg|g|gm|gms|ml|iu|%|kg|l)$/;
const UNIT_WORDS = new Set(["mg", "mcg", "g", "gm", "gms", "ml", "iu", "kg", "l"]);
const PACK_RE = /^(\d+'?s|\d+x\d+|\d+n|\d+nos)$/;
const FILLER = new Set(["strip", "strips", "pack", "nos", "pcs", "bottle", "box", "of", "the", "and", "with"]);

function nameTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/(\d)\s+(mg|mcg|gm|gms|ml|iu|kg)\b/g, "$1$2") // "650 mg" → "650mg"
    .replace(/[^a-z0-9.%'x]+/g, " ")
    .split(" ")
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

// Order-insensitive key: "DOLO 650 TAB 15'S" and "Dolo 650mg" → "650 dolo"
function nameKey(...parts) {
  const out = [];
  for (const t of nameTokens(parts.filter(Boolean).join(" "))) {
    if (FORM_WORDS[t] || PACK_RE.test(t) || FILLER.has(t) || UNIT_WORDS.has(t)) continue;
    const u = t.match(UNIT_RE);
    out.push(u ? String(Number(u[1])) : t.replace(/'/g, ""));
  }
  return [...new Set(out)].sort().join(" ");
}

const titleCase = (s) => s.replace(/\b([a-z])([a-z]*)/g, (_, a, b) => a.toUpperCase() + b);

// "AUGMENTIN 625 DUO TAB 10'S" → { brand_name: "Augmentin Duo", strength: "625", dosage_form: "Tablet" }
function parseNameParts(name) {
  let dosage_form = null;
  let strength = null;
  const words = [];
  for (const raw of String(name || "").trim().split(/\s+/)) {
    const t = raw.toLowerCase().replace(/[^a-z0-9.%'x]/g, "");
    if (!t) continue;
    if (!dosage_form && FORM_WORDS[t]) {
      dosage_form = FORM_WORDS[t];
      continue;
    }
    if (PACK_RE.test(t) || FILLER.has(t)) continue;
    if (!strength && (UNIT_RE.test(t) || /^\d+(\.\d+)?$/.test(t))) {
      strength = raw.replace(/[^A-Za-z0-9.%]/g, "");
      continue;
    }
    if (strength && UNIT_WORDS.has(t) && /^\d/.test(strength)) {
      strength += t;
      continue;
    }
    words.push(raw.replace(/[^A-Za-z0-9.&+\-/]/g, ""));
  }
  const brand = titleCase(words.filter(Boolean).join(" ").toLowerCase());
  return { brand_name: brand || null, strength, dosage_form };
}

const normCode = (v) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");

function buildCatalogIndex(meds) {
  const byId = new Map();
  const byCode = new Map();
  const byBarcode = new Map();
  const byKey = new Map();
  const addTo = (map, k, m) => {
    if (!k) return;
    if (!map.has(k)) map.set(k, []);
    if (!map.get(k).includes(m)) map.get(k).push(m);
  };
  for (const m of meds) {
    byId.set(Number(m.id), m);
    addTo(byCode, normCode(m.medicine_code), m);
    addTo(byBarcode, normCode(m.barcode), m);
    addTo(byKey, nameKey(m.brand_name || m.medicine_name, m.strength), m);
    if (m.brand_name && m.medicine_name) addTo(byKey, nameKey(m.medicine_name, m.strength), m);
  }
  return { byId, byCode, byBarcode, byKey, all: meds };
}

// Catalog medicines that share the first word of the name — shown as "did you mean"
function similarMedicines(index, name, limit = 5) {
  const first = nameTokens(name).find((t) => /[a-z]{3,}/.test(t) && !FORM_WORDS[t]);
  if (!first) return [];
  return index.all
    .filter((m) => nameTokens(`${m.brand_name || ""} ${m.medicine_name || ""}`).some((t) => t.startsWith(first.slice(0, 4))))
    .slice(0, limit);
}

const brief = (m) => ({ medicine_id: Number(m.id), medicine: medicineLabel(m), medicine_code: m.medicine_code || null });

/* ============================================================
   Line validation + pricing (receipt — batch + expiry required)
============================================================ */
function priceLine(raw, p, today, upp = 1) {
  const batch_number = String(raw.batch_number == null ? "" : raw.batch_number).trim();
  if (!batch_number) throw httpError(400, `${p}: batch number is required`);
  if (batch_number.length > 100) throw httpError(400, `${p}: batch number is too long (max 100)`);

  const expiry_date = toDate(raw.expiry_date);
  if (!expiry_date) throw httpError(400, `${p}: expiry date is required (YYYY-MM-DD)`);
  if (expiry_date <= today) throw httpError(400, `${p}: expiry ${expiry_date} has already passed — expired stock can't be received`);

  let manufacturing_date = null;
  if (has(raw, "manufacturing_date")) {
    manufacturing_date = toDate(raw.manufacturing_date);
    if (!manufacturing_date) throw httpError(400, `${p}: manufacturing date must be YYYY-MM-DD`);
    if (manufacturing_date > today) throw httpError(400, `${p}: manufacturing date can't be in the future`);
    if (manufacturing_date >= expiry_date) throw httpError(400, `${p}: manufacturing date must be before expiry`);
  }

  const quantity = Number(raw.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw httpError(400, `${p}: quantity must be a whole number above 0`);
  const free_quantity = has(raw, "free_quantity") ? Number(raw.free_quantity) : 0;
  if (!Number.isInteger(free_quantity) || free_quantity < 0) throw httpError(400, `${p}: free quantity must be a whole number`);

  const amount = (k, label) => {
    const v = has(raw, k) ? Number(raw[k]) : 0;
    if (!Number.isFinite(v) || v < 0) throw httpError(400, `${p}: ${label} must be a number, 0 or more`);
    return money(v);
  };
  const purchase_price = amount("purchase_price", "rate");
  const mrp = amount("mrp", "MRP");
  const selling_price = amount("selling_price", "selling price");
  // trade discount (₹, or worked out from a %) + the scheme amount (₹) on top of it
  const trade_discount = amount("discount_amount", "discount");
  const scheme_amount = amount("scheme_amount", "scheme amount");
  const discount_amount = money(trade_discount + scheme_amount);

  const gst_percentage = has(raw, "gst_percentage") ? Number(raw.gst_percentage) : 0;
  if (!Number.isFinite(gst_percentage) || gst_percentage < 0 || gst_percentage > 100)
    throw httpError(400, `${p}: GST must be between 0 and 100`);
  if (mrp > 0 && selling_price > mrp)
    throw httpError(400, `${p}: selling price ₹${selling_price} per strip is more than the MRP ₹${mrp} — it can be at most the MRP`);
  if (mrp > 0 && purchase_price > mrp) throw httpError(400, `${p}: rate ${purchase_price} is more than MRP ${mrp} — check the columns`);

  const units_per_pack = Math.max(1, Math.floor(Number(upp) || 1));
  // the line is worth the strips paid for; free strips cost nothing
  const gross = money(quantity * purchase_price);
  if (discount_amount > gross)
    throw httpError(400, `${p}: discount ${discount_amount}${scheme_amount ? ` (incl. scheme ₹${scheme_amount})` : ""} is more than the line value ${gross}`);
  const taxable = money(gross - discount_amount);
  // D.Price: the rate per strip after the trade discount; its % of the rate
  const discount_percent = gross > 0 ? Math.round((trade_discount / gross) * 10000) / 100 : 0;
  const d_price = quantity > 0 ? Math.round(((gross - trade_discount) / quantity) * 100) / 100 : purchase_price;
  const tax_amount = money((taxable * gst_percentage) / 100);
  const total_amount = money(taxable + tax_amount);
  const tablets_in = tabletsFromStrips(quantity, free_quantity, units_per_pack);

  return {
    batch_number, manufacturing_date, expiry_date, quantity, free_quantity, units_per_pack,
    strips_in: quantity + free_quantity,
    tablets_in,
    units_in: tablets_in, // tablets — what goes on the shelf
    purchase_price, mrp, selling_price,
    discount_amount, trade_discount, scheme_amount, discount_percent, d_price,
    gst_percentage, gross, taxable, tax_amount, total_amount,
  };
}

/** "10 strips (+1 free) = 110 tablets into stock", "3 bottles into stock" */
function receiptText(L, word = "strip") {
  const upp = L.units_per_pack || 1;
  const w = upp > 1 ? word : word === "strip" ? "pack" : word;
  const head = `${L.quantity} ${plural(w, L.quantity)}${L.free_quantity ? ` (+${L.free_quantity} free)` : ""}`;
  if (upp <= 1) return `${head} into stock`;
  return `${head} = ${L.tablets_in} ${plural("tablet", L.tablets_in)} into stock`;
}

/* What a pack is sold as — pharmacy_medicines.unit ("strip", "bottle", "tube"…). The same words as the
   Medicines screen; anything else typed is kept as it is (lower case). A word that is really the
   loose item ("tablet", "nos") is not a pack, so it is ignored. */
const PACK_UNIT_ALIASES = {
  strip: "strip", strips: "strip", str: "strip", stp: "strip", blister: "strip",
  bottle: "bottle", bottles: "bottle", btl: "bottle", bot: "bottle",
  tube: "tube", tubes: "tube",
  vial: "vial", vials: "vial",
  sachet: "sachet", sachets: "sachet", sach: "sachet",
  box: "box", boxes: "box",
  pack: "pack", packs: "pack", pkt: "pack", packet: "pack",
  jar: "jar", jars: "jar",
};
const LOOSE_UNIT = /^(tablets?|tabs?|capsules?|caps?|pcs|pieces?|nos|no|units?|n)$/i;
function cleanPackUnit(v) {
  const t = String(v == null ? "" : v).trim().toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  if (!t || LOOSE_UNIT.test(t)) return null;
  return PACK_UNIT_ALIASES[t] || t.slice(0, 30);
}

/** The pack label to store with a new tablets-per-strip: keep a custom label ("100 ml", "1 pack"),
    replace one that was only a count ("10", "10 tablets", "10'S", "1x10") or empty. */
function packLabelFor(oldLabel, upp) {
  const old = String(oldLabel == null ? "" : oldLabel).trim();
  if (old && parsePackSize(old) == null) return old;
  return upp > 1 ? `${upp} tablets` : old || null;
}

function computeHeader(lines, discountAmount, otherCharges) {
  const discount_amount = money(discountAmount);
  const other_charges = money(otherCharges);
  const subtotal = money(lines.reduce((s, l) => s + l.gross, 0));
  const tax_amount = money(lines.reduce((s, l) => s + l.tax_amount, 0));
  const linesTotal = money(lines.reduce((s, l) => s + l.total_amount, 0));
  const grand_total = money(linesTotal - discount_amount + other_charges);
  return { subtotal, discount_amount, tax_amount, other_charges, grand_total, lines_total: linesTotal };
}

async function nextPurchaseNumber(conn, adminId, dateStr) {
  const prefix = `PO-${String(dateStr).slice(0, 4)}-`;
  const [rows] = await conn.query(
    `SELECT MAX(CAST(SUBSTRING(purchase_number, ?) AS UNSIGNED)) AS n
     FROM pharmacy_purchase_orders WHERE admin_id = ? AND purchase_number LIKE ?`,
    [prefix.length + 1, adminId, `${prefix}%`]
  );
  return `${prefix}${pad((Number(rows[0].n) || 0) + 1, 4)}`;
}

/* ============================================================
   New medicines — medicine_data first, then pharmacy_medicines
============================================================ */
function cleanNewMedicine(nm, row) {
  nm = nm || {};
  const s = (v, max = 255) => {
    const t = v == null ? "" : String(v).trim();
    return t ? t.slice(0, max) : null;
  };
  return {
    brand_name: s(nm.brand_name),
    medicine_name: s(nm.medicine_name) || s(nm.brand_name),
    strength: s(nm.strength, 100),
    dosage_form: s(nm.dosage_form, 100),
    pack_size: s(nm.pack_size ?? row.pack_size, 100),
    manufacturer: s(nm.manufacturer ?? row.manufacturer),
    hsn_code: s(nm.hsn_code ?? row.hsn_code, 20),
    medicine_code: s(nm.medicine_code ?? row.medicine_code, 100),
    barcode: s(nm.barcode ?? row.barcode, 100),
    category_id: Number.isInteger(Number(nm.category_id)) && Number(nm.category_id) > 0 ? Number(nm.category_id) : null,
  };
}

// Master record. Only columns medicine_data actually has are written.
function medicineDataValues(nm, adminId, cols, userId) {
  return {
    medicine_name: nm.medicine_name || nm.brand_name,
    generic_name: undefined,
    brand_name: nm.brand_name,
    strength: nm.strength,
    dosage_form: nm.dosage_form,
    manufacturer: nm.manufacturer,
    manufacturer_name: nm.manufacturer,
    hsn_code: nm.hsn_code,
    pack_size: nm.pack_size,
    admin_id: cols.has("admin_id") ? adminId : undefined,
    status: statusValueFor(cols.get("status")),
    is_active: cols.has("is_active") ? 1 : undefined,
    created_by: userId || undefined,
  };
}

// Tenant row. medicine_data_id links back to the master record.
function pharmacyMedicineValues(nm, line, adminId, cols, userId, mdId, code, categoryId) {
  // tablets per strip, the pack label and the pack word, from the receipt line (see resolveReceipt)
  const pack = line.new_pack || {};
  return {
    ...NEW_MEDICINE_DEFAULTS,
    admin_id: adminId,
    medicine_data_id: mdId,
    category_id: nm.category_id || categoryId || NEW_MEDICINE_DEFAULTS.category_id || undefined,
    manufacturer: nm.manufacturer,
    pack_size: pack.pack_size !== undefined ? pack.pack_size : nm.pack_size,
    units_per_pack: pack.units_per_pack || undefined,
    unit: pack.unit || undefined,
    storage_location: pack.storage_location || undefined,
    medicine_code: code || undefined,
    barcode: nm.barcode,
    hsn_code: nm.hsn_code,
    hsn: nm.hsn_code,
    gst_percentage: line.gst_percentage,
    purchase_price: line.purchase_price,
    selling_price: line.selling_price,
    mrp: line.mrp,
    status: statusValueFor(cols.get("status")),
    is_active: cols.has("is_active") ? 1 : undefined,
    created_by: userId || undefined,
  };
}

async function nextMedicineCodes(conn, adminId, count) {
  const [rows] = await conn.query(
    `SELECT MAX(CAST(SUBSTRING(medicine_code, 4) AS UNSIGNED)) AS n
     FROM pharmacy_medicines WHERE admin_id = ? AND medicine_code REGEXP '^MED[0-9]+$'`,
    [adminId]
  );
  const start = (Number(rows[0].n) || 0) + 1;
  return Array.from({ length: count }, (_, i) => `MED${pad(start + i, 5)}`);
}

async function createMedicine(conn, adminId, userId, nm, line, code, categoryId) {
  const mdCols = await tableColumns(conn, "medicine_data");
  const pmCols = await tableColumns(conn, "pharmacy_medicines");

  // 1. master record — reuse one with the same name + strength if it exists
  let mdId = null;
  const params = [nm.brand_name || nm.medicine_name, nm.medicine_name || nm.brand_name];
  let scope = "";
  if (mdCols.has("admin_id")) {
    scope = " AND (admin_id = ? OR admin_id IS NULL)";
    params.push(adminId);
  }
  const [candidates] = await conn.query(
    `SELECT id, medicine_name, brand_name, strength FROM medicine_data
     WHERE (brand_name = ? OR medicine_name = ?)${scope} LIMIT 50`,
    params
  );
  const want = nameKey(nm.brand_name || nm.medicine_name, nm.strength);
  const hit = candidates.find((c) => nameKey(c.brand_name || c.medicine_name, c.strength) === want);


  if (hit) {
    mdId = hit.id;
  } else {
    mdId = await insertKnown(
      conn,
      "medicine_data",
      medicineDataValues(nm, adminId, mdCols, userId),
      `medicine "${nm.brand_name || nm.medicine_name}"`
    );
  }

  // One pharmacy_medicines row per (admin_id, medicine_data_id) — uq_admin_medicine.
  // Check regardless of how mdId was arrived at.
  const [existing] = await conn.query(
    `SELECT id FROM pharmacy_medicines WHERE admin_id = ? AND medicine_data_id = ? LIMIT 1`,
    [adminId, mdId]
  );
  if (existing.length) return { id: existing[0].id, reused: true };

  const id = await insertKnown(
    conn,
    "pharmacy_medicines",
    pharmacyMedicineValues(nm, line, adminId, pmCols, userId, mdId, code, categoryId),
    `medicine "${nm.brand_name || nm.medicine_name}"`
  );
  return { id, reused: false };
}

/* ============================================================
   Category for medicines created from an invoice
   Returns null when pharmacy_medicines has no category_id column,
   else { id, name, will_create, needed, error }.
   apply=false never writes; apply=true creates "Uncategorized" if needed.
============================================================ */
async function tableColumnsOrNull(conn, table) {
  try {
    return await tableColumns(conn, table);
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE") return null;
    throw e;
  }
}

async function categoryExists(conn, adminId, catCols, id) {
  const scoped = catCols.has("admin_id");
  const [rows] = await conn.query(
    `SELECT id FROM pharmacy_categories WHERE id = ?${scoped ? " AND admin_id = ?" : ""} LIMIT 1`,
    scoped ? [id, adminId] : [id]
  );
  return rows.length > 0;
}

async function resolveNewMedicineCategory(conn, adminId, userId, body, apply) {
  const pmCols = await tableColumns(conn, "pharmacy_medicines");
  const col = pmCols.get("category_id");
  if (!col) return null;
  const needed = col.Null === "NO" && col.Default === null;
  const catCols = await tableColumnsOrNull(conn, "pharmacy_categories");

  const explicit = has(body, "default_category_id") ? body.default_category_id : NEW_MEDICINE_DEFAULTS.category_id;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    const id = Number(explicit);
    if (!Number.isInteger(id) || id <= 0) return { needed, error: "default_category_id must be a category id" };
    if (catCols && !(await categoryExists(conn, adminId, catCols, id)))
      return { needed, error: `Category ${id} not found for this pharmacy (default_category_id)` };
    return { id, needed, will_create: false };
  }
  if (!needed) return { id: null, needed, will_create: false };
  if (!catCols)
    return { needed, error: "pharmacy_medicines needs category_id but there is no pharmacy_categories table. Set NEW_MEDICINE_DEFAULTS.category_id." };

  const nameCol = ["category_name", "name", "title"].find((c) => catCols.has(c));
  if (!nameCol) return { needed, error: "Can't tell which pharmacy_categories column holds the name. Send default_category_id." };

  const where = [`LOWER(TRIM(??)) IN (?)`];
  const params = [nameCol, FALLBACK_CATEGORY_MATCHES];
  if (catCols.has("admin_id")) {
    where.push("admin_id = ?");
    params.push(adminId);
  }
  const activeValue = statusValueFor(catCols.get("status"));
  if (activeValue !== undefined) {
    where.push("status = ?");
    params.push(activeValue);
  }
  if (catCols.has("is_active")) where.push("is_active = 1");
  if (catCols.has("deleted_at")) where.push("deleted_at IS NULL");
  const [found] = await conn.query(
    `SELECT id, ?? AS name FROM pharmacy_categories WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT 1`,
    [nameCol, ...params]
  );
  if (found.length) return { id: Number(found[0].id), name: found[0].name, needed, will_create: false };

  const values = knownValues(catCols, {
    [nameCol]: FALLBACK_CATEGORY_NAME,
    admin_id: adminId,
    description: "Created automatically for medicines added from supplier invoices",
    status: activeValue,
    is_active: catCols.has("is_active") ? 1 : undefined,
    created_by: userId || undefined,
  });
  const missing = missingRequired(catCols, values);
  if (missing.length)
    return {
      needed,
      error: `Can't create an "${FALLBACK_CATEGORY_NAME}" category automatically (pharmacy_categories needs ${missing.join(", ")}). Create one, or send default_category_id.`,
    };
  if (!apply) return { id: null, name: FALLBACK_CATEGORY_NAME, needed, will_create: true };
  const [ins] = await conn.query("INSERT INTO pharmacy_categories SET ?", [values]);
  return { id: ins.insertId, name: FALLBACK_CATEGORY_NAME, needed, will_create: false, created: true };
}

/* ============================================================
   RECEIVING CORE
   apply=false → preview: plain reads, no locks, no writes
   apply=true  → real receive inside the caller's transaction

   input: {
     purchase_id | supplier_id,        one of them
     branch,                           admin of a multi-branch pharmacy, when the PO has none
     invoice_number, invoice_date,     supplier's invoice
     received_date,                    default today
     discount_amount, other_charges,   invoice-level (default: from PO)
     notes,
     missing_lines: "remove" | "block",
     update_catalog: true,
     allow_duplicate_invoice: false,
     rows: [ { row?, item_id? | medicine_id? | create_new + new_medicine? |
               medicine_code? | barcode? | name?,
               batch_number, expiry_date, manufacturing_date,
               quantity (strips), free_quantity (strips), units_per_pack (tablets per strip),
               purchase_price, mrp, selling_price (all per strip),
               discount_amount | discount_percent (trade discount), scheme_amount (₹, on top), gst_percentage,
               hsn_code, pack_size, manufacturer, storage_location, unit, file_amount } ]
   }
============================================================ */
const VALUE_FIELDS = [
  "batch_number", "manufacturing_date", "expiry_date", "quantity", "free_quantity",
  "purchase_price", "mrp", "selling_price", "discount_amount", "gst_percentage",
];
// typed on a line (or read from the file) and handed back exactly as they came
const PASS_FIELDS = ["units_per_pack", "storage_location", "hsn_code", "pack_size", "manufacturer", "unit", "file_amount", "scheme_amount"];

const cleanText = (v, max = 255) => {
  const t = v == null ? "" : String(v).trim();
  return t ? t.slice(0, max) : null;
};

/* Where this receipt's stock goes (see utils/pharmacyBranch.js).
   The PO's deliver-to branch wins; otherwise the receiver's branch (the admin picks one). */
async function receiptScope(conn, req, order, wanted) {
  const s = await resolveScope(conn, req, { wanted, forWrite: false });
  const out = { actor: s.actor, multi: s.multi, branch: s.branch, key: s.key, filter: s.filter, from: "receiver", problem: null };
  const poBranch = order ? cleanText(order.branch) : null;
  if (poBranch) {
    out.from = "order";
    out.branch = s.branches.find((b) => branchKey(b) === branchKey(poBranch)) || poBranch;
    out.key = branchKey(out.branch);
    out.filter = s.multi;
    if (s.multi && !s.actor.isAdmin && s.key !== out.key)
      out.problem = `${order.purchase_number} is to be delivered to ${out.branch}. It is received there, or by the admin.`;
    return out;
  }
  if (s.multi && !s.branch) out.problem = "Choose the branch first.";
  return out;
}

async function resolveReceipt(conn, adminId, userId, input, apply, req) {
  const body = input || {};
  const now = new Date();
  const today = toDate(now);
  const lock = apply ? "FOR UPDATE" : "";
  const blocking = [];
  const warnings = [];

  /* ---- 1. Header: PO or direct ---- */
  let order = null;
  let poItems = [];
  let supplier;
  if (has(body, "purchase_id")) {
    const orderId = parseId(body.purchase_id, "purchase order");
    const [orders] = await conn.query(
      `SELECT po.*, s.supplier_name FROM pharmacy_purchase_orders po
       LEFT JOIN pharmacy_suppliers s ON s.id = po.supplier_id AND s.admin_id = po.admin_id
       WHERE po.id = ? AND po.admin_id = ? LIMIT 1 ${lock}`,
      [orderId, adminId]
    );
    if (!orders.length) throw httpError(404, "Purchase order not found");
    order = orders[0];
    if (!RECEIVABLE_STATUS.includes(order.status))
      throw httpError(409, `Purchase order ${order.purchase_number} is '${order.status}' — only draft or ordered POs can be received.`);
    if (apply) await conn.query(`SELECT id FROM pharmacy_purchase_items WHERE purchase_id = ? FOR UPDATE`, [orderId]);
    [poItems] = await conn.query(
      `SELECT pi.*, pm.medicine_code, pm.barcode, ${CATALOG_NAME_COLS}
       FROM pharmacy_purchase_items pi
       LEFT JOIN pharmacy_medicines pm ON pm.id = pi.medicine_id
       ${CATALOG_JOIN}
       WHERE pi.purchase_id = ? ORDER BY pi.id ASC`,
      [orderId]
    );
    supplier = { id: order.supplier_id, supplier_name: order.supplier_name };
    if (!order.supplier_id) blocking.push(`${order.purchase_number} has no supplier yet. Choose one on the order (Purchase orders) first.`);
  } else {
    if (!has(body, "supplier_id")) throw httpError(400, "Choose a purchase order, or a supplier for a direct receipt");
    supplier = await verifySupplier(conn, adminId, body.supplier_id);
  }

  // which branch the stock goes into — blocks the receipt (not the preview) when it can't be told
  const scope = await receiptScope(conn, req, order, body.branch);
  if (scope.problem) blocking.push(scope.problem);
  const bf = batchFilter(scope, "b");

  let received_date = today;
  if (has(body, "received_date")) {
    received_date = toDate(body.received_date);
    if (!received_date) throw httpError(400, "received_date must be YYYY-MM-DD");
    if (received_date > today) throw httpError(400, "received_date can't be in the future");
    const poDate = order ? toDate(order.purchase_date) : null;
    if (poDate && received_date < poDate) throw httpError(400, `received_date can't be before the PO date (${poDate})`);
  }
  const invoice_number = has(body, "invoice_number") ? String(body.invoice_number).trim().slice(0, 100) : order?.invoice_number || null;
  let invoice_date = order ? toDate(order.invoice_date) : null;
  if (has(body, "invoice_date")) {
    invoice_date = toDate(body.invoice_date);
    if (!invoice_date) throw httpError(400, "invoice_date must be YYYY-MM-DD");
    if (invoice_date > today) throw httpError(400, "invoice_date can't be in the future");
  }
  if (!invoice_number) warnings.push("No supplier invoice number entered — add it so this receipt can be matched to the bill later.");

  if (invoice_number) {
    const [dups] = await conn.query(
      `SELECT id, purchase_number FROM pharmacy_purchase_orders
       WHERE admin_id = ? AND supplier_id = ? AND invoice_number = ? AND status = 'received' AND id <> ? LIMIT 1`,
      [adminId, supplier.id, invoice_number, order ? order.id : 0]
    );
    if (dups.length) {
      const msg = `Invoice ${invoice_number} from this supplier was already received on ${dups[0].purchase_number}.`;
      if (body.allow_duplicate_invoice === true) warnings.push(msg);
      else blocking.push(`${msg} Importing it again would double the stock.`);
    }
  }

  const missingMode = body.missing_lines === "block" ? "block" : "remove";
  const updateCatalog = body.update_catalog !== false;

  /* ---- 2. Rows ---- */
  if (!Array.isArray(body.rows) || !body.rows.length) throw httpError(400, "No lines to receive");
  if (body.rows.length > MAX_ROWS) throw httpError(400, `Too many lines (max ${MAX_ROWS})`);

  const [catalogRows] = await conn.query(
    `SELECT pm.*, ${CATALOG_NAME_COLS}
     FROM pharmacy_medicines pm
     ${CATALOG_JOIN}
     WHERE pm.admin_id = ?`,
    [adminId]
  );
  const index = buildCatalogIndex(catalogRows);

  // the newest batch of each medicine in this branch: where it sits on the shelf, and its MRP —
  // the defaults for a line that doesn't say
  const [shelfRows] = await conn.query(
    `SELECT b.medicine_id, b.storage_location FROM pharmacy_medicine_batches b
      JOIN (SELECT b.medicine_id, MAX(b.id) AS id FROM pharmacy_medicine_batches b
             WHERE b.admin_id = ? AND b.storage_location IS NOT NULL AND TRIM(b.storage_location) <> '' ${bf.sql}
             GROUP BY b.medicine_id) x ON x.id = b.id`,
    [adminId, ...bf.params]
  );
  const shelfOf = new Map(shelfRows.map((r) => [Number(r.medicine_id), r.storage_location]));
  const [mrpRows] = await conn.query(
    `SELECT b.medicine_id, b.mrp FROM pharmacy_medicine_batches b
      JOIN (SELECT medicine_id, MAX(id) AS id FROM pharmacy_medicine_batches
             WHERE admin_id = ? AND mrp > 0 GROUP BY medicine_id) x ON x.id = b.id`,
    [adminId]
  );
  const lastMrpOf = new Map(mrpRows.map((r) => [Number(r.medicine_id), Number(r.mrp) || 0]));

  const poById = new Map(poItems.map((l) => [Number(l.id), l]));
  const claimed = new Set();
  // PO lines named explicitly by item_id are reserved for those rows
  const reserved = new Set(body.rows.filter((r) => r && has(r, "item_id")).map((r) => Number(r.item_id)));

  const claimPoLine = (medId, batch) => {
    const free = poItems.filter(
      (l) => Number(l.medicine_id) === medId && !claimed.has(Number(l.id)) && !reserved.has(Number(l.id))
    );
    if (!free.length) return null;
    const byBatch = batch ? free.find((l) => normCode(l.batch_number) === normCode(batch)) : null;
    const line = byBatch || free[0];
    claimed.add(Number(line.id));
    return line;
  };

  const out = [];
  for (let i = 0; i < body.rows.length; i++) {
    const r = body.rows[i] || {};
    const p = r.row ? `Row ${r.row}` : `Line ${i + 1}`;
    const res = {
      index: i,
      row: r.row || null,
      label: p,
      input_name: r.name || null,
      action: null,
      item_id: null,
      medicine_id: null,
      medicine: null,
      ordered_quantity: null,
      new_medicine: null,
      candidates: [],
      similar: [],
      problems: [...(Array.isArray(r.problems) ? r.problems : [])],
      warnings: [],
      changes: [],
      catalog_changes: [],
      batch_changes: [],
    };
    let med = null;
    let poLine = null;

    /* -- which medicine? -- */
    if (has(r, "item_id")) {
      if (!order) res.problems.push("item_id only works when receiving against a purchase order");
      else {
        poLine = poById.get(Number(r.item_id));
        if (!poLine) res.problems.push(`item_id ${r.item_id} is not on ${order.purchase_number}`);
        else if (claimed.has(Number(poLine.id))) res.problems.push(`PO line ${r.item_id} is used by an earlier row`);
        else {
          claimed.add(Number(poLine.id));
          med = index.byId.get(Number(poLine.medicine_id)) || null;
        }
      }
    } else if (r.create_new === true) {
      const nm = cleanNewMedicine(r.new_medicine, r);
      if (!nm.brand_name && !nm.medicine_name) res.problems.push("New medicine needs a name");
      else {
        const dup = index.byKey.get(nameKey(nm.brand_name || nm.medicine_name, nm.strength)) || [];
        if (dup.length) {
          res.problems.push(`"${medicineLabel(nm)}" is already in your catalog — select it instead of creating a new one`);
          res.candidates = dup.map(brief);
        }
        if (nm.medicine_code && (index.byCode.get(normCode(nm.medicine_code)) || []).length)
          res.problems.push(`Medicine code ${nm.medicine_code} is already used by another medicine`);
      }
      res.action = "new_medicine";
      res.new_medicine = nm;
      res.medicine = medicineLabel(nm);
    } else {
      let how = null;
      if (has(r, "medicine_id")) {
        med = index.byId.get(Number(r.medicine_id)) || null;
        if (!med) res.problems.push(`Medicine ${r.medicine_id} is not in your catalog`);
        how = "medicine_id";
      }
      if (!med && !how && has(r, "medicine_code")) {
        const hits = index.byCode.get(normCode(r.medicine_code)) || [];
        if (hits.length === 1) [med, how] = [hits[0], "medicine_code"];
      }
      if (!med && !how && has(r, "barcode")) {
        const hits = index.byBarcode.get(normCode(r.barcode)) || [];
        if (hits.length === 1) [med, how] = [hits[0], "barcode"];
      }
      if (!med && !how && has(r, "name")) {
        const hits = index.byKey.get(nameKey(r.name, r.strength)) || [];
        if (hits.length === 1) [med, how] = [hits[0], "name"];
        else if (hits.length > 1) {
          res.action = "ambiguous";
          res.candidates = hits.map(brief);
          res.problems.push(`"${r.name}" matches ${hits.length} medicines — choose the right one`);
          how = "ambiguous";
        } else {
          // Not in catalog → new medicine (auto)
          const parts = parseNameParts(r.name);
          const nm = cleanNewMedicine(
            {
              brand_name: parts.brand_name || String(r.name).trim(),
              medicine_name: parts.brand_name || String(r.name).trim(),
              strength: r.strength || parts.strength,
              dosage_form: r.dosage_form || parts.dosage_form,
            },
            r
          );
          res.action = "new_medicine";
          res.new_medicine = nm;
          res.medicine = medicineLabel(nm);
          res.similar = similarMedicines(index, r.name).map(brief);
          res.warnings.push(
            res.similar.length
              ? `Not in your catalog — will be added as a new medicine. Similar: ${res.similar.map((s) => s.medicine).join(", ")}. Pick one of those instead if it's the same medicine.`
              : "Not in your catalog — will be added as a new medicine."
          );
          how = "new";
        }
      }
      if (!how) res.problems.push("Row has no medicine name, code, barcode or id");
      res.matched_by = how;
    }

    if (med) {
      if (!["active", 1, "1", true].includes(med.status) && med.status !== undefined)
        res.warnings.push("This medicine is inactive in the catalog — stock will still be added.");
      res.medicine_id = Number(med.id);
      res.medicine = medicineLabel(med);
      if (!poLine && order) poLine = claimPoLine(Number(med.id), r.batch_number);
      res.action = poLine ? "po_line" : "extra";
      if (!poLine && order) res.warnings.push(`Not on ${order.purchase_number} — will be added to it as an extra line.`);
    }
    if (poLine) {
      res.item_id = Number(poLine.id);
      res.ordered_quantity = Number(poLine.quantity);
    }
    if (!res.action) res.action = "unresolved";

    /* -- tablets per strip: typed → the file's pack column → PO line → medicine → 1 -- */
    let upp = null;
    let uppFrom = "default";
    try {
      const typed = has(r, "units_per_pack") ? cleanUnitsPerPack(r.units_per_pack) : null;
      if (typed) [upp, uppFrom] = [typed, "line"];
    } catch (e) {
      res.problems.push(e.message);
    }
    if (!upp && has(r, "pack_size") && parsePackSize(r.pack_size)) [upp, uppFrom] = [parsePackSize(r.pack_size), "file"];
    if (!upp && poLine && Number(poLine.units_per_pack) >= 1) [upp, uppFrom] = [Number(poLine.units_per_pack), "order"];
    if (!upp && med) [upp, uppFrom] = [unitsPerPack(med), "medicine"];
    if (!upp && res.new_medicine && parsePackSize(res.new_medicine.pack_size)) [upp, uppFrom] = [parsePackSize(res.new_medicine.pack_size), "file"];
    if (!upp) upp = 1;
    res.units_per_pack_from = uppFrom;
    // what one pack is sold as: typed on the line (or the file's unit column) → the medicine's → strip / pack
    const typedUnit = has(r, "unit") ? cleanPackUnit(r.unit) : null;
    res.pack_word = typedUnit || (med ? packWord(med, upp) : upp > 1 ? "strip" : "pack");

    /* -- shelf: typed → the medicine's → its newest batch in this branch -- */
    const typedShelf = cleanText(r.storage_location, 100);
    const storage_location = typedShelf || cleanText(med?.storage_location, 100) || (med ? cleanText(shelfOf.get(Number(med.id)), 100) : null);

    /* -- values: row → PO line → catalog -- */
    const base = poLine || {};
    const catalogSrc = med || {};
    const v = (k, ...fallbacks) => (has(r, k) ? r[k] : fallbacks.find((f) => f !== undefined && f !== null && f !== ""));
    const raw = {
      batch_number: v("batch_number", base.batch_number),
      manufacturing_date: v("manufacturing_date", toDate(base.manufacturing_date)),
      expiry_date: v("expiry_date", toDate(base.expiry_date)),
      quantity: v("quantity", base.quantity),
      free_quantity: v("free_quantity", base.free_quantity, 0),
      purchase_price: v("purchase_price", base.purchase_price, catalogSrc.purchase_price, 0),
      mrp: v("mrp", Number(base.mrp) || undefined, Number(catalogSrc.mrp) || undefined, med ? lastMrpOf.get(Number(med.id)) || undefined : undefined, 0),
      gst_percentage: v("gst_percentage", base.gst_percentage, catalogSrc.gst_percentage, 0),
    };
    // selling price per strip: what the invoice / the pharmacist says; otherwise the MRP
    // (or, with no MRP anywhere, the price on the order / in the catalog). Never above the MRP.
    raw.selling_price = v(
      "selling_price",
      Number(raw.mrp) > 0 ? raw.mrp : undefined,
      Number(base.selling_price) || undefined,
      Number(catalogSrc.selling_price) || undefined,
      0
    );
    // discount: amount → percent → PO line
    if (has(r, "discount_amount")) raw.discount_amount = r.discount_amount;
    else if (has(r, "discount_percent")) {
      const pct = Number(r.discount_percent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) res.problems.push("discount % must be between 0 and 100");
      else raw.discount_amount = money((Number(raw.quantity) * Number(raw.purchase_price) * pct) / 100);
    } else raw.discount_amount = Math.max(0, (Number(base.discount_amount) || 0) - (Number(base.scheme_amount) || 0));
    // scheme amount (₹): the row's → the PO line's (when the order stored one)
    if (has(r, "scheme_amount")) raw.scheme_amount = r.scheme_amount;
    else if (Number(base.scheme_amount) > 0) raw.scheme_amount = Number(base.scheme_amount);

    let line = null;
    try {
      line = priceLine(raw, p, today, upp);
    } catch (e) {
      if (!e.status) throw e;
      res.problems.push(e.message.replace(`${p}: `, ""));
    }
    const hsn_code = cleanText(r.hsn_code, 20) || cleanText(catalogSrc.hsn_code ?? catalogSrc.hsn, 20);
    const manufacturer = cleanText(r.manufacturer) || cleanText(catalogSrc.manufacturer) || cleanText(res.new_medicine?.manufacturer);
    res.values = line
      ? { ...line, storage_location, hsn_code, manufacturer, ...(has(r, "discount_percent") && !has(r, "discount_amount") ? { discount_percent: Number(r.discount_percent) } : {}) }
      : { ...Object.fromEntries(VALUE_FIELDS.map((k) => [k, raw[k] ?? null])), units_per_pack: upp, storage_location, hsn_code, manufacturer };
    if (line) {
      line.storage_location = storage_location;
      line.storage_typed = !!typedShelf;
      line.receipt_text = receiptText(line, res.pack_word);
      res.receipt_text = line.receipt_text;
    }

    if (line) {
      if (line.expiry_date <= addDays(today, NEAR_EXPIRY_DAYS))
        res.warnings.push(`Short expiry: ${line.expiry_date} is within ${NEAR_EXPIRY_DAYS} days.`);
      if (has(r, "file_amount") && Math.abs(Number(r.file_amount) - line.total_amount) > 1)
        res.warnings.push(`File amount ${money(r.file_amount)} ≠ computed ${line.total_amount} — check rate, discount or GST.`);
      if (!(line.selling_price > 0)) res.warnings.push("No selling price or MRP — this stock can't be sold until a price is set.");
      if (poLine) {
        for (const k of ["quantity", "free_quantity", "purchase_price"]) {
          if (Number(poLine[k]) !== Number(line[k])) res.changes.push({ field: k, on_po: Number(poLine[k]), received: line[k] });
        }
        if (Number(poLine.units_per_pack) >= 1 && Number(poLine.units_per_pack) !== line.units_per_pack)
          res.changes.push({ field: "units_per_pack", on_po: Number(poLine.units_per_pack), received: line.units_per_pack });
        if (line.quantity < Number(poLine.quantity))
          res.warnings.push(`Short supply: ordered ${poLine.quantity}, received ${line.quantity}.`);
      }
      if (med) {
        const pairs = [
          ["purchase_price", money(med.purchase_price), line.purchase_price, "Rate / strip"],
          ["mrp", "mrp" in med ? money(med.mrp) : null, line.mrp, "MRP / strip"],
          ["selling_price", money(med.selling_price), line.selling_price, "Selling price / strip"],
          ["gst_percentage", Number(med.gst_percentage) || 0, line.gst_percentage, "GST %"],
        ];
        const hsnCol = "hsn_code" in med ? "hsn_code" : "hsn" in med ? "hsn" : null;
        if (hsnCol && has(r, "hsn_code") && String(r.hsn_code).trim() !== String(med[hsnCol] || ""))
          pairs.push([hsnCol, med[hsnCol] || null, String(r.hsn_code).trim(), "HSN"]);
        if ("manufacturer" in med && has(r, "manufacturer") && cleanText(r.manufacturer) !== cleanText(med.manufacturer))
          pairs.push(["manufacturer", med.manufacturer || null, cleanText(r.manufacturer), "Manufacturer"]);
        for (const [field, from, to, label] of pairs) {
          if (!(field in med)) continue; // column not in your schema (mrp isn't)
          if (!["hsn_code", "hsn", "manufacturer"].includes(field) && Number(to) === 0) continue; // never wipe a price with 0
          if (String(from) !== String(to)) res.catalog_changes.push({ field, from, to, label });
        }
        // tablets per strip — the default for the next purchase; stock already on the shelf keeps its own
        const was = unitsPerPack(med);
        if ("units_per_pack" in med && was !== line.units_per_pack) {
          res.catalog_changes.push({
            field: "units_per_pack", from: was, to: line.units_per_pack, label: "Pack size",
            note: `Pack size ${was} → ${line.units_per_pack} tablets/strip — older stock keeps ${was}`,
          });
          const label = packLabelFor(med.pack_size, line.units_per_pack);
          if ("pack_size" in med && (label || null) !== (cleanText(med.pack_size) || null))
            res.catalog_changes.push({ field: "pack_size", from: med.pack_size || null, to: label, label: "Pack label" });
        }
        if ("storage_location" in med && !cleanText(med.storage_location) && storage_location)
          res.catalog_changes.push({ field: "storage_location", from: null, to: storage_location, label: "Storage location" });
        // sold as (strip / bottle / tube…) — changes how the medicine is named everywhere (stock, sales)
        const wasWord = packWord(med, upp);
        if ("unit" in med && typedUnit && typedUnit !== wasWord)
          res.catalog_changes.push({ field: "unit", from: wasWord, to: typedUnit, label: "Sold as" });
      }
      if (res.new_medicine) {
        // what the new catalog row gets: tablets per strip when we know it, a pack label and word
        line.new_pack = {
          units_per_pack: uppFrom === "default" ? undefined : upp,
          pack_size: res.new_medicine.pack_size || (upp > 1 ? `${upp} tablets` : null),
          unit: typedUnit || (upp > 1 ? "strip" : "pack"),
          storage_location,
        };
      }
    }
    res._line = line;
    res._med = med;
    res._poLine = poLine;
    res._input = r;
    out.push(res);
  }

  /* ---- 3. Same medicine + batch twice in one invoice ---- */
  const seenBatch = new Map();
  for (const res of out) {
    if (!res._line) continue;
    const who = res.medicine_id ? `m${res.medicine_id}` : `n${nameKey(res.new_medicine?.brand_name, res.new_medicine?.strength)}`;
    const key = `${who}|${res._line.batch_number.toUpperCase()}`;
    if (seenBatch.has(key))
      res.problems.push(`Same medicine and batch as ${seenBatch.get(key)} — combine them into one line`);
    else seenBatch.set(key, res.label);
  }
  // Same new medicine on two rows (different batches) → created once
  const newKeys = new Map();
  for (const res of out) {
    if (res.action !== "new_medicine" || !res.new_medicine) continue;
    const k = nameKey(res.new_medicine.brand_name || res.new_medicine.medicine_name, res.new_medicine.strength);
    if (!newKeys.has(k)) newKeys.set(k, []);
    newKeys.get(k).push(res);
  }

  /* ---- 4. Batches — same medicine + batch number in THIS branch ---- */
  for (const res of out) {
    const L = res._line;
    if (!L) continue;
    if (!res.medicine_id) {
      res.batch_action = "create_new_batch";
      continue;
    }
    const [rows] = await conn.query(
      `SELECT b.id, b.expiry_date, b.status, b.quantity_available, b.units_per_pack,
              b.purchase_price, b.selling_price, b.mrp, b.storage_location
       FROM pharmacy_medicine_batches b
       WHERE b.admin_id = ? AND b.medicine_id = ? AND b.batch_number = ? ${bf.sql}
       ORDER BY b.id ASC LIMIT 1 ${lock}`,
      [adminId, res.medicine_id, L.batch_number, ...bf.params]
    );
    if (!rows.length) {
      res.batch_action = "create_new_batch";
      continue;
    }
    const b = rows[0];
    const bUpp = unitsPerPack(b);
    if (b.status !== "active") res.problems.push(`Batch ${L.batch_number} exists but is '${b.status}' — stock can't be added to it`);
    else if (toDate(b.expiry_date) !== L.expiry_date)
      res.problems.push(
        `Batch ${L.batch_number} is already in stock with expiry ${toDate(b.expiry_date)}, the invoice says ${L.expiry_date}. Correct the batch or expiry.`
      );
    else if (bUpp !== L.units_per_pack)
      res.problems.push(
        `Different pack size — receive it as a new batch number. Batch ${L.batch_number} on the shelf has ${bUpp} tablets per strip, this line says ${L.units_per_pack}.`
      );
    res.batch_action = "add_to_existing_batch";
    res.batch_id = Number(b.id);
    res.batch_units_per_pack = bUpp;
    res.batch_stock_before = Number(b.quantity_available) || 0;
    res.batch_stock_text = describeStock(b.quantity_available, bUpp, res.pack_word);
    // the latest invoice sets the batch's prices
    for (const [field, label] of [["purchase_price", "Rate"], ["selling_price", "Selling price"], ["mrp", "MRP"]]) {
      if (money(b[field]) !== money(L[field])) res.batch_changes.push({ field, from: money(b[field]), to: money(L[field]), label });
    }
    if (res.batch_changes.length)
      res.warnings.push(
        `Batch ${L.batch_number} prices change to this invoice's: ${res.batch_changes.map((c) => `${c.label.toLowerCase()} ₹${c.from} → ₹${c.to}`).join(", ")} (per strip).`
      );
    res._batch = b;
  }

  /* ---- 5. PO lines not in the invoice ---- */
  const missing = poItems
    .filter((l) => !claimed.has(Number(l.id)))
    .map((l) => ({ item_id: Number(l.id), medicine_id: Number(l.medicine_id), medicine: medicineLabel(l), quantity: Number(l.quantity) }));
  for (const m of missing) {
    const msg = `${m.medicine} (${m.quantity} ordered) is not in the invoice`;
    if (missingMode === "block") blocking.push(`${msg}.`);
    else warnings.push(`${msg} — it will be removed from ${order.purchase_number} as not supplied.`);
  }

  /* ---- 6. Can new medicines be created with this schema? ---- */
  let newMedicineCategory = null;
  if (newKeys.size) {
    newMedicineCategory = await resolveNewMedicineCategory(conn, adminId, userId, body, false);
    const rowCats = [...new Set(out.filter((r) => r.new_medicine?.category_id).map((r) => r.new_medicine.category_id))];
    const catCols = rowCats.length ? await tableColumnsOrNull(conn, "pharmacy_categories") : null;
    for (const cid of rowCats) {
      if (catCols && !(await categoryExists(conn, adminId, catCols, cid)))
        out.filter((r) => r.new_medicine?.category_id === cid).forEach((r) => r.problems.push(`Category ${cid} not found`));
    }
    const allRowsHaveCategory = [...newKeys.values()].every((g) => g[0].new_medicine.category_id);
    if (newMedicineCategory?.error && newMedicineCategory.needed && !allRowsHaveCategory) blocking.push(newMedicineCategory.error);
    else if (newMedicineCategory?.will_create)
      warnings.push(`New medicines will go into a new "${newMedicineCategory.name}" category (created on receive). Move them to the right category later.`);
    else if (newMedicineCategory?.name)
      warnings.push(`New medicines will go into the "${newMedicineCategory.name}" category. Move them to the right category later.`);

    const mdCols = await tableColumns(conn, "medicine_data");
    const pmCols = await tableColumns(conn, "pharmacy_medicines");
    const sample = { brand_name: "x", medicine_name: "x", strength: "x", dosage_form: "x" };
    const sampleCat = newMedicineCategory && !newMedicineCategory.error ? newMedicineCategory.id || 1 : undefined;
    const sampleLine = { gst_percentage: 0, purchase_price: 0, selling_price: 0, mrp: 0 };

    const mdMissing = missingRequired(mdCols, knownValues(mdCols, medicineDataValues(sample, adminId, mdCols, userId)));
    // medicine_data_id is satisfied at insert time by the master record created
    // just before — pass a dummy id so it isn't reported as missing here.
    const pmMissing = missingRequired(
      pmCols,
      knownValues(pmCols, pharmacyMedicineValues(sample, sampleLine, adminId, pmCols, userId, 1, "MED00000", sampleCat))
    ).filter((c) => !(c === "category_id" && (allRowsHaveCategory || newMedicineCategory?.error)));

    if (mdMissing.length || pmMissing.length)
      blocking.push(
        `New medicines can't be created yet: ${[
          mdMissing.length && `medicine_data needs ${mdMissing.join(", ")}`,
          pmMissing.length && `pharmacy_medicines needs ${pmMissing.join(", ")}`,
        ]
          .filter(Boolean)
          .join("; ")}. Set them in NEW_MEDICINE_DEFAULTS, or match these rows to existing medicines.`
      );
  }

  /* ---- 6b. Wrong file / wrong PO guard ---- */
  if (order && poItems.length && out.length && !out.some((r) => r.action === "po_line")) {
    blocking.push(
      `None of the invoice lines match a medicine on ${order.purchase_number}. ` +
      `Is this the right invoice for this PO? If the supplier sent different items, receive it as a direct receipt (supplier only, no PO).`
    );
  }

  /* ---- 7. Totals ---- */
  const okLines = out.filter((r) => r._line).map((r) => r._line);
  const discount = has(body, "discount_amount") ? Number(body.discount_amount) : Number(order?.discount_amount) || 0;
  const other = has(body, "other_charges") ? Number(body.other_charges) : Number(order?.other_charges) || 0;
  if (!Number.isFinite(discount) || discount < 0) throw httpError(400, "discount_amount must be a number, 0 or more");
  if (!Number.isFinite(other) || other < 0) throw httpError(400, "other_charges must be a number, 0 or more");
  const header = computeHeader(okLines, discount, other);
  if (header.grand_total < 0) blocking.push(`Invoice discount ${discount} is more than the invoice value ${header.lines_total}`);
  const paid = money(order?.paid_amount);
  if (paid > header.grand_total && okLines.length === out.length)
    blocking.push(`Received total ${header.grand_total} is less than the ${paid} already paid. Record a supplier credit instead.`);
  const { due_amount, payment_status } = computePaymentFields(header.grand_total, paid);

  for (const res of out) for (const pr of res.problems) blocking.push(`${res.label}${res.medicine ? ` (${res.medicine})` : ""}: ${pr}`);
  for (const res of out) for (const w of res.warnings) warnings.push(`${res.label}${res.medicine ? ` (${res.medicine})` : ""}: ${w}`);
  if (updateCatalog) {
    const n = out.filter((r) => r.catalog_changes.length).length;
    if (n) warnings.push(`The catalog will be updated for ${n} medicine(s) from this invoice — see the highlighted lines.`);
  }

  /* ---- 8. The normalized body the client sends to /confirm ---- */
  const receive_body = {
    ...(order ? { purchase_id: Number(order.id) } : { supplier_id: Number(supplier.id) }),
    ...(scope.from === "receiver" && scope.multi && scope.actor.isAdmin && scope.branch ? { branch: scope.branch } : {}),
    invoice_number: invoice_number || null,
    invoice_date: invoice_date || null,
    received_date,
    discount_amount: money(discount),
    other_charges: money(other),
    missing_lines: missingMode,
    update_catalog: updateCatalog,
    ...(body.allow_duplicate_invoice === true ? { allow_duplicate_invoice: true } : {}),
    ...(has(body, "default_category_id") ? { default_category_id: Number(body.default_category_id) } : {}),
    ...(has(body, "notes") ? { notes: String(body.notes) } : {}),
    rows: out.map((res) => {
      const r = res._input;
      const values = {};
      for (const k of VALUE_FIELDS) {
        // the selling price is handed back only when the line gave one — otherwise it keeps following the MRP
        if (k === "selling_price" && !has(r, "selling_price")) continue;
        const val = res._line ? res._line[k] : r[k];
        if (val !== undefined && val !== null && val !== "") values[k] = val;
      }
      // the line's discount_amount is trade + scheme; hand back the trade part only (the scheme goes
      // back as scheme_amount, below), so a re-check never counts the scheme twice
      if (res._line && values.discount_amount !== undefined) values.discount_amount = res._line.trade_discount;
      // a discount given as a percentage stays a percentage, so it follows a changed quantity or rate
      if (has(r, "discount_percent") && !has(r, "discount_amount")) {
        delete values.discount_amount;
        values.discount_percent = r.discount_percent;
      }
      const extra = {};
      for (const k of PASS_FIELDS) if (has(r, k)) extra[k] = r[k];
      // a scheme that came from the PO line (not typed) goes back too, so the screen can show it
      if (res._line && !has(extra, "scheme_amount") && res._line.scheme_amount > 0) extra.scheme_amount = res._line.scheme_amount;
      const id =
        res.action === "po_line" ? { item_id: res.item_id }
          : res.action === "extra" ? { medicine_id: res.medicine_id }
            : res.action === "new_medicine" ? { create_new: true, new_medicine: res.new_medicine }
              : Object.fromEntries(["medicine_id", "medicine_code", "barcode", "name", "strength"].filter((k) => has(r, k)).map((k) => [k, r[k]]));
      return { ...(res.row ? { row: res.row } : {}), ...(r.name ? { name: r.name } : {}), ...id, ...values, ...extra };
    }),
  };

  const tabletsIn = okLines.reduce((s, l) => s + l.tablets_in, 0);
  const preview = {
    purchase_id: order ? Number(order.id) : null,
    purchase_number: order ? order.purchase_number : null,
    supplier: { id: Number(supplier.id), supplier_name: supplier.supplier_name },
    branch: scope.branch || null,
    branch_from: scope.from,
    multi_branch: !!scope.multi,
    received_date,
    invoice_number,
    invoice_date,
    can_receive: blocking.length === 0,
    blocking_issues: blocking,
    warnings,
    rows: out.map(({ _line, _med, _poLine, _input, _batch, ...rest }) => rest),
    missing_po_lines: missing,
    missing_lines: missingMode,
    new_medicine_category: newMedicineCategory
      ? { id: newMedicineCategory.id ?? null, name: newMedicineCategory.name ?? null, will_create: !!newMedicineCategory.will_create }
      : null,
    totals: {
      previous_grand_total: order ? money(order.grand_total) : null,
      ...header,
      paid_amount: paid,
      due_amount,
      payment_status,
    },
    summary: {
      rows: out.length,
      po_lines: out.filter((r) => r.action === "po_line").length,
      extra_lines: out.filter((r) => r.action === "extra").length,
      new_medicines: newKeys.size,
      needs_attention: out.filter((r) => r.problems.length).length,
      new_batches: out.filter((r) => r._line && r.batch_action === "create_new_batch").length,
      existing_batches: out.filter((r) => r._line && r.batch_action === "add_to_existing_batch").length,
      total_strips: okLines.reduce((s, l) => s + l.quantity, 0),
      total_free_strips: okLines.reduce((s, l) => s + l.free_quantity, 0),
      total_tablets_in: tabletsIn,
      total_units_in: tabletsIn, // tablets
      removed_po_lines: missingMode === "remove" ? missing.length : 0,
      catalog_updates: updateCatalog ? out.filter((r) => r.catalog_changes.length).length : 0,
    },
    receive_body,
  };

  if (!apply) return preview;
  if (blocking.length) {
    // the branch question is asked with the contract's own words, not buried in a list
    if (scope.problem && blocking.length === 1) throw httpError(400, scope.problem, { blocking_issues: blocking });
    throw httpError(400, "Fix the issues in the preview before receiving", { blocking_issues: blocking });
  }

  /* ================= APPLY ================= */
  const txnTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const txnDateTime = `${received_date} ${txnTime}`;

  // a. New medicines (one per distinct name + strength)
  const created = [];
  let applyCategory = null;
  if (newKeys.size) {
    applyCategory = await resolveNewMedicineCategory(conn, adminId, userId, body, true);
    const pmCols = await tableColumns(conn, "pharmacy_medicines");
    const codes = pmCols.has("medicine_code") ? await nextMedicineCodes(conn, adminId, newKeys.size) : [];
    let c = 0;
    for (const [, group] of newKeys) {
      const first = group[0];
      const code = first.new_medicine.medicine_code || codes[c++];
      const { id, reused } = await createMedicine(conn, adminId, userId, first.new_medicine, first._line, code, applyCategory?.id);
      for (const res of group) res.medicine_id = Number(id);
      created.push({
        medicine_id: Number(id), medicine: first.medicine, medicine_code: reused ? null : code, reused_existing: reused,
        category_id: reused ? null : first.new_medicine.category_id || applyCategory?.id || null,
      });
    }
  }

  // b. Direct receipt → create the PO header now (deliver-to = the branch the stock goes into)
  let orderId = order ? Number(order.id) : null;
  let purchase_number = order ? order.purchase_number : null;
  const poCols = await tableColumns(conn, "pharmacy_purchase_orders");
  if (!order) {
    purchase_number = await nextPurchaseNumber(conn, adminId, received_date);
    orderId = await insertKnown(
      conn,
      "pharmacy_purchase_orders",
      {
        admin_id: adminId,
        branch: poCols.has("branch") ? scope.branch || null : undefined,
        supplier_id: supplier.id,
        purchase_number,
        purchase_date: txnDateTime,
        order_type: poCols.has("order_type") ? "new_order" : undefined,
        invoice_number,
        invoice_date,
        subtotal: 0, discount_amount: 0, tax_amount: 0, other_charges: 0, grand_total: 0,
        paid_amount: 0, due_amount: 0, payment_status: "unpaid",
        status: "draft",
        notes: has(body, "notes") ? String(body.notes).trim() : "Direct receipt from supplier invoice",
      },
      "purchase order"
    );
  }

  // c. Lines: batch → PO line → ledger → catalog
  const itemCols = await tableColumns(conn, "pharmacy_purchase_items");
  const withItemUpp = itemCols.has("units_per_pack");
  // optional columns (sql/2026-10-22_purchase_items_scheme.sql): the discount % and scheme ₹ as entered
  const withItemDisc = itemCols.has("discount_percent") && itemCols.has("scheme_amount");
  const lineResults = [];
  const batchSeen = new Map();
  const note = `Received against ${purchase_number}${invoice_number ? ` (invoice ${invoice_number})` : ""}`;
  for (const res of out) {
    const L = res._line;
    const medId = res.medicine_id;
    const bKey = `${medId}|${L.batch_number.toUpperCase()}`;
    let batchId = res.batch_id || batchSeen.get(bKey) || null;
    const toppedUp = !!batchId;

    if (batchId) {
      // tablets in through the one door that keeps the shelf and the ledger together …
      await recordMove(conn, {
        adminId, userId, batchId, tabletsIn: L.tablets_in, type: "purchase",
        referenceId: orderId, referenceNumber: purchase_number, notes: note, date: txnDateTime,
      });
      // … and the rest of the batch keeps its meaning: received = paid strips, free = free strips
      // (both in tablets), prices = this invoice's (the latest price wins)
      await conn.query(
        `UPDATE pharmacy_medicine_batches
            SET quantity_received = quantity_received + ?, free_quantity = free_quantity + ?,
                purchase_price = ?, selling_price = ?, mrp = ?,
                storage_location = ${L.storage_typed ? "?" : "COALESCE(NULLIF(TRIM(storage_location), ''), ?)"},
                supplier_id = COALESCE(supplier_id, ?)
          WHERE id = ? AND admin_id = ?`,
        [
          L.quantity * L.units_per_pack, L.free_quantity * L.units_per_pack,
          L.purchase_price, L.selling_price, L.mrp, L.storage_location, supplier.id, batchId, adminId,
        ]
      );
    } else {
      const [ins] = await conn.query(
        `INSERT INTO pharmacy_medicine_batches
           (admin_id, branch, medicine_id, batch_number, units_per_pack, storage_location,
            manufacturing_date, expiry_date, purchase_price, selling_price, mrp,
            quantity_received, quantity_available, free_quantity, supplier_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          adminId, scope.branch || null, medId, L.batch_number, L.units_per_pack, L.storage_location,
          L.manufacturing_date, L.expiry_date, L.purchase_price, L.selling_price, L.mrp,
          L.quantity * L.units_per_pack, L.tablets_in, L.free_quantity * L.units_per_pack, supplier.id,
        ]
      );
      batchId = ins.insertId;
      await ledgerRow(conn, {
        adminId, userId, batchId, medicineId: medId, type: "purchase", tabletsIn: L.tablets_in,
        referenceId: orderId, referenceNumber: purchase_number, notes: note, date: txnDateTime,
      });
    }
    batchSeen.set(bKey, batchId);

    const cols = [
      batchId, L.batch_number, L.manufacturing_date, L.expiry_date, L.quantity, L.free_quantity,
      L.purchase_price, L.mrp, L.selling_price, L.discount_amount, L.gst_percentage, L.tax_amount, L.total_amount,
    ];
    let itemId = res.item_id;
    if (itemId) {
      await conn.query(
        `UPDATE pharmacy_purchase_items
         SET batch_id = ?, batch_number = ?, manufacturing_date = ?, expiry_date = ?, quantity = ?, free_quantity = ?,
             purchase_price = ?, mrp = ?, selling_price = ?, discount_amount = ?, gst_percentage = ?,
             tax_amount = ?, total_amount = ?${withItemUpp ? ", units_per_pack = ?" : ""}${withItemDisc ? ", discount_percent = ?, scheme_amount = ?" : ""}
         WHERE id = ? AND purchase_id = ?`,
        [...cols, ...(withItemUpp ? [L.units_per_pack] : []), ...(withItemDisc ? [L.discount_percent, L.scheme_amount] : []), itemId, orderId]
      );
    } else {
      const [ins] = await conn.query(
        `INSERT INTO pharmacy_purchase_items
           (purchase_id, medicine_id, batch_id, batch_number, manufacturing_date, expiry_date,
            quantity, free_quantity, purchase_price, mrp, selling_price,
            discount_amount, gst_percentage, tax_amount, total_amount${withItemUpp ? ", units_per_pack" : ""}${withItemDisc ? ", discount_percent, scheme_amount" : ""})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${withItemUpp ? ", ?" : ""}${withItemDisc ? ", ?, ?" : ""})`,
        [orderId, medId, ...cols, ...(withItemUpp ? [L.units_per_pack] : []), ...(withItemDisc ? [L.discount_percent, L.scheme_amount] : [])]
      );
      itemId = ins.insertId;
    }

    if (updateCatalog && res.catalog_changes.length && res.action !== "new_medicine") {
      const set = Object.fromEntries(res.catalog_changes.map((c) => [c.field, c.to]));
      await conn.query(`UPDATE pharmacy_medicines SET ? WHERE id = ? AND admin_id = ?`, [set, medId, adminId]);
    }

    lineResults.push({
      row: res.row, item_id: itemId, medicine_id: medId, medicine: res.medicine, action: res.action,
      batch_id: batchId, batch_number: L.batch_number, expiry_date: L.expiry_date,
      strips: L.quantity, free_strips: L.free_quantity, units_per_pack: L.units_per_pack, pack_word: res.pack_word,
      tablets_in: L.tablets_in, units_in: L.tablets_in, storage_location: L.storage_location,
      text: L.receipt_text,
      batch_action: toppedUp ? "add_to_existing_batch" : "create_new_batch",
    });
  }

  // d. PO lines not supplied
  if (missing.length) {
    await conn.query(`DELETE FROM pharmacy_purchase_items WHERE purchase_id = ? AND id IN (?)`, [
      orderId,
      missing.map((m) => m.item_id),
    ]);
  }

  // e. Header → received (an order with no deliver-to branch now says where it went)
  const set = {
    status: "received",
    invoice_number,
    invoice_date,
    subtotal: header.subtotal,
    discount_amount: header.discount_amount,
    tax_amount: header.tax_amount,
    other_charges: header.other_charges,
    grand_total: header.grand_total,
    due_amount,
    payment_status,
  };
  if (order && poCols.has("branch") && !cleanText(order.branch) && scope.branch) set.branch = scope.branch;
  if (poCols.has("received_at")) set.received_at = txnDateTime;
  if (poCols.has("received_date")) set.received_date = received_date;
  if (poCols.has("received_by")) set.received_by = userId || null;
  const [upd] = await conn.query(
    `UPDATE pharmacy_purchase_orders SET ?${order && has(body, "notes") ? ", notes = CONCAT_WS('\\n', notes, ?)" : ""}
     WHERE id = ? AND admin_id = ? AND status IN ('draft', 'ordered')`,
    order && has(body, "notes") ? [set, `Receipt: ${String(body.notes).trim()}`, orderId, adminId] : [set, orderId, adminId]
  );
  if (!upd.affectedRows) throw httpError(409, "This purchase order was received by someone else just now");

  return {
    ...preview,
    purchase_id: orderId,
    purchase_number,
    created_medicines: created,
    lines: lineResults,
  };
}

/* ============================================================
   IMPORT — file parsing
============================================================ */
// Supplier invoices are imported from CSV or Excel only (no PDF / image import).
const IMPORT_EXTENSIONS = [".csv", ".xlsx", ".xls"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (IMPORT_EXTENSIONS.includes(ext)) return cb(null, true);
    cb(httpError(400, "Only CSV or Excel files (.csv, .xlsx, .xls) can be imported."));
  },
});

function uploadSingle(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "File is too large (max 5 MB)" : err.message;
    return res.status(400).json({ success: false, message });
  });
}

// Header → field. Compared lower-case with everything except letters,
// digits and % removed ("Batch No." → "batchno", "Disc %" → "disc%").
const FIELD_ALIASES = {
  item_id: ["itemid", "lineid", "poitemid", "purchaseitemid"],
  medicine_id: ["medicineid", "medid"],
  medicine_code: ["medicinecode", "code", "itemcode", "productcode", "sku", "prodcode"],
  barcode: ["barcode", "ean", "upc"],
  name: ["medicine", "medicinename", "itemname", "item", "product", "productname", "prodname", "description",
    "itemdescription", "productdescription", "particulars", "name", "brand", "brandname", "drugname"],
  strength: ["strength"],
  dosage_form: ["dosageform", "form"],
  pack_size: ["pack", "packing", "packsize", "pk", "packs"],
  units_per_pack: ["unitsperpack", "tabletsperstrip", "tabsperstrip", "perstrip", "conversion", "conv"],
  unit: ["uom", "unit", "unitofmeasure"],
  storage_location: ["location", "loc", "locn", "storageloc", "storagelocation", "rack", "rackno", "racklocation", "shelf", "shelfno", "bin", "binno", "storage"],
  manufacturer: ["manufacturer", "mfr", "mfrname", "company", "companyname", "mktby", "marketedby", "mfgby", "mfgname"],
  hsn_code: ["hsn", "hsncode", "hsnsac", "hsnno", "hsnsaccode"],
  batch_number: ["batchnumber", "batchno", "batch", "lotno", "lot", "lotnumber"],
  mfg_ambiguous: ["mfg"],
  manufacturing_date: ["manufacturingdate", "mfgdate", "mfd", "mfddate", "mfgdt"],
  expiry_date: ["expirydate", "expiry", "expirys", "expdate", "exp", "expdt", "expiry dt"],
  quantity: ["quantity", "qty", "receivedqty", "billedqty", "units", "billqty"],
  free_quantity: ["freequantity", "freeqty", "free", "bonus", "bonusqty", "schemeqty", "fqty", "sch", "scheme"],
  purchase_price: ["purchaseprice", "rate", "ptr", "costprice", "cost", "purchaserate", "unitprice", "prate"],
  mrp: ["mrp"],
  selling_price: ["sellingprice", "sp", "saleprice", "salerate", "srate"],
  discount_amount: ["discamt", "discountamount", "discamount", "discountrs", "discrs", "disc", "discount"],
  discount_percent: ["disc%", "discount%", "discpercent", "discountpercent", "discper", "cd%", "cd", "td%"],
  // "Sch. Amt" is a rupee amount; a bare "Sch" / "Scheme" column stays free quantity (above)
  scheme_amount: ["schamt", "schemeamt", "schemeamount", "schamount", "schrs", "schemers", "schdisc", "schemediscount", "schdiscount", "schval", "schemevalue"],
  gst_percentage: ["gst", "gst%", "gstrate", "gstpercent", "gstper", "taxrate", "tax%", "gstrate%"],
  cgst: ["cgst", "cgst%"],
  sgst: ["sgst", "sgst%", "utgst", "utgst%"],
  igst: ["igst", "igst%"],
  file_amount: ["amount", "total", "netamount", "value", "netvalue", "linetotal", "totalamount", "netamt"],
};
const IDENTIFIERS = ["item_id", "medicine_id", "medicine_code", "barcode", "name"];
const normHeader = (v) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9%]/g, "");
const ALIAS_LOOKUP = new Map();
for (const [field, list] of Object.entries(FIELD_ALIASES))
  for (const a of list) ALIAS_LOOKUP.set(normHeader(a), field);

function mapHeaderRow(cells) {
  const map = {};
  const unknown = [];
  cells.forEach((cell, col) => {
    const k = normHeader(cell);
    if (!k) return;
    const field = ALIAS_LOOKUP.get(k) || ALIAS_LOOKUP.get(k.replace(/%/g, ""));
    if (field && map[field] === undefined) map[field] = col;
    else if (!field) unknown.push(String(cell).trim());
  });
  return { map, unknown };
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const fullYear = (y) => (String(y).length === 2 ? 2000 + Number(y) : Number(y));
const monthNum = (s) => MONTHS[String(s).toLowerCase().slice(0, 4)] || MONTHS[String(s).toLowerCase().slice(0, 3)];

// Day-first (Indian) dates. Month-only ("05/28", "MAY-2028") → expiry = last day, mfg = 1st.
// Returns 'YYYY-MM-DD', undefined (blank) or null (unreadable).
function parseInvoiceDate(v, kind) {
  if (v === undefined || v === null || v === "") return undefined;
  const monthOnly = (y, m) => (kind === "expiry" ? buildDate(y, m, new Date(y, m, 0).getDate()) : buildDate(y, m, 1));
  if (v instanceof Date) return isNaN(v.getTime()) ? null : toDate(v);
  if (typeof v === "number") {
    if (v > 20000 && v < 80000) {
      const d = new Date((Math.floor(v) - 25569) * 86400000); // Excel serial
      return buildDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return null;
  }
  const s = String(v).trim();
  if (!s) return undefined;
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return buildDate(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) return buildDate(fullYear(m[3]), +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{2}|\d{4})$/))) return +m[1] >= 1 && +m[1] <= 12 ? monthOnly(fullYear(m[2]), +m[1]) : null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})$/))) return +m[2] >= 1 && +m[2] <= 12 ? monthOnly(+m[1], +m[2]) : null;
  if ((m = s.match(/^(\d{1,2})[\s\-/.]([a-z]{3,9})[\s\-/.,']*(\d{2}|\d{4})$/i)))
    return monthNum(m[2]) ? buildDate(fullYear(m[3]), monthNum(m[2]), +m[1]) : null;
  if ((m = s.match(/^([a-z]{3,9})[\s\-/.,']*(\d{2}|\d{4})$/i)))
    return monthNum(m[1]) ? monthOnly(fullYear(m[2]), monthNum(m[1])) : null;
  return null;
}

function parseAmount(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/rs\.?|₹|inr|,|%|\s/gi, "");
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cellText(v) {
  if (v === undefined || v === null) return "";
  if (v instanceof Date) return toDate(v) || "";
  return String(v).trim();
}

function readImportFile(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  let wb;
  try {
    // raw:true for CSV keeps "05/06/2028" as text (read day-first by us).
    // cellDates:false keeps Excel dates as serial numbers (no timezone shift).
    wb = XLSX.read(file.buffer, { type: "buffer", cellDates: false, raw: ext === ".csv" });
  } catch (e) {
    throw httpError(400, "Could not read the file. Upload a valid .csv, .xlsx or .xls file.");
  }
  const sheetName = wb.SheetNames[0];
  const ws = sheetName && wb.Sheets[sheetName];
  if (!ws || !ws["!ref"]) throw httpError(400, "The file is empty");

  const startRow = XLSX.utils.decode_range(ws["!ref"]).s.r;
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true, blankrows: true });

  // Distributor exports usually have a title / address block — find the header row
  let headerIdx = -1;
  let header = null;
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const h = mapHeaderRow(grid[i] || []);
    if (h.map.quantity !== undefined && IDENTIFIERS.some((f) => h.map[f] !== undefined)) {
      headerIdx = i;
      header = h;
      break;
    }
  }
  if (headerIdx < 0)
    throw httpError(
      400,
      "Couldn't find the column headings. The file needs a quantity column and a medicine name (or code / barcode). Download the template to see the format."
    );

  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i] || [];
    if (!cells.some((c) => cellText(c) !== "")) continue;
    const firstText = cellText(cells.find((c) => cellText(c) !== ""));
    if (/^(sub\s*)?(grand\s*)?(net\s*)?total\b|^round\s*off|^gst\s*summary|^taxable/i.test(firstText)) continue;
    const values = {};
    for (const [field, col] of Object.entries(header.map)) values[field] = cells[col];
    const idText = IDENTIFIERS.map((f) => cellText(values[f])).join("");
    if (!idText && !cellText(values.quantity)) continue;
    rows.push({ row: startRow + i + 1, values });
    if (rows.length > MAX_ROWS) throw httpError(400, `Too many rows (max ${MAX_ROWS})`);
  }
  if (!rows.length) throw httpError(400, "No data rows found under the column headings");

  return {
    sheet: sheetName,
    headerRowNumber: startRow + headerIdx + 1,
    columns_used: Object.keys(header.map),
    columns_ignored: header.unknown,
    rows,
  };
}

// One file row → a receipt input row (typed values + problems)
function fileRowToInput({ row, values }) {
  const out = { row };
  const problems = [];

  for (const f of ["item_id", "medicine_id"]) {
    const t = cellText(values[f]);
    if (t) {
      const n = Number(t);
      if (Number.isInteger(n) && n > 0) out[f] = n;
      else problems.push(`${f} "${t}" is not a valid id`);
    }
  }
  for (const f of ["medicine_code", "barcode", "name", "strength", "dosage_form", "pack_size", "manufacturer", "hsn_code", "batch_number", "storage_location", "unit"]) {
    const t = cellText(values[f]);
    if (t) out[f] = t;
  }
  // tablets per strip: its own column, else read off the pack ("1x15" → 15, "10'S" → 10; "100 ml" → none)
  const uppText = cellText(values.units_per_pack);
  if (uppText) {
    const n = Number(uppText);
    if (Number.isInteger(n) && n >= 1 && n <= 10000) out.units_per_pack = n;
    else problems.push(`tablets per strip "${uppText}" must be a whole number`);
  } else if (out.pack_size && parsePackSize(out.pack_size)) {
    out.units_per_pack = parsePackSize(out.pack_size);
  }
  if (values.mfg_ambiguous !== undefined && cellText(values.mfg_ambiguous)) {
    const d = parseInvoiceDate(values.mfg_ambiguous, "mfg");
    if (d) out.manufacturing_date = d;
    else if (!out.manufacturer) out.manufacturer = cellText(values.mfg_ambiguous);
  }
  for (const [f, kind] of [["expiry_date", "expiry"], ["manufacturing_date", "mfg"]]) {
    const d = parseInvoiceDate(values[f], kind);
    if (d === null) problems.push(`${f === "expiry_date" ? "expiry" : "mfg date"} "${cellText(values[f])}" is not a date we can read`);
    else if (d !== undefined) out[f] = d;
  }
  for (const f of ["quantity", "free_quantity"]) {
    const n = parseAmount(values[f]);
    if (n === null || (n !== undefined && (!Number.isInteger(n) || n < 0)))
      problems.push(`${f === "quantity" ? "quantity" : "free qty"} "${cellText(values[f])}" must be a whole number`);
    else if (n !== undefined) out[f] = n;
  }
  for (const f of ["purchase_price", "mrp", "selling_price", "discount_amount", "discount_percent", "scheme_amount", "gst_percentage", "file_amount"]) {
    const n = parseAmount(values[f]);
    if (n === null || (n !== undefined && n < 0)) problems.push(`${f.replace(/_/g, " ")} "${cellText(values[f])}" is not a valid number`);
    else if (n !== undefined) out[f] = n;
  }
  if (out.gst_percentage === undefined) {
    const c = parseAmount(values.cgst);
    const s = parseAmount(values.sgst);
    const ig = parseAmount(values.igst);
    if (Number.isFinite(ig) && ig > 0) out.gst_percentage = ig;
    else if (Number.isFinite(c) || Number.isFinite(s)) out.gst_percentage = money((c || 0) + (s || 0));
  }
  if (problems.length) out.problems = problems;
  return out;
}

/* ============================================================
   LOOKUPS
============================================================ */

// POs waiting to be received
// GET /pending?search=
router.get("/pending", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const adminId = getTenantAdminId(req);
    const params = [adminId];
    let extra = "";
    if (has(req.query, "search")) {
      extra = " AND (po.purchase_number LIKE ? OR s.supplier_name LIKE ?)";
      const like = `%${String(req.query.search).trim()}%`;
      params.push(like, like);
    }
    // several branches: staff see the orders for their branch (and the ones with no branch yet);
    // the admin sees all, or one branch when they pick it
    const scope = await resolveScope(db, req, { wanted: req.query.branch, forWrite: false });
    if (scope.filter) {
      extra += " AND (po.branch IS NULL OR TRIM(po.branch) = '' OR LOWER(TRIM(po.branch)) = ?)";
      params.push(scope.key);
    }
    const [rows] = await db.query(
      `SELECT po.id, po.purchase_number, po.purchase_date, po.status, po.grand_total, po.paid_amount,
              po.supplier_id, s.supplier_name, po.branch,
              (SELECT COUNT(*) FROM pharmacy_purchase_items pi WHERE pi.purchase_id = po.id) AS items_count
       FROM pharmacy_purchase_orders po
       LEFT JOIN pharmacy_suppliers s ON s.id = po.supplier_id AND s.admin_id = po.admin_id
       WHERE po.admin_id = ? AND po.status IN ('draft', 'ordered')${extra}
       ORDER BY FIELD(po.status, 'ordered', 'draft'), po.purchase_date DESC
       LIMIT 200`,
      params
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return sendError(res, err, "Pending receipts error:", "Failed to load pending purchase orders");
  }
});

// PO lines to prefill manual entry
// GET /po/:id
router.get("/po/:id", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const adminId = getTenantAdminId(req);
    const id = parseId(req.params.id, "purchase order");
    const [orders] = await db.query(
      `SELECT po.*, s.supplier_name FROM pharmacy_purchase_orders po
       LEFT JOIN pharmacy_suppliers s ON s.id = po.supplier_id AND s.admin_id = po.admin_id
       WHERE po.id = ? AND po.admin_id = ? LIMIT 1`,
      [id, adminId]
    );
    if (!orders.length) throw httpError(404, "Purchase order not found");
    const [items] = await db.query(
      `SELECT pi.*, pm.medicine_code, pm.barcode, pm.pack_size, pm.unit, pm.storage_location,
              pm.units_per_pack AS medicine_units_per_pack, ${CATALOG_NAME_COLS}
       FROM pharmacy_purchase_items pi
       LEFT JOIN pharmacy_medicines pm ON pm.id = pi.medicine_id
       ${CATALOG_JOIN}
       WHERE pi.purchase_id = ? ORDER BY pi.id ASC`,
      [id]
    );
    return res.json({
      success: true,
      data: {
        ...orders[0],
        items: items.map((it) => {
          // tablets per strip: the line's snapshot → the medicine's → its pack label
          const upp = Number(it.units_per_pack) >= 1 ? Number(it.units_per_pack) : unitsPerPack({ units_per_pack: it.medicine_units_per_pack, pack_size: it.pack_size });
          return { ...it, units_per_pack: upp, pack_word: packWord(it, upp), medicine: medicineLabel(it) };
        }),
      },
    });
  } catch (err) {
    return sendError(res, err, "Receive PO fetch error:", "Failed to load purchase order");
  }
});

// GET /suppliers — for direct receipts
router.get("/suppliers", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, supplier_name FROM pharmacy_suppliers WHERE admin_id = ? AND status = 'active' ORDER BY supplier_name LIMIT 500`,
      [getTenantAdminId(req)]
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return sendError(res, err, "Receive suppliers error:", "Failed to load suppliers");
  }
});

// GET /medicine-lookup?q= — pick a catalog medicine for an ambiguous / new row
router.get("/medicine-lookup", authMiddleware, allowPermissions(PERM.view), async (req, res) => {
  try {
    const adminId = getTenantAdminId(req);
    const q = String(req.query.q || "").trim();
    const params = [adminId];
    let where = "pm.admin_id = ?";
    if (q) {
      where += " AND (md.medicine_name LIKE ? OR md.brand_name LIKE ? OR pm.medicine_code LIKE ? OR pm.barcode = ?)";
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, q);
    }
    const [rows] = await db.query(
      `SELECT pm.id, pm.medicine_code, pm.barcode, pm.purchase_price, pm.gst_percentage,
              pm.pack_size, pm.unit, pm.units_per_pack, ${CATALOG_NAME_COLS}
       FROM pharmacy_medicines pm
       ${CATALOG_JOIN}
       WHERE ${where} ORDER BY COALESCE(md.brand_name, md.medicine_name) LIMIT 25`,
      params
    );
    return res.json({
      success: true,
      data: rows.map((m) => ({
        ...brief(m), dosage_form: m.dosage_form, purchase_price: money(m.purchase_price),
        units_per_pack: unitsPerPack(m), pack_size: m.pack_size || null, pack_word: packWord(m),
      })),
    });
  } catch (err) {
    return sendError(res, err, "Medicine lookup error:", "Failed to search medicines");
  }
});

/* ============================================================
   TEMPLATE
   GET /template/:id  → CSV pre-filled with the PO's lines
   GET /template      → blank CSV for direct receipts
============================================================ */
// quantity / free_quantity are STRIPS; tablets_per_strip says how many tablets one strip holds;
// purchase_price, mrp and selling_price are per strip
const TEMPLATE_COLS = [
  "item_id", "medicine", "medicine_code", "hsn_code", "batch_number", "manufacturing_date", "expiry_date",
  "tablets_per_strip", "quantity", "free_quantity", "purchase_price", "mrp", "selling_price", "discount_percent",
  "scheme_amount", "gst_percentage", "location",
];
const csvEsc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function sendTemplate(req, res) {
  try {
    let lines = [];
    let fileName = "receive-template.csv";
    if (req.params.id) {
      const adminId = getTenantAdminId(req);
      const id = parseId(req.params.id, "purchase order");
      const [orders] = await db.query(
        `SELECT purchase_number, status FROM pharmacy_purchase_orders WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, adminId]
      );
      if (!orders.length) throw httpError(404, "Purchase order not found");
      if (!RECEIVABLE_STATUS.includes(orders[0].status))
        throw httpError(409, `This purchase order is '${orders[0].status}' — nothing to receive.`);
      const [items] = await db.query(
        `SELECT pi.*, pm.medicine_code, pm.barcode, pm.pack_size, pm.storage_location,
                pm.hsn_code AS medicine_hsn, pm.units_per_pack AS medicine_units_per_pack, ${CATALOG_NAME_COLS}
         FROM pharmacy_purchase_items pi
         LEFT JOIN pharmacy_medicines pm ON pm.id = pi.medicine_id
         ${CATALOG_JOIN}
         WHERE pi.purchase_id = ? ORDER BY pi.id ASC`,
        [id]
      );
      // batch / mfg / expiry left blank — those come off the physical pack
      lines = items.map((it) =>
        [
          it.id, medicineLabel(it), it.medicine_code, pick(it, ["hsn_code", "hsn", "medicine_hsn"]) || "",
          "", "", "",
          Number(it.units_per_pack) >= 1 ? Number(it.units_per_pack) : unitsPerPack({ units_per_pack: it.medicine_units_per_pack, pack_size: it.pack_size }),
          it.quantity, it.free_quantity, it.purchase_price,
          Number(it.mrp) || "", Number(it.selling_price) || "",
          // discount % as ordered (stored, or worked out from the ₹ discount less the scheme) and the scheme ₹
          (() => {
            if (it.discount_percent != null && Number(it.discount_percent) > 0) return Number(it.discount_percent);
            const gross = (Number(it.quantity) || 0) * (Number(it.purchase_price) || 0);
            const trade = (Number(it.discount_amount) || 0) - (Number(it.scheme_amount) || 0);
            return gross > 0 && trade > 0 ? Math.round((trade / gross) * 10000) / 100 : "";
          })(),
          Number(it.scheme_amount) || "", it.gst_percentage, it.storage_location || "",
        ].map(csvEsc).join(",")
      );
      fileName = `${String(orders[0].purchase_number).replace(/[^A-Za-z0-9_-]/g, "_")}-receive.csv`;
    } else {
      lines = [["", "Dolo 650mg Tablet", "", "3004", "DL2401", "2026-01-10", "2028-12-31", 15, 100, 10, 20.5, 32, 30, 5, 0, 12, "Rack A2"].map(csvEsc).join(",")];
    }
    const csv = "\uFEFF" + [TEMPLATE_COLS.join(","), ...lines].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(csv);
  } catch (err) {
    return sendError(res, err, "Receive template error:", "Failed to build template");
  }
}
router.get("/template", authMiddleware, allowPermissions(PERM.receive), sendTemplate);
router.get("/template/:id", authMiddleware, allowPermissions(PERM.receive), sendTemplate);

/* ============================================================
   IMPORT — upload the distributor's file → preview (writes nothing)
   POST /import   multipart/form-data
     file            .csv / .xlsx / .xls (max 5 MB)          required
     purchase_id     receive against this PO                  or
     supplier_id     direct receipt (no PO)
     invoice_number, invoice_date, received_date, missing_lines   optional
============================================================ */
router.post("/import", authMiddleware, allowPermissions(PERM.receive), uploadSingle, async (req, res) => {
  let conn;
  try {
    if (!req.file) throw httpError(400, "Attach the invoice file in a form field named 'file'");
    const file = readImportFile(req.file);
    const f = req.body || {};
    const input = {
      rows: file.rows.map(fileRowToInput),
      ...Object.fromEntries(
        ["purchase_id", "supplier_id", "branch", "invoice_number", "invoice_date", "received_date", "missing_lines", "notes", "default_category_id"]
          .filter((k) => has(f, k))
          .map((k) => [k, f[k]])
      ),
      update_catalog: f.update_catalog !== "false" && f.update_catalog !== "0",
    };
    conn = await db.getConnection();
    const preview = await resolveReceipt(conn, getTenantAdminId(req), req.user.id, input, false, req);
    return res.json({
      success: true,
      preview_only: true,
      file: {
        name: req.file.originalname,
        sheet: file.sheet,
        header_row: file.headerRowNumber,
        rows_read: file.rows.length,
        columns_used: file.columns_used,
        columns_ignored: file.columns_ignored,
      },
      data: preview,
    });
  } catch (err) {
    return sendError(res, err, "Receive import error:", "Failed to read the file");
  } finally {
    if (conn) conn.release();
  }
});

/* ============================================================
   PREVIEW — re-check after edits in the review screen (writes nothing)
   POST /preview   JSON: same shape as receive_body
============================================================ */
router.post("/preview", authMiddleware, allowPermissions(PERM.receive), async (req, res) => {
  let conn;
  try {
    conn = await db.getConnection();
    const data = await resolveReceipt(conn, getTenantAdminId(req), req.user.id, req.body, false, req);
    return res.json({ success: true, preview_only: true, data });
  } catch (err) {
    return sendError(res, err, "Receive preview error:", "Failed to preview receipt");
  } finally {
    if (conn) conn.release();
  }
});

/* ============================================================
   CONFIRM — stock goes in
   POST /confirm   JSON: receive_body from /import or /preview
============================================================ */
router.post("/confirm", authMiddleware, allowPermissions(PERM.receive), async (req, res) => {
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();
    const result = await resolveReceipt(conn, getTenantAdminId(req), req.user.id, req.body, true, req);
    await conn.commit();
    const s = result.summary;
    // one word for the packs (strips / bottles…, "packs" for a mix); tablets only when a pack holds several
    const lines = result.lines || [];
    const words = new Set(lines.map((l) => l.pack_word).filter(Boolean));
    const word = words.size === 1 ? [...words][0] : "pack";
    const multi = lines.some((l) => Number(l.units_per_pack) > 1);
    const single = lines.some((l) => Number(l.units_per_pack) <= 1);
    return res.json({
      success: true,
      message:
        `${result.purchase_number} received — ${s.total_strips} ${plural(word, s.total_strips)}` +
        (s.total_free_strips ? ` (+${s.total_free_strips} free)` : "") +
        (multi ? ` = ${s.total_tablets_in} ${plural(single ? "unit" : "tablet", s.total_tablets_in)}` : "") +
        " into stock" +
        (result.branch ? ` at ${result.branch}` : "") +
        (result.created_medicines.length ? `, ${result.created_medicines.length} new medicine(s) added to the catalog` : "") +
        (s.removed_po_lines ? `, ${s.removed_po_lines} unsupplied line(s) removed` : ""),
      data: result,
    });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => { });
    return sendError(res, err, "Receive confirm error:", "Failed to receive stock");
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
// exported for tests
module.exports._internals = { nameKey, parseNameParts, parseInvoiceDate, readImportFile, fileRowToInput, resolveReceipt };