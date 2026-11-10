const db = require("../db");

const {
    generateClientId,
    generateTempPassword,
    hashPassword,
    sendClientCredentialsSafe
} = require("../services/clientAccount");

/*
====================================================================
form.controller.js  (public / patient-facing)

WHAT CHANGED AND WHY
--------------------
1. admin_id is derived from the QR token on the server, not read from
   req.body. The old version trusted whatever the browser sent: a
   patient could post any admin_id and file a submission into another
   clinic's records, and if the frontend forgot the field it silently
   inserted NULL. The qr_token column was never written either, so
   there was no way to tell which QR a submission came from.

2. `clients` has NO admin_id column in this schema. Clinic ownership
   could only be inferred by joining form_submissions, and that
   inference was wrong whenever a patient had no submission yet — a
   reception-created patient, or any patient after test submissions
   were cleared, was refused at the Client ID gate despite a correct
   id. The gate now looks the client up directly; see
   SCOPE_GATE_TO_CLINIC for the trade-off and how to tighten it once
   clients.admin_id exists.

3. Registration generates a Client ID and a temporary password, hashes
   it with bcrypt, and emails the credentials — the same flow as
   /client/create. So clients.password stays NOT NULL and no schema
   change is needed. A patient-supplied `password` field is never
   written to the clients row.

4. lookupClient lets the patient prefill from their clients row. They
   identify themselves with EITHER their Client ID or the email they
   registered with; the mobile number is an optional extra check. It
   returns only CLIENT_BASIC_COLUMNS, never the whole row (which holds
   the password hash). See REQUIRE_MOBILE_MATCH.

5. Identity fields are written to `clients`, and — with
   KEEP_IDENTITY_IN_FORM_DATA on — also kept in form_data, so a
   submission is a complete record of what was typed that day. A
   `password` field is never kept in form_data.

6. Values are normalised before they touch `clients`. gender and
   blood_group are ENUMs and dob is a DATE, so free-text answers like
   "Male", "A positive" or "12/05/1990" are rejected by MySQL in strict
   mode. Anything unmappable is dropped rather than failing the whole
   submission.

7. clients.email is UNIQUE, so it is checked before INSERT: a shared
   family email returns a readable 409 instead of an ER_DUP_ENTRY 500.

8. Registration is ONE-TIME. If the email is already on file, or the
   mobile AND name both match an existing client, the submission is
   refused with a 409 — see findDuplicateRegistration(). It is never
   merged into the existing record: the original code merged on the
   mobile number alone, so a second patient sharing a phone inherited
   the first one's client id and name, and every later form then
   returned the wrong person.

9. New endpoint: checkEmail. The registration form calls it while the
   patient types, so "already registered" appears under the email box
   rather than after they finish the whole form.
====================================================================
*/

/*
  Whether the mobile number is MANDATORY on lookup.

  false: the patient can load their record with the Client ID alone.
  The mobile field stays on screen and is still verified WHEN GIVEN — a
  wrong number is rejected, an empty one is allowed through.

  This is a defensible default here only because client ids are "3"
  followed by 8 random digits, so there is nothing to walk sequentially;
  a guesser faces a ~90 million wide space. It would NOT be safe if ids
  were small integers.

  Set to true to require it again — nothing else needs to change.
*/
const REQUIRE_MOBILE_MATCH = false;

/*
  Whether identity fields (name, email, mobile, address, gender, dob,
  blood group) are ALSO kept inside form_submissions.form_data.

  true:  the submission row is a complete record of what the patient
         actually typed on that date, and `clients` holds the current
         value. Useful for consent forms and audit — the clients row
         can be edited later, the submission cannot.

  false: form_data holds only the extra fields, and every identity
         value is read back from `clients`.

  The trade-off: with true there are two copies, so if reception later
  corrects a misspelt name in `clients`, the old spelling still sits in
  the historical submission. That is usually what an audit trail is
  supposed to do, but it does mean form_data is not the place to read a
  patient's CURRENT details from.

  `password` is stripped either way — see stripPasswordOnly.
*/
const KEEP_IDENTITY_IN_FORM_DATA = true;

