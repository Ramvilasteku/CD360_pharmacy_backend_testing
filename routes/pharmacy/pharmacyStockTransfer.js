// routes/pharmacy/pharmacyStockTransfer.js
//
// PURCHASE TRANSFER — move stock from one branch to another branch of the same admin.
//
// Flow:  Send  →  In transit  →  Accept (stock lands at the receiving branch)
//                             →  Reject (receiving branch refuses; stock goes back to the sender)
//                             →  Cancel (sending branch pulls it back before it is accepted)
//
// Where a branch comes from: there is no branches table. A branch is the text in staff.branch;
// a branch "exists" when at least one active staff member of this admin has it. Comparisons
// ignore case and leading/trailing spaces ("Kukatpally" = " kukatpally ").
//
// Rules enforced here:
//   • Both branches belong to the logged-in user's admin (tenant).
//   • Staff send ONLY from their own staff.branch (read from the database, never the request).
//     The admin has no branch, so the admin chooses both "from" and "to".
//   • "To" must be a different branch. Two people in the same branch cannot transfer to each
//     other — a transfer is branch → branch, not person → person.
//   • Staff with no branch cannot send, accept, reject or cancel.
//   • A batch can be sent only if it belongs to this admin, sits in the "from" branch,
//     is active, not expired, and has enough quantity (counted in tablets/units).
//   • Only the receiving branch (or the admin) can accept/reject; only the sending branch
//     (or the admin) can cancel; only while the transfer is still in transit; only once.
//   • Quantities are TABLETS (utils/pharmacyUnits.js). A line can be sent as { quantity } in tablets,
//     or as { strips, tablets } — strips × the batch's own units_per_pack + loose tablets.
//   • Accept: the receiving branch may give each line a storage_location (default: the medicine's
//     storage_location). A new batch row at the receiving branch copies the source batch's
//     units_per_pack, prices and dates and gets that location. Topping up a batch with the same
//     number that is already there needs the same expiry AND the same units_per_pack — a different
//     pack size is refused (reject the transfer instead), like Receive does.
//   • Every move goes through utils/pharmacyStock (recordMove / ledgerRow): the batch and the ledger
//     row change together, and the row's balance is the batch's real balance.
//   • Every move is written to pharmacy_stock_transactions (the ledger is never edited):
//       transfer_out    stock leaves the source batch          (send)
//       transfer_in     stock lands in the destination batch   (accept)
//       transfer_return stock goes back into the source batch  (reject / cancel)
//     All rows of one transfer share reference_number = TRF-00001, TRF-00002, …
//     The status is worked out from which rows exist; the transfer details live as JSON in
//     the notes of each row. No new tables.
//
// Mount in server.js:
//   const pharmacyStockTransfer = require("./routes/pharmacy/pharmacyStockTransfer.js");
//   app.use("/api/pharmacy/stock-transfers", pharmacyStockTransfer);
//
// Permissions: pharmacy.purchase_transfer.view / .create (send, cancel) / .edit (accept, reject)

const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowPermissions } = require("../../middlewares/allowPermissions");
const { unitsPerPack, packWord, describeStock } = require("../../utils/pharmacyUnits");
const { recordMove, ledgerRow } = require("../../utils/pharmacyStock");

const PERM = {
  view: "pharmacy.purchase_transfer.view",
  create: "pharmacy.purchase_transfer.create",
  edit: "pharmacy.purchase_transfer.edit",
};

const PREFIX = "TRF-";
const MAX_LINES = 200;
const MAX_QTY = 10000000;

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
const branchKey = (v) => clean(v).toLowerCase();
const toPosInt = (v) => {
  if (typeof v === "string" && !/^\s*\d+\s*$/.test(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const pad2 = (n) => String(n).padStart(2, "0");

// Current date/time in India (stored the same way the other pharmacy routes store it)
const istNow = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
const istToday = () => istNow().slice(0, 10);

// DATE column → "YYYY-MM-DD" whether the driver returns a Date or a string
const dateStr = (v) => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  return String(v).slice(0, 10);
};

const parseNotes = (v) => {
  if (!v) return {};
  if (typeof v === "object") return v;
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
};

const medicineLabel = (r) =>
  [r.brand_name || r.medicine_name, r.strength].filter(Boolean).join(" ") ||
  r.medicine_name ||
  `Medicine #${r.medicine_id}`;

// Express wrapper: one place that turns thrown errors into JSON responses
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, message: err.message, ...(err.extra || {}) });
    }
    console.error("Stock transfer error:", err);
    return res.status(500).json({ success: false, message: "Something went wrong with the stock transfer." });
  }
};

/* ============================================================
   Who is calling, and which branch are they in
============================================================ */
async function getActor(req) {
  const u = req.user || {};
  const isAdmin = u.userType === "admin" || u.role === "admin";
  const adminId = isAdmin ? u.id : u.adminId;
  if (!adminId) throw httpError(401, "Please log in again.");

  if (isAdmin) {
    return { isAdmin: true, adminId, userId: u.id, type: "admin", name: clean(u.name) || "Admin", branch: null, key: null };
  }

  // Always read the branch from the database — the token can be stale after a branch change.
  const [rows] = await db.query(
    `SELECT name, branch, status FROM staff WHERE id = ? AND admin_id = ? LIMIT 1`,
    [u.id, adminId]
  );
  const s = rows[0];
  if (!s || Number(s.status) !== 1) throw httpError(403, "Your staff account is not active.");
  const branch = clean(s.branch);
  return {
    isAdmin: false,
    adminId,
    userId: u.id,
    type: "staff",
    name: clean(s.name) || clean(u.name) || "Staff",
    branch: branch || null,
    key: branch ? branchKey(branch) : null,
  };
}

