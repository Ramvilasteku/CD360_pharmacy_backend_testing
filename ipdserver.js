// ======================================================
// 📦 CORE IMPORTS
// ======================================================
const express = require("express");
const http = require("http");
const path = require("path");
require("dotenv").config();

// ======================================================
// 📦 THIRD PARTY
// ======================================================
const cors = require("cors");
const cookieParser = require("cookie-parser");

// ======================================================
// 🔌 SOCKET (OPTIONAL)
// ======================================================
const initializeSocket = require("./routes/socketServer");

// ======================================================
// 🚀 APP INIT
// ======================================================
const app = express();
const server = http.createServer(app);
const authController = require("./controllers/authController.js");
const { authMiddleware } = require("./middlewares/authMiddleware.js");

// ======================================================
// 🌐 GLOBAL MIDDLEWARE
// ======================================================
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ======================================================
// 📁 STATIC FILES
// ======================================================
app.use("/Images", express.static(path.join(__dirname, "Images")));

// ======================================================
// 🔌 SOCKET INIT
// ======================================================
initializeSocket(server);

// ======================================================
// 🔓 PUBLIC ROUTES
// ======================================================
app.post("/login", authController.login);
app.post("/verify-otp", authController.loginAuth, authController.verifyOtp);
app.post("/logout", authController.logout);

// Modules & Role Management
app.get("/api/modules", authController.loginAuth, authController.getModules);
// All system modules
app.get(
  "/api/all-modules",
  authController.loginAuth,
  authController.getAllModules
);
app.get(
  "/api/role-modules/:role",
  authController.loginAuth,
  authController.getRoleModules,
);
app.post(
  "/api/role-modules",
  authController.loginAuth,
  authController.saveRoleModules,
);
app.put(
  "/api/role-modules/:role",
  authController.loginAuth,
  authController.updateRoleModules,
);
app.delete(
  "/api/role-modules/:role",
  authController.loginAuth,
  authController.deleteRoleModules,
);

// ======================================================
// 📦 IPD ROUTES
// ======================================================

const ipdAdmissionRoutes = require("./routes/ipd/ipdAdmissionRoute.js");
const ipdWardtypeRoutes = require("./routes/ipd/ipdWardTypeRoutes");
const ipdRoomsRoutes = require("./routes/ipd/ipdRoomsRoutes");
const ipdBedsRoutes = require("./routes/ipd/ipdBedsRoutes");
const ipdBedAllocationRoutes = require("./routes/ipd/ipdBedAllocationsRoutes");
const ipdDoctorVisitsRoutes = require("./routes/ipd/ipdDoctorVisitsRoutes");
const ipdLabTestRoutes = require("./routes/ipd/ipdLabTestsRoutes");
const ipdProceduresRoutes = require("./routes/ipd/ipdProceduresRoutes");
const ipdNursingChargesRoutes = require("./routes/ipd/ipdNursingChargesRoutes");
const ipdMisellaneousChargesRoutes = require("./routes/ipd/ipdMisellaneousChargesRoutes");
const ipdPaymentsRoutes = require("./routes/ipd/ipdPaymentsRoutes");
const ipdPharmacyIssuesRoutes = require("./routes/ipd/ipdPharmacyIssuesRoutes");
const { router: ipdBillsRoutes } = require("./routes/ipd/ipdBillsRoutes");
const {
  router: ipdBedChargesRoutes,
} = require("./routes/ipd/ipdBedChargesRoutes");

require("./Cron/bedChargeCron.js");

const ipdAnalyticsRoutes = require("./routes/ipd/ipdAnalyticsRoutes.js");

// ======================================================
// 📦 USE ROUTES
// ======================================================

app.use("/api", ipdAdmissionRoutes);
app.use("/api", ipdWardtypeRoutes);
app.use("/api", ipdRoomsRoutes);
app.use("/api", ipdBedsRoutes);
app.use("/api", ipdBedAllocationRoutes);
app.use("/api", ipdDoctorVisitsRoutes);
app.use("/api", ipdLabTestRoutes);
app.use("/api", ipdProceduresRoutes);
app.use("/api", ipdNursingChargesRoutes);
app.use("/api", ipdMisellaneousChargesRoutes);
app.use("/api", ipdBedChargesRoutes);
app.use("/api", ipdBillsRoutes);
app.use("/api", ipdPaymentsRoutes);
app.use("/api", ipdPharmacyIssuesRoutes);

app.use("/api", ipdAnalyticsRoutes);

// ======================================================
// 🔌 SOCKET INIT (OPTIONAL)
// ======================================================
initializeSocket(server);

// ======================================================
// 🚀 START SERVER
// ======================================================
server.listen(5001, () => {
  console.log("🚀 IPD Server running on port 5001");
});