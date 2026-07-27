const express = require("express");
const router = express.Router();
const db = require("../../db");

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");
const { regenerateBill } = require("./ipdBillsRoutes");

const normalize = (value) => value?.toString().trim().toLowerCase();

// ======================================================
// ✅ CREATE LAB TEST (ONLY RECEPTIONIST)✅
// ======================================================
router.post(
  "/post/lab-tests/",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const { ipd_id, test_name, test_date, result_status, test_charge } =
        req.body;

      const { adminId, id: staff_id } = req.user;
      const admin_id = adminId;

      // ✅ Basic validation
      if (!ipd_id || !test_name || !test_date) {
        return res.status(400).json({
          message: "ipd_id, test_name, test_date required",
        });
      }

      // =====================================================
      // 🔒 STEP 1: GET STAFF BRANCH
      // =====================================================
      const [staffData] = await db.query(
        `SELECT branch, admin_id 
         FROM staff 
         WHERE id = ?`,
        [staff_id],
      );

      if (staffData.length === 0) {
        return res.status(404).json({
          message: "Staff not found",
        });
      }

      const staff_branch = staffData[0].branch;

      // Extra safety (admin check)
      if (staffData[0].admin_id !== admin_id) {
        return res.status(403).json({
          message: "Invalid staff admin mapping",
        });
      }

      // =====================================================
      // 🔒 STEP 2: GET IPD BRANCH
      // =====================================================
      const [ipdData] = await db.query(
        `SELECT id, admin_id, branch_name 
         FROM ipd_admissions 
         WHERE id = ?`,
        [ipd_id],
      );

      if (ipdData.length === 0) {
        return res.status(404).json({
          message: "Invalid IPD ID",
        });
      }

      const ipd_branch = ipdData[0].branch_name;

      // =====================================================
      // 🚫 STEP 3: VALIDATION (ADMIN + BRANCH)
      // =====================================================
      if (ipdData[0].admin_id !== admin_id) {
        return res.status(403).json({
          message: "Access denied: Different admin",
        });
      }

      if (normalize(staff_branch) !== normalize(ipd_branch)) {
        return res.status(403).json({
          message: "Access denied: Branch mismatch",
        });
      }

      // =====================================================
      // ✅ STEP 4: INSERT LAB TEST
      // =====================================================
      const [result] = await db.query(
        `INSERT INTO ipd_lab_tests 
        (admin_id, ipd_id, test_name, test_date, result_status, test_charge)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          admin_id,
          ipd_id,
          test_name,
          test_date,
          result_status || "pending",
          test_charge || 0,
        ],
      );

      await regenerateBill(ipd_id);

      res.status(201).json({
        message: "Lab test created successfully",
        id: result.insertId,
      });
    } catch (err) {
      console.error("Lab test create error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
);
// ======================================================
// ✅ GET ALL LAB TESTS BY IPD (ADMIN + RECEPTIONIST)✅
// ======================================================
router.get(
  "/get/lab-tests/ipd/:ipd_id",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { ipd_id } = req.params;
      const { role, id: userId, adminId } = req.user;

      const admin_id = role === "admin" ? userId : adminId;

      // =====================================================
      // 👨‍💼 ADMIN → DIRECT FETCH
      // =====================================================
      if (role === "admin") {
        const [data] = await db.query(
          `SELECT * FROM ipd_lab_tests 
           WHERE ipd_id = ? AND admin_id = ?
           ORDER BY test_date DESC`,
          [ipd_id, admin_id],
        );

        return res.json({
          message: "Lab tests fetched (admin)",
          data,
        });
      }

      // =====================================================
      // 🧑‍💻 RECEPTIONIST → BRANCH FILTER
      // =====================================================
      if (role === "receptionist") {
        const [staffData] = await db.query(
          `SELECT branch FROM staff WHERE id = ? AND admin_id = ?`,
          [userId, admin_id],
        );

        if (staffData.length === 0) {
          return res.status(404).json({ message: "Staff not found" });
        }

        const staff_branch = staffData[0].branch;

        const [data] = await db.query(
          `SELECT lt.*
           FROM ipd_lab_tests lt
           JOIN ipd_admissions ia ON lt.ipd_id = ia.id
           WHERE lt.ipd_id = ?
           AND lt.admin_id = ?
           AND ia.admin_id = ?
           AND LOWER(TRIM(ia.branch_name)) = LOWER(TRIM(?))
           ORDER BY lt.test_date DESC`,
          [ipd_id, admin_id, admin_id, staff_branch],
        );

        return res.json({
          message: "Lab tests fetched (branch filtered)",
          data,
        });
      }

      // =====================================================
      // 👤 CLIENT → ONLY OWN IPD
      // =====================================================

      const [ipd] = await db.query(
        `SELECT id, client_id 
         FROM ipd_admissions 
         WHERE id = ?`,
        [ipd_id],
      );

      if (ipd.length === 0) {
        return res.status(404).json({
          message: "Invalid IPD or access denied",
        });
      }

      if (ipd[0].client_id !== userId) {
        return res.status(403).json({
          message: "You can only access your own lab tests",
        });
      }

      const [data] = await db.query(
        `SELECT * 
         FROM ipd_lab_tests
         WHERE ipd_id = ?
         ORDER BY test_date DESC`,
        [ipd_id],
      );

      return res.json({
        message: "Lab tests fetched (client)",
        data,
      });
    } catch (err) {
      console.error("Fetch IPD lab tests error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

// ======================================================
// ✅ GET ALL LAB TEST (ADMIN + RECEPTIONIST) ✅
// ======================================================
router.get(
  "/getall/lab-tests/",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { role, id: userId, adminId } = req.user;

      const admin_id = role === "admin" ? userId : adminId;

      // =====================================================
      // 👨‍💼 ADMIN → GET ALL LAB TESTS
      // =====================================================
      if (role === "admin") {
        const [data] = await db.query(
          `SELECT * FROM ipd_lab_tests
           WHERE admin_id = ?
           ORDER BY test_date DESC`,
          [admin_id],
        );

        return res.json({
          message: "All lab tests fetched (admin)",
          data,
        });
      }

      // =====================================================
      // 👤 CLIENT → ONLY HIS OWN LAB TESTS
      // =====================================================
      if (role === "client") {
        const [data] = await db.query(
          `SELECT lt.*
           FROM ipd_lab_tests lt
           JOIN ipd_admissions ia ON lt.ipd_id = ia.id
           WHERE lt.admin_id = ?
           AND ia.client_id = ?
           ORDER BY lt.test_date DESC`,
          [admin_id, userId],
        );

        return res.json({
          message: "Lab tests fetched (client)",
          data,
        });
      }

      // =====================================================
      // 🧑‍💻 RECEPTIONIST → ONLY HIS BRANCH DATA
      // =====================================================

      const [staffData] = await db.query(
        `SELECT branch FROM staff WHERE id = ?`,
        [userId],
      );

      if (staffData.length === 0) {
        return res.status(404).json({ message: "Staff not found" });
      }

      const staff_branch = staffData[0].branch;

      const [data] = await db.query(
        `SELECT lt.*
         FROM ipd_lab_tests lt
         JOIN ipd_admissions ia ON lt.ipd_id = ia.id
         WHERE lt.admin_id = ?
         AND LOWER(TRIM(ia.branch_name)) = LOWER(TRIM(?))
         ORDER BY lt.test_date DESC`,
        [admin_id, staff_branch],
      );

      return res.json({
        message: "Lab tests fetched (branch filtered)",
        data,
      });
    } catch (err) {
      console.error("Fetch all lab tests error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

// ======================================================
// ✅ GET SINGLE LAB TEST (ADMIN + RECEPTIONIST)✅
// ======================================================
router.get(
  "/get/lab-test/:id",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { id: testId } = req.params;
      const { role, id: userId, adminId } = req.user;

      const admin_id = role === "admin" ? userId : adminId;

      // =====================================================
      // 🔒 STEP 1: GET LAB TEST
      // =====================================================
      const [labTest] = await db.query(
        `SELECT * FROM ipd_lab_tests 
         WHERE id = ? AND admin_id = ?`,
        [testId, admin_id],
      );

      if (labTest.length === 0) {
        return res.status(404).json({ message: "Lab test not found" });
      }

      const ipd_id = labTest[0].ipd_id;

      // =====================================================
      // 👤 CLIENT ACCESS CHECK (NO BRANCH)
      // =====================================================
      if (role === "client") {
        const [ipdData] = await db.query(
          `SELECT client_id FROM ipd_admissions WHERE id = ?`,
          [ipd_id],
        );

        if (ipdData.length === 0) {
          return res.status(404).json({ message: "IPD not found" });
        }

        if (ipdData[0].client_id !== userId) {
          return res.status(403).json({
            message: "Access denied: Not your lab test",
          });
        }
      }

      // =====================================================
      // 🔒 STEP 2: RECEPTIONIST → CHECK BRANCH (UNCHANGED)
      // =====================================================
      if (role === "receptionist") {
        const [staffData] = await db.query(
          `SELECT branch FROM staff WHERE id = ?`,
          [userId],
        );

        if (staffData.length === 0) {
          return res.status(404).json({ message: "Staff not found" });
        }

        const staff_branch = staffData[0].branch;

        const [ipdData] = await db.query(
          `SELECT branch_name FROM ipd_admissions WHERE id = ?`,
          [ipd_id],
        );

        if (ipdData.length === 0) {
          return res.status(404).json({ message: "IPD not found" });
        }

        const ipd_branch = ipdData[0].branch_name;

        if (normalize(staff_branch) !== normalize(ipd_branch)) {
          return res.status(403).json({
            message: "Access denied: Branch mismatch",
          });
        }
      }

      // =====================================================
      // 👨‍💼 ADMIN → NO EXTRA CHECK
      // =====================================================

      return res.json({
        message: "Lab test fetched successfully",
        data: labTest[0],
      });
    } catch (err) {
      console.error("Fetch lab test error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

// ======================================================
// ✅ UPDATE LAB TEST (ONLY RECEPTIONIST)✅
// ======================================================
router.put(
  "/update/lab-test/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const { id: testId } = req.params;
      const { test_name, test_date, result_status, test_charge } = req.body;

      const { adminId, id: staff_id } = req.user;
      const admin_id = adminId;

      // =====================================================
      // 🔒 STEP 1: GET EXISTING LAB TEST
      // =====================================================
      const [existing] = await db.query(
        `SELECT * FROM ipd_lab_tests 
         WHERE id = ? AND admin_id = ?`,
        [testId, admin_id],
      );

      if (existing.length === 0) {
        return res.status(404).json({ message: "Lab test not found" });
      }

      const ipd_id = existing[0].ipd_id;

      // =====================================================
      // 🔒 STEP 2: GET STAFF BRANCH
      // =====================================================
      const [staffData] = await db.query(
        `SELECT branch, admin_id 
         FROM staff 
         WHERE id = ?`,
        [staff_id],
      );

      if (staffData.length === 0) {
        return res.status(404).json({ message: "Staff not found" });
      }

      const staff_branch = staffData[0].branch;

      if (staffData[0].admin_id !== admin_id) {
        return res.status(403).json({
          message: "Invalid staff admin mapping",
        });
      }

      // =====================================================
      // 🔒 STEP 3: GET IPD BRANCH
      // =====================================================
      const [ipdData] = await db.query(
        `SELECT id, admin_id, branch_name 
         FROM ipd_admissions 
         WHERE id = ?`,
        [ipd_id],
      );

      if (ipdData.length === 0) {
        return res.status(404).json({ message: "IPD not found" });
      }

      const ipd_branch = ipdData[0].branch_name;

      // =====================================================
      // 🚫 STEP 4: VALIDATION
      // =====================================================
      if (ipdData[0].admin_id !== admin_id) {
        return res.status(403).json({
          message: "Access denied: Different admin",
        });
      }

      if (normalize(staff_branch) !== normalize(ipd_branch)) {
        return res.status(403).json({
          message: "Access denied: Branch mismatch",
        });
      }

      // =====================================================
      // ✅ STEP 5: UPDATE
      // =====================================================
      await db.query(
        `UPDATE ipd_lab_tests SET
          test_name = ?,
          test_date = ?,
          result_status = ?,
          test_charge = ?
         WHERE id = ? AND admin_id = ?`,
        [
          test_name || existing[0].test_name,
          test_date || existing[0].test_date,
          result_status || existing[0].result_status,
          test_charge ?? existing[0].test_charge,
          testId,
          admin_id,
        ],
      );

      await regenerateBill(ipd_id);

      res.json({ message: "Updated successfully" });
    } catch (err) {
      console.error("Update lab test error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

// ======================================================
// ✅ DELETE LAB TEST (ONLY RECEPTIONIST)✅
// ======================================================
router.delete(
  "/delete/lab-test/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const { id: testId } = req.params;
      const { adminId, id: id } = req.user;

      const admin_id = adminId;

      // =====================================================
      // 🔒 STEP 1: GET STAFF BRANCH
      // =====================================================
      const [staffData] = await db.query(
        `SELECT branch, admin_id FROM staff WHERE id = ?`,
        [id],
      );

      if (staffData.length === 0) {
        return res.status(404).json({ message: "Staff not found" });
      }

      const staff_branch = staffData[0].branch;

      if (staffData[0].admin_id !== admin_id) {
        return res.status(403).json({
          message: "Invalid staff admin mapping",
        });
      }

      // =====================================================
      // 🔒 STEP 2: CHECK LAB TEST + IPD BRANCH (JOIN ⚡)
      // =====================================================
      const [data] = await db.query(
        `SELECT lt.id
   FROM ipd_lab_tests lt
   JOIN ipd_admissions ia ON lt.ipd_id = ia.id
   WHERE lt.id = ?
   AND lt.admin_id = ?
   AND LOWER(TRIM(ia.branch_name)) = LOWER(TRIM(?))`,
        [testId, admin_id, staff_branch],
      );

      if (data.length === 0) {
        return res.status(404).json({
          message: "Not found or access denied",
        });
      }

      // =====================================================
      // ✅ STEP 3: DELETE
      // =====================================================
      await db.query(
        `DELETE FROM ipd_lab_tests 
         WHERE id = ? AND admin_id = ?`,
        [testId, admin_id],
      );

      res.json({ message: "Deleted successfully" });
    } catch (err) {
      console.error("Delete lab test error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

module.exports = router;