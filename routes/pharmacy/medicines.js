// routes/pharmacy/medicines.js

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
const {
  unitsPerPack,
  cleanUnitsPerPack,
  parsePackSize,
  packWord,
  plural,
} = require("../../utils/pharmacyUnits");
const { BranchError, resolveScope, batchFilter, sendBranchError } = require("../../utils/pharmacyBranch");
const { istToday, repackBatch } = require("../../utils/pharmacyStock");

/*
   UNITS (see utils/pharmacyUnits.js)
     • units_per_pack   tablets in one strip — the default for the next purchase.
                        Required for a new medicine (parsed from pack_size when not sent).
     • pack_size        a free-text LABEL only ("15'S", "1x10"); empty → shown as "N tablets"
     • prices           PER STRIP (per pack when units_per_pack = 1)
     • reorder_level / maximum_stock   in STRIPS
     • stock            batches hold TABLETS; the list adds stock_tablets / stock_text /
                        low_stock / locations, per branch (resolveScope, read-only)
*/

/* ============================================================
   Helper: resolve tenant admin_id from req.user
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

/* ============================================================
   Helper: validate input per type (a 400 with a sentence, never a 500)
============================================================ */
class FieldError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Text field: string or number in, trimmed string (or null when empty) out. undefined = not sent. */
function textField(val, label, max) {
  if (val === undefined) return undefined;
  if (val === null) return null;
  if (typeof val === "number" && Number.isFinite(val)) val = String(val);
  if (typeof val !== "string") throw new FieldError(`${label} must be text`);
  const s = val.trim();
  if (s.length > max) throw new FieldError(`${label} can be at most ${max} characters`);
  return s || null;
}

/** Number field. "" / null → `empty`. undefined = not sent. */
function numberField(val, label, { min = 0, max = 9999999999, int = false, empty = 0 } = {}) {
  if (val === undefined) return undefined;
  if (val === null || (typeof val === "string" && val.trim() === "")) return empty;
  const n = typeof val === "number" ? val : typeof val === "string" ? Number(val.trim()) : NaN;
  if (!Number.isFinite(n)) throw new FieldError(`${label} must be a number`);
  if (int && !Number.isInteger(n)) throw new FieldError(`${label} must be a whole number`);
  if (n < min) throw new FieldError(min === 0 ? `${label} cannot be negative` : `${label} must be at least ${min}`);
  if (n > max) throw new FieldError(`${label} is too large`);
  return n;
}

const TEXT_LIMITS = {
  manufacturer: ["Manufacturer", 255],
  pack_size: ["Pack label", 100],
  unit: ["Unit", 50],
  medicine_code: ["Medicine code", 100],
  barcode: ["Barcode", 100],
  hsn_code: ["HSN code", 20],
  storage_location: ["Shelf / location", 100],
};

const sendFieldError = (res, err) => {
  if (err instanceof FieldError || (err && err.status === 400 && !(err instanceof BranchError))) {
    res.status(400).json({ success: false, message: err.message });
    return true;
  }
  return false;
};

/* ============================================================
   Helper: stock per medicine, from its batches in the branch scope
   Stock = active, unexpired batches with tablets left. Strips are counted per batch
   (floor(tablets ÷ that batch's units_per_pack)) — the full strips we can still sell.
============================================================ */
function stockJoin(scope, adminId) {
  const f = batchFilter(scope, "b");
  return {
    sql: `LEFT JOIN (
            SELECT b.medicine_id,
                   SUM(b.quantity_available) AS stock_tablets,
                   SUM(FLOOR(b.quantity_available / GREATEST(b.units_per_pack, 1))) AS stock_strips,
                   SUM(MOD(b.quantity_available, GREATEST(b.units_per_pack, 1))) AS stock_loose,
                   COUNT(*) AS batch_count,
                   MIN(b.expiry_date) AS nearest_expiry
              FROM pharmacy_medicine_batches b
             WHERE b.admin_id = ? AND b.status = 'active' AND b.expiry_date >= ?
               AND b.quantity_available > 0 ${f.sql}
             GROUP BY b.medicine_id
          ) st ON st.medicine_id = pm.id`,
    params: [adminId, istToday(), ...f.params],
  };
}

/** Distinct shelves of the batches holding stock, earliest expiry first (FEFO). */
async function locationsFor(adminId, scope, medicineIds) {
  const out = new Map();
  if (!medicineIds.length) return out;
  const f = batchFilter(scope, "b");
  const [rows] = await db.query(
    `SELECT b.medicine_id, TRIM(b.storage_location) AS loc, MIN(b.expiry_date) AS first_expiry
       FROM pharmacy_medicine_batches b
      WHERE b.admin_id = ? AND b.medicine_id IN (?) AND b.status = 'active'
        AND b.expiry_date >= ? AND b.quantity_available > 0
        AND b.storage_location IS NOT NULL AND TRIM(b.storage_location) <> '' ${f.sql}
      GROUP BY b.medicine_id, TRIM(b.storage_location)
      ORDER BY first_expiry ASC, loc ASC`,
    [adminId, medicineIds, istToday(), ...f.params]
  );
  for (const r of rows) {
    if (!out.has(r.medicine_id)) out.set(r.medicine_id, []);
    out.get(r.medicine_id).push(r.loc);
  }
  return out;
}

