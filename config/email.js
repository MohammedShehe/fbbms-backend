const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

const sendOTP = (email, otp) => {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Your OTP for Four Brothers Business Management System',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
                <h2 style="color: #333; text-align: center;">Four Brothers BMS</h2>
                <div style="background: #f4f4f4; padding: 20px; border-radius: 5px; text-align: center;">
                    <h3 style="margin: 0; color: #555;">Your OTP Code</h3>
                    <div style="font-size: 32px; font-weight: bold; color: #2c3e50; margin: 20px 0; letter-spacing: 5px;">${otp}</div>
                    <p style="color: #666; font-size: 14px;">This OTP is valid for 10 minutes.</p>
                </div>
                <p style="color: #888; font-size: 12px; text-align: center; margin-top: 20px;">If you didn't request this, please ignore this email.</p>
            </div>
        `
    };

    return transporter.sendMail(mailOptions);
};

module.exports = { sendOTP };