// socketTestClient.js
const { io } = require("socket.io-client");

// Connect to socket server
const socket = io("http://localhost:5000", {
  transports: ["websocket"],
});

socket.on("connect", () => {
  console.log("🟢 Connected to Socket Server:", socket.id);

  // Simulate user login (example staff_id = 12)
  socket.emit("register", 5);  
  console.log("📍 Registered user ID: 12");
});

// Listen for admin assignment event
socket.on("new_service_request", (msg) => {
  console.log("📩 Received Notification:", msg);
});
socket.on("new_appointment", (msg) => console.log(msg));
socket.on("appointment_cancelled", (msg) => console.log(msg));
socket.on("appointment_assigned", (msg) => console.log(msg));
socket.on("appointment_delayed", (msg) => console.log(msg));
socket.on("appointment_assigned", (msg) => console.log(msg));
socket.on("appointment_assigned_staff", (msg) => console.log(msg));
socket.on("attendance_request",(msg)=>console.log(msg));
socket.on("new-notification",(msg)=>console.log(msg));
socket.on("disconnect", () => {
  console.log("❌ Socket disconnected");
});
