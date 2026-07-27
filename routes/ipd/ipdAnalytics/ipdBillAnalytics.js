// controllers/ipdAnalyticsController.js

const db = require("../../../db");

const buildDateFilter = require("../../../utils/analyticsDateFilter");

const getIPDRevenueAnalytics = async (req, res) => {
  try {
    const admin_id = req.user.role === "admin" ? req.user.id : req.user.adminId;

    const { branch_name, filter_type, start_date, end_date } = req.query;

    let branchFilter = "";
    let branchParams = [];

    // Receptionist → only own branch
    if (req.user.role === "receptionist") {
      branchFilter = `
        AND ia.branch_name = ?
      `;

      branchParams.push(req.user.branch_name);
    }

    // Admin → optional branch filter
    else if (
      req.user.role === "admin" &&
      branch_name &&
      branch_name !== "all"
    ) {
      branchFilter = `
        AND ia.branch_name = ?
      `;

      branchParams.push(branch_name);
    }

    // Date Filters
    const doctorVisitDateFilter = buildDateFilter(
      filter_type,
      "dv.created_at",
      start_date,
      end_date,
    );

    const labDateFilter = buildDateFilter(
      filter_type,
      "lt.created_at",
      start_date,
      end_date,
    );

    const procedureDateFilter = buildDateFilter(
      filter_type,
      "pr.created_at",
      start_date,
      end_date,
    );

    const nursingDateFilter = buildDateFilter(
      filter_type,
      "nc.created_at",
      start_date,
      end_date,
    );

    const miscDateFilter = buildDateFilter(
      filter_type,
      "mc.created_at",
      start_date,
      end_date,
    );

    const bedDateFilter = buildDateFilter(
      filter_type,
      "bc.created_at",
      start_date,
      end_date,
    );

    const pharmacyDateFilter = buildDateFilter(
      filter_type,
      "ph.created_at",
      start_date,
      end_date,
    );

    const paymentDateFilter = buildDateFilter(
      filter_type,
      "py.created_at",
      start_date,
      end_date,
    );

    // const billDateFilter = buildDateFilter(
    //   filter_type,
    //   "bl.created_at",
    //   start_date,
    //   end_date,
    // );

    const billDateFilter = buildDateFilter(
      filter_type,
      "bl.created_at",
      start_date,
      end_date,
    );

    const query = `
SELECT

(
  SELECT IFNULL(SUM(dv.visit_charge), 0)
  FROM ipd_doctor_visits dv
  JOIN ipd_admissions ia ON ia.id = dv.ipd_id
  WHERE dv.admin_id = ?
  ${branchFilter}
  ${doctorVisitDateFilter}
) AS doctor_visits_total,

(
  SELECT IFNULL(SUM(lt.test_charge), 0)
  FROM ipd_lab_tests lt
  JOIN ipd_admissions ia ON ia.id = lt.ipd_id
  WHERE lt.admin_id = ?
  ${branchFilter}
  ${labDateFilter}
) AS lab_tests_total,

(
  SELECT IFNULL(SUM(pr.procedure_charge), 0)
  FROM ipd_procedures pr
  JOIN ipd_admissions ia ON ia.id = pr.ipd_id
  WHERE pr.admin_id = ?
  ${branchFilter}
  ${procedureDateFilter}
) AS procedures_total,

(
  SELECT IFNULL(SUM(nc.charge_amount), 0)
  FROM ipd_nursing_charges nc
  JOIN ipd_admissions ia ON ia.id = nc.ipd_id
  WHERE nc.admin_id = ?
  ${branchFilter}
  ${nursingDateFilter}
) AS nursing_total,

(
  SELECT IFNULL(SUM(mc.charge_amount), 0)
  FROM ipd_miscellaneous_charges mc
  JOIN ipd_admissions ia ON ia.id = mc.ipd_id
  WHERE mc.admin_id = ?
  ${branchFilter}
  ${miscDateFilter}
) AS miscellaneous_total,

(
  SELECT IFNULL(SUM(bc.charge_amount), 0)
  FROM ipd_bed_charges bc
  JOIN ipd_admissions ia ON ia.id = bc.ipd_id
  WHERE bc.admin_id = ?
  ${branchFilter}
  ${bedDateFilter}
) AS bed_charges_total,

(
  SELECT IFNULL(SUM(ph.total_price), 0)
  FROM ipd_pharmacy_issues ph
  JOIN ipd_admissions ia ON ia.id = ph.ipd_id
  WHERE ph.admin_id = ?
  ${branchFilter}
  ${pharmacyDateFilter}
) AS pharmacy_total,

(
  SELECT IFNULL(SUM(py.amount), 0)
  FROM ipd_payments py
  JOIN ipd_admissions ia ON ia.id = py.ipd_id
  WHERE py.admin_id = ?
  ${branchFilter}
  ${paymentDateFilter}
) AS payments_total,

(
  SELECT IFNULL(SUM(bl.total_amount), 0)
  FROM ipd_bills bl
  JOIN ipd_admissions ia ON ia.id = bl.ipd_id
  WHERE bl.admin_id = ?
  ${branchFilter}
  ${billDateFilter}
) AS total_bill_amount,

(
  SELECT IFNULL(SUM(bl.paid_amount), 0)
  FROM ipd_bills bl
  JOIN ipd_admissions ia ON ia.id = bl.ipd_id
  WHERE bl.admin_id = ?
  ${branchFilter}
  ${billDateFilter}
) AS total_paid_amount,

(
  SELECT IFNULL(SUM(bl.balance_amount), 0)
  FROM ipd_bills bl
  JOIN ipd_admissions ia ON ia.id = bl.ipd_id
  WHERE bl.admin_id = ?
  ${branchFilter}
  ${billDateFilter}
) AS total_pending_amount,

(
  SELECT COUNT(*)
  FROM ipd_bills bl
  JOIN ipd_admissions ia ON ia.id = bl.ipd_id
  WHERE bl.admin_id = ?
  AND bl.bill_status = 'pending'
  ${branchFilter}
  ${billDateFilter}
) AS pending_bills_count,

(
  SELECT COUNT(*)
  FROM ipd_bills bl
  JOIN ipd_admissions ia ON ia.id = bl.ipd_id
  WHERE bl.admin_id = ?
  AND bl.bill_status = 'partial'
  ${branchFilter}
  ${billDateFilter}
) AS partial_bills_count,

(
  SELECT COUNT(*)
  FROM ipd_bills bl
  JOIN ipd_admissions ia ON ia.id = bl.ipd_id
  WHERE bl.admin_id = ?
  AND bl.bill_status = 'paid'
  ${branchFilter}
  ${billDateFilter}
) AS paid_bills_count

`;

    const queryParams = [
      admin_id,
      ...branchParams,

      admin_id,
      ...branchParams,

      admin_id,
      ...branchParams,

      admin_id,
      ...branchParams,

      admin_id,
      ...branchParams,

      admin_id,
      ...branchParams,

      admin_id,
      ...branchParams,

      admin_id,
      ...branchParams,

      // total_bill_amount
      admin_id,
      ...branchParams,

      // total_paid_amount
      admin_id,
      ...branchParams,

      // total_pending_amount
      admin_id,
      ...branchParams,

      // pending_bills_count
      admin_id,
      ...branchParams,

      // partial_bills_count
      admin_id,
      ...branchParams,

      // paid_bills_count
      admin_id,
      ...branchParams,
    ];

    const [rows] = await db.query(query, queryParams);

    const analytics = rows[0];

    const grand_total =
      Number(analytics.doctor_visits_total) +
      Number(analytics.lab_tests_total) +
      Number(analytics.procedures_total) +
      Number(analytics.nursing_total) +
      Number(analytics.miscellaneous_total) +
      Number(analytics.bed_charges_total) +
      Number(analytics.pharmacy_total) +
      Number(analytics.total_bill_amount);

    return res.status(200).json({
      success: true,

      filters: {
        branch_name:
          req.user.role === "receptionist"
            ? req.user.branch_name
            : branch_name || "all",

        filter_type,
        start_date,
        end_date,
      },

      analytics: {
        ...analytics,
        grand_total,
      },
    });
  } catch (error) {
    console.log("IPD Revenue Analytics Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

const getDoctorWiseRevenueAnalytics = async (req, res) => {
  try {
    const admin_id = req.user.role === "admin" ? req.user.id : req.user.adminId;

    const { branch_name, filter_type, start_date, end_date } = req.query;
    const condition = buildDateFilter(
      filter_type,
      "dv.created_at",
      start_date,
      end_date,
    );

    let branchFilter = "";
    let branchParams = [];

    if (req.user.role === "receptionist") {
      branchFilter = ` AND ia.branch_name = ? `;
      branchParams.push(req.user.branch_name);
    } else if (branch_name && branch_name !== "all") {
      branchFilter = ` AND ia.branch_name = ? `;
      branchParams.push(branch_name);
    }

    const query = `
SELECT
    s.id AS doctor_id,
    s.name AS doctor_name,

    COUNT(DISTINCT dv.ipd_id) AS total_patients,
    COUNT(dv.id) AS total_visits,
    COALESCE(SUM(dv.visit_charge),0) AS revenue

FROM staff s

LEFT JOIN ipd_doctor_visits dv
    ON dv.doctor_id = s.id
    AND dv.admin_id = ?

INNER JOIN ipd_admissions ia
    ON ia.id = dv.ipd_id
    AND ia.admin_id = ?

WHERE s.role = 'doctor'
AND s.admin_id = ?

${branchFilter}
${condition}

GROUP BY s.id,s.name

ORDER BY revenue DESC
`;

    const params = [
      admin_id, // dv.admin_id
      admin_id, // ia.admin_id
      admin_id, // s.admin_id
      ...branchParams,
    ];

  
    const [rows] = await db.query(query, params);



    const formattedData = rows.map((item, index) => ({
      id: index + 1,
      doctor_id: item.doctor_id,
      doctor_name: item.doctor_name,
      total_patients: Number(item.total_patients),
      total_visits: Number(item.total_visits),
      revenue: Number(item.revenue),
    }));

    return res.status(200).json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    console.error("Doctor Revenue Analytics Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch doctor revenue analytics",
      error: error.message,
    });
  }
};
module.exports = {
  getIPDRevenueAnalytics,

  getDoctorWiseRevenueAnalytics,
};
