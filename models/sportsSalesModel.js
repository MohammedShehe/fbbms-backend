const db = require("../config/db");

exports.createSale = (sale, callback)=>{

    const sql = `

    INSERT INTO sports_sales

    (

    sale_date,

    customer_name,

    item_name,

    category,

    quantity,

    unit_price,

    total_price,

    notes,

    created_by

    )

    VALUES(?,?,?,?,?,?,?,?,?)

    `;

    db.query(sql,sale,callback);

}