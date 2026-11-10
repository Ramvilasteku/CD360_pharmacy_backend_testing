// routes/pharmacy/stock-transactions.js

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
const { recordMove } = require("../../utils/pharmacyStock");
const { resolveScope, batchFilter, sendBranchError } = require("../../utils/pharmacyBranch");

/* ============================================================
   BRANCH (6 Nov 2026) — the ledger has no branch column. A movement belongs to the branch
   of the BATCH it moved, so the read endpoints filter on pmb.branch (strict, the same rule
   as live stock and the POS):
     staff, several branches   always their own branch — ?branch is ignored
     admin, several branches   every branch, or ?branch=<name> for one
     one branch / none         no filter
   A movement with no batch, or on a batch with no branch, shows only under All branches.
   Returns the condition WITHOUT a leading AND, for the where[] arrays below.
============================================================ */
async function ledgerScope(req) {
  const scope = await resolveScope(db, req, { wanted: req.query.branch });
  const f = batchFilter(scope, "pmb");
  return {
    scope,
    sql: f.sql ? f.sql.replace(/^\s*AND\s+/i, "") : "",
    params: f.params,
  };
}

/* ============================================================
   IMMUTABLE AUDIT LEDGER
   This table records every stock movement — purchase, sale,
   dispense, return, adjustment, expiry, damage, opening stock.
   Once written, a row is NEVER updated or deleted. Corrections
   go in as a NEW row with transaction_type = 'adjustment'.
   That's why this file has no PUT / DELETE endpoints.
============================================================ */

const VALID_TYPES = [
  "purchase",
  "sale",
  "dispense",
  "return",
  "purchase_return",
  "adjustment",
  "expired",
  "damaged",
  "opening_stock",
  "transfer_out",
  "transfer_in",
  "transfer_return",
];

/* ============================================================
   Helper: resolve tenant admin_id from req.user
============================================================ */
function getTenantAdminId(req) {
  const { role, id, adminId } = req.user;
  return role === "admin" ? id : adminId;
}

