const db = require("../config/db");

// Get today's records
exports.getTodayRecords = (req, res) => {
    const { division } = req.query; // 'sports' or 'scents'
    const table = division === 'sports' ? 'sports_sales' : 'scents_sales';
    
    const sql = `
        SELECT 
            ss.*,
            u.email as created_by_email
        FROM ${table} ss
        JOIN users u ON ss.created_by = u.id
        WHERE DATE(ss.sale_date) = CURDATE()
        ORDER BY ss.created_at DESC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        // Calculate total income
        const totalIncome = results.reduce((sum, sale) => sum + parseFloat(sale.total_price), 0);
        
        res.json({
            records: results,
            totalIncome: totalIncome
        });
    });
};

// Get weekly records
exports.getWeeklyRecords = (req, res) => {
    const { division } = req.query;
    const table = division === 'sports' ? 'sports_sales' : 'scents_sales';
    
    const sql = `
        SELECT 
            DATE(sale_date) as date,
            DAYNAME(sale_date) as day_name,
            COUNT(*) as total_records,
            SUM(total_price) as daily_income
        FROM ${table}
        WHERE sale_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        GROUP BY DATE(sale_date)
        ORDER BY sale_date DESC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        // Calculate weekly total
        const weeklyTotal = results.reduce((sum, day) => sum + parseFloat(day.daily_income), 0);
        
        res.json({
            weeklyData: results,
            weeklyTotal: weeklyTotal
        });
    });
};

// Get monthly records
exports.getMonthlyRecords = (req, res) => {
    const { division, month, year } = req.query;
    const table = division === 'sports' ? 'sports_sales' : 'scents_sales';
    
    let sql = `
        SELECT 
            ss.*,
            u.email as created_by_email
        FROM ${table} ss
        JOIN users u ON ss.created_by = u.id
        WHERE MONTH(ss.sale_date) = ? AND YEAR(ss.sale_date) = ?
        ORDER BY ss.sale_date DESC, ss.created_at DESC
    `;

    db.query(sql, [month, year], (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        const totalIncome = results.reduce((sum, sale) => sum + parseFloat(sale.total_price), 0);
        
        res.json({
            records: results,
            totalIncome: totalIncome
        });
    });
};

// Get yearly records
exports.getYearlyRecords = (req, res) => {
    const { division, year } = req.query;
    const table = division === 'sports' ? 'sports_sales' : 'scents_sales';
    
    let sql = `
        SELECT 
            ss.*,
            u.email as created_by_email
        FROM ${table} ss
        JOIN users u ON ss.created_by = u.id
        WHERE YEAR(ss.sale_date) = ?
        ORDER BY ss.sale_date DESC, ss.created_at DESC
    `;

    db.query(sql, [year], (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        const totalIncome = results.reduce((sum, sale) => sum + parseFloat(sale.total_price), 0);
        
        res.json({
            records: results,
            totalIncome: totalIncome
        });
    });
};

// Get graphical data - weekly overview
exports.getWeeklyOverview = (req, res) => {
    const { division } = req.query;
    const table = division === 'sports' ? 'sports_sales' : 'scents_sales';
    
    const sql = `
        SELECT 
            DAYNAME(sale_date) as day,
            SUM(total_price) as total
        FROM ${table}
        WHERE sale_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        GROUP BY DAYNAME(sale_date)
        ORDER BY FIELD(DAYNAME(sale_date), 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday')
    `;

    db.query(sql, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
};

// Get day trend (last 8 occurrences)
exports.getDayTrend = (req, res) => {
    const { division, day } = req.query;
    const table = division === 'sports' ? 'sports_sales' : 'scents_sales';
    
    const sql = `
        SELECT 
            DATE(sale_date) as date,
            SUM(total_price) as total
        FROM ${table}
        WHERE DAYNAME(sale_date) = ?
        ORDER BY sale_date DESC
        LIMIT 8
    `;

    db.query(sql, [day], (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results.reverse());
    });
};