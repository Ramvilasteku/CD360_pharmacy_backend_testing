// utils/pharmacyUnits.js
//
// THE strip / tablet rules, in one place. Every pharmacy route uses these — never its own maths.
//
//   • Stock (pharmacy_medicine_batches.quantity_*) is counted in TABLETS.
//     A capsule or sachet counts as one tablet. A syrup / tube / injection is 1 "tablet" per pack.
//   • Prices (purchase_price, selling_price, mrp on batches, medicines and purchase lines) are
//     PER STRIP — what the supplier invoice and the printed MRP say.
//   • A tablet's price = strip price ÷ tablets per strip, kept to 4 decimals; a line total is
//     rounded to the paisa. A full strip always sells at exactly the strip price.
//   • units_per_pack = tablets in one strip. Each batch keeps its own (the packing it arrived
//     in); the medicine's is the default for the next purchase. 1 = sold whole only.
//   • Purchases are in whole strips (+ free strips). Sales are by strip, by tablet, or — for
//     items with units_per_pack 1 — by pack.

/* ---------------- numbers ---------------- */
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const rate4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;

/* ---------------- pack size ---------------- */
// "1x10", "10 x 10", "1*15"  → the number after the x (tablets in one strip)
const MULTI_RE = /^\s*\d+\s*[x×*]\s*(\d+)\s*(?:'?s|n|nos|pcs|tabs?|tablets?|caps?|capsules?)?\s*$/i;
// "10", "10 tablets", "10'S", "15 caps", "10 TAB", "10N"
const SINGLE_RE = /^\s*(\d+)\s*(?:'?s|n|nos|pcs|tabs?|tablets?|caps?|capsules?)?\s*$/i;
// "strip of 10", "pack of 15 tablets"
const OF_RE = /\b(?:strip|pack|blister)\s+of\s+(\d+)\b/i;

/** Tablets per strip read from pack_size text, or null when it isn't a count ("100 ml", "1 pack"). */
function parsePackSize(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return null;
  const m = MULTI_RE.exec(s) || SINGLE_RE.exec(s) || OF_RE.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : null;
}

/**
 * Tablets per strip for a medicine OR a batch row.
 * Order: the row's own units_per_pack → parsed pack_size → 1.
 */
function unitsPerPack(row) {
  if (!row) return 1;
  const own = Number(row.units_per_pack);
  if (Number.isInteger(own) && own >= 1) return own;
  return parsePackSize(row.pack_size) || 1;
}

/** Validates a units_per_pack value coming from a form or a file. Returns an int ≥ 1 or throws. */
function cleanUnitsPerPack(v, label = "Tablets per strip") {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    const e = new Error(`${label} must be a whole number from 1 to 10000`);
    e.status = 400;
    throw e;
  }
  return n;
}

/* ---------------- stock ---------------- */
/** 125 tablets at 10 per strip → { strips: 12, loose: 5 }  (full strips we can still sell whole) */
const splitTablets = (tablets, upp) => {
  const t = Math.max(0, Math.floor(Number(tablets) || 0));
  const u = Math.max(1, Math.floor(Number(upp) || 1));
  return { strips: Math.floor(t / u), loose: t % u };
};

const plural = (word, n) => {
  const w = String(word || "").toLowerCase();
  if (Number(n) === 1) return w;
  return /(s|x|ch|sh)$/.test(w) ? `${w}es` : `${w}s`;
};

// the pack word for a medicine: its unit ("strip", "bottle", "tube"…), but a unit that is
// really the loose item ("tablet") means the pack is a strip
const LOOSE_WORD = /^(tablets?|tabs?|capsules?|caps?|pcs|pieces?|nos|units?)$/i;
const packWord = (row, upp) => {
  const u = String((row && row.unit) || "").trim();
  if (u && !LOOSE_WORD.test(u)) return u.toLowerCase();
  return (upp || unitsPerPack(row)) > 1 ? "strip" : "pack";
};

/** "12 strips + 5 tablets", "12 strips", "5 tablets", "3 bottles", "0 strips" */
function describeStock(tablets, upp, word = "strip") {
  const u = Math.max(1, Number(upp) || 1);
  const { strips, loose } = splitTablets(tablets, u);
  if (u === 1) return `${strips} ${plural(word === "strip" ? "pack" : word, strips)}`;
  if (strips && loose) return `${strips} ${plural(word, strips)} + ${loose} ${plural("tablet", loose)}`;
  if (loose) return `${loose} ${plural("tablet", loose)}`;
  return `${strips} ${plural(word, strips)}`;
}

/* ---------------- sale lines ---------------- */
/** 'strip' | 'tablet' | 'pack' — a 1-per-pack item can only be sold as a pack. */
function cleanSaleUnit(v, upp) {
  if (Number(upp) <= 1) return "pack";
  const s = String(v || "strip").trim().toLowerCase();
  if (s === "tablet" || s === "tablets" || s === "tab" || s === "loose") return "tablet";
  if (s === "strip" || s === "strips" || s === "pack") return "strip";
  const e = new Error(`Sale type must be "strip" or "tablet"`);
  e.status = 400;
  throw e;
}

/** tablets that leave the batch for qty of saleUnit */
const tabletsFor = (saleUnit, qty, upp) => (saleUnit === "tablet" ? qty : qty * Math.max(1, upp));

/** the price of ONE saleUnit, given the batch's per-strip price */
const unitPriceFor = (saleUnit, stripPrice, upp) =>
  saleUnit === "tablet" ? rate4((Number(stripPrice) || 0) / Math.max(1, upp)) : rate4(stripPrice);

/** the most ONE saleUnit may cost, given the per-strip MRP (0 / missing MRP → no limit) */
const mrpFor = (saleUnit, stripMrp, upp) => {
  const m = Number(stripMrp) || 0;
  if (m <= 0) return null;
  return saleUnit === "tablet" ? rate4(m / Math.max(1, upp)) : rate4(m);
};

/**
 * How to read ANY pharmacy_sale_items row, old or new.
 *   new rows   sale_unit / units_per_pack / tablets are set
 *   old POS    sale_unit NULL → it was sold by the strip, from stock then counted in strips
 *   old B2B    sale_unit NULL and the sale's notes start with {"b2b":1 → quantity was tablets
 * Returns { sale_unit, units_per_pack, tablets } — tablets in today's stock units.
 */
function readSaleLine(line, sale, batch) {
  if (line && line.sale_unit) {
    const upp = Number(line.units_per_pack) || unitsPerPack(batch) || 1;
    const qty = Number(line.quantity) || 0;
    return {
      sale_unit: line.sale_unit,
      units_per_pack: upp,
      tablets: line.tablets != null ? Number(line.tablets) : tabletsFor(line.sale_unit, qty, upp),
      legacy: false,
    };
  }
  const upp = unitsPerPack(batch) || 1;
  const qty = Number(line && line.quantity) || 0;
  const isB2B = !!(sale && typeof sale.notes === "string" && sale.notes.startsWith('{"b2b":1'));
  if (isB2B) return { sale_unit: "tablet", units_per_pack: upp, tablets: qty, legacy: true };
  return { sale_unit: upp > 1 ? "strip" : "pack", units_per_pack: upp, tablets: qty * upp, legacy: true };
}

/** "2 strips", "7 tablets", "3 bottles" for a sale line */
function describeSaleQty(saleUnit, qty, word = "strip") {
  if (saleUnit === "tablet") return `${qty} ${plural("tablet", qty)}`;
  if (saleUnit === "pack") return `${qty} ${plural(word === "strip" ? "pack" : word, qty)}`;
  return `${qty} ${plural(word, qty)}`;
}

/* ---------------- purchases ---------------- */
/** strips (+ free strips) at upp per strip → tablets into stock */
const tabletsFromStrips = (strips, freeStrips, upp) =>
  ((Number(strips) || 0) + (Number(freeStrips) || 0)) * Math.max(1, Number(upp) || 1);

/** reorder_level / maximum_stock are in strips; stock is in tablets → compare in strips */
const stripsInStock = (tablets, upp) => Math.floor((Number(tablets) || 0) / Math.max(1, Number(upp) || 1));

module.exports = {
  money,
  rate4,
  parsePackSize,
  unitsPerPack,
  cleanUnitsPerPack,
  splitTablets,
  plural,
  packWord,
  describeStock,
  cleanSaleUnit,
  tabletsFor,
  unitPriceFor,
  mrpFor,
  readSaleLine,
  describeSaleQty,
  tabletsFromStrips,
  stripsInStock,
};