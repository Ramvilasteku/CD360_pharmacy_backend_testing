const PDFDocument = require("pdfkit");
const fs   = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
/* ═══════════════════════════════════════════════
   IMAGE LOADER
═══════════════════════════════════════════════ */


async function imageToBuffer(imageUrl) {
  return new Promise((resolve, reject) => {
    const client = imageUrl.startsWith("https") ? https : http;

    client.get(imageUrl, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Image fetch failed: ${res.statusCode}`));
      }

      const data = [];

      res.on("data", chunk => data.push(chunk));
      res.on("end", () => resolve(Buffer.concat(data)));
    }).on("error", reject);
  });
}

/* ═══════════════════════════════════════════════
   DESIGN TOKENS
═══════════════════════════════════════════════ */
const TEAL        = "#3f6f7a";
const TEAL_DARK   = "#2d5560";
const TEAL_LIGHT  = "#eef6f7";
const TEXT_DARK   = "#1a2e35";
const TEXT_MUTED  = "#7a9ba3";
const BORDER      = "#c8dde0";
const ROW_ALT     = "#f4fafb";
const WHITE       = "#ffffff";

const PAGE_W = 595;
const PAGE_H = 842;
const ML     = 36;
const MR     = 36;
const CW     = PAGE_W - ML - MR;   // 523

/* ═══════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════ */
function hLine(doc, y, color, lw) {
  color = color || BORDER; lw = lw || 0.5;
  doc.save().strokeColor(color).lineWidth(lw)
     .moveTo(ML, y).lineTo(PAGE_W - MR, y).stroke().restore();
}

function sectionLabel(doc, text, y) {
  doc.save()
     .fontSize(7).font("Helvetica-Bold").fillColor(TEAL)
     .text(text.toUpperCase(), ML, y, { characterSpacing: 1.2 })
     .restore();
  return y + 13;
}

/* ═══════════════════════════════════════════════
   TABLE  —  cols:[{header,key,width,align}]
             rows: plain objects
   Returns Y after table.
═══════════════════════════════════════════════ */
function drawTable(doc, cols, rows, startY) {
  const HEAD_H = 18;
  const ROW_H  = 20;
  const PX     = 5;
  const PY     = 4;

  let y = startY;

  /* header bar */
  doc.save().rect(ML, y, CW, HEAD_H).fill(TEAL).restore();

  let cx = ML;
  cols.forEach((col) => {
    doc.save()
       .fontSize(6.5).font("Helvetica-Bold").fillColor(WHITE)
       .text(col.header.toUpperCase(), cx + PX, y + PY, {
         width: col.width - PX * 2,
         align: col.align || "left",
         characterSpacing: 0.5,
         lineBreak: false,
       }).restore();
    cx += col.width;
  });
  y += HEAD_H;

  /* data rows */
  rows.forEach((row, ri) => {
    const bg = ri % 2 === 0 ? WHITE : ROW_ALT;
    doc.save().rect(ML, y, CW, ROW_H).fill(bg).restore();
    doc.save().strokeColor(BORDER).lineWidth(0.3)
       .moveTo(ML, y + ROW_H).lineTo(ML + CW, y + ROW_H).stroke().restore();

    cx = ML;
    cols.forEach((col) => {
      const val = String(row[col.key] !== undefined && row[col.key] !== null ? row[col.key] : "—");
      doc.save()
         .fontSize(8).font("Helvetica").fillColor(TEXT_DARK)
         .text(val, cx + PX, y + PY + 1, {
           width: col.width - PX * 2,
           align: col.align || "left",
           lineBreak: false,
           ellipsis: true,
         }).restore();
      cx += col.width;
    });
    y += ROW_H;
  });

  /* outer border */
  doc.save().rect(ML, startY, CW, y - startY).stroke(BORDER).restore();

  /* vertical column separators */
  cx = ML;
  cols.forEach((col, i) => {
    if (i > 0) {
      doc.save().strokeColor(BORDER).lineWidth(0.3)
         .moveTo(cx, startY).lineTo(cx, y).stroke().restore();
    }
    cx += col.width;
  });

  return y + 12;
}

/* ═══════════════════════════════════════════════
   HEADER — 3 distinct columns with separators
   Col A: Logo + Clinic Name + Branch
   Col B: "Prescription" label + issued date
   Col C: Phone, Email, Address
═══════════════════════════════════════════════ */
async function drawHeader(doc, clinic, branch, logoBuffer) {
  const HDR_H = 74;
  const COL_AW = 205;
  const COL_BW = 150;

  /* white background */
  doc.save().rect(0, 0, PAGE_W, HDR_H).fill(WHITE).restore();

  /* ── COL A: Logo + Name + Branch ── */
  const LSIZE = 50;
  const lx = ML;
  const ly = (HDR_H - LSIZE) / 2;

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, lx, ly, { width: LSIZE, height: LSIZE });
    } catch {}
  }

  const nameX = logoBuffer ? lx + LSIZE + 10 : lx;
  const nameW = COL_AW - (nameX - ML) - 10;

  doc.save()
    .fontSize(10)
    .font("Helvetica-Bold")
    .fillColor(TEXT_DARK)
    .text(clinic.name || "", 0, 18, { width: PAGE_W, align: "center" })
    .restore();

  doc.save()
    .fontSize(8)
    .font("Helvetica")
    .fillColor(TEXT_MUTED)
    .text("Branch: " + (branch || "—"), 0, 40, { width: PAGE_W, align: "center" })
    .restore();

  /* ── COL B: Issued date ── */
  const bX = ML + COL_AW + 14;

  // doc.save()
  //    .fontSize(8)
  //    .font("Helvetica")
  //    .fillColor(TEXT_MUTED)
  //    .text(
  //      "Issued: " +
  //        new Date().toLocaleDateString("en-IN", {
  //          day: "2-digit",
  //          month: "short",
  //          year: "numeric",
  //        }),
  //      bX,
  //      30,
  //      { width: COL_BW - 20 }
  //    )
  //    .restore();

  /* ── COL C: Contact info ── */
  const cX = ML + COL_AW + COL_BW + 14;
  const cW = PAGE_W - cX - MR;

  const contacts = [
    clinic.phone   ? "Phone:"+clinic.phone   : null,
    clinic.email   ? "Email:"+ clinic.email   : null,
    clinic.address ? clinic.address       : null,
  ].filter(Boolean);

  let cy = 18;
  contacts.forEach((line) => {
    doc.save()
       .fontSize(8)
       .font("Helvetica")
       .fillColor(TEXT_DARK)
       .text(line, cX, cy, { width: cW, lineBreak: false, ellipsis: true })
       .restore();
    cy += 14;
  });

  /* bottom divider */
  doc.save()
     .strokeColor(BORDER)
     .lineWidth(1)
     .moveTo(ML, HDR_H)
     .lineTo(PAGE_W - MR, HDR_H)
     .stroke()
     .restore();

  return HDR_H + 12;
}





/* ═══════════════════════════════════════════════
   INFO BAND — Patient | Doctor | Appointment
   3 equal columns with clear dividers
═══════════════════════════════════════════════ */
function drawInfoBand(doc, patient, doctor, appointment, startY) {
  const BAND_H = 56;
  const COL_W  = Math.floor(CW / 3);

  /* light background */
  doc.save().rect(ML, startY, CW, BAND_H).fill(TEAL_LIGHT).restore();
  hLine(doc, startY,          TEAL, 0.8);
  hLine(doc, startY + BAND_H, TEAL, 0.8);

  const apptDate = appointment && appointment.appointment_date
    ? new Date(appointment.appointment_date).toLocaleDateString("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
      })
    : "—";

  const items = [
    { label: "PATIENT",     line1: patient.name  || "—", line2: "ID: " + (patient.id || "—") },
    { label: "DOCTOR",      line1: doctor.name   || "—", line2: doctor.qualification || "" },
    { label: "APPOINTMENT", line1: apptDate,             line2: "ID: #" + (appointment && appointment.id ? appointment.id : "—") },
  ];

  items.forEach((item, i) => {
    const colX = ML + i * COL_W;
    const padX = 10;

    /* vertical divider between columns */
    if (i > 0) {
      doc.save().strokeColor(BORDER).lineWidth(0.5)
         .moveTo(colX, startY + 8).lineTo(colX, startY + BAND_H - 8).stroke().restore();
    }

    doc.save()
       .fontSize(6.5).font("Helvetica-Bold").fillColor(TEAL)
       .text(item.label, colX + padX, startY + 9, { characterSpacing: 1, width: COL_W - padX * 2 })
       .restore();
    doc.save()
       .fontSize(11).font("Helvetica-Bold").fillColor(TEXT_DARK)
       .text(item.line1, colX + padX, startY + 22, { width: COL_W - padX * 2, lineBreak: false, ellipsis: true })
       .restore();
    if (item.line2) {
      doc.save()
         .fontSize(7.5).font("Helvetica").fillColor(TEXT_MUTED)
         .text(item.line2, colX + padX, startY + 39, { width: COL_W - padX * 2, lineBreak: false })
         .restore();
    }
  });

  return startY + BAND_H + 16;
}

/* ═══════════════════════════════════════════════
   CLINICAL BAND — Chief Complaint | Treatment Plan
   2 equal columns, directly under patient/doctor band
═══════════════════════════════════════════════ */
function drawClinicalBand(doc, notes, startY) {
  const hasChief = !!notes.chiefComplaint;
  const hasPlan  = !!notes.treatmentPlan;
  if (!hasChief && !hasPlan) return startY;   // nothing to draw, skip entirely

  const COL_W = Math.floor(CW / 2);

  const chiefH = hasChief
    ? doc.heightOfString(notes.chiefComplaint, { width: COL_W - 20, fontSize: 9 })
    : 0;
  const planH = hasPlan
    ? doc.heightOfString(notes.treatmentPlan, { width: COL_W - 20, fontSize: 9 })
    : 0;
  const BAND_H = Math.max(chiefH, planH) + 34;

  doc.save().rect(ML, startY, CW, BAND_H).fill(TEAL_LIGHT).restore();
  hLine(doc, startY,          TEAL, 0.8);
  hLine(doc, startY + BAND_H, TEAL, 0.8);

  const items = [
    { label: "CHIEF COMPLAINT",  value: notes.chiefComplaint || "—" },
    { label: "TREATMENT PLAN",   value: notes.treatmentPlan  || "—" },
  ];

  items.forEach((item, i) => {
    const colX = ML + i * COL_W;
    const padX = 10;

    if (i > 0) {
      doc.save().strokeColor(BORDER).lineWidth(0.5)
         .moveTo(colX, startY + 8).lineTo(colX, startY + BAND_H - 8).stroke().restore();
    }

    doc.save()
       .fontSize(6.5).font("Helvetica-Bold").fillColor(TEAL)
       .text(item.label, colX + padX, startY + 9, { characterSpacing: 1, width: COL_W - padX * 2 })
       .restore();
    doc.save()
       .fontSize(9).font("Helvetica").fillColor(TEXT_DARK)
       .text(item.value, colX + padX, startY + 22, { width: COL_W - padX * 2 })
       .restore();
  });

  return startY + BAND_H + 16;
}

/* ═══════════════════════════════════════════════
   FOOTER — logo + name left | signed centre | contact right
═══════════════════════════════════════════════ */
function drawFooter(doc, clinic, doctor, logoBuffer) {
  const FH = 60;
  const FY = PAGE_H - FH;

  /* white background */
  doc.save().rect(0, FY, PAGE_W, FH).fill(WHITE).restore();

  /* top divider */
  doc.save()
     .strokeColor(BORDER)
     .lineWidth(1)
     .moveTo(ML, FY)
     .lineTo(PAGE_W - MR, FY)
     .stroke()
     .restore();

  /* ── LEFT: logo + clinic name ── */
  const LSIZE = 50;
  const lx = ML;
  const ly = FY + (FH - LSIZE) / 2;

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, lx, ly, { width: LSIZE, height: LSIZE });
    } catch {}
  }

  const nameX = logoBuffer ? lx + LSIZE + 10 : lx;

  // doc.save()
  //    .fontSize(11)
  //    .font("Helvetica-Bold")
  //    .fillColor(TEXT_DARK)
  //    .text(clinic.name || "", nameX, FY + 18, { lineBreak: false })
  //    .restore();

  // doc.save()
  //    .fontSize(7)
  //    .font("Helvetica")
  //    .fillColor(TEXT_MUTED)
  //    .text("© " + new Date().getFullYear() + " All rights reserved", nameX, FY + 34)
  //    .restore();

  /* ── CENTER: signed by ── */
  doc.save()
     .fontSize(6.5)
     .font("Helvetica")
     .fillColor(TEXT_MUTED)
     .text("ELECTRONICALLY SIGNED BY", 0, FY + 10, {
       width: PAGE_W,
       align: "center",
       characterSpacing: 1,
     })
     .restore();

  doc.save()
     .fontSize(11)
     .font("Helvetica-Bold")
     .fillColor(TEXT_DARK)
     .text(doctor.name || "", 0, FY + 24, {
       width: PAGE_W,
       align: "center",
     })
     .restore();

  doc.save()
     .fontSize(7.5)
     .font("Helvetica")
     .fillColor(TEXT_MUTED)
     .text(doctor.qualification || "", 0, FY + 38, {
       width: PAGE_W,
       align: "center",
     })
     .restore();

  /* ── RIGHT: contact ── */
  const rc = [
    clinic.phone ? "Phone:" + clinic.phone : null,
    clinic.email ? "Email:" + clinic.email : null,
  ].filter(Boolean);

  let ry = FY + 18;
  rc.forEach((line) => {
    doc.save()
       .fontSize(7.5)
       .font("Helvetica")
       .fillColor(TEXT_DARK)
       .text(line, 0, ry, { width: PAGE_W - MR, align: "right" })
       .restore();
    ry += 13;
  });
}

/* ═══════════════════════════════════════════════
   MAIN EXPORT
═══════════════════════════════════════════════ */
module.exports = async function buildPrescriptionPDF(data) {
  const {
    clinic        = {},
    branch        = "—",
    patient       = {},
    doctor        = {},
    appointment   = {},
    medicines     = [],
    tests         = [],
    consultations = [],
     notes         = { chiefComplaint: "", treatmentPlan: "", doctorNotes: "" },
  } = data;

  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: true });
  const buffers = [];
  doc.on("data", buffers.push.bind(buffers));

  /* ✅ CRITICAL: register "end" listener BEFORE doc.end() */
  const pdfReady = new Promise((resolve, reject) => {
    doc.on("end",   () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
  });

  let logoBuffer = null;

if (clinic.logo) {
  try {
    logoBuffer = await imageToBuffer(clinic.logo);
  } catch (err) {
    console.warn("Logo load failed:", err.message);
  }
}

  /* ── HEADER ── */
  let y = await drawHeader(doc, clinic, branch, logoBuffer);

  /* ── INFO BAND ── */
  y = drawInfoBand(doc, patient, doctor, appointment, y);

   y = drawClinicalBand(doc, notes, y);

  /* ── CONSULTATION TYPES ── */
  if (Array.isArray(consultations) && consultations.length) {
    y = sectionLabel(doc, "Consultation Types", y);
    y = drawTable(doc,
      [
        { header: "#",            key: "_i",   width: 26,  align: "center" },
        { header: "Consultation", key: "name", width: 175 },
        { header: "Description",  key: "desc", width: CW - 26 - 175 },
      ],
      consultations.map((c, i) => ({
        _i:   i + 1,
        name: c.name || c.type || "—",
        desc: c.description || "—",
      })),
      y
    );
  }

  /* ── MEDICINES ── */
  if (Array.isArray(medicines) && medicines.length) {
    y = sectionLabel(doc, "Medicines", y);
    // widths must sum to CW (523)
    const noteW = CW - 22 - 108 - 50 - 55 - 26 - 88 - 58;  // = 116
    y = drawTable(doc,
      [
        { header: "#",        key: "_i",   width: 22,  align: "center" },
        { header: "Medicine", key: "med",  width: 108 },
        { header: "Type",     key: "type", width: 50  },
        { header: "Strength", key: "str",  width: 55  },
        { header: "Qty",      key: "qty",  width: 26,  align: "center" },
        { header: "When",     key: "when", width: 88  },
        { header: "Duration", key: "dur",  width: 58  },
        { header: "Notes",    key: "note", width: noteW },
      ],
      medicines.map((m, i) => ({
        _i:   i + 1,
        med:  m.medicine_name || "—",
        type: m.type          || "—",
        str:  (m.strength || "") + (m.unit || "") || "—",
        qty:  m.quantity      !== undefined ? m.quantity : "—",
        when: Array.isArray(m.when_to_take) ? m.when_to_take.join(", ") : (m.when_to_take || "—"),
        dur:  m.duration      || "—",
        note: m.description   || "—",
      })),
      y
    );
  }

  /* ── TESTS ── */
  if (Array.isArray(tests) && tests.length) {
    y = sectionLabel(doc, "Tests", y);
    y = drawTable(doc,
      [
        { header: "#",     key: "_i",    width: 26,  align: "center" },
        { header: "Test",  key: "name",  width: 165 },
        { header: "Type",  key: "type",  width: 100 },
        { header: "Notes", key: "notes", width: CW - 26 - 165 - 100 },
      ],
      tests.map((t, i) => ({
        _i:    i + 1,
        name:  t.test_name   || "—",
        type:  t.type        || "—",
        notes: t.description || "—",
      })),
      y
    );
  }

 
  /* ── DOCTOR NOTES (bottom, matches screen preview) ── */
  if (notes.doctorNotes) {
    y = sectionLabel(doc, "Doctor Notes", y);
    const fieldH = Math.max(
      doc.heightOfString(notes.doctorNotes, { width: CW - 20, fontSize: 9 }) + 18,
      32
    );
    doc.save().rect(ML, y, CW, fieldH).fill(TEAL_LIGHT).restore();
    hLine(doc, y,           BORDER);
    hLine(doc, y + fieldH,  BORDER);
    doc.save()
       .fontSize(9).font("Helvetica").fillColor(TEXT_DARK)
       .text(notes.doctorNotes, ML + 10, y + 9, { width: CW - 20 })
       .restore();
    y += fieldH + 10;
  }
  /* ── FOOTER ── */
  drawFooter(doc, clinic, doctor, logoBuffer);

  doc.end();
  return await pdfReady;
};