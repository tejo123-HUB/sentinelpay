// Generates realistic demo traffic against a running SentinelPay server: a continuous stream of
// normal customer-pays-merchant commerce (purchases, refunds, store-credit top-ups, settlement
// payouts — see generateNormalTransaction below), plus on-demand scripted scenarios for a
// single-transaction fraud block and a full structuring/layering pattern (architecture.md
// Section 10, Task 4).
//
// Usage:
//   node simulator/simulate_transactions.js --scenario=normal --count=100 --rate=150
//   node simulator/simulate_transactions.js --scenario=fraud
//   node simulator/simulate_transactions.js --scenario=structuring
//   node simulator/simulate_transactions.js --scenario=odd-hour
//   node simulator/simulate_transactions.js --scenario=all
//   node simulator/simulate_transactions.js --scenario=normal --continuous   (Ctrl+C to stop)

require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { API_KEY, DEFAULT_DEV_API_KEY } = require('../server/middleware/apiKeyAuth');

const BASE_URL = process.env.SIMULATOR_BASE_URL || 'http://127.0.0.1:3000';

// The API now requires X-API-Key on every request (server/middleware/apiKeyAuth.js). This
// process and the server it's talking to are separate processes, so they only agree on the key
// automatically via the shared DEFAULT_DEV_API_KEY fallback (when neither side sets API_KEY) or
// by both loading the same .env (dotenv, above) once a real key is configured — there's no other
// shared state between them.
if (API_KEY === DEFAULT_DEV_API_KEY) {
  console.warn('[simulator] No API_KEY set — using the same insecure default the server falls back to.');
}

// Demo/display only: hub cities spread across India so the dashboard's Map tab reads as a
// nationwide network rather than one single-city blob. Round-robin assignment below (not
// random) guarantees an even split across hubs regardless of pool size.
const DEMO_CITY_HUBS = [
  { name: 'Delhi', lat: 28.6139, lng: 77.209 },
  { name: 'Mumbai', lat: 19.076, lng: 72.8777 },
  { name: 'Bengaluru', lat: 12.9716, lng: 77.5946 },
  { name: 'Kolkata', lat: 22.5726, lng: 88.3639 },
  { name: 'Chennai', lat: 13.0827, lng: 80.2707 },
  { name: 'Hyderabad', lat: 17.385, lng: 78.4867 },
  { name: 'Pune', lat: 18.5204, lng: 73.8567 },
  { name: 'Ahmedabad', lat: 23.0225, lng: 72.5714 },
  { name: 'Jaipur', lat: 26.9124, lng: 75.7873 },
  { name: 'Lucknow', lat: 26.8467, lng: 80.9462 },
];

// A pool of synthetic customers with stable homes/devices, so their behavioral baselines
// (avg_transaction_amount, typical_active_hours, known devices) build up naturally across the
// normal traffic stream rather than every transaction looking brand-new. Sized large enough
// (300) that even a fast stream (tens of ms between sends) keeps any single customer's own
// transaction rate well under the velocity detector's threshold (5/60s) — a smaller pool made
// "normal" traffic look like bot-speed velocity abuse from a handful of accounts, which is a
// simulator realism bug, not a fraud-engine false positive. Homes are assigned round-robin
// across DEMO_CITY_HUBS (not randomly) so every hub gets an equal share of customers — see
// DEMO_CITY_HUBS above.
const CUSTOMER_POOL = Array.from({ length: 300 }, (_, i) => {
  const hub = DEMO_CITY_HUBS[i % DEMO_CITY_HUBS.length];
  return {
    id: `u_sim_${i + 1}`,
    device: `d_sim_${i + 1}`,
    homeCity: hub.name,
    homeLat: hub.lat + (Math.random() - 0.5) * 0.3,
    homeLng: hub.lng + (Math.random() - 0.5) * 0.3,
    typicalAmount: 50 + Math.random() * 300,
  };
});

// The business's own receiving accounts — a handful of storefronts/product lines within the one
// merchant business SentinelPay is monitoring, not a fresh random receiver per transaction. Sized
// large enough (8) that even when a merchant account is the *sender* (refunds/payouts, below),
// any single account's send rate stays well under the velocity threshold — the same reasoning
// that sizes CUSTOMER_POOL above, just for the much smaller share of traffic merchants originate.
const MERCHANT_RECEIVER_POOL = [
  'm_store_apparel',
  'm_store_electronics',
  'm_store_home_goods',
  'm_store_beauty',
  'm_store_subscriptions',
  'm_store_digital_goods',
  'm_store_grocery',
  'm_store_marketplace',
];

// Which of the business's own payment-gateway accounts a transaction was ingested through —
// the point of SentinelPay wiring into every gateway the business uses, rather than just one, is
// that laundering can otherwise hide by spreading activity across gateways no single integration
// would see in full (architecture.md Section 1). Populated from a small fixed pool so the
// dashboard's "Gateway" column visibly shows several real gateways, not a fresh random value
// every transaction.
const GATEWAY_POOL = ['stripe_acct_primary', 'razorpay_acct_intl', 'paypal_acct_eu', 'stripe_acct_backup'];

