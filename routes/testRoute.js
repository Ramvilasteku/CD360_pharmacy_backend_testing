const express = require("express");
const router = express.Router();

router.post("/notify-test", async (req, res) => {
  try {
    const { sender_id, receiver_id, message } = req.body;

    if (!sender_id || !receiver_id || !message) {
      return res.status(400).json({ message: "sender_id, receiver_id, message are required" });
    }

    // 🔥 Send message via WebSocket
    global.io.to(receiver_id.toString()).emit("notification", {
      from: sender_id,
      msg: message,
      time: new Date()
    });

    return res.json({ message: "Notification sent successfully!" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

module.exports = router;
