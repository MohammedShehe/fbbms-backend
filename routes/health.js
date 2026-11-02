// Business Health Monitor + forecast (module: health).
const router = require('express').Router();
const { requireModule, canAny } = require('../middleware/auth');
const { wrap } = require('../lib/util');
const { computeHealth, forecast } = require('../lib/health');

const gate = [requireModule('health'), canAny('health.view', 'reports.view')];
router.get('/health', gate, wrap(async (req, res) => res.json(await computeHealth(req.biz))));
router.get('/forecast', gate, wrap(async (req, res) => res.json(await forecast(req.biz))));
module.exports = router;