function randomGateway() {
  return GATEWAY_POOL[Math.floor(Math.random() * GATEWAY_POOL.length)];
}

function randomMerchantAccount() {
  return MERCHANT_RECEIVER_POOL[Math.floor(Math.random() * MERCHANT_RECEIVER_POOL.length)];
}

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
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(transaction),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function getAlerts(baseUrl, limit = 20) {
  const res = await fetch(`${baseUrl}/alerts?limit=${limit}`, { headers: { 'X-API-Key': API_KEY } });
  return res.json();
}

// Models the business's actual money flow, not generic person-to-person transfers: a customer
// mostly pays one of the business's storefronts, occasionally the business refunds a customer
// or settles funds out to its bank — the two cases that carry a human-readable `purpose` note,
// mirroring what a real risk/compliance analyst would actually see in this data (architecture.md
// Section 1).
function generateNormalTransaction() {
  const customer = CUSTOMER_POOL[Math.floor(Math.random() * CUSTOMER_POOL.length)];
  const merchantAccount = randomMerchantAccount();
  const gateway = randomGateway();
  // Small jitter approximating real GPS noise for "still at home" (~tens of meters), not an
  // independent multi-km random jump every transaction.
  const customerLocation = { lat: jitter(customer.homeLat, 0.0003), lng: jitter(customer.homeLng, 0.0003) };
  const roll = Math.random();

  if (roll < 0.86) {
    // Ordinary purchase: customer pays the business.
    const amount = Math.max(10, jitter(customer.typicalAmount, customer.typicalAmount * 0.3));
    return {
      sender_id: customer.id,
      receiver_id: merchantAccount,
      amount: Math.round(amount * 100) / 100,
      timestamp: new Date().toISOString(),
      location: customerLocation,
      device_id: customer.device,
      merchant_id: gateway,
      transaction_type: 'transfer',
    };
  }

  if (roll < 0.92) {
    // Merchant-initiated refund back to the customer — the case `purpose` exists for.
    const amount = Math.max(10, jitter(customer.typicalAmount, customer.typicalAmount * 0.2));
    return {
      sender_id: merchantAccount,
      receiver_id: customer.id,
      amount: Math.round(amount * 100) / 100,
      timestamp: new Date().toISOString(),
      device_id: customer.device,
      merchant_id: gateway,
      purpose: `Refund - order #${Math.floor(100000 + Math.random() * 900000)}`,
      transaction_type: 'transfer',
    };
  }

  if (roll < 0.98) {
    // Customer tops up stored/account credit with the business.
    const amount = Math.max(10, jitter(customer.typicalAmount, customer.typicalAmount * 0.3));
    return {
      sender_id: customer.id,
      receiver_id: merchantAccount,
      amount: Math.round(amount * 100) / 100,
      timestamp: new Date().toISOString(),
      location: customerLocation,
      device_id: customer.device,
      merchant_id: gateway,
      transaction_type: 'deposit',
    };
  }

  // The business settles funds out to its own bank account through this gateway.
  return {
    sender_id: merchantAccount,
    receiver_id: `bank_settlement_${gateway}`,
    amount: Math.round((500 + Math.random() * 4000) * 100) / 100,
    timestamp: new Date().toISOString(),
    merchant_id: gateway,
    purpose: 'Payout - settlement to business bank account',
    transaction_type: 'withdrawal',
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
// fresh account each run so repeat demo runs aren't affected by prior state. Targets one of the
// business's real storefronts — a card-testing/account-takeover attack against the merchant,
// not a generic person-to-person transfer.
async function triggerFraudScenario(baseUrl) {
  const sender = randomId('u_fraud');
  const receiver = randomMerchantAccount();
  const gateway = randomGateway();
  const homeLat = 16.5062;
  const homeLng = 80.648;
  const device = randomId('d');

  console.log(`[fraud] scripted attack from ${sender} against ${receiver}: rapid transactions + a 400km+ jump on a new device`);

  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await postTransaction(baseUrl, {
      sender_id: sender,
      receiver_id: receiver,
      amount: 100 + i * 10,
      timestamp: new Date().toISOString(),
      location: { lat: homeLat, lng: homeLng },
      device_id: device,
      merchant_id: gateway,
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
    merchant_id: gateway,
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

// Full structuring pattern: a shell account funnels a large sum through 6 small transfers to 3
// shell vendor/payout accounts riding on the platform's payment flow, 2 of which then rapidly
// cash out >80% of what they received — laundering hidden inside otherwise-ordinary marketplace
// activity, not one obviously large red-flag transaction. Fresh account IDs every run so the
// structuring engine's re-alert cooldown never suppresses a legitimate new demo run.
async function triggerStructuringScenario(baseUrl) {
  const sender = randomId('u_struct');
  const receivers = [randomId('u_vendor_shell'), randomId('u_vendor_shell'), randomId('u_vendor_shell')];

  console.log(`[structuring] scripted pattern from ${sender} -> [${receivers.join(', ')}] (shell vendor/payout accounts)`);

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
  const receiver = randomMerchantAccount();
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
  randomGateway,
  randomMerchantAccount,
  DEMO_CITY_HUBS,
  MERCHANT_RECEIVER_POOL,
  GATEWAY_POOL,
};
