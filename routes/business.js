// Everything a signed-in admin does inside one business. Tenant + permissions are enforced per route.
const router = require('express').Router();
const { authenticate, tenant } = require('../middleware/auth');
const rt = require('../lib/realtime');

router.use(authenticate, tenant);

// Live event stream (Server-Sent Events). EventSource can't send headers, so ?token=&b= are accepted.
router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders && res.flushHeaders();
  res.write('retry: 3000\nevent: hello\ndata: {}\n\n');
  rt.add(req.biz.id, res);
});

// Billing first: an unpaid business must always be able to open this page and pay.
router.use('/billing', require('./billing'));
// Read-only lock: when a business has not paid, every write (add / edit / delete) is refused. Viewing still works.
router.use(require('../lib/billing').gate);

router.use(require('./admin'));
router.use(require('./products'));
router.use(require('./sales'));
router.use(require('./orders'));
router.use(require('./insights'));
router.use(require('./suppliers'));
router.use(require('./customers'));
router.use(require('./refunds'));
router.use(require('./cash'));
router.use(require('./alerts'));
router.use(require('./finance'));
router.use(require('./health'));
router.use(require('./ai'));
router.use(require('./integrations'));
router.use(require('./barber'));
router.use(require('./rentals'));

module.exports = router;
