const express = require("express");
const router = express.Router();
const db = require("../db");

const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");


// ===================== CLIENT ROUTES =====================

// 1. Create Service Request (Client Only)
//required notification checked clients of adminid
router.post(
  "/client/service-request",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;
      const adminId = req.user.adminId;

      const {
        compliance_type_id,
        description,
        preferred_date,
        priority
      } = req.body;

      if (!description || !preferred_date) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // Verify client belongs to admin
      const [clientRow] = await db.query(
        `SELECT id FROM clients WHERE id = ? AND admin_id = ?`,
        [clientId, adminId]
      );

      if (!clientRow.length) {
        return res.status(403).json({
          message: "You are not allowed to create service request for this admin"
        });
      }

      // Insert service request
      const [result] = await db.query(
        `
        INSERT INTO service_request
          (client_id, admin_id, compliance_type_id, description, preferred_date, priority)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          clientId,
          adminId,
          compliance_type_id || null,
          description,
          preferred_date,
          priority || "normal"
        ]
      );

      const requestId = result.insertId;

      // Fetch assigned staff (if any)
      const [reqRow] = await db.query(
        `SELECT assigned_staff_id FROM service_request WHERE id = ?`,
        [requestId]
      );

      const assignedStaffId = reqRow[0]?.assigned_staff_id || null;

      // ---------------- NOTIFICATION (DB) ----------------
      const title = "New Service Request";
      const message = "Client submitted a new service request";

      const [notificationResult] = await db.query(
        `
        INSERT INTO notifications
          (sender_role, sender_id, title, message, type)
        VALUES (?, ?, ?, ?, ?)
        `,
        ["client", clientId, title, message, "request"]
      );

      const notificationId = notificationResult.insertId;

      // Admin (always)
      await db.query(
        `
        INSERT INTO notification_receivers
          (notification_id, receiver_role, receiver_id)
        VALUES (?, 'admin', ?)
        `,
        [notificationId, adminId]
      );

      // Staff (only if assigned)
      if (assignedStaffId) {
        await db.query(
          `
          INSERT INTO notification_receivers
            (notification_id, receiver_role, receiver_id)
          VALUES (?, 'staff', ?)
          `,
          [notificationId, assignedStaffId]
        );
      }

      // ---------------- SOCKET ----------------
      const socketPayload = {
        notificationId,
        requestId,
        title,
        message,
        type: "request",
        sender_role: "client",
        sender_id: clientId,
        created_at: new Date(),
      };

      // Admin
      global.io.to(adminId.toString()).emit("new_notification", socketPayload);

      // Staff (if assigned)
      if (assignedStaffId) {
        global.io
          .to(`staff_${assignedStaffId}`)
          .emit("new_notification", socketPayload);
      }

      return res.status(201).json({
        message: "Service request created successfully",
        requestId
      });

    } catch (err) {
      console.error("CREATE SERVICE REQUEST ERROR:", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);





// 2. Client — List all own requests
router.get(
  "/client/service-request",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT * FROM service_request WHERE client_id=? ORDER BY created_at DESC`,
        [req.user.id]
      );
      res.json(rows);

    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

// GET all service requests of a client
router.get(
  "/service-request",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id; // from JWT / cookie

      const [rows] = await db.execute(
        `SELECT id, priority, status, preferred_date, created_at
       FROM service_request
       WHERE client_id = ?
       ORDER BY created_at DESC`,
        [clientId]
      );

      res.json({
        success: true,
        data: rows,
      });
    } catch (err) {
      res.status(500).json({ success: false, err });
    }
  }
);