/** "15 strips + 5 tablets" from full strips (counted per batch) and loose tablets. */
function stockText(strips, loose, word) {
  const unit = (n) => plural(word, n);
  if (strips && loose) return `${strips} ${unit(strips)} + ${loose} ${plural("tablet", loose)}`;
  if (loose) return `${loose} ${plural("tablet", loose)}`;
  return `${strips} ${unit(strips)}`;
}

/** Adds the unit + stock fields to a medicine row (stock fields are null when there's no scope). */
function decorate(row, locMap, scope) {
  const upp = unitsPerPack(row);
  const word = packWord(row, upp);
  row.pack_units = upp; // tablets per strip actually used (own units_per_pack → pack_size → 1)
  row.pack_word = word;
  row.pack_label = row.pack_size || (upp > 1 ? `${upp} tablets` : `1 ${word}`);
  if (scope === null) {
    Object.assign(row, { stock_tablets: null, stock_strips: null, stock_text: null, low_stock: null, shortfall_strips: null, batch_count: null, locations: [] });
    return row;
  }
  const tablets = Number(row.stock_tablets) || 0;
  const strips = Number(row.stock_strips) || 0;
  const loose = Number(row.stock_loose) || 0;
  const level = Number(row.reorder_level) || 0;
  row.stock_tablets = tablets;
  row.stock_strips = strips;
  row.stock_loose = loose;
  row.batch_count = Number(row.batch_count) || 0;
  // full strips counted per batch (each batch has its own pack size) + the loose tablets left over —
  // the same figure as stock_strips, never the total re-divided by the medicine's default pack size
  row.stock_text = stockText(strips, loose, upp <= 1 && word === "strip" ? "pack" : word);
  row.low_stock = level > 0 && strips < level;
  row.shortfall_strips = row.low_stock ? level - strips : 0;
  const locs = (locMap && locMap.get(row.id)) || [];
  row.locations = locs.length ? locs : row.storage_location ? [row.storage_location] : [];
  row.stock_branch = scope && scope.filter ? scope.branch : null;
  return row;
}

/** Read-only scope for a list. A staff member with no branch still gets the list, without stock. */
async function readScope(req) {
  try {
    return { scope: await resolveScope(db, req, { wanted: req.query.branch }) };
  } catch (err) {
    if (err instanceof BranchError && err.status === 403) return { scope: null, note: err.message };
    throw err;
  }
}

const MEDICINE_COLUMNS = `
           pm.id, pm.admin_id, pm.medicine_data_id, pm.category_id,
           pm.manufacturer, pm.pack_size, pm.units_per_pack, pm.storage_location, pm.unit,
           pm.medicine_code, pm.barcode, pm.hsn_code,
           pm.gst_percentage, pm.purchase_price, pm.selling_price,
           pm.reorder_level, pm.maximum_stock, pm.prescription_required,
           pm.return_policy,
           pm.status, pm.created_at, pm.updated_at,
           md.medicine_name, md.brand_name, md.generic_name,
           md.dosage_form, md.strength,
           pc.category_name`;

/** One medicine with its catalog + category + stock (used after create / update / get). */
async function fetchMedicine(req, id, extra = "") {
  const tenantAdminId = getTenantAdminId(req);
  const { scope } = await readScope(req);
  const sj = scope ? stockJoin(scope, tenantAdminId) : null;
  const [rows] = await db.query(
    `SELECT ${MEDICINE_COLUMNS}${extra}
            ${sj ? ", st.stock_tablets, st.stock_strips, st.stock_loose, st.batch_count, st.nearest_expiry" : ""}
       FROM pharmacy_medicines pm
       JOIN medicine_data md       ON md.id = pm.medicine_data_id
       JOIN pharmacy_categories pc ON pc.id = pm.category_id
       ${sj ? sj.sql : ""}
      WHERE pm.id = ? AND pm.admin_id = ?
      LIMIT 1`,
    [...(sj ? sj.params : []), id, tenantAdminId]
  );
  if (!rows.length) return null;
  const locMap = scope ? await locationsFor(tenantAdminId, scope, [rows[0].id]) : null;
  return decorate(rows[0], locMap, scope);
}


/* ============================================================
   Helper: parse + normalize return_policy JSON
   Returns a well-formed policy object (never null)
============================================================ */
const DEFAULT_RETURN_POLICY = {
  is_returnable: true,
  window_days: 7,
  condition: "unopened_only",
  requires_approval_after_window: true,
  reason: null,
  notes: null,
};

const VALID_CONDITIONS = ["any", "unopened_only", "sealed_pack_only", "batch_intact"];

function parseReturnPolicy(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null; // caller decides whether to apply default
  }
  let obj;
  try {
    obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error("return_policy must be valid JSON");
  }
  if (typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("return_policy must be an object");
  }

  const isReturnable = obj.is_returnable !== false; // default true

  const normalized = {
    is_returnable: isReturnable,
  };

  if (isReturnable) {
    // Returnable → must have window + condition
    const windowDays =
      obj.window_days === null || obj.window_days === undefined
        ? 7
        : parseInt(obj.window_days, 10);
    if (isNaN(windowDays) || windowDays < 0 || windowDays > 365) {
      throw new Error("window_days must be between 0 and 365");
    }
    const condition = obj.condition || "unopened_only";
    if (!VALID_CONDITIONS.includes(condition)) {
      throw new Error(
        `condition must be one of: ${VALID_CONDITIONS.join(", ")}`
      );
    }
    normalized.window_days = windowDays;
    normalized.condition = condition;
    normalized.requires_approval_after_window =
      obj.requires_approval_after_window !== false; // default true
    normalized.notes = obj.notes?.toString().trim() || null;
  } else {
    // Not returnable → reason recommended
    normalized.reason =
      obj.reason?.toString().trim() ||
      "This medicine is marked as non-returnable";
  }

  return normalized;
}


