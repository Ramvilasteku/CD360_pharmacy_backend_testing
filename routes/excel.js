// routes/excel.js

const express = require("express");
const router = express.Router();

const upload = require("../middlewares/upload");
const uploadExcel  = require("../controllers/excelController");

router.post(
    "/upload",
    upload.single("file"),
    uploadExcel.uploadMedicines
);

module.exports = router;