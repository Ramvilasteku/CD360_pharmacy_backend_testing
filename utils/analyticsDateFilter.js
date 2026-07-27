const buildDateFilter = (filterType, columnName, startDate, endDate) => {
  let condition = "";

  switch (filterType) {
    case "currentmonth":
      condition = `
    AND MONTH(${columnName}) = MONTH(CURDATE())
    AND YEAR(${columnName}) = YEAR(CURDATE())
  `;
      break;

    case "7days":
      condition = ` AND ${columnName} >= NOW() - INTERVAL 7 DAY `;
      break;

    case "1month":
      condition = ` AND ${columnName} >= NOW() - INTERVAL 1 MONTH `;
      break;

    case "3months":
      condition = ` AND ${columnName} >= NOW() - INTERVAL 3 MONTH `;
      break;

    case "6months":
      condition = ` AND ${columnName} >= NOW() - INTERVAL 6 MONTH `;
      break;

    case "1year":
      condition = ` AND ${columnName} >= NOW() - INTERVAL 1 YEAR `;
      break;

    case "custom":
      if (startDate && endDate) {
        condition = `
          AND DATE(${columnName})
          BETWEEN '${startDate}' AND '${endDate}'
        `;
      }
      break;
  }

  return condition;
};

module.exports = buildDateFilter;