/* ============================================================
   CREATE pharmacy medicine (add to inventory catalog)
   Access:
     - admin (bypass — tenant owner)
     - any staff role with 'pharmacy.medicines.create' permission
============================================================ */
router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.medicines.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      const {
        medicine_data_id,
        category_id,
        gst_percentage,
        purchase_price,
        selling_price,
        reorder_level,
        maximum_stock,
        prescription_required,
        units_per_pack,
         return_policy,
      } = req.body;

      // ── Text fields: strings or numbers, length-checked ──
      let text;
      let upp;
      try {
        text = Object.fromEntries(
          Object.entries(TEXT_LIMITS).map(([k, [label, max]]) => [k, textField(req.body[k], label, max) ?? null])
        );
        // tablets in one strip: sent, else read from the pack label ("10 tablets", "1x10")
        upp = cleanUnitsPerPack(units_per_pack) ?? parsePackSize(text.pack_size);
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }
      if (!upp) {
        return res.status(400).json({
          success: false,
          message: "Enter how many tablets are in one strip (1 for a bottle, tube or injection)",
        });
      }

      // ── Required field validation ──
      if (!medicine_data_id) {
        return res.status(400).json({
          success: false,
          message: "medicine_data_id is required — please select a medicine from the catalog",
        });
      }

      if (!category_id) {
        return res.status(400).json({
          success: false,
          message: "category_id is required",
        });
      }

      // ── Verify medicine exists in universal catalog ──
      const [medicineCheck] = await db.query(
        `SELECT id, medicine_name FROM medicine_data 
         WHERE id = ? AND status = 'active' LIMIT 1`,
        [medicine_data_id]
      );

      if (!medicineCheck.length) {
        return res.status(404).json({
          success: false,
          message: "Selected medicine not found in catalog",
        });
      }

      // ── Verify category belongs to this tenant ──
      const [categoryCheck] = await db.query(
        `SELECT id FROM pharmacy_categories 
         WHERE id = ? AND admin_id = ? AND status = 'active' LIMIT 1`,
        [category_id, tenantAdminId]
      );

      if (!categoryCheck.length) {
        return res.status(404).json({
          success: false,
          message: "Category not found in your organization",
        });
      }

      // ── Duplicate check (UNIQUE constraint on admin_id + medicine_data_id) ──
      const [existing] = await db.query(
        `SELECT id FROM pharmacy_medicines 
         WHERE admin_id = ? AND medicine_data_id = ? LIMIT 1`,
        [tenantAdminId, medicine_data_id]
      );

      if (existing.length) {
        return res.status(409).json({
          success: false,
          message: `'${medicineCheck[0].medicine_name}' is already in your inventory`,
          existing_id: existing[0].id,
        });
      }

      // ── Validate numeric fields (prices per strip, levels in strips) ──
      let gst, purchase, selling, reorder, maxStock;
      try {
        gst = numberField(gst_percentage, "GST percentage") ?? 0;
        purchase = numberField(purchase_price, "Purchase price") ?? 0;
        selling = numberField(selling_price, "Selling price") ?? 0;
        reorder = numberField(reorder_level, "Reorder level", { int: true, max: 4000000000 }) ?? 0;
        maxStock = numberField(maximum_stock, "Maximum stock", { int: true, max: 4000000000, empty: null }) ?? null;
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }

      if (gst < 0 || gst > 100) {
        return res.status(400).json({
          success: false,
          message: "GST percentage must be between 0 and 100",
        });
      }

      if (maxStock !== null && maxStock > 0 && maxStock < reorder) {
        return res.status(400).json({
          success: false,
          message: "Maximum stock can't be below the reorder level",
        });
      }


      // ── Parse + validate return policy (apply default if not provided) ──