/* ============================================================
   Core: record a stock transaction inside an existing DB
   connection/transaction. Callable from other route files
   (sale, dispense, purchase, etc.) so the balance logic lives
   in ONE place.

   The caller must:
     - have started a transaction on `conn` (conn.beginTransaction())
     - handle commit / rollback itself

   Returns: { id, previous_balance, new_balance }
   Throws:  Error with .status (400 / 404) for validation / not-found
            so the caller can respond appropriately.
============================================================ */
async function recordStockTransaction(conn, tenantAdminId, createdByUserId, data) {
  const {
    medicine_id,
    batch_id,
    transaction_type,
    reference_id,
    reference_number,
    quantity_in = 0,
    quantity_out = 0,
    transaction_date,
    notes,
  } = data || {};

  // ---- Validation ----
  if (!medicine_id) {
    const e = new Error("medicine_id is required");
    e.status = 400;
    throw e;
  }
  if (!VALID_TYPES.includes(transaction_type)) {
    const e = new Error(
      `Invalid transaction_type. Must be one of: ${VALID_TYPES.join(", ")}`
    );
    e.status = 400;
    throw e;
  }

  const qtyIn = Number(quantity_in) || 0;
  const qtyOut = Number(quantity_out) || 0;

  if (qtyIn < 0 || qtyOut < 0) {
    const e = new Error("Quantities cannot be negative");
    e.status = 400;
    throw e;
  }
  if (qtyIn === 0 && qtyOut === 0) {
    const e = new Error(
      "At least one of quantity_in or quantity_out must be greater than 0"
    );
    e.status = 400;
    throw e;
  }
  if (qtyIn > 0 && qtyOut > 0) {
    const e = new Error(
      "A single transaction cannot have both quantity_in and quantity_out"
    );
    e.status = 400;
    throw e;
  }

  // ---- Verify medicine belongs to this tenant ----
  const [med] = await conn.query(
    `SELECT id FROM pharmacy_medicines
     WHERE id = ? AND admin_id = ? LIMIT 1`,
    [medicine_id, tenantAdminId]
  );
  if (!med.length) {
    const e = new Error("Medicine not found for this tenant");
    e.status = 404;
    throw e;
  }

  // ---- If batch given, verify it belongs to this medicine + tenant ----
  if (batch_id) {
    const [batch] = await conn.query(
      `SELECT id FROM pharmacy_medicine_batches
       WHERE id = ? AND medicine_id = ? AND admin_id = ? LIMIT 1`,
      [batch_id, medicine_id, tenantAdminId]
    );
    if (!batch.length) {
      const e = new Error("Batch not found for this medicine + tenant");
      e.status = 404;
      throw e;
    }
  }

  // ---- Balance after this movement ----
  // For a batch, the balance IS the batch's quantity_available (in tablets) — the caller has
  // already moved the stock, normally with utils/pharmacyStock.recordMove(). Reading it from the
  // batch keeps the ledger and the shelf in agreement, even though older ledger rows were
  // written in strips or skipped altogether.
  // Without a batch (rare: a medicine-level opening balance) the running sum is used as before.
  let previousBalance;
  let newBalance;
  if (batch_id) {
    const [[b]] = await conn.query(
      `SELECT quantity_available FROM pharmacy_medicine_batches WHERE id = ? AND admin_id = ? FOR UPDATE`,
      [batch_id, tenantAdminId]
    );
    newBalance = Number(b.quantity_available) || 0;
    previousBalance = newBalance - qtyIn + qtyOut;
  } else {
    const [last] = await conn.query(
      `SELECT balance_quantity
       FROM pharmacy_stock_transactions
       WHERE admin_id = ? AND medicine_id = ? AND batch_id IS NULL
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [tenantAdminId, medicine_id]
    );
    previousBalance = last.length ? Number(last[0].balance_quantity) : 0;
    newBalance = previousBalance + qtyIn - qtyOut;
    if (newBalance < 0) {
      const e = new Error(`Insufficient stock. Current balance: ${previousBalance}, requested out: ${qtyOut}`);
      e.status = 400;
      throw e;
    }
  }

  // ---- Insert the transaction ----
  const [result] = await conn.query(
    `INSERT INTO pharmacy_stock_transactions
      (admin_id, medicine_id, batch_id, transaction_type,
       reference_id, reference_number,
       quantity_in, quantity_out, balance_quantity,
       transaction_date, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${transaction_date ? "?" : "DEFAULT"}, ?, ?)`,
    transaction_date
      ? [
          tenantAdminId,
          medicine_id,
          batch_id || null,
          transaction_type,
          reference_id || null,
          reference_number ? String(reference_number).trim() : null,
          qtyIn,
          qtyOut,
          newBalance,
          transaction_date,
          notes ? String(notes).trim() : null,
          createdByUserId || null,
        ]
      : [
          tenantAdminId,
          medicine_id,
          batch_id || null,
          transaction_type,
          reference_id || null,
          reference_number ? String(reference_number).trim() : null,
          qtyIn,
          qtyOut,
          newBalance,
          notes ? String(notes).trim() : null,
          createdByUserId || null,
        ]
  );

  return {
    id: result.insertId,
    previous_balance: previousBalance,
    new_balance: newBalance,
  };
}

function buildLedgerFilters(query, tenantAdminId, branch = null) {
  const { medicine_id, batch_id, direction, search, date_from, date_to } = query;
  const transaction_type = query.transaction_type || query.type;
 
  const where = ["st.admin_id = ?"];
  const params = [tenantAdminId];

  // branch = ledgerScope(req) — LEDGER_FROM already joins pmb
  if (branch && branch.sql) {
    where.push(branch.sql);
    params.push(...branch.params);
  }
 
  if (medicine_id) {
    where.push("st.medicine_id = ?");
    params.push(medicine_id);
  }
  if (batch_id) {
    where.push("st.batch_id = ?");
    params.push(batch_id);
  }
  if (transaction_type) {
    if (!VALID_TYPES.includes(transaction_type)) {
      return {
        error: `Unknown transaction_type '${transaction_type}'. Valid: ${VALID_TYPES.join(", ")}`,
      };
    }
    where.push("st.transaction_type = ?");
    params.push(transaction_type);
  }
  if (direction === "in") where.push("COALESCE(st.quantity_in, 0) > 0");
  else if (direction === "out") where.push("COALESCE(st.quantity_out, 0) > 0");
 
  // DATE() so a bare '2026-11-04' includes the whole day
  if (date_from) {
    where.push("DATE(st.transaction_date) >= ?");
    params.push(date_from);
  }
  if (date_to) {
    where.push("DATE(st.transaction_date) <= ?");
    params.push(date_to);
  }
 
  if (search && String(search).trim()) {
    const like = `%${String(search).trim()}%`;
    where.push(`(
      md.medicine_name LIKE ? OR
      md.brand_name LIKE ? OR
      md.generic_name LIKE ? OR
      pm.medicine_code LIKE ? OR
      pmb.batch_number LIKE ? OR
      st.reference_number LIKE ?
    )`);
    params.push(like, like, like, like, like, like);
  }
 
  return { where, params };
}
 
// Joins needed by the search filter (medicine name / code / batch)
const LEDGER_FROM = `
  FROM pharmacy_stock_transactions st
  LEFT JOIN pharmacy_medicines pm         ON pm.id  = st.medicine_id
  LEFT JOIN medicine_data md              ON md.id  = pm.medicine_data_id
  LEFT JOIN pharmacy_medicine_batches pmb ON pmb.id = st.batch_id
`;

/* ============================================================
   CREATE stock transaction (direct HTTP)
   Mostly used for: opening_stock, adjustment, expired, damaged.
   Sale / dispense / purchase should call recordStockTransaction()
   from within their own endpoint's transaction.
   Access:
     - admin (bypass)
     - staff with 'pharmacy.stock.create'
============================================================ */
router.post(
  "/post",
  authMiddleware,
  allowPermissions("pharmacy.stock.create"),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const tenantAdminId = getTenantAdminId(req);
      const body = req.body || {};
      let result;
      if (body.batch_id) {
        // A movement on a batch must change the batch too, or the ledger and the shelf drift
        // apart. recordMove() does both (quantities are tablets).
        // Sales, purchases, returns and transfers move stock through their own screens; a manual
        // entry here is only an opening balance or a correction / write-off.
        const MANUAL_TYPES = ["opening_stock", "adjustment", "expired", "damaged"];
        if (!MANUAL_TYPES.includes(body.transaction_type)) {
          const e = new Error(`A manual stock entry must be one of: ${MANUAL_TYPES.join(", ")}`);
          e.status = 400;
          throw e;
        }
        // Branch rule: staff only touch their own branch's batches (admin: any, or the one picked)
        const scope = await resolveScope(db, req, { wanted: body.branch });
        const f = batchFilter(scope, "b");
        const [[own]] = await conn.query(
          `SELECT b.id FROM pharmacy_medicine_batches b
            WHERE b.id = ? AND b.medicine_id = ? AND b.admin_id = ? ${f.sql}`,
          [body.batch_id, body.medicine_id, tenantAdminId, ...f.params]
        );
        if (!own) {
          const e = new Error(scope.filter ? `That batch is not in ${scope.branch}.` : "Batch not found for this medicine");
          e.status = 404;
          throw e;
        }
        const newBalance = await recordMove(conn, {
          adminId: tenantAdminId,
          userId: req.user.id,
          batchId: body.batch_id,
          tabletsIn: body.quantity_in,
          tabletsOut: body.quantity_out,
          type: body.transaction_type,
          referenceId: body.reference_id,
          referenceNumber: body.reference_number,
          notes: body.notes,
          date: body.transaction_date,
        });
        const [[last]] = await conn.query(
          `SELECT id FROM pharmacy_stock_transactions WHERE admin_id = ? AND batch_id = ? ORDER BY id DESC LIMIT 1`,
          [tenantAdminId, body.batch_id]
        );
        result = {
          id: last.id,
          new_balance: newBalance,
          previous_balance: newBalance - (Number(body.quantity_in) || 0) + (Number(body.quantity_out) || 0),
        };
      } else {
        result = await recordStockTransaction(conn, tenantAdminId, req.user.id, body);
      }

      await conn.commit();

      const [row] = await db.query(
        `SELECT id, admin_id, medicine_id, batch_id, transaction_type,
                reference_id, reference_number,
                quantity_in, quantity_out, balance_quantity,
                transaction_date, notes, created_by
         FROM pharmacy_stock_transactions WHERE id = ?`,
        [result.id]
      );

      return res.status(201).json({
        success: true,
        message: "Stock transaction recorded",
        data: row[0],
        previous_balance: result.previous_balance,
        new_balance: result.new_balance,
      });
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (err.status) {
        return res
          .status(err.status)
          .json({ success: false, message: err.message, ...(err.extra || {}) });
      }
      console.error("Create stock txn error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to record stock transaction",
      });
    } finally {
      conn.release();
    }
  }
);

/* ============================================================
   LIST stock transactions (with filters)
   Query params:
     - medicine_id
     - batch_id
     - transaction_type
     - date_from (YYYY-MM-DD or ISO)
     - date_to
     - page, limit
     - sort_order — ASC | DESC (default DESC = newest first)
   Access:
     - admin (bypass)
     - staff with 'pharmacy.stock.view'
============================================================ */
/* ============================================================
   GET /get: paginated stock ledger with medicine + batch details
   Query: search, type | transaction_type, direction (in|out),
          date_from, date_to, medicine_id, batch_id,
          page, limit, sort_order
============================================================ */
router.get(
  "/get",
  authMiddleware,
  allowPermissions("pharmacy.stock.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const {
        medicine_id,
        batch_id,
        direction,
        search,
        date_from,
        date_to,
        page = 1,
        limit = 20,
        sort_order = "DESC",
      } = req.query;

      // Frontend sends "type"; accept both
      const transaction_type = req.query.transaction_type || req.query.type;

      const where = ["st.admin_id = ?"];
      const params = [tenantAdminId];

      const br = await ledgerScope(req);
      if (br.sql) {
        where.push(br.sql);
        params.push(...br.params);
      }

      if (medicine_id) {
        where.push("st.medicine_id = ?");
        params.push(medicine_id);
      }
      if (batch_id) {
        where.push("st.batch_id = ?");
        params.push(batch_id);
      }
      if (transaction_type) {
        if (!VALID_TYPES.includes(transaction_type)) {
          return res.status(400).json({
            success: false,
            message: `Unknown transaction_type '${transaction_type}'. Valid: ${VALID_TYPES.join(", ")}`,
          });
        }
        where.push("st.transaction_type = ?");
        params.push(transaction_type);
      }
      if (direction === "in") where.push("COALESCE(st.quantity_in, 0) > 0");
      else if (direction === "out") where.push("COALESCE(st.quantity_out, 0) > 0");

      // DATE() so the whole "to" day is included
      if (date_from) {
        where.push("DATE(st.transaction_date) >= ?");
        params.push(date_from);
      }
      if (date_to) {
        where.push("DATE(st.transaction_date) <= ?");
        params.push(date_to);
      }

      if (search && String(search).trim()) {
        const like = `%${String(search).trim()}%`;
        where.push(`(
          md.medicine_name LIKE ? OR
          md.brand_name LIKE ? OR
          md.generic_name LIKE ? OR
          pm.medicine_code LIKE ? OR
          pmb.batch_number LIKE ? OR
          st.reference_number LIKE ?
        )`);
        params.push(like, like, like, like, like, like);
      }

      const whereClause = where.join(" AND ");
      const safeLimit = Math.min(200, Math.max(1, Number(limit) || 20));
      const safePage = Math.max(1, Number(page) || 1);
      const offset = (safePage - 1) * safeLimit;
      const safeSortOrder = sort_order === "ASC" ? "ASC" : "DESC";

      const fromJoins = `
        FROM pharmacy_stock_transactions st
        LEFT JOIN pharmacy_medicines pm         ON pm.id  = st.medicine_id
        LEFT JOIN medicine_data md              ON md.id  = pm.medicine_data_id
        LEFT JOIN pharmacy_medicine_batches pmb ON pmb.id = st.batch_id
      `;

      const [countRes] = await db.query(
        `SELECT COUNT(*) AS total ${fromJoins} WHERE ${whereClause}`,
        params
      );

      const [rows] = await db.query(
        `SELECT st.id, st.admin_id, st.medicine_id, st.batch_id, st.transaction_type,
                st.reference_id, st.reference_number,
                st.quantity_in, st.quantity_out, st.balance_quantity,
                st.transaction_date, st.notes, st.created_by,
                md.medicine_name, md.brand_name, md.generic_name,
                md.strength, md.dosage_form,
                pm.medicine_code,
                pmb.batch_number, pmb.expiry_date
         ${fromJoins}
         WHERE ${whereClause}
         ORDER BY st.transaction_date ${safeSortOrder}, st.id ${safeSortOrder}
         LIMIT ? OFFSET ?`,
        [...params, safeLimit, offset]
      );

      const data = rows.map((r) => {
        const name = r.medicine_name || r.brand_name || r.generic_name;
        return {
          ...r,
          quantity_in: Number(r.quantity_in) || 0,
          quantity_out: Number(r.quantity_out) || 0,
          // Label shown in the Medicine column
          medicine: name
            ? [name, r.strength].filter(Boolean).join(" ")
            : `Medicine #${r.medicine_id}`,
        };
      });

      const total = Number(countRes[0].total) || 0;

      return res.json({
        success: true,
        data,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total,
          total_pages: Math.ceil(total / safeLimit),
        },
      });
    } catch (err) {
      if (sendBranchError(res, err)) return undefined;
      console.error("List stock txns error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch stock transactions",
      });
    }
  }
);

