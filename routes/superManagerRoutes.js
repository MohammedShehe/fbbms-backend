const express = require("express");
const router = express.Router();
const verify = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const superManager = require("../controllers/superManagerController");
const records = require("../controllers/superManagerRecordsController");
const inventory = require("../controllers/inventoryController");

// Auth routes
router.post("/send-otp", superManager.sendLoginOTP);
router.post("/verify-otp", superManager.verifyOTPAndLogin);

// Profile routes
router.put("/profile", verify, role("super_manager"), superManager.updateProfile);

// Manager management routes
router.post("/manager/send-otp", verify, role("super_manager"), superManager.sendManagerOTP);
router.get("/managers", verify, role("super_manager"), superManager.getManagers);
router.put("/manager/:id", verify, role("super_manager"), superManager.updateManager);
router.delete("/manager/:id", verify, role("super_manager"), superManager.deleteManager);

// Records routes - Sports
router.get("/records/sports/today", verify, role("super_manager"), (req, res) => {
    req.query.division = 'sports';
    records.getTodayRecords(req, res);
});
router.get("/records/sports/weekly", verify, role("super_manager"), (req, res) => {
    req.query.division = 'sports';
    records.getWeeklyRecords(req, res);
});
router.get("/records/sports/monthly", verify, role("super_manager"), (req, res) => {
    req.query.division = 'sports';
    records.getMonthlyRecords(req, res);
});
router.get("/records/sports/yearly", verify, role("super_manager"), (req, res) => {
    req.query.division = 'sports';
    records.getYearlyRecords(req, res);
});

// Records routes - Scents
router.get("/records/scents/today", verify, role("super_manager"), (req, res) => {
    req.query.division = 'scents';
    records.getTodayRecords(req, res);
});
router.get("/records/scents/weekly", verify, role("super_manager"), (req, res) => {
    req.query.division = 'scents';
    records.getWeeklyRecords(req, res);
});
router.get("/records/scents/monthly", verify, role("super_manager"), (req, res) => {
    req.query.division = 'scents';
    records.getMonthlyRecords(req, res);
});
router.get("/records/scents/yearly", verify, role("super_manager"), (req, res) => {
    req.query.division = 'scents';
    records.getYearlyRecords(req, res);
});

// Graph routes
router.get("/graph/weekly-overview", verify, role("super_manager"), (req, res) => {
    records.getWeeklyOverview(req, res);
});
router.get("/graph/day-trend", verify, role("super_manager"), (req, res) => {
    records.getDayTrend(req, res);
});

// Inventory routes
router.post("/inventory/add", verify, role("super_manager"), inventory.addInventory);
router.get("/inventory", verify, role("super_manager"), inventory.getInventory);
router.get("/inventory/stats", verify, role("super_manager"), inventory.getInventoryStats);

module.exports = router;