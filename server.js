require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, cb) => (!origin || !allowed.length || allowed.includes(origin)) ? cb(null, true) : cb(new Error('Origin not allowed')),
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Business-Id'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(express.json({ limit: '3.5mb' }));

require('./config/db');
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/developer', require('./routes/developer'));
app.use('/api/public', require('./routes/public'));
app.use('/api/b', require('./routes/business'));
app.get('/api/platform/theme', (req, res, next) => { req.url = '/theme'; require('./routes/auth')(req, res, next); });

app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ message: status >= 500 ? 'Something went wrong on the server' : err.message, ...(err.extra ? { detail: err.extra } : {}) });
});

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) console.warn('⚠️  Set a long random JWT_SECRET in .env');
if (String(process.env.OTP_ENABLED).toLowerCase() !== 'false' && !require('./config/mailer').configured()) console.warn('⚠️  SMTP_HOST/SMTP_USER/SMTP_PASS not set: email OTP is skipped (password-only sign-in).');
if (!require('./lib/cloudinary').configured()) console.warn('⚠️  Cloudinary is not configured: product photo uploads will be refused.');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`FBBMS API running on :${PORT}`));