/* ============================================================
   LEDGER view for a single medicine (chronological, oldest first)
   Good for the "stock history" screen on a medicine detail page.
============================================================ */
router.get(
  "/ledger/medicine/:medicine_id",
  authMiddleware,
  allowPermissions("pharmacy.stock.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { medicine_id } = req.params;
      const { batch_id } = req.query;

      const where = ["admin_id = ?", "medicine_id = ?"];
      const params = [tenantAdminId, medicine_id];

      if (batch_id) {
        where.push("batch_id = ?");
        params.push(batch_id);
      }

      const [rows] = await db.query(
        `SELECT id, batch_id, transaction_type,
                reference_id, reference_number,
                quantity_in, quantity_out, balance_quantity,
                transaction_date, notes, created_by
         FROM pharmacy_stock_transactions
         WHERE ${where.join(" AND ")}
         ORDER BY transaction_date ASC, id ASC`,
        params
      );

      return res.json({
        success: true,
        medicine_id: Number(medicine_id),
        batch_id: batch_id ? Number(batch_id) : null,
        count: rows.length,
        data: rows,
      });
    } catch (err) {
      console.error("Ledger view error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch ledger",
      });
    }
  }
);

/* ============================================================
   CURRENT BALANCE for a medicine
   - If batch_id in query → returns balance for that batch
   - Otherwise → returns balance per batch + a rolled-up total
============================================================ */
router.get(
  "/balance/medicine/:medicine_id",
  authMiddleware,
  allowPermissions("pharmacy.stock.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { medicine_id } = req.params;
      const { batch_id } = req.query;

      if (batch_id) {
        const [rows] = await db.query(
          `SELECT balance_quantity, transaction_date
           FROM pharmacy_stock_transactions
           WHERE admin_id = ? AND medicine_id = ? AND batch_id = ?
           ORDER BY id DESC
           LIMIT 1`,
          [tenantAdminId, medicine_id, batch_id]
        );

        return res.json({
          success: true,
          medicine_id: Number(medicine_id),
          batch_id: Number(batch_id),
          balance: rows.length ? Number(rows[0].balance_quantity) : 0,
          last_transaction_date: rows.length ? rows[0].transaction_date : null,
        });
      }

      // Latest balance per batch for this medicine
      const [perBatch] = await db.query(
        `SELECT t1.batch_id,
                t1.balance_quantity,
                t1.transaction_date
         FROM pharmacy_stock_transactions t1
         WHERE t1.admin_id = ?
           AND t1.medicine_id = ?
           AND t1.id = (
             SELECT MAX(t2.id)
             FROM pharmacy_stock_transactions t2
             WHERE t2.admin_id = t1.admin_id
               AND t2.medicine_id = t1.medicine_id
               AND (t2.batch_id <=> t1.batch_id)
           )
         ORDER BY t1.batch_id`,
        [tenantAdminId, medicine_id]
      );

      const total = perBatch.reduce(
        (sum, r) => sum + Number(r.balance_quantity),
        0
      );

      return res.json({
        success: true,
        medicine_id: Number(medicine_id),
        total_balance: total,
        batches: perBatch,
      });
    } catch (err) {
      console.error("Balance lookup error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch balance",
      });
    }
  }
);

