// utils/pharmacyStock.js
//
// Moving stock. Every change to a batch's quantity goes through recordMove(), which changes the
// batch AND writes the stock-ledger row in one step — so the shelf and the ledger always agree.
// All quantities here are TABLETS (see utils/pharmacyUnits.js).
//
//   recordMove(conn, {...})            in or out of one batch + ledger row
//   allocate(conn, {...})              FEFO: which batches a sale line is taken from
//   ledgerRow(conn, {...})             ledger row only, for a batch whose quantity you just set
//                                      yourself (e.g. a brand-new batch created with its stock)
//
// Call them inside a transaction you started (conn.beginTransaction()); you commit / roll back.

const { unitsPerPack, tabletsFor, unitPriceFor, mrpFor, splitTablets, rate4, describeStock } = require("./pharmacyUnits");
const { batchFilter } = require("./pharmacyBranch");

const LEDGER_TYPES = new Set([
  "purchase", "sale", "dispense", "return", "purchase_return", "adjustment",
  "expired", "damaged", "opening_stock", "transfer_out", "transfer_in", "transfer_return",
]);

const fail = (status, message, extra) => {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
};

const istNow = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
const istToday = () => istNow().slice(0, 10);

/** Ledger row for a batch whose quantity_available is already final. Balance = that quantity. */
async function ledgerRow(conn, { adminId, userId, batchId, medicineId, type, tabletsIn = 0, tabletsOut = 0, referenceId, referenceNumber, notes, date }) {
  if (!LEDGER_TYPES.has(type)) throw fail(500, `Unknown stock movement type "${type}"`);
  const [[b]] = await conn.query(
    `SELECT medicine_id, quantity_available FROM pharmacy_medicine_batches WHERE id = ? AND admin_id = ?`,
    [batchId, adminId]
  );
  if (!b) throw fail(404, "Batch not found.");
  await conn.query(
    `INSERT INTO pharmacy_stock_transactions
       (admin_id, medicine_id, batch_id, transaction_type, reference_id, reference_number,
        quantity_in, quantity_out, balance_quantity, transaction_date, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      adminId,
      medicineId || b.medicine_id,
      batchId,
      type,
      referenceId || null,
      referenceNumber ? String(referenceNumber).slice(0, 100) : null,
      Math.max(0, Math.floor(tabletsIn)),
      Math.max(0, Math.floor(tabletsOut)),
      Number(b.quantity_available) || 0,
      date || istNow(),
      notes == null ? null : typeof notes === "string" ? notes : JSON.stringify(notes),
      userId || null,
    ]
  );
}

/**
 * Move tablets in or out of one batch, and write the ledger row.
 * Throws 409 when taking out more than the batch holds (nothing is changed then).
 * Returns the batch's new quantity_available.
 */
async function recordMove(conn, { adminId, userId, batchId, tabletsIn = 0, tabletsOut = 0, type, referenceId, referenceNumber, notes, date, alsoReceived = false }) {
  const tin = Math.max(0, Math.floor(Number(tabletsIn) || 0));
  const tout = Math.max(0, Math.floor(Number(tabletsOut) || 0));
  if (!tin && !tout) throw fail(400, "Nothing to move.");
  if (tin && tout) throw fail(500, "A stock movement is either in or out, not both.");

  const [[b]] = await conn.query(
    `SELECT id, medicine_id, batch_number, quantity_available, units_per_pack
       FROM pharmacy_medicine_batches WHERE id = ? AND admin_id = ? FOR UPDATE`,
    [batchId, adminId]
  );
  if (!b) throw fail(404, "Batch not found.");
  if (tout > Number(b.quantity_available)) {
    throw fail(409, `Only ${describeStock(b.quantity_available, unitsPerPack(b))} left in batch ${b.batch_number}.`, {
      batch_id: b.id,
      available: Number(b.quantity_available),
    });
  }
  await conn.query(
    `UPDATE pharmacy_medicine_batches
        SET quantity_available = quantity_available + ? - ?${alsoReceived ? ", quantity_received = quantity_received + ?" : ""}
      WHERE id = ? AND admin_id = ?`,
    alsoReceived ? [tin, tout, tin, batchId, adminId] : [tin, tout, batchId, adminId]
  );
  await ledgerRow(conn, { adminId, userId, batchId, medicineId: b.medicine_id, type, tabletsIn: tin, tabletsOut: tout, referenceId, referenceNumber, notes, date });
  return Number(b.quantity_available) + tin - tout;
}

/**
 * FEFO allocation for ONE sale line, locked for update.
 *   saleUnit  'strip' | 'tablet' | 'pack'      qty  how many of saleUnit
 *   batchId   optional: only this batch        scope  from resolveScope() (branch filter)
 *   medicine  the pharmacy_medicines row (for a fallback price)
 * A strip line takes whole strips only (floor(tablets ÷ per-strip) per batch).
 * Batches: active, not expired, in scope, with stock — earliest expiry first, then oldest.
 * Returns [{ batch, qty, tablets, units_per_pack, unit_price, max_price, strip_price }]
 * (one entry per batch used). Throws 409 with { available } when there isn't enough.
 */
async function allocate(conn, { adminId, medicine, saleUnit, qty, batchId = null, scope, today = istToday() }) {
  const want = Math.floor(Number(qty) || 0);
  if (want < 1) throw fail(400, "Quantity must be at least 1.");
  const f = batchFilter(scope, "b");
  const [rows] = await conn.query(
    `SELECT b.* FROM pharmacy_medicine_batches b
      WHERE b.admin_id = ? AND b.medicine_id = ? AND b.status = 'active'
        AND b.expiry_date >= ? AND b.quantity_available > 0 ${f.sql}
        ${batchId ? "AND b.id = ?" : ""}
      ORDER BY b.expiry_date ASC, b.id ASC
      FOR UPDATE`,
    [adminId, medicine.id, today, ...f.params, ...(batchId ? [batchId] : [])]
  );

  const out = [];
  let left = want;
  let canGive = 0;
  for (const b of rows) {
    const upp = unitsPerPack(b);
    // A loose-tablet line can only come from batches that are actually in strips. A batch counted
    // per pack (1 per pack) is skipped — never sell "3 tablets" as 3 whole packs.
    if (saleUnit === "tablet" && upp <= 1) continue;
    const unit = upp <= 1 ? "pack" : saleUnit === "tablet" ? "tablet" : "strip";
    const have = unit === "tablet" ? Number(b.quantity_available) : splitTablets(b.quantity_available, upp).strips;
    canGive += have;
    if (left <= 0 || have <= 0) continue;
    const take = Math.min(have, left);
    const stripPrice = Number(b.selling_price) > 0 ? Number(b.selling_price) : Number(b.mrp) > 0 ? Number(b.mrp) : Number(medicine.selling_price) || 0;
    out.push({
      batch: b,
      sale_unit: unit,
      qty: take,
      tablets: tabletsFor(unit, take, upp),
      units_per_pack: upp,
      strip_price: rate4(stripPrice),
      unit_price: unitPriceFor(unit, stripPrice, upp),
      max_price: mrpFor(unit, b.mrp, upp),
    });
    left -= take;
  }
  if (left > 0) {
    const word = saleUnit === "tablet" ? "tablets" : "strips";
    throw fail(409, batchId ? `Only ${canGive} ${word} left in that batch.` : `Only ${canGive} ${word} in stock.`, { available: canGive, sale_unit: saleUnit });
  }
  return out;
}

// H5: moved here from routes/pharmacy/batches.js (which is not mounted) so medicines.js can use it
/**
 * RE-PACK one batch that was counted in packs (units_per_pack = 1) as strips of `upp` tablets.
 * Used when the migration couldn't read a medicine's pack size and its batches were left at 1:
 * received / available / free are all multiplied by upp, units_per_pack becomes upp, and one
 * ledger row records the tablets added. The batch must already be locked (FOR UPDATE) by the caller.
 * Returns { batch_id, batch_number, branch, packs, tablets } or null when there is nothing to do.
 */
async function repackBatch(conn, { adminId, userId, batch, upp }) {
  if (Number(batch.units_per_pack) !== 1 || !(upp > 1)) return null;
  const packs = Number(batch.quantity_available) || 0;
  const tablets = packs * upp;
  await conn.query(
    `UPDATE pharmacy_medicine_batches
        SET units_per_pack = ?, quantity_received = quantity_received * ?,
            quantity_available = quantity_available * ?, free_quantity = free_quantity * ?, updated_at = NOW()
      WHERE id = ? AND admin_id = ? AND units_per_pack = 1`,
    [upp, upp, upp, upp, batch.id, adminId]
  );
  await ledgerRow(conn, {
    adminId,
    userId,
    batchId: batch.id,
    medicineId: batch.medicine_id,
    type: "adjustment",
    tabletsIn: tablets - packs,
    referenceId: batch.id,
    referenceNumber: batch.batch_number,
    notes: `Pack size set to ${upp} per strip: ${packs} ${packs === 1 ? "pack" : "packs"} counted as ${tablets} tablets`,
  });
  return { batch_id: Number(batch.id), batch_number: batch.batch_number, branch: batch.branch || null, packs, tablets };
}

module.exports = { recordMove, ledgerRow, allocate, istNow, istToday, LEDGER_TYPES, repackBatch };