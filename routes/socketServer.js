// socketServer.js
const { Server } = require("socket.io");

function initializeSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: "*", // or your frontend URL
      methods: ["GET", "POST"],
    },
  });

  global.io = io; // make io globally accessible in routes

  // Map to keep track of connected users by userId
  const connectedUsers = {};

  io.on("connection", (socket) => {
    console.log("🔥 Socket connected:", socket.id);

    // Register user to their own room
    socket.on("register", ({ userId, role }) => {
      if (!userId) return;
      socket.join(userId.toString());
      connectedUsers[userId] = socket.id;

      console.log(`📌 ${role || "User"} registered -> ID: ${userId}`);
      console.log(`📍 Joined room: ${userId}`);
    });

    // Optional: handle appointment_created (server can emit using this)
    socket.on("appointment_created", ({ receiverId, payload }) => {
      if (!receiverId) return;
      io.to(receiverId.toString()).emit("appointment_created", payload);
    });

    // Optional: handle direct new-notification from client (if needed)
    socket.on("new-notification", ({ receiverId, payload }) => {
      if (!receiverId) return;
      io.to(receiverId.toString()).emit("new-notification", payload);
    });

    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected:", socket.id);
      // Remove from connectedUsers
      for (const [key, val] of Object.entries(connectedUsers)) {
        if (val === socket.id) delete connectedUsers[key];
      }
    });
  });

  // Attach connectedUsers map to io for routes to use
  io.connectedUsers = connectedUsers;

  return io;
}

module.exports = initializeSocket;
