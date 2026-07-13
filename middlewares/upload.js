const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({
    destination: "uploads/",
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

module.exports = multer({
    storage,
    fileFilter: (req, file, cb) => {

        const ext = path.extname(file.originalname).toLowerCase();

        if ([".csv", ".xls", ".xlsx"].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error("Only CSV, XLS and XLSX files are allowed."));
        }
    }
});