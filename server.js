require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use('/api/v1', require('./routes/v1')); // public API: own CORS rules (per-key allowed origins)
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, cb) => (!origin || !allowed.length || allowed.includes(origin)) ? cb(null, true) : cb(new Error('Origin not allowed')),
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Business-Id'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
// Snippe payment webhook needs the RAW body (signature check), so it is mounted before the JSON parser.
app.post('/api/billing/webhook/snippe', express.raw({ type: '*/*', limit: '256kb' }), require('./routes/billingWebhook'));
app.use(express.json({ limit: '3.5mb' }));

const { q: dbq } = require('./config/db');
// Self-heal: the personal-language column is added automatically if `npm run migrate` was not run yet.
dbq('SELECT language FROM users LIMIT 1').catch(e => { if (e && e.code === 'ER_BAD_FIELD_ERROR') dbq('ALTER TABLE users ADD COLUMN language VARCHAR(5) NULL').then(() => console.log('Added users.language column')).catch(err => console.error('Could not add users.language:', err.message)); });
// Self-heal: billing tables/columns are created automatically (idempotent), so the update works even before `npm run migrate`.
require('./lib/billing').config().then(c => require('./lib/billing-schema').ensure((s, p) => dbq(s, p), (s, p) => dbq(s, p), c.trial_days))
  .then(() => console.log('Billing tables ready'))
  .catch(e => console.error('Could not prepare billing tables (run `npm run migrate`):', e.message));
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/developer', require('./routes/developer'));
app.use('/api/developer', require('./routes/developer2'));
app.use('/api/developer', require('./routes/developerBilling'));
app.use('/api/group', require('./routes/group'));
app.use('/api/public', require('./routes/public'));
app.use('/api/b', require('./routes/business'));
app.get('/api/platform/theme', (req, res, next) => { req.url = '/theme'; require('./routes/auth')(req, res, next); });

app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line
  const status = err.status || 500;
  if (status >= 500 && status !== 503) { console.error(err); require('./lib/errors').record(req, err); }
  res.status(status).json({ message: status >= 500 && status !== 503 ? 'Something went wrong on the server' : err.message, ...(err.apiCode ? { code: err.apiCode } : {}), ...(err.extra ? { detail: err.extra } : {}) });
});

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) console.warn('⚠️  Set a long random JWT_SECRET in .env');
if (String(process.env.OTP_ENABLED).toLowerCase() !== 'false' && !require('./config/mailer').configured()) console.warn('⚠️  SMTP_HOST/SMTP_USER/SMTP_PASS not set: email OTP is skipped (password-only sign-in).');
if (!require('./lib/billing').configured()) console.warn('⚠️  SNIPPE_API_KEY is not set: businesses cannot pay online yet (trials still work).');
if (!require('./lib/cloudinary').configured()) console.warn('⚠️  Cloudinary is not configured: product photo uploads will be refused.');

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => { console.log(`FBBMS API running on :${PORT}`); require('./lib/scheduler').start(); require('./lib/billing').start(); });