// 3. Client — View single request
router.get(
  "/client/service-request/:id",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT * FROM service_request WHERE id=? AND client_id=?`,
        [req.params.id, req.user.id]
      );

      if (!rows.length) return res.status(404).json({ message: "Not found" });
      res.json(rows[0]);

    } catch (err) {
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

// update service requests of a client
router.put(
  "/client/service-request/:id",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const requestId = req.params.id;
      const clientId = req.user.id;
      const adminId = req.user.adminId;

      const {
        compliance_type_id,
        description,
        preferred_date,
        priority
      } = req.body;

      if (!description || !preferred_date) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields"
        });
      }

      // Check existing request + assigned staff
      const [existing] = await db.execute(
        `
        SELECT status, assigned_staff_id
        FROM service_request
        WHERE id = ? AND client_id = ? AND admin_id = ?
        `,
        [requestId, clientId, adminId]
      );

      if (!existing.length) {
        return res.status(404).json({
          success: false,
          message: "Service request not found"
        });
      }

      if (existing[0].status === "completed") {
        return res.status(403).json({
          success: false,
          message: "Completed service requests cannot be edited"
        });
      }

      const assignedStaffId = existing[0].assigned_staff_id;

      // Update request
      await db.execute(
        `
        UPDATE service_request
        SET
          compliance_type_id = ?,
          description = ?,
          preferred_date = ?,
          priority = ?
        WHERE id = ?
        `,
        [
          compliance_type_id || null,
          description,
          preferred_date,
          priority || "normal",
          requestId
        ]
      );

      // ---------------- NOTIFICATION (DB) ----------------
      const title = "Service Request Updated";
      const message = "Client updated an existing service request";

      const [notificationResult] = await db.query(
        `
        INSERT INTO notifications
          (sender_role, sender_id, title, message, type)
        VALUES (?, ?, ?, ?, ?)
        `,
        ["client", clientId, title, message, "request"]
      );

      const notificationId = notificationResult.insertId;

      // Admin (always)
      await db.query(
        `
        INSERT INTO notification_receivers
          (notification_id, receiver_role, receiver_id)
        VALUES (?, 'admin', ?)
        `,
        [notificationId, adminId]
      );

      // Staff (only if assigned)
      if (assignedStaffId) {
        await db.query(
          `
          INSERT INTO notification_receivers
            (notification_id, receiver_role, receiver_id)
          VALUES (?, 'staff', ?)
          `,
          [notificationId, assignedStaffId]
        );
      }

      // ---------------- SOCKET ----------------
      const socketPayload = {
        notificationId,
        requestId,
        title,
        message,
        type: "request",
        sender_role: "client",
        sender_id: clientId,
        created_at: new Date(),
      };

      // Admin
      global.io.to(adminId.toString()).emit("new_notification", socketPayload);

      // Staff (if assigned)
      if (assignedStaffId) {
        global.io
          .to(`staff_${assignedStaffId}`)
          .emit("new_notification", socketPayload);
      }

      return res.status(200).json({
        success: true,
        message: "Service request updated successfully"
      });

    } catch (error) {
      console.error("UPDATE SERVICE REQUEST ERROR:", error);
      return res.status(500).json({
        success: false,
        message: error.sqlMessage || error.message
      });
    }
  }
);


// Fetching the clients
router.get(
  "/client/service-requests",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id; // admin id from token

      const [rows] = await db.query(
        `
        SELECT 
          sr.id,
          sr.client_id,
          sr.staff_id,
          sr.admin_id,

          sr.compliance_type_id,
          ct.name AS compliance_type_name,

          s.name AS staff_name,

          sr.description,
          sr.preferred_date,
          sr.priority,
          sr.status,
          sr.created_at

        FROM service_request sr

        LEFT JOIN compliance_types ct
          ON sr.compliance_type_id = ct.id

        LEFT JOIN staff s
          ON sr.staff_id = s.id

        WHERE sr.client_id = ?
        ORDER BY sr.created_at DESC
        `,
        [clientId]
      );

      return res.status(200).json({
        success: true,
        data: rows,
      });

    } catch (err) {
      console.error("Service request fetch error:", err);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);


// 4. Client — Cancel Request
//required notification
router.put(
  "/client/service-request/cancel",
  authMiddleware,
  allowRoles("client"),
  async (req, res) => {
    try {
      const clientId = req.user.id;

      // Find latest PENDING request only
      const [rows] = await db.query(
        `SELECT id, admin_id, description, preferred_date
         FROM service_request
         WHERE client_id=? AND status='pending'
         ORDER BY created_at DESC
         LIMIT 1`,
        [clientId]
      );

      if (rows.length === 0) {
        return res.status(400).json({ message: "No pending request found to cancel" });
      }

      const requestData = rows[0];
      const cancelledRequestId = requestData.id;
      const admin_id = requestData.admin_id;

      // Update status to cancelled
      await db.query(
        `UPDATE service_request SET status='cancelled' WHERE id=?`,
        [cancelledRequestId]
      );

      // Emit socket notification to admin
      const notification = {
        requestId: cancelledRequestId,
        clientId,
        message: "Client cancelled the service request",
        description: requestData.description,
        preferred_date: requestData.preferred_date,
        status: "cancelled",
      };

      global.io.to(admin_id.toString()).emit("request_cancelled", notification);

      res.json({ message: "Request cancelled successfully" });

    } catch (err) {
      console.error("Error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

// ===================== ADMIN ROUTES =====================

// Create the Task Routes here
router.post(
  "/admin/service-request",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;

      const {
        client_id, // optional
        compliance_type_id,
        description,
        preferred_date,
        priority,
        staff_id,
      } = req.body;

      if (!description || !preferred_date) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      // If client_id is provided → verify it belongs to admin
      if (client_id) {
        const [clientRow] = await db.query(
          `SELECT id FROM clients WHERE id = ? AND admin_id = ?`,
          [client_id, adminId]
        );

        if (!clientRow.length) {
          return res.status(403).json({
            message: "Client does not belong to this admin"
          });
        }
      }

      // Insert service request
      const [result] = await db.query(
        `
        INSERT INTO service_request
          (client_id, admin_id, compliance_type_id, description, preferred_date, priority, staff_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          client_id || null,              // NULL = "other"
          adminId,
          compliance_type_id || null,
          description,
          preferred_date,
          priority || "normal",
          staff_id || null
        ]
      );

      const requestId = result.insertId;

      // ---------------- NOTIFICATION ----------------
      const title = "New Service Request";
      const message = client_id
        ? "Admin created a service request for a client"
        : "Admin created a service request (Other)";

      const [notificationResult] = await db.query(
        `
        INSERT INTO notifications
          (sender_role, sender_id, title, message, type)
        VALUES (?, ?, ?, ?, ?)
        `,
        ["admin", adminId, title, message, "request"]
      );

      const notificationId = notificationResult.insertId;

      // Admin receiver (self / other admins if needed)
      await db.query(
        `
        INSERT INTO notification_receivers
          (notification_id, receiver_role, receiver_id)
        VALUES (?, 'admin', ?)
        `,
        [notificationId, adminId]
      );

      // Staff receiver (if assigned)
      if (staff_id) {
        await db.query(
          `
          INSERT INTO notification_receivers
            (notification_id, receiver_role, receiver_id)
          VALUES (?, 'staff', ?)
          `,
          [notificationId, staff_id]
        );
      }

      // ---------------- SOCKET ----------------
      const socketPayload = {
        notificationId,
        requestId,
        title,
        message,
        type: "request",
        sender_role: "admin",
        sender_id: adminId,
        created_at: new Date(),
      };

      // Emit to admin
      global.io.to(adminId.toString()).emit("new_notification", socketPayload);

      // Emit to staff
      if (staff_id) {
        global.io
          .to(`staff_${staff_id}`)
          .emit("new_notification", socketPayload);
      }

      return res.status(201).json({
        message: "Service request created successfully",
        requestId,
        client_type: client_id ? "client" : "other"
      });

    } catch (err) {
      console.error("ADMIN CREATE SERVICE REQUEST ERROR:", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);


// 5. List all service requests under admin
router.get(
  "/admin/service-requests",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id; // admin id from token

      const [rows] = await db.query(
        `
        SELECT 
          sr.id,
          sr.client_id,
          c.name AS client_name,

          sr.staff_id,
          sr.admin_id,

          sr.compliance_type_id,
          ct.name AS compliance_type_name,

          s.name AS staff_name,

          sr.description,
          sr.preferred_date,
          sr.priority,
          sr.status,
          sr.created_at,
          b.bill_status

        FROM service_request sr

        LEFT JOIN compliance_types ct
          ON sr.compliance_type_id = ct.id

        LEFT JOIN staff s
          ON sr.staff_id = s.id

        LEFT JOIN clients c
          ON sr.client_id = c.id
        
        LEFT JOIN bills b 
        ON b.request_id = sr.id

        WHERE sr.admin_id = ?
        ORDER BY sr.created_at DESC
        `,
        [adminId]
      );

      return res.status(200).json({
        success: true,
        data: rows,
      });

    } catch (err) {
      console.error("Service request fetch error:", err);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Fetch the staff based srvice request analytics
router.get(
  "/admin/staff-service-analytics",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;

      const {
        staff_id,
        year = new Date().getFullYear(),
      } = req.query;

      // -----------------------------
      // DEFAULT: pick ONE staff if no filter
      // -----------------------------
      let staffCondition = "";
      let params = [adminId, year];

      if (staff_id) {
        staffCondition = "AND sr.staff_id = ?";
        params.push(staff_id);
      } else {
        staffCondition = `
          AND sr.staff_id = (
            SELECT id FROM staff
            WHERE admin_id = ?
            ORDER BY id ASC
            LIMIT 1
          )
        `;
        params.push(adminId);
      }

      const [rows] = await db.execute(
        `
        SELECT
          sr.staff_id,
          s.name AS staff_name,

          MONTH(sr.created_at) AS month,
          MONTHNAME(sr.created_at) AS month_name,

          SUM(CASE WHEN sr.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN sr.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
          SUM(CASE WHEN sr.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
          COUNT(*) AS total_requests

        FROM service_request sr

        INNER JOIN staff s ON sr.staff_id = s.id

        WHERE
          sr.admin_id = ?
          AND YEAR(sr.created_at) = ?
          ${staffCondition}

        GROUP BY
          sr.staff_id,
          month,
          month_name

        ORDER BY
          month ASC
        `,
        params
      );

      return res.status(200).json({
        success: true,
        year,
        staff_id: staff_id || "default",
        data: rows,
      });

    } catch (err) {
      console.error("Staff analytics error:", err);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);


// Admin gets the details of a specific service request under his id.
router.get(
  "/admin/service-requests/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;
      const requestId = req.params.id;

      const [rows] = await db.query(
        `
        SELECT 
          sr.id,
          sr.client_id,
          sr.staff_id,
          sr.admin_id,

          sr.compliance_type_id,
          ct.name AS compliance_type_name,

          s.name AS staff_name,

          sr.description,
          sr.preferred_date,
          sr.priority,
          sr.status,
          sr.created_at

        FROM service_request sr

        LEFT JOIN compliance_types ct
          ON sr.compliance_type_id = ct.id

        LEFT JOIN staff s
          ON sr.staff_id = s.id

        WHERE sr.id = ? AND sr.admin_id = ?
        `,
        [requestId, adminId]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Service request not found",
        });
      }

      return res.status(200).json({
        success: true,
        data: rows[0],
      });

    } catch (err) {
      console.error("Get service request error:", err);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);