let policyToStore;
try {
  policyToStore = parseReturnPolicy(return_policy) || { ...DEFAULT_RETURN_POLICY };
} catch (e) {
  return res.status(400).json({
    success: false,
    message: `Invalid return_policy: ${e.message}`,
  });
}


      // ── Insert ──
      const [result] = await db.query(
        `INSERT INTO pharmacy_medicines (
          admin_id, medicine_data_id, category_id, manufacturer,
          pack_size, units_per_pack, storage_location, unit, medicine_code, barcode,
          hsn_code, gst_percentage, purchase_price, selling_price,
          reorder_level, maximum_stock, prescription_required,
          return_policy, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          tenantAdminId,
          medicine_data_id,
          category_id,
          text.manufacturer,
          text.pack_size,
          upp,
          text.storage_location,
          text.unit,
          text.medicine_code,
          text.barcode,
          text.hsn_code,
          gst,
          purchase,
          selling,
          reorder,
          maxStock,
          prescription_required ? 1 : 0,
          JSON.stringify(policyToStore),
        ]
      );

      // ── Return created row with joined catalog + category + stock info ──
      const newRow = await fetchMedicine(req, result.insertId);

      return res.status(201).json({
        success: true,
        message: "Medicine added to inventory successfully",
        data: newRow,
      });
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          success: false,
          message: "This medicine is already in your inventory",
        });
      }
      if (sendBranchError(res, err)) return;
      console.error("Create pharmacy medicine error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to add medicine",
      });
    }
  }
);

/* ============================================================
   LIST medicines (with search, filter, pagination)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.medicines.view' permission
============================================================ */
router.get(
  "/",
  authMiddleware,
  // M7: billing screens need this read — a cashier holding only pharmacy.sales.create must be able to use it
  allowPermissions("pharmacy.medicines.view", "pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);

      const {
        search,
        status,
        category_id,
        prescription_required,
        returnable,
        low_stock,
        stock_status,
        sort_by = "created_at",
        sort_order = "DESC",
      } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 20));

      // ── Stock per medicine, in the branch scope (admin: all branches unless one is picked) ──
      const { scope, note: stockNote } = await readScope(req);
      const sj = scope ? stockJoin(scope, tenantAdminId) : { sql: "", params: [] };

      const whereConditions = ["pm.admin_id = ?"];
      const params = [tenantAdminId];

      // stock filters: low (fewer strips than the reorder level), in (any stock), out (none)
      const stockWanted =
        low_stock === "1" || low_stock === "true" ? "low" : ["low", "in", "out"].includes(stock_status) ? stock_status : null;
      if (stockWanted && scope) {
        if (stockWanted === "low") whereConditions.push("(pm.reorder_level > 0 AND COALESCE(st.stock_strips, 0) < pm.reorder_level)");
        if (stockWanted === "in") whereConditions.push("COALESCE(st.stock_tablets, 0) > 0");
        if (stockWanted === "out") whereConditions.push("COALESCE(st.stock_tablets, 0) = 0");
      }

      if (status && ["active", "inactive"].includes(status)) {
        whereConditions.push("pm.status = ?");
        params.push(status);
      }

      if (category_id) {
        whereConditions.push("pm.category_id = ?");
        params.push(category_id);
      }

      if (prescription_required !== undefined && prescription_required !== "") {
        const flag =
          prescription_required === "true" ||
          prescription_required === "1" ||
          prescription_required === 1;
        whereConditions.push("pm.prescription_required = ?");
        params.push(flag ? 1 : 0);
      }

      // ✅ FIX 1: Moved returnable filter here (before whereClause is built)
      if (returnable !== undefined && returnable !== "") {
        const flag = returnable === "true" || returnable === "1";
        whereConditions.push(
          `JSON_EXTRACT(pm.return_policy, '$.is_returnable') = ?`
        );
        params.push(flag);
      }

      if (search && search.trim()) {
        const searchTerm = `%${search.trim()}%`;
        whereConditions.push(`(
          md.medicine_name LIKE ? OR 
          md.brand_name LIKE ? OR 
          md.generic_name LIKE ? OR
          pm.medicine_code LIKE ? OR
          pm.barcode LIKE ? OR
          pm.manufacturer LIKE ? OR
          pm.storage_location LIKE ?
        )`);
        params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
      }

      const whereClause = whereConditions.join(" AND ");
      const offset = (page - 1) * limit;

      // Whitelisted sort columns — prevent SQL injection
      const allowedSort = {
        created_at: "pm.created_at",
        updated_at: "pm.updated_at",
        medicine_name: "md.medicine_name",
        selling_price: "pm.selling_price",
        purchase_price: "pm.purchase_price",
        reorder_level: "pm.reorder_level",
        ...(scope && {
          stock: "COALESCE(st.stock_tablets, 0)",
          shortfall: "(CAST(pm.reorder_level AS SIGNED) - COALESCE(st.stock_strips, 0))",
          nearest_expiry: "st.nearest_expiry",
        }),
      };
      const safeSortBy = allowedSort[sort_by] || "pm.created_at";
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      // Total count
      const [countResult] = await db.query(
        `SELECT COUNT(*) as total
         FROM pharmacy_medicines pm
         JOIN medicine_data md       ON md.id = pm.medicine_data_id
         JOIN pharmacy_categories pc ON pc.id = pm.category_id
         ${sj.sql}
         WHERE ${whereClause}`,
        [...sj.params, ...params]
      );

      // Paginated results
      const [medicines] = await db.query(
        `SELECT ${MEDICINE_COLUMNS}
           ${scope ? ", st.stock_tablets, st.stock_strips, st.stock_loose, st.batch_count, st.nearest_expiry" : ""}
         FROM pharmacy_medicines pm
         JOIN medicine_data md       ON md.id = pm.medicine_data_id
         JOIN pharmacy_categories pc ON pc.id = pm.category_id
         ${sj.sql}
         WHERE ${whereClause}
         ORDER BY ${safeSortBy} ${safeSortOrder}, pm.id DESC
         LIMIT ? OFFSET ?`,
        [...sj.params, ...params, limit, offset]
      );
      const locMap = scope ? await locationsFor(tenantAdminId, scope, medicines.map((m) => m.id)) : null;
      medicines.forEach((m) => decorate(m, locMap, scope));

      // ✅ FIX 2: Check global catalog when inventory is empty — enables substitute suggestions
      let catalog_match = null;
      if (
        medicines.length === 0 &&
        search &&
        search.trim().length >= 2
      ) {
        const searchTerm = `${search.trim()}%`;
        const [catalogRows] = await db.query(
          `SELECT 
             id, medicine_name, brand_name, generic_name,
             strength, dosage_form, composition_key
           FROM medicine_data
           WHERE status = 'active'
             AND (
               medicine_name LIKE ? OR 
               brand_name LIKE ? OR 
               generic_name LIKE ?
             )
           ORDER BY LENGTH(medicine_name) ASC
           LIMIT 5`,
          [searchTerm, searchTerm, searchTerm]
        );
        if (catalogRows.length > 0) {
          catalog_match = { suggestions: catalogRows };
        }
      }

      return res.json({
        success: true,
        data: medicines,
        pagination: {
          page,
          limit,
          total: countResult[0].total,
          total_pages: Math.ceil(countResult[0].total / limit),
        },
        catalog_match,  // ← enables substitute suggestions on frontend
        stock_scope: scope ? { branch: scope.filter ? scope.branch : null, multi: scope.multi } : null,
        stock_note: stockNote || null,
      });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("List medicines error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch medicines",
      });
    }
  }
);

//  API for medicine substitute lookup
// GET /api/pharmacy/medicines/substitutes?medicine_data_id=123
router.get(
  "/substitutes",
  authMiddleware,
  // M7: billing screens need this read — a cashier holding only pharmacy.sales.create must be able to use it
  allowPermissions("pharmacy.medicines.view", "pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const medicineDataId = parseInt(req.query.medicine_data_id);

      if (!medicineDataId) {
        return res.status(400).json({
          success: false,
          message: "medicine_data_id is required",
        });
      }

      // 1. Get the composition_key of the requested medicine from the global catalog
      const [[catalog]] = await db.query(
        `SELECT id, medicine_name, generic_name, strength, dosage_form, composition_key
         FROM medicine_data
         WHERE id = ? AND status = 'active'
         LIMIT 1`,
        [medicineDataId]
      );

      if (!catalog) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found in catalog",
        });
      }

      // Branch — 26 Oct 2026. "In stock" used to mean in stock ANYWHERE in the pharmacy: the
      // batch join below had no branch filter, so the substitute dialog could offer P2 a
      // medicine only P1 holds, with P1's quantity. Now it is the same strict live-stock
      // filter the medicine search uses — staff: their branch; admin: the branch picked.
      // A staff member whose profile has no branch gets no suggestions, rather than
      // suggestions from someone else's shelf.
      const { scope, note } = await readScope(req);
      if (!scope) {
        return res.json({
          success: true,
          data: {
            requested: {
              medicine_data_id: catalog.id,
              name: catalog.medicine_name,
              composition: `${catalog.generic_name || ""} ${catalog.strength || ""} ${catalog.dosage_form || ""}`.trim(),
            },
            substitutes: [],
            total: 0,
            note,
          },
        });
      }
      const subBf = batchFilter(scope, "pmb");

      // 2. Find in-stock medicines in THIS pharmacy (and branch) with the same composition
      const [substitutes] = await db.query(
        `SELECT 
           pm.id AS pharmacy_medicine_id,
           pm.medicine_code,
           pm.barcode,
           pm.manufacturer,
           pm.pack_size,
           pm.selling_price,
           pm.gst_percentage,
           md.medicine_name,
           md.brand_name,
           md.generic_name,
           md.strength,
           md.dosage_form,
           pc.category_name,
           SUM(pmb.quantity_available) AS total_available,
           MIN(pmb.expiry_date) AS nearest_expiry
         FROM pharmacy_medicines pm
         JOIN medicine_data md       ON md.id = pm.medicine_data_id
         JOIN pharmacy_categories pc ON pc.id = pm.category_id
         JOIN pharmacy_medicine_batches pmb 
           ON pmb.medicine_id = pm.id 
           AND pmb.admin_id = pm.admin_id
         WHERE pm.admin_id = ?
           AND pm.status = 'active'
           AND md.composition_key = ?
           AND md.id != ?
           AND pmb.status = 'active'
           AND pmb.quantity_available > 0
           AND pmb.expiry_date > CURDATE() ${subBf.sql}
         GROUP BY pm.id
         ORDER BY nearest_expiry ASC, pm.selling_price ASC
         LIMIT 10`,
        [tenantAdminId, catalog.composition_key, medicineDataId, ...subBf.params]
      );

      return res.json({
        success: true,
        data: {
          requested: {
            medicine_data_id: catalog.id,
            name: catalog.medicine_name,
            composition: `${catalog.generic_name || ""} ${catalog.strength || ""} ${catalog.dosage_form || ""}`.trim(),
          },
          substitutes: substitutes,
          total: substitutes.length,
          stock_branch: scope.filter ? scope.branch : null,
        },
      });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("Substitute lookup error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch substitutes",
      });
    }
  }
);

router.get(
  "/catalog-search",
  authMiddleware,
  // M7: billing screens need this read — a cashier holding only pharmacy.sales.create must be able to use it
  allowPermissions("pharmacy.medicines.view", "pharmacy.sales.create"),
  async (req, res) => {
    try {
      const { search = "", limit = 5 } = req.query;
      
      if (!search || search.trim().length < 2) {
        return res.json({ success: true, data: [] });
      }
      
      const safeLimit = Math.min(parseInt(limit) || 5, 20);
      const searchTerm = `${search.trim()}%`;
      
      const [rows] = await db.query(
        `SELECT id, medicine_name, brand_name, generic_name,
                strength, dosage_form, composition_key
         FROM medicine_data
         WHERE status = 'active'
           AND (medicine_name LIKE ? OR brand_name LIKE ? OR generic_name LIKE ?)
         ORDER BY LENGTH(medicine_name) ASC
         LIMIT ?`,
        [searchTerm, searchTerm, searchTerm, safeLimit]
      );
      
      return res.json({ success: true, data: rows });
    } catch (err) {
      console.error("Catalog search error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to search catalog",
      });
    }
  }
);

/* ============================================================
   GET single medicine by ID (with catalog + category joined)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.medicines.view' permission
============================================================ */
router.get(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const { id } = req.params;

      // ─── Validate id is a positive integer (security + prevents SQL errors) ───
      const medicineId = Number(id);
      if (!Number.isInteger(medicineId) || medicineId <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid medicine ID",
        });
      }

      // ─── Fetch the medicine with its catalog + category + stock in scope ───
      const row = await fetchMedicine(
        req,
        medicineId,
        ", md.medicine_image, pc.status AS category_status"
      );

      if (!row) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found",
        });
      }

      // Batches still counted in packs (all branches) — what setting a pack size would re-pack
      const [[pk]] = await db.query(
        `SELECT COUNT(*) AS batches, COALESCE(SUM(quantity_available), 0) AS packs,
                SUM(quantity_available > 0) AS with_stock
           FROM pharmacy_medicine_batches
          WHERE admin_id = ? AND medicine_id = ? AND units_per_pack = 1`,
        [row.admin_id, medicineId]
      );
      row.packed_batches = {
        batches: Number(pk.batches) || 0,
        with_stock: Number(pk.with_stock) || 0,
        packs: Number(pk.packs) || 0,
      };

      return res.json({
        success: true,
        data: row,
      });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("Get medicine error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch medicine",
      });
    }
  }
);

/* ============================================================
   UPDATE medicine
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.medicines.edit' permission
   NOTE: medicine_data_id CANNOT be changed after creation.
         To swap the underlying medicine, delete + re-add.
============================================================ */
router.put(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
      const {
        category_id,
        gst_percentage,
        purchase_price,
        selling_price,
        reorder_level,
        maximum_stock,
        prescription_required,
          return_policy,     
        status,
      } = req.body;

      // Verify ownership
      const [existing] = await db.query(
        `SELECT id, reorder_level, maximum_stock, units_per_pack, pack_size FROM pharmacy_medicines 
         WHERE id = ? AND admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found",
        });
      }

      const updates = [];
      const params = [];

      // ── category_id ──
      if (category_id !== undefined) {
        const [catCheck] = await db.query(
          `SELECT id FROM pharmacy_categories 
           WHERE id = ? AND admin_id = ? AND status = 'active' LIMIT 1`,
          [category_id, tenantAdminId]
        );
        if (!catCheck.length) {
          return res.status(404).json({
            success: false,
            message: "Category not found in your organization",
          });
        }
        updates.push("category_id = ?");
        params.push(category_id);
      }

      // ── Text fields (a number sent for a text field is fine: "30049099" or 30049099) ──
      for (const [key, [label, max]] of Object.entries(TEXT_LIMITS)) {
        const val = textField(req.body[key], label, max);
        if (val !== undefined) {
          updates.push(`${key} = ?`);
          params.push(val);
        }
      }

      // ── units_per_pack (tablets per strip — the default for the NEXT purchase; batches keep theirs) ──
      //    EXCEPT when it goes from an effective 1 to N > 1: the batches still counted in packs
      //    (units_per_pack = 1) are RE-PACKED below, in the same transaction.
      let repackTo = null;
      if (req.body.units_per_pack !== undefined) {
        const upp = cleanUnitsPerPack(req.body.units_per_pack);
        if (!upp) {
          return res.status(400).json({
            success: false,
            message: "Enter how many tablets are in one strip (1 for a bottle, tube or injection)",
          });
        }
        updates.push("units_per_pack = ?");
        params.push(upp);
        if (upp > 1 && unitsPerPack(existing[0]) === 1) repackTo = upp;
      }

      // ── gst_percentage ──
      const gst = numberField(gst_percentage, "GST percentage");
      if (gst !== undefined) {
        if (gst > 100) {
          return res.status(400).json({
            success: false,
            message: "GST percentage must be between 0 and 100",
          });
        }
        updates.push("gst_percentage = ?");
        params.push(gst);
      }

      // ── purchase_price / selling_price (per strip) ──
      const purchase = numberField(purchase_price, "Purchase price");
      if (purchase !== undefined) {
        updates.push("purchase_price = ?");
        params.push(purchase);
      }
      const selling = numberField(selling_price, "Selling price");
      if (selling !== undefined) {
        updates.push("selling_price = ?");
        params.push(selling);
      }

      // ── reorder_level / maximum_stock (in strips) ──
      const reorder = numberField(reorder_level, "Reorder level", { int: true, max: 4000000000 });
      if (reorder !== undefined) {
        updates.push("reorder_level = ?");
        params.push(reorder);
      }
      const maxStock = numberField(maximum_stock, "Maximum stock", { int: true, max: 4000000000, empty: null });
      if (maxStock !== undefined) {
        updates.push("maximum_stock = ?");
        params.push(maxStock);
      }
      const nextReorder = reorder !== undefined ? reorder : Number(existing[0].reorder_level) || 0;
      const nextMax = maxStock !== undefined ? maxStock : existing[0].maximum_stock;
      if ((reorder !== undefined || maxStock !== undefined) && nextMax != null && nextMax > 0 && nextMax < nextReorder) {
        return res.status(400).json({
          success: false,
          message: "Maximum stock can't be below the reorder level",
        });
      }

      // ── prescription_required ──
      if (prescription_required !== undefined) {
        updates.push("prescription_required = ?");
        params.push(prescription_required ? 1 : 0);
      }


      // ── return_policy ──
          if (return_policy !== undefined) {
            let normalized;
            try {
              normalized =
                return_policy === null
                  ? null
                  : parseReturnPolicy(return_policy);
            } catch (e) {
              return res.status(400).json({
                success: false,
                message: `Invalid return_policy: ${e.message}`,
              });
            }
            updates.push("return_policy = ?");
            params.push(normalized ? JSON.stringify(normalized) : null);
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

      // One transaction: the medicine + (when its pack size is first set) the re-packed batches
      const repacked = [];
      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        let toRepack = [];
        if (repackTo) {
          [toRepack] = await conn.query(
            `SELECT * FROM pharmacy_medicine_batches
              WHERE admin_id = ? AND medicine_id = ? AND units_per_pack = 1
              ORDER BY id ASC FOR UPDATE`,
            [tenantAdminId, id]
          );
        }
        await conn.query(
          `UPDATE pharmacy_medicines 
           SET ${updates.join(", ")} 
           WHERE id = ? AND admin_id = ?`,
          params
        );
        for (const batch of toRepack) {
          const r = await repackBatch(conn, { adminId: tenantAdminId, userId: req.user.id, batch, upp: repackTo });
          if (r) repacked.push(r);
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      } finally {
        conn.release();
      }

      // Return updated row with joined data + stock
      const updated = await fetchMedicine(req, id);
      const packs = repacked.reduce((t, r) => t + r.packs, 0);
      const tablets = repacked.reduce((t, r) => t + r.tablets, 0);

      return res.json({
        success: true,
        message: repacked.length
          ? `Medicine updated · ${repacked.length} ${repacked.length === 1 ? "batch" : "batches"} recounted: ${packs} ${packs === 1 ? "pack" : "packs"} → ${tablets} tablets`
          : "Medicine updated successfully",
        data: updated,
        repacked: repacked.length ? { units_per_pack: repackTo, batches: repacked.length, packs, tablets, rows: repacked } : null,
      });
    } catch (err) {
      if (sendFieldError(res, err)) return;
      if (sendBranchError(res, err)) return;
      console.error("Update medicine error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update medicine",
      });
    }
  }
);