/*
  Whether the Client ID gate requires the patient to have submitted a
  form at THIS clinic before.

  false: any Client ID or registered email in `clients` opens the form.

  Why false is the honest default here: `clients` has no admin_id
  column, so "belongs to this clinic" can only be inferred from
  form_submissions — and that inference is wrong in two common cases:

    - a patient created by reception through the admin panel has no
      submission yet, so a correct Client ID was rejected
    - after clearing test submissions, every existing patient stopped
      being recognised

  It also isn't much of a boundary: the clients table is shared across
  clinics as it stands, so the scoping was cosmetic rather than real.

  Set to true only once clients.admin_id exists and is backfilled, and
  switch these lookups to it instead of the form_submissions join.
*/
const SCOPE_GATE_TO_CLINIC = false;

// Columns exposed to a patient prefilling a form. Deliberately not
// SELECT * — clients holds a password hash.
const CLIENT_BASIC_COLUMNS = [
    "id", "name", "email", "mobile", "gender", "dob", "address", "blood_group"
];

/*
  Maps a clients column to the field `name` values a form might use.
  Keep in sync with services/pdf/clientFallback.js.

  NOTE: `password` is deliberately absent. A patient-facing QR form must
  not be able to set login credentials; the password is generated and
  hashed server-side instead.
*/
const CLIENT_FIELD_ALIASES = {
    name: [
        "name", "full_name", "client_name", "patient_name", "participant_name",
        "first_name", "patient_full_name", "name_of_patient"
    ],
    email: ["email", "email_address", "email_id", "mail", "mail_id"],
    mobile: [
        "mobile", "contact_number", "phone", "phone_number", "mobile_number",
        "phone_mobile", "mobile_no", "phone_no", "contact_no", "contact",
        "cell", "cell_number", "whatsapp_number"
    ],
    address: ["address", "client_address", "home_address", "residential_address"],
    gender: ["gender", "sex"],
    dob: ["dob", "date_of_birth", "birth_date", "birthdate"],
    blood_group: ["blood_group", "bloodgroup", "blood_type"]
};

/*
  Field names come from whatever the clinic typed into the form builder,
  so "Full Name", "full name", "mobile_no" and "MobileNo" all mean the
  same column. Compare on a canonical form — lowercase, letters and
  digits only — instead of an exact string match.

  This was a real failure: an exact match meant a registration form whose
  fields were named "Full Name" and "Mobile No" produced an empty
  clientData, so nothing was ever written to `clients`.
*/
const canon = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const ALIAS_TO_COLUMN = {};

Object.entries(CLIENT_FIELD_ALIASES).forEach(([column, aliases]) => {
    aliases.forEach((alias) => {
        ALIAS_TO_COLUMN[canon(alias)] = column;
    });
});

// Which clients column, if any, a submitted field name maps to.
const columnForKey = (key) => ALIAS_TO_COLUMN[canon(key)] || null;

/*
  Pulls the clients-table columns out of the submitted data, and reports
  which submitted keys were consumed so they can be removed before the
  rest is saved to form_submissions.
*/
function extractClientFields(data) {
    const result = {};
    const consumedKeys = [];

    for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null || value === "") continue;

        const column = columnForKey(key);
        if (!column) continue;

        // First non-empty match wins, so a form with both "name" and
        // "patient_name" doesn't overwrite one with the other.
        if (result[column] !== undefined) continue;

        result[column] = value;
        consumedKeys.push(key);
    }

    return { result, consumedKeys };
}

