// Bulk-seeds sentinelpay.db with a large batch of historical synthetic transactions, evenly
// distributed across the lookback window, across the same city hubs simulator/
// simulate_transactions.js uses for live traffic, and across a pool of synthetic users -- with
// historical fraud/structuring/amount-anomaly events sprinkled evenly across the whole window
// too, not clustered at "now". The point is that Live Monitor's scrollback, the Map, and the
// Audit Trail's 24h trend chart all look like an established payment network the instant the
// dashboard opens, instead of starting from zero and needing minutes of live traffic to fill in.
//
// Writes straight to the DB, bypassing the HTTP API. POST /transaction always scores against
// server-received time by design (architecture.md Section 15.2, a deliberate security fix) --
// there's no way to backdate a transaction's timestamp through the real API, on purpose. This
// script instead calls the same rules/structuring/ML/decision modules
// server/routes/transactions.js calls for a live request, just with a synthetic historical
// timestamp, so seeded data is scored exactly the way a live transaction would be, not faked.
// If that pipeline's shape ever changes, mirror the change here too.
//
// Not meant to run concurrently with a live server -- both would be writing to the same SQLite
// file at once. Run this before `npm start`/`npm run demo` (which does it for you automatically
// on a fresh DB; pass --no-seed to skip).
//
// Usage:
//   node scripts/generate_demo_data.js
//   node scripts/generate_demo_data.js --count=2000 --hours=24 --fraud=5 --structuring=3 --anomalies=20

'use strict';

const crypto = require('crypto');
const { initDb } = require('../server/db');
const { ensureUserExists, getUserHistory, updateUserAfterTransaction } = require('../server/userProfile');
const findActiveAlert = require('../server/structuring/alertLookup');
const computeFraudScore = require('../server/scoring');
const decide = require('../server/decision');
const { getFraudProbability } = require('../server/ml/mlClient');
const { runScanCycle } = require('../server/structuring/backgroundJob');
const { DEMO_CITY_HUBS, MERCHANT_RECEIVER_POOL, GATEWAY_POOL } = require('../simulator/simulate_transactions');

const velocity = require('../server/rules/velocity');
const impossibleTravel = require('../server/rules/impossibleTravel');
const amountAnomaly = require('../server/rules/amountAnomaly');
const deviceMismatch = require('../server/rules/deviceMismatch');
const oddHour = require('../server/rules/oddHour');

const RULE_DETECTORS = [
  { type: 'velocity', check: velocity },
  { type: 'impossible_travel', check: impossibleTravel },
  { type: 'amount_anomaly', check: amountAnomaly },
  { type: 'device_mismatch', check: deviceMismatch },
  { type: 'odd_hour', check: oddHour },
];

// Every insertTransaction call increments this, not just the "headline" outcome of each
// generator (a fraud/structuring burst inserts several rows but its generator function only
// returns the last one) -- so the end-of-run summary reflects every row actually written,
// including e.g. a structuring burst's own rapid-fire transfers occasionally tripping
// velocity/device_mismatch on their own, before the resulting alert even exists.
const TALLY = { allow: 0, step_up: 0, block: 0 };

function parseArgs(argv) {
  const defaults = { count: 1500, hours: 24, fraud: 5, structuring: 3, anomalies: 20 };
  const args = { ...defaults };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key in defaults) args[key] = Number(value);
  }
  return args;
}