/* ============================================================
   SOFT DELETE (set inactive)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.medicines.delete' permission
============================================================ */
router.delete(
  "/:id",
  authMiddleware,
  allowPermissions("pharmacy.medicines.delete"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      // Verify ownership
      const [existing] = await db.query(
        `SELECT pm.id, md.medicine_name 
         FROM pharmacy_medicines pm
         JOIN medicine_data md ON md.id = pm.medicine_data_id
         WHERE pm.id = ? AND pm.admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found",
        });
      }

      await db.query(
        `UPDATE pharmacy_medicines 
         SET status = 'inactive' 
         WHERE id = ? AND admin_id = ?`,
        [id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `'${existing[0].medicine_name}' has been deactivated`,
      });
    } catch (err) {
      console.error("Delete medicine error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to deactivate medicine",
      });
    }
  }
);

/* ============================================================
   TOGGLE STATUS (activate / deactivate)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.medicines.edit' permission
============================================================ */
router.patch(
  "/:id/status",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [existing] = await db.query(
        `SELECT pm.id, pm.status, md.medicine_name 
         FROM pharmacy_medicines pm
         JOIN medicine_data md ON md.id = pm.medicine_data_id
         WHERE pm.id = ? AND pm.admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found",
        });
      }

      const newStatus =
        existing[0].status === "active" ? "inactive" : "active";

      await db.query(
        `UPDATE pharmacy_medicines 
         SET status = ? 
         WHERE id = ? AND admin_id = ?`,
        [newStatus, id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `'${existing[0].medicine_name}' ${newStatus === "active" ? "activated" : "deactivated"}`,
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
   LOOKUP by barcode (for POS / billing screen)
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.medicines.view' permission
============================================================ */
router.get(
  "/lookup/barcode/:barcode",
  authMiddleware,
  // M7: billing screens need this read — a cashier holding only pharmacy.sales.create must be able to use it
  allowPermissions("pharmacy.medicines.view", "pharmacy.sales.create"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { barcode } = req.params;

      if (!barcode || !barcode.trim()) {
        return res.status(400).json({
          success: false,
          message: "Barcode is required",
        });
      }

      const [rows] = await db.query(
        `SELECT 
           pm.id, pm.medicine_data_id, pm.category_id,
           pm.manufacturer, pm.pack_size, pm.units_per_pack, pm.storage_location, pm.unit,
           pm.medicine_code, pm.barcode, pm.hsn_code,
           pm.gst_percentage, pm.purchase_price, pm.selling_price,
           pm.return_policy, 
           pm.prescription_required, pm.status,
           md.medicine_name, md.brand_name, md.dosage_form, md.strength,
           pc.category_name
         FROM pharmacy_medicines pm
         JOIN medicine_data md       ON md.id = pm.medicine_data_id
         JOIN pharmacy_categories pc ON pc.id = pm.category_id
         WHERE pm.admin_id = ? AND pm.barcode = ? AND pm.status = 'active'
         LIMIT 1`,
        [tenantAdminId, barcode.trim()]
      );

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found for this barcode",
        });
      }

      // Stock — 26 Oct 2026. The scan used to return the medicine with no stock at all, so
      // the counter couldn't tell whether THIS branch holds it. Same fields, in the same
      // branch scope, as the medicine search (stock_strips, stock_text, stock_branch, …).
      // Additive: every field the scan returned before is still here. Selling is still
      // gated where it always was — POS addMedicine() refuses an item with no stock in the
      // branch — so this informs the counter, it doesn't change what can be billed.
      const withStock = await fetchMedicine(req, rows[0].id);

      return res.json({
        success: true,
        data: withStock ? { ...rows[0], ...withStock } : rows[0],
      });
    } catch (err) {
      console.error("Barcode lookup error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to lookup barcode",
      });
    }
  }
);

