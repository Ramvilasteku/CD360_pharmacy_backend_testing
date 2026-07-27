const cron = require("node-cron");
const db = require("../db");

const {
  generateBedCharges,
  regenerateBill,
} = require("../routes/ipd/ipdBedChargesRoutes");

cron.schedule("* * * * *" , async () => {
  try {
    console.log("Running Bed Charge Job...");

    const [ipds] = await db.query(`
      SELECT
        id,
        admin_id
      FROM ipd_admissions
      WHERE status = 'admitted'
    `);

    for (const ipd of ipds) {
      try {
        const count = await generateBedCharges(
          ipd.id,
          ipd.admin_id
        );

      
        console.log(
          `IPD ${ipd.id} -> ${count} bed charges generated`
        );
      } catch (err) {
        console.error(
          `Failed for IPD ${ipd.id}`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error("Cron Error:", err);
  }
});

console.log("Bed Charge Cron Loaded");

module.exports = {};