const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

/* =========================================================
   📝 CLIENT → CREATE REVIEW
========================================================= */
router.post(
  "/client/review",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      let { appointment_id, rating, review } = req.body;
      const clientId = req.user.id;
      const adminId = req.user.adminId;
      /* 🔹 normalize */
      appointment_id = Number(appointment_id);
      rating = Number(rating);
      review = review ? review.trim() : null;

      /* 🔹 validation */
      if (!appointment_id || !rating) {
        return res.status(400).json({
          success: false,
          message: "appointment_id and rating are required",
        });
      }

      if (rating < 1 || rating > 5) {
        return res.status(400).json({
          success: false,
          message: "Rating must be between 1 and 5",
        });
      }

      /* 1️⃣ Get client */
      const [[client]] = await db.query(
        `SELECT name FROM clients WHERE id = ?`,
        [clientId]
      );

      if (!client) {
        return res.status(404).json({
          success: false,
          message: "Client not found",
        });
      }

      /* 2️⃣ Validate appointment */
      const [[appointment]] = await db.query(
        `
        SELECT id, admin_id, staff_id
        FROM appointments
        WHERE id = ?
          AND client_id = ?
          AND status = 'completed'
        `,
        [appointment_id, clientId]
      );

      if (!appointment) {
        return res.status(400).json({
          success: false,
          message: "You can review only your completed appointments",
        });
      }

      if (!appointment.staff_id) {
        return res.status(400).json({
          success: false,
          message: "Doctor not assigned for this appointment",
        });
      }

      /* 3️⃣ Prevent duplicate review */
      const [existing] = await db.query(
        `
        SELECT id
        FROM client_staff_reviews
        WHERE appointment_id = ? AND client_id = ?
        `,
        [appointment_id, clientId]
      );

      if (existing.length) {
        return res.status(409).json({
          success: false,
          message: "You have already reviewed this appointment",
        });
      }

      /* 4️⃣ Insert review */
      const [result] = await db.query(
        `
        INSERT INTO client_staff_reviews
        (admin_id, appointment_id, staff_id, client_id, rating, review)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          appointment.admin_id,
          appointment_id,
          appointment.staff_id,
          clientId,
          rating,
          review,
        ]
      );

      const reviewId = result.insertId;

      /* 5️⃣ Notification */
      const title = "New Doctor Review";
      const message = `Client ${client.name} submitted a ${rating}★ review`;
      const adminid = appointment.admin_id;
      const [notif] = await db.query(
        `
        INSERT INTO notifications
        (admin_id,sender_role, sender_id, title, message, type)
        VALUES (?,'client', ?, ?, ?, 'review')
        `,
        [adminid, clientId, title, message]
      );

      await db.query(
        `
        INSERT INTO notification_receivers
        (notification_id, receiver_role, receiver_id)
        VALUES (?, 'doctor', ?)
        `,
        [notif.insertId, appointment.staff_id]
      );

      /* 6️⃣ WebSocket */
      global.io.to(appointment.staff_id.toString()).emit("new-notification", {
        id: notif.insertId,
        type: "review",
        review_id: reviewId,
        appointment_id,
        rating,
        client_name: client.name,
      });

      return res.status(201).json({
        success: true,
        message: "Review submitted successfully",
        review_id: reviewId,
      });
    } catch (error) {
      console.error("CREATE REVIEW ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

//Admin Reviews Route
router.get(
  "/admin/reviews",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;

      const { staff_id, rating, fromDate, toDate, role } = req.query;

      let whereClause = "csr.admin_id = ?";
      let params = [adminId];

      if (staff_id) {
        whereClause += " AND csr.staff_id = ?";
        params.push(staff_id);
      }

      if (rating) {
        whereClause += " AND csr.rating = ?";
        params.push(rating);
      }

      if (fromDate) {
        whereClause += " AND DATE(csr.created_at) >= ?";
        params.push(fromDate);
      }

      if (toDate) {
        whereClause += " AND DATE(csr.created_at) <= ?";
        params.push(toDate);
      }

      if (role) {
        whereClause += " AND s.role = ?";
        params.push(role);
      }

      const [reviews] = await db.query(
        `
        SELECT
          csr.staff_id,
          s.name AS staff_name,

          COUNT(csr.id) AS total_reviews,
          ROUND(AVG(csr.rating), 1) + 0 AS avg_rating,

          SUM(csr.rating = 5) + 0 AS rating_5,
          SUM(csr.rating = 4) + 0 AS rating_4,
          SUM(csr.rating = 3) + 0 AS rating_3,
          SUM(csr.rating = 2) + 0 AS rating_2,
          SUM(csr.rating = 1) + 0 AS rating_1
        FROM client_staff_reviews csr
        LEFT JOIN staff s ON csr.staff_id = s.id
        WHERE ${whereClause}
        GROUP BY csr.staff_id, s.name
        ORDER BY avg_rating DESC
        `,
        params
      );

      res.json({
        success: true,
        filters: { staff_id, rating, fromDate, toDate, role },
        reviews,
      });
    } catch (err) {
      console.error("Error fetching admin reviews:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

/* =========================================================
   📋 GET REVIEWS (ADMIN | RECEPTIONIST | DOCTOR | CLIENT)
========================================================= */
router.get(
  "/reviews",
  authMiddleware,
  allowRoles("admin", "receptionist", "doctor", "client"),
  async (req, res) => {
    try {
      const { role, id: userId, adminId: tokenAdminId } = req.user;

      let { branch, doctorId, appointment_id } = req.query;

      branch = branch ? branch.trim().toLowerCase() : null;
      doctorId = doctorId ? Number(doctorId) : null;
      appointment_id = appointment_id ? Number(appointment_id) : null;

      let whereClause = "";
      let params = [];
      let adminId = null;

      if (role === "client") {
        whereClause = "csr.client_id = ?";
        params = [userId];
      } else {
        adminId = role === "admin" ? userId : tokenAdminId;

        whereClause = "csr.admin_id = ?";
        params = [adminId];
      }

if (role === "doctor") {

  const [[doctor]] = await db.query(
    `
    SELECT id
    FROM staff
    WHERE id = ?
      AND role = 'doctor'
      AND status = 1
    `,
    [userId]
  );


  if (!doctor) {
    return res.status(403).json({
      success:false,
      message:"Doctor not found"
    });
  }


  whereClause += ` AND csr.staff_id = ?`;
  params.push(doctor.id);
}

      // RECEPTIONIST → FORCE OWN BRANCH ONLY
      if (role === "receptionist") {
        const [[receptionist]] = await db.query(
          `SELECT branch
           FROM staff
           WHERE id = ?
             AND admin_id = ?
             AND role = 'receptionist'
             AND status = 1`,
          [userId, adminId]
        );

        if (!receptionist || !receptionist.branch) {
          return res.status(403).json({
            success: false,
            message: "Invalid receptionist branch"
          });
        }

        const recBranch = receptionist.branch.trim().toLowerCase();
        whereClause += ` AND LOWER(s.branch) = ?`;
        params.push(recBranch);

        branch = recBranch; // override filter
      }

      // ADMIN → optional branch filter
      if (role === "admin" && branch) {
        whereClause += ` AND LOWER(s.branch) = ?`;
        params.push(branch);
      }

      // Doctor filter (admin & receptionist only)
      if ((role === "admin" || role === "receptionist") && doctorId) {
        whereClause += ` AND s.id = ?`;
        params.push(doctorId);
      }

      // Appointment filter (all roles)
      if (appointment_id) {
        whereClause += ` AND csr.appointment_id = ?`;
        params.push(appointment_id);
      }

      /* =========================
         FETCH REVIEWS
      ========================== */
      const [reviews] = await db.query(
        `
        SELECT
          csr.id AS review_id,
          csr.appointment_id,
          csr.rating,
          csr.review,
          csr.created_at,

          c.id AS client_id,
          c.name AS client_name,

          s.id AS staff_id,
          s.name AS doctor_name,
          s.branch
        FROM client_staff_reviews csr
        JOIN clients c ON c.id = csr.client_id
        JOIN staff s ON s.id = csr.staff_id
        WHERE ${whereClause}
        ORDER BY csr.created_at DESC
        `,
        params
      );

      return res.status(200).json({
        success: true,
        role,
        branch: branch || "all",
        doctorId: doctorId || null,
        appointment_id: appointment_id || null,
        count: reviews.length,
        reviews
      });

    } catch (error) {
      console.error("FETCH REVIEWS ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error"
      });
    }
  }
);


//calculate overall reviews percentage 

router.get(
  "/doctor/overall-percentage",
  authMiddleware,
  allowRoles("doctor"),
  async (req, res) => {
    try {
      const doctorId = req.user.id;
      const adminId = req.user.adminId;

      const [[stats]] = await db.query(
        `
        SELECT 
          COUNT(*) AS total_reviews,
          AVG(rating) AS avg_rating
        FROM client_staff_reviews
        WHERE staff_id = ? AND admin_id = ?
        `,
        [doctorId, adminId]
      );

      if (!stats || stats.total_reviews === 0) {
        return res.status(200).json({
          success: true,
          total_reviews: 0,
          avg_rating: 0,
          review_percentage: 0
        });
      }

      const total = stats.total_reviews;
    const avgRating = stats.avg_rating
      ? Number(stats.avg_rating).toFixed(2)
      : "0.00";

      // Calculate overall percentage
      const reviewPercentage = parseFloat(((avgRating / 5) * 100).toFixed(2));

      return res.status(200).json({
        success: true,
        total_reviews: total,
        avg_rating: avgRating,
        review_percentage: reviewPercentage,
        count:total
      });

    } catch (error) {
      console.error("DOCTOR OVERALL PERCENTAGE ERROR:", error);
      return res.status(500).json({
        success: false,
        message: "Internal server error"
      });
    }
  }
);


module.exports = router;