function jitter(value, spread) {
  return value + (Math.random() * 2 - 1) * spread;
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function randomGateway() {
  return GATEWAY_POOL[Math.floor(Math.random() * GATEWAY_POOL.length)];
}

function randomMerchantAccount() {
  return MERCHANT_RECEIVER_POOL[Math.floor(Math.random() * MERCHANT_RECEIVER_POOL.length)];
}

// Separate instance from simulator/simulate_transactions.js's CUSTOMER_POOL (that one only
// exists to drive live HTTP traffic) but the same shape and the same DEMO_CITY_HUBS, round-robin
// assigned so every hub gets an equal share of customers -- the fix for the Map tab clustering
// into one city that a previous pass on this codebase made for live traffic applies here too.
// Receiving accounts (MERCHANT_RECEIVER_POOL) and gateways (GATEWAY_POOL) are imported directly
// from the simulator rather than duplicated, so seeded history and live demo traffic agree on
// the same handful of storefronts/gateways.
const POOL_SIZE = 300;
const REGULAR_COUNT = 60; // first N of the pool -- picked disproportionately often, see pickCustomer
const SEED_CUSTOMER_POOL = Array.from({ length: POOL_SIZE }, (_, i) => {
  const hub = DEMO_CITY_HUBS[i % DEMO_CITY_HUBS.length];
  return {
    id: `u_seed_${i + 1}`,
    device: `d_seed_${i + 1}`,
    homeCity: hub.name,
    homeLat: hub.lat + (Math.random() - 0.5) * 0.3,
    homeLng: hub.lng + (Math.random() - 0.5) * 0.3,
    typicalAmount: 50 + Math.random() * 300,
  };
});

// 70% of picks come from the first REGULAR_COUNT customers so a meaningful chunk of the pool
// builds up real avg-spend/device history early in the window -- amountAnomaly and
// deviceMismatch below need a real baseline to be anomalous *against*, same as they would for
// genuine repeat customers.
function pickCustomer() {
  if (Math.random() < 0.7) return SEED_CUSTOMER_POOL[Math.floor(Math.random() * REGULAR_COUNT)];
  return SEED_CUSTOMER_POOL[Math.floor(Math.random() * POOL_SIZE)];
}

// Mirrors the pipeline in server/routes/transactions.js exactly (same modules, same order),
// except `input.timestamp` is trusted as given instead of being overwritten with real "now" --
// safe here because this script never receives input from an untrusted client, only from the
// synthetic generators below.
async function insertTransaction(db, input) {
  // Mirrors validate.js's normalization for the live API (undefined merchant_id/purpose -> null)
  // -- several of the historical event generators below don't set one, same as their live
  // counterparts in simulator/simulate_transactions.js which rely on the API doing this.
  if (typeof input.merchant_id !== 'string') input.merchant_id = null;
  if (typeof input.purpose !== 'string') input.purpose = null;

  const nowMs = new Date(input.timestamp).getTime();

  ensureUserExists(db, input.sender_id, input.timestamp);
  ensureUserExists(db, input.receiver_id, input.timestamp);

  const userHistory = getUserHistory(db, input.sender_id, nowMs);

  const ruleResults = RULE_DETECTORS.map(({ type, check }) => ({
    type,
    ...check(input, userHistory),
  }));

  const structuringLookup = findActiveAlert(db, input.sender_id, input.receiver_id, nowMs);
  const mlProbability = await getFraudProbability(input, userHistory);

  const { score, reasons } = computeFraudScore(ruleResults, structuringLookup, mlProbability);
  const decision = decide(score);
  const transactionId = `t_${crypto.randomUUID()}`;

  db.prepare(
    `INSERT INTO transactions
      (transaction_id, sender_id, receiver_id, amount, timestamp, location_lat, location_lng, device_id, merchant_id, purpose, transaction_type, fraud_score, decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    transactionId,
    input.sender_id,
    input.receiver_id,
    input.amount,
    input.timestamp,
    input.location ? input.location.lat : null,
    input.location ? input.location.lng : null,
    input.device_id,
    input.merchant_id,
    input.purpose,
    input.transaction_type,
    score,
    decision
  );

  const flagInsert = db.prepare(
    'INSERT INTO flags (flag_id, transaction_id, flag_type, reason, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of ruleResults) {
    if (r.flagged) {
      flagInsert.run(`fl_${crypto.randomUUID()}`, transactionId, r.type, r.reason, r.weight, input.timestamp);
    }
  }

  updateUserAfterTransaction(db, input.sender_id, input);

  TALLY[decision] += 1;
  return { decision, reasons };
}

// Mirrors simulator/simulate_transactions.js's generateNormalTransaction: mostly customer ->
// merchant purchases, with a smaller share of merchant-initiated refunds/settlement payouts
// (the cases `purpose` is for) so seeded history matches the shape live traffic produces.
async function runNormalEvent(db, atMs) {
  const customer = pickCustomer();
  const merchantAccount = randomMerchantAccount();
  const gateway = randomGateway();
  const customerLocation = { lat: jitter(customer.homeLat, 0.0003), lng: jitter(customer.homeLng, 0.0003) };
  const roll = Math.random();

  if (roll < 0.86) {
    const amount = Math.max(10, jitter(customer.typicalAmount, customer.typicalAmount * 0.3));
    return insertTransaction(db, {
      sender_id: customer.id,
      receiver_id: merchantAccount,
      amount: Math.round(amount * 100) / 100,
      timestamp: isoAt(atMs),
      location: customerLocation,
      device_id: customer.device,
      merchant_id: gateway,
      transaction_type: 'transfer',
    });
  }

  if (roll < 0.92) {
    const amount = Math.max(10, jitter(customer.typicalAmount, customer.typicalAmount * 0.2));
    return insertTransaction(db, {
      sender_id: merchantAccount,
      receiver_id: customer.id,
      amount: Math.round(amount * 100) / 100,
      timestamp: isoAt(atMs),
      device_id: customer.device,
      merchant_id: gateway,
      purpose: `Refund - order #${Math.floor(100000 + Math.random() * 900000)}`,
      transaction_type: 'transfer',
    });
  }

  if (roll < 0.98) {
    const amount = Math.max(10, jitter(customer.typicalAmount, customer.typicalAmount * 0.3));
    return insertTransaction(db, {
      sender_id: customer.id,
      receiver_id: merchantAccount,
      amount: Math.round(amount * 100) / 100,
      timestamp: isoAt(atMs),
      location: customerLocation,
      device_id: customer.device,
      merchant_id: gateway,
      transaction_type: 'deposit',
    });
  }

  return insertTransaction(db, {
    sender_id: merchantAccount,
    receiver_id: `bank_settlement_${gateway}`,
    amount: Math.round((500 + Math.random() * 4000) * 100) / 100,
    timestamp: isoAt(atMs),
    merchant_id: gateway,
    purpose: 'Payout - settlement to business bank account',
    transaction_type: 'withdrawal',
  });
}