/* ============================================================
   REORDER LIST — medicines running LOW, per branch
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.medicines.view' permission
   Low = fewer full strips in stock than reorder_level (both in strips).
   Strips in stock = Σ floor(tablets ÷ the batch's units_per_pack) over active, unexpired
   batches in scope (staff: own branch; admin: all branches, or ?branch=).
   Response rows add: stock_tablets, stock_strips, stock_text, shortfall_strips,
   suggested_strips (up to maximum_stock when set, else the shortfall).
============================================================ */
router.get(
  "/reports/reorder-list",
  authMiddleware,
  allowPermissions("pharmacy.medicines.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const scope = await resolveScope(db, req, { wanted: req.query.branch });
      const sj = stockJoin(scope, tenantAdminId);

      const [rows] = await db.query(
        `SELECT 
           pm.id, pm.medicine_code, pm.barcode,
           pm.reorder_level, pm.maximum_stock,
           pm.manufacturer, pm.purchase_price, pm.selling_price,
           pm.pack_size, pm.units_per_pack, pm.unit, pm.storage_location,
           md.medicine_name, md.brand_name, md.dosage_form, md.strength,
           pc.category_name,
           st.stock_tablets, st.stock_strips, st.stock_loose, st.batch_count, st.nearest_expiry
         FROM pharmacy_medicines pm
         JOIN medicine_data md       ON md.id = pm.medicine_data_id
         JOIN pharmacy_categories pc ON pc.id = pm.category_id
         ${sj.sql}
         WHERE pm.admin_id = ? 
           AND pm.status = 'active'
           AND pm.reorder_level > 0
           AND COALESCE(st.stock_strips, 0) < pm.reorder_level
         ORDER BY (CAST(pm.reorder_level AS SIGNED) - COALESCE(st.stock_strips, 0)) DESC, md.medicine_name ASC`,
        [...sj.params, tenantAdminId]
      );

      const locMap = await locationsFor(tenantAdminId, scope, rows.map((r) => r.id));
      const data = rows.map((r) => {
        decorate(r, locMap, scope);
        const max = Number(r.maximum_stock) || 0;
        r.suggested_strips = max > r.stock_strips ? max - r.stock_strips : r.shortfall_strips;
        return r;
      });

      return res.json({
        success: true,
        data,
        total: data.length,
        branch: scope.filter ? scope.branch : null,
      });
    } catch (err) {
      if (sendBranchError(res, err)) return;
      console.error("Reorder list error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch reorder list",
      });
    }
  }
);


