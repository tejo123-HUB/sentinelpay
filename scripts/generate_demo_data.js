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
//   node scripts/generate_demo_data.js --count=2000 --hours=24 --fraud=5 --structuring=3 \
//     --anomalies=20 --outbound-fraud=5 --refund-fraud=5

'use strict';

const crypto = require('crypto');
const { initDb } = require('../server/db');
const { ensureUserExists, getUserHistory, updateUserAfterTransaction } = require('../server/userProfile');
const findActiveAlert = require('../server/structuring/alertLookup');
const computeFraudScore = require('../server/scoring');
const decide = require('../server/decision');
const { getFraudProbability } = require('../server/ml/mlClient');
const { runScanCycle, runGraphClusterScan } = require('../server/structuring/backgroundJob');
const { DEMO_CITY_HUBS, MERCHANT_RECEIVER_POOL, GATEWAY_POOL } = require('../simulator/simulate_transactions');
const { isBusinessAccount } = require('../server/businessAccounts');
const getOutboundContext = require('../server/outboundContext');
const applyOutboundRestrictors = require('../server/outboundRestrictor');
const { updateReputationAfterTransaction } = require('../server/reputation');
const { upsertEdge } = require('../server/graphIntelligence');
const { recordConfirmedMule } = require('../server/muleScore');
const { autoWatchlistConfirmedMule } = require('../server/autoFraudListing');

const velocity = require('../server/rules/velocity');
const impossibleTravel = require('../server/rules/impossibleTravel');
const amountAnomaly = require('../server/rules/amountAnomaly');
const deviceMismatch = require('../server/rules/deviceMismatch');
const oddHour = require('../server/rules/oddHour');
const refundWithoutPurchase = require('../server/rules/refundWithoutPurchase');
const payoutToNewReceiver = require('../server/rules/payoutToNewReceiver');
const outboundRatioAnomaly = require('../server/rules/outboundRatioAnomaly');
const outboundFanOutBurst = require('../server/rules/outboundFanOutBurst');

const RULE_DETECTORS = [
  { type: 'velocity', check: velocity },
  { type: 'impossible_travel', check: impossibleTravel },
  { type: 'amount_anomaly', check: amountAnomaly },
  { type: 'device_mismatch', check: deviceMismatch },
  { type: 'odd_hour', check: oddHour },
];

const OUTBOUND_RULE_DETECTORS = [
  { type: 'refund_without_purchase', check: refundWithoutPurchase },
  { type: 'payout_new_receiver', check: payoutToNewReceiver },
  { type: 'outbound_ratio_anomaly', check: outboundRatioAnomaly },
  { type: 'outbound_fan_out_burst', check: outboundFanOutBurst },
];

// Every insertTransaction call increments this, not just the "headline" outcome of each
// generator (a fraud/structuring burst inserts several rows but its generator function only
// returns the last one) -- so the end-of-run summary reflects every row actually written,
// including e.g. a structuring burst's own rapid-fire transfers occasionally tripping
// velocity/device_mismatch on their own, before the resulting alert even exists.
const TALLY = { allow: 0, step_up: 0, block: 0 };

