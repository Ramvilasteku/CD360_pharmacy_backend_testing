/* ═══════════════════════════════════════════════════════════════════
   AI prescription suggestions (OpenAI)

   Doctor types a chief complaint → OpenAI proposes a provisional
   diagnosis, treatment plan, medicines and tests → every medicine/test
   is matched to THIS clinic's catalogue → the doctor reviews and edits.
   Nothing is saved to a prescription until the doctor saves it.

   .env (server only — never put the key in the React app):
     OPENAI_API_KEY=sk-...
     OPENAI_MODEL=gpt-5.6-terra          # optional; gpt-5.6-luna is ~10x cheaper
     OPENAI_REASONING_EFFORT=low         # optional; "" to omit for non-reasoning models
     OPENAI_BASE_URL=https://api.openai.com/v1   # optional
     AI_RX_LIMIT_PER_HOUR=40             # optional; per user

   Privacy: only age, gender, the complaint text and the doctor's
   qualification are sent. No patient name, phone, email or IDs.
═══════════════════════════════════════════════════════════════════ */

const db = require("../db");

const MODEL = () => process.env.OPENAI_MODEL || "gpt-5.6-terra";
const BASE_URL = () => (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const EFFORT = () =>
  process.env.OPENAI_REASONING_EFFORT === undefined ? "low" : process.env.OPENAI_REASONING_EFFORT;
const TIMEOUT_MS = 60000;

const WHEN = ["Morning", "Afternoon", "Evening", "Night"];

/* ── Schema probing ───────────────────────────────────────────────
   Installations differ: some tables carry a tenant column (admin_id,
   clinic_id, …), some carry none, and patient age/gender live under
   different names. Read the real columns once per table, cache them,
   and build each WHERE clause from what is actually there — so this
   service can never fail with "Unknown column".
─────────────────────────────────────────────────────────────────── */
const TENANT_COLS = ["admin_id", "clinic_id", "tenant_id", "hospital_id", "company_id", "branch_id"];
const schemaCache = new Map();

async function columnsOf(table) {
  if (schemaCache.has(table)) return schemaCache.get(table);
  let cols = new Set();
  try {
    const [rows] = await db.execute(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    cols = new Set(rows.map((r) => String(r.c).toLowerCase()));
    if (!cols.size) console.warn(`[AI-RX] table "${table}" not found in this database`);
  } catch (err) {
    console.warn(`[AI-RX] could not read columns of ${table}:`, err.message);
  }
  schemaCache.set(table, cols);
  return cols;
}

/* name of this table's tenant column, or null if it isn't scoped */
async function tenantColumn(table) {
  const cols = await columnsOf(table);
  return TENANT_COLS.find((c) => cols.has(c)) || null;
}

const firstCol = (cols, names) => names.find((n) => cols.has(n)) || null;

/* ── Response shape OpenAI must follow (Structured Outputs, strict) ── */
const SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "enough_information", "follow_up_questions", "provisional_diagnosis",
    "differential_diagnoses", "treatment_plan", "advice", "medicines",
    "tests", "red_flags", "cautions",
  ],
  properties: {
    enough_information: {
      type: "boolean",
      description: "false if the complaint is too vague to suggest treatment safely",
    },
    follow_up_questions: {
      type: "array", items: { type: "string" },
      description: "What the doctor should ask/examine next. Empty if not needed.",
    },
    provisional_diagnosis: { type: "string" },
    differential_diagnoses: { type: "array", items: { type: "string" } },
    treatment_plan: { type: "string", description: "2-4 short sentences" },
    advice: { type: "array", items: { type: "string" }, description: "Advice for the patient" },
    medicines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "generic_name", "brand_examples", "form", "strength", "dose_count",
          "dose_text", "when_to_take", "food_timing", "duration_days", "purpose", "caution",
        ],
        properties: {
          generic_name: { type: "string", description: "e.g. Paracetamol" },
          brand_examples: {
            type: "array", items: { type: "string" },
            description: "1-3 common Indian brand names with strength, e.g. Dolo 650",
          },
          form: {
            type: "string",
            enum: ["Tablet", "Capsule", "Syrup", "Suspension", "Drops", "Injection",
                   "Ointment", "Cream", "Gel", "Inhaler", "Mouthwash", "Powder", "Other"],
          },
          strength: { type: "string", description: "e.g. 650 mg, 5 ml, 0.2%" },
          dose_count: { type: "number", description: "units per intake, e.g. 1 or 0.5" },
          dose_text: { type: "string", description: "e.g. 1 tablet, 5 ml, 15 mg/kg (weight needed)" },
          when_to_take: { type: "array", items: { type: "string", enum: WHEN } },
          food_timing: {
            type: "string",
            enum: ["After food", "Before food", "With food", "Empty stomach", "At bedtime", "As needed", "Not applicable"],
          },
          duration_days: { type: "integer" },
          purpose: { type: "string" },
          caution: { type: "string", description: "Short caution or empty string" },
        },
      },
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "reason"],
        properties: { name: { type: "string" }, reason: { type: "string" } },
      },
    },
    red_flags: {
      type: "array", items: { type: "string" },
      description: "Signs that need urgent referral / emergency care",
    },
    cautions: {
      type: "array", items: { type: "string" },
      description: "Allergy, pregnancy, age, kidney/liver, interaction checks the doctor must do",
    },
  },
};

