// Generates realistic demo traffic against a running SentinelPay server: a continuous stream
// of normal micro-transactions, plus on-demand scripted scenarios for a single-transaction
// fraud block and a full structuring/layering pattern (architecture.md Section 10, Task 4).
//
// Usage:
//   node simulator/simulate_transactions.js --scenario=normal --count=100 --rate=150
//   node simulator/simulate_transactions.js --scenario=fraud
//   node simulator/simulate_transactions.js --scenario=structuring
//   node simulator/simulate_transactions.js --scenario=odd-hour
//   node simulator/simulate_transactions.js --scenario=all
//   node simulator/simulate_transactions.js --scenario=normal --continuous   (Ctrl+C to stop)

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const BASE_URL = process.env.SIMULATOR_BASE_URL || 'http://127.0.0.1:3000';

// A pool of synthetic "regular" users with stable homes/devices, so their behavioral
// baselines (avg_transaction_amount, typical_active_hours, known devices) build up naturally
// across the normal traffic stream rather than every transaction looking brand-new. Sized
// large enough (300) that even a fast stream (tens of ms between sends) keeps any single
// user's own transaction rate well under the velocity detector's threshold (5/60s) — a
// smaller pool made "normal" traffic look like bot-speed velocity abuse from a handful of
// accounts, which is a simulator realism bug, not a fraud-engine false positive.
const NORMAL_USER_POOL = Array.from({ length: 300 }, (_, i) => ({
  id: `u_sim_${i + 1}`,
  device: `d_sim_${i + 1}`,
  homeLat: 16.5062 + (Math.random() - 0.5) * 0.4,
  homeLng: 80.648 + (Math.random() - 0.5) * 0.4,
  typicalAmount: 50 + Math.random() * 300,
}));

