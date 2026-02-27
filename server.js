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

// Socket initializer

const initializeSocket = require("./routes/socketServer");
const superAdmin = require("./routes/superAdminRoutes");
const adminRoutes = require("./routes/adminRoutes");
const staffRoutes = require("./routes/staffRoutes");
const clientRoutes = require("./routes/clientRoutes");
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

// ---------- MIDDLEWARE ----------
app.use(
  cors({
    origin: "https://caredesk360.com", // React URL
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

// ---------- START HTTP + WS SERVER ----------
server.listen(5000, () => {
  console.log("🚀 Server & WebSocket running on port 5000");
});
