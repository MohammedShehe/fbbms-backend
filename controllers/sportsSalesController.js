const db = require("../config/db");
const Sales = require("../models/sportsSalesModel");

// Get all sales with filters, sorting, and search
exports.getSales = (req, res) => {
    const { 
        search, 
        category, 
        sort, 
        month,
        year 
    } = req.query;

    let sql = `
        SELECT 
            ss.*,
            u.email as created_by_email
        FROM sports_sales ss
        JOIN users u ON ss.created_by = u.id
        WHERE 1=1
    `;
    
    const params = [];

    // Search by customer name or item name
    if (search) {
        sql += ` AND (ss.customer_name LIKE ? OR ss.item_name LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
    }

    // Filter by category
    if (category) {
        sql += ` AND ss.category = ?`;
        params.push(category);
    }

    // Filter by month and year
    if (month && year) {
        sql += ` AND MONTH(ss.sale_date) = ? AND YEAR(ss.sale_date) = ?`;
        params.push(month, year);
    }

    // Sorting
    switch(sort) {
        case 'newest':
            sql += ` ORDER BY ss.sale_date DESC, ss.created_at DESC`;
            break;
        case 'oldest':
            sql += ` ORDER BY ss.sale_date ASC, ss.created_at ASC`;
            break;
        case 'highest':
            sql += ` ORDER BY ss.total_price DESC`;
            break;
        case 'lowest':
            sql += ` ORDER BY ss.total_price ASC`;
            break;
        default:
            sql += ` ORDER BY ss.created_at DESC`;
    }

    db.query(sql, params, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
};

// Get sales statistics
exports.getStats = (req, res) => {
    const { month, year } = req.query;

    let sql = `
        SELECT 
            COUNT(*) as total_records,
            SUM(total_price) as total_income,
            AVG(total_price) as avg_sale_value
        FROM sports_sales
        WHERE 1=1
    `;

    const params = [];

    if (month && year) {
        sql += ` AND MONTH(sale_date) = ? AND YEAR(sale_date) = ?`;
        params.push(month, year);
    }

    db.query(sql, params, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results[0]);
    });
};

// Get monthly summary
exports.getMonthlySummary = (req, res) => {
    const { year } = req.query;

    let sql = `
        SELECT 
            MONTH(sale_date) as month,
            YEAR(sale_date) as year,
            COUNT(*) as total_records,
            SUM(total_price) as monthly_income
        FROM sports_sales
    `;

    const params = [];

    if (year) {
        sql += ` WHERE YEAR(sale_date) = ?`;
        params.push(year);
    }

    sql += ` GROUP BY YEAR(sale_date), MONTH(sale_date)
             ORDER BY YEAR(sale_date) DESC, MONTH(sale_date) DESC`;

    db.query(sql, params, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
};

// Get single sale by ID
exports.getSaleById = (req, res) => {
    const { id } = req.params;

    const sql = `
        SELECT 
            ss.*,
            u.email as created_by_email
        FROM sports_sales ss
        JOIN users u ON ss.created_by = u.id
        WHERE ss.id = ?
    `;

    db.query(sql, [id], (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (results.length === 0) {
            return res.status(404).json({ message: "Sale not found" });
        }
        res.json(results[0]);
    });
};

// Update sale
exports.updateSale = (req, res) => {
    const { id } = req.params;
    const {
        sale_date,
        customer_name,
        item_name,
        category,
        quantity,
        unit_price,
        notes
    } = req.body;

    if (
        !sale_date ||
        !customer_name ||
        !item_name ||
        !category ||
        !quantity ||
        !unit_price
    ) {
        return res.status(400).json({
            message: "Please fill all required fields"
        });
    }

    const total_price = quantity * unit_price;

    const sql = `
        UPDATE sports_sales 
        SET 
            sale_date = ?,
            customer_name = ?,
            item_name = ?,
            category = ?,
            quantity = ?,
            unit_price = ?,
            total_price = ?,
            notes = ?
        WHERE id = ? AND created_by = ?
    `;

    const values = [
        sale_date,
        customer_name,
        item_name,
        category,
        quantity,
        unit_price,
        total_price,
        notes || "",
        id,
        req.user.id
    ];

    db.query(sql, values, (err, result) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ 
                message: "Sale not found or you don't have permission to edit" 
            });
        }
        res.json({
            message: "Sale Updated Successfully",
            total_price
        });
    });
};

// Delete sale
exports.deleteSale = (req, res) => {
    const { id } = req.params;

    const sql = `DELETE FROM sports_sales WHERE id = ? AND created_by = ?`;

    db.query(sql, [id, req.user.id], (err, result) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (result.affectedRows === 0) {
            return res.status(404).json({ 
                message: "Sale not found or you don't have permission to delete" 
            });
        }
        res.json({
            message: "Sale Deleted Successfully"
        });
    });
};

// Add sale (existing code)
exports.addSale = (req, res) => {
    const {
        sale_date,
        customer_name,
        item_name,
        category,
        quantity,
        unit_price,
        notes
    } = req.body;

    if (
        !sale_date ||
        !customer_name ||
        !item_name ||
        !category ||
        !quantity ||
        !unit_price
    ) {
        return res.status(400).json({
            message: "Please fill all required fields"
        });
    }

    const total_price = quantity * unit_price;

    const sale = [
        sale_date,
        customer_name,
        item_name,
        category,
        quantity,
        unit_price,
        total_price,
        notes || "",
        req.user.id
    ];

    Sales.createSale(sale, (err, result) => {
        if (err) {
            return res.status(500).json(err);
        }
        res.status(201).json({
            message: "Sale Added Successfully",
            saleId: result.insertId,
            total_price
        });
    });
};