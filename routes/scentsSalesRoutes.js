const express = require("express");
const router = express.Router();
const verify = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const sales = require("../controllers/scentsSalesController");

// Add sale
router.post("/add", verify, role("scents_manager"), sales.addSale);

// Get all sales with filters
router.get("/", verify, role("scents_manager"), sales.getSales);

// Get statistics
router.get("/stats", verify, role("scents_manager"), sales.getStats);

// Get monthly summary
router.get("/monthly", verify, role("scents_manager"), sales.getMonthlySummary);

// Get single sale
router.get("/:id", verify, role("scents_manager"), sales.getSaleById);

// Update sale
router.put("/:id", verify, role("scents_manager"), sales.updateSale);

// Delete sale
router.delete("/:id", verify, role("scents_manager"), sales.deleteSale);

module.exports = router;