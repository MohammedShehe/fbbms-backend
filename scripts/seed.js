// First-run setup: the two businesses, the Developer and the founder (Super Admin of both shops).
// Passwords: set SEED_DEVELOPER_PASSWORD / SEED_FOUNDER_PASSWORD in .env, or leave blank to auto-generate (printed once).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { q, one, pool } = require('../config/db');
const { TEMPLATES } = require('../lib/templates');
const { genPassword } = require('../lib/util');

const FOUNDER = { name: 'Abdul-rahman Aminu Shehe', email: 'founder@zanlux.online', phone: '+255774040506' };
const DEV = { name: 'MO11', email: 'developer@fourbrothers.online' };
const created = [];

async function ensureUser(u, isDev, envKey) {
  let row = await one('SELECT * FROM users WHERE email=?', [u.email]);
  if (row) return row.id;
  const pw = process.env[envKey] || genPassword(14);
  const r = await q('INSERT INTO users (name,email,phone,password_hash,is_developer,must_change_password) VALUES (?,?,?,?,?,?)', [u.name, u.email, u.phone || null, await bcrypt.hash(pw, 11), isDev ? 1 : 0, process.env[envKey] ? 0 : 1]);
  created.push({ email: u.email, password: pw, generated: !process.env[envKey] });
  return r.insertId;
}

async function ensureBusiness(b) {
  const ex = await one('SELECT id FROM businesses WHERE slug=?', [b.slug]);
  if (ex) return ex.id;
  const t = TEMPLATES[b.template];
  const r = await q('INSERT INTO businesses (slug,code,name,short_name,template,tagline,currency,settings,theme) VALUES (?,?,?,?,?,?,?,?,?)',
    [b.slug, b.code, b.name, b.short_name, b.template, b.tagline, 'TZS', JSON.stringify({ ...t.settings, ...b.settings }), JSON.stringify({ ...t.theme, ...(b.theme || {}) })]);
  let i = 0; for (const c of t.categories) await q('INSERT INTO categories (business_id,name,sort_order) VALUES (?,?,?)', [r.insertId, c, i++]);
  return r.insertId;
}

(async () => {
  const zan = await ensureBusiness({
    slug: 'zanlux', code: 'ZL', name: 'ZanLux Scents', short_name: 'ZanLux', template: 'scents', tagline: 'The Essence Of Elegance',
    settings: {
      has_website: true, website_enabled: true,
      phone: '+255 774 040 506', whatsapp: '255774040506', email: 'support@zanlux.online',
      address: 'Mipango, mwisho wa lami', location: 'Dodoma, Tanzania',
      instagram: 'https://www.instagram.com/zanlux_scents?exln=MWIyc2FicG9ldm5ybQ==', website: 'zanlux.online',
      hero_title: 'The Essence Of Elegance', hero_subtitle: 'Luxury perfumes & fragrances, hand-picked for the way you want to be remembered.',
      about: 'ZanLux Scents is a luxury fragrance house based in Dodoma, Tanzania. We curate refined perfumes and fragrances so every customer can find a signature scent that feels like them.',
      founder: { name: 'Mr. Abdul-Rahman Shehe', title: 'Founder, ZanLux', origin: 'Zanzibari - Tanzanian', since: '1 November 2026', phone: '+255 774 040 506', portfolio: 'docman.fourbrothers.online', bio: 'A medical doctor by profession and a lover of fine fragrance, Mr. Abdul-Rahman Shehe founded ZanLux to bring elegant, authentic scents within reach of everyone in Tanzania.' }
    }
  });
  const fb = await ensureBusiness({
    slug: 'fbsc', code: 'FB', name: 'Four Brothers Sports Center', short_name: 'FBSC', template: 'sports', tagline: '#ChooseAnyBest',
    settings: {
      has_website: false, phone: '+255 774 040 506', whatsapp: '255774040506', email: 'support@zanlux.online', address: 'Mipango, mwisho wa lami', location: 'Dodoma, Tanzania',
      instagram: 'https://www.instagram.com/four_brothers_sports_center?dlrf=d20xYno3dmlwcnJ4', website: 'fourbrothers.online'
    }
  });
  const dev = await ensureUser(DEV, true, 'SEED_DEVELOPER_PASSWORD');
  const founder = await ensureUser(FOUNDER, false, 'SEED_FOUNDER_PASSWORD');
  for (const bid of [zan, fb]) await q("INSERT IGNORE INTO memberships (user_id,business_id,role,created_by) VALUES (?,?,'super_admin',?)", [founder, bid, dev]);
  await q("INSERT IGNORE INTO platform_settings (k,v) VALUES ('theme', ?)", [JSON.stringify({ name: 'FBBMS', primary: '#d4af55', accent: '#f1d98a', mode: 'dark' })]);

  console.log('\n✅ Seed complete: ZanLux + Four Brothers Sports Center, Developer and founder accounts are in place.');
  if (created.length) {
    console.log('\n🔑 Initial credentials (shown only once - sign in and change them):');
    created.forEach(c => console.log(`   ${c.email}   ${c.generated ? c.password : '(password from .env)'}`));
  } else console.log('   Accounts already existed - passwords unchanged.');
  await pool.end();
})().catch(e => { console.error('❌ Seed failed:', e.message); process.exit(1); });
