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
      const adminId = req.user.id; // from login token/cookie

      const [reviews] = await db.query(
        `SELECT csr.id, csr.request_id, csr.staff_id, csr.client_id, csr.rating, csr.review, csr.created_at,
                s.name AS staff_name, c.name AS client_name
         FROM client_staff_reviews csr
         LEFT JOIN staff s ON csr.staff_id = s.id
         LEFT JOIN clients c ON csr.client_id = c.id
         WHERE csr.admin_id = ?
         ORDER BY csr.created_at DESC`,
        [adminId]
      );

      res.json({ reviews });
    } catch (err) {
      console.error("Error fetching admin reviews:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);



//Staff Reviews Route

router.get(
  "/staff/reviews",
  authMiddleware,
  allowRoles("staff"),
  async (req, res) => {
    try {
      const staffId = req.user.id; // from login token/cookie

      const [reviews] = await db.query(
        `SELECT csr.id, csr.request_id, csr.admin_id, csr.client_id, csr.rating, csr.review, csr.created_at,
                a.name AS admin_name, c.name AS client_name
         FROM client_staff_reviews csr
         LEFT JOIN admins a ON csr.admin_id = a.id
         LEFT JOIN clients c ON csr.client_id = c.id
         WHERE csr.staff_id = ?
         ORDER BY csr.created_at DESC`,
        [staffId]
      );

      res.json({ reviews });
    } catch (err) {
      console.error("Error fetching staff reviews:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);


//Client Reviews Route

router.get(
  "/client/reviews",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id; // from login token/cookie

      const [reviews] = await db.query(
        `SELECT csr.id, csr.request_id, csr.admin_id, csr.staff_id, csr.rating, csr.review, csr.created_at,
                a.name AS admin_name,
                s.name AS staff_name
         FROM client_staff_reviews csr
         LEFT JOIN admins a ON csr.admin_id = a.id
         LEFT JOIN staff s ON csr.staff_id = s.id
         WHERE csr.client_id = ?
         ORDER BY csr.created_at DESC`,
        [clientId]
      );

      res.json({ reviews });
    } catch (err) {
      console.error("Error fetching client reviews:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

//Admin Reviews Route with the review id

router.get(
  "/reviews/details/:reviewId",
  authMiddleware,
  allowRoles("admin", "staff", "client"),
  async (req, res) => {
    try {
      const { reviewId } = req.params;

      const adminId =
        req.user.role === "admin" ? req.user.id : req.user.adminId;

      const [rows] = await db.execute(
        `
        SELECT
            csr.id AS review_id,
            csr.rating,
            csr.review,
            csr.created_at AS review_created_at,

            sr.id AS request_id,
            sr.status,
            sr.preferred_date,
            sr.description,

            c.id AS client_id,
            c.name AS client_name,

            ct.name AS compliance_type,

            s.id AS staff_id,
            s.name AS staff_name

        FROM client_staff_reviews csr
        JOIN service_request sr ON csr.request_id = sr.id
        JOIN clients c ON sr.client_id = c.id
        JOIN compliance_types ct ON sr.compliance_type_id = ct.id
        LEFT JOIN staff s ON sr.staff_id = s.id
        WHERE csr.id = ?
          AND csr.admin_id = ?
        `,
        [reviewId, adminId]
      );

      if (!rows.length) {
        return res.status(404).json({ message: "Review not found" });
      }

      res.json(rows[0]);
    } catch (err) {
      console.error("REVIEW DETAILS ERROR:", err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

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