/*
  Removes every identity field from form_data, for every form type. The
  clients row is the single source of truth for them.

  `password` is dropped too: it is never written to `clients`, but it
  must not survive into form_submissions either, or a form field named
  "password" would be stored there as plaintext JSON.
*/
function stripClientFields(data) {
    const out = {};

    Object.entries(data).forEach(([key, value]) => {
        if (columnForKey(key)) return;
        if (canon(key) === "password") return;
        out[key] = value;
    });

    return out;
}

/*
  Keeps everything the patient typed EXCEPT a password field. Used when
  KEEP_IDENTITY_IN_FORM_DATA is true.

  A password is never stored here under any setting: form_data is plain
  JSON, readable by anyone who can read the table or open the generated
  PDF, and the real credential already lives hashed in clients.password.
*/
function stripPasswordOnly(data) {
    const out = {};

    Object.entries(data).forEach(([key, value]) => {
        if (canon(key) === "password") return;
        out[key] = value;
    });

    return out;
}

const digits = (v) => String(v || "").replace(/\D/g, "");


/*
====================================
NORMALISERS
====================================
clients.gender and clients.blood_group are ENUMs and clients.dob is a
DATE. A form builder can put any option text it likes on a field, so map
to what the column accepts — and return null rather than throwing when
there is no sensible mapping, so one odd answer never costs the patient
their whole registration.
*/

const asGender = (v) => {
    const g = String(v || "").trim().toLowerCase();
    if (!g) return null;
    if (/^(m|male|man|boy)$/.test(g)) return "male";
    if (/^(f|female|woman|girl)$/.test(g)) return "female";
    return "other";
};

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

const asBlood = (v) => {
    let b = String(v || "").toUpperCase().replace(/\s+/g, "");
    if (!b) return null;

    b = b.replace(/POSITIVE|POS|\+VE/g, "+").replace(/NEGATIVE|NEG|-VE/g, "-");
    b = b.replace(/[^ABO+-]/g, "");

    return BLOOD_GROUPS.includes(b) ? b : null;
};

// Accepts YYYY-MM-DD (the <input type="date"> format) and DD/MM/YYYY.
const asDate = (v) => {
    const s = String(v || "").trim();

    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;

    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;

    return null;
};

function normalizeClientData(raw) {
    const out = { ...raw };

    if (out.mobile) out.mobile = digits(out.mobile).slice(-10);
    if (out.gender) out.gender = asGender(out.gender);
    if (out.blood_group) out.blood_group = asBlood(out.blood_group);
    if (out.dob) out.dob = asDate(out.dob);
    if (out.name) out.name = String(out.name).trim().slice(0, 255);
    if (out.email) out.email = String(out.email).trim().toLowerCase().slice(0, 255);
    if (out.address) out.address = String(out.address).trim();

    // Never hand MySQL a value the column cannot hold.
    Object.keys(out).forEach((k) => {
        if (out[k] === null || out[k] === undefined || out[k] === "") delete out[k];
    });

    return out;
}

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || ""));