router.get(
  "/types",
  authMiddleware,
  allowPermissions("pharmacy.stock.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const br = await ledgerScope(req);
 
      const [rows] = await db.query(
        `SELECT st.transaction_type AS type, COUNT(*) AS count
         FROM pharmacy_stock_transactions st
         LEFT JOIN pharmacy_medicine_batches pmb ON pmb.id = st.batch_id
         WHERE st.admin_id = ?
           AND st.transaction_type IS NOT NULL
           AND st.transaction_type <> ''
           ${br.sql ? `AND ${br.sql}` : ""}
         GROUP BY st.transaction_type
         ORDER BY count DESC, st.transaction_type ASC`,
        [tenantAdminId, ...br.params]
      );
 
      return res.json({
        success: true,
        data: rows.map((r) => ({ type: r.type, count: Number(r.count) || 0 })),
      });
    } catch (err) {
      if (sendBranchError(res, err)) return undefined;
      console.error("Stock txn types error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch transaction types",
      });
    }
  }
);
 
/* ============================================================
   GET /summary
   Totals for the current filters (search, type, direction, dates).
   Ignores page/limit — it's the whole filtered set.
   Response: { success, summary: { movements, total_in, total_out, net } }
============================================================ */
router.get(
  "/summary",
  authMiddleware,
  allowPermissions("pharmacy.stock.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const filters = buildLedgerFilters(req.query, tenantAdminId, await ledgerScope(req));
 
      if (filters.error) {
        return res.status(400).json({ success: false, message: filters.error });
      }
 
      const [rows] = await db.query(
        `SELECT
           COUNT(*)                            AS movements,
           COALESCE(SUM(st.quantity_in), 0)    AS total_in,
           COALESCE(SUM(st.quantity_out), 0)   AS total_out
         ${LEDGER_FROM}
         WHERE ${filters.where.join(" AND ")}`,
        filters.params
      );
 
      // mysql2 returns SUM() as a string — convert before maths
      const movements = Number(rows[0]?.movements) || 0;
      const total_in = Number(rows[0]?.total_in) || 0;
      const total_out = Number(rows[0]?.total_out) || 0;
 
      return res.json({
        success: true,
        summary: {
          movements,
          total_in,
          total_out,
          net: total_in - total_out,
        },
      });
    } catch (err) {
      if (sendBranchError(res, err)) return undefined;
      console.error("Stock txn summary error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch stock ledger summary",
      });
    }
  }
);

