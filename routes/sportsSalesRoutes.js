const express = require("express");
const router = express.Router();
const verify = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const sales = require("../controllers/sportsSalesController");

// Add sale
router.post("/add", verify, role("sports_manager"), sales.addSale);

// Get all sales with filters
router.get("/", verify, role("sports_manager"), sales.getSales);

// Get statistics
router.get("/stats", verify, role("sports_manager"), sales.getStats);

// Get monthly summary
router.get("/monthly", verify, role("sports_manager"), sales.getMonthlySummary);

// Get single sale
router.get("/:id", verify, role("sports_manager"), sales.getSaleById);

// Update sale
router.put("/:id", verify, role("sports_manager"), sales.updateSale);

// Delete sale
router.delete("/:id", verify, role("sports_manager"), sales.deleteSale);

module.exports = router;