// Admin deletes a service request under his id.  
router.delete(
  "/admin/service-requests/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;
      const requestId = req.params.id;

      // Check if service request exists and belongs to this admin
      const [rows] = await db.query(
        `
        SELECT id
        FROM service_request
        WHERE id = ? AND admin_id = ?
        `,
        [requestId, adminId]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Service request not found or unauthorized",
        });
      }

      // Delete service request
      await db.query(
        `
        DELETE FROM service_request
        WHERE id = ? AND admin_id = ?
        `,
        [requestId, adminId]
      );

      return res.status(200).json({
        success: true,
        message: "Service request deleted successfully",
      });

    } catch (err) {
      console.error("Delete service request error:", err);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);


// Admin updates service request: assign staff and/or update status
router.put(
  "/admin/service-requests/:id",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;
      const requestId = req.params.id;
      const { staff_id, status } = req.body;

      // Validate status if provided
      const allowedStatuses = ["pending", "assigned", "completed", "cancelled"];
      if (status && !allowedStatuses.includes(status)) {
        return res.status(400).json({ message: "Invalid status value" });
      }

      // If staff_id provided → verify staff belongs to admin
      if (staff_id) {
        const [staff] = await db.query(
          `SELECT id FROM staff WHERE id=? AND admin_id=?`,
          [staff_id, adminId]
        );

        if (staff.length === 0) {
          return res.status(403).json({
            message: "Staff does not belong to this admin",
          });
        }
      }

      // Update service request
      const [result] = await db.query(
        `
        UPDATE service_request
        SET 
          staff_id = ?,
          status = ?
        WHERE id = ? AND admin_id = ?
        `,
        [
          staff_id || null,   // null = admin himself
          status || "pending",
          requestId,
          adminId
        ]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({
          message: "Service request not found",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Service request updated successfully",
      });

    } catch (err) {
      console.error("Update service request error:", err);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      });
    }
  }
);






