const express=require("express");

const router=express.Router();

const verify=require("../middleware/authMiddleware");

const role=require("../middleware/roleMiddleware");

const sales=require("../controllers/sportsSalesController");

router.post(

"/add",

verify,

role("sports_manager"),

sales.addSale

);

module.exports=router;