function parseArgs(argv) {
  const defaults = {
    count: 1500,
    hours: 24,
    fraud: 5,
    structuring: 3,
    anomalies: 20,
    outboundFraud: 5,
    refundFraud: 5,
  };
  const args = { ...defaults };
  for (const arg of argv) {
    const [rawKey, value] = arg.replace(/^--/, '').split('=');
    // CLI flags are kebab-case (--outbound-fraud=3) but the args object is camelCase --
    // matches this file's other flags (--count, --hours, etc.) already being plain lowercase.
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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

// Regression (mirrors the fix in simulator/simulate_transactions.js's generateNormalTransaction,
// found by inspecting what --scenario=normal actually flagged against a live server): refund
// events used to pick a uniformly random customer with no regard for whether that customer had
// ever actually bought from that merchant, tripping refund_without_purchase.js on seeded "normal"
// history. purchaseLedger tracks real purchase records per (merchant, customer) pair -- events
// here run in strict chronological order (main()'s events.sort), so building it up incrementally
// as runNormalEvent's own purchases/deposits are generated stays consistent with what the real
// refundWithoutPurchase.js rule will see when insertTransaction scores each event. Also respects
// OUTBOUND_MIN_PURCHASE_AGE_MS, same anti-forgery age gate the real rule enforces: a purchase
// isn't usable as refund credit until it's old enough.
const OUTBOUND_MIN_PURCHASE_AGE_MS = getOutboundContext.OUTBOUND_MIN_PURCHASE_AGE_MS;
const purchaseLedger = new Map(); // merchantAccount -> Map(customerId -> Array<{ amountRemaining, atMs }>)
const MIN_REFUND_CREDIT = 10; // matches the Math.max(10, ...) floor used for every generated amount

function recordPurchaseCredit(merchantAccount, customerId, amount, atMs) {
  let merchantLedger = purchaseLedger.get(merchantAccount);
  if (!merchantLedger) {
    merchantLedger = new Map();
    purchaseLedger.set(merchantAccount, merchantLedger);
  }
  let entries = merchantLedger.get(customerId);
  if (!entries) {
    entries = [];
    merchantLedger.set(customerId, entries);
  }
  entries.push({ amountRemaining: amount, atMs });
}

function pickRefundableCustomer(merchantAccount, nowMs) {
  const merchantLedger = purchaseLedger.get(merchantAccount);
  if (!merchantLedger) return null;
  const eligible = [];
  for (const [customerId, entries] of merchantLedger.entries()) {
    const credit = entries
      .filter((e) => nowMs - e.atMs >= OUTBOUND_MIN_PURCHASE_AGE_MS)
      .reduce((sum, e) => sum + e.amountRemaining, 0);
    if (credit >= MIN_REFUND_CREDIT) eligible.push([customerId, credit]);
  }
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

// Consumes refund credit oldest-purchase-first, matching how a real customer's actual purchase
// history would be drawn down.
function consumeRefundCredit(merchantAccount, customerId, amount, nowMs) {
  const entries = purchaseLedger.get(merchantAccount).get(customerId);
  let remaining = amount;
  for (const entry of entries) {
    if (remaining <= 0) break;
    if (nowMs - entry.atMs < OUTBOUND_MIN_PURCHASE_AGE_MS) continue;
    const take = Math.min(entry.amountRemaining, remaining);
    entry.amountRemaining -= take;
    remaining -= take;
  }
}

// Mirrors the pipeline in server/routes/transactions.js exactly (same modules, same order),
// except `input.timestamp` is trusted as given instead of being overwritten with real "now" --
// safe here because this script never receives input from an untrusted client, only from the
// synthetic generators below.
async function insertTransaction(db, input) {
  // Mirrors validate.js's normalization for the live API (undefined merchant_id/purpose/
  // device_id -> null) -- several of the historical event generators below don't set one, same
  // as their live counterparts in simulator/simulate_transactions.js which rely on the API
  // doing this (e.g. runRefundFraudEvent/the normal-event refund branch deliberately omit
  // device_id -- a business-initiated payout isn't something a customer device touched).
  if (typeof input.merchant_id !== 'string') input.merchant_id = null;
  if (typeof input.purpose !== 'string') input.purpose = null;
  if (typeof input.device_id !== 'string') input.device_id = null;

  const nowMs = new Date(input.timestamp).getTime();

  ensureUserExists(db, input.sender_id, input.timestamp);
  ensureUserExists(db, input.receiver_id, input.timestamp);

  // Mirrors server/routes/transactions.js: the structuring lookup always runs, but fraud/AML
  // rule+ML scoring only runs for outbound transactions (money leaving the business) -- see the
  // matching comment there.
  const structuringLookup = findActiveAlert(db, input.sender_id, input.receiver_id, nowMs);
  const outbound = isBusinessAccount(db, input.sender_id);

  let ruleResults = [];
  let mlProbability = 0;
  // Hoisted out of the `if (outbound)` block (mirrors routes/transactions.js's
  // outboundContextForGraph) so the graph-edge/mule-detection writes below can reuse it after
  // scoring instead of recomputing.
  let outboundContext = null;
  if (outbound) {
    const userHistory = getUserHistory(db, input.sender_id, nowMs);
    outboundContext = getOutboundContext(db, input, nowMs);

    ruleResults = [
      ...RULE_DETECTORS.map(({ type, check }) => ({ type, ...check(input, userHistory) })),
      ...OUTBOUND_RULE_DETECTORS.map(({ type, check }) => ({ type, ...check(input, outboundContext) })),
    ];
    mlProbability = await getFraudProbability(input, userHistory);

    // Mirrors routes/transactions.js: the moment this transaction's receiver is confirmed a mule
    // (real-time, not a batch job), persist it -- see server/muleScore.js/autoFraudListing.js.
    if (outboundContext.receiverMuleScore && outboundContext.receiverMuleScore.isMule) {
      recordConfirmedMule(db, input.receiver_id, outboundContext.receiverMuleScore.qualifyingCycles, nowMs);
      autoWatchlistConfirmedMule(db, input.receiver_id, outboundContext.receiverMuleScore.qualifyingCycles);
    }
  }

  let { score, reasons } = computeFraudScore(ruleResults, structuringLookup, mlProbability);
  if (outbound) {
    ({ score, reasons } = applyOutboundRestrictors(score, reasons, input));
  }
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

  // Mirrors routes/transactions.js: composite reputation (server/reputation.js) only moves for
  // outbound-scored transactions, and the persisted graph store (server/graphIntelligence.js) is
  // seeded from every transaction plus outbound's shared-identifier edges. Without these two, the
  // dashboard's Graph tab has relationships to draw (from live GET /graph/relationships self-joins)
  // but "Discovered Risky Clusters" -- which reads the persisted graph_clusters table, populated by
  // a periodic union-find pass over graph_edges scored against entity_reputation -- stays
  // permanently empty for seeded history, since neither table was ever written.
  if (outbound) {
    updateReputationAfterTransaction(db, { ...input, transaction_id: transactionId }, ruleResults);
  }
  upsertEdge(db, input.sender_id, input.receiver_id, 'transaction', input.amount, input.timestamp);
  if (outbound && outboundContext) {
    for (const otherId of outboundContext.sharedDeviceAccountIds) upsertEdge(db, input.sender_id, otherId, 'shared_device', 0, input.timestamp);
    for (const otherId of outboundContext.sharedIpAccountIds) upsertEdge(db, input.sender_id, otherId, 'shared_ip', 0, input.timestamp);
    for (const otherId of outboundContext.sharedIdentityHashAccountIds) upsertEdge(db, input.sender_id, otherId, 'shared_identity_hash', 0, input.timestamp);
    for (const otherId of outboundContext.sharedBankAccountAccountIds) upsertEdge(db, input.sender_id, otherId, 'shared_bank_account', 0, input.timestamp);
  }

  updateUserAfterTransaction(db, input.sender_id, input);

  TALLY[decision] += 1;
  return { decision, reasons };
}

function insertOrdinaryPurchase(db, customer, merchantAccount, gateway, customerLocation, transactionType, atMs) {
  const amount = Math.max(10, jitter(customer.typicalAmount, customer.typicalAmount * 0.3));
  recordPurchaseCredit(merchantAccount, customer.id, amount, atMs);
  return insertTransaction(db, {
    sender_id: customer.id,
    receiver_id: merchantAccount,
    amount: Math.round(amount * 100) / 100,
    timestamp: isoAt(atMs),
    location: customerLocation,
    device_id: customer.device,
    merchant_id: gateway,
    transaction_type: transactionType,
  });
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
    return insertOrdinaryPurchase(db, customer, merchantAccount, gateway, customerLocation, 'transfer', atMs);
  }

  if (roll < 0.92) {
    // No device_id -- a business-initiated payout, not something the customer's own device
    // touched (see the matching comment in simulator/simulate_transactions.js). Only refund a
    // customer with real, aged-enough purchase credit at this merchant (purchaseLedger) --
    // refunding whoever the random roll landed on regardless of purchase history is exactly the
    // refund_without_purchase pattern this system exists to catch, not "normal" seeded history.
    const refundable = pickRefundableCustomer(merchantAccount, atMs);
    if (!refundable) {
      return insertOrdinaryPurchase(db, customer, merchantAccount, gateway, customerLocation, 'transfer', atMs);
    }
    const [refundCustomerId, credit] = refundable;
    const amount = Math.min(credit, Math.max(10, jitter(credit * 0.6, credit * 0.2)));
    consumeRefundCredit(merchantAccount, refundCustomerId, amount, atMs);
    return insertTransaction(db, {
      sender_id: merchantAccount,
      receiver_id: refundCustomerId,
      amount: Math.round(amount * 100) / 100,
      timestamp: isoAt(atMs),
      merchant_id: gateway,
      purpose: `Refund - order #${Math.floor(100000 + Math.random() * 900000)}`,
      transaction_type: 'transfer',
    });
  }

  if (roll < 0.98) {
    return insertOrdinaryPurchase(db, customer, merchantAccount, gateway, customerLocation, 'deposit', atMs);
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
  // Registered as a business account only for the duration of this event (unregistered again
  // below) so these 6 transfers actually run through real outbound rule/reputation scoring
  // instead of being silently auto-allowed -- a non-business sender never triggers
  // outbound_fan_out_burst/payout_new_receiver or the reputation/graph_edges writes
  // insertTransaction now does for outbound transactions, which is what lets
  // graphIntelligence.discoverClusters find this ring risky enough (avg member reputation >=
  // GRAPH_INTELLIGENCE.CLUSTER_RISK_THRESHOLD) to ever surface on the Graph tab's "Discovered
  // Risky Clusters" panel. Deliberately temporary, unlike MERCHANT_RECEIVER_POOL's real
  // registrations in main(): this is a synthetic structuring *origin* being run through the same
  // scoring path a compromised/complicit business account would be, not an actual account of the
  // demo's own business -- GET /business-accounts (the dashboard's "Business Accounts" panel) is
  // a curated registry of the latter, and this id has no business appearing in it once seeding
  // is done scoring it.
  db.prepare('INSERT OR IGNORE INTO business_accounts (account_id, created_at) VALUES (?, ?)').run(sender, isoAt(startMs));
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

  // Un-register: this id was only ever a scoring-path device (see the comment above), not a real
  // account of the demo's own business -- it must not linger in GET /business-accounts/the
  // dashboard's "Business Accounts" panel after the fact.
  db.prepare('DELETE FROM business_accounts WHERE account_id = ?').run(sender);

  return alerts.find((a) => a.sender_id === sender) || null;
}

// Historical version of simulator/simulate_transactions.js's triggerOutboundFraudScenario: a
// business account rapidly drains funds to several fresh, never-paid-before receivers, from a
// new device, with an implausible location jump -- the outbound account-takeover pattern this
// system actually catches (unlike runFraudEvent above, which is inbound and kept only for
// reference/comparison -- see architecture.md Section 4.1).
async function runOutboundFraudEvent(db, startMs) {
  const hub = DEMO_CITY_HUBS[Math.floor(Math.random() * DEMO_CITY_HUBS.length)];
  const sender = randomMerchantAccount();
  const gateway = randomGateway();
  const device = randomId('d');

  let t = startMs;
  for (let i = 0; i < 5; i += 1) {
    await insertTransaction(db, {
      sender_id: sender,
      receiver_id: randomId('u_drain_target_hist'),
      amount: 500 + i * 50,
      timestamp: isoAt(t),
      location: { lat: hub.lat, lng: hub.lng },
      device_id: device,
      merchant_id: gateway,
      transaction_type: 'transfer',
    });
    t += 300;
  }

  const farHub = [...DEMO_CITY_HUBS].sort(
    (a, b) => haversine(b.lat, b.lng, hub.lat, hub.lng) - haversine(a.lat, a.lng, hub.lat, hub.lng)
  )[0];

  return insertTransaction(db, {
    sender_id: sender,
    receiver_id: randomId('u_drain_target_hist'),
    amount: 550,
    timestamp: isoAt(t),
    location: { lat: farHub.lat, lng: farHub.lng },
    device_id: randomId('d_new'),
    merchant_id: gateway,
    transaction_type: 'transfer',
  });
}

// Historical version of triggerRefundFraudScenario: a business account issues a large
// refund-purpose payment to a customer it has no record of ever selling anything to.
async function runRefundFraudEvent(db, atMs) {
  const sender = randomMerchantAccount();
  const gateway = randomGateway();

  return insertTransaction(db, {
    sender_id: sender,
    receiver_id: randomId('u_refund_target_hist'),
    amount: 8000,
    timestamp: isoAt(atMs),
    merchant_id: gateway,
    purpose: `Refund - order #${Math.floor(100000 + Math.random() * 900000)}`,
    transaction_type: 'transfer',
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[seed] generating ${args.count} normal + ${args.anomalies} anomaly + ${args.fraud} fraud (inbound, reference only) + ` +
      `${args.structuring} structuring + ${args.outboundFraud} outbound-fraud + ${args.refundFraud} refund-fraud events, ` +
      `evenly spread across the last ${args.hours}h`
  );

  const db = initDb();

  // Fraud/AML rule+ML scoring only runs for registered business accounts (see insertTransaction
  // above) -- pre-register the simulator's known storefront accounts so seeded outbound events
  // (and any refund/payout rows runNormalEvent generates) score under the real outbound model
  // rather than silently auto-allowing. Mirrors simulator/simulate_transactions.js's
  // ensureMerchantAccountsRegistered, just via a direct insert instead of the HTTP API.
  const registerBusinessAccount = db.prepare(
    'INSERT OR IGNORE INTO business_accounts (account_id, created_at) VALUES (?, ?)'
  );
  const seedTimeIso = new Date().toISOString();
  for (const accountId of MERCHANT_RECEIVER_POOL) {
    registerBusinessAccount.run(accountId, seedTimeIso);
  }

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

  const outboundFraudSlot = windowMs / args.outboundFraud;
  for (let i = 0; i < args.outboundFraud; i += 1) {
    const at = windowStartMs + i * outboundFraudSlot + Math.random() * outboundFraudSlot;
    events.push({ at, run: () => runOutboundFraudEvent(db, at) });
  }

  const refundFraudSlot = windowMs / args.refundFraud;
  for (let i = 0; i < args.refundFraud; i += 1) {
    const at = windowStartMs + i * refundFraudSlot + Math.random() * refundFraudSlot;
    events.push({ at, run: () => runRefundFraudEvent(db, at) });
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

  // Same reasoning as runStructuringEvent's own direct runScanCycle call: this seed script never
  // runs alongside a live server, so nothing would otherwise ever run graphIntelligence's periodic
  // union-find cluster scan (normally server/structuring/backgroundJob.js's 7s interval) against
  // the graph_edges just written above -- do it once, now, so "Discovered Risky Clusters" has
  // real content the instant the dashboard opens, not just once a server has been running for a
  // while. Idempotent (persistDiscoveredClusters upserts by deterministic cluster_id), so running
  // this again after a live server's own scans have already run is harmless.
  const newClusters = runGraphClusterScan(db, Date.now());

  const alertCount = db.prepare('SELECT COUNT(*) AS n FROM structuring_alerts').get().n;
  const clusterCount = db.prepare('SELECT COUNT(*) AS n FROM graph_clusters').get().n;
  const totalRows = db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;

  console.log(
    `[seed] done. ${totalRows} transactions written -- allow=${TALLY.allow} step_up=${TALLY.step_up} ` +
      `block=${TALLY.block}; ${alertCount} structuring alerts created; ${clusterCount} risky cluster(s) discovered ` +
      `(${newClusters.length} new this run)` +
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
