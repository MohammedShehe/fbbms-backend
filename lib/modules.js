// Feature modules. The Developer switches them on/off per business; Super Admins only see what is enabled for them.
const MODULES = [
  { key: 'suppliers',  label: 'Suppliers & purchase orders', desc: 'Supplier records, purchase orders, stock receiving, supplier balances', default: true },
  { key: 'customers',  label: 'Customers & loyalty (CRM)',    desc: 'Customer profiles, purchase history, credit balances, loyalty points, birthdays', default: true },
  { key: 'refunds',    label: 'Refunds & exchanges',          desc: 'Return goods against a sale, restock, refund money or exchange for other items', default: true },
  { key: 'cash',       label: 'Cash management',              desc: 'Open/close the till, cash in/out, daily reconciliation with variance', default: true },
  { key: 'finance',    label: 'Finance & tax reports',        desc: 'Income statement, cash flow, tax report, receivables and payables', default: true },
  { key: 'health',     label: 'Business Health Monitor',      desc: 'Health score, risk flags, recommendations and sales forecast', default: true },
  { key: 'alerts',     label: 'Alerts & daily summaries',     desc: 'In-app notifications, unusual activity alerts, daily/weekly summaries', default: true },
  { key: 'ai',         label: 'AI business assistant',        desc: 'Ask questions in plain language; answers come from your real data (needs AI configured by the Developer)', default: false },
  { key: 'public_api', label: 'Public API & webhooks',        desc: 'API keys so websites/apps can read the catalogue and send orders; webhooks', default: false }
];
const KEYS = MODULES.map(m => m.key);
const DEFAULTS = Object.fromEntries(MODULES.map(m => [m.key, m.default]));

const state = biz => { const set = (biz && biz.settings && biz.settings.modules) || {}; return Object.fromEntries(KEYS.map(k => [k, k in set ? !!set[k] : DEFAULTS[k]])); };
const enabled = (biz, key) => !!state(biz)[key];
const clean = input => { const o = {}; if (input && typeof input === 'object') KEYS.forEach(k => { if (k in input) o[k] = !!input[k]; }); return o; };

module.exports = { MODULES, KEYS, DEFAULTS, state, enabled, clean };
