// src/pharmacy/b2b/B2BCreateInvoice.js
//
// Make a B2B invoice: say who it is for (any pharmacy), add medicines, say for each whether
// you are selling STRIPS (whole packs) or SINGLE TABLETS, and issue it. The stock comes off the
// shelf, and the invoice is a GST tax invoice you can download as a PDF straight away.
//
//   Buyer            type the name — pharmacies you sold to before are suggested and fill in their
//                    phone, GSTIN, address…; anyone new is just typed in. There is no buyer list to
//                    keep: the details are written on each invoice.
//   Your details     your GSTIN, drug licence, bank details and terms are printed on the invoice.
//                    They start as what you typed on the last invoice, and can be changed here.
//   Strip / Tablet   each line has its own toggle. Tablet is offered only for a medicine that has
//                    more than one tablet in a strip (units_per_pack > 1); a bottle or a roll is
//                    sold by the bottle / roll only. Changing the toggle swaps the rate to the
//                    strip rate or the per-tablet rate (strip rate ÷ tablets in a strip).
//   Batch            "Auto" takes the earliest-expiry batch first and moves on to the next when it
//                    runs out (each batch used becomes its own printed line). Or pin one batch.
//   Stock            what is on the shelf is shown as "12 strips + 4 tablets"; a line asking for
//                    more than there is turns red and blocks Issue — the server checks again.
//   GST              each line's % starts at the medicine's own and can be changed. CGST + SGST for
//                    a buyer in your state, IGST for another state (first two digits of the two
//                    GSTINs; either missing → same state). The total is rounded to a whole rupee.
//
// It is a full-screen dialog opened from the B2B page — not a route — so it never appears in the sidebar.
//
// Backend: routes/pharmacy/pharmacyB2BSales.js @ /api/pharmacy/b2b-sales
//   GET  /defaults              your business details + the buyers you sold to before
//   GET  /medicine-search?q=    in-stock medicines with batches, strip/tablet rates and stock text
//   POST /create                issues the invoice → the complete invoice
//
// Needs pharmacy.sales.create.
//
// Usage   <B2BCreateInvoice open onClose onCreated={(invoice) => …} />

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Autocomplete, Box, Button, CircularProgress, Collapse, Dialog, DialogActions, DialogContent, DialogContentText,
  DialogTitle, Divider, IconButton, InputAdornment, MenuItem, Stack, Switch, TextField, ToggleButton,
  ToggleButtonGroup, Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import BusinessOutlinedIcon from "@mui/icons-material/BusinessOutlined";
import SearchIcon from "@mui/icons-material/Search";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import StorefrontOutlinedIcon from "@mui/icons-material/StorefrontOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import ReceiptLongOutlinedIcon from "@mui/icons-material/ReceiptLongOutlined";
import PaymentsOutlinedIcon from "@mui/icons-material/PaymentsOutlined";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";

import { IconTile, buttonSx, fade, headWash, inputSx, numCellSx, nums, panelSx, thinScroll, tints, toneColor } from "../purchase/purchaseStyles";
import {
  B2B_API, PAY_METHODS, apiMessage, fmtExpiry, http, inr, money, plural, priceInvoice, todayStr,
} from "./b2bShared";

const SEARCH_DELAY = 250;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

/* ---------- stock arithmetic (tablets are the common unit) ---------- */
const uppOf = (m) => Math.max(1, Number(m.units_per_pack) || 1);
const wholeQty = (l) => (Number.isInteger(Number(l.quantity)) ? Number(l.quantity) : 0);
const needOf = (l) => (l.qty_type === "strip" ? wholeQty(l) * uppOf(l.med) : wholeQty(l));
const scopeBatches = (l) => (l.batch_id ? l.med.batches.filter((b) => String(b.id) === String(l.batch_id)) : l.med.batches);
// strip lines only ever take whole strips from a batch, so a half strip in one batch doesn't count
const availOf = (l) => {
  const upp = uppOf(l.med);
  return scopeBatches(l).reduce((t, b) => t + (l.qty_type === "strip" ? Math.floor(b.tablets / upp) * upp : b.tablets), 0);
};
const unitWord = (m) => String(m.unit || "strip").toLowerCase();

function shortText(l) {
  const upp = uppOf(l.med);
  const have = availOf(l);
  const where = l.batch_id ? " in that batch" : "";
  if (l.qty_type === "strip") {
    const n = have / upp;
    return n > 0 ? `Only ${n} ${plural(unitWord(l.med), n)} available${where}` : `No whole ${unitWord(l.med)} available${where}`;
  }
  return have > 0 ? `Only ${have} ${plural("tablet", have)} available${where}` : `No tablets available${where}`;
}

let keySeed = 0;
const newLine = (med) => ({
  key: `l${++keySeed}`,
  med,
  qty_type: "strip",
  quantity: "1",
  unit_price: String(med.strip_rate ?? 0),
  gst: String(med.gst_percentage ?? 0),
  batch_id: "",
});

const rateFor = (med, type) => String(type === "tablet" ? med.tablet_rate ?? 0 : med.strip_rate ?? 0);

