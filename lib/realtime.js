// Server-Sent Events hub: pushes live events to every signed-in admin of a business.
const clients = new Map(); // businessId -> Set<res>

function add(bizId, res) {
  if (!clients.has(bizId)) clients.set(bizId, new Set());
  clients.get(bizId).add(res);
  res.on('close', () => { const s = clients.get(bizId); if (s) { s.delete(res); if (!s.size) clients.delete(bizId); } });
}

function broadcast(bizId, event, data = {}) {
  const set = clients.get(bizId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify({ ...data, at: new Date().toISOString() })}\n\n`;
  for (const res of set) { try { res.write(payload); } catch (_) {} }
}

setInterval(() => { for (const set of clients.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch (_) {} } }, 25000).unref();

/** Ends every live stream of a business (used after the business is deleted). */
function drop(bizId) { const set = clients.get(bizId); if (!set) return; for (const res of set) { try { res.write('event: gone\ndata: {}\n\n'); res.end(); } catch (_) {} } clients.delete(bizId); }

module.exports = { add, broadcast, drop };
