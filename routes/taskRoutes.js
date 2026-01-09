const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middlewares/authMiddleware");
const { allowRoles } = require("../middlewares/roleMiddleware");

router.get("/tasks",authMiddleware,allowRoles("admin", "staff"),(req, res) => {
    res.json({ message: "Tasks visible to Admin & Staff only" });
  }
);

module.exports = router;