/* ============================================================
   UPDATE just the return policy for a medicine
   Access:
     - admin (bypass)
     - any staff role with 'pharmacy.medicines.edit' permission
   Body:
     { return_policy: { is_returnable, window_days, condition, ... } }
     OR
     { return_policy: null }   // reset to default on next read
============================================================ */
router.patch(
  "/:id/return-policy",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;
      const { return_policy } = req.body;

      // Verify ownership
      const [existing] = await db.query(
        `SELECT pm.id, md.medicine_name 
           FROM pharmacy_medicines pm
           JOIN medicine_data md ON md.id = pm.medicine_data_id
          WHERE pm.id = ? AND pm.admin_id = ? LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Medicine not found",
        });
      }

      let normalized;
      try {
        normalized =
          return_policy === null || return_policy === undefined
            ? null
            : parseReturnPolicy(return_policy);
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: `Invalid return_policy: ${e.message}`,
        });
      }

      await db.query(
        `UPDATE pharmacy_medicines 
            SET return_policy = ? 
          WHERE id = ? AND admin_id = ?`,
        [normalized ? JSON.stringify(normalized) : null, id, tenantAdminId]
      );

      return res.json({
        success: true,
        message: `Return policy updated for '${existing[0].medicine_name}'`,
        data: {
          id: Number(id),
          return_policy: normalized,
        },
      });
    } catch (err) {
      console.error("Update return policy error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update return policy",
      });
    }
  }
);

/* ============================================================
   BULK UPDATE return policy by category
   Access: admin only (via allowPermissions)
   Body:
     { category_id: 5, return_policy: {...} }
============================================================ */
router.post(
  "/bulk/return-policy",
  authMiddleware,
  allowPermissions("pharmacy.medicines.edit"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { category_id, return_policy } = req.body;

      if (!category_id) {
        return res.status(400).json({
          success: false,
          message: "category_id is required",
        });
      }

      let normalized;
      try {
        normalized = parseReturnPolicy(return_policy);
        if (!normalized) {
          return res.status(400).json({
            success: false,
            message: "return_policy is required",
          });
        }
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: `Invalid return_policy: ${e.message}`,
        });
      }

      const [result] = await db.query(
        `UPDATE pharmacy_medicines 
            SET return_policy = ?
          WHERE admin_id = ? AND category_id = ?`,
        [JSON.stringify(normalized), tenantAdminId, category_id]
      );

      return res.json({
        success: true,
        message: `Return policy applied to ${result.affectedRows} medicines`,
        affected: result.affectedRows,
      });
    } catch (err) {
      console.error("Bulk update return policy error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to bulk update return policy",
      });
    }
  }
);



module.exports = router;