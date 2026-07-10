const Sales = require("../models/sportsSalesModel");

exports.addSale = (req,res)=>{

    const {

        sale_date,

        customer_name,

        item_name,

        category,

        quantity,

        unit_price,

        notes

    } = req.body;

    if(

        !sale_date ||

        !customer_name ||

        !item_name ||

        !category ||

        !quantity ||

        !unit_price

    ){

        return res.status(400).json({

            message:"Please fill all required fields"

        });

    }

    const total_price = quantity * unit_price;

    const sale=[

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

    Sales.createSale(

        sale,

        (err,result)=>{

            if(err){

                return res.status(500).json(err);

            }

            res.status(201).json({

                message:"Sale Added Successfully",

                saleId:result.insertId,

                total_price

            });

        }

    );

}