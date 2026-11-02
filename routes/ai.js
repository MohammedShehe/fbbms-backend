// AI business assistant endpoints (module: ai). Platform settings and the API key are controlled by the Developer.
const router = require('express').Router();
const { q, one } = require('../config/db');
const { requireModule, canAny } = require('../middleware/auth');
const { wrap, bad, tooMany, clip, HttpError } = require('../lib/util');
const ai = require('../lib/ai');

const gate = [requireModule('ai'), canAny('ai.use')];
const recent = new Map(); // userId -> timestamps

async function run(req, messages, kind, question) {
  const cfg = await ai.config();
  if (!cfg.usable) throw new HttpError(503, 'The AI assistant is not available right now. Ask the platform Developer to configure it.');
  const t = Date.now(); const arr = (recent.get(req.user.id) || []).filter(x => t - x < 60000);
  if (arr.length >= cfg.per_user_per_minute) throw tooMany('You are asking too fast. Wait a moment and try again.');
  const today = await one("SELECT COUNT(*) AS n FROM ai_usage WHERE business_id=? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR) AND status='ok'", [req.biz.id]);
  if (today.n >= cfg.daily_limit_per_business) throw tooMany('This business reached its daily AI limit. Try again tomorrow.');
  arr.push(t); recent.set(req.user.id, arr);
  const ctx = { biz: req.biz, isSuper: req.member.role === 'super_admin', perms: req.member.permissions, user: req.user };
  try {
    const r = await ai.chat(ctx, messages, cfg);
    await q("INSERT INTO ai_usage (business_id,user_id,kind,model,question,prompt_tokens,completion_tokens,tool_calls,latency_ms,status) VALUES (?,?,?,?,?,?,?,?,?,'ok')", [req.biz.id, req.user.id, kind, cfg.model, clip(question, 300), r.usage.prompt_tokens, r.usage.completion_tokens, r.tool_calls.length, r.ms]);
    return { answer: r.answer, tools_used: [...new Set(r.tool_calls.map(c => c.name))] };
  } catch (e) {
    await q("INSERT INTO ai_usage (business_id,user_id,kind,model,question,status,error) VALUES (?,?,?,?,?,'error',?)", [req.biz.id, req.user.id, kind, cfg.model, clip(question, 300), clip(e.message, 300)]).catch(() => {});
    console.error('AI error:', e.message); throw new HttpError(e.status === 429 ? 429 : 502, e.status === 429 ? 'The AI service is busy. Try again in a moment.' : 'The AI assistant could not answer right now. Please try again.');
  }
}

router.get('/ai/status', requireModule('ai'), wrap(async (req, res) => { const c = await ai.config(); res.json({ available: c.usable, model: c.usable ? c.model : null }); }));
router.post('/ai/chat', gate, wrap(async (req, res) => {
  const msgs = Array.isArray(req.body.messages) ? req.body.messages.filter(m => m && typeof m.content === 'string') : []; if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw bad('Ask a question');
  res.json(await run(req, msgs, 'chat', msgs[msgs.length - 1].content));
}));
router.post('/ai/summary', gate, wrap(async (req, res) => {
  res.json(await run(req, [{ role: 'user', content: 'Check the business health, this week versus last week, stock and money owed. Give me a short briefing: what is going well, what needs attention, and the 3 most important actions for this week.' }], 'summary', 'Business briefing'));
}));
module.exports = router;
