// utils/pharmacyBranch.js
//
// Which branch a pharmacy request works in. There is no branches table — a branch is the text in
// staff.branch, and a branch "exists" when an active staff member of this admin has it.
// Names compare without case or outer spaces ("Kukatpally" = " kukatpally ").
//
//   One branch (or none)   branch filtering is OFF: everyone sees and sells all stock, and new
//                          stock is stamped with that one branch (or left empty if there is none).
//   Two or more branches   staff always work in THEIR OWN branch (read from the database, never
//                          from the request). The admin has no branch:
//                            • screens that CHANGE stock (sell, receive, adjust) must name one
//                            • screens that only SHOW stock see every branch unless one is named
//
// Usage in a route:
//   const scope = await resolveScope(db, req, { wanted: req.query.branch, forWrite: true });
//   const f = batchFilter(scope, "b");      // → { sql: " AND …", params: [...] }
//   … WHERE b.admin_id = ? ${f.sql}  [adminId, ...f.params]
//   INSERT … branch = scope.branch

const db = require("../db");

class BranchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clean = (v) => (v === undefined || v === null ? "" : String(v).trim());
const branchKey = (v) => clean(v).toLowerCase();

const unique = (names) => {
  const seen = new Map();
  for (const n of names) {
    const name = clean(n);
    if (name && !seen.has(branchKey(name))) seen.set(branchKey(name), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
};

/** Who is calling. Staff branch always comes from the database (a token can be stale). */
async function getActor(req, q = db) {
  const u = req.user || {};
  const isAdmin = String(u.role || "").toLowerCase() === "admin" || u.userType === "admin";
  const adminId = isAdmin ? u.id : u.adminId;
  if (!adminId) throw new BranchError(401, "Please log in again.");
  if (isAdmin) {
    return { isAdmin: true, adminId, userId: u.id, type: "admin", name: clean(u.name) || "Admin", branch: null, key: null };
  }
  const [rows] = await q.query(`SELECT name, branch, status FROM staff WHERE id = ? AND admin_id = ? LIMIT 1`, [u.id, adminId]);
  const s = rows[0];
  if (!s || Number(s.status) !== 1) throw new BranchError(403, "Your staff account is not active.");
  const branch = clean(s.branch) || null;
  return { isAdmin: false, adminId, userId: u.id, type: "staff", name: clean(s.name) || "Staff", branch, key: branch ? branchKey(branch) : null };
}

/** Branches with at least one active staff member. */
async function staffBranches(q, adminId) {
  const [rows] = await q.query(
    `SELECT TRIM(branch) AS branch FROM staff
      WHERE admin_id = ? AND status = 1 AND branch IS NOT NULL AND TRIM(branch) <> ''`,
    [adminId]
  );
  return unique(rows.map((r) => r.branch));
}

/** Branches that hold stock right now (staff may have left a branch that still has stock). */
async function stockBranches(q, adminId) {
  const [rows] = await q.query(
    // NOT "AND quantity_available > 0": a branch whose stock has run out would drop off
    // the admin's branch list, and then resolveScope would reject the branch they had
    // already picked with `"X" is not one of your branches.` — a hard 400 on the Sales
    // screen for the ordinary case of a branch selling out.
    `SELECT DISTINCT TRIM(branch) AS branch FROM pharmacy_medicine_batches
      WHERE admin_id = ? AND branch IS NOT NULL AND TRIM(branch) <> ''`,
    [adminId]
  );
  return unique(rows.map((r) => r.branch));
}

const findBranch = (list, name) => list.find((b) => branchKey(b) === branchKey(name)) || null;

/**
 * The branch this request works in.
 *   opts.wanted    the branch the ADMIN picked (ignored for staff)
 *   opts.forWrite  true when the request changes stock → the admin must pick one (multi-branch)
 * Returns { actor, multi, branches, branch, key, filter }
 *   branch  canonical name to stamp on new rows (null when there are no branches at all)
 *   filter  true → restrict stock reads/writes to `branch`
 */
async function resolveScope(q, req, opts = {}) {
  const actor = await getActor(req, q);
  const staffList = await staffBranches(q, actor.adminId);
  const multi = staffList.length >= 2;

  if (!multi) {
    const only = staffList[0] || null;
    return { actor, multi, branches: staffList, branch: actor.branch || only, key: branchKey(actor.branch || only) || null, filter: false };
  }

  if (!actor.isAdmin) {
    if (!actor.key) throw new BranchError(403, "Your profile has no branch. Ask your admin to set your branch.");
    const name = findBranch(staffList, actor.branch) || actor.branch;
    return { actor, multi, branches: staffList, branch: name, key: branchKey(name), filter: true };
  }

  const all = unique([...staffList, ...(await stockBranches(q, actor.adminId))]);
  const wanted = clean(opts.wanted);
  if (!wanted || wanted.toLowerCase() === "all") {
    if (opts.forWrite) throw new BranchError(400, "Choose the branch first.");
    return { actor, multi, branches: all, branch: null, key: null, filter: false };
  }
  const name = findBranch(all, wanted);
  if (!name) throw new BranchError(400, `"${wanted}" is not one of your branches.`);
  return { actor, multi, branches: all, branch: name, key: branchKey(name), filter: true };
}

/** SQL to keep only this scope's batches: " AND b.branch … = ?" (empty when not filtering). */
function batchFilter(scope, alias = "b") {
  if (!scope || !scope.filter) return { sql: "", params: [] };
  return { sql: ` AND ${alias}.branch IS NOT NULL AND LOWER(TRIM(${alias}.branch)) = ?`, params: [scope.key] };
}

/**
 * Same, but for a HISTORICAL RECORD (a sale, a return, a dispensing) rather than live stock.
 *
 * STRICT since 26 Oct 2026 — the tolerant version is deliberately reversed.
 *
 * From 24 Oct until now this matched `= ? OR branch IS NULL OR branch = ''`, so an
 * unattributed record showed under EVERY branch. That was right at the time: nothing was
 * stamping branch, every historical sale was NULL, and a strict test made the books look
 * empty the moment a branch was picked.
 *
 * It is wrong now, because the requirement is that a staff member sees ONLY their own
 * branch — and tolerance meant every staff member also saw every unassigned row from
 * every other branch. It became safe to make strict once two things were true:
 *   1. nothing creates NULLs any more — POST /sales/post now requires a branch
 *      (forWrite) and returns are now stamped, which they never were;
 *   2. sql/2026-10-26_branch_strict_backfill.sql has stamped the historical rows, and
 *      reports, per tenant, any it could not attribute.
 * A row that is still NULL after the backfill (an admin-made sale in a multi-branch
 * pharmacy, before admins had to pick a branch) is visible only under "All branches",
 * which is the admin's default on every read screen.
 *
 * Strict here also brings this into line with routes/Pharmacy/pharmacyProcurementReports.js,
 * which was always strict: until now the same NULL-branch sale was counted in the Sales
 * reports and dropped from the Procurement reports.
 *
 * Still exactly one `?`, so every call site's parameter array is unchanged.
 */
function rowFilter(scope, alias = "s") {
  if (!scope || !scope.filter) return { sql: "", params: [] };
  const col = alias ? `${alias}.branch` : "branch";
  return {
    sql: ` AND ${col} IS NOT NULL AND LOWER(TRIM(${col})) = ?`,
    params: [scope.key],
  };
}

/**
 * The same predicate as a bare string, for report queries that build their branch filter
 * inline instead of calling rowFilter. One definition, so the two cannot drift — before
 * 26 Oct this predicate had been hand-copied into 15 places in pharmacySales.js and
 * pharmacySalesReports.js instead of calling this, which is exactly the drift it exists
 * to prevent. They all call it now.
 *   historyBranchSql("s")  → " AND s.branch IS NOT NULL AND LOWER(TRIM(s.branch)) = ?"
 *   historyBranchSql()     → the same on a bare `branch` column
 * STRICT, like rowFilter (see the note there). One `?`. No string literal, so it is safe
 * inside a single-quoted, double-quoted or template JS string alike.
 */
function historyBranchSql(alias = "") {
  const col = alias ? `${alias}.branch` : "branch";
  return ` AND ${col} IS NOT NULL AND LOWER(TRIM(${col})) = ?`;
}

/**
 * Scope for acting on an EXISTING record that carries its own branch — a sale, a parked
 * draft, a return, a dispensing. The RECORD's stored branch decides, never the request.
 * Added 26 Oct 2026.
 *
 * Before this, every route that took an id — open a bill, print it, edit it, cancel it,
 * complete a parked draft, process or open a return — checked admin_id and nothing else.
 * The LISTS were branch-scoped, so a staff member could not see another branch's bills,
 * but could open, print, edit or cancel any of them by typing its id or number. And the
 * ones that move stock (edit, cancel, draft-complete, return) did so with no branch test.
 *
 *   single-branch pharmacy  allowed; empty filter (there is only one branch)
 *   staff                   the record must be in THEIR branch, else 404 — not 403, so an
 *                           id from another branch is indistinguishable from no such id
 *   admin                   any branch
 *
 * Returns { scope, branch, key, bf }. `bf` is a STRICT live-stock filter pinned to the
 * RECORD's branch (same shape as batchFilter), for checking that the batches an action
 * touches really belong to that branch.
 *
 *   opts.alias     batch table alias for bf (default "b")
 *   opts.forStock  the action moves stock. In a multi-branch pharmacy a record with NO
 *                  branch is then refused with 409: there is no way to know whose stock it
 *                  is, and guessing is how one branch's shelf ends up paying for another's.
 *   opts.notFound  the 404 message
 *   opts.noBranch  the 409 message
 */
async function recordScope(q, req, recordBranch, opts = {}) {
  const scope = await resolveScope(q, req, {});
  const empty = { sql: "", params: [] };
  if (!scope.multi) return { scope, branch: scope.branch, key: scope.key, bf: empty };

  const recKey = branchKey(recordBranch) || null;
  if (!scope.actor.isAdmin && (!recKey || recKey !== scope.key)) {
    throw new BranchError(404, opts.notFound || "Not found in your branch.");
  }
  if (!recKey) {
    if (opts.forStock) {
      throw new BranchError(
        409,
        opts.noBranch || "This record has no branch, so its stock can't be identified. Assign it a branch first."
      );
    }
    return { scope, branch: null, key: null, bf: empty };
  }
  const alias = opts.alias || "b";
  return {
    scope,
    branch: clean(recordBranch),
    key: recKey,
    bf: { sql: ` AND ${alias}.branch IS NOT NULL AND LOWER(TRIM(${alias}.branch)) = ?`, params: [recKey] },
  };
}

/** Express error helper: turn BranchError into a JSON reply. Returns true when handled. */
function sendBranchError(res, err) {
  if (err instanceof BranchError) {
    res.status(err.status).json({ success: false, message: err.message });
    return true;
  }
  return false;
}

module.exports = {
  BranchError,
  branchKey,
  getActor,
  staffBranches,
  stockBranches,
  findBranch,
  resolveScope,
  batchFilter,
  rowFilter,
  historyBranchSql,
  recordScope,
  sendBranchError,
};