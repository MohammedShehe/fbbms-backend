const db = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { sendOTP } = require("../config/email");

// Store OTPs temporarily (in production, use Redis or database)
const otpStore = {};

// Generate OTP
const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// Step 1: Send OTP for login (Validate Email + Password)
exports.sendLoginOTP = (req, res) => {
    const { email, password } = req.body;

    // Validate email
    if (email !== 'manager@fourbrothers.online') {
        return res.status(401).json({ message: "Invalid email" });
    }

    // Get user from database
    db.query("SELECT * FROM users WHERE email = ?", [email], (err, results) => {
        if (err || results.length === 0) {
            return res.status(401).json({ message: "User not found" });
        }

        const user = results[0];

        // Step 1: Verify password
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (err || !isMatch) {
                return res.status(401).json({ message: "Invalid password" });
            }

            // Password is correct, send OTP
            const otp = generateOTP();
            otpStore[email] = { otp, expires: Date.now() + 600000 }; // 10 minutes

            sendOTP(email, otp)
                .then(() => {
                    res.json({ 
                        message: "OTP sent to your email", 
                        email 
                    });
                })
                .catch(err => {
                    console.error('Email error:', err);
                    res.status(500).json({ message: "Failed to send OTP" });
                });
        });
    });
};

// Step 2: Verify OTP and login
exports.verifyOTPAndLogin = (req, res) => {
    const { email, otp } = req.body;

    const stored = otpStore[email];
    if (!stored || stored.otp !== otp || Date.now() > stored.expires) {
        return res.status(401).json({ message: "Invalid or expired OTP" });
    }

    // Clear OTP
    delete otpStore[email];

    // Get user from database
    db.query("SELECT * FROM users WHERE email = ?", [email], (err, results) => {
        if (err || results.length === 0) {
            return res.status(401).json({ message: "User not found" });
        }

        const user = results[0];
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: "8h" }
        );

        res.json({
            token,
            email: user.email,
            role: user.role
        });
    });
};

// Update super manager profile
exports.updateProfile = (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const userId = req.user.id;

    if (newPassword !== confirmPassword) {
        return res.status(400).json({ message: "Passwords do not match" });
    }

    // Get current user
    db.query("SELECT * FROM users WHERE id = ?", [userId], (err, results) => {
        if (err || results.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        const user = results[0];

        // Verify current password
        bcrypt.compare(currentPassword, user.password, (err, isMatch) => {
            if (err || !isMatch) {
                return res.status(401).json({ message: "Current password is incorrect" });
            }

            // Hash new password
            bcrypt.hash(newPassword, 10, (err, hashedPassword) => {
                if (err) {
                    return res.status(500).json({ message: "Error hashing password" });
                }

                // Update password
                db.query(
                    "UPDATE users SET password = ? WHERE id = ?",
                    [hashedPassword, userId],
                    (err, result) => {
                        if (err) {
                            return res.status(500).json({ message: "Error updating password" });
                        }
                        res.json({ message: "Password updated successfully" });
                    }
                );
            });
        });
    });
};

// Send OTP for manager operations
exports.sendManagerOTP = (req, res) => {
    const { email } = req.body;
    const superManagerEmail = req.user.email;

    const otp = generateOTP();
    otpStore[`${superManagerEmail}_manager_op`] = { otp, expires: Date.now() + 600000 };

    sendOTP(superManagerEmail, otp)
        .then(() => {
            res.json({ message: "OTP sent to your email" });
        })
        .catch(err => {
            console.error('Email error:', err);
            res.status(500).json({ message: "Failed to send OTP" });
        });
};

// Get all managers
exports.getManagers = (req, res) => {
    db.query(
        "SELECT id, email, role, created_at FROM users WHERE role IN ('sports_manager', 'scents_manager') ORDER BY role, email",
        (err, results) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json(results);
        }
    );
};

// Update manager
exports.updateManager = (req, res) => {
    const { id } = req.params;
    const { email, newPassword, otp } = req.body;
    const superManagerEmail = req.user.email;

    // Verify OTP
    const stored = otpStore[`${superManagerEmail}_manager_op`];
    if (!stored || stored.otp !== otp || Date.now() > stored.expires) {
        return res.status(401).json({ message: "Invalid or expired OTP" });
    }

    // Clear OTP
    delete otpStore[`${superManagerEmail}_manager_op`];

    // Check if user exists and is a manager
    db.query(
        "SELECT * FROM users WHERE id = ? AND role IN ('sports_manager', 'scents_manager')",
        [id],
        (err, results) => {
            if (err || results.length === 0) {
                return res.status(404).json({ message: "Manager not found" });
            }

            let updates = [];
            let values = [];

            if (email) {
                // Check if email already exists
                db.query("SELECT * FROM users WHERE email = ? AND id != ?", [email, id], (err, exists) => {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    if (exists.length > 0) {
                        return res.status(400).json({ message: "Email already exists" });
                    }
                    proceedWithUpdate();
                });
            } else {
                proceedWithUpdate();
            }

            function proceedWithUpdate() {
                if (email) {
                    updates.push("email = ?");
                    values.push(email);
                }

                if (newPassword) {
                    bcrypt.hash(newPassword, 10, (err, hashedPassword) => {
                        if (err) {
                            return res.status(500).json({ message: "Error hashing password" });
                        }
                        updates.push("password = ?");
                        values.push(hashedPassword);
                        finishUpdate();
                    });
                } else {
                    finishUpdate();
                }
            }

            function finishUpdate() {
                if (updates.length === 0) {
                    return res.status(400).json({ message: "No updates provided" });
                }

                values.push(id);
                const sql = `UPDATE users SET ${updates.join(", ")} WHERE id = ?`;

                db.query(sql, values, (err, result) => {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }
                    res.json({ message: "Manager updated successfully" });
                });
            }
        }
    );
};

// Delete manager
exports.deleteManager = (req, res) => {
    const { id } = req.params;
    const { otp } = req.body;
    const superManagerEmail = req.user.email;

    // Verify OTP
    const stored = otpStore[`${superManagerEmail}_manager_op`];
    if (!stored || stored.otp !== otp || Date.now() > stored.expires) {
        return res.status(401).json({ message: "Invalid or expired OTP" });
    }

    // Clear OTP
    delete otpStore[`${superManagerEmail}_manager_op`];

    db.query(
        "DELETE FROM users WHERE id = ? AND role IN ('sports_manager', 'scents_manager')",
        [id],
        (err, result) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            if (result.affectedRows === 0) {
                return res.status(404).json({ message: "Manager not found" });
            }
            res.json({ message: "Manager deleted successfully" });
        }
    );
};