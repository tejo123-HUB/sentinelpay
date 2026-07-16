const { test } = require('node:test');
const assert = require('node:assert/strict');

// Fresh module instance per test (rateLimit.js keeps in-process state in `hitsByIp`), so tests
// don't leak request counts into each other.
function freshRateLimit() {
  delete require.cache[require.resolve('../server/middleware/rateLimit')];
  return require('../server/middleware/rateLimit');
}

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

test('rateLimit: allows requests under the per-IP cap', () => {
  const rateLimit = freshRateLimit();
  const req = { ip: '10.0.0.1' };
  let nextCalled = 0;
  for (let i = 0; i < rateLimit.MAX_PER_WINDOW - 1; i += 1) {
    rateLimit(req, fakeRes(), () => {
      nextCalled += 1;
    });
  }
  assert.equal(nextCalled, rateLimit.MAX_PER_WINDOW - 1);
});

test('rateLimit: blocks with 429 once a single IP exceeds the cap within the window (regression)', () => {
  // Regression: nothing throttled POST /transaction at all before this — an unauthenticated (or,
  // post-auth-fix, even an authenticated) caller could flood it with no limit whatsoever.
  const rateLimit = freshRateLimit();
  const req = { ip: '10.0.0.2' };

  for (let i = 0; i < rateLimit.MAX_PER_WINDOW; i += 1) {
    rateLimit(req, fakeRes(), () => {});
  }

  const res = fakeRes();
  let nextCalled = false;
  rateLimit(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'next() must not be called once the cap is exceeded');
  assert.equal(res.statusCode, 429);
  assert.equal(typeof res.body.error, 'string');
});

test('rateLimit: tracks each IP independently', () => {
  const rateLimit = freshRateLimit();
  for (let i = 0; i < rateLimit.MAX_PER_WINDOW; i += 1) {
    rateLimit({ ip: '10.0.0.3' }, fakeRes(), () => {});
  }

  // A different IP must not be affected by 10.0.0.3 having exhausted its own cap.
  const res = fakeRes();
  let nextCalled = false;
  rateLimit({ ip: '10.0.0.4' }, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});