function jitter(value, spread) {
  return value + (Math.random() * 2 - 1) * spread;
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseArgs(argv) {
  const args = { scenario: 'normal', count: 100, rate: 150, continuous: false, baseUrl: BASE_URL };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'scenario') args.scenario = value;
    else if (key === 'count') args.count = Number(value);
    else if (key === 'rate') args.rate = Number(value);
    else if (key === 'continuous') args.continuous = true;
    else if (key === 'base-url') args.baseUrl = value;
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postTransaction(baseUrl, transaction) {
  const res = await fetch(`${baseUrl}/transaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transaction),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function getAlerts(baseUrl, limit = 20) {
  const res = await fetch(`${baseUrl}/alerts?limit=${limit}`);
  return res.json();
}

function generateNormalTransaction() {
  const sender = NORMAL_USER_POOL[Math.floor(Math.random() * NORMAL_USER_POOL.length)];
  let receiver = NORMAL_USER_POOL[Math.floor(Math.random() * NORMAL_USER_POOL.length)];
  while (receiver.id === sender.id) {
    receiver = NORMAL_USER_POOL[Math.floor(Math.random() * NORMAL_USER_POOL.length)];
  }

  const amount = Math.max(10, jitter(sender.typicalAmount, sender.typicalAmount * 0.3));
  const type = Math.random() < 0.85 ? 'transfer' : Math.random() < 0.5 ? 'deposit' : 'withdrawal';

  return {
    sender_id: sender.id,
    receiver_id: receiver.id,
    amount: Math.round(amount * 100) / 100,
    timestamp: new Date().toISOString(),
    // Small jitter approximating real GPS noise for "still at home" (~tens of meters), not an
    // independent multi-km random jump every transaction — a sender picked twice in quick
    // succession (this pool is small and the stream is fast) must not look like impossible
    // travel just because the simulator re-rolled a wide-radius location each time.
    location: { lat: jitter(sender.homeLat, 0.0003), lng: jitter(sender.homeLng, 0.0003) },
    device_id: sender.device,
    merchant_id: randomId('m'),
    transaction_type: type,
  };
}

async function runNormalStream(baseUrl, count, rateMs, continuous) {
  console.log(`[normal] streaming ${continuous ? 'continuously' : count + ' transactions'} at ~${rateMs}ms intervals`);
  let sent = 0;
  // eslint-disable-next-line no-constant-condition
  while (continuous || sent < count) {
    const tx = generateNormalTransaction();
    const { status, body } = await postTransaction(baseUrl, tx);
    if (status === 201) {
      console.log(
        `[normal] ${tx.sender_id} -> ${tx.receiver_id} ₹${tx.amount} :: score=${body.fraud_score} decision=${body.decision}`
      );
    } else {
      console.error(`[normal] request failed (${status}):`, body);
    }
    sent += 1;
    await sleep(rateMs);
  }
  console.log(`[normal] done, sent ${sent} transactions`);
}

// Single-transaction fraud pattern: velocity + impossible travel + device mismatch, on a
// fresh account each run so repeat demo runs aren't affected by prior state.
async function triggerFraudScenario(baseUrl) {
  const sender = randomId('u_fraud');
  const receiver = randomId('u_fraud_target');
  const homeLat = 16.5062;
  const homeLng = 80.648;
  const device = randomId('d');

  console.log(`[fraud] scripted attack from ${sender}: rapid transactions + a 400km+ jump on a new device`);

  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await postTransaction(baseUrl, {
      sender_id: sender,
      receiver_id: receiver,
      amount: 100 + i * 10,
      timestamp: new Date().toISOString(),
      location: { lat: homeLat, lng: homeLng },
      device_id: device,
      transaction_type: 'transfer',
    });
    await sleep(300);
  }

  // Final transaction: new device, far-away location, seconds after the last one.
  const finalResult = await postTransaction(baseUrl, {
    sender_id: sender,
    receiver_id: receiver,
    amount: 150,
    timestamp: new Date().toISOString(),
    location: { lat: 28.6139, lng: 77.209 }, // Delhi, ~1200km from the home location, seconds later
    device_id: randomId('d_new'),
    transaction_type: 'transfer',
  });

  console.log('[fraud] final transaction result:', finalResult.body);
  if (finalResult.body && finalResult.body.decision === 'block') {
    console.log('[fraud] OK: scripted fraud pattern was blocked as expected');
  } else {
    console.warn('[fraud] WARNING: expected a block decision, got:', finalResult.body && finalResult.body.decision);
  }
  return finalResult;
}

// Full structuring pattern: 1 sender -> 6 small transfers -> 3 receivers, then 2 of those
// receivers rapidly withdraw >80% of what they received. Fresh account IDs every run so the
// structuring engine's re-alert cooldown never suppresses a legitimate new demo run.
async function triggerStructuringScenario(baseUrl) {
  const sender = randomId('u_struct');
  const receivers = [randomId('u_mule'), randomId('u_mule'), randomId('u_mule')];

  console.log(`[structuring] scripted pattern from ${sender} -> [${receivers.join(', ')}]`);

  // Real wall-clock timestamps at send time (not pre-computed future offsets) — the background
  // job compares transaction timestamps against its own real Date.now(), so backdating/future-
  // dating them here would push them outside (or ahead of) the window it actually scans.
  for (let i = 0; i < 6; i += 1) {
    const receiver = receivers[i % receivers.length];
    await postTransaction(baseUrl, {
      sender_id: sender,
      receiver_id: receiver,
      amount: 4000,
      timestamp: new Date().toISOString(),
      location: { lat: 16.5062, lng: 80.648 },
      device_id: randomId('d'),
      transaction_type: 'transfer',
    });
    await sleep(200);
  }
  console.log('[structuring] sent 6 transfers of ₹4,000 (₹24,000 total) split across 3 receivers');

  await postTransaction(baseUrl, {
    sender_id: receivers[0],
    receiver_id: randomId('u_cashout'),
    amount: 7000,
    timestamp: new Date().toISOString(),
    device_id: randomId('d'),
    transaction_type: 'withdrawal',
  });
  await sleep(200);
  await postTransaction(baseUrl, {
    sender_id: receivers[1],
    receiver_id: randomId('u_cashout'),
    amount: 6500,
    timestamp: new Date().toISOString(),
    device_id: randomId('d'),
    transaction_type: 'withdrawal',
  });
  console.log('[structuring] sent 2 rapid withdrawals (>80% of received funds) from 2 of the 3 receivers');

  console.log('[structuring] waiting for the background structuring job to pick this up...');
  const POLL_INTERVAL_MS = 2000;
  const MAX_WAIT_MS = 30000;
  const waited0 = Date.now();
  while (Date.now() - waited0 < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const alerts = await getAlerts(baseUrl);
    const match = alerts.find((a) => a.sender_id === sender);
    if (match) {
      console.log(`[structuring] OK: alert created after ${Date.now() - waited0}ms ->`, match.reason);
      return match;
    }
  }

  console.warn('[structuring] WARNING: no alert appeared within the wait window; check the background job interval');
  return null;
}

const ODD_HOUR_WINDOW_A = [1, 9]; // 01:00-09:00 UTC
const ODD_HOUR_WINDOW_B = [13, 21]; // 13:00-21:00 UTC

function resolveDbPath() {
  return process.env.DB_PATH || path.join(process.cwd(), 'sentinelpay.db');
}

// Picks a demo "typical active hours" window that provably excludes the current real hour, so
// the transaction sent below is guaranteed to land outside it regardless of when this is run.
function pickOddHourBaselineWindow(currentHourUtc) {
  const [startA, endA] = ODD_HOUR_WINDOW_A;
  const inWindowA = currentHourUtc >= startA && currentHourUtc < endA;
  return inWindowA ? ODD_HOUR_WINDOW_B : ODD_HOUR_WINDOW_A;
}

// Demonstrates the odd-hour rule live without weakening the timestamp-security fix
// (architecture.md Section 15.2, finding #1 / Section 15.4): POST /transaction always scores
// against server-received time, so a live demo can no longer fake "this account has days of
// daytime history, and it's now 3am" using a client-supplied timestamp within a few seconds —
// that's the security fix working as intended, not a limitation to route around via the API.
// Instead, this seeds a realistic-looking historical baseline directly into the demo database
// (bypassing the API entirely — the same way a real account's baseline would only exist after
// real accumulated usage, never something POST /transaction itself lets a caller assert), then
// sends exactly one transaction through the *real* API at genuine current time. The odd-hour
// check itself still runs unmodified against real server time; only how the account's
// pre-existing history came to exist is different from organic usage.
async function triggerOddHourScenario(baseUrl) {
  const dbPath = resolveDbPath();
  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    console.error(`[odd-hour] could not open the database at ${dbPath}:`, err.message);
    console.error('[odd-hour] make sure the server has been started at least once (npm start) so the schema exists.');
    throw err;
  }

  const sender = randomId('u_oddhour');
  const receiver = randomId('u_oddhour_target');
  const nowMs = Date.now();
  const currentHourUtc = new Date(nowMs).getUTCHours();
  const baselineWindow = pickOddHourBaselineWindow(currentHourUtc);
  const accountCreatedAt = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(); // pretend the account is a day old

  console.log(
    `[odd-hour] seeding ${sender} with a typical-active-hours baseline of ${baselineWindow[0]}:00-${baselineWindow[1]}:00 UTC ` +
      `(current hour is ${currentHourUtc}:00 UTC, deliberately excluded)`
  );

  try {
    db.prepare(
      'INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount, typical_active_hours) VALUES (?, ?, ?, ?)'
    ).run(sender, accountCreatedAt, 150, JSON.stringify([baselineWindow]));
    db.prepare('INSERT OR IGNORE INTO users (user_id, created_at, avg_transaction_amount) VALUES (?, ?, 0)').run(
      receiver,
      accountCreatedAt
    );
  } finally {
    db.close();
  }

  const result = await postTransaction(baseUrl, {
    sender_id: sender,
    receiver_id: receiver,
    amount: 150,
    timestamp: new Date().toISOString(), // shape-validated only; the server always scores against its own received time
    transaction_type: 'transfer',
  });

  console.log('[odd-hour] live transaction result:', result.body);
  const flaggedOddHour = Boolean(
    result.body && result.body.reasons && result.body.reasons.some((r) => /typical active hours/.test(r))
  );
  if (flaggedOddHour) {
    console.log("[odd-hour] OK: transaction was correctly flagged as outside the account's typical active hours");
    // odd_hour is deliberately the weakest single rule weight (see server/rules/oddHour.js) —
    // on its own it won't cross the step_up threshold, matching the design intent that no
    // single mild signal alone should challenge/block a user. The flag firing (above) is what
    // this scenario demonstrates, not a guaranteed decision tier.
    if (result.body && result.body.decision === 'allow') {
      console.log(
        "[odd-hour] note: decision is still 'allow' — a single odd-hour flag alone isn't enough to trigger step-up by design; see the reason above for the actual signal."
      );
    }
  } else {
    console.warn('[odd-hour] WARNING: expected an odd-hour flag but did not see one — check server logs');
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`SentinelPay simulator :: scenario=${args.scenario} baseUrl=${args.baseUrl}`);

  if (args.scenario === 'normal') {
    await runNormalStream(args.baseUrl, args.count, args.rate, args.continuous);
  } else if (args.scenario === 'fraud') {
    await triggerFraudScenario(args.baseUrl);
  } else if (args.scenario === 'structuring') {
    await triggerStructuringScenario(args.baseUrl);
  } else if (args.scenario === 'odd-hour') {
    await triggerOddHourScenario(args.baseUrl);
  } else if (args.scenario === 'all') {
    await runNormalStream(args.baseUrl, 20, args.rate, false);
    await triggerFraudScenario(args.baseUrl);
    await triggerStructuringScenario(args.baseUrl);
    await triggerOddHourScenario(args.baseUrl);
  } else {
    console.error(`Unknown scenario "${args.scenario}". Use normal | fraud | structuring | odd-hour | all.`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Simulator crashed:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  generateNormalTransaction,
  postTransaction,
  getAlerts,
  triggerFraudScenario,
  triggerStructuringScenario,
  triggerOddHourScenario,
  randomId,
};
