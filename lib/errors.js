// Remembers the last server errors so the Developer can see them without reading log files.
const ring = [];
const started = Date.now();
const stats = { requests5xx: 0 };
function record(req, err) { stats.requests5xx++; ring.unshift({ at: new Date().toISOString(), method: req.method, path: (req.originalUrl || '').split('?')[0].slice(0, 120), message: String(err && err.message || err).slice(0, 300) }); if (ring.length > 80) ring.pop(); }
module.exports = { record, recent: () => ring.slice(), stats, started };