/* ============================================================
   GET single transaction by ID
============================================================ */
router.get(
  "/get/:id",
  authMiddleware,
  allowPermissions("pharmacy.stock.view"),
  async (req, res) => {
    try {
      const tenantAdminId = getTenantAdminId(req);
      const { id } = req.params;

      const [rows] = await db.query(
        `SELECT id, admin_id, medicine_id, batch_id, transaction_type,
                reference_id, reference_number,
                quantity_in, quantity_out, balance_quantity,
                transaction_date, notes, created_by
         FROM pharmacy_stock_transactions
         WHERE id = ? AND admin_id = ?
         LIMIT 1`,
        [id, tenantAdminId]
      );

      if (!rows.length) {
        return res.status(404).json({
          success: false,
          message: "Stock transaction not found",
        });
      }

      return res.json({ success: true, data: rows[0] });
    } catch (err) {
      console.error("Get stock txn error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch stock transaction",
      });
    }
  }
);

/* ============================================================
   Deliberately NO PUT / DELETE.
   To correct a mistake: POST a new transaction with
   transaction_type = 'adjustment' that offsets the wrong entry.
   The bad entry stays in the ledger — that's the audit trail.
============================================================ */

// Expose the reusable writer so other route files can use it
// inside their own DB transactions.
router.recordStockTransaction = recordStockTransaction;

module.exports = router;