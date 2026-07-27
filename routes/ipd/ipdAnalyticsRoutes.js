// routes/ipdAnalyticsRoutes.js

const express = require("express");

const router = express.Router();

const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");

const attachBranch = require("../../middlewares/attachBranch");

// 1. Bill Analytic

const { getIPDRevenueAnalytics, getDoctorWiseRevenueAnalytics } = require("./ipdAnalytics/ipdBillAnalytics");

// 2. Admissions Analytic

const {
  getIPDAdmissionsGraph,
} = require("./ipdAnalytics/ipdAdmissionsAnalyticsController");

// 3. Bed Analytic

const {
  getBedOverviewAnalytics,

  getBedOccupancyGraph,

  getWardWiseAnalytics,

  getBedStatusDistribution,

  getWardWiseRevenueAnalytics,
} = require("./ipdAnalytics/ipdBedAnalytics");


// ===================== 1. Bill Analytic =====================


// 1. OVERVIEW =====================


router.get(
  "/revenue",
  authMiddleware,
  attachBranch,
  allowRoles("admin", "receptionist"),
  getIPDRevenueAnalytics,
);



// 2. DOCTOR WISE REVENU =====================


router.get(
  "/doctor-wise/revenue",
  authMiddleware,
  attachBranch,
  allowRoles("admin", "receptionist"),
  getDoctorWiseRevenueAnalytics,
);



// ===================== 2. Admissions Analytic =====================

router.get(
  "/admissions-graph",
  authMiddleware,
  attachBranch,
  allowRoles("admin", "receptionist"),
  getIPDAdmissionsGraph,
);

// ===================== 3. Bed Analytic =====================

// 1. OVERVIEW =====================

// branch filter is not working for
//  "total_beds": 4,
// "occupied_beds": 3,
// "available_beds": 1,
// "active_allocations": 5,
// "completed_allocations": 0,

router.get(
  "/overview",
  authMiddleware,
  attachBranch,
  allowRoles("admin", "receptionist"),
  getBedOverviewAnalytics,
);

// 2. OCCUPANCY GRAPH =====================

// filters are not working  not woring and also display branch in result

// here i want date wise graph and including filters

router.get(
  "/bed-occupancy-graph",
  authMiddleware,
  attachBranch,
  allowRoles("admin", "receptionist"),
  getBedOccupancyGraph,
);

// 3. WARD-WISE =====================

// date filter not woring and also display branch in result

// wards which is there in beds table to releted ward only displaying that wards

router.get(
  "/ward-wise",
  authMiddleware,
  attachBranch,
  allowRoles("admin", "receptionist"),
  getWardWiseAnalytics,
);

// 8. STATUS DISTRIBUTION ===================== ✅ ✅ ✅
router.get(
  "/status-distribution",
  authMiddleware,
  attachBranch,
  allowRoles("admin", "receptionist"),
  getBedStatusDistribution,
);


router.get(
  "/ward-revenue",
  authMiddleware,
  attachBranch,
  allowRoles("admin", "receptionist"),
  getWardWiseRevenueAnalytics,
);

module.exports = router;