/*
  MySQL DATE comes back from mysql2 as a JS Date. Serialising that with
  res.json() gives "1990-05-12T00:00:00.000Z", which the prefill screen
  would render raw. Format from LOCAL parts — toISOString() shifts the
  date back a day for anyone east of UTC.
*/
const ymd = (d) => {
    if (!d) return null;
    if (typeof d === "string") return d.slice(0, 10);

    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/*
  Resolves the clinic from a QR token. This is the ONLY place admin_id
  comes from for a patient submission.
*/
async function adminIdFromToken(token) {
    if (!token) return null;

    const [rows] = await db.query(
        `SELECT admin_id FROM qr_codes WHERE qr_token=? AND status=1`,
        [token]
    );

    return rows.length ? rows[0].admin_id : null;
}


/*
====================================
CLINIC-SCOPED CLIENT LOOKUPS
====================================
One place that answers "does this client belong to this clinic", so the
admin_id / join fallback lives in exactly two functions.
*/

/*
  Resolves the identifier the patient typed on the gate screen: either a
  Client ID or the email they registered with.

  Deliberately NOT `WHERE c.id = ? OR c.email = ?` with the same value —
  clients.id is an INT, so MySQL would cast a non-numeric email to 0 and
  happily match a client with id 0. Pick the column first, then query.
*/
async function findClientByIdentifier(identifier, adminId, columns) {
    const select = columns.map((c) => `c.${c}`).join(", ");
    const value = String(identifier || "").trim();

    if (!value) return null;

    const byEmail = value.includes("@");

    // A Client ID is all digits. Anything else that isn't an email can
    // only be a typo, so don't send it to the database at all.
    if (!byEmail && !/^\d+$/.test(value)) return null;

    const where = byEmail ? "c.email = ?" : "c.id = ?";
    const param = byEmail ? value.toLowerCase() : value;

    if (SCOPE_GATE_TO_CLINIC) {
        const [scoped] = await db.query(
            `SELECT ${select} FROM clients c
             JOIN form_submissions s ON s.client_id = c.id
             WHERE ${where} AND s.admin_id = ?
             LIMIT 1`,
            [param, adminId]
        );
        return scoped[0] || null;
    }

    const [rows] = await db.query(
        `SELECT ${select} FROM clients c
         WHERE ${where}
         LIMIT 1`,
        [param]
    );
    return rows[0] || null;
}

/*
  By client id — used at submit time to confirm the client_id the form
  posted is real before it goes into form_submissions.
*/
async function findClientById(clientId, adminId, columns) {
    const select = columns.map((c) => `c.${c}`).join(", ");

    if (SCOPE_GATE_TO_CLINIC) {
        const [scoped] = await db.query(
            `SELECT ${select} FROM clients c
             JOIN form_submissions s ON s.client_id = c.id
             WHERE c.id = ? AND s.admin_id = ?
             LIMIT 1`,
            [clientId, adminId]
        );
        return scoped[0] || null;
    }

    const [rows] = await db.query(
        `SELECT ${select} FROM clients c
         WHERE c.id = ?
         LIMIT 1`,
        [clientId]
    );
    return rows[0] || null;
}

/*
====================================
IDENTITY LOOKUPS FOR REGISTRATION
====================================
These are deliberately NOT scoped to the clinic, unlike the Client ID
gate below.

`clients` has no admin_id column, so the table is effectively shared:
clinic membership is recorded by form_submissions, not on the client
row. That leaves email — which is UNIQUE across the whole table — as
the only dependable identity key.

Scoping these to the clinic produced a dead end: a patient with no
submission at this clinic yet looked like a stranger, so a new client
was attempted, and the global UNIQUE index then rejected it with
"That email is already registered" — with no way for the patient to
proceed. Registering here simply writes the form_submissions row that
makes them a patient of this clinic.

Trade-off: a patient who registers at a second clinic attaches to their
existing client row, and that clinic can then read the details on it.
Adding clients.admin_id and a proper patient-per-clinic model is the
real answer; this is the coherent behaviour without it.
*/
async function findClientByEmail(email) {
    if (!email) return null;

    const [rows] = await db.query(
        `SELECT * FROM clients WHERE email = ? LIMIT 1`,
        [String(email).toLowerCase()]
    );
    return rows[0] || null;
}

/*
  Every client on that number. Deliberately NOT LIMIT 1: a phone number
  is routinely shared — the live data has five patients on one number —
  so the caller has to compare names across all of them rather than
  whichever row MySQL happened to return first.
*/
async function findClientsByMobile(mobile) {
    if (!mobile) return [];

    const [rows] = await db.query(
        `SELECT * FROM clients
         WHERE mobile = ? OR RIGHT(mobile, 10) = ?`,
        [mobile, mobile]
    );
    return rows;
}

/*
====================================
HAS THIS PERSON ALREADY REGISTERED?
====================================
Registration is a ONE-TIME action. Someone already on file opens the
other forms with their Client ID; they do not register a second time.
So a repeat registration is REFUSED, not merged.

Refusing matters. The original code merged on the mobile number alone,
so a second patient sharing a phone inherited the first one's client id
and name, and every later form then returned the wrong person's record.
Merging silently is worse than an error the patient can act on.

Two ways to already be on file:

  1. EMAIL — clients.email carries a UNIQUE index, so a match is
     conclusive. This is also what the live check on the form uses.

  2. MOBILE **AND** NAME — the same person using a different email
     address. BOTH are required: a husband and wife on one number are
     two patients, not one.

Returns null when this is genuinely a new patient.
*/
async function findDuplicateRegistration(clientData) {

    const byEmail = await findClientByEmail(clientData.email);

    if (byEmail) {
        return { client: byEmail, matchedOn: "email" };
    }

    const sharing = await findClientsByMobile(clientData.mobile);

    const sameName = sharing.find(
        (c) => canon(c.name) === canon(clientData.name)
    );

    if (sameName) {
        return { client: sameName, matchedOn: "mobile+name" };
    }

    if (sharing.length) {
        console.log(
            "Registration: mobile", clientData.mobile,
            "is already used by", sharing.length, "client(s) —",
            sharing.map((c) => `${c.id} (${c.name})`).join(", "),
            "— none match the name", clientData.name,
            "so this is treated as a new patient."
        );
    }

    return null;
}


/*
====================================
GET FORM DETAILS USING QR TOKEN
====================================
GET /api/forms/qr/:token
*/
exports.getFormByQR = async (req, res) => {
    try {
        const { token } = req.params;

        const admin_id = await adminIdFromToken(token);

        if (!admin_id) {
            return res.status(404).json({ message: "Invalid QR Code" });
        }

        const [forms] = await db.query(
            `SELECT id, form_name, form_type, description
             FROM forms WHERE admin_id=? AND status=1
             ORDER BY id ASC`,
            [admin_id]
        );

        // qr_token is echoed back so the form page can send it on submit
        res.json({ admin_id, qr_token: token, forms });
    } catch (err) {
        console.log("Get Form Error", err);
        res.status(500).json({ message: "Failed to load forms" });
    }
};


/*
====================================
GET SINGLE FORM DETAILS
====================================
GET /api/forms/:admin_id/:form_id
*/
exports.getFormById = async (req, res) => {
    try {
        const { admin_id, form_id } = req.params;

        const [formRows] = await db.query(
            `SELECT id, form_name, form_type, form_schema, description
             FROM forms WHERE id=? AND admin_id=? AND status=1`,
            [form_id, admin_id]
        );

        if (formRows.length === 0) {
            return res.status(404).json({ message: "Form not found" });
        }

        const form = formRows[0];

        // form_schema is a MySQL JSON column, so mysql2 returns it parsed.
        // Parse defensively only if a row was stored as TEXT.
        let schema = form.form_schema;

        if (typeof schema === "string") {
            try {
                schema = JSON.parse(schema);
            } catch (e) {
                schema = null;
            }
        }

        const sections = Array.isArray(schema?.sections)
            ? schema.sections
            : Array.isArray(schema)
            ? [{ title: form.form_name, fields: schema }]
            : Array.isArray(schema?.fields)
            ? [{ title: form.form_name, fields: schema.fields }]
            : [];

        res.json({
            admin_id: Number(admin_id),
            id: form.id,
            form_name: form.form_name,
            form_type: form.form_type,
            description: form.description,
            sections
        });
    } catch (err) {
        console.log("Get Form By Id Error", err);
        res.status(500).json({ message: "Failed to load form" });
    }
};


/*
====================================
LOOK UP AN EXISTING CLIENT FOR PREFILL
====================================
POST /api/forms/qr/:token/client
BODY: { identifier, mobile }      // identifier = Client ID OR email
      { client_id, mobile }       // still accepted, older callers

Returns only CLIENT_BASIC_COLUMNS, and only for a client belonging to
the clinic that owns this QR token.
*/
exports.lookupClient = async (req, res) => {
    try {
        const { token } = req.params;
        const { identifier, client_id, email, mobile } = req.body;

        const admin_id = await adminIdFromToken(token);

        if (!admin_id) {
            return res.status(404).json({ message: "Invalid QR Code" });
        }

        // Whichever field the frontend sent — they mean the same thing now.
        const who = String(identifier || client_id || email || "").trim();

        if (!who) {
            return res.status(400).json({
                message: "Please enter your Client ID or registered email."
            });
        }

        if (REQUIRE_MOBILE_MATCH && !digits(mobile)) {
            return res.status(400).json({
                message: "Registered mobile number is required"
            });
        }

        const client = await findClientByIdentifier(who, admin_id, CLIENT_BASIC_COLUMNS);

        // One deliberately vague message for "no such client" and "wrong
        // mobile", so this endpoint can't be used to confirm which ids or
        // which email addresses exist.
        const notFound = () =>
            res.status(404).json({
                message: "No patient found with those details. Please check with reception."
            });

        if (!client) return notFound();

        /*
          The mobile is optional (see REQUIRE_MOBILE_MATCH), but if the
          patient typed one it must match — otherwise the field would be
          decorative, and someone half-remembering another patient's id
          would sail past a number they got wrong.
        */
        if (
            digits(mobile) &&
            digits(client.mobile).slice(-10) !== digits(mobile).slice(-10)
        ) {
            return notFound();
        }

        // Send dob as a plain YYYY-MM-DD string, not a serialised Date.
        client.dob = ymd(client.dob);

        return res.json({ client });
    } catch (err) {
        console.log("Client Lookup Error", err);
        res.status(500).json({ message: "Lookup failed" });
    }
};


/*
====================================
IS THIS EMAIL FREE TO REGISTER WITH?
====================================
POST /api/forms/qr/:token/check-email
BODY: { email }
-> { available: true|false, message }

Called by the registration form as the patient types, so "already
registered" appears under the email box instead of after they have
filled in three pages and pressed Submit.

NOTE: this does confirm whether an address is on file, which is a small
disclosure. It is gated behind a valid QR token, and the wording avoids
naming the patient. If that trade is not acceptable, delete this
endpoint and the check in DynamicForm — submitForm() still refuses the
duplicate, just later.
*/
exports.checkEmail = async (req, res) => {
    try {
        const { token } = req.params;
        const { email } = req.body;

        const admin_id = await adminIdFromToken(token);

        if (!admin_id) {
            return res.status(404).json({ message: "Invalid QR Code" });
        }

        const value = String(email || "").trim().toLowerCase();

        if (!value) {
            return res.json({ available: null, message: "" });
        }

        if (!isEmail(value)) {
            return res.json({
                available: false,
                reason: "invalid",
                message: "Please enter a valid email address."
            });
        }

        const existing = await findClientByEmail(value);

        return res.json({
            available: !existing,
            reason: existing ? "taken" : null,
            message: existing
                ? "This email address is already registered. Please use a different email address, or open the other forms with your Client ID."
                : ""
        });

    } catch (err) {
        console.log("Check Email Error", err);
        // Never block the form on this — submitForm() is the real gate.
        return res.json({ available: null, message: "" });
    }
};


/*
====================================
SUBMIT DYNAMIC FORM
====================================
POST /api/forms/submit

BODY: {
  qr_token,          // patient scanning a QR — admin_id derived from it
  form_id,
  client_id,         // required for every form except registration
  appointment_id,
  data
}
*/
exports.submitForm = async (req, res) => {
    try {
        const {
            qr_token,
            form_id,
            client_id,
            appointment_id,
            data
        } = req.body;

        if (!form_id || !data || typeof data !== "object") {
            return res.status(400).json({
                message: "form_id and data are required"
            });
        }

        /*
          Where admin_id comes from, in order of trust:
            1. the QR token  — a patient on their phone
            2. req.user      — a logged-in receptionist filling it in
          Never req.body.admin_id.
        */
        let admin_id = await adminIdFromToken(qr_token);
        let submitted_by = "patient";

        if (!admin_id && req.user) {
            admin_id = req.user.role === "admin" ? req.user.id : req.user.adminId;
            submitted_by = "receptionist";
        }

        if (!admin_id) {
            return res.status(400).json({
                message: "Invalid or expired QR code. Please scan again."
            });
        }

        // The form must belong to the clinic that owns the QR
        const [formRows] = await db.query(
            `SELECT form_type FROM forms WHERE id=? AND admin_id=? AND status=1`,
            [form_id, admin_id]
        );

        if (formRows.length === 0) {
            return res.status(404).json({ message: "Form not found" });
        }

        const form_type = formRows[0].form_type;
        let newClientId = client_id || null;

        // Set only when a brand-new account was created, so the response can
        // tell the frontend to show the Client ID to the patient.
        let createdAccount = null;

        /*
        ================================
        REGISTRATION FORM — creates or updates the client
        ================================
        */
        const isRegistration = String(form_type || "")
            .toLowerCase()
            .includes("registration");

        if (isRegistration) {

            /*
              A registration form opened by someone who ALREADY has a
              Client ID. The gate resolved them before the form rendered,
              so the identity fields were shown read-only and never
              re-typed. This is not a new registration — it is an
              existing patient completing the rest of the form, so
              nothing is created and no duplicate check applies.
            */
            if (newClientId) {

                const known = await findClientById(newClientId, admin_id, ["id"]);

                if (!known) {
                    return res.status(404).json({
                        message: "Client not found. Please check the Client ID."
                    });
                }

                console.log(
                    "Registration form completed by existing client",
                    newClientId, "— no new client created."
                );

            } else {

            // Normalise BEFORE validating, so the required check runs against
            // the values that will actually be inserted.
            const { result: rawClientData } = extractClientFields(data);
            const clientData = normalizeClientData(rawClientData);

            const missing = ["name", "mobile", "email"].filter((c) => !clientData[c]);

            if (missing.length) {
                /*
                  Logged with the submitted keys, because the usual cause is
                  a form field whose `name` doesn't map to a clients column —
                  check this line against CLIENT_FIELD_ALIASES.
                */
                console.log(
                    "Registration missing identity fields:", missing,
                    "| submitted keys:", Object.keys(data)
                );

                return res.status(400).json({
                    message:
                        "This registration form is missing required patient details: " +
                        missing.join(", ") +
                        ". Please check with reception."
                });
            }

            // clients.email is NOT NULL UNIQUE and the credentials mail goes
            // there, so reject a malformed address up front.
            if (!isEmail(clientData.email)) {
                return res.status(400).json({
                    message: "Please enter a valid email address."
                });
            }

            /*
              ONE REGISTRATION PER PERSON. Someone already on file uses
              their Client ID on the other forms — registering again is
              refused rather than merged into the existing record.

              The email case is normally caught before this by the live
              check on the form (POST .../check-email), so reaching here
              means either a race, or a match on mobile+name.
            */
            const duplicate = await findDuplicateRegistration(clientData);

            if (duplicate) {
                console.log(
                    "Registration refused — already on file as client",
                    duplicate.client.id, `(${duplicate.client.name})`,
                    "matched on", duplicate.matchedOn
                );

                return res.status(409).json({
                    already_registered: true,
                    matched_on: duplicate.matchedOn,
                    message: duplicate.matchedOn === "email"
                        ? "This email address is already registered. Please use a different email address, or open the other forms with your Client ID."
                        : "You have already registered at this clinic. Please use your Client ID to fill in the other forms, or ask at reception."
                });
            }

            {
                /*
                  clients.id is supplied explicitly, not auto-incremented —
                  same "3" + 8 random digits scheme as clientRoutes.js.
                  Retry on the rare collision.
                */
                let newId = null;

                for (let attempt = 0; attempt < 5; attempt++) {
                    const candidate = generateClientId();

                    const [taken] = await db.query(
                        `SELECT id FROM clients WHERE id=? LIMIT 1`,
                        [candidate]
                    );

                    if (taken.length === 0) {
                        newId = candidate;
                        break;
                    }
                }

                if (!newId) {
                    return res.status(500).json({
                        message: "Could not allocate a Client ID. Please try again."
                    });
                }

                /*
                  The patient never types a password, but clients.password is
                  NOT NULL. Generate one, hash it with bcrypt, and email it —
                  the same thing /client/create does. This is the ONLY password
                  path here: any `password` field the form happened to contain
                  was already dropped by extractClientFields.
                */
                const tempPassword = generateTempPassword();
                const hashed = await hashPassword(tempPassword);

                /*
                  No admin_id here — `clients` has no such column. The
                  clinic link is the form_submissions row written below.
                */
                const row = {
                    ...clientData,
                    id: newId,
                    password: hashed,
                    status: 1
                };

                const columns = Object.keys(row);

                await db.query(
                    `INSERT INTO clients (${columns.join(",")})
                     VALUES(${columns.map(() => "?").join(",")})`,
                    columns.map((c) => row[c])
                );

                // not result.insertId — the id column is supplied, not generated
                newClientId = newId;

                createdAccount = {
                    id: newId,
                    name: clientData.name,
                    email: clientData.email,
                    password: tempPassword
                };
            }

            } // end: brand-new patient

        } else {

            /*
            ================================
            EVERY OTHER FORM — must reference an existing client of THIS clinic
            ================================
            */
            if (!newClientId) {
                return res.status(400).json({
                    message: "Please enter your Client ID to continue."
                });
            }

            const owned = await findClientById(newClientId, admin_id, ["id"]);

            if (!owned) {
                return res.status(404).json({
                    message: "Client not found. Please check the Client ID."
                });
            }
        }

        /*
        ================================
        SAVE THE REST
        ================================
        With KEEP_IDENTITY_IN_FORM_DATA on, everything the patient typed is
        recorded here as well, so the submission stands on its own; `clients`
        still holds the current, editable version of the identity fields.
        A password field is dropped either way.
        */
        const formData = KEEP_IDENTITY_IN_FORM_DATA
            ? stripPasswordOnly(data)
            : stripClientFields(data);

        await db.query(
            `
            INSERT INTO form_submissions
            (
                admin_id,
                form_id,
                client_id,
                appointment_id,
                qr_token,
                submitted_by,
                form_data
            )
            VALUES(?,?,?,?,?,?,?)
            `,
            [
                admin_id,
                form_id,
                newClientId,
                appointment_id || null,
                qr_token || null,
                submitted_by,
                JSON.stringify(formData)
            ]
        );

        /*
          Sent only after the submission row is safely written, and NOT
          awaited: the account already exists, so a slow or bouncing SMTP
          server must not turn a successful registration into a 500, or
          leave the patient watching a spinner for ten seconds.
        */
        if (createdAccount) {
            sendClientCredentialsSafe({
                name: createdAccount.name,
                email: createdAccount.email,
                password: createdAccount.password,
                clientId: createdAccount.id
            });
        }

        return res.json({
            success: true,
            message: "Form submitted successfully",
            client_id: newClientId,
            // true only for a brand-new account, so the frontend knows to
            // show the Client ID before navigating away
            new_client: !!createdAccount
        });

    } catch (err) {
        console.log("Submit Form Error", err);
        res.status(500).json({ message: "Form submission failed" });
    }
};