const requireBranch = (actor) => {
  if (!actor.isAdmin && !actor.key) {
    throw httpError(403, "Your profile has no branch. Ask your admin to set your branch before using transfers.");
  }
};

/* ============================================================
   Branch lists (no branches table — built from staff.branch)
============================================================ */
const uniqueBranches = (names) => {
  const seen = new Map();
  for (const n of names) {
    const name = clean(n);
    if (name && !seen.has(branchKey(name))) seen.set(branchKey(name), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
};

// Branches that have at least one active staff member — the only valid destinations
async function staffBranches(q, adminId) {
  const [rows] = await q.query(
    `SELECT TRIM(branch) AS branch FROM staff
      WHERE admin_id = ? AND status = 1 AND branch IS NOT NULL AND TRIM(branch) <> ''`,
    [adminId]
  );
  return uniqueBranches(rows.map((r) => r.branch));
}

// Branches that currently hold stock (an admin may need to move stock out of a branch
// whose staff have all left)
async function stockBranches(q, adminId) {
  const [rows] = await q.query(
    `SELECT DISTINCT TRIM(branch) AS branch FROM pharmacy_medicine_batches
      WHERE admin_id = ? AND branch IS NOT NULL AND TRIM(branch) <> '' AND quantity_available > 0`,
    [adminId]
  );
  return uniqueBranches(rows.map((r) => r.branch));
}

const findBranch = (list, name) => list.find((b) => branchKey(b) === branchKey(name)) || null;

/* ============================================================
   Reading a transfer
============================================================ */
// SQL that rebuilds the transfer header from the ledger.
// Every JSON read is wrapped in JSON_VALID(): other ledger rows keep plain-text notes
// ("Received against PO-12"), and MySQL 8 may evaluate these expressions on those rows too.
const HEADER_SQL = `
  SELECT t.*,
         COALESCE((
           SELECT CASE c.transaction_type
                    WHEN 'transfer_in' THEN 'received'
                    ELSE IF(JSON_VALID(c.notes), JSON_UNQUOTE(JSON_EXTRACT(c.notes, '$.action')), NULL)
                  END
             FROM pharmacy_stock_transactions c
            WHERE c.admin_id = t.admin_id
              AND c.reference_number = t.transfer_number
              AND c.transaction_type IN ('transfer_in', 'transfer_return')
            ORDER BY c.id LIMIT 1
         ), 'in_transit') AS status,
         (SELECT c.transaction_date FROM pharmacy_stock_transactions c
           WHERE c.admin_id = t.admin_id AND c.reference_number = t.transfer_number
             AND c.transaction_type IN ('transfer_in', 'transfer_return')
           ORDER BY c.id LIMIT 1) AS closed_at,
         (SELECT IF(JSON_VALID(c.notes), JSON_UNQUOTE(JSON_EXTRACT(c.notes, '$.by_name')), NULL) FROM pharmacy_stock_transactions c
           WHERE c.admin_id = t.admin_id AND c.reference_number = t.transfer_number
             AND c.transaction_type IN ('transfer_in', 'transfer_return')
           ORDER BY c.id LIMIT 1) AS closed_by_name,
         (SELECT IF(JSON_VALID(c.notes), JSON_UNQUOTE(JSON_EXTRACT(c.notes, '$.reason')), NULL) FROM pharmacy_stock_transactions c
           WHERE c.admin_id = t.admin_id AND c.reference_number = t.transfer_number
             AND c.transaction_type IN ('transfer_in', 'transfer_return')
           ORDER BY c.id LIMIT 1) AS close_reason
    FROM (
      SELECT g.admin_id,
             g.transfer_number,
             g.sent_at,
             g.line_count,
             g.total_units,
             h.created_by AS sent_by,
             IF(JSON_VALID(h.notes), JSON_UNQUOTE(JSON_EXTRACT(h.notes, '$.from_branch')), NULL) AS from_branch,
             IF(JSON_VALID(h.notes), JSON_UNQUOTE(JSON_EXTRACT(h.notes, '$.from_key')), NULL)    AS from_key,
             IF(JSON_VALID(h.notes), JSON_UNQUOTE(JSON_EXTRACT(h.notes, '$.to_branch')), NULL)   AS to_branch,
             IF(JSON_VALID(h.notes), JSON_UNQUOTE(JSON_EXTRACT(h.notes, '$.to_key')), NULL)      AS to_key,
             IF(JSON_VALID(h.notes), JSON_UNQUOTE(JSON_EXTRACT(h.notes, '$.by_name')), NULL)     AS sent_by_name,
             IF(JSON_VALID(h.notes), JSON_UNQUOTE(JSON_EXTRACT(h.notes, '$.remarks')), NULL)     AS remarks
        FROM (
          SELECT admin_id,
                 reference_number   AS transfer_number,
                 MIN(id)            AS first_id,
                 MIN(transaction_date) AS sent_at,
                 COUNT(*)           AS line_count,
                 SUM(quantity_out)  AS total_units
            FROM pharmacy_stock_transactions
           WHERE admin_id = ? AND transaction_type = 'transfer_out'
           GROUP BY admin_id, reference_number
        ) g
        JOIN pharmacy_stock_transactions h ON h.id = g.first_id
    ) t`;

const shapeHeader = (r, actor) => {
  const status = r.status || "in_transit";
  const inTransit = status === "in_transit";
  const isSender = actor.isAdmin || (actor.key && actor.key === r.from_key);
  const isReceiver = actor.isAdmin || (actor.key && actor.key === r.to_key);
  return {
    transfer_number: r.transfer_number,
    status, // in_transit | received | rejected | cancelled
    from_branch: r.from_branch,
    to_branch: r.to_branch,
    direction: actor.isAdmin ? null : actor.key === r.to_key ? "incoming" : "outgoing",
    sent_at: r.sent_at,
    sent_by: r.sent_by,
    sent_by_name: r.sent_by_name,
    remarks: r.remarks && r.remarks !== "null" ? r.remarks : null,
    line_count: Number(r.line_count) || 0,
    total_units: Number(r.total_units) || 0,
    closed_at: r.closed_at || null,
    closed_by_name: r.closed_by_name && r.closed_by_name !== "null" ? r.closed_by_name : null,
    close_reason: r.close_reason && r.close_reason !== "null" ? r.close_reason : null,
    // What this user may do (the screen still checks the permission keys on top)
    can_accept: inTransit && isReceiver,
    can_reject: inTransit && isReceiver,
    can_cancel: inTransit && isSender,
  };
};

async function getTransferDetail(q, actor, ref) {
  const [heads] = await q.query(`SELECT * FROM (${HEADER_SQL}) x WHERE x.transfer_number = ?`, [actor.adminId, ref]);
  const head = heads[0];
  if (!head) return null;
  // Staff only see transfers that involve their own branch
  if (!actor.isAdmin && actor.key !== head.from_key && actor.key !== head.to_key) return null;

  const [lines] = await q.query(
    `SELECT o.id AS line_id, o.medicine_id, o.batch_id AS source_batch_id, o.quantity_out AS quantity,
            b.batch_number, b.expiry_date, b.mrp, b.purchase_price, b.selling_price,
            b.units_per_pack, b.storage_location,
            m.medicine_code, m.pack_size, m.unit, m.storage_location AS default_location,
            md.medicine_name, md.brand_name, md.generic_name, md.strength, md.dosage_form
       FROM pharmacy_stock_transactions o
       LEFT JOIN pharmacy_medicine_batches b ON b.id = o.batch_id
       LEFT JOIN pharmacy_medicines m ON m.id = o.medicine_id
       LEFT JOIN medicine_data md ON md.id = m.medicine_data_id
      WHERE o.admin_id = ? AND o.reference_number = ? AND o.transaction_type = 'transfer_out'
      ORDER BY o.id`,
    [actor.adminId, ref]
  );

  // Which destination batch each line landed in (after accept)
  const [closing] = await q.query(
    `SELECT c.batch_id, c.notes, d.storage_location
       FROM pharmacy_stock_transactions c
       LEFT JOIN pharmacy_medicine_batches d ON d.id = c.batch_id
      WHERE c.admin_id = ? AND c.reference_number = ? AND c.transaction_type = 'transfer_in'`,
    [actor.adminId, ref]
  );
  const landedIn = new Map(closing.map((c) => [Number(parseNotes(c.notes).source_line_id), c]));

  return {
    ...shapeHeader(head, actor),
    items: lines.map((l) => ({
      line_id: l.line_id,
      medicine_id: l.medicine_id,
      name: medicineLabel(l),
      medicine_name: l.medicine_name,
      brand_name: l.brand_name,
      generic_name: l.generic_name,
      strength: l.strength,
      dosage_form: l.dosage_form,
      medicine_code: l.medicine_code,
      pack_size: l.pack_size,
      unit: l.unit,
      batch_number: l.batch_number,
      expiry_date: dateStr(l.expiry_date),
      mrp: Number(l.mrp) || 0,
      purchase_price: Number(l.purchase_price) || 0,
      selling_price: Number(l.selling_price) || 0,
      quantity: Number(l.quantity) || 0,
      units_per_pack: unitsPerPack(l),
      word: packWord(l, unitsPerPack(l)),
      qty_text: describeStock(l.quantity, unitsPerPack(l), packWord(l, unitsPerPack(l))),
      source_batch_id: l.source_batch_id,
      source_location: l.storage_location || null,
      default_location: l.default_location || null,
      destination_batch_id: landedIn.has(Number(l.line_id)) ? landedIn.get(Number(l.line_id)).batch_id : null,
      destination_location: landedIn.has(Number(l.line_id)) ? landedIn.get(Number(l.line_id)).storage_location || null : null,
    })),
  };
}

/* ============================================================
   Locking helper (stock + ledger rows go through utils/pharmacyStock)
============================================================ */
// A named lock stops two people from sending/accepting the same thing at the same moment.
// It is taken BEFORE the transaction starts, so the transaction always sees the latest data.
async function withLockedTransaction(lockName, work) {
  const conn = await db.getConnection();
  let locked = false;
  try {
    const [[l]] = await conn.query(`SELECT GET_LOCK(?, 10) AS ok`, [lockName]);
    if (!l || Number(l.ok) !== 1) throw httpError(409, "Someone else is updating this right now. Please try again.");
    locked = true;
    await conn.beginTransaction();
    try {
      const out = await work(conn);
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    if (locked) {
      try {
        await conn.query(`SELECT RELEASE_LOCK(?)`, [lockName]);
      } catch (_) {
        /* the connection is released anyway */
      }
    }
    conn.release();
  }
}

/* ============================================================
   GET /get/branches
   Branches this user can send from / to. Use it to build the form.
============================================================ */
router.get(
  "/get/branches",
  authMiddleware,
  allowPermissions(PERM.view),
  handle(async (req, res) => {
    const actor = await getActor(req);
    const staffList = await staffBranches(db, actor.adminId);

    let sources;
    let destinations;
    if (actor.isAdmin) {
      sources = uniqueBranches([...staffList, ...(await stockBranches(db, actor.adminId))]);
      destinations = staffList;
    } else {
      sources = actor.branch ? [findBranch(staffList, actor.branch) || actor.branch] : [];
      destinations = actor.key ? staffList.filter((b) => branchKey(b) !== actor.key) : [];
    }

    let unassigned = 0;
    if (actor.isAdmin) {
      const [[u]] = await db.query(
        `SELECT COUNT(*) AS n FROM pharmacy_medicine_batches
          WHERE admin_id = ? AND (branch IS NULL OR TRIM(branch) = '') AND quantity_available > 0`,
        [actor.adminId]
      );
      unassigned = Number(u.n) || 0;
    }

    let reason = null;
    if (!actor.isAdmin && !actor.key) reason = "Your profile has no branch. Ask your admin to set it.";
    else if (!destinations.length) reason = "There is no other branch to send stock to.";
    else if (actor.isAdmin && staffList.length < 2 && sources.length < 2) reason = "You need at least two branches to transfer stock.";

    return res.json({
      success: true,
      data: {
        my_branch: actor.branch,
        is_admin: actor.isAdmin,
        can_choose_source: actor.isAdmin,
        source_branches: sources,
        destination_branches: destinations,
        can_transfer: !reason,
        reason,
        batches_without_branch: unassigned, // admin only: old stock that still needs a branch
      },
    });
  })
);

/* ============================================================
   GET /getall/transferable-stock?branch=&search=&limit=
   Batches that can be sent from a branch (staff: always their own branch).
============================================================ */
router.get(
  "/getall/transferable-stock",
  authMiddleware,
  allowPermissions(PERM.view),
  handle(async (req, res) => {
    const actor = await getActor(req);
    requireBranch(actor);

    let from;
    if (actor.isAdmin) {
      const wanted = clean(req.query.branch);
      if (!wanted) throw httpError(400, "Choose the branch to send from.");
      const sources = uniqueBranches([...(await staffBranches(db, actor.adminId)), ...(await stockBranches(db, actor.adminId))]);
      from = findBranch(sources, wanted);
      if (!from) throw httpError(400, `"${wanted}" is not one of your branches.`);
    } else {
      from = actor.branch;
    }

    const limit = Math.min(Math.max(toPosInt(req.query.limit) || 50, 1), 200);
    const search = clean(req.query.search);
    const where = [
      "b.admin_id = ?",
      "b.branch IS NOT NULL",
      "LOWER(TRIM(b.branch)) = ?",
      "b.status = 'active'",
      "b.expiry_date >= ?",
      "b.quantity_available > 0",
    ];
    const params = [actor.adminId, branchKey(from), istToday()];
    if (search) {
      where.push(
        `(md.medicine_name LIKE ? OR md.brand_name LIKE ? OR md.generic_name LIKE ?
          OR m.medicine_code LIKE ? OR m.barcode LIKE ? OR b.batch_number LIKE ?)`
      );
      const like = `%${search}%`;
      params.push(like, like, like, like, like, like);
    }

    const [rows] = await db.query(
      `SELECT b.id AS batch_id, b.medicine_id, b.batch_number, b.expiry_date,
              b.mrp, b.purchase_price, b.selling_price, b.quantity_available,
              b.units_per_pack, b.storage_location,
              m.medicine_code, m.pack_size, m.unit,
              md.medicine_name, md.brand_name, md.generic_name, md.strength, md.dosage_form
         FROM pharmacy_medicine_batches b
         JOIN pharmacy_medicines m ON m.id = b.medicine_id
         LEFT JOIN medicine_data md ON md.id = m.medicine_data_id
        WHERE ${where.join(" AND ")}
        ORDER BY COALESCE(md.brand_name, md.medicine_name), b.expiry_date, b.id
        LIMIT ?`,
      [...params, limit]
    );

    return res.json({
      success: true,
      data: {
        from_branch: from,
        items: rows.map((r) => ({
          batch_id: r.batch_id,
          medicine_id: r.medicine_id,
          name: medicineLabel(r),
          medicine_name: r.medicine_name,
          brand_name: r.brand_name,
          generic_name: r.generic_name,
          strength: r.strength,
          dosage_form: r.dosage_form,
          medicine_code: r.medicine_code,
          pack_size: r.pack_size,
          unit: r.unit,
          batch_number: r.batch_number,
          expiry_date: dateStr(r.expiry_date),
          mrp: Number(r.mrp) || 0,
          purchase_price: Number(r.purchase_price) || 0,
          selling_price: Number(r.selling_price) || 0,
          quantity_available: Number(r.quantity_available) || 0,
          units_per_pack: unitsPerPack(r),
          word: packWord(r, unitsPerPack(r)),
          storage_location: r.storage_location || null,
          stock_text: describeStock(r.quantity_available, unitsPerPack(r), packWord(r, unitsPerPack(r))),
        })),
      },
    });
  })
);

/* ============================================================
   POST /post/transfer   — send stock (it goes "in transit")
   body: { from_branch (admin only), to_branch, remarks,
           items: [{ batch_id, quantity }]  or  [{ batch_id, strips, tablets }] }
   quantity is in tablets, same as quantity_available; strips are the batch's own strips.
============================================================ */
router.post(
  "/post/transfer",
  authMiddleware,
  allowPermissions(PERM.create),
  handle(async (req, res) => {
    const actor = await getActor(req);
    requireBranch(actor);
    const body = req.body || {};

    /* ---- 1. branches ---- */
    const staffList = await staffBranches(db, actor.adminId);
    let from;
    if (actor.isAdmin) {
      const wanted = clean(body.from_branch);
      if (!wanted) throw httpError(400, "Choose the branch to send from.");
      const sources = uniqueBranches([...staffList, ...(await stockBranches(db, actor.adminId))]);
      from = findBranch(sources, wanted);
      if (!from) throw httpError(400, `"${wanted}" is not one of your branches.`);
    } else {
      // Staff: ALWAYS their own branch. A from_branch in the body is ignored on purpose.
      from = findBranch(staffList, actor.branch) || actor.branch;
    }

    const wantedTo = clean(body.to_branch);
    if (!wantedTo) throw httpError(400, "Choose the branch to send to.");
    const to = findBranch(staffList, wantedTo);
    if (!to) throw httpError(400, `"${wantedTo}" is not one of your branches (no active staff there).`);
    if (branchKey(to) === branchKey(from)) {
      throw httpError(400, "You can't transfer within the same branch. Choose a different branch to send to.");
    }

    const remarks = clean(body.remarks);
    if (remarks.length > 500) throw httpError(400, "Remarks can be at most 500 characters.");

    /* ---- 2. lines (merge repeats of the same batch) ---- */
    if (!Array.isArray(body.items) || !body.items.length) throw httpError(400, "Add at least one medicine to send.");
    if (body.items.length > MAX_LINES) throw httpError(400, `A transfer can have at most ${MAX_LINES} lines.`);
    const wantedQty = new Map(); // batch id → tablets (strips are turned into tablets once the batch is read)
    const wantedStrips = new Map();
    const lineErrors = [];
    const zeroOk = (v) => v === undefined || v === null || v === "" || Number(v) === 0;
    body.items.forEach((it, i) => {
      const batchId = toPosInt(it && it.batch_id);
      if (!batchId) return lineErrors.push({ line: i + 1, batch_id: it && it.batch_id, message: "Pick a batch." });
      const split = it && (it.strips !== undefined || it.tablets !== undefined);
      if (split) {
        const strips = zeroOk(it.strips) ? 0 : toPosInt(it.strips);
        const loose = zeroOk(it.tablets) ? 0 : toPosInt(it.tablets);
        if (strips === null || loose === null || (!strips && !loose) || strips > MAX_QTY || loose > MAX_QTY) {
          return lineErrors.push({ line: i + 1, batch_id: batchId, message: "Enter whole strips and/or tablets above 0." });
        }
        wantedStrips.set(batchId, (wantedStrips.get(batchId) || 0) + strips);
        wantedQty.set(batchId, (wantedQty.get(batchId) || 0) + loose);
        return undefined;
      }
      const qty = toPosInt(it && it.quantity);
      if (!qty || qty > MAX_QTY) return lineErrors.push({ line: i + 1, batch_id: batchId, message: "Quantity must be a whole number above 0." });
      wantedQty.set(batchId, (wantedQty.get(batchId) || 0) + qty);
      return undefined;
    });
    if (lineErrors.length) throw httpError(400, "Some lines need fixing.", { errors: lineErrors });

    /* ---- 3. do it ---- */
    const now = istNow();
    const today = now.slice(0, 10);
    const fromKey = branchKey(from);
    const toKey = branchKey(to);

    const transferNumber = await withLockedTransaction(`pst_trf_seq_${actor.adminId}`, async (conn) => {
      const ids = [...wantedQty.keys()];
      const [batches] = await conn.query(
        `SELECT b.id, b.medicine_id, b.batch_number, b.expiry_date, b.status, b.quantity_available, b.branch,
                b.units_per_pack, m.unit, m.pack_size
           FROM pharmacy_medicine_batches b
           LEFT JOIN pharmacy_medicines m ON m.id = b.medicine_id
          WHERE b.admin_id = ? AND b.id IN (?)
          FOR UPDATE`,
        [actor.adminId, ids]
      );
      const byId = new Map(batches.map((b) => [Number(b.id), b]));
      // whole strips → tablets, at each batch's own tablets per strip
      for (const [batchId, strips] of wantedStrips) {
        const b = byId.get(batchId);
        if (b && strips) wantedQty.set(batchId, (wantedQty.get(batchId) || 0) + strips * unitsPerPack(b));
      }

      const errors = [];
      for (const [batchId, qty] of wantedQty) {
        const b = byId.get(batchId);
        if (!b) {
          errors.push({ batch_id: batchId, message: "Batch not found." });
          continue;
        }
        if (!b.branch || branchKey(b.branch) !== fromKey) {
          errors.push({ batch_id: batchId, batch_number: b.batch_number, message: `This batch is not in ${from}.` });
          continue;
        }
        if (b.status !== "active") {
          errors.push({ batch_id: batchId, batch_number: b.batch_number, message: `This batch is ${b.status} and can't be sent.` });
          continue;
        }
        if (dateStr(b.expiry_date) < today) {
          errors.push({ batch_id: batchId, batch_number: b.batch_number, message: "This batch has expired and can't be sent." });
          continue;
        }
        if (qty > Number(b.quantity_available)) {
          const upp = unitsPerPack(b);
          errors.push({
            batch_id: batchId,
            batch_number: b.batch_number,
            available: Number(b.quantity_available),
            message: `Only ${describeStock(b.quantity_available, upp, packWord(b, upp))} in this batch.`,
          });
        }
      }
      if (errors.length) throw httpError(400, "Some lines can't be sent.", { errors });

      // Next transfer number for this admin (safe: we hold the sequence lock)
      const [[last]] = await conn.query(
        `SELECT MAX(CAST(SUBSTRING(reference_number, ${PREFIX.length + 1}) AS UNSIGNED)) AS n
           FROM pharmacy_stock_transactions
          WHERE admin_id = ? AND transaction_type = 'transfer_out' AND reference_number LIKE ?`,
        [actor.adminId, `${PREFIX}%`]
      );
      const number = `${PREFIX}${String((Number(last && last.n) || 0) + 1).padStart(5, "0")}`;

      const header = {
        kind: "stock_transfer",
        from_branch: from,
        from_key: fromKey,
        to_branch: to,
        to_key: toKey,
        remarks: remarks || null,
        by_type: actor.type,
        by_name: actor.name,
      };

      for (const [batchId, qty] of wantedQty) {
        try {
          await recordMove(conn, {
            adminId: actor.adminId,
            userId: actor.userId,
            batchId,
            tabletsOut: qty,
            type: "transfer_out",
            referenceNumber: number,
            notes: header,
            date: now,
          });
        } catch (e) {
          if (e.status === 409) throw httpError(409, "Stock changed while sending. Please reload and try again.");
          throw e;
        }
      }
      return number;
    });

    const data = await getTransferDetail(db, actor, transferNumber);
    return res.status(201).json({
      success: true,
      message: `${transferNumber} sent to ${to}. It will reach their stock once they accept it.`,
      data,
    });
  })
);

/* ============================================================
   GET /getall/transfers?direction=incoming|outgoing|all&status=&branch=&search=&page=&limit=
   Staff see only transfers from or to their own branch.
   Admin sees everything; "branch" narrows it (with direction relative to that branch).
============================================================ */
router.get(
  "/getall/transfers",
  authMiddleware,
  allowPermissions(PERM.view),
  handle(async (req, res) => {
    const actor = await getActor(req);
    requireBranch(actor);

    const direction = ["incoming", "outgoing"].includes(clean(req.query.direction)) ? clean(req.query.direction) : "all";
    const status = ["in_transit", "received", "rejected", "cancelled"].includes(clean(req.query.status))
      ? clean(req.query.status)
      : null;
    const search = clean(req.query.search);
    const page = toPosInt(req.query.page) || 1;
    const limit = Math.min(toPosInt(req.query.limit) || 20, 100);

    const where = [];
    const params = [actor.adminId];
    const scopeKey = actor.isAdmin ? (clean(req.query.branch) ? branchKey(req.query.branch) : null) : actor.key;
    if (scopeKey) {
      if (direction === "incoming") {
        where.push("x.to_key = ?");
        params.push(scopeKey);
      } else if (direction === "outgoing") {
        where.push("x.from_key = ?");
        params.push(scopeKey);
      } else {
        where.push("(x.from_key = ? OR x.to_key = ?)");
        params.push(scopeKey, scopeKey);
      }
    }
    if (status) {
      where.push("x.status = ?");
      params.push(status);
    }
    if (search) {
      where.push("(x.transfer_number LIKE ? OR x.from_branch LIKE ? OR x.to_branch LIKE ? OR x.sent_by_name LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[count]] = await db.query(`SELECT COUNT(*) AS n FROM (${HEADER_SQL}) x ${whereSql}`, params);
    const [rows] = await db.query(
      `SELECT * FROM (${HEADER_SQL}) x ${whereSql}
        ORDER BY (x.status = 'in_transit') DESC, x.sent_at DESC, x.transfer_number DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );

    // Badge: transfers waiting for this user to accept
    const pendingParams = [actor.adminId];
    let pendingWhere = "x.status = 'in_transit'";
    if (!actor.isAdmin) {
      pendingWhere += " AND x.to_key = ?";
      pendingParams.push(actor.key);
    }
    const [[pending]] = await db.query(`SELECT COUNT(*) AS n FROM (${HEADER_SQL}) x WHERE ${pendingWhere}`, pendingParams);

    return res.json({
      success: true,
      data: rows.map((r) => shapeHeader(r, actor)),
      pagination: { page, limit, total: Number(count.n) || 0 },
      pending_to_accept: Number(pending.n) || 0,
    });
  })
);

/* ============================================================
   GET /get/transfer/:ref   — one transfer with its lines
============================================================ */
router.get(
  "/get/transfer/:ref",
  authMiddleware,
  allowPermissions(PERM.view),
  handle(async (req, res) => {
    const actor = await getActor(req);
    requireBranch(actor);
    const data = await getTransferDetail(db, actor, clean(req.params.ref).toUpperCase());
    if (!data) throw httpError(404, "Transfer not found.");
    return res.json({ success: true, data });
  })
);

/* ============================================================
   Accept / reject / cancel share the same checks
============================================================ */
async function closeTransfer(req, res, mode) {
  const actor = await getActor(req);
  requireBranch(actor);
  const ref = clean(req.params.ref).toUpperCase();
  if (!ref.startsWith(PREFIX)) throw httpError(404, "Transfer not found.");
  const reason = clean(req.body && req.body.reason);
  if (mode === "reject" && !reason) throw httpError(400, "Please give a reason for rejecting.");
  if (reason.length > 500) throw httpError(400, "The reason can be at most 500 characters.");

  // accept: where each line goes on the receiving branch's shelf  { line_id: "Rack B2" } or [{ line_id, storage_location }]
  const locations = new Map();
  const rawLoc = mode === "accept" && req.body ? req.body.locations : null;
  const locPairs = Array.isArray(rawLoc)
    ? rawLoc.map((x) => [x && x.line_id, x && x.storage_location])
    : rawLoc && typeof rawLoc === "object"
      ? Object.entries(rawLoc)
      : [];
  for (const [lineId, loc] of locPairs) {
    const id = toPosInt(lineId);
    const text = clean(loc);
    if (!id || !text) continue;
    if (text.length > 100) throw httpError(400, "A storage location can be at most 100 characters.");
    locations.set(id, text);
  }

  await withLockedTransaction(`pst_trf_${actor.adminId}_${ref}`, async (conn) => {
    const [outs] = await conn.query(
      `SELECT id, medicine_id, batch_id, quantity_out, notes
         FROM pharmacy_stock_transactions
        WHERE admin_id = ? AND reference_number = ? AND transaction_type = 'transfer_out'
        ORDER BY id
        FOR UPDATE`,
      [actor.adminId, ref]
    );
    if (!outs.length) throw httpError(404, "Transfer not found.");
    const head = parseNotes(outs[0].notes);

    // Staff from a third branch must not learn the transfer exists
    if (!actor.isAdmin && actor.key !== head.from_key && actor.key !== head.to_key) {
      throw httpError(404, "Transfer not found.");
    }

    const [closed] = await conn.query(
      `SELECT transaction_type, notes FROM pharmacy_stock_transactions
        WHERE admin_id = ? AND reference_number = ? AND transaction_type IN ('transfer_in', 'transfer_return')
        LIMIT 1`,
      [actor.adminId, ref]
    );
    if (closed.length) {
      const was = closed[0].transaction_type === "transfer_in" ? "accepted" : parseNotes(closed[0].notes).action || "closed";
      throw httpError(409, `${ref} was already ${was}.`);
    }

    if (mode === "cancel") {
      if (!actor.isAdmin && actor.key !== head.from_key) throw httpError(403, "Only the sending branch can cancel this transfer.");
    } else if (!actor.isAdmin && actor.key !== head.to_key) {
      throw httpError(403, `Only ${head.to_branch} can ${mode} this transfer.`);
    }

    const now = istNow();
    const sourceIds = outs.map((o) => o.batch_id).filter(Boolean);
    const [sources] = sourceIds.length
      ? await conn.query(`SELECT * FROM pharmacy_medicine_batches WHERE admin_id = ? AND id IN (?) FOR UPDATE`, [actor.adminId, sourceIds])
      : [[]];
    const sourceById = new Map(sources.map((b) => [Number(b.id), b]));
    const medIds = [...new Set(sources.map((b) => Number(b.medicine_id)))];
    const [meds] = medIds.length
      ? await conn.query(`SELECT id, unit, pack_size, storage_location FROM pharmacy_medicines WHERE admin_id = ? AND id IN (?)`, [actor.adminId, medIds])
      : [[]];
    const medById = new Map(meds.map((m) => [Number(m.id), m]));

    for (const o of outs) {
      const qty = Number(o.quantity_out);
      const src = sourceById.get(Number(o.batch_id));
      if (!src) throw httpError(409, `The original batch for line ${o.id} no longer exists. Contact support.`);

      if (mode === "accept") {
        /* ---- stock lands at the receiving branch ---- */
        const med = medById.get(Number(src.medicine_id)) || {};
        const srcUpp = unitsPerPack(src);
        const chosen = locations.get(Number(o.id));
        const [found] = await conn.query(
          `SELECT id, expiry_date, status, quantity_available, units_per_pack
             FROM pharmacy_medicine_batches
            WHERE admin_id = ? AND medicine_id = ? AND batch_number = ?
              AND branch IS NOT NULL AND LOWER(TRIM(branch)) = ?
            ORDER BY id LIMIT 1
            FOR UPDATE`,
          [actor.adminId, src.medicine_id, src.batch_number, head.to_key]
        );
        let destId;
        if (found.length) {
          const d = found[0];
          if (dateStr(d.expiry_date) !== dateStr(src.expiry_date)) {
            throw httpError(
              409,
              `Batch ${src.batch_number} already exists at ${head.to_branch} with a different expiry ` +
                `(${dateStr(d.expiry_date)} vs ${dateStr(src.expiry_date)}). Fix the batch details, or reject the transfer.`
            );
          }
          if (d.status === "blocked") {
            throw httpError(409, `Batch ${src.batch_number} is blocked at ${head.to_branch}. Unblock it first, or reject the transfer.`);
          }
          if (unitsPerPack(d) !== srcUpp) {
            throw httpError(
              409,
              `Different pack size — batch ${src.batch_number} at ${head.to_branch} has ${unitsPerPack(d)} per ${packWord(med, 2)}, ` +
                `this stock has ${srcUpp}. Reject the transfer and receive it as a new batch number.`,
              { batch_number: src.batch_number, units_per_pack: srcUpp, destination_units_per_pack: unitsPerPack(d) }
            );
          }
          destId = d.id;
          if (chosen) {
            await conn.query(`UPDATE pharmacy_medicine_batches SET storage_location = ? WHERE id = ? AND admin_id = ?`, [chosen, destId, actor.adminId]);
          }
          await recordMove(conn, {
            adminId: actor.adminId,
            userId: actor.userId,
            batchId: destId,
            tabletsIn: qty,
            alsoReceived: true,
            type: "transfer_in",
            referenceNumber: ref,
            date: now,
            notes: {
              kind: "stock_transfer",
              action: "accepted",
              from_branch: head.from_branch,
              to_branch: head.to_branch,
              source_line_id: o.id,
              source_batch_id: src.id,
              by_type: actor.type,
              by_name: actor.name,
              reason: reason || null,
            },
          });
        } else {
          const [ins] = await conn.query(
            `INSERT INTO pharmacy_medicine_batches
               (admin_id, branch, medicine_id, batch_number, units_per_pack, storage_location,
                manufacturing_date, expiry_date, purchase_price, selling_price, mrp,
                quantity_received, quantity_available, free_quantity, supplier_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active')`,
            [
              actor.adminId,
              head.to_branch,
              src.medicine_id,
              src.batch_number,
              srcUpp,
              chosen || clean(med.storage_location) || null,
              dateStr(src.manufacturing_date),
              dateStr(src.expiry_date),
              src.purchase_price,
              src.selling_price,
              src.mrp,
              qty,
              qty,
              src.supplier_id || null,
            ]
          );
          destId = ins.insertId;
          await ledgerRow(conn, {
            adminId: actor.adminId,
            userId: actor.userId,
            batchId: destId,
            medicineId: src.medicine_id,
            type: "transfer_in",
            tabletsIn: qty,
            referenceNumber: ref,
            date: now,
            notes: {
              kind: "stock_transfer",
              action: "accepted",
              from_branch: head.from_branch,
              to_branch: head.to_branch,
              source_line_id: o.id,
              source_batch_id: src.id,
              by_type: actor.type,
              by_name: actor.name,
              reason: reason || null,
            },
          });
        }
      } else {
        /* ---- reject / cancel: stock goes back into the batch it came from ---- */
        await recordMove(conn, {
          adminId: actor.adminId,
          userId: actor.userId,
          batchId: src.id,
          tabletsIn: qty,
          type: "transfer_return",
          referenceNumber: ref,
          date: now,
          notes: {
            kind: "stock_transfer",
            action: mode === "reject" ? "rejected" : "cancelled",
            from_branch: head.from_branch,
            to_branch: head.to_branch,
            source_line_id: o.id,
            by_type: actor.type,
            by_name: actor.name,
            reason: reason || null,
          },
        });
      }
    }
  });

  const data = await getTransferDetail(db, actor, ref);
  const msg = {
    accept: `${ref} accepted. The stock is now in ${data.to_branch}.`,
    reject: `${ref} rejected. The stock went back to ${data.from_branch}.`,
    cancel: `${ref} cancelled. The stock is back in ${data.from_branch}.`,
  }[mode];
  return res.json({ success: true, message: msg, data });
}

/* POST /accept/transfer/:ref   body: { reason? }  — receiving branch */
router.post("/accept/transfer/:ref", authMiddleware, allowPermissions(PERM.edit), handle((req, res) => closeTransfer(req, res, "accept")));

/* POST /reject/transfer/:ref   body: { reason }   — receiving branch */
router.post("/reject/transfer/:ref", authMiddleware, allowPermissions(PERM.edit), handle((req, res) => closeTransfer(req, res, "reject")));

/* POST /cancel/transfer/:ref   body: { reason? }  — sending branch */
router.post("/cancel/transfer/:ref", authMiddleware, allowPermissions(PERM.create), handle((req, res) => closeTransfer(req, res, "cancel")));

module.exports = router;