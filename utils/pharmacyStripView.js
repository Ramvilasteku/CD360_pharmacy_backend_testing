// utils/pharmacyStripView.js
//
// The bridge between the database and Bhargavi's pharmacy screens.
//
// The database counts stock in TABLETS and prices PER STRIP (see utils/pharmacyUnits.js).
// Bhargavi's screens have no strip/tablet control: the POS reads a batch's
// quantity_available straight into its quantity stepper and prices the line at the
// batch's selling_price. So every number those screens receive has to mean STRIPS,
// and every quantity they send has to be read as STRIPS.
//
// This file is that translation, in one place:
//
//   reading   tablets -> strips    stripsOf() / SQL_STRIPS
//   writing   strips  -> tablets   tabletsOf()
//
// Nothing else in the routes should divide or multiply by units_per_pack directly.
//
// Consequence worth knowing: a part-sold strip leaves loose tablets behind
// (125 tablets at 10 per strip reads as 12 strips, not 12.5). Those 5 loose tablets
// stay in the batch and are simply not offered on these screens. LOOSE_TABLETS_NOTE
// below is the wording used when that matters to the user.

const { unitsPerPack, parsePackSize, rate4, money } = require("./pharmacyUnits");

/** Whole strips that `tablets` makes up, at `upp` tablets per strip. */
const stripsOf = (tablets, upp) =>
  Math.floor(Math.max(0, Number(tablets) || 0) / Math.max(1, Number(upp) || 1));

/** Tablets in `strips` strips, at `upp` tablets per strip. */
const tabletsOf = (strips, upp) =>
  Math.max(0, Math.floor(Number(strips) || 0)) * Math.max(1, Number(upp) || 1);

/** Loose tablets left over once whole strips are counted out. */
const looseOf = (tablets, upp) =>
  Math.max(0, Number(tablets) || 0) % Math.max(1, Number(upp) || 1);

/**
 * SQL that turns a tablet column into whole strips.
 *   SQL_STRIPS("b.quantity_available", "b.units_per_pack")
 * Used so a list query returns strips without any post-processing in JS.
 */
const SQL_STRIPS = (tabletCol, uppCol) =>
  `FLOOR(${tabletCol} / GREATEST(COALESCE(${uppCol}, 1), 1))`;

/**
 * Tablets per strip to use for a NEW batch of this medicine.
 * The medicine's own units_per_pack wins; otherwise its pack_size text is parsed
 * ("10 tablets", "1x15", "strip of 10"); otherwise 1, which means sold whole only.
 * Matches unitsPerPack() in utils/pharmacyUnits.js — kept separate only because a new
 * batch has no row of its own to read yet.
 */
function uppForNewBatch(medicineRow, requested) {
  const asked = Number(requested);
  if (Number.isInteger(asked) && asked >= 1) return asked;
  return unitsPerPack(medicineRow) || parsePackSize(medicineRow && medicineRow.pack_size) || 1;
}

/**
 * Rewrite one batch row for the screens: tablet counts become strip counts.
 * The tablet figures are kept alongside under *_tablets so a handler that needs the
 * real stock (a decrement, a stock check) never has to convert back.
 */
function batchToStripView(row) {
  if (!row) return row;
  const upp = unitsPerPack(row);
  const availTablets = Number(row.quantity_available) || 0;
  const recvTablets = Number(row.quantity_received) || 0;
  const freeTablets = Number(row.free_quantity) || 0;
  return {
    ...row,
    units_per_pack: upp,
    quantity_available: stripsOf(availTablets, upp),
    quantity_received: stripsOf(recvTablets, upp),
    free_quantity: stripsOf(freeTablets, upp),
    quantity_available_tablets: availTablets,
    quantity_received_tablets: recvTablets,
    free_quantity_tablets: freeTablets,
    loose_tablets: looseOf(availTablets, upp),
  };
}

const batchesToStripView = (rows) => (Array.isArray(rows) ? rows.map(batchToStripView) : rows);

/**
 * reorder_level and maximum_stock are held in strips (they are what a buyer thinks in),
 * while stock is in tablets — so a reorder comparison has to happen in strips.
 */
const atOrBelowReorder = (tablets, upp, reorderLevel) =>
  stripsOf(tablets, upp) <= Math.max(0, Number(reorderLevel) || 0);

const LOOSE_TABLETS_NOTE =
  "Loose tablets left over from a part-sold strip are not offered on this screen.";

module.exports = {
  stripsOf,
  tabletsOf,
  looseOf,
  SQL_STRIPS,
  uppForNewBatch,
  batchToStripView,
  batchesToStripView,
  atOrBelowReorder,
  LOOSE_TABLETS_NOTE,
  rate4,
  money,
};
