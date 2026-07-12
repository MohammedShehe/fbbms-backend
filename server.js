require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const app = express();

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

require("./config/db");

app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/sports/sales", require("./routes/sportsSalesRoutes"));
app.use("/api/scents/sales", require("./routes/scentsSalesRoutes"));
app.use("/api/super", require("./routes/superManagerRoutes")); // ADD THIS LINE

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
});