//Admin gets requests under his id filtered by status that comes from frontend.
router.get(
  "/admin/service-requests/status",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { status } = req.query;  // from frontend
      const adminId = req.user.id;   // from token/cookie

      if (!status) {
        return res.status(400).json({ message: "status is required" });
      }

      const [rows] = await db.query(
        `SELECT * FROM service_request 
         WHERE admin_id=? AND status=? 
         ORDER BY created_at DESC`,
        [adminId, status]
      );

      res.json(rows);

    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

//Get All Requests for a Specific Staff
router.get(
  "/admin/service-requests/client",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { client_id } = req.query;    // passed from frontend
      const adminId = req.user.id;       // from cookie/token

      if (!client_id) {
        return res.status(400).json({ message: "client_id is required" });
      }

      const [rows] = await db.query(
        `SELECT * FROM service_request
         WHERE admin_id=? AND client_id=?
         ORDER BY created_at DESC`,
        [adminId, client_id]
      );

      res.json(rows);

    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);


//Admin — Get Requests for Staff With Status Filter
router.get(
  "/admin/service-requests/client/status",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { client_id, status } = req.query;
      const adminId = req.user.id;

      if (!client_id || !status) {
        return res.status(400).json({ message: "client_id and status are required" });
      }

      const [rows] = await db.query(
        `SELECT * FROM service_request
         WHERE admin_id=? AND client_id=? AND status=?
         ORDER BY created_at DESC`,
        [adminId, client_id, status]
      );

      res.json(rows);

    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);


// 6. Assign to Admin (self take request)
router.put(
  "/admin/service-request/:request_id/assign-self",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const adminId = req.user.id;
      const requestId = req.params.request_id;

      // ⭐ Admin can assign to self even if staff already assigned
      const [result] = await db.query(
        `UPDATE service_request
         SET staff_id = NULL,             -- remove staff assignment
             admin_id = ?, 
             status = 'assigned',
             assigned_at = NOW()
         WHERE id = ? 
           AND admin_id = ?`,
        [adminId, requestId, adminId]
      );

      if (!result.affectedRows) {
        return res.status(400).json({
          message: "Cannot assign: Request not found under this admin"
        });
      }

      // 🔔 Save notification
      const [notify] = await db.query(
        `INSERT INTO notifications 
          (sender_role, sender_id, title, message, type)
         VALUES (?, ?, ?, ?, ?)`,
        [
          "admin",
          adminId,
          "Task Assigned",
          `You assigned request #${requestId} to yourself`,
          "request"
        ]
      );

      // Insert receiver record (admin himself)
      await db.query(
        `INSERT INTO notification_receivers 
           (notification_id, receiver_role, receiver_id)
         VALUES (?, ?, ?)`,
        [notify.insertId, "admin", adminId]
      );

      // 🔥 Real-time websocket to admin
      global.io.to(adminId.toString()).emit(
        "new_assignment",
        `You have assigned request #${requestId} to yourself`
      );

      res.json({ message: "Request assigned to yourself successfully" });

    } catch (err) {
      console.error("Assign self error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);






// 7. Assign to Staff
router.put(
  "/admin/service-request/assign-staff",
  authMiddleware,
  allowRoles("admin"),
  async (req, res) => {
    try {
      const { request_id, staff_id } = req.body;
      const adminId = req.user.id; // admin from cookie

      if (!request_id || !staff_id) {
        return res.status(400).json({
          message: "request_id and staff_id are required"
        });
      }

      // 1️⃣ Validate staff belongs to this admin
      const [staffRows] = await db.query(
        `SELECT id, admin_id FROM staff WHERE id = ?`,
        [staff_id]
      );

      if (staffRows.length === 0) {
        return res.status(404).json({ message: "Staff not found" });
      }

      if (Number(staffRows[0].admin_id) !== Number(adminId)) {
        return res.status(403).json({
          message: "Unauthorized: Staff does not belong to this admin"
        });
      }

      // 2️⃣ Update request and assign to staff
      const [result] = await db.query(
        `UPDATE service_request
         SET staff_id = ?, status = 'assigned', assigned_at = NOW()
         WHERE id = ? AND admin_id = ?`,
        [staff_id, request_id, adminId]
      );

      if (!result.affectedRows) {
        return res.status(400).json({
          message: "Request not found or does not belong to this admin"
        });
      }

      // 3️⃣ Save notification
      const [notify] = await db.query(
        `INSERT INTO notifications (sender_role, sender_id, title, message, type)
         VALUES (?, ?, ?, ?, ?)`,
        [
          "admin",
          adminId,
          "Task Assigned",
          `Request #${request_id} assigned to you`,
          "request"
        ]
      );

      // 4️⃣ Assign receiver record
      await db.query(
        `INSERT INTO notification_receivers (notification_id, receiver_role, receiver_id)
         VALUES (?, ?, ?)`,
        [notify.insertId, "staff", staff_id]
      );

      // 5️⃣ WebSocket real-time push
      global.io.to(staff_id.toString()).emit(
        "new_assignment",
        `New service request #${request_id} assigned to you`
      );

      res.json({ message: "Staff assigned successfully" });

    } catch (err) {
      console.error("Assign staff error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);





// 8. Admin and Staff update status manually
router.put(
  "/service-request/:id/status",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.id;      // from token/cookie
      const role = req.user.role;      // 'admin' or 'staff'
      const requestId = req.params.id;
      const { status } = req.body;

      if (!status) {
        return res.status(400).json({ message: "Status is required" });
      }

      let query = "";
      let params = [];

      // ⭐ ADMIN UPDATE
      if (role === "admin") {
        // If completed → update completed_at also
        if (status === "completed") {
          query = `
            UPDATE service_request
            SET status=?, completed_at=NOW()
            WHERE id=? AND admin_id=?
          `;
        } else {
          query = `
            UPDATE service_request
            SET status=?
            WHERE id=? AND admin_id=?
          `;
        }

        params = [status, requestId, userId];
      }

      // ⭐ STAFF UPDATE
      else if (role === "staff") {
        if (status === "completed") {
          query = `
            UPDATE service_request
            SET status=?, completed_at=NOW()
            WHERE id=? AND staff_id=?
          `;
        } else {
          query = `
            UPDATE service_request
            SET status=?
            WHERE id=? AND staff_id=?
          `;
        }

        params = [status, requestId, userId];
      }

      // ❌ Unauthorized Role
      else {
        return res.status(403).json({ message: "Unauthorized role" });
      }

      const [result] = await db.query(query, params);

      if (!result.affectedRows) {
        return res.status(400).json({ message: "Cannot update status or unauthorized" });
      }

      // --------------- FETCH CLIENT + ADMIN DETAILS ----------------
      const [info] = await db.query(
        `SELECT client_id, admin_id, staff_id 
         FROM service_request 
         WHERE id=?`,
        [requestId]
      );

      if (!info.length) {
        return res.status(404).json({ message: "Service request not found" });
      }

      const { client_id, admin_id, staff_id } = info[0];

      // ------------------- WEBSOCKET NOTIFICATIONS -----------------

      // STAFF → COMPLETED
      if (role === "staff" && status === "completed") {
        // Notify Client
        global.io.to(client_id.toString()).emit("request_completed", {
          request_id: requestId,
          message: "Your service request was completed by staff",
        });

        // Notify Admin
        global.io.to(admin_id.toString()).emit("request_completed", {
          request_id: requestId,
          message: "A staff member completed a service request",
        });
      }

      // ADMIN → COMPLETED
      if (role === "admin" && status === "completed") {
        global.io.to(client_id.toString()).emit("request_completed", {
          request_id: requestId,
          message: "Your service request was marked completed by admin",
        });
      }

      // -------------------------------------------------------------

      res.json({ message: "Status updated successfully" });

    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);





// 9. Add delay reason
router.put(
  "/service-request/:request_id/delay",
  authMiddleware,
  allowRoles("admin", "staff"),
  async (req, res) => {
    try {
      const { delay_reason } = req.body;
      const requestId = req.params.request_id;

      if (!delay_reason) {
        return res.status(400).json({ message: "delay_reason is required" });
      }

      // ---- Fetch service request info first ----
      const [requestRows] = await db.query(
        `SELECT client_id, admin_id, staff_id, description, preferred_date
         FROM service_request
         WHERE id = ?`,
        [requestId]
      );

      if (requestRows.length === 0) {
        return res.status(404).json({ message: "Service request not found" });
      }

      const requestData = requestRows[0];

      // Check permission based on role
      let condition = "";
      let params = [delay_reason, requestId];

      if (req.user.role === "admin") {
        condition = "AND admin_id = ?";
        params.push(req.user.id);
      } else if (req.user.role === "staff") {
        condition = "AND staff_id = ?";
        params.push(req.user.id);
      }

      // ---- Update delay status ----
      const [result] = await db.query(
        `UPDATE service_request
         SET status='delayed', delay_reason=?
         WHERE id=? ${condition}`,
        params
      );

      if (!result.affectedRows) {
        return res.status(400).json({ message: "Cannot mark as delayed or unauthorized" });
      }

      // ---- SOCKET: Notify Client ONLY when staff delays ----
      if (req.user.role === "staff") {
        const delayNotification = {
          requestId,
          message: "Your service request has been delayed by staff",
          reason: delay_reason,
          description: requestData.description,
          preferred_date: requestData.preferred_date,
          status: "delayed",
        };

        global.io.to(requestData.client_id.toString()).emit("request_delayed", delayNotification);
      }

      res.json({ message: "Delay reason updated successfully" });

    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);





// ===================== STAFF ROUTES =====================

// 10. Staff view assigned service requests
router.get(
  "/staff/service-requests",
  authMiddleware,
  allowRoles("staff"),
  async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT * FROM service_request WHERE staff_id=? ORDER BY created_at DESC`,
        [req.user.id]
      );
      res.json(rows);

    } catch (err) {
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.get(
  "/staff-client/service-requests",
  authMiddleware,
  allowRoles("staff"),
  async (req, res) => {
    try {
      const staffId = req.user.id;

      const [rows] = await db.query(
        `
        SELECT
          sr.id,
          sr.description,
          sr.status,
          sr.priority,
          sr.created_at,
          sr.preferred_date,
          sr.compliance_type_id,
          sr.completed_at,
          c.id AS client_id,
          c.name AS client_name,
          c.email AS client_email,
          c.mobile AS client_mobile,
          c.address AS client_address
        FROM service_request sr
        INNER JOIN clients c ON sr.client_id = c.id
        WHERE sr.staff_id = ?
        ORDER BY sr.created_at DESC
        `,
        [staffId]
      );

      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

// here staff update the completed date of service request

router.put(
  "/service-request/:id/completed-datetime",
  authMiddleware,
  allowRoles("staff"),
  async (req, res) => {
    try {
      const staffId = req.user.id;
      const requestId = req.params.id;
      const { completed_at } = req.body; // expects date + time

      if (!completed_at) {
        return res.status(400).json({
          message: "completed_at (date & time) is required",
        });
      }

      // Accept formats:
      // "2025-01-16 14:30:00"
      // OR ISO: "2025-01-16T14:30:00"
      const completedDateTime = new Date(completed_at);

      if (isNaN(completedDateTime.getTime())) {
        return res.status(400).json({
          message: "Invalid completed_at datetime format",
        });
      }

      const [result] = await db.query(
        `
        UPDATE service_request
        SET completed_at = ?, status = 'completed'
        WHERE id = ? AND staff_id = ?
        `,
        [completedDateTime, requestId, staffId]
      );

      if (!result.affectedRows) {
        return res.status(403).json({
          message: "Unauthorized or request not found",
        });
      }

      // Fetch details for notification
      const [info] = await db.query(
        `SELECT client_id, admin_id FROM service_request WHERE id=?`,
        [requestId]
      );

      if (info.length) {
        const { client_id, admin_id } = info[0];

        // Notify client
        global.io.to(client_id.toString()).emit("request_completed", {
          request_id: requestId,
          message: "Your service request has been completed",
        });

        // Notify admin
        global.io.to(admin_id.toString()).emit("request_completed", {
          request_id: requestId,
          message: "Staff completed a service request",
        });
      }

      res.json({
        message: "Completed date & time updated successfully",
      });

    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);


//  Updated /service-request/:id/updateservice , here update all status, delay_reason,completed_at
router.put(
  "/service-request/:id/updateservice",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = req.user.id;
      const role = req.user.role;
      const requestId = req.params.id;

      const { status, delay_reason, completed_at } = req.body;

      // ---------------- VALIDATE STATUS ----------------
      if (!["in_progress", "delayed", "completed"].includes(status)) {
        return res.status(400).json({ message: "Invalid status value" });
      }

      if (status === "delayed" && !delay_reason) {
        return res.status(400).json({ message: "Delay reason is required" });
      }

      if (status === "completed" && !completed_at) {
        return res.status(400).json({ message: "Completed date is required" });
      }

      const delayReasonValue = status === "delayed" ? delay_reason : null;
      const completedAtValue = status === "completed" ? completed_at : null;

      let query = "";
      let params = [];

      // ---------------- ADMIN UPDATE ----------------
      if (role === "admin") {
        query = `
          UPDATE service_request
          SET status = ?, delay_reason = ?, completed_at = ?
          WHERE id = ? AND admin_id = ?
        `;
        params = [
          status,
          delayReasonValue,
          completedAtValue,
          requestId,
          userId,
        ];
      }

      // ---------------- STAFF UPDATE ----------------
      else if (role === "staff") {
        query = `
          UPDATE service_request
          SET status = ?, delay_reason = ?, completed_at = ?
          WHERE id = ? AND staff_id = ?
        `;
        params = [
          status,
          delayReasonValue,
          completedAtValue,
          requestId,
          userId,
        ];
      } else {
        return res.status(403).json({ message: "Unauthorized role" });
      }

      const [result] = await db.query(query, params);

      if (!result.affectedRows) {
        return res.status(400).json({
          message: "Update failed or unauthorized access",
        });
      }

      // ---------------- FETCH REQUEST DETAILS ----------------
      const [info] = await db.query(
        `SELECT client_id, admin_id
         FROM service_request
         WHERE id = ?`,
        [requestId]
      );

      if (!info.length) {
        return res.status(404).json({ message: "Service request not found" });
      }

      const { client_id, admin_id } = info[0];

      // ---------------- NOTIFICATION CONTENT ----------------
      let title = "Service Request Update";
      let message = "";

      if (status === "in_progress") {
        message = "Your service request is now in progress.";
      }

      if (status === "delayed") {
        message = `Your service request is delayed. Reason: ${delay_reason}`;
      }

      if (status === "completed") {
        message = "Your service request has been completed successfully.";
      }

      // ---------------- INSERT NOTIFICATION ----------------
      const [notifResult] = await db.query(
        `INSERT INTO notifications
        (sender_role, sender_id, title, message, type)
        VALUES (?, ?, ?, ?, 'request')`,
        [role, userId, title, message]
      );

      const notificationId = notifResult.insertId;

      // ---------------- RECEIVER → CLIENT ----------------
      await db.query(
        `INSERT INTO notification_receivers
        (notification_id, receiver_role, receiver_id)
        VALUES (?, 'client', ?)`,
        [notificationId, client_id]
      );

      // ---------------- SOCKET → CLIENT ----------------
      global.io.to(client_id.toString()).emit("new-notification", {
        notificationId,
        title,
        message,
        type: "request",
      });

      // ---------------- ADMIN NOTIFY (ONLY IF STAFF UPDATED) ----------------
      if (role === "staff") {
        const adminTitle = "Service Request Updated by Staff";
        const adminMessage = `Staff updated service request #${requestId} to "${status}"`;

        const [adminNotif] = await db.query(
          `INSERT INTO notifications
          (sender_role, sender_id, title, message, type)
          VALUES ('staff', ?, ?, ?, 'request')`,
          [userId, adminTitle, adminMessage]
        );

        await db.query(
          `INSERT INTO notification_receivers
          (notification_id, receiver_role, receiver_id)
          VALUES (?, 'admin', ?)`,
          [adminNotif.insertId, admin_id]
        );

        global.io.to(admin_id.toString()).emit("new-notification", {
          notificationId: adminNotif.insertId,
          title: adminTitle,
          message: adminMessage,
          type: "request",
        });
      }

      // -----------------------------------------------------
      res.json({ message: "Status updated successfully" });
    } catch (err) {
      console.error("Status update error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);








// ===================== EXPORT ROUTER =====================
module.exports = router;