/* ============================================================
   the medicine search box
============================================================ */
function MedicineSearch({ onPick, disabled }) {
  const theme = useTheme();
  const primary = toneColor(theme, "primary");
  const [input, setInput] = useState("");
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  const search = useCallback(async (q) => {
    const mine = ++latest.current;
    setLoading(true);
    setFailed(false);
    try {
      const r = await http.get(`${B2B_API}/medicine-search`, { params: { q, limit: 20 } });
      if (mine !== latest.current) return;
      setOptions(r.data.data || []);
    } catch {
      if (mine !== latest.current) return;
      setOptions([]);
      setFailed(true);
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(input.trim()), input ? SEARCH_DELAY : 0);
    return () => clearTimeout(t);
  }, [input, search]);

  return (
    <Autocomplete
      fullWidth
      size="small"
      disabled={disabled}
      options={options}
      value={null}
      inputValue={input}
      onInputChange={(_, v, reason) => {
        if (reason === "input" || reason === "clear") setInput(v);
      }}
      onChange={(_, med) => {
        if (med) {
          onPick(med);
          setInput("");
        }
      }}
      filterOptions={(x) => x}
      getOptionLabel={(m) => m?.name || ""}
      isOptionEqualToValue={(a, b) => a.medicine_id === b.medicine_id}
      loading={loading}
      loadingText="Searching…"
      noOptionsText={failed ? "Couldn't search — try again" : input ? "No in-stock medicine matches" : "Nothing in stock"}
      autoHighlight
      blurOnSelect
      clearOnBlur
      slotProps={{
        paper: {
          sx: {
            mt: 0.75,
            borderRadius: 2.5,
            border: 1,
            borderColor: fade(primary, 0.15),
            boxShadow: `0 12px 32px ${fade(primary, 0.15)}`,
            "& .MuiAutocomplete-listbox": { maxHeight: 340, p: 0.75, ...thinScroll(primary) },
            "& .MuiAutocomplete-option": { borderRadius: 1.5, py: 0.75, px: 1, mb: 0.25 },
            "& .MuiAutocomplete-option.Mui-focused": { bgcolor: fade(primary, 0.08) },
          },
        },
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder="Search a medicine to add — name, brand, generic, code or barcode"
          sx={inputSx(primary, false)}
          InputProps={{
            ...params.InputProps,
            startAdornment: (
              <>
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
                {params.InputProps.startAdornment}
              </>
            ),
            endAdornment: (
              <>
                {loading ? <CircularProgress size={16} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
          inputProps={{ ...params.inputProps, "aria-label": "Search medicine" }}
        />
      )}
      renderOption={(props, m) => {
        const { key, ...rest } = props;
        return (
          <Box component="li" key={m.medicine_id} {...rest} sx={{ display: "flex !important", alignItems: "center", gap: 1.25 }}>
            <IconTile icon={Inventory2OutlinedIcon} tone="primary" size={30} />
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography sx={{ fontSize: 14, fontWeight: 700 }} noWrap>
                {m.name}
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: "text.secondary" }} noWrap>
                {m.stock_text} in stock · ₹{inr(m.strip_rate)}/{unitWord(m)}
                {m.can_sell_loose ? ` · ₹${inr(m.tablet_rate)}/tablet` : ""}
              </Typography>
            </Box>
            <Typography sx={{ fontSize: 11.5, color: "text.secondary", ...nums }}>GST {m.gst_percentage}%</Typography>
          </Box>
        );
      }}
    />
  );
}

/* ============================================================
   one invoice line
============================================================ */
const LINE_COLS = "minmax(0,1fr) 136px 80px 100px 68px 100px 34px";

function Line({ line, over, together, onChange, onRemove }) {
  const theme = useTheme();
  const m = line.med;
  const upp = uppOf(m);
  const word = unitWord(m);
  const qty = Number(line.quantity);
  const amount = money((qty > 0 ? qty : 0) * (Number(line.unit_price) || 0));
  const qtyBad = line.quantity !== "" && !(Number.isInteger(qty) && qty > 0);
  const rateBad = line.unit_price === "" || !(Number(line.unit_price) >= 0);
  const gstBad = line.gst === "" || !(Number(line.gst) >= 0 && Number(line.gst) <= 100);
  const red = toneColor(theme, "error");
  const inputLabel = (text) => (
    <Typography sx={{ display: { md: "none" }, fontSize: 11, fontWeight: 600, color: "text.secondary", mb: 0.25 }}>{text}</Typography>
  );

  return (
    <Box
      data-testid="create-line"
      sx={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: { xs: "1fr 1fr", md: LINE_COLS },
        gap: { xs: 1.25, md: 1.5 },
        alignItems: "start",
        p: 1.25,
        border: 1,
        borderRadius: 2,
        borderColor: over || together ? fade(red, 0.55) : "divider",
        bgcolor: over || together ? fade(red, 0.03) : "background.paper",
      }}
    >
      {/* medicine + stock note */}
      <Box sx={{ gridColumn: { xs: "1 / -1", md: "auto" }, minWidth: 0, pr: { xs: 4.5, md: 0 }, order: -2 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 700 }} noWrap title={m.name}>
          {m.name}
        </Typography>
        <Typography sx={{ fontSize: 11.5, color: "text.secondary" }} noWrap title={`${m.stock_text} in stock`}>
          {m.stock_text} in stock{m.hsn_code ? ` · HSN ${m.hsn_code}` : ""}
        </Typography>
      </Box>

      {/* batch — under the name on a phone, on its own row on a desktop */}
      <Box sx={{ gridColumn: { xs: "1 / -1", md: "1 / 3" }, order: { xs: -1, md: 9 }, minWidth: 0 }}>
        <TextField
          select
          size="small"
          value={line.batch_id}
          onChange={(e) => onChange({ batch_id: e.target.value })}
          inputProps={{ "aria-label": `Batch for ${m.name}` }}
          SelectProps={{ displayEmpty: true, MenuProps: { PaperProps: { sx: { borderRadius: 2 } } } }}
          sx={{ width: "100%", "& .MuiOutlinedInput-root": { borderRadius: 1.75, fontSize: 12.5 }, "& .MuiSelect-select": { py: 0.55 } }}
        >
          <MenuItem value="" sx={{ fontSize: 13 }}>
            Auto — earliest expiry first
          </MenuItem>
          {m.batches.map((b) => (
            <MenuItem key={b.id} value={String(b.id)} sx={{ fontSize: 13 }}>
              {b.batch_number || `Batch ${b.id}`}
              {b.expiry_date ? ` · exp ${fmtExpiry(b.expiry_date)}` : ""} · {b.stock_text}
            </MenuItem>
          ))}
        </TextField>
      </Box>

      {/* strip / tablet */}
      <Box sx={{ gridColumn: { xs: "1 / -1", md: "auto" } }}>
        {inputLabel("Selling by")}
        <ToggleButtonGroup
          exclusive
          size="small"
          fullWidth
          value={line.qty_type}
          onChange={(_, v) => v && onChange({ qty_type: v, unit_price: rateFor(m, v) })}
          aria-label={`Quantity type for ${m.name}`}
          sx={{ "& .MuiToggleButton-root": { textTransform: "none", fontWeight: 700, fontSize: 12.5, py: 0.55, borderRadius: 1.75 } }}
        >
          <ToggleButton value="strip" aria-label={`Sell by the ${word}`} sx={{ textTransform: "capitalize !important" }}>
            {word}
          </ToggleButton>
          {m.can_sell_loose && (
            <ToggleButton value="tablet" aria-label="Sell single tablets">
              Tablet
            </ToggleButton>
          )}
        </ToggleButtonGroup>
        {line.qty_type === "tablet" && (
          <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.4 }}>{upp} tablets make a {word}</Typography>
        )}
        {line.qty_type === "strip" && upp > 1 && Number(line.quantity) > 0 && (
          <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.4 }}>= {wholeQty(line) * upp} tablets</Typography>
        )}
      </Box>

      <Box>
        {inputLabel(line.qty_type === "tablet" ? "Tablets" : `${word[0].toUpperCase()}${word.slice(1)}s`)}
        <Box
          component="input"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={line.quantity}
          onChange={(e) => onChange({ quantity: e.target.value })}
          aria-label={`${line.qty_type === "tablet" ? "Tablets" : `${word[0].toUpperCase()}${word.slice(1)}s`} of ${m.name}`}
          sx={numCellSx(theme, { error: qtyBad || over || together })}
        />
      </Box>

      <Box>
        {inputLabel(`Rate / ${line.qty_type === "tablet" ? "tablet" : word}`)}
        <Box
          component="input"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          value={line.unit_price}
          onChange={(e) => onChange({ unit_price: e.target.value })}
          aria-label={`Rate of ${m.name}`}
          sx={numCellSx(theme, { error: rateBad })}
        />
      </Box>

      <Box>
        {inputLabel("GST %")}
        <Box
          component="input"
          type="number"
          min={0}
          max={100}
          step="0.01"
          inputMode="decimal"
          value={line.gst}
          onChange={(e) => onChange({ gst: e.target.value })}
          aria-label={`GST percent of ${m.name}`}
          sx={numCellSx(theme, { error: gstBad })}
        />
      </Box>

      <Box sx={{ textAlign: "right", alignSelf: "end", gridColumn: "auto" }}>
        {inputLabel("Amount")}
        <Typography sx={{ fontSize: 14, fontWeight: 800, ...nums }} data-testid="line-amount">
          ₹{inr(amount)}
        </Typography>
      </Box>

      <IconButton
        size="small"
        aria-label={`Remove ${m.name}`}
        onClick={onRemove}
        sx={{
          position: { xs: "absolute", md: "static" },
          top: { xs: 6, md: "auto" },
          right: { xs: 6, md: "auto" },
          alignSelf: "center",
          "&:hover": { color: "error.main", bgcolor: fade(red, 0.08) },
        }}
      >
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>

      {(over || together) && (
        <Box sx={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 0.6, color: "error.main" }}>
          <WarningAmberRoundedIcon sx={{ fontSize: 16 }} />
          <Typography role="alert" sx={{ fontSize: 12.5, fontWeight: 600 }}>
            {over ? shortText(line) : `All lines for ${m.name} together need more than the ${m.stock_text} in stock`}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

/* one label / amount line in the totals */
function Sum({ label, value, strong, hide, tone }) {
  const theme = useTheme();
  if (hide) return null;
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={2} sx={{ py: 0.35 }}>
      <Typography sx={{ fontSize: strong ? 15 : 13, fontWeight: strong ? 800 : 500, color: strong ? "text.primary" : "text.secondary" }}>{label}</Typography>
      <Typography sx={{ fontSize: strong ? 20 : 13.5, fontWeight: strong ? 800 : 600, ...nums, color: tone ? toneColor(theme, tone) : "text.primary" }}>{value}</Typography>
    </Stack>
  );
}

