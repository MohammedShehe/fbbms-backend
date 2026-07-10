const express=require("express");

const router=express.Router();

const auth=require("../controllers/authController");

const verify=require("../middleware/authMiddleware");

router.post("/login",auth.login);

router.get("/profile",verify,(req,res)=>{

    res.json({

        email:req.user.email,

        role:req.user.role

    });

});

module.exports=router;