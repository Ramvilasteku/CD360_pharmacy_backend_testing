const express = require("express");
const router = express.Router();
const db = require("../../db");
const { authMiddleware } = require("../../middlewares/authMiddleware");
const { allowRoles } = require("../../middlewares/roleMiddleware");

/* ===================== CREATE IPD (Receptionist Only) ===================== */
router.post(
  "/create/ipdadmission",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId, id: staffId } = req.user;

      const { client_id, doctor_id, bed_id, admission_date, admission_reason } =
        req.body;

      if (!client_id || !admission_date) {
        return res.status(400).json({
          success: false,
          message: "client_id & admission_date required",
        });
      }

      await conn.beginTransaction();

      /* ================= GET RECEPTIONIST BRANCH ================= */
      const [[staff]] = await conn.query(
        `SELECT branch
         FROM staff
         WHERE id = ? AND admin_id = ? AND status = 1`,
        [staffId, adminId],
      );

      if (!staff) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Invalid staff",
        });
      }

      const branch_name = (staff.branch || "");

      /* ================= CLIENT VALIDATION ================= */
      const [[client]] = await conn.query(
        `SELECT id
         FROM clients
          WHERE id = ? AND status = 1`,
        [client_id],
      );

      if (!client) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "Invalid client_id",
        });
      }

      /* ================= DOCTOR VALIDATION ================= */
      if (doctor_id) {
        const [[doctor]] = await conn.query(
          `SELECT id, branch
           FROM staff
           WHERE id = ?
             AND admin_id = ?
             AND role = 'doctor'
             AND status = 1`,
          [doctor_id, adminId],
        );

        if (!doctor) {
          await conn.rollback();

          return res.status(404).json({
            success: false,
            message: "Invalid doctor_id",
          });
        }

        if ((doctor.branch || "") !== branch_name) {
          await conn.rollback();

          return res.status(403).json({
            success: false,
            message: "Doctor belongs to different branch",
          });
        }
      }

      /* ================= BED VALIDATION ================= */
      if (bed_id && bed_id !== "NULL") {
        const [[bed]] = await conn.query(
          `SELECT id, bed_status, branch_name
           FROM ipd_beds
           WHERE id = ? AND admin_id = ?`,
          [bed_id, adminId],
        );

        if (!bed) {
          await conn.rollback();

          return res.status(404).json({
            success: false,
            message: "Invalid bed_id",
          });
        }

        if (bed.bed_status === "occupied") {
          await conn.rollback();

          return res.status(400).json({
            success: false,
            message: "Bed already occupied",
          });
        }

        if ((bed.branch_name || "") !== branch_name) {
          await conn.rollback();

          return res.status(403).json({
            success: false,
            message: "Bed belongs to different branch",
          });
        }
      }

      /* ================= GENERATE RANDOM IPD ID ================= */
      let newIpdId = null;
      let isUnique = false;
      let attempts = 0;

      while (!isUnique && attempts < 10) {
        const randomNumber = Math.floor(100000 + Math.random() * 900000);

        const generatedId = `IPD${randomNumber}`;

        const [[existingIpd]] = await conn.query(
          `SELECT id
            FROM ipd_admissions
            WHERE id = ?`,
          [generatedId],
        );

        if (!existingIpd) {
          newIpdId = generatedId;
          isUnique = true;
        }

        attempts++;
      }

      if (!isUnique) {
        throw new Error("Failed to generate unique IPD ID");
      }
      /* ================= INSERT IPD ================= */
      await conn.query(
        `INSERT INTO ipd_admissions
          (
            id,
            admin_id,
            client_id,
            doctor_id,
            bed_id,
            branch_name,
            admission_date,
            admission_reason
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newIpdId,
          adminId,
          client_id,
          doctor_id || null,
          bed_id && bed_id !== "NULL" ? bed_id : null,
          branch_name,
          admission_date,
          admission_reason || null,
        ],
      );

      /* ================= BED OCCUPY ================= */
      if (bed_id && bed_id !== "NULL") {
        await conn.query(
          `UPDATE ipd_beds
           SET bed_status = 'occupied'
           WHERE id = ?`,
          [bed_id],
        );

        await conn.query(
          `INSERT INTO ipd_bed_allocations
          (
            admin_id,
            ipd_id,
            bed_id,
            start_time
          )
          VALUES (?, ?, ?, ?)`,
          [adminId, newIpdId, bed_id, admission_date],
        );
      }

      await conn.commit();

      await conn.query(
        `INSERT INTO ipd_bills
  (
    admin_id,
    ipd_id,
    total_amount,
    balance_amount
  )
  VALUES (?, ?, 0, 0)`,
        [adminId, newIpdId],
      );

      return res.status(201).json({
        success: true,
        message: "IPD admission created",
        id: newIpdId,
        branch: branch_name,
      });
    } catch (err) {
      await conn.rollback();

      console.error("Create IPD Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to create IPD",
      });
    } finally {
      conn.release();
    }
  },
);

/* ===================== GET IPD ===================== */
router.get(
  "/get/ipdadmission",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;

      const finalAdminId = role === "admin" ? id : adminId;

      const { id: ipdId } = req.query;

      let where = `i.admin_id = ?`;
      let params = [finalAdminId];

      if (role === "client") {
        where += ` AND i.client_id = ?`;
        params.push(id);
      }

      if (ipdId) {
        where += ` AND i.id = ?`;
        params.push(ipdId);

        const [[row]] = await db.query(
          `SELECT
            i.*,
            c.name AS client_name,
            s.name AS doctor_name
           FROM ipd_admissions i
           JOIN clients c ON c.id = i.client_id
           LEFT JOIN staff s ON s.id = i.doctor_id
           WHERE ${where}`,
          params,
        );

        if (!row) {
          return res.status(404).json({
            success: false,
            message: "IPD not found",
          });
        }

        return res.json({
          success: true,
          data: row,
        });
      }

      const [rows2] = await db.query(
        `SELECT
          i.*,
          c.name AS client_name,
          s.name AS doctor_name
         FROM ipd_admissions i
         JOIN clients c ON c.id = i.client_id
         LEFT JOIN staff s ON s.id = i.doctor_id
         WHERE ${where}
         ORDER BY i.created_at DESC`,
        params,
      );

      return res.json({
        success: true,
        count: rows2.length,
        data: rows2,
      });
    } catch (err) {
      console.error("Get IPD Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch IPD",
      });
    }
  },
);


router.get(
  "/get/active-ipdadmissions",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;

      // For admin, use their own id.
      // For receptionist and doctor, use the associated adminId.
      const finalAdminId = role === "admin" ? id : adminId;

      const [rows] = await db.query(
        `SELECT
          i.*,
          c.name AS client_name,
          s.name AS doctor_name
         FROM ipd_admissions i
         JOIN clients c ON c.id = i.client_id
         LEFT JOIN staff s ON s.id = i.doctor_id
         WHERE i.admin_id = ?
           AND i.status = 'admitted'
         ORDER BY i.created_at DESC`,
        [finalAdminId]
      );

      return res.json({
        success: true,
        count: rows.length,
        data: rows,
      });
    } catch (err) {
      console.error("Get Active IPD Admissions Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to fetch active IPD admissions",
      });
    }
  }
);

/* ===================== UPDATE IPD ===================== */
router.put(
  "/ipd/:id",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    const conn = await db.getConnection();

    try {
      const { adminId, id: staffId } = req.user;
      const ipdId = req.params.id;

      const {
        doctor_id,
        bed_id,
        admission_date,
        admission_reason,
        discharge_date,
        discharge_summary,
        status,
      } = req.body;

      let fields = [];
      let values = [];

      await conn.beginTransaction();

      /* ================= GET STAFF ================= */
      const [[staff]] = await conn.query(
        `SELECT branch
         FROM staff
         WHERE id = ?
           AND admin_id = ?
           AND status = 1`,
        [staffId, adminId],
      );

      if (!staff) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "Invalid staff",
        });
      }

      const branch_name = (staff.branch || "").trim().toLowerCase();

      /* ================= GET IPD ================= */
      const [[ipd]] = await conn.query(
        `SELECT *
         FROM ipd_admissions
         WHERE id = ?
           AND admin_id = ?`,
        [ipdId, adminId],
      );

      if (!ipd) {
        await conn.rollback();

        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      /* ================= BRANCH SECURITY ================= */
      if ((ipd.branch_name || "").trim().toLowerCase() !== branch_name) {
        await conn.rollback();

        return res.status(403).json({
          success: false,
          message: "You cannot update IPD from another branch",
        });
      }

      /* ================= DOCTOR ================= */
      if (doctor_id !== undefined) {
        const [[doctor]] = await conn.query(
          `SELECT id, branch
           FROM staff
           WHERE id = ?
             AND admin_id = ?
             AND role = 'doctor'
             AND status = 1`,
          [doctor_id, adminId],
        );

        if (!doctor) {
          await conn.rollback();

          return res.status(400).json({
            success: false,
            message: "Invalid doctor_id",
          });
        }

        if ((doctor.branch || "").trim().toLowerCase() !== branch_name) {
          await conn.rollback();

          return res.status(403).json({
            success: false,
            message: "Doctor belongs to different branch",
          });
        }

        if (doctor_id !== ipd.doctor_id) {
          fields.push("doctor_id = ?");
          values.push(doctor_id);
        }
      }

      /* ================= ADMISSION DATE ================= */
      if (admission_date !== undefined) {
        if (ipd.status === "discharged") {
          await conn.rollback();

          return res.status(400).json({
            success: false,
            message: "Cannot change admission_date after discharge",
          });
        }

        if (admission_date !== ipd.admission_date) {
          fields.push("admission_date = ?");
          values.push(admission_date);
        }
      }

      /* ================= ADMISSION REASON ================= */
      if (admission_reason !== undefined) {
        if (admission_reason !== ipd.admission_reason) {
          fields.push("admission_reason = ?");
          values.push(admission_reason || null);
        }
      }

      /* ================= BED CHANGE ================= */
      if (bed_id !== undefined) {
        /* ===== ASSIGN / CHANGE BED ===== */
        if (bed_id && bed_id !== "NULL") {
          const [[bed]] = await conn.query(
            `SELECT id, bed_status, branch_name
             FROM ipd_beds
             WHERE id = ?
               AND admin_id = ?`,
            [bed_id, adminId],
          );

          if (!bed) {
            await conn.rollback();

            return res.status(404).json({
              success: false,
              message: "Invalid bed_id",
            });
          }

          /* ===== BRANCH CHECK ===== */
          if ((bed.branch_name || "").trim().toLowerCase() !== branch_name) {
            await conn.rollback();

            return res.status(403).json({
              success: false,
              message: "Bed belongs to different branch",
            });
          }

          /* ===== BED OCCUPIED CHECK ===== */
          if (bed.bed_status === "occupied" && bed_id !== ipd.bed_id) {
            await conn.rollback();

            return res.status(400).json({
              success: false,
              message: "Bed already occupied",
            });
          }

          /* ===== CHANGE BED ===== */
          if (bed_id !== ipd.bed_id) {
            /* ===== COMPLETE OLD BED ===== */
            if (ipd.bed_id) {
              /* free old bed */
              await conn.query(
                `UPDATE ipd_beds
                 SET bed_status = 'available'
                 WHERE id = ?`,
                [ipd.bed_id],
              );

              /* complete old allocation */
              await conn.query(
                `UPDATE ipd_bed_allocations
                 SET
                    end_time = NOW(),
                    allocation_status = 'completed'
                 WHERE ipd_id = ?
                   AND bed_id = ?
                   AND allocation_status = 'active'`,
                [ipdId, ipd.bed_id],
              );
            }

            /* ===== OCCUPY NEW BED ===== */
            await conn.query(
              `UPDATE ipd_beds
               SET bed_status = 'occupied'
               WHERE id = ?`,
              [bed_id],
            );

            /* ===== CREATE NEW ALLOCATION ===== */
            const [allocationResult] = await conn.query(
              `INSERT INTO ipd_bed_allocations
              (
                admin_id,
                ipd_id,
                bed_id,
                start_time,
                allocation_status
              )
              VALUES (?, ?, ?, NOW(), 'active')`,
              [adminId, ipdId, bed_id],
            );

            /* ===== UPDATE IPD ===== */
            fields.push("bed_id = ?");
            values.push(bed_id);

            fields.push("bed_allocation_id = ?");
            values.push(allocationResult.insertId);
          }
        } else {
          /* ===== REMOVE BED ===== */
          if (ipd.bed_id) {
            /* free current bed */
            await conn.query(
              `UPDATE ipd_beds
               SET bed_status = 'available'
               WHERE id = ?`,
              [ipd.bed_id],
            );

            /* complete active allocation */
            await conn.query(
              `UPDATE ipd_bed_allocations
               SET
                  end_time = NOW(),
                  allocation_status = 'completed'
               WHERE ipd_id = ?
                 AND bed_id = ?
                 AND allocation_status = 'active'`,
              [ipdId, ipd.bed_id],
            );
          }

          /* clear bed from IPD */
          fields.push("bed_id = ?");
          values.push(null);

          fields.push("bed_allocation_id = ?");
          values.push(null);
        }
      }

      /* ================= DISCHARGE DATE ================= */
      if (discharge_date !== undefined) {
        fields.push("discharge_date = ?");
        values.push(discharge_date || null);
      }

      /* ================= DISCHARGE SUMMARY ================= */
      if (discharge_summary !== undefined) {
        fields.push("discharge_summary = ?");
        values.push(discharge_summary || null);
      }

      /* ================= STATUS ================= */
      if (status !== undefined && status !== ipd.status) {
        fields.push("status = ?");
        values.push(status);

        /* ===== DISCHARGE ===== */
        if (status === "discharged") {
            if (!discharge_date) {
              fields.push("discharge_date = ?");
              values.push(new Date());
            }
          


          /* ===== COMPLETE ACTIVE ALLOCATIONS ===== */
          await conn.query(
            `UPDATE ipd_bed_allocations
             SET
                end_time = NOW(),
                allocation_status = 'completed'
             WHERE ipd_id = ?
               AND allocation_status = 'active'`,
            [ipdId],
          );

          /* ===== FREE CURRENT BED ===== */
          if (ipd.bed_id) {
            await conn.query(
              `UPDATE ipd_beds
               SET bed_status = 'available'
               WHERE id = ?`,
              [ipd.bed_id],
            );
          }

          /* ===== REMOVE BED FROM IPD ===== */
          fields.push("bed_id = ?");
          values.push(null);

          fields.push("bed_allocation_id = ?");
          values.push(null);
        }
      }

      /* ================= NO CHANGES ================= */
      if (fields.length === 0) {
        await conn.rollback();

        return res.status(400).json({
          success: false,
          message: "No changes detected",
        });
      }

      /* ================= UPDATE IPD ================= */
      const query = `
        UPDATE ipd_admissions
        SET ${fields.join(", ")}
        WHERE id = ?
          AND admin_id = ?
      `;

      values.push(ipdId, adminId);

      const [result] = await conn.query(query, values);

      if (result.affectedRows === 0) {
        await conn.rollback();

        return res.status(400).json({
          success: false,
          message: "No update happened",
        });
      }

      await conn.commit();
      if (status === "discharged") { 
         try {    
          await generateBedCharges(ipdId, adminId);  
            await regenerateBill(ipdId);7  } 
            catch (err) {    console.error("Billing error:", err);  }}

            
      return res.json({
        success: true,
        message: "IPD updated successfully",
      });
    } catch (err) {
      await conn.rollback();

      console.error("Update IPD Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to update IPD",
        error: err.message,
      });
    } finally {
      conn.release();
    }
  },
);

/* ===================== SEARCH IPD ===================== */
router.get(
  "/search/ipdadmission",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;

      const finalAdminId = role === "admin" ? id : adminId;

      const { search } = req.query;

      if (!search || !search.trim()) {
        return res.status(400).json({
          success: false,
          message: "Search query required",
        });
      }

      const keyword = `%${search.trim().toLowerCase()}%`;

      let where = `
        i.admin_id = ?
      `;

      let params = [finalAdminId];

      /* ================= CLIENT ACCESS ================= */
      if (role === "client") {
        where += ` AND i.client_id = ?`;

        params.push(id);
      }

      /* ================= DOCTOR ACCESS ================= */
      if (role === "doctor") {
        where += ` AND i.doctor_id = ?`;

        params.push(id);
      }

      /* ================= SEARCH ================= */
      where += `
        AND (
          LOWER(i.id) LIKE ?

          OR CAST(i.admin_id AS CHAR) LIKE ?
          OR CAST(i.client_id AS CHAR) LIKE ?
          OR CAST(i.doctor_id AS CHAR) LIKE ?
          OR CAST(i.bed_id AS CHAR) LIKE ?
          OR CAST(i.bed_allocation_id AS CHAR) LIKE ?

          OR LOWER(i.branch_name) LIKE ?
          OR LOWER(i.admission_reason) LIKE ?
          OR LOWER(i.discharge_summary) LIKE ?
          OR LOWER(i.status) LIKE ?

          OR DATE_FORMAT(i.admission_date, '%Y-%m-%d %H:%i:%s') LIKE ?
          OR DATE_FORMAT(i.discharge_date, '%Y-%m-%d %H:%i:%s') LIKE ?
          OR DATE_FORMAT(i.created_at, '%Y-%m-%d %H:%i:%s') LIKE ?
          OR DATE_FORMAT(i.updated_at, '%Y-%m-%d %H:%i:%s') LIKE ?

          OR LOWER(c.name) LIKE ?
          OR LOWER(s.name) LIKE ?
        )
      `;

      params.push(
        keyword, // id

        keyword, // admin_id
        keyword, // client_id
        keyword, // doctor_id
        keyword, // bed_id
        keyword, // bed_allocation_id

        keyword, // branch_name
        keyword, // admission_reason
        keyword, // discharge_summary
        keyword, // status

        keyword, // admission_date
        keyword, // discharge_date
        keyword, // created_at
        keyword, // updated_at

        keyword, // client_name
        keyword, // doctor_name
      );

      /* ================= GET DATA ================= */
      const [rows] = await db.query(
        `
        SELECT
          i.*,
          c.name AS client_name,
          s.name AS doctor_name
        FROM ipd_admissions i
        JOIN clients c
          ON c.id = i.client_id
        LEFT JOIN staff s
          ON s.id = i.doctor_id
        WHERE ${where}
        ORDER BY i.created_at DESC
        `,
        params,
      );

      return res.json({
        success: true,
        count: rows.length,
        data: rows,
      });
    } catch (err) {
      console.error("Search IPD Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to search IPD",
        error: err.message,
      });
    }
  },
);

/* ===================== get branch under admin IPD ===================== */

router.get(
  "/get/admin/branches",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;
      const finalAdminId = role === "admin" ? id : adminId;

      // Pull distinct branch values from staff table under this admin
      const [rows] = await db.query(
        `SELECT DISTINCT branch 
         FROM staff 
         WHERE admin_id = ? 
           AND branch IS NOT NULL 
           AND branch != ''
         ORDER BY branch ASC`,
        [finalAdminId],
      );

      return res.json({
        success: true,
        data: rows.map((r) => r.branch),
      });
    } catch (err) {
      console.error("Get branches error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to fetch branches" });
    }
  },
);

/* ===================== edit branch by receptionist ===================== */

router.put(
  "/ipd/transfer/:ipdId",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const { adminId } = req.user;

      // branch from token/user
      const staffBranch = req.user.branch;

      const { ipdId } = req.params;
      const { to_branch } = req.body;

      console.log("req.user =>", req.user);
      console.log("staffBranch =>", staffBranch);

      const [[admission]] = await db.query(
        `SELECT id, branch_name
         FROM ipd_admissions
         WHERE id = ? AND admin_id = ?`,
        [ipdId, adminId],
      );

      console.log("admission.branch_name =>", admission?.branch_name);

      if (!admission) {
        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      const admissionBranch = String(admission.branch_name || "")
        .trim()
        .toLowerCase();

      const receptionistBranch = String(staffBranch || "")
        .trim()
        .toLowerCase();

      console.log("admissionBranch =>", admissionBranch);
      console.log("receptionistBranch =>", receptionistBranch);

      if (admissionBranch !== receptionistBranch) {
        return res.status(403).json({
          success: false,
          message: "You can only transfer admissions from your own branch",
        });
      }

      await db.query(
        `UPDATE ipd_admissions
         SET branch_name = ?
         WHERE id = ?`,
        [to_branch, ipdId],
      );

      return res.json({
        success: true,
        message: "Transferred successfully",
      });
    } catch (err) {
      console.error("Transfer error:", err);

      return res.status(500).json({
        success: false,
        message: "Transfer failed",
      });
    }
  },
);


/* ===================== SEARCH IPD ===================== */
router.get(
  "/search/ipdadmission",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;

      const finalAdminId = role === "admin" ? id : adminId;

      const { search } = req.query;

      if (!search || !search.trim()) {
        return res.status(400).json({
          success: false,
          message: "Search query required",
        });
      }

      const keyword = `%${search.trim().toLowerCase()}%`;

      let where = `
        i.admin_id = ?
      `;

      let params = [finalAdminId];

      /* ================= CLIENT ACCESS ================= */
      if (role === "client") {
        where += ` AND i.client_id = ?`;

        params.push(id);
      }

      /* ================= DOCTOR ACCESS ================= */
      if (role === "doctor") {
        where += ` AND i.doctor_id = ?`;

        params.push(id);
      }

      /* ================= SEARCH ================= */
      where += `
        AND (
          LOWER(i.id) LIKE ?

          OR CAST(i.admin_id AS CHAR) LIKE ?
          OR CAST(i.client_id AS CHAR) LIKE ?
          OR CAST(i.doctor_id AS CHAR) LIKE ?
          OR CAST(i.bed_id AS CHAR) LIKE ?
          OR CAST(i.bed_allocation_id AS CHAR) LIKE ?

          OR LOWER(i.branch_name) LIKE ?
          OR LOWER(i.admission_reason) LIKE ?
          OR LOWER(i.discharge_summary) LIKE ?
          OR LOWER(i.status) LIKE ?

          OR DATE_FORMAT(i.admission_date, '%Y-%m-%d %H:%i:%s') LIKE ?
          OR DATE_FORMAT(i.discharge_date, '%Y-%m-%d %H:%i:%s') LIKE ?
          OR DATE_FORMAT(i.created_at, '%Y-%m-%d %H:%i:%s') LIKE ?
          OR DATE_FORMAT(i.updated_at, '%Y-%m-%d %H:%i:%s') LIKE ?

          OR LOWER(c.name) LIKE ?
          OR LOWER(s.name) LIKE ?
        )
      `;

      params.push(
        keyword, // id

        keyword, // admin_id
        keyword, // client_id
        keyword, // doctor_id
        keyword, // bed_id
        keyword, // bed_allocation_id

        keyword, // branch_name
        keyword, // admission_reason
        keyword, // discharge_summary
        keyword, // status

        keyword, // admission_date
        keyword, // discharge_date
        keyword, // created_at
        keyword, // updated_at

        keyword, // client_name
        keyword, // doctor_name
      );

      /* ================= GET DATA ================= */
      const [rows] = await db.query(
        `
        SELECT
          i.*,
          c.name AS client_name,
          s.name AS doctor_name
        FROM ipd_admissions i
        JOIN clients c
          ON c.id = i.client_id
        LEFT JOIN staff s
          ON s.id = i.doctor_id
        WHERE ${where}
        ORDER BY i.created_at DESC
        `,
        params,
      );

      return res.json({
        success: true,
        count: rows.length,
        data: rows,
      });
    } catch (err) {
      console.error("Search IPD Error:", err);

      return res.status(500).json({
        success: false,
        message: "Failed to search IPD",
        error: err.message,
      });
    }
  },
);

/* ===================== get branch under admin IPD ===================== */

router.get(
  "/get/admin/branches",
  authMiddleware,
  allowRoles("admin", "receptionist"),
  async (req, res) => {
    try {
      const { role, id, adminId } = req.user;
      const finalAdminId = role === "admin" ? id : adminId;

      // Pull distinct branch values from staff table under this admin
      const [rows] = await db.query(
        `SELECT DISTINCT branch 
         FROM staff 
         WHERE admin_id = ? 
           AND branch IS NOT NULL 
           AND branch != ''
         ORDER BY branch ASC`,
        [finalAdminId],
      );

      return res.json({
        success: true,
        data: rows.map((r) => r.branch),
      });
    } catch (err) {
      console.error("Get branches error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Failed to fetch branches" });
    }
  },
);


/* ===================== edit branch by receptionist ===================== */

router.put(
  "/ipd/transfer/:ipdId",
  authMiddleware,
  allowRoles("receptionist"),
  async (req, res) => {
    try {
      const { adminId } = req.user;

      // branch from token/user
      const staffBranch = req.user.branch;

      const { ipdId } = req.params;
      const { to_branch } = req.body;

      console.log("req.user =>", req.user);
      console.log("staffBranch =>", staffBranch);

      const [[admission]] = await db.query(
        `SELECT id, branch_name
         FROM ipd_admissions
         WHERE id = ? AND admin_id = ?`,
        [ipdId, adminId],
      );

      console.log("admission.branch_name =>", admission?.branch_name);

      if (!admission) {
        return res.status(404).json({
          success: false,
          message: "IPD not found",
        });
      }

      const admissionBranch = String(admission.branch_name || "")
        .trim()
        .toLowerCase();

      const receptionistBranch = String(staffBranch || "")
        .trim()
        .toLowerCase();

      console.log("admissionBranch =>", admissionBranch);
      console.log("receptionistBranch =>", receptionistBranch);

      if (admissionBranch !== receptionistBranch) {
        return res.status(403).json({
          success: false,
          message: "You can only transfer admissions from your own branch",
        });
      }

      await db.query(
        `UPDATE ipd_admissions
         SET branch_name = ?
         WHERE id = ?`,
        [to_branch, ipdId],
      );

      return res.json({
        success: true,
        message: "Transferred successfully",
      });
    } catch (err) {
      console.error("Transfer error:", err);

      return res.status(500).json({
        success: false,
        message: "Transfer failed",
      });
    }
  },
);


router.get(
  "/get/branch/ipdadmission",
  authMiddleware,
  allowRoles("admin", "receptionist", "client"),
  async (req, res) => {
    try {
      const {
        role,
        id,
        adminId,
        branch,
      } = req.user;

      // ============================================
      // FINAL ADMIN ID
      // ============================================
      const finalAdminId =
        role === "admin" ? id : adminId;

      // ============================================
      // QUERY PARAMS
      // ============================================
      const {
        id: ipdId,
        branch: queryBranch,
        status,
      } = req.query;

      // ============================================
      // BASE WHERE
      // ============================================
      let where = `1=1`;
      let params = [];

      // Admin & Receptionist -> filter by admin
      if (role === "admin") {
        where += ` AND i.admin_id = ?`;
        params.push(id);
      }

      if (role === "receptionist") {
        where += ` AND i.admin_id = ?`;
        params.push(adminId);
      }

      // Client -> only own admissions
      if (role === "client") {
        where += ` AND i.client_id = ?`;
        params.push(id);
      }

      // ============================================
      // RECEPTIONIST
      // ONLY THEIR BRANCH DATA
      // ============================================
      // ============================================
// RECEPTIONIST -> ONLY THEIR BRANCH
// ============================================
if (role === "receptionist") {

  // Get receptionist branch
  const [[staffData]] = await db.query(
    `
    SELECT branch
    FROM staff
    WHERE id = ?
    AND role = 'receptionist'
    `,
    [id]
  );

  // If branch exists
  if (staffData?.branch) {

    where += `
      AND LOWER(i.branch_name) = ?
    `;

    params.push(
      staffData.branch.toLowerCase()
    );
  }
}
      // ============================================
      // ADMIN BRANCH FILTER
      // ============================================
      if (
        role === "admin" &&
        queryBranch
      ) {
        where += ` AND LOWER(i.branch_name) = ?`;

        params.push(
          queryBranch.toLowerCase()
        );
      }

      // ============================================
      // STATUS FILTER
      // ============================================
      if (status) {
        where += ` AND i.status = ?`;
        params.push(status);
      }

      // ============================================
      // SINGLE IPD
      // ============================================
      if (ipdId) {
        where += ` AND i.id = ?`;
        params.push(ipdId);

        const [[row]] = await db.query(
          `
          SELECT
            i.*,

            c.name AS client_name,
            c.mobile AS client_mobile,

            d.name AS doctor_name,

            ba.id AS bed_allocation_id,

            b.bed_number,
            r.room_number,
            w.ward_type_name

          FROM ipd_admissions i

          JOIN clients c
            ON c.id = i.client_id

          LEFT JOIN staff d
            ON d.id = i.doctor_id

          LEFT JOIN ipd_bed_allocations ba
            ON ba.id = i.bed_allocation_id

          LEFT JOIN ipd_beds b
            ON b.id = ba.bed_id

          LEFT JOIN ipd_rooms r
            ON r.id = b.room_id

          LEFT JOIN ipd_ward_type w
            ON w.id = r.ward_type_id

          WHERE ${where}
          `,
          params
        );

        if (!row) {
          return res.status(404).json({
            success: false,
            message: "IPD admission not found",
          });
        }

        return res.json({
          success: true,
          data: row,
        });
      }

      // ============================================
      // ALL IPD LIST
      // ============================================
      const [rows] = await db.query(
        `
        SELECT
          i.*,

          c.name AS client_name,
          c.mobile AS client_mobile,

          d.name AS doctor_name,

          ba.id AS bed_allocation_id,

          b.bed_number,
          r.room_number,
          w.ward_type_name

        FROM ipd_admissions i

        JOIN clients c
          ON c.id = i.client_id

        LEFT JOIN staff d
          ON d.id = i.doctor_id

        LEFT JOIN ipd_bed_allocations ba
          ON ba.id = i.bed_allocation_id

        LEFT JOIN ipd_beds b
          ON b.id = ba.bed_id

        LEFT JOIN ipd_rooms r
          ON r.id = b.room_id

        LEFT JOIN ipd_ward_type w
          ON w.id = r.ward_type_id

        WHERE ${where}

        ORDER BY i.created_at DESC
        `,
        params
      );

      return res.status(200).json({
        success: true,
        count: rows.length,
        data: rows,
      });

    } catch (err) {
      console.error(
        "GET IPD ADMISSION ERROR:",
        err
      );

      return res.status(500).json({
        success: false,
        message:
          "Failed to fetch IPD admissions",
      });
    }
  }
);




module.exports = router;