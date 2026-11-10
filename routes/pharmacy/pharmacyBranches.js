// routes/Pharmacy/pharmacyBranches.js
//
// The branches a pharmacy screen can work in — for the branch picker on POS, Receive, B2B,
// stock screens. Any logged-in user of the pharmacy may read it (branch names only).
//
// Mount in server.js:
//   const pharmacyBranches = require("./routes/Pharmacy/pharmacyBranches.js");
//   app.use("/api/pharmacy/branches", pharmacyBranches);
//
//   GET /get/branches  → { multi, is_admin, my_branch, branches, stock_branches, unassigned_batches }
//     multi     true when the pharmacy has two or more branches (then stock is kept per branch)
//     branches  every branch with active staff (+ for the admin: branches that still hold stock)

const express = require("express");
const router = express.Router();
const db = require("../../db");
const { authMiddleware } = require("../../middlewares/authMiddleware");
const { getActor, staffBranches, stockBranches, sendBranchError } = require("../../utils/pharmacyBranch");

router.get("/get/branches", authMiddleware, async (req, res) => {
  try {
    const actor = await getActor(req, db);
    const staffList = await staffBranches(db, actor.adminId);
    const stockList = actor.isAdmin ? await stockBranches(db, actor.adminId) : [];
    const seen = new Map();
    [...staffList, ...stockList].forEach((b) => seen.set(b.toLowerCase(), b));
    let unassigned = 0;
    if (actor.isAdmin && staffList.length >= 2) {
      const [[u]] = await db.query(
        `SELECT COUNT(*) AS n FROM pharmacy_medicine_batches
          WHERE admin_id = ? AND (branch IS NULL OR TRIM(branch) = '') AND quantity_available > 0`,
        [actor.adminId]
      );
      unassigned = Number(u.n) || 0;
    }
    return res.json({
      success: true,
      data: {
        multi: staffList.length >= 2,
        is_admin: actor.isAdmin,
        my_branch: actor.branch,
        branches: [...seen.values()].sort((a, b) => a.localeCompare(b)),
        staff_branches: staffList,
        unassigned_batches: unassigned,
      },
    });
  } catch (err) {
    if (sendBranchError(res, err)) return;
    console.error("Branches error:", err);
    return res.status(500).json({ success: false, message: "Could not load branches." });
  }
});

module.exports = router;