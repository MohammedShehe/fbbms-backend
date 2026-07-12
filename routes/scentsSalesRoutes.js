const express = require("express");
const router = express.Router();
const verify = require("../middleware/authMiddleware");
const role = require("../middleware/roleMiddleware");
const sales = require("../controllers/scentsSalesController");
const inventory = require("../controllers/inventoryController");

// IMPORTANT: Inventory routes MUST be before /:id route
// Inventory routes for view only
router.get("/inventory", verify, role("scents_manager"), (req, res) => {
    if (!req.query.division) {
        req.query.division = 'scents';
    }
    inventory.getInventory(req, res);
});

router.get("/inventory/stats", verify, role("scents_manager"), (req, res) => {
    if (!req.query.division) {
        req.query.division = 'scents';
    }
    inventory.getInventoryStats(req, res);
});

// Add sale
router.post("/add", verify, role("scents_manager"), sales.addSale);

// Get all sales with filters
router.get("/", verify, role("scents_manager"), sales.getSales);

// Get statistics
router.get("/stats", verify, role("scents_manager"), sales.getStats);

// Get monthly summary
router.get("/monthly", verify, role("scents_manager"), sales.getMonthlySummary);

// Get single sale - MUST BE LAST
router.get("/:id", verify, role("scents_manager"), sales.getSaleById);

// Update sale
router.put("/:id", verify, role("scents_manager"), sales.updateSale);

// Delete sale
router.delete("/:id", verify, role("scents_manager"), sales.deleteSale);

module.exports = router;