/* ============================================================
   the builder
============================================================ */
export default function B2BCreateInvoice({ open, onClose, onCreated }) {
  const theme = useTheme();
  const primary = toneColor(theme, "primary");
  const act = tints(theme, "primary");

  const [pastBuyers, setPastBuyers] = useState([]);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [business, setBusiness] = useState({ business_name: "" });
  const [sellerGstin, setSellerGstin] = useState("");
  const [sellerDl, setSellerDl] = useState("");
  const [sellerBank, setSellerBank] = useState("");
  const [sellerTerms, setSellerTerms] = useState("");
  const [showSeller, setShowSeller] = useState(false);
  const [buyerName, setBuyerName] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [buyerGst, setBuyerGst] = useState("");
  const [buyerDl, setBuyerDl] = useState("");
  const [buyerState, setBuyerState] = useState("");
  const [buyerAddress, setBuyerAddress] = useState("");
  const [owes, setOwes] = useState(0); // what a returning buyer already owes
  const [invoiceDate, setInvoiceDate] = useState(todayStr());
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState([]);
  const [discount, setDiscount] = useState("");
  const [other, setOther] = useState("");
  const [notes, setNotes] = useState("");
  const [payOn, setPayOn] = useState(false);
  const [payAmount, setPayAmount] = useState(""); // "" = the full total
  const [payMethod, setPayMethod] = useState("cash");
  const [payRef, setPayRef] = useState("");

  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState(null);
  const [tried, setTried] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // a fresh, empty invoice every time it opens
  useEffect(() => {
    if (!open) return;
    setBuyerName("");
    setBuyerPhone("");
    setBuyerEmail("");
    setBuyerGst("");
    setBuyerDl("");
    setBuyerState("");
    setBuyerAddress("");
    setOwes(0);
    setShowSeller(false);
    setInvoiceDate(todayStr());
    setDueDate("");
    setLines([]);
    setDiscount("");
    setOther("");
    setNotes("");
    setPayOn(false);
    setPayAmount("");
    setPayMethod("cash");
    setPayRef("");
    setProblem(null);
    setTried(false);
    setConfirmClose(false);
    setLoadingDefaults(true);
    http
      .get(`${B2B_API}/defaults`)
      .then((r) => {
        const d = r.data.data || {};
        const me = d.seller || {};
        setBusiness(me);
        setSellerGstin(String(me.gstin || ""));
        setSellerDl(String(me.drug_license_number || ""));
        setSellerBank(String(me.bank_details || ""));
        setSellerTerms(String(me.terms || ""));
        setPastBuyers(d.buyers || []);
      })
      .catch(() => setPastBuyers([]))
      .finally(() => setLoadingDefaults(false));
  }, [open]);

  const pickPastBuyer = (b) => {
    setProblem(null);
    setBuyerName(b.buyer_name || "");
    setBuyerPhone(b.phone || "");
    setBuyerEmail(b.email || "");
    setBuyerGst(b.gst_number || "");
    setBuyerDl(b.drug_license_number || "");
    setBuyerState(b.state || "");
    setBuyerAddress(b.address || "");
    setOwes(Number(b.outstanding) || 0);
  };

  /* ---------- lines ---------- */
  const addMedicine = (med) => {
    setProblem(null);
    setLines((ls) => {
      // the same medicine, same batch, same type again → just one more
      const same = ls.find((l) => l.med.medicine_id === med.medicine_id && l.qty_type === "strip" && l.batch_id === "");
      if (same) return ls.map((l) => (l === same ? { ...l, quantity: String((Number(l.quantity) || 0) + 1) } : l));
      return [...ls, newLine(med)];
    });
  };
  const patchLine = (key, patch) => {
    setProblem(null);
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };
  const removeLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));

  /* ---------- checks and totals ---------- */
  const overKeys = useMemo(() => new Set(lines.filter((l) => wholeQty(l) > 0 && needOf(l) > availOf(l)).map((l) => l.key)), [lines]);
  const togetherKeys = useMemo(() => {
    const need = {};
    lines.forEach((l) => {
      need[l.med.medicine_id] = (need[l.med.medicine_id] || 0) + needOf(l);
    });
    return new Set(
      lines.filter((l) => !overKeys.has(l.key) && need[l.med.medicine_id] > (Number(l.med.stock_tablets) || 0)).map((l) => l.key)
    );
  }, [lines, overKeys]);

  const totals = useMemo(
    () =>
      priceInvoice(
        lines.map((l) => ({ quantity: Number(l.quantity) || 0, unit_price: Number(l.unit_price) || 0, gst_percentage: Number(l.gst) || 0 })),
        { discount: Number(discount) || 0, otherCharges: Number(other) || 0 }
      ),
    [lines, discount, other]
  );

  const sellerCode = sellerGstin.trim().slice(0, 2);
  const buyerCode = buyerGst.trim().slice(0, 2);
  const igst = /^\d\d$/.test(sellerCode) && /^\d\d$/.test(buyerCode) && sellerCode !== buyerCode;
  const half = money(totals.tax_amount / 2);

  const payNow = !payOn ? 0 : payAmount === "" ? totals.grand_total : money(payAmount);
  const discountOver = money(discount) > totals.subtotal + 0.001;

  const errors = useMemo(() => {
    const e = [];
    if (!buyerName.trim()) e.push("Enter who this invoice is for.");
    if (buyerGst.trim() && !GSTIN_RE.test(buyerGst.trim().toUpperCase())) e.push("The buyer's GSTIN must be 15 characters, like 36ABCDE1234F1Z5.");
    if (buyerEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail.trim())) e.push("The buyer's email isn't valid.");
    if (buyerPhone.trim() && !/^\+?\d{7,15}$/.test(buyerPhone.replace(/[\s\-()]/g, ""))) e.push("The buyer's phone number doesn't look right.");
    if (sellerGstin.trim() && !GSTIN_RE.test(sellerGstin.trim().toUpperCase())) e.push("Your GSTIN must be 15 characters, like 36ABCDE1234F1Z5.");
    if (!lines.length) e.push("Add at least one medicine.");
    lines.forEach((l) => {
      const q = Number(l.quantity);
      if (!(Number.isInteger(q) && q > 0)) e.push(`${l.med.name}: quantity must be a whole number above 0.`);
      if (l.unit_price === "" || !(Number(l.unit_price) >= 0)) e.push(`${l.med.name}: enter the rate.`);
      if (l.gst === "" || !(Number(l.gst) >= 0 && Number(l.gst) <= 100)) e.push(`${l.med.name}: GST must be between 0 and 100.`);
    });
    if (overKeys.size || togetherKeys.size) e.push("Some lines ask for more than is in stock.");
    if (dueDate && dueDate < invoiceDate) e.push("The pay-by date can't be before the invoice date.");
    if (discount !== "" && !(Number(discount) >= 0)) e.push("Discount can't be negative.");
    if (discountOver) e.push("Discount can't be more than the items total.");
    if (other !== "" && !(Number(other) >= 0)) e.push("Other charges can't be negative.");
    if (payOn && !(payNow > 0)) e.push("Enter the amount received, or turn the payment off.");
    if (payOn && payNow > totals.grand_total + 0.001) e.push("The payment is more than the invoice total.");
    return e;
  }, [buyerName, buyerGst, buyerEmail, buyerPhone, sellerGstin, lines, overKeys, togetherKeys, dueDate, invoiceDate, discount, discountOver, other, payOn, payNow, totals.grand_total]);

  const dirty = !!(buyerName.trim() || lines.length || notes || discount || other || dueDate);

  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirmClose(true);
    else onClose();
  };

  /* ---------- issue ---------- */
  const issue = async () => {
    setTried(true);
    setProblem(null);
    if (errors.length) return;
    setSaving(true);
    try {
      const r = await http.post(`${B2B_API}/create`, {
        buyer: {
          buyer_name: buyerName.trim(),
          phone: buyerPhone.trim() || undefined,
          email: buyerEmail.trim() || undefined,
          gst_number: buyerGst.trim() ? buyerGst.trim().toUpperCase() : undefined,
          drug_license_number: buyerDl.trim() || undefined,
          state: buyerState.trim() || undefined,
          address: buyerAddress.trim() || undefined,
        },
        seller: {
          gstin: sellerGstin.trim() ? sellerGstin.trim().toUpperCase() : undefined,
          drug_license_number: sellerDl.trim() || undefined,
          bank_details: sellerBank.trim() || undefined,
          terms: sellerTerms.trim() || undefined,
        },
        invoice_date: invoiceDate,
        due_date: dueDate || undefined,
        discount_amount: Number(discount) || 0,
        other_charges: Number(other) || 0,
        notes: notes.trim() || undefined,
        items: lines.map((l) => ({
          medicine_id: l.med.medicine_id,
          qty_type: l.qty_type,
          quantity: Number(l.quantity),
          unit_price: Number(l.unit_price),
          gst_percentage: Number(l.gst),
          batch_id: l.batch_id ? Number(l.batch_id) : undefined,
        })),
        payment: payOn && payNow > 0 ? { amount: payNow, payment_method: payMethod, transaction_reference: payRef.trim() || undefined } : undefined,
      });
      onCreated && onCreated(r.data.data, r.data.message);
    } catch (e) {
      setProblem(await apiMessage(e, "Couldn't issue the invoice"));
    } finally {
      setSaving(false);
    }
  };

  const shown = tried ? errors : [];

  /* ---------- the right-hand summary (also the phone's bottom section) ---------- */
  const summary = (
    <Stack spacing={2}>
      <Box sx={{ ...panelSx(theme), p: 1.75 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", mb: 1 }}>Totals</Typography>
        <Sum label="Items total" value={`₹${inr(totals.subtotal)}`} />
        <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1.25, my: 1 }}>
          <TextField
            size="small"
            label="Discount ₹"
            type="number"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            inputProps={{ min: 0, step: "0.01", "aria-label": "Invoice discount" }}
            error={discountOver}
            sx={inputSx(primary, false)}
          />
          <TextField
            size="small"
            label="Other charges ₹"
            type="number"
            value={other}
            onChange={(e) => setOther(e.target.value)}
            inputProps={{ min: 0, step: "0.01", "aria-label": "Other charges" }}
            sx={inputSx(primary, false)}
          />
        </Box>
        <Sum label="Discount" value={`− ₹${inr(totals.discount_amount)}`} hide={!(totals.discount_amount > 0)} />
        <Sum label="Taxable value" value={`₹${inr(totals.taxable_amount)}`} />
        {igst ? (
          <Sum label="IGST" value={`₹${inr(totals.tax_amount)}`} />
        ) : (
          <>
            <Sum label="CGST" value={`₹${inr(half)}`} />
            <Sum label="SGST" value={`₹${inr(money(totals.tax_amount - half))}`} />
          </>
        )}
        <Sum label="Other charges" value={`₹${inr(totals.other_charges)}`} hide={!(totals.other_charges > 0)} />
        <Sum label="Round off" value={`${totals.round_off < 0 ? "− " : ""}₹${inr(Math.abs(totals.round_off))}`} hide={!totals.round_off} />
        <Divider sx={{ my: 0.75 }} />
        <Sum label="Invoice total" value={`₹${inr(totals.grand_total)}`} strong />
        <Typography sx={{ mt: 0.75, fontSize: 11.5, color: "text.secondary" }}>
          {igst ? "Another state — IGST applies." : "Same state — CGST + SGST apply."}
          {!sellerGstin.trim() && " Add your GSTIN under “Your details” to be sure."}
        </Typography>
      </Box>

      <Box sx={{ ...panelSx(theme), p: 1.75 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <IconTile icon={PaymentsOutlinedIcon} tone="success" size={30} radius={1.75} />
          <Typography sx={{ fontSize: 13.5, fontWeight: 700, flex: 1 }}>Received payment now?</Typography>
          <Switch checked={payOn} onChange={(e) => setPayOn(e.target.checked)} inputProps={{ "aria-label": "Received payment now" }} color="success" />
        </Stack>
        {payOn && (
          <Box sx={{ display: "grid", gap: 1.25, mt: 1.5, gridTemplateColumns: "1fr 1fr" }}>
            <TextField
              size="small"
              label="Amount ₹"
              type="number"
              value={payAmount}
              placeholder={String(totals.grand_total)}
              onChange={(e) => setPayAmount(e.target.value)}
              inputProps={{ min: 0, step: "0.01", "aria-label": "Payment amount" }}
              InputLabelProps={{ shrink: true }}
              sx={inputSx(primary, false)}
            />
            <TextField select size="small" label="Method" value={payMethod} onChange={(e) => setPayMethod(e.target.value)} sx={inputSx(primary, false)}>
              {PAY_METHODS.map((m) => (
                <MenuItem key={m.value} value={m.value}>
                  {m.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              label="Reference (optional)"
              value={payRef}
              onChange={(e) => setPayRef(e.target.value)}
              sx={{ ...inputSx(primary, false), gridColumn: "1 / -1" }}
            />
            {payNow > 0 && payNow < totals.grand_total && (
              <Typography sx={{ gridColumn: "1 / -1", fontSize: 12, color: "text.secondary" }}>₹{inr(totals.grand_total - payNow)} will stay due.</Typography>
            )}
          </Box>
        )}
      </Box>

      <TextField
        size="small"
        label="Notes on the invoice (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        multiline
        minRows={2}
        sx={inputSx(primary, false)}
      />
    </Stack>
  );

  return (
    <>
      <Dialog open={!!open} onClose={requestClose} fullScreen aria-labelledby="b2b-create-title" PaperProps={{ sx: { bgcolor: "background.default" } }}>
        {/* header */}
        <Box sx={{ ...headWash(theme), bgcolor: "background.paper", px: { xs: 2, md: 3 }, py: 1.5, display: "flex", alignItems: "center", gap: 1.5, borderBottom: 1, borderColor: "divider" }}>
          <IconTile icon={ReceiptLongOutlinedIcon} tone="primary" size={40} radius={2.5} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography component="h2" id="b2b-create-title" sx={{ fontSize: 18, fontWeight: 800 }} noWrap>New B2B invoice</Typography>
            <Typography sx={{ fontSize: 12.5, color: "text.secondary", display: { xs: "none", sm: "block" } }} noWrap>
              Sell strips or single tablets to another pharmacy
            </Typography>
          </Box>
          <Typography sx={{ fontSize: 17, fontWeight: 800, ...nums, display: { xs: "none", sm: "block" } }}>₹{inr(totals.grand_total)}</Typography>
          <IconButton onClick={requestClose} aria-label="Close" disabled={saving}>
            <CloseIcon />
          </IconButton>
        </Box>

        <DialogContent sx={{ p: 0, ...thinScroll(primary) }}>
          <Box
            sx={{
              maxWidth: 1240,
              mx: "auto",
              px: { xs: 2, md: 3 },
              py: 2.25,
              display: "grid",
              gap: 2.25,
              gridTemplateColumns: { xs: "minmax(0,1fr)", lg: "minmax(0,1fr) 360px" },
              alignItems: "start",
            }}
          >
            {/* ---------------- left: buyer, medicines ---------------- */}
            <Stack spacing={2.25} sx={{ minWidth: 0 }}>
              <Box sx={{ ...panelSx(theme), p: 1.75 }}>
                <Stack direction="row" alignItems="center" spacing={1.25} sx={{ mb: 1.5 }}>
                  <IconTile icon={StorefrontOutlinedIcon} tone="primary" size={30} radius={1.75} />
                  <Typography sx={{ fontSize: 12.5, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase", flex: 1 }}>Sold to</Typography>
                </Stack>
                <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr 1fr", sm: "2fr 1fr 1fr" } }}>
                  <Autocomplete
                    size="small"
                    freeSolo
                    options={pastBuyers}
                    value={null}
                    inputValue={buyerName}
                    loading={loadingDefaults}
                    onInputChange={(_, v, reason) => {
                      if (reason === "input" || reason === "clear") {
                        setBuyerName(v);
                        setOwes(0);
                        setProblem(null);
                      }
                    }}
                    onChange={(_, b) => {
                      if (b && typeof b === "object") pickPastBuyer(b);
                    }}
                    filterOptions={(opts, st) => {
                      const q = st.inputValue.trim().toLowerCase();
                      return opts.filter((b) => !q || `${b.buyer_name} ${b.gst_number || ""} ${b.phone || ""}`.toLowerCase().includes(q)).slice(0, 12);
                    }}
                    getOptionLabel={(b) => (typeof b === "string" ? b : b?.buyer_name || "")}
                    noOptionsText="Type the pharmacy's name"
                    autoHighlight
                    sx={{ gridColumn: { xs: "1 / -1", sm: "auto" } }}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="Buyer (pharmacy)"
                        error={tried && !buyerName.trim()}
                        helperText={tried && !buyerName.trim() ? "Enter who this is for" : undefined}
                        sx={inputSx(primary, !!buyerName.trim())}
                        inputProps={{ ...params.inputProps, "aria-label": "Buyer" }}
                      />
                    )}
                    renderOption={(props, b) => {
                      const { key, ...rest } = props;
                      return (
                        <Box component="li" key={`${b.buyer_name}-${b.gst_number || b.phone || ""}`} {...rest}>
                          <Box sx={{ minWidth: 0 }}>
                            <Typography sx={{ fontSize: 14, fontWeight: 600 }} noWrap>{b.buyer_name}</Typography>
                            <Typography sx={{ fontSize: 11.5, color: "text.secondary" }} noWrap>
                              {[b.gst_number, b.phone, b.state].filter(Boolean).join(" · ") || "No details"}
                            </Typography>
                          </Box>
                        </Box>
                      );
                    }}
                  />
                  <TextField
                    size="small"
                    label="Invoice date"
                    type="date"
                    value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value || todayStr())}
                    InputLabelProps={{ shrink: true }}
                    sx={inputSx(primary, false)}
                  />
                  <TextField
                    size="small"
                    label="Pay by (optional)"
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                    inputProps={{ min: invoiceDate }}
                    error={!!dueDate && dueDate < invoiceDate}
                    sx={inputSx(primary, false)}
                  />
                  <TextField size="small" label="Phone" value={buyerPhone} onChange={(e) => setBuyerPhone(e.target.value)} inputProps={{ inputMode: "tel", "aria-label": "Buyer phone" }} sx={inputSx(primary, false)} />
                  <TextField
                    size="small"
                    label="GSTIN"
                    value={buyerGst}
                    onChange={(e) => setBuyerGst(e.target.value.toUpperCase())}
                    error={!!buyerGst.trim() && !GSTIN_RE.test(buyerGst.trim())}
                    inputProps={{ maxLength: 15, "aria-label": "Buyer GSTIN" }}
                    sx={inputSx(primary, false)}
                  />
                  <TextField size="small" label="Email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} inputProps={{ inputMode: "email", "aria-label": "Buyer email" }} sx={{ ...inputSx(primary, false), gridColumn: { xs: "1 / -1", sm: "auto" } }} />
                  <TextField size="small" label="Drug licence no." value={buyerDl} onChange={(e) => setBuyerDl(e.target.value)} inputProps={{ "aria-label": "Buyer drug licence" }} sx={inputSx(primary, false)} />
                  <TextField size="small" label="State" value={buyerState} onChange={(e) => setBuyerState(e.target.value)} inputProps={{ "aria-label": "Buyer state" }} sx={inputSx(primary, false)} />
                  <TextField size="small" label="Address" value={buyerAddress} onChange={(e) => setBuyerAddress(e.target.value)} inputProps={{ "aria-label": "Buyer address" }} sx={{ ...inputSx(primary, false), gridColumn: { xs: "1 / -1", sm: "auto" } }} />
                </Box>
                <Typography sx={{ mt: 1.25, fontSize: 12.5, color: "text.secondary" }}>
                  {buyerGst.trim() ? `GSTIN ${buyerGst.trim()}` : "No GSTIN — treated as same state"}
                  {owes > 0 ? ` · already owes ₹${inr(owes)}` : ""}
                </Typography>
              </Box>

              {/* your own details, printed on the invoice */}
              <Box sx={{ ...panelSx(theme), p: 1.75 }}>
                <Stack direction="row" alignItems="center" spacing={1.25}>
                  <IconTile icon={BusinessOutlinedIcon} tone="primary" size={30} radius={1.75} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase" }}>Your details</Typography>
                    <Typography sx={{ fontSize: 12.5, color: "text.secondary" }} noWrap>
                      {[business.business_name, sellerGstin.trim() ? `GSTIN ${sellerGstin.trim()}` : "Add your GSTIN"].filter(Boolean).join(" · ")}
                    </Typography>
                  </Box>
                  <Button
                    size="small"
                    onClick={() => setShowSeller((v) => !v)}
                    aria-expanded={showSeller}
                    endIcon={<ExpandMoreIcon sx={{ transform: showSeller ? "rotate(180deg)" : "none", transition: "transform .2s" }} />}
                    sx={buttonSx}
                  >
                    {showSeller ? "Hide" : "Edit"}
                  </Button>
                </Stack>
                <Collapse in={showSeller} unmountOnExit>
                  <Box sx={{ display: "grid", gap: 1.5, mt: 1.5, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
                    <TextField
                      size="small"
                      label="Your GSTIN"
                      value={sellerGstin}
                      onChange={(e) => setSellerGstin(e.target.value.toUpperCase())}
                      error={!!sellerGstin.trim() && !GSTIN_RE.test(sellerGstin.trim())}
                      inputProps={{ maxLength: 15, "aria-label": "Your GSTIN" }}
                      sx={inputSx(primary, false)}
                    />
                    <TextField size="small" label="Your drug licence no." value={sellerDl} onChange={(e) => setSellerDl(e.target.value)} inputProps={{ "aria-label": "Your drug licence" }} sx={inputSx(primary, false)} />
                    <TextField size="small" label="Bank details" value={sellerBank} onChange={(e) => setSellerBank(e.target.value)} multiline minRows={2} inputProps={{ "aria-label": "Bank details" }} sx={inputSx(primary, false)} />
                    <TextField size="small" label="Terms" value={sellerTerms} onChange={(e) => setSellerTerms(e.target.value)} multiline minRows={2} inputProps={{ "aria-label": "Terms" }} sx={inputSx(primary, false)} />
                  </Box>
                </Collapse>
              </Box>

              <Box sx={{ ...panelSx(theme), p: 1.75 }}>
                <Stack direction="row" alignItems="center" spacing={1.25} sx={{ mb: 1.5 }}>
                  <IconTile icon={Inventory2OutlinedIcon} tone="primary" size={30} radius={1.75} />
                  <Typography sx={{ fontSize: 12.5, fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase" }}>Medicines</Typography>
                  {lines.length > 0 && (
                    <Typography sx={{ fontSize: 12, fontWeight: 800, px: 0.9, borderRadius: 3, bgcolor: act.tile, color: act.main }}>{lines.length}</Typography>
                  )}
                </Stack>
                <MedicineSearch onPick={addMedicine} disabled={saving} />

                {lines.length > 0 ? (
                  <>
                    <Box
                      sx={{
                        display: { xs: "none", md: "grid" },
                        gridTemplateColumns: LINE_COLS,
                        gap: 1.5,
                        mt: 1.5,
                        px: 1.25,
                        py: 0.7,
                        borderRadius: 2,
                        border: 1,
                        borderColor: act.line,
                        bgcolor: act.soft,
                        "& > p": { fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: act.dark },
                      }}
                    >
                      <Typography component="p">Medicine / batch</Typography>
                      <Typography component="p">Selling by</Typography>
                      <Typography component="p" sx={{ textAlign: "right" }}>Qty</Typography>
                      <Typography component="p" sx={{ textAlign: "right" }}>Rate</Typography>
                      <Typography component="p" sx={{ textAlign: "right" }}>GST %</Typography>
                      <Typography component="p" sx={{ textAlign: "right" }}>Amount</Typography>
                      <span />
                    </Box>
                    <Stack spacing={1} sx={{ mt: 1 }}>
                      {lines.map((l) => (
                        <Line
                          key={l.key}
                          line={l}
                          over={overKeys.has(l.key)}
                          together={togetherKeys.has(l.key)}
                          onChange={(patch) => patchLine(l.key, patch)}
                          onRemove={() => removeLine(l.key)}
                        />
                      ))}
                    </Stack>
                  </>
                ) : (
                  <Stack alignItems="center" spacing={0.75} sx={{ py: 5, textAlign: "center" }}>
                    <Box sx={{ width: 52, height: 52, borderRadius: "50%", display: "grid", placeItems: "center", bgcolor: act.soft }}>
                      <Inventory2OutlinedIcon sx={{ fontSize: 26, color: act.main }} />
                    </Box>
                    <Typography sx={{ fontSize: 14, fontWeight: 700 }}>No medicines yet</Typography>
                    <Typography sx={{ fontSize: 12.5, color: "text.secondary", maxWidth: 340 }}>
                      Search above and pick a medicine. Then choose whether you are selling strips or single tablets.
                    </Typography>
                  </Stack>
                )}
              </Box>
            </Stack>

            {/* ---------------- right: totals, payment ---------------- */}
            <Box sx={{ position: { lg: "sticky" }, top: { lg: 12 } }}>{summary}</Box>
          </Box>
        </DialogContent>

        {/* footer */}
        <Box sx={{ borderTop: 1, borderColor: "divider", bgcolor: "background.paper", px: { xs: 2, md: 3 }, py: 1.25 }}>
          <Box sx={{ maxWidth: 1240, mx: "auto" }}>
            {(shown.length > 0 || problem) && (
              <Alert severity={problem ? "error" : "warning"} variant="outlined" sx={{ mb: 1, borderRadius: 2, py: 0 }} role="alert">
                {problem || shown[0]}
                {!problem && shown.length > 1 ? ` (and ${shown.length - 1} more)` : ""}
              </Alert>
            )}
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: 11, fontWeight: 700, color: "text.secondary", letterSpacing: "0.05em" }}>INVOICE TOTAL</Typography>
                <Typography sx={{ fontSize: 20, fontWeight: 800, ...nums }} data-testid="footer-total">₹{inr(totals.grand_total)}</Typography>
              </Box>
              <Button onClick={requestClose} disabled={saving} sx={buttonSx}>
                Cancel
              </Button>
              <Button
                variant="contained"
                disableElevation
                onClick={issue}
                disabled={saving}
                startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <ReceiptLongOutlinedIcon />}
                sx={{ ...buttonSx, px: 3 }}
              >
                {saving ? "Issuing…" : "Issue invoice"}
              </Button>
            </Stack>
          </Box>
        </Box>
      </Dialog>

      <Dialog open={confirmClose} onClose={() => setConfirmClose(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Discard this invoice?</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 14 }}>Nothing has been issued and no stock has moved. What you entered will be lost.</DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setConfirmClose(false)} sx={buttonSx}>
            Keep editing
          </Button>
          <Button
            color="error"
            variant="contained"
            disableElevation
            onClick={() => {
              setConfirmClose(false);
              onClose();
            }}
            sx={buttonSx}
          >
            Discard
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
