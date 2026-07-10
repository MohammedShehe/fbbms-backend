require("dotenv").config();

const express=require("express");

const cors=require("cors");

const app=express();

app.use(cors());

app.use(express.json());

require("./config/db");

app.use("/api/auth",require("./routes/authRoutes"));
app.use("/api/sports/sales",require("./routes/sportsSalesRoutes"));


const PORT=process.env.PORT;

app.listen(PORT,()=>{

console.log(`Server running on ${PORT}`);

});