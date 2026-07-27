// controllers/ipdBedAnalyticsController.js

const db = require("../../../db");

const buildDateFilter = require("../../../utils/analyticsDateFilter");

// ======================================================
// 1.CURRENT MONTH BED OVERVIEW ANALYTICS JUST TOTAL, OCCUPIED AND AVAILABLE BEDS ✅✅✅
// ======================================================

const getBedOverviewAnalytics = async (req, res) => {
  try {
    // ======================================================
    // ADMIN ID
    // ======================================================

    const admin_id = req.user.role === "admin" ? req.user.id : req.user.adminId;

    const { branch_name } = req.query;

    // ======================================================
    // BRANCH FILTER
    // ======================================================

    let branchFilter = "";
    let branchParams = [];

    if (req.user.role === "receptionist") {
      branchFilter = `
        AND ia.branch_name = ?
      `;

      branchParams.push(req.user.branch_name);
    } else if (
      req.user.role === "admin" &&
      branch_name &&
      branch_name !== "all"
    ) {
      branchFilter = `
        AND ia.branch_name = ?
      `;

      branchParams.push(branch_name);
    }

    // ======================================================
    // QUERY
    // ======================================================

    const query = `

SELECT

-- TOTAL BEDS

COUNT(
  DISTINCT ba.bed_id
) AS total_beds,

-- OCCUPIED BEDS

COUNT(
  DISTINCT CASE
    WHEN ba.allocation_status = 'active'
    THEN ba.bed_id
  END
) AS occupied_beds

FROM ipd_bed_allocations ba

LEFT JOIN ipd_admissions ia
ON ia.id = ba.ipd_id

WHERE ba.admin_id = ?
AND ba.created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
AND ba.created_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')

${branchFilter}

`;

    // ======================================================
    // QUERY PARAMS
    // ======================================================

    const queryParams = [admin_id, ...branchParams];

    const [rows] = await db.query(query, queryParams);

    const analytics = rows[0];
    const total_beds = Number(analytics.total_beds);
    const occupied_beds = Number(analytics.occupied_beds);

    const available_beds = total_beds - occupied_beds;
    // ======================================================
    // OCCUPANCY RATE
    // ======================================================

    const occupancy_rate =
      total_beds > 0 ? ((occupied_beds / total_beds) * 100).toFixed(2) : 0;
    // ======================================================
    // RESPONSE
    // ======================================================

    return res.status(200).json({
      success: true,

      filters: {
        branch_name:
          req.user.role === "receptionist"
            ? req.user.branch_name
            : branch_name || "all",
      },

      analytics: {
        total_beds,
        occupied_beds,
        available_beds,
        occupancy_rate,
      },
    });
  } catch (error) {
    console.log("Bed Overview Analytics Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ======================================================
// 2. BED OCCUPANCY GRAPH
// ======================================================

const getBedOccupancyGraph = async (req, res) => {
  try {
    const admin_id = req.user.role === "admin" ? req.user.id : req.user.adminId;

    const {
      branch_name,
      filter_type = "currentmonth",
      start_date,
      end_date,
    } = req.query;

    // ======================================================
    // BRANCH FILTER
    // ======================================================

    let branchFilter = "";
    let branchParams = [];

    if (req.user.role === "receptionist") {
      branchFilter = `
        AND ia.branch_name = ?
      `;
      branchParams.push(req.user.branch_name);
    } else if (branch_name && branch_name !== "all") {
      branchFilter = `
        AND ia.branch_name = ?
      `;
      branchParams.push(branch_name);
    }

    // ======================================================
    // DATE FILTER
    // ======================================================

    let dateCondition = "";
    let dateParams = [];

    switch (filter_type) {
      case "7days":
        dateCondition = `
          AND DATE(ba.created_at)
          BETWEEN DATE_SUB(CURDATE(), INTERVAL 6 DAY)
          AND CURDATE()
        `;
        break;

      case "currentmonth":
        dateCondition = `
          AND MONTH(ba.created_at)=MONTH(CURDATE())
          AND YEAR(ba.created_at)=YEAR(CURDATE())
        `;
        break;

      case "1month":
        dateCondition = `
          AND ba.created_at >= DATE_FORMAT(
            DATE_SUB(CURDATE(), INTERVAL 1 MONTH),
            '%Y-%m-01'
          )
          AND ba.created_at <
            DATE_FORMAT(
              CURDATE(),
              '%Y-%m-01'
            )
        `;
        break;

      case "3months":
        dateCondition = `
          AND ba.created_at >=
          DATE_SUB(CURDATE(), INTERVAL 3 MONTH)
        `;
        break;

      case "6months":
        dateCondition = `
          AND ba.created_at >=
          DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
        `;
        break;

      case "1year":
        dateCondition = `
          AND ba.created_at >=
          DATE_SUB(CURDATE(), INTERVAL 1 YEAR)
        `;
        break;

      case "custom":
        dateCondition = `
          AND DATE(ba.created_at)
          BETWEEN ? AND ?
        `;
        dateParams = [start_date, end_date];
        break;
    }

    // ======================================================
    // GROUPING
    // ======================================================

    let selectLabel = "";
    let groupBy = "";
    let orderBy = "";

    if (["currentmonth", "7days", "1month"].includes(filter_type)) {
      selectLabel = `
  DATE(ba.created_at) AS label
`;

      groupBy = `
  GROUP BY DATE(ba.created_at)
`;

      orderBy = `
  ORDER BY DATE(ba.created_at)
`;
    } else if (["3months", "6months"].includes(filter_type)) {
      selectLabel = `
    DATE_FORMAT(ba.created_at,'%Y-%m') AS label
  `;

      groupBy = `
    GROUP BY DATE_FORMAT(ba.created_at,'%Y-%m')
  `;

      orderBy = `
    ORDER BY label
  `;
    } else {
      selectLabel = `
  DATE_FORMAT(ba.created_at,'%Y-%m') AS label
`;
      groupBy = `
       GROUP BY DATE_FORMAT(ba.created_at,'%Y-%m')
      `;

      orderBy = `
        ORDER BY label
      `;
    }

    // ======================================================
    // QUERY
    // ======================================================

    const query = `
    SELECT

${selectLabel},

COUNT(
 DISTINCT CASE
   WHEN ba.allocation_status='active'
   THEN ba.bed_id
 END
) AS occupied_beds

FROM ipd_bed_allocations ba

LEFT JOIN ipd_admissions ia
ON ia.id = ba.ipd_id

WHERE ba.admin_id = ?

${branchFilter}
${dateCondition}

${groupBy}
${orderBy}
    `;

    const params = [admin_id, ...branchParams, ...dateParams];

    const [rows] = await db.query(query, params);

    const graph_data = rows.map((item) => ({
      label: item.label,
      occupied_beds: Number(item.occupied_beds) || 0,
    }));

    return res.status(200).json({
      success: true,
      graph_data,
    });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

// ======================================================
// 3. WARD WISE BED OCCUPANCY ANALYTICS ✅✅✅
// ======================================================

const getWardWiseAnalytics = async (req, res) => {
  try {
    const admin_id = req.user.role === "admin" ? req.user.id : req.user.adminId;

    const { branch_name, filter_type, start_date, end_date } = req.query;

    let branchFilter = "";
    let branchParams = [];

    // Receptionist => only own branch
    if (req.user.role === "receptionist") {
      branchFilter = `AND ia.branch_name = ?`;
      branchParams.push(req.user.branch_name);
    }

    // Admin selected specific branch
    else if (
      req.user.role === "admin" &&
      branch_name &&
      branch_name !== "all"
    ) {
      branchFilter = `AND ia.branch_name = ?`;
      branchParams.push(branch_name);
    }

    const allocationDateFilter = buildDateFilter(
      filter_type,
      "ba.created_at",
      start_date,
      end_date,
    );

    const query = `
   SELECT
    wt.ward_type_name AS ward_type,

    COUNT(
      DISTINCT CASE
        WHEN ba.allocation_status = 'active'
        THEN ba.bed_id
      END
    ) AS occupied_beds

FROM ipd_ward_type wt

LEFT JOIN ipd_rooms r
    ON r.ward_type_id = wt.id

LEFT JOIN ipd_beds b
    ON b.room_id = r.id

LEFT JOIN ipd_bed_allocations ba
    ON ba.bed_id = b.id

LEFT JOIN ipd_admissions ia
    ON ia.id = ba.ipd_id

WHERE wt.admin_id = ?
${branchFilter}
${allocationDateFilter}

GROUP BY wt.ward_type_name

ORDER BY occupied_beds DESC
`;

    const dateParams = filter_type === "custom" ? [start_date, end_date] : [];

    const queryParams = [admin_id, ...branchParams, ...dateParams];

    const [rows] = await db.query(query, queryParams);

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

      analytics: rows,
    });
  } catch (error) {
    console.error("Ward Wise Analytics Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ======================================================
// 4. BED STATUS DISTRIBUTION
// ======================================================

const getBedStatusDistribution = async (req, res) => {
  try {
    // ======================================================
    // ADMIN ID
    // ======================================================

    const admin_id = req.user.role === "admin" ? req.user.id : req.user.adminId;

    // ======================================================
    // QUERY PARAMS
    // ======================================================

    const {
      branch_name,
      filter_type = "currentmonth",
      start_date,
      end_date,
    } = req.query;

    // ======================================================
    // BRANCH FILTER
    // ======================================================

    let branchFilter = "";
    let branchParams = [];

    if (req.user.role === "receptionist") {
      branchFilter = `
          AND ia.branch_name = ?
        `;

      branchParams.push(req.user.branch_name);
    } else if (
      req.user.role === "admin" &&
      branch_name &&
      branch_name !== "all"
    ) {
      branchFilter = `
          AND ia.branch_name = ?
        `;

      branchParams.push(branch_name);
    }

    // ======================================================
    // DATE FILTER
    // ======================================================

    const allocationDateFilter = buildDateFilter(
      filter_type,
      "ba.created_at",
      start_date,
      end_date,
    );

    // ======================================================
    // QUERY
    // ======================================================

    const query = `

SELECT

CASE
  WHEN ba.allocation_status = 'active'
  THEN 'occupied'

  WHEN ba.allocation_status = 'completed'
  THEN 'available'
END AS label,

COUNT(
  DISTINCT ba.bed_id
) AS total,

ROUND(

(
  COUNT(
    DISTINCT ba.bed_id
  ) * 100.0
)

/

NULLIF(

(
  SELECT COUNT(
    DISTINCT ba2.bed_id
  )

  FROM ipd_bed_allocations ba2

  LEFT JOIN ipd_admissions ia2
  ON ia2.id = ba2.ipd_id

  WHERE ba2.admin_id = ?

  ${branchFilter.replaceAll("ia.", "ia2.")}

  ${allocationDateFilter.replaceAll("ba.", "ba2.")}

),

0

),

2

) AS percentage

FROM ipd_bed_allocations ba

LEFT JOIN ipd_admissions ia
ON ia.id = ba.ipd_id

WHERE ba.admin_id = ?

${branchFilter}
${allocationDateFilter}

GROUP BY ba.allocation_status

`;

    // ======================================================
    // PARAMS
    // ======================================================

    const queryParams = [
      // SUBQUERY

      admin_id,
      ...branchParams,

      ...(filter_type === "custom" ? [start_date, end_date] : []),

      // MAIN QUERY

      admin_id,
      ...branchParams,

      ...(filter_type === "custom" ? [start_date, end_date] : []),
    ];

    // ======================================================
    // DB QUERY
    // ======================================================

    const [rows] = await db.query(query, queryParams);

    // ======================================================
    // FORMAT RESPONSE
    // ======================================================

    const chart_data = rows.map((item) => ({
      label: item.label,

      total: Number(item.total),

      percentage: Number(item.percentage),
    }));

    // ======================================================
    // RESPONSE
    // ======================================================

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

      chart_data,
    });
  } catch (error) {
    console.log("Bed Status Distribution Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ======================================================
// 5. WARD WISE REVENU
// ======================================================

const getWardWiseRevenueAnalytics = async (req, res) => {
  try {
    const admin_id = req.user.role === "admin" ? req.user.id : req.user.adminId;

    const { branch_name, filter_type, start_date, end_date } = req.query;

    let branchFilter = "";
    let queryParams = [admin_id];

    if (req.user.role === "receptionist") {
      branchFilter = ` AND ia.branch_name = ? `;
      queryParams.push(req.user.branch_name);
    } else if (branch_name && branch_name !== "all") {
      branchFilter = ` AND ia.branch_name = ? `;
      queryParams.push(branch_name);
    }

    const dateFilter = buildDateFilter(
      filter_type,
      "bc.created_at",
      start_date,
      end_date,
    );

    const sql = `
  SELECT
    wt.ward_type_name,
    COUNT(DISTINCT bc.ipd_id) AS total_patients,
    COALESCE(SUM(bc.charge_amount),0) AS revenue

  FROM ipd_bed_charges bc

  INNER JOIN ipd_admissions ia
    ON bc.ipd_id = ia.id

  INNER JOIN ipd_bed_allocations ba
    ON bc.bed_allocation_id = ba.id

  INNER JOIN ipd_beds b
    ON ba.bed_id = b.id

  INNER JOIN ipd_rooms r
    ON b.room_id = r.id

  INNER JOIN ipd_ward_type wt
    ON r.ward_type_id = wt.id

  WHERE ia.admin_id = ?
  ${branchFilter}
  ${dateFilter}

  GROUP BY wt.ward_type_name

  ORDER BY revenue DESC
`;

    const [rows] = await db.query(sql, queryParams);

    const formattedRows = rows.map((row, index) => ({
      id: index + 1,
      ...row,
      revenue: Number(row.revenue),
    }));

    return res.status(200).json({
      success: true,
      data: formattedRows,
    });
  } catch (error) {
    console.error("Ward Revenue Analytics Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  getBedOverviewAnalytics,

  getBedOccupancyGraph,

  getWardWiseAnalytics,

  getBedStatusDistribution,

  getWardWiseRevenueAnalytics,
};
