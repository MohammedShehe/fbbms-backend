const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");

exports.login = (req,res)=>{

    const {email,password}=req.body;

    User.getUserByEmail(email,(err,result)=>{

        if(err){

            return res.status(500).json(err);

        }

        if(result.length==0){

            return res.status(401).json({

                message:"Invalid Email"

            });

        }

        const user=result[0];

        bcrypt.compare(

            password,

            user.password,

            (err,isMatch)=>{

                if(!isMatch){

                    return res.status(401).json({

                        message:"Invalid Password"

                    });

                }

                const token=jwt.sign({

                    id:user.id,

                    email:user.email,

                    role:user.role

                },

                process.env.JWT_SECRET,

                {

                    expiresIn:"8h"

                });

                res.json({

                    token,

                    email:user.email,

                    role:user.role

                });

            }

        );

    });

};