/*
====================================================================
services/pdf/theme.js

One stylesheet for every printed form. Colours sampled from the
clinic's existing yoga form (brand #0F6B5C). `brand` can be overridden
per call so a second clinic / a second form family can have its own
colour without touching the renderer.

Every block type the renderer can emit has a class here — the renderer
itself never writes inline style except for column widths.
====================================================================
*/

const DEFAULT_THEME = {
    brand: "#0F6B5C",
    tint: "#E8F1F0",
    rule: "#ACCBC7",
    ink: "#1D1D1B",
    muted: "#4A4A48",
    zebra: "#F6FAF9",
    baseFont: '"Liberation Sans",Arial,Helvetica,"DejaVu Sans",sans-serif',
    sigFont: '"Liberation Serif",Georgia,"DejaVu Serif",serif',
    fontSize: "9.6pt"
};

function buildCss(theme = {}) {
    const t = { ...DEFAULT_THEME, ...theme };

    return `
:root{
  --brand:${t.brand};--tint:${t.tint};--rule:${t.rule};
  --ink:${t.ink};--muted:${t.muted};--zebra:${t.zebra};
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:${t.baseFont};font-size:${t.fontSize};line-height:1.42;color:var(--ink);
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}

/* ---------- document header ---------- */
.brandbar{background:var(--brand);color:#fff;text-align:center;padding:11px 10px 9px}
.brandbar h1{margin:0;font-size:16pt;font-weight:700;letter-spacing:1.5px}
.brandbar p{margin:3px 0 0;font-size:9.4pt;font-style:italic;color:#DCEAE7}

/* ---------- section ---------- */
.section{break-inside:auto}
.section.pb{break-before:page;page-break-before:always}
.sec{
  background:var(--brand);color:#fff;font-weight:700;font-size:9.8pt;letter-spacing:.7px;
  padding:4px 9px;margin:13px 0 9px;break-after:avoid;page-break-after:avoid;
}
.sec-desc{margin:0 0 8px;color:var(--muted)}
.sub{font-weight:700;color:var(--brand);margin:7px 0 4px;break-after:avoid}

/* ---------- fields ---------- */
.grid{display:flex;flex-wrap:wrap;gap:0 20px}
.f{display:flex;align-items:flex-end;gap:6px;margin-bottom:9px;break-inside:avoid}
.f.half{flex:1 1 calc(50% - 20px);min-width:210px}
.f.full{flex:1 1 100%}
.f>.l{font-weight:700;white-space:nowrap}
.f>.v{flex:1;min-height:15px;border-bottom:1px solid var(--rule);padding:0 4px 1px;word-break:break-word}

.hint{font-size:8.6pt;font-style:italic;color:var(--muted);margin:0 0 3px}
.yn{display:inline-flex;align-items:center;gap:5px;margin-right:16px}
.f>.v.plain{border-bottom:none;padding-bottom:0}
.attach{max-height:150px;max-width:60%;border:1px solid var(--rule);border-radius:2px}
.ta{break-inside:avoid;margin-bottom:9px}
.ta .q{margin:0 0 4px;color:var(--muted)}
.ta .box{
  border:1px solid var(--rule);background:var(--tint);border-radius:2px;padding:6px 8px;
}
.ta .box.sm{min-height:34px}
.ta .box.md{min-height:52px}
.ta .box.lg{min-height:78px}

/* ---------- option groups ---------- */
.optblock{break-inside:avoid;margin-bottom:8px}
.opts{display:flex;flex-wrap:wrap;gap:5px 18px;margin:2px 0 4px}
.opt{display:flex;align-items:center;gap:7px}
.opts.c1 .opt{flex:1 1 100%}
.opts.c2 .opt{flex:1 1 calc(50% - 18px)}
.opts.c3 .opt{flex:1 1 calc(33.3% - 18px)}
/* One size for every marker, square or round, so a page of mixed
   radio/checkbox groups lines up. 11px outer, 1px border -> 9x9 inner. */
.cb,.rb{position:relative;display:inline-block;width:11px;height:11px;flex:0 0 auto;
    border:1px solid var(--brand);background:#fff;vertical-align:-1.5px}
/* The tick used to sit at top:-1.6px — poking out above the box. These
   offsets were measured off a 600dpi render: the mark is centred with
   ~1.6px clear left/right and ~2px top/bottom inside the 9px inner box. */
.cb.on::after{content:"";position:absolute;left:2.98px;top:1.26px;width:3px;height:5.4px;
    border-right:1.5px solid var(--brand);border-bottom:1.5px solid var(--brand);
    transform:rotate(45deg)}
.rb{border-radius:50%}
.rb.on::after{content:"";position:absolute;left:2.5px;top:2.5px;width:4px;height:4px;
    border-radius:50%;background:var(--brand)}
.other{display:flex;align-items:flex-end;gap:5px;flex:1 1 220px}
.other .v{flex:1;min-width:90px;border-bottom:1px solid var(--rule);min-height:14px;padding:0 4px 1px}

/* ---------- static text ---------- */
p.body{margin:0 0 7px;text-align:justify;color:var(--muted)}

/* ---------- acknowledgements ---------- */
.acks{margin:4px 0 6px}
.ack{display:flex;gap:8px;margin-bottom:6px;break-inside:avoid}
.ack .ini{flex:0 0 62px;text-align:center;font-weight:700;color:var(--brand);
    border:1px solid var(--rule);background:var(--tint);border-radius:2px;
    padding:1px 0;font-size:9pt;min-height:15px}
.ack .t{flex:1}

/* ---------- signatures ---------- */
.sigs{display:flex;gap:26px;margin:12px 0 4px;break-inside:avoid}
.sig{flex:1}
.sig .pad{height:30px;border-bottom:1px solid #6E6E6C;display:flex;
    align-items:flex-end;justify-content:center;padding-bottom:2px}
.sig .cap{font-size:8.4pt;font-weight:700;color:var(--muted);padding-top:3px}
.sig-img{max-height:28px;max-width:100%}
.sig-text{font-family:${t.sigFont};font-style:italic;font-size:12pt}

/* ---------- tables ---------- */
table.tbl{width:100%;border-collapse:collapse;margin:6px 0 8px;break-inside:auto}
table.tbl.nosplit{break-inside:avoid;page-break-inside:avoid}
table.tbl th{background:var(--brand);color:#fff;font-size:9.2pt;font-weight:700;
    padding:6px 8px;text-align:left;border:1px solid var(--brand)}
table.tbl td{border:1px solid var(--rule);padding:6px 8px;height:22px;vertical-align:top}
table.tbl tbody tr{break-inside:avoid}
table.tbl tbody tr:nth-child(even) td{background:var(--zebra)}
table.tbl .c{text-align:center}
table.tbl td.item{font-weight:600}

/* ---------- key/value fallback table ---------- */
table.kv{width:100%;border-collapse:collapse}
table.kv td{border-bottom:1px solid #EDEDED;padding:5px 6px;vertical-align:top}
table.kv td.k{width:36%;font-weight:700}
table.kv tr{break-inside:avoid}
`;
}

module.exports = { buildCss, DEFAULT_THEME };