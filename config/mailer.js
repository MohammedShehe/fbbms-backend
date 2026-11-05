const nodemailer = require('nodemailer');

// Zoho (or any SMTP) settings come from .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, optional SMTP_FROM / SMTP_SECURE
const configured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
let transporter;
function get() {
  if (!transporter) {
    const port = parseInt(process.env.SMTP_PORT, 10) || 587;
    const secure = process.env.SMTP_SECURE ? String(process.env.SMTP_SECURE).toLowerCase() === 'true' : port === 465; // 587 = STARTTLS
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure,
      requireTLS: !secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
    });
  }
  return transporter;
}

const OTP_TEXT = {
  en: { tag: 'Four Brothers Business Management System', hello: n => `Hello ${n},`, use: 'Use this code to finish signing in:', valid: "Valid for 10 minutes. If this wasn't you, change your password immediately.", subject: c => `${c} is your FBBMS sign-in code`, plain: c => `Your FBBMS sign-in code is ${c}. It is valid for 10 minutes.` },
  sw: { tag: 'Mfumo wa Usimamizi wa Biashara wa Four Brothers', hello: n => `Habari ${n},`, use: 'Tumia msimbo huu kukamilisha kuingia:', valid: 'Unatumika kwa dakika 10. Kama si wewe, badilisha nenosiri lako mara moja.', subject: c => `${c} ni msimbo wako wa kuingia FBBMS`, plain: c => `Msimbo wako wa kuingia FBBMS ni ${c}. Unatumika kwa dakika 10.` }
};

async function sendOTP(email, name, code, lang = 'en') {
  const L = OTP_TEXT[lang] || OTP_TEXT.en;
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;background:#0e0e10;color:#f4efe3;border-radius:16px;padding:28px;border:1px solid #2a2418">
    <h2 style="margin:0 0 4px;color:#d4af55;letter-spacing:.5px">FBBMS</h2>
    <p style="margin:0 0 20px;color:#a89f86;font-size:13px">${L.tag}</p>
    <p>${L.hello(String(name).replace(/[<>]/g, ''))}</p>
    <p>${L.use}</p>
    <div style="font-size:34px;font-weight:700;letter-spacing:10px;text-align:center;background:#17150f;border:1px dashed #d4af55;border-radius:12px;padding:16px;color:#d4af55">${code}</div>
    <p style="color:#a89f86;font-size:12px;margin-top:18px">${L.valid}</p>
  </div>`;
  // Zoho only accepts a From address that belongs to the authenticated account
  const from = process.env.SMTP_FROM || `"FBBMS" <${process.env.SMTP_USER}>`;
  return get().sendMail({ from, to: email, subject: L.subject(code), html, text: L.plain(code) });
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.SMTP_FROM || `"FBBMS" <${process.env.SMTP_USER}>`;
  return get().sendMail({ from, to, subject, text, html });
}

module.exports = { sendOTP, sendMail, configured };
