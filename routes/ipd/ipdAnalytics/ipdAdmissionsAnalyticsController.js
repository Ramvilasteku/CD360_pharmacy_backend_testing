const db = require("../../../db");

const getIPDAdmissionsGraph = async (req, res) => {
  try {
    const admin_id = req.user.role === "admin" ? req.user.id : req.user.adminId;

    const {
      branch_name,
      filter_type = "currentmonth",
      start_date,
      end_date,
    } = req.query;
    let branchFilter = "";
    let queryParams = [admin_id];

    // Receptionist branch restriction
    if (req.user.role === "receptionist") {
      branchFilter = `
        AND branch_name = ?
      `;

      queryParams.push(req.user.branch_name);
    }

    // Admin branch filter
    else if (
      req.user.role === "admin" &&
      branch_name &&
      branch_name !== "all"
    ) {
      branchFilter = `
        AND branch_name = ?
      `;

      queryParams.push(branch_name);
    }

    let dateFilter = "";
    let groupBy = "";
    let selectLabel = "";
    let orderBy = "";

    // ---------------- Current Month ----------------

    if (filter_type === "currentmonth") {
      dateFilter = `
    AND MONTH(created_at) = MONTH(CURDATE())
    AND YEAR(created_at) = YEAR(CURDATE())
  `;

      selectLabel = `
    DATE(created_at) AS label
  `;

      groupBy = `
    GROUP BY DATE(created_at)
  `;
    }

    // ---------------- 7 DAYS ----------------
    else if (filter_type === "7days") {
      dateFilter = `
        AND created_at >= CURDATE() - INTERVAL 7 DAY
      `;

      selectLabel = `
        DATE(created_at) AS label
      `;

      groupBy = `
        GROUP BY DATE(created_at)
      `;
    }

    // ---------------- 1 MONTH ----------------
    else if (filter_type === "1month") {
      dateFilter = `
        AND created_at >= CURDATE() - INTERVAL 1 MONTH
      `;

      selectLabel = `
        DATE(created_at) AS label
      `;

      groupBy = `
        GROUP BY DATE(created_at)
      `;
    }
    // ---------------- 3 MONTHS ----------------
    else if (filter_type === "3months") {
      dateFilter = `
    AND created_at >= CURDATE() - INTERVAL 3 MONTH
  `;

      selectLabel = `
    DATE_FORMAT(created_at, '%Y-%m') AS label
  `;

      groupBy = `
    GROUP BY DATE_FORMAT(created_at, '%Y-%m')
  `;

      orderBy = `
    ORDER BY label
  `;
    }
    // ---------------- 6 MONTHS ----------------
    else if (filter_type === "6months") {
      dateFilter = `
    AND created_at >= CURDATE() - INTERVAL 6 MONTH
  `;

      selectLabel = `
    DATE_FORMAT(created_at, '%Y-%m') AS label
  `;

      groupBy = `
    GROUP BY DATE_FORMAT(created_at, '%Y-%m')
  `;

      orderBy = `
    ORDER BY label
  `;
    }
    // ---------------- 1 YEAR ----------------
    else if (filter_type === "1year") {
      dateFilter = `
        AND created_at >= CURDATE() - INTERVAL 1 YEAR
      `;

      selectLabel = `
        DATE_FORMAT(created_at, '%Y-%m') AS label
      `;

      groupBy = `
        GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      `;
    }

    // ---------------- CUSTOM ----------------
    else if (filter_type === "custom" && start_date && end_date) {
      dateFilter = `
        AND DATE(created_at)
        BETWEEN ? AND ?
      `;

      queryParams.push(start_date, end_date);

      // Calculate days difference
      const start = new Date(start_date);
      const end = new Date(end_date);

      const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

      // <= 31 days → daily
      if (diffDays <= 31) {
        selectLabel = `
    DATE(created_at) AS label
  `;

        groupBy = `
    GROUP BY DATE(created_at)
  `;

        orderBy = `
    ORDER BY label
  `;
      } else {
        selectLabel = `
    DATE_FORMAT(created_at, '%Y-%m') AS label
  `;

        groupBy = `
    GROUP BY DATE_FORMAT(created_at, '%Y-%m')
  `;

        orderBy = `
    ORDER BY label
  `;
      }
    }

    const query = `
SELECT

${selectLabel},

COUNT(*) AS total_admissions

FROM ipd_admissions

WHERE admin_id = ?
${branchFilter}
${dateFilter}

${groupBy}

${orderBy || "ORDER BY label"}
`;

    const [rows] = await db.query(query, queryParams);

    const total_count = rows.reduce(
      (sum, item) => sum + Number(item.total_admissions),
      0,
    );

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

      total_count,

      graph_data: rows,
    });
  } catch (error) {
    console.log("IPD Admissions Graph Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = {
  getIPDAdmissionsGraph,
};