const SYSTEM_PROMPT = `You are a clinical decision-support assistant for licensed doctors at clinics in India.
A doctor reviews and edits everything you propose; you never replace their judgement.

From the chief complaint and basic patient details, propose a provisional diagnosis, differentials,
a short treatment plan, medicines commonly available in India, relevant investigations, patient advice,
red flags needing urgent referral, and cautions.

Rules:
- Follow standard Indian practice (NLEM/ICMR/specialty guidelines). Prefer first-line, conservative care.
- Antibiotics only when clearly indicated; say why in "purpose".
- Never suggest narcotics, Schedule X drugs or off-label use.
- Children under 12: give weight-based dosing in dose_text and add a caution that weight is needed.
- Women 15-50: add a pregnancy/lactation caution when a suggested drug needs it.
- If the complaint is too vague to treat safely: enough_information=false, list follow_up_questions,
  and give only safe symptomatic medicines or none.
- Tailor to the doctor's specialty (e.g. BDS/MDS = dental, dermatology, paediatrics).
- At most 6 medicines and 5 tests. Keep every text short.
- when_to_take uses only Morning, Afternoon, Evening, Night (e.g. twice daily = Morning + Night).`;

/* ── Small per-user rate limit (protects your OpenAI bill) ── */
const usage = new Map(); // userKey -> [timestamps]
function checkRateLimit(userKey) {
  const limit = Number(process.env.AI_RX_LIMIT_PER_HOUR) || 40;
  const now = Date.now();
  const recent = (usage.get(userKey) || []).filter((t) => now - t < 3600000);
  if (recent.length >= limit) return false;
  recent.push(now);
  usage.set(userKey, recent);
  return true;
}

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now < new Date(now.getFullYear(), d.getMonth(), d.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

class AiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ── OpenAI call (Chat Completions + Structured Outputs) ── */
async function callOpenAI(userPayload) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new AiError(503, "AI suggestions are not set up: add OPENAI_API_KEY to the server .env and restart.");
  if (typeof fetch !== "function") throw new AiError(500, "AI suggestions need Node.js 18 or newer on the server.");

  const body = {
    model: MODEL(),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "prescription_suggestion", strict: true, schema: SUGGESTION_SCHEMA },
    },
  };
  if (EFFORT()) body.reasoning_effort = EFFORT();

  const send = async (payload) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => ({}));
      return { res, json };
    } catch (err) {
      if (err.name === "AbortError") throw new AiError(504, "The AI took too long to answer. Please try again.");
      throw new AiError(502, "Could not reach OpenAI: " + err.message);
    } finally {
      clearTimeout(timer);
    }
  };

  let { res, json } = await send(body);

  /* a non-reasoning model (e.g. gpt-4.1) rejects reasoning_effort — retry once without it */
  if (res.status === 400 && body.reasoning_effort && /reasoning/i.test(json?.error?.message || "")) {
    delete body.reasoning_effort;
    ({ res, json } = await send(body));
  }

  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new AiError(502, "OpenAI rejected the API key. Check OPENAI_API_KEY on the server.");
    if (res.status === 429) throw new AiError(429, "OpenAI is rate-limiting or the account is out of credit. Try again shortly.");
    if (res.status === 404) throw new AiError(502, `OpenAI model "${body.model}" is not available to this key. Set OPENAI_MODEL.`);
    throw new AiError(502, "OpenAI error: " + msg);
  }

  const choice = json?.choices?.[0];
  if (choice?.message?.refusal) throw new AiError(422, "The AI declined to answer: " + choice.message.refusal);
  if (choice?.finish_reason === "length") throw new AiError(502, "The AI answer was cut off. Please try again.");

  try {
    return { suggestion: JSON.parse(choice?.message?.content || ""), usage: json.usage || null, model: json.model || body.model };
  } catch {
    throw new AiError(502, "The AI returned an answer that could not be read. Please try again.");
  }
}

