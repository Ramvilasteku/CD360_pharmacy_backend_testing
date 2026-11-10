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

// ---------- Modules ----------
const roles = require('./modules/roles.js');
const features = require("./modules/features.js");
const roleFeatures = require("./modules/roleFeatures");
const permissions = require("./modules/permissions.js");
const rolePermissions = require("./modules/rolepermissions.js");
const userRoleAssignment = require("./modules/userroleassignment.js");

// ---------- Pharmacy ----------
const pharmacyDispensingRoutes = require("./routes/pharmacy/pharmacy_dispensing.js");
const pharmacyreturnRoutes = require("./routes/pharmacy/pharmacy_returns.js");
const pharmacySubstitutionRoutes = require("./routes/pharmacy/substitutions.js");
const pharmacypaymentRoutes = require("./routes/pharmacy/pharmacy_payments.js");
const pharmacyRoute = require("./modules/userroleassignment.js");
const PermissionRoute = require("./modules/permissions.js");
const rolePermissionRoute = require("./modules/rolepermissions.js");
const pharmacyCategory = require("./routes/pharmacy/categories.js");
const pharmacyMedicines = require("./routes/pharmacy/medicines.js");
const pharmacySuppliers = require("./routes/pharmacy/pharmacySupplier.js");
const pharmacyBatches = require("./routes/pharmacy/pharmacyMedicineBatches.js");
const pharmacySales = require("./routes/pharmacy/pharmacySales.js");
const pharmacySalesReports = require("./routes/pharmacy/pharmacySalesReports.js");
const pharmacyCustomers = require("./routes/pharmacy/pharmacyCustomer.js");
const pharmacyMedicineData = require("./routes/pharmacy/pharmacyMedicineData.js");
const pharmacyPurchaseOrders = require("./routes/pharmacy/pharmacyPurchaseOrders.js");
const pharmacyPurchaseItems = require("./routes/pharmacy/pharmacyPurchaseItems.js");
const pharmacyStockTransactions = require("./routes/pharmacy/pharmacyStockTransactions.js");
const pharmacyStockAdjustments = require("./routes/pharmacy/pharmacyStockAdjustments.js");
const pharmacyReceivePurchaseOrder = require("./routes/pharmacy/pharmacyReceivePurchaseOrder.js");
const pharmacyB2BSales = require("./routes/pharmacy/pharmacyB2BSales.js");
const pharmacyStockTransfer = require("./routes/pharmacy/pharmacyStockTransfer.js");
const pharmacyBranches = require("./routes/pharmacy/pharmacyBranches.js");
const pharmacyPurchaseReturns = require("./routes/pharmacy/pharmacyPurchaseReturns.js");
const pharmacyAccount = require("./routes/pharmacy/pharmacyAccount.js");
const pharmacyProcurementReports = require("./routes/pharmacy/pharmacyProcurementReports.js");

// ---------- MIDDLEWARE ----------
app.use(
  cors({
    origin: "http://localhost:3000", // React URL
    credentials: true, // allow cookies / auth headers
  }),
);

app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
// L2: Express 5 leaves req.body undefined when a request has no body, and every
// `const { x } = req.body` then throws — a 500 (one route even hung) instead of the
// route's own "x is required" message. An empty object lets that validation answer.
// (Upload routes are unaffected: multer sets its own req.body.)
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// 🔥 THIS LINE IS THE FIX
app.use("/Images", express.static(path.join(__dirname, "Images")));

// ---------- Initialize WebSocket Server ----------
initializeSocket(server); // handles socket connection

// ---------- PUBLIC ROUTES ----------
app.post("/login", authController.login);
app.post("/verify-otp", authController.loginAuth, authController.verifyOtp);
// app.post("/login", authController.login);
app.post("/logout", authController.logout);
app;
// Test Route
// app.use("/test", testRoute);
app.get("/api/modules", authController.loginAuth, authController.getModules);
app.get(
  "/api/all-modules",
  authController.loginAuth,
  authController.getAllModules,
);

// M2: the frontend's useAccess hook loads the signed-in user's roles + permissions from here
app.get("/api/getMyAccess", authController.loginAuth, authController.getMyAccess);

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
app.use("/schedule", doctorschedule);
// app.use("/api", passwordrepositories);
// app.use("/api", businessTypeRoutes);
// app.use("/api", complianceTypeRoutes);
// app.use("/api", documentRequirements);
app.use("/api", invoiceRoutes);
app.use("/api/medicines", medicinesRoutes);
app.use("/api/tests", testsRoutes);
app.use("/api/prescriptions", prescription);
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

// ---------- Modul ROUTES ----------

app.use("/api/roles", roles);
app.use("/api/features", features);
app.use("/api/role-features", roleFeatures);
app.use("/api/permissions", permissions);
app.use("/api/role-permissions", rolePermissions);
app.use("/api/user-role-assignments", userRoleAssignment);

// ---------- Pharmacy ROUTES ----------
app.use("/api", pharmacyDispensingRoutes);
app.use("/api", pharmacyreturnRoutes);
// H1: the Sales Returns screen calls /api/sales/return/... — mount the same router there too
app.use("/api/sales/return", pharmacyreturnRoutes);
// M1: substitution log used by POS and Existing-patient sale
app.use("/api/pharmacy/substitutions", pharmacySubstitutionRoutes);
app.use("/api/pharmacy", pharmacypaymentRoutes);
app.use("/api/user-role-assignments",pharmacyRoute);
app.use("/api/permissions", PermissionRoute);
app.use("/api/role-permissions", rolePermissionRoute);
app.use("/api/pharmacy/categories",pharmacyCategory);
app.use("/api/pharmacy/medicines",pharmacyMedicines);
app.use("/api/pharmacy/suppliers", pharmacySuppliers);
app.use("/api/pharmacy/batches", pharmacyBatches);
app.use("/api/pharmacy/sales", pharmacySales);
app.use("/api/pharmacy/sales-reports", pharmacySalesReports);
app.use("/api/pharmacy/customers", pharmacyCustomers);
app.use("/api/pharmacy/medicine-data", pharmacyMedicineData);
app.use("/api/pharmacy/purchase-orders", pharmacyPurchaseOrders);
app.use("/api/pharmacy/purchase-items", pharmacyPurchaseItems);
app.use("/api/pharmacy/stock-transactions", pharmacyStockTransactions);
app.use("/api/pharmacy/stock-adjustments", pharmacyStockAdjustments);
app.use("/api/pharmacy/purchase-receive", pharmacyReceivePurchaseOrder);
app.use("/api/pharmacy/b2b-sales", pharmacyB2BSales);
app.use("/api/pharmacy/stock-transfers", pharmacyStockTransfer);
app.use("/api/pharmacy/branches", pharmacyBranches);
app.use("/api/pharmacy/purchase-returns", pharmacyPurchaseReturns);
app.use("/api/pharmacy/account", pharmacyAccount);
app.use("/api/pharmacy/procurement-reports", pharmacyProcurementReports);


// ---------- START HTTP + WS SERVER ----------
server.listen(5000, () => {
  console.log("🚀 Server & WebSocket running on port 5000");
});