// A single amount-anomaly transaction (4x a regular's established average) -- lands in the
// step_up tier (weight 45, see server/rules/amountAnomaly.js) without the velocity/travel/device
// signals a full fraud burst would add, so the Audit Trail gets yellow bars spread through the
// day instead of only appearing right when a scripted fraud/structuring event fires.
async function runAnomalyEvent(db, atMs) {
  const candidates = SEED_CUSTOMER_POOL.slice(0, REGULAR_COUNT);
  for (const sender of shuffle(candidates)) {
    const row = db.prepare('SELECT avg_transaction_amount FROM users WHERE user_id = ?').get(sender.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE sender_id = ?').get(sender.id).n;
    if (!row || !row.avg_transaction_amount || count < 3) continue;

    return insertTransaction(db, {
      sender_id: sender.id,
      receiver_id: randomMerchantAccount(),
      amount: Math.round(row.avg_transaction_amount * 4 * 100) / 100,
      timestamp: isoAt(atMs),
      location: { lat: jitter(sender.homeLat, 0.0003), lng: jitter(sender.homeLng, 0.0003) },
      device_id: sender.device,
      merchant_id: randomGateway(),
      transaction_type: 'transfer',
    });
  }
  return null; // no regular has enough history yet at this point in the timeline -- skip, not fatal
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Historical version of simulator/simulate_transactions.js's triggerFraudScenario: same shape
// (5 rapid same-city transactions, then a final one ~1400km away seconds later on a new device),
// anchored at a historical startMs instead of real time.
async function runFraudEvent(db, startMs) {
  const hub = DEMO_CITY_HUBS[Math.floor(Math.random() * DEMO_CITY_HUBS.length)];
  const sender = randomId('u_fraud_hist');
  const receiver = randomMerchantAccount();
  const gateway = randomGateway();
  const device = randomId('d');

  let t = startMs;
  for (let i = 0; i < 5; i += 1) {
    await insertTransaction(db, {
      sender_id: sender,
      receiver_id: receiver,
      amount: 100 + i * 10,
      timestamp: isoAt(t),
      location: { lat: hub.lat, lng: hub.lng },
      device_id: device,
      merchant_id: gateway,
      transaction_type: 'transfer',
    });
    t += 300;
  }

  // Farthest other hub from this one, for a guaranteed large jump regardless of which hub was picked.
  const farHub = [...DEMO_CITY_HUBS].sort(
    (a, b) => haversine(b.lat, b.lng, hub.lat, hub.lng) - haversine(a.lat, a.lng, hub.lat, hub.lng)
  )[0];

  return insertTransaction(db, {
    sender_id: sender,
    receiver_id: receiver,
    amount: 150,
    timestamp: isoAt(t),
    location: { lat: farHub.lat, lng: farHub.lng },
    device_id: randomId('d_new'),
    merchant_id: gateway,
    transaction_type: 'transfer',
  });
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Historical version of triggerStructuringScenario: 6 transfers -> 3 shell vendor/payout
// receivers, then 2 of them rapidly cash out >80% of what they received -- laundering hidden
// inside otherwise-ordinary marketplace payment flow. Anchored at startMs; runScanCycle is
// called directly right after (rather than waiting on the live 7s-interval job) so the resulting
// alert's created_at lands at this historical point instead of "whenever this script finishes".
async function runStructuringEvent(db, startMs) {
  const hub = DEMO_CITY_HUBS[Math.floor(Math.random() * DEMO_CITY_HUBS.length)];
  const sender = randomId('u_struct_hist');
  const receivers = [randomId('u_vendor_shell_hist'), randomId('u_vendor_shell_hist'), randomId('u_vendor_shell_hist')];

  let t = startMs;
  for (let i = 0; i < 6; i += 1) {
    const receiver = receivers[i % receivers.length];
    await insertTransaction(db, {
      sender_id: sender,
      receiver_id: receiver,
      amount: 4000,
      timestamp: isoAt(t),
      location: { lat: hub.lat, lng: hub.lng },
      device_id: randomId('d'),
      transaction_type: 'transfer',
    });
    t += 200;
  }

  await insertTransaction(db, {
    sender_id: receivers[0],
    receiver_id: randomId('u_cashout_hist'),
    amount: 7000,
    timestamp: isoAt(t),
    device_id: randomId('d'),
    transaction_type: 'withdrawal',
  });
  t += 200;
  await insertTransaction(db, {
    sender_id: receivers[1],
    receiver_id: randomId('u_cashout_hist'),
    amount: 6500,
    timestamp: isoAt(t),
    device_id: randomId('d'),
    transaction_type: 'withdrawal',
  });

  const alerts = runScanCycle(db, t + 2000);
  return alerts.find((a) => a.sender_id === sender) || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[seed] generating ${args.count} normal + ${args.anomalies} anomaly + ${args.fraud} fraud + ` +
      `${args.structuring} structuring events, evenly spread across the last ${args.hours}h`
  );

  const db = initDb();

  const nowMs = Date.now();
  const windowEndMs = nowMs - 2000;
  const windowStartMs = nowMs - args.hours * 60 * 60 * 1000;
  const windowMs = windowEndMs - windowStartMs;

  const events = [];

  const normalSlot = windowMs / args.count;
  for (let i = 0; i < args.count; i += 1) {
    const at = windowStartMs + i * normalSlot + Math.random() * normalSlot;
    events.push({ at, run: () => runNormalEvent(db, at) });
  }

  const anomalyStart = windowStartMs + 0.35 * windowMs;
  const anomalySlot = (windowEndMs - anomalyStart) / args.anomalies;
  for (let i = 0; i < args.anomalies; i += 1) {
    const at = anomalyStart + i * anomalySlot + Math.random() * anomalySlot;
    events.push({ at, run: () => runAnomalyEvent(db, at) });
  }

  const fraudSlot = windowMs / args.fraud;
  for (let i = 0; i < args.fraud; i += 1) {
    const at = windowStartMs + i * fraudSlot + Math.random() * fraudSlot;
    events.push({ at, run: () => runFraudEvent(db, at) });
  }

  const structuringSlot = windowMs / args.structuring;
  for (let i = 0; i < args.structuring; i += 1) {
    const at = windowStartMs + i * structuringSlot + Math.random() * structuringSlot;
    events.push({ at, run: () => runStructuringEvent(db, at) });
  }

  // Strict chronological order: each event's history-dependent scoring (avg spend, recent
  // transactions, known devices) must only ever see rows that are chronologically before it,
  // exactly as a live server would only ever see the past. Running out of order would let an
  // "earlier" event see a "later" one's data.
  events.sort((a, b) => a.at - b.at);

  let done = 0;
  let skippedAnomalies = 0;
  for (const event of events) {
    const result = await event.run();
    done += 1;
    if (result === null) skippedAnomalies += 1;
    if (done % 200 === 0 || done === events.length) {
      console.log(`[seed] ${done}/${events.length} events processed...`);
    }
  }

  const alertCount = db.prepare('SELECT COUNT(*) AS n FROM structuring_alerts').get().n;
  const totalRows = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;

  console.log(
    `[seed] done. ${totalRows} transactions written -- allow=${TALLY.allow} step_up=${TALLY.step_up} ` +
      `block=${TALLY.block}; ${alertCount} structuring alerts created` +
      (skippedAnomalies > 0 ? `; ${skippedAnomalies} anomaly event(s) skipped (no sender had enough history yet)` : '')
  );
  console.log(`[seed] hubs used: ${DEMO_CITY_HUBS.map((h) => h.name).join(', ')}`);

  db.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[seed] crashed:', err);
    process.exitCode = 1;
  });
}

module.exports = { main };