/* ── Catalogue matching ───────────────────────────────────────── */
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => "\\" + c);
const startsPattern = (text) =>
  String(text).trim().split(/[\s_\-]+/).filter(Boolean).slice(0, 4).map(likeEscape).join("_") + "%";

/* index-friendly lookup (same approach as /api/medicines/search) */
async function medicinesStartingWith(text, adminId, limit = 5) {
  if (!String(text || "").trim()) return [];
  const tcol = await tenantColumn("medicines");
  /* shared catalogue rows (tenant column NULL) stay visible to everyone */
  const scope = tcol ? `AND (\`${tcol}\` IS NULL OR \`${tcol}\` = ?)` : "";
  const params = tcol ? [startsPattern(text), adminId] : [startsPattern(text)];
  const [rows] = await db.execute(
    `SELECT m.id, m.medicine_name, m.type, m.strength, m.unit, m.amount
     FROM medicines m
     JOIN (
       SELECT id FROM medicines
       WHERE medicine_name LIKE ? ${scope}
       ORDER BY medicine_name ASC
       LIMIT ${Number(limit)}
     ) pick ON pick.id = m.id
     ORDER BY m.medicine_name ASC`,
    params
  );
  return rows;
}

const strengthNumber = (s) => (String(s || "").match(/\d+(\.\d+)?/) || [""])[0];

