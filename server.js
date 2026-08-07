const express = require("express");
const http = require("http");
const cookieParser = require("cookie-parser");
const cors = require("cors");
require("dotenv").config();

// Routes

const authController = require("./controllers/authController.js");
const stafftimeSlots = require("./routes/stafftimeslots");
const serviceRequest = require("./routes/serviceRequestRoute");
// const testRoute = require("./routes/testRoute");
const appointment = require("./routes/appointmentRoute");
const clientStaffReviews = require("./routes/clientStaffReviews");
const bill = require("./routes/bills.js");
const medicinesRoutes = require("./routes/medicinesRoutes.js");
const consultationTypesRoute = require("./routes/consultationTypes.js");
const clientPrescriptionsRouter = require("./routes/clientPrescriptionsRoute");
const landingAdmin = require("./routes/admin.js");
const landingContact = require("./routes/contact.js");
const landingDemo = require("./routes/demo.js");

// Socket initializer

const initializeSocket = require("./routes/socketServer");
const superAdmin = require("./routes/superAdminRoutes");
const adminRoutes = require("./routes/adminRoutes");
const staffRoutes = require("./routes/staffRoutes");
const clientRoutes = require("./routes/clientRoutes");
const patientRoutes = require("./routes/patientRoutes");
const leaveRequest = require("./routes/leaveRequest");
const staffAttendance = require("./routes/staffAttendance");
const updateNews = require("./routes/UpdatedNews.js");
const documents = require("./routes/documents.js");
const payments = require("./routes/paymentsRoutes.js");
const notification = require("./routes/notification.js");
const passwordrepositories = require("./routes/repositories.js");
const forgotPassword = require("./routes/forgot_password.js");
const doctorschedule = require("./routes/doctorschedule.js");
// const taskRoutes = require("./routes/taskRoutes");
// const businessTypeRoutes = require("./routes/businessType");
// const complianceTypeRoutes = require("./routes/complianceType");
const invoiceRoutes = require("./routes/invoiceRoutes.js");
// const documentRequirements = require("./routes/documentRequirements");
const testsRoutes = require("./routes/testRoutes.js");
const prescription = require("./routes/prescription.js");
const app = express();
const server = http.createServer(app);
const path = require("path");
const { fileURLToPath } = require("url");
const { authMiddleware } = require("./middlewares/authMiddleware.js");

// ipdserver

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

// ---------- MIDDLEWARE ----------
app.use(
  cors({
    origin: "http://localhost:3000", // React URL
    credentials: true, // allow cookies / auth headers
  })
);

app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// 🔥 THIS LINE IS THE FIX
app.use("/Images", express.static(path.join(__dirname, "Images")));

// ---------- Initialize WebSocket Server ----------
initializeSocket(server); // handles socket connection

// ---------- PUBLIC ROUTES ----------
app.post("/login", authController.login);
app.post("/verify-otp", authController.loginAuth, authController.verifyOtp);
app.post("/logout", authController.logout);
app;
// Test Route
// app.use("/test", testRoute);
app.get("/api/modules", authController.loginAuth,authController.getModules);
app.get(
  "/api/all-modules",
  authController.loginAuth,
  authController.getAllModules
);

app.get("/api/role-modules/:role", authController.loginAuth, authController.getRoleModules);

app.post("/api/role-modules", authController.loginAuth,authController.saveRoleModules);

app.put("/api/role-modules/:role", authController.loginAuth,authController.updateRoleModules);

app.delete("/api/role-modules/:role",  authController.loginAuth,authController.deleteRoleModules);

// ---------- PROTECTED ROUTES ----------

app.use("/api", stafftimeSlots);
app.use("/service", serviceRequest);
app.use("/appointment", appointment);
app.use("/review", clientStaffReviews);
app.use("/bill", bill);
app.use("/api", superAdmin);
app.use("/api", adminRoutes);
app.use("/api", staffRoutes);
app.use("/api", clientRoutes);
app.use("/api", patientRoutes);
app.use("/api", leaveRequest);
app.use("/api", staffAttendance);
app.use("/news", updateNews);
app.use("/api", documents);
app.use("/api", payments);
app.use("/api", notification);
app.use("/api", forgotPassword);
app.use("/schedule",doctorschedule);
// app.use("/api", passwordrepositories);
// app.use("/api", businessTypeRoutes);
// app.use("/api", complianceTypeRoutes);
// app.use("/api", documentRequirements);
app.use("/api", invoiceRoutes);
app.use("/api/medicines", medicinesRoutes);
app.use("/api/tests", testsRoutes);
app.use("/api/prescriptions",prescription );
app.use("/api/consultation-types", consultationTypesRoute);
app.use("/api/client/prescriptions", clientPrescriptionsRouter);

// Landing Page Routes
app.use("/landingpage/admin", landingAdmin);
app.use("/landingpage/contact", landingContact);
app.use("/landingpage/demo", landingDemo);

// ---------- IPD ROUTES ----------
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



// ---------- START HTTP + WS SERVER ----------
server.listen(5000, () => {
  console.log("🚀 Server & WebSocket running on port 5000");
});
