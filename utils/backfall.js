// scripts/backfillSystemRoles.js
const db = require("../db");
const { seedSystemRolesForAdmin } = require("../utils/seedSystemRoles");
 
(async () => {
  try {
    const [admins] = await db.execute(
      `SELECT id, plan_type FROM admins WHERE status = 1`
    );
 
    console.log(`Found ${admins.length} active admin(s). Starting backfill...`);
 
    let seeded = 0;
    let skipped = 0;
 
    for (const admin of admins) {
      if (!admin.plan_type) {
        skipped++;
        continue;
      }
 
      try {
        await seedSystemRolesForAdmin(admin.id, admin.plan_type);
        seeded++;
        console.log(`✅ Seeded admin_id=${admin.id} (plan_type=${admin.plan_type})`);
      } catch (err) {
        console.error(`❌ Failed for admin_id=${admin.id}:`, err.message);
      }
    }
 
    console.log(`\nBackfill complete.`);
    console.log(`  Seeded:  ${seeded}`);
    console.log(`  Skipped: ${skipped} (no plan_type set)`);
    console.log(`  Total:   ${admins.length}`);
 
    process.exit(0);
  } catch (err) {
    console.error("Backfill failed:", err);
    process.exit(1);
  }
})();