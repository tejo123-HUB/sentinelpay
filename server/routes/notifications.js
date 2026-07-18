// Section 16, Category 17: a manual trigger to verify notification configuration without
// waiting for a real Critical-severity transaction. admin-only -- this both reveals which
// channels are configured (a mild information-disclosure surface) and actually sends real
// outbound messages, so it's gated the same as other operationally-consequential admin actions.
const express = require('express');
const router = express.Router();

const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth');
const { dispatchCriticalAlert } = require('../notifications');

const MAX_MESSAGE_LENGTH = 1000;

// POST /notifications/test { message? } — sends a real test message to every configured
// channel and reports per-channel success/failure, so misconfiguration is visible immediately
// rather than silently discovered the next time a real Critical alert fires.
router.post('/notifications/test', requireApiKey, requireRole('admin'), async (req, res) => {
  const { message } = req.body || {};
  if (message !== undefined && (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH)) {
    return res.status(400).json({ error: `message must be at most ${MAX_MESSAGE_LENGTH} characters` });
  }

  const results = await dispatchCriticalAlert(message || '[SentinelPay] Test notification -- if you see this, your webhook/credentials are configured correctly.');
  res.json(results);
});

module.exports = router;
