const db = require("../config/db");

// Add inventory stock
exports.addInventory = (req, res) => {
    const { division, category, quantity, unit } = req.body;
    
    if (!division || !category || !quantity || !unit) {
        return res.status(400).json({ message: "All fields are required" });
    }
    
    const table = division === 'sports' ? 'sports_inventory' : 'scents_inventory';
    
    // Check if category exists
    db.query(
        `SELECT * FROM ${table} WHERE category = ?`,
        [category],
        (err, results) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            if (results.length > 0) {
                // Update existing
                const currentStock = results[0].stock_quantity;
                const newStock = parseFloat(currentStock) + parseFloat(quantity);
                
                db.query(
                    `UPDATE ${table} SET stock_quantity = ?, unit = ?, last_updated = NOW() WHERE category = ?`,
                    [newStock, unit, category],
                    (err, result) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        res.json({ 
                            message: "Inventory updated successfully",
                            newStock: newStock
                        });
                    }
                );
            } else {
                // Insert new
                db.query(
                    `INSERT INTO ${table} (category, stock_quantity, unit) VALUES (?, ?, ?)`,
                    [category, quantity, unit],
                    (err, result) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }
                        res.json({ 
                            message: "Inventory added successfully",
                            stock: quantity
                        });
                    }
                );
            }
        }
    );
};

// Get all inventory categories
exports.getInventory = (req, res) => {
    const { division } = req.query;
    const table = division === 'sports' ? 'sports_inventory' : 'scents_inventory';
    
    db.query(
        `SELECT * FROM ${table} ORDER BY category`,
        (err, results) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json(results);
        }
    );
};

// Get inventory stats
exports.getInventoryStats = (req, res) => {
    const { division } = req.query;
    const table = division === 'sports' ? 'sports_inventory' : 'scents_inventory';
    
    db.query(
        `SELECT 
            COUNT(*) as categories_tracked,
            SUM(stock_quantity) as units_in_stock,
            SUM(CASE WHEN stock_quantity < 10 THEN 1 ELSE 0 END) as needs_attention
        FROM ${table}`,
        (err, results) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json(results[0]);
        }
    );
};