async function matchMedicine(med, adminId) {
  const tries = [
    ...(med.brand_examples || []).slice(0, 3),
    [med.generic_name, strengthNumber(med.strength)].filter(Boolean).join(" "),
    med.generic_name,
  ].filter((t) => String(t || "").trim().length >= 3);

  const seen = new Map();
  for (const t of tries) {
    for (const row of await medicinesStartingWith(t, adminId, 5)) {
      if (!seen.has(row.id)) seen.set(row.id, row);
    }
    if (seen.size >= 5) break;
  }

  /* put catalogue items whose strength matches the AI's strength first;
     then ones that at least carry the number in their name */
  const want = strengthNumber(med.strength);
  const rank = (row) => {
    if (!want) return 1;
    if (strengthNumber(row.strength) === want) return 0;
    if (new RegExp(`(^|\\D)${want.replace(".", "\\.")}(\\D|$)`).test(row.medicine_name)) return 1;
    return 2;
  };
  return [...seen.values()]
    .map((row, i) => ({ row, i, r: rank(row) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.row)
    .slice(0, 5);
}

async function matchTest(name, adminId) {
  const clean = String(name || "").trim();
  if (!clean) return null;
  const tcol = await tenantColumn("tests");
  const scope = tcol ? `\`${tcol}\` = ? AND` : "";
  const pre = tcol ? [adminId] : [];
  const [exact] = await db.execute(
    `SELECT id, test_name, test_type, description, amount FROM tests
     WHERE ${scope} LOWER(TRIM(test_name)) = LOWER(?) LIMIT 1`,
    [...pre, clean]
  );
  if (exact.length) return exact[0];
  const [like] = await db.execute(
    `SELECT id, test_name, test_type, description, amount FROM tests
     WHERE ${scope} test_name LIKE ? ORDER BY CHAR_LENGTH(test_name) ASC LIMIT 1`,
    [...pre, `%${likeEscape(clean)}%`]
  );
  return like[0] || null;
}

/* the clinic writes durations as "3_days" or "3 days" — follow their style */
async function durationStyle() {
  try {
    const [[u]] = await db.execute(
      "SELECT COUNT(*) AS n FROM (SELECT 1 FROM medicines WHERE duration LIKE '%\\_day%' LIMIT 1) x"
    );
    return Number(u.n) > 0 ? "_" : " ";
  } catch {
    return " ";
  }
}

/* ── Main entry used by the route ─────────────────────────────── */
async function suggestPrescription({ adminId, user, chiefComplaint, patientId, extraNotes }) {
  const complaint = String(chiefComplaint || "").trim().replace(/\s+/g, " ");
  if (complaint.length < 2) throw new AiError(400, "Write the chief complaint first.");
  if (complaint.length > 500) throw new AiError(400, "Chief complaint is too long (max 500 characters).");

  if (!checkRateLimit(`${adminId}:${user.role}:${user.id}`)) {
    throw new AiError(429, "AI suggestion limit reached for this hour. Please try again later.");
  }

  /* patient context — age and gender only */
  let age = null, gender = null;
  if (patientId) {
    const cols      = await columnsOf("clients");
    const genderCol = firstCol(cols, ["gender", "sex"]);
    const dobCol    = firstCol(cols, ["dob", "date_of_birth", "birth_date", "dateofbirth"]);
    const ageCol    = firstCol(cols, ["age"]);
    const select    = [genderCol, dobCol, ageCol].filter(Boolean).map((c) => `\`${c}\``).join(", ");

    if (select) {
      const tcol  = await tenantColumn("clients");
      const where = tcol ? `id = ? AND \`${tcol}\` = ?` : "id = ?";
      const [[p]] = await db.execute(
        `SELECT ${select} FROM clients WHERE ${where} LIMIT 1`,
        tcol ? [patientId, adminId] : [patientId]
      );
      if (p) {
        gender = (genderCol && p[genderCol]) || null;
        if (dobCol) age = ageFromDob(p[dobCol]);
        if (age === null && ageCol && Number(p[ageCol]) > 0) age = Number(p[ageCol]);
      }
    }
  }

  /* doctor specialty steers the suggestion (BDS → dental, etc.) */
  let specialty = null;
  if (user.role === "doctor") {
    const cols = await columnsOf("staff");
    const qCol = firstCol(cols, [
      "qualification", "qualifications", "specialization", "speciality", "specialty", "degree",
    ]);
    if (qCol) {
      const [[s]] = await db.execute(`SELECT \`${qCol}\` AS q FROM staff WHERE id = ? LIMIT 1`, [user.id]);
      specialty = s?.q || null;
    }
  }

  const payload = {
    chief_complaint: complaint,
    extra_notes_from_doctor: String(extraNotes || "").trim().slice(0, 800) || null,
    patient_age_years: age,
    patient_gender: gender,
    doctor_specialty: specialty,
  };

  const { suggestion: s, usage: tokens, model } = await callOpenAI(payload);

  const sep = await durationStyle();
  const medicines = [];
  for (const m of (s.medicines || []).slice(0, 6)) {
    const matches = await matchMedicine(m, adminId);
    const best = matches[0] || null;
    const when = (m.when_to_take || []).filter((w) => WHEN.includes(w));
    const days = Number.isInteger(m.duration_days) && m.duration_days > 0 ? m.duration_days : null;
    medicines.push({
      /* fields the Rx pad uses */
      medicine_id: best ? best.id : "",
      medicine_name: best ? best.medicine_name : `${m.generic_name} ${m.strength}`.trim(),
      type: best?.type || m.form,
      strength: best ? best.strength || "" : strengthNumber(m.strength),
      unit: best ? best.unit || "" : String(m.strength || "").replace(/^[\d.\s]+/, ""),
      quantity: Number(m.dose_count) > 0 ? Number(m.dose_count) : 1,
      when_to_take: when,
      duration: days ? `${days}${sep}day${days === 1 ? "" : "s"}` : "",
      description: [m.food_timing !== "Not applicable" ? m.food_timing : "", m.dose_text].filter(Boolean).join(" · "),
      amount: best ? Number(best.amount || 0) : 0,
      /* review-only info (stripped before it goes on the pad) */
      ai: {
        generic_name: m.generic_name,
        strength: m.strength,
        brand_examples: m.brand_examples || [],
        purpose: m.purpose,
        caution: m.caution,
        in_catalog: !!best,
        alternatives: matches,
      },
    });
  }

  const tests = [];
  for (const t of (s.tests || []).slice(0, 5)) {
    const row = await matchTest(t.name, adminId);
    tests.push(row
      ? { ...row, test_id: row.id, amount: Number(row.amount || 0), ai: { name: t.name, reason: t.reason, in_catalog: true } }
      : { test_name: t.name, test_type: "", description: t.reason, amount: 0, ai: { name: t.name, reason: t.reason, in_catalog: false } });
  }

  const result = {
    chief_complaint: complaint,
    enough_information: !!s.enough_information,
    follow_up_questions: s.follow_up_questions || [],
    provisional_diagnosis: s.provisional_diagnosis || "",
    differential_diagnoses: s.differential_diagnoses || [],
    treatment_plan: s.treatment_plan || "",
    advice: s.advice || [],
    red_flags: s.red_flags || [],
    cautions: s.cautions || [],
    medicines,
    tests,
    patient_context: { age, gender, specialty },
    model,
  };

  /* audit trail (optional table — see 004_ai_rx_suggestions.sql) */
  try {
    await db.execute(
      `INSERT INTO rx_ai_suggestions
         (admin_id, user_id, user_role, patient_id, chief_complaint, model,
          prompt_tokens, completion_tokens, response_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        adminId, user.id, user.role, patientId || null, complaint, model,
        tokens?.prompt_tokens ?? null, tokens?.completion_tokens ?? null,
        JSON.stringify(s),
      ]
    );
  } catch (err) {
    if (!/doesn't exist/i.test(err.message)) console.warn("[AI-RX] log failed:", err.message);
  }

  return result;
}

module.exports = { suggestPrescription, AiError, SUGGESTION_SCHEMA, SYSTEM_PROMPT };