/*
====================================================================
services/pdf/fieldValues.js

Tolerant lookup layer between form_data (whatever keys your builder
happened to save: "Emergency name", "emergency_mobile", "dob",
"Consent class video"...) and the fixed layout of the printed form.

Every template asks for a value by a LIST of likely keys. Matching is
done on a normalized key (lowercase, alphanumerics only), so
   "Date of Birth"  ==  "date_of_birth"  ==  "dateOfBirth"  ==  "DOB "
all resolve to the same field. If no exact match is found it falls
back to a substring match, so "Participant signature date" is still
found by ["participant sign date"].

Nothing here is yoga-specific — reuse it for any printed form.
====================================================================
*/

const norm = (s) =>
    String(s === null || s === undefined ? "" : s)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

const YES = /^(yes|y|true|1|on|checked|agree|agreed|accept|accepted)$/i;
const NO = /^(no|n|false|0|off|unchecked|decline|declined)$/i;

function escapeHtml(v) {
    return String(v === null || v === undefined ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function isDataImage(v) {
    return typeof v === "string" && /^data:image\/[a-z+]+;base64,/i.test(v.trim());
}

/**
 * @param {object} formData    form_submissions.form_data
 * @param {object} [fallback]  second source consulted only when form_data has
 *   nothing — used for identity fields that submitForm() moved into the
 *   clients table (see clientFallback.js).
 */
/** whitespace-collapsed lowercase, punctuation KEPT (word boundaries matter) */
const loose = (s) => String(s === null || s === undefined ? "" : s)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Does a stored answer refer to this option?
 *
 * Normalized equality first — that already absorbs the harmless
 * differences ("6:00 – 7:00 AM" vs "6:00-7:00 AM" both become
 * "600700am").
 *
 * Then, and only then, a WORD-BOUNDARY prefix match, so a truncated
 * answer still counts ("Hatha" -> "Hatha Yoga", "Testimonial" ->
 * "Testimonial (Written/Video)").
 *
 * What this must never do is plain substring containment. That was the
 * old rule, and it ticked Male for a patient who answered Female,
 * because norm("female").includes(norm("male")). Same trap in "Other"
 * vs "Mother", "No" vs "Not applicable", "Yes" vs "Yesterday".
 */
function optionMatches(chosen, option) {
    const a = norm(chosen);
    const b = norm(option);
    if (!a || !b) return false;
    if (a === b) return true;

    // prefix must end on a non-alphanumeric boundary, so "Yes" matches
    // "Yes, I Consent" but "No" does not match "Not applicable"
    const boundedPrefix = (long, short) =>
        long.length > short.length &&
        long.startsWith(short) &&
        /[^a-z0-9]/.test(long.charAt(short.length));

    const la = loose(chosen);
    const lb = loose(option);
    return boundedPrefix(lb, la) || boundedPrefix(la, lb);
}

function createResolver(formData, fallback) {
    const data = formData && typeof formData === "object" ? formData : {};
    const extra = fallback && typeof fallback === "object" ? fallback : {};

    // normalized key -> value  (first key wins on collision)
    const index = new Map();
    const normKeys = [];

    const addSource = (src) => {
        Object.keys(src).forEach((k) => {
            const nk = norm(k);
            if (!index.has(nk)) {
                index.set(nk, src[k]);
                normKeys.push(nk);
            }
        });
    };

    addSource(data);   // form_data always wins
    addSource(extra);  // clients row fills the gaps

    /**
     * Raw value for the first candidate key that resolves.
     * @param {object} [opts] { exact:true } disables the substring pass —
     *   use it for narrow lookups like "<field> other", where a fuzzy hit
     *   on another field's key would silently leak a value across groups.
     */
    function raw(candidates, opts = {}) {
        const list = Array.isArray(candidates) ? candidates : [candidates];

        // pass 1 — exact (normalized) match
        for (const c of list) {
            const nc = norm(c);
            if (nc && index.has(nc)) {
                const v = index.get(nc);
                if (v !== undefined && v !== null && v !== "") return v;
            }
        }

        if (opts.exact) return undefined;

        // pass 2 — substring match, longest key first (most specific)
        for (const c of list) {
            const nc = norm(c);
            if (nc.length < 4) continue;

            const hit = normKeys
                .filter((k) => k.includes(nc) || nc.includes(k))
                .sort((a, b) => b.length - a.length)
                .find((k) => {
                    const v = index.get(k);
                    return v !== undefined && v !== null && v !== "";
                });

            if (hit) return index.get(hit);
        }

        return undefined;
    }

    /** printable, HTML-escaped scalar ("" when unanswered) */
    function get(candidates, opts) {
        const v = raw(candidates, opts);
        if (v === undefined || v === null || v === "") return "";
        if (Array.isArray(v)) return escapeHtml(v.join(", "));
        if (typeof v === "boolean") return v ? "Yes" : "No";
        if (typeof v === "object") {
            const on = Object.keys(v).filter((k) => v[k]);
            return escapeHtml(on.join(", "));
        }
        return escapeHtml(v);
    }

    /** multi-line text, newlines preserved as <br> */
    function getMultiline(candidates) {
        return get(candidates).replace(/\r?\n/g, "<br>");
    }

    /** every selected option of a checkbox / multi-select group */
    function selected(candidates) {
        const v = raw(candidates);
        if (v === undefined || v === null || v === "") return [];
        if (Array.isArray(v)) return v.map(String);
        if (typeof v === "object") return Object.keys(v).filter((k) => v[k]);
        if (typeof v === "string") {
            return v.includes(",") ? v.split(",").map((s) => s.trim()) : [v.trim()];
        }
        return [String(v)];
    }

    /**
     * Is `option` ticked?
     * Handles three storage styles at once:
     *   1. group array   -> { "Yoga style": ["Hatha Yoga", ...] }
     *   2. per-option key-> { "Website use": "Yes" }
     *   3. prefixed key  -> { "Consent website use": true }
     */
    function isChecked(groupCandidates, option, extraKeys = []) {
        if (!norm(option)) return false;

        const chosen = selected(groupCandidates);
        if (chosen.some((c) => optionMatches(c, option))) return true;

        const groups = Array.isArray(groupCandidates) ? groupCandidates : [groupCandidates];
        const keys = [
            ...extraKeys,
            option,
            ...groups.map((g) => `${g} ${option}`)
        ];

        // exact only: a fuzzy key match here can pull in a neighbouring
        // field's answer (the same class of bug as "<field> initials")
        const v = raw(keys, { exact: true });
        if (v === undefined || v === null || v === "") return false;
        if (typeof v === "boolean") return v;
        if (Array.isArray(v)) return v.some((c) => optionMatches(c, option));
        if (typeof v === "string") return YES.test(v.trim()) || optionMatches(v, option);
        return Boolean(v);
    }

    /** tri-state for the master checklist: true / false / null (unanswered) */
    function tri(candidates) {
        const v = raw(candidates);
        if (v === undefined || v === null || v === "") return null;
        if (typeof v === "boolean") return v;
        if (typeof v === "string") {
            if (YES.test(v.trim())) return true;
            if (NO.test(v.trim())) return false;
            return null;
        }
        if (Array.isArray(v)) return v.length > 0;
        return Boolean(v);
    }

    /**
     * Signature cell: renders a signature-pad image when the value is a
     * base64 data URL, otherwise the typed name.
     */
    function signature(candidates) {
        const v = raw(candidates);
        if (v === undefined || v === null || v === "") return "";
        if (isDataImage(v)) {
            return `<img class="sig-img" src="${escapeHtml(String(v).trim())}" alt="">`;
        }
        return `<span class="sig-text">${escapeHtml(v)}</span>`;
    }

    /** get() with the fuzzy pass disabled */
    function getExact(candidates) {
        return get(candidates, { exact: true });
    }

    return { raw, get, getExact, getMultiline, selected, isChecked, tri, signature, data };
}

module.exports = { createResolver, escapeHtml, norm, isDataImage, optionMatches };