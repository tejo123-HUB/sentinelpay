// Generates realistic demo traffic against a running SentinelPay server: a continuous stream of
// normal customer-pays-merchant commerce (purchases, refunds, store-credit top-ups, settlement
// payouts — see generateNormalTransaction below), plus on-demand scripted scenarios for a
// single-transaction fraud block and a full structuring/layering pattern (architecture.md
// Section 10, Task 4). Fraud/AML rule+ML scoring is outbound-only (money leaving the business —
// see architecture.md Section 4.1): --scenario=fraud/odd-hour are inbound and kept only for
// reference/comparison (no longer expected to block); --scenario=outbound-fraud/refund-fraud are
// the scenarios this system actually catches. --scenario=normal periodically injects a genuine
// account-takeover burst (see NORMAL_STREAM_RISK_INJECTION_INTERVAL below) so a live demo feed
// shows real detections, not just an unbroken stream of "allow".
//
// Usage:
//   node simulator/simulate_transactions.js --scenario=normal --count=100 --rate=150
//   node simulator/simulate_transactions.js --scenario=fraud          (inbound, no longer blocks — see above)
//   node simulator/simulate_transactions.js --scenario=structuring
//   node simulator/simulate_transactions.js --scenario=odd-hour       (inbound, no longer blocks — see above)
//   node simulator/simulate_transactions.js --scenario=outbound-fraud
//   node simulator/simulate_transactions.js --scenario=refund-fraud
//   node simulator/simulate_transactions.js --scenario=merchant-takeover
//   node simulator/simulate_transactions.js --scenario=mule
//   node simulator/simulate_transactions.js --scenario=all
//   node simulator/simulate_transactions.js --scenario=normal --continuous   (Ctrl+C to stop)

require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { API_KEY, DEFAULT_DEV_API_KEY } = require('../server/middleware/apiKeyAuth');
const getOutboundContext = require('../server/outboundContext');

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

// Regression (found by actually running --scenario=normal against a live server and inspecting
// the flags it produced): "normal" traffic was tripping refund_without_purchase and the adaptive
// velocity rule on a meaningful share of transactions, which is not realistic input for a stream
// meant to read as clean. Two root causes, both fixed by the state below:
//
// 1. Refunds picked a uniformly random customer with no regard for whether that customer had
//    ever actually bought from that merchant account -- purchaseLedger tracks real purchase
//    records per (merchant, customer) pair so a refund can only be generated against genuine
//    prior purchase history, capped at what's actually left to refund, exactly like a real
//    business. It also respects server/outboundContext.js's OUTBOUND_MIN_PURCHASE_AGE_MS: the
//    real refundWithoutPurchase.js rule only counts a purchase as refundable once it's at least
//    that old (an anti-forgery guard against fabricate-then-immediately-refund), so a purchase
//    this ledger just recorded isn't actually usable as refund credit yet either -- ignoring that
//    would just trade one false flag for another.
// 2. server/rules/velocity.js is adaptive: it z-scores this burst's spacing against the sender's
//    *own* learned baseline (server/adaptiveBaseline.js), defaulting to a 5-minute assumed
//    interval (ADAPTIVE_BASELINE.VELOCITY_DEFAULT_INTERVAL_MS) until a merchant account has
//    established one. Refunds/settlements are rare (~8% of traffic) but purely random timing
//    occasionally clustered 3+ of them from the same low-frequency merchant account within the
//    60-second velocity window -- exactly the "burst against your own normal pace" signal the
//    rule is designed to catch, just triggered by simulator bad luck instead of a real burst.
//    lastMerchantOutboundEventMs enforces real spacing between a merchant account's own
//    refund/settlement events so they never cluster like that.
const OUTBOUND_MIN_PURCHASE_AGE_MS = getOutboundContext.OUTBOUND_MIN_PURCHASE_AGE_MS;
const purchaseLedger = new Map(); // merchantAccount -> Map(customerId -> Array<{ amountRemaining, atMs }>)
const lastMerchantOutboundEventMs = new Map(); // merchantAccount -> timestamp of its last refund/settlement
const MIN_MERCHANT_OUTBOUND_INTERVAL_MS = 90 * 1000; // comfortably above the 60s velocity window
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

function eligibleCredit(entries, nowMs) {
  return entries
    .filter((e) => nowMs - e.atMs >= OUTBOUND_MIN_PURCHASE_AGE_MS)
    .reduce((sum, e) => sum + e.amountRemaining, 0);
}

function pickRefundableCustomer(merchantAccount, nowMs) {
  const merchantLedger = purchaseLedger.get(merchantAccount);
  if (!merchantLedger) return null;
  const eligible = [];
  for (const [customerId, entries] of merchantLedger.entries()) {
    const credit = eligibleCredit(entries, nowMs);
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

function merchantOutboundEventReady(merchantAccount, nowMs) {
  const last = lastMerchantOutboundEventMs.get(merchantAccount) || 0;
  return nowMs - last >= MIN_MERCHANT_OUTBOUND_INTERVAL_MS;
}

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

async function postMerchantLogin(baseUrl, login) {
  const res = await fetch(`${baseUrl}/merchant-logins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(login),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// Fraud/AML rule+ML scoring only runs for transactions whose sender is a registered business
// account (architecture.md Section 4.1) -- registration is normally a manual, owner-driven step
// via the dashboard's Business Accounts strip, but the simulator already knows exactly which
// IDs are the business's own storefronts (MERCHANT_RECEIVER_POOL), so it self-registers them
// here rather than requiring a manual click before any outbound scenario/detector can be
// demonstrated. Idempotent server-side (POST /business-accounts is INSERT OR IGNORE) -- safe to
// call on every run. Best-effort: a registration failure here shouldn't crash whichever scenario
// the caller actually asked for.
async function ensureMerchantAccountsRegistered(baseUrl) {
  await Promise.all(
    MERCHANT_RECEIVER_POOL.map(async (accountId) => {
      try {
        await fetch(`${baseUrl}/business-accounts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
          body: JSON.stringify({ account_id: accountId }),
        });
      } catch (err) {
        console.warn(`[simulator] could not register ${accountId} as a business account:`, err.message);
      }
    })
  );
}

// Models the business's actual money flow, not generic person-to-person transfers: a customer
// mostly pays one of the business's storefronts, occasionally the business refunds a customer
// or settles funds out to its bank — the two cases that carry a human-readable `purpose` note,
// mirroring what a real risk/compliance analyst would actually see in this data (architecture.md
// Section 1).
function generateOrdinaryPurchase(customer, merchantAccount, gateway, customerLocation, transactionType, nowMs) {
  const amount = Math.max(10, jitter(customer.typicalAmount, customer.typicalAmount * 0.3));
  recordPurchaseCredit(merchantAccount, customer.id, amount, nowMs);
  return {
    sender_id: customer.id,
    receiver_id: merchantAccount,
    amount: Math.round(amount * 100) / 100,
    timestamp: new Date().toISOString(),
    location: customerLocation,
    device_id: customer.device,
    merchant_id: gateway,
    transaction_type: transactionType,
  };
}

function generateNormalTransaction() {
  const customer = CUSTOMER_POOL[Math.floor(Math.random() * CUSTOMER_POOL.length)];
  const merchantAccount = randomMerchantAccount();
  const gateway = randomGateway();
  // Small jitter approximating real GPS noise for "still at home" (~tens of meters), not an
  // independent multi-km random jump every transaction.
  const customerLocation = { lat: jitter(customer.homeLat, 0.0003), lng: jitter(customer.homeLng, 0.0003) };
  const roll = Math.random();
  const nowMs = Date.now();

  if (roll < 0.86) {
    // Ordinary purchase: customer pays the business. Builds this customer's refundable credit
    // with this merchant (purchaseLedger) so a later refund has real history to draw against.
    return generateOrdinaryPurchase(customer, merchantAccount, gateway, customerLocation, 'transfer', nowMs);
  }

  if (roll < 0.92) {
    // Merchant-initiated refund back to the customer — the case `purpose` exists for. No
    // device_id: this is a business-initiated payout, not something the customer's own device
    // touched — setting it to the customer's device previously made every refund look like a
    // "device mismatch" against the business account's own device history (it had never seen
    // the customer's device, and never would).
    //
    // Only refund a customer with real, still-outstanding purchase credit at this merchant
    // (purchaseLedger), capped at what's left -- refunding a random customer who never bought
    // anything here isn't "normal" traffic, it's exactly the refund_without_purchase laundering
    // pattern this system exists to catch. Also respects the outbound cooldown below, same
    // reasoning as the settlement branch.
    const refundable = merchantOutboundEventReady(merchantAccount, nowMs) ? pickRefundableCustomer(merchantAccount, nowMs) : null;
    if (!refundable) {
      return generateOrdinaryPurchase(customer, merchantAccount, gateway, customerLocation, 'transfer', nowMs);
    }
    const [refundCustomerId, credit] = refundable;
    const amount = Math.min(credit, Math.max(10, jitter(credit * 0.6, credit * 0.2)));
    consumeRefundCredit(merchantAccount, refundCustomerId, amount, nowMs);
    lastMerchantOutboundEventMs.set(merchantAccount, nowMs);
    return {
      sender_id: merchantAccount,
      receiver_id: refundCustomerId,
      amount: Math.round(amount * 100) / 100,
      timestamp: new Date().toISOString(),
      merchant_id: gateway,
      purpose: `Refund - order #${Math.floor(100000 + Math.random() * 900000)}`,
      transaction_type: 'transfer',
    };
  }

  if (roll < 0.98) {
    // Customer tops up stored/account credit with the business -- also real revenue, so it
    // builds refundable credit the same as an ordinary purchase.
    return generateOrdinaryPurchase(customer, merchantAccount, gateway, customerLocation, 'deposit', nowMs);
  }

  // The business settles funds out to its own bank account through this gateway. Gated by the
  // same per-merchant outbound cooldown as refunds above -- without it, this and a refund from
  // the same low-frequency merchant account landing within the same 60 seconds by chance reads
  // as a burst against that account's own (slow) normal pace to the adaptive velocity rule.
  if (!merchantOutboundEventReady(merchantAccount, nowMs)) {
    return generateOrdinaryPurchase(customer, merchantAccount, gateway, customerLocation, 'transfer', nowMs);
  }
  lastMerchantOutboundEventMs.set(merchantAccount, nowMs);
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

// Roughly one genuine risk burst injected per this many ordinary transactions -- a live demo
// feed that's 100% clean traffic doesn't show the fraud engine actually doing anything. This
// reuses triggerOutboundFraudScenario (the same real account-takeover pattern --scenario=
// outbound-fraud runs standalone) rather than fabricating a shortcut block: every flag it
// produces is the genuine rule/ML pipeline reacting to a genuinely risky pattern, not simulator
// noise -- unlike the refund/velocity false positives generateNormalTransaction used to produce
// on ordinary traffic before this fix (see the purchaseLedger/lastMerchantOutboundEventMs
// comment above generateNormalTransaction).
const NORMAL_STREAM_RISK_INJECTION_INTERVAL = 40;

async function runNormalStream(baseUrl, count, rateMs, continuous) {
  console.log(`[normal] streaming ${continuous ? 'continuously' : count + ' transactions'} at ~${rateMs}ms intervals`);
  let sent = 0;
  // eslint-disable-next-line no-constant-condition
  while (continuous || sent < count) {
    if (sent > 0 && sent % NORMAL_STREAM_RISK_INJECTION_INTERVAL === 0) {
      console.log('[normal] injecting a genuine account-takeover burst so the live feed shows real detection, not just clean traffic...');
      await triggerOutboundFraudScenario(baseUrl);
    }
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

// Single-transaction card-testing pattern (velocity + impossible travel + device mismatch)
// targeting one of the business's storefronts — kept for reference/comparison, but no longer
// expected to be blocked: fraud/AML behavioral scoring is now outbound-only (money leaving the
// business), and this is an inbound attack (a customer paying the merchant with a stolen card).
// That's the card network's/payment gateway's problem to catch (CVV, 3D-Secure, chargebacks),
// not money laundering or theft of the business's own funds — see --scenario=outbound-fraud for
// the equivalent attack this system actually polices.
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
  if (finalResult.body && finalResult.body.decision === 'allow' && (finalResult.body.reasons || []).length === 0) {
    console.log(
      "[fraud] OK: correctly allowed with no flags — this is an inbound attack (a customer paying the merchant), " +
        'and fraud/AML scoring only runs on money leaving the business now. See --scenario=outbound-fraud for the ' +
        'attack this system actually catches.'
    );
  } else {
    console.warn(
      '[fraud] unexpected: inbound transactions should always auto-allow with no flags now (unless caught by an ' +
        'active structuring alert) — got:',
      finalResult.body
    );
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

// Kept for reference/comparison, same as triggerFraudScenario above: this is an inbound
// transaction (a customer paying the merchant), and rule-based scoring — odd-hour included — is
// now outbound-only, so this no longer produces a flag. Originally demonstrated the odd-hour
// rule live without weakening the timestamp-security fix (architecture.md Section 15.2, finding
// #1 / Section 15.4): POST /transaction always scores against server-received time, so a live
// demo can't fake "this account has days of daytime history, and it's now 3am" using a
// client-supplied timestamp — that's the security fix working as intended. This seeds a
// realistic-looking historical baseline directly into the demo database (bypassing the API
// entirely — the same way a real account's baseline would only exist after real accumulated
// usage), then sends exactly one transaction through the *real* API at genuine current time.
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
  if (result.body && result.body.decision === 'allow' && (result.body.reasons || []).length === 0) {
    console.log(
      '[odd-hour] OK: correctly allowed with no flags — inbound transactions (a customer paying the merchant) ' +
        'are no longer rule-scored, odd-hour included. See --scenario=outbound-fraud for a scenario this system ' +
        'actually catches.'
    );
  } else {
    console.warn('[odd-hour] unexpected: inbound transactions should auto-allow with no flags now — got:', result.body);
  }
  return result;
}

// The flagship "single-transaction fraud block" demo under the outbound-only model: a
// compromised business account (one of the business's own storefronts, picked at random)
// rapidly drains funds to several fresh, never-paid-before receivers, from a new device, with an
// implausible location jump — the outbound equivalent of the old --scenario=fraud (which
// attacked the merchant from the customer side, no longer scored — see triggerFraudScenario
// above). Triggers velocity + device mismatch + impossible travel from the existing rule set,
// plus payoutToNewReceiver.js and outboundFanOutBurst.js from the new outbound-only detectors.
async function triggerOutboundFraudScenario(baseUrl) {
  const sender = randomMerchantAccount(); // one of the business's own accounts, "compromised"
  const gateway = randomGateway();
  const homeLat = 16.5062;
  const homeLng = 80.648;
  const device = randomId('d');

  console.log(
    `[outbound-fraud] scripted account-takeover from ${sender}: rapid payouts to new receivers + a 400km+ jump on a new device`
  );

  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await postTransaction(baseUrl, {
      sender_id: sender,
      receiver_id: randomId('u_drain_target'),
      amount: 500 + i * 50,
      timestamp: new Date().toISOString(),
      location: { lat: homeLat, lng: homeLng },
      device_id: device,
      merchant_id: gateway,
      transaction_type: 'transfer',
    });
    await sleep(300);
  }

  // Final payout: new device, far-away location, seconds after the last one, to yet another
  // fresh receiver.
  const finalResult = await postTransaction(baseUrl, {
    sender_id: sender,
    receiver_id: randomId('u_drain_target'),
    amount: 550,
    timestamp: new Date().toISOString(),
    location: { lat: 28.6139, lng: 77.209 }, // Delhi, ~1200km from the home location, seconds later
    device_id: randomId('d_new'),
    merchant_id: gateway,
    transaction_type: 'transfer',
  });

  console.log('[outbound-fraud] final transaction result:', finalResult.body);
  if (finalResult.body && finalResult.body.decision === 'block') {
    console.log('[outbound-fraud] OK: scripted account-takeover pattern was blocked as expected');
  } else {
    console.warn('[outbound-fraud] WARNING: expected a block decision, got:', finalResult.body && finalResult.body.decision);
  }
  return finalResult;
}

// Demonstrates refundWithoutPurchase.js: a business account issues a large refund-purpose
// payment to a customer it has no record of ever selling anything to — the "fake refund"
// laundering pattern, money leaving the business with no legitimate revenue behind it.
async function triggerRefundFraudScenario(baseUrl) {
  const sender = randomMerchantAccount();
  const gateway = randomGateway();
  const customer = randomId('u_refund_target'); // a fresh account this business has never actually sold to

  console.log(`[refund-fraud] scripted fake refund from ${sender} to ${customer} (no matching prior purchase)`);

  const result = await postTransaction(baseUrl, {
    sender_id: sender,
    receiver_id: customer,
    amount: 8000,
    timestamp: new Date().toISOString(),
    merchant_id: gateway,
    purpose: `Refund - order #${Math.floor(100000 + Math.random() * 900000)}`,
    transaction_type: 'transfer',
  });

  console.log('[refund-fraud] result:', result.body);
  const flaggedRefundFraud = Boolean(
    result.body &&
      result.body.reasons &&
      result.body.reasons.some((r) => /no matching prior purchase|exceeds this customer's total prior purchases/.test(r))
  );
  if (flaggedRefundFraud) {
    console.log('[refund-fraud] OK: refund with no matching purchase was correctly flagged');
  } else {
    console.warn('[refund-fraud] WARNING: expected a refundWithoutPurchase flag, got:', result.body);
  }
  return result;
}

// Section 16, Category 22: demonstrates merchantAccountTakeover.js -- a login from a device/
// country never seen on this business account before, immediately followed by a refund.
async function triggerMerchantTakeoverScenario(baseUrl) {
  const sender = randomMerchantAccount();
  const gateway = randomGateway();
  const victim = randomId('u_takeover_victim');

  console.log(`[merchant-takeover] scripted account takeover on ${sender}: unrecognized device/country login, then an immediate refund`);

  await postMerchantLogin(baseUrl, { merchant_id: sender, device_id: randomId('d_known'), country: 'IN' });
  await sleep(200);
  await postMerchantLogin(baseUrl, { merchant_id: sender, device_id: randomId('d_attacker'), country: 'RU' });
  await sleep(200);

  const result = await postTransaction(baseUrl, {
    sender_id: sender,
    receiver_id: victim,
    amount: 6000,
    timestamp: new Date().toISOString(),
    merchant_id: gateway,
    purpose: `Refund - order #${Math.floor(100000 + Math.random() * 900000)}`,
    transaction_type: 'transfer',
  });

  console.log('[merchant-takeover] result:', result.body);
  if (result.body && result.body.decision === 'block') {
    console.log('[merchant-takeover] OK: unrecognized-device login followed by a refund was blocked as expected');
  } else {
    console.warn('[merchant-takeover] WARNING: expected a block decision, got:', result.body && result.body.decision);
  }
  return result;
}

// Section 16, Category 22: demonstrates muleReceiverRisk.js -- a receiver with a lifetime
// receive-then-quickly-drain pattern, flagged when a business account pays them.
async function triggerMuleScenario(baseUrl) {
  const sender = randomMerchantAccount();
  const gateway = randomGateway();
  const muleAccount = randomId('u_mule');

  console.log(`[mule] scripted mule pattern on ${muleAccount}: receives from outside accounts, quickly drains most of it, twice`);

  for (let i = 0; i < 2; i += 1) {
    const outsideSender = randomId('u_outside');
    await postTransaction(baseUrl, {
      sender_id: outsideSender,
      receiver_id: muleAccount,
      amount: 2000,
      timestamp: new Date().toISOString(),
      transaction_type: 'transfer',
    });
    await sleep(200);
    await postTransaction(baseUrl, {
      sender_id: muleAccount,
      receiver_id: randomId('u_downstream'),
      amount: 1800,
      timestamp: new Date().toISOString(),
      transaction_type: 'transfer',
    });
    await sleep(200);
  }

  // Now the business account pays this mule -- muleReceiverRisk.js should flag it.
  const result = await postTransaction(baseUrl, {
    sender_id: sender,
    receiver_id: muleAccount,
    amount: 500,
    timestamp: new Date().toISOString(),
    merchant_id: gateway,
    purpose: `Vendor settlement #${Math.floor(1000 + Math.random() * 9000)}`,
    transaction_type: 'transfer',
  });

  console.log('[mule] final payout to the mule account result:', result.body);
  const flaggedMule = Boolean(result.body && result.body.reasons && result.body.reasons.some((r) => /Suspected Mule Account/.test(r)));
  if (flaggedMule) {
    console.log('[mule] OK: payout to a suspected mule account was correctly flagged');
  } else {
    console.warn('[mule] WARNING: expected a muleReceiverRisk flag, got:', result.body);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`SentinelPay simulator :: scenario=${args.scenario} baseUrl=${args.baseUrl}`);

  await ensureMerchantAccountsRegistered(args.baseUrl);

  if (args.scenario === 'normal') {
    await runNormalStream(args.baseUrl, args.count, args.rate, args.continuous);
  } else if (args.scenario === 'fraud') {
    await triggerFraudScenario(args.baseUrl);
  } else if (args.scenario === 'structuring') {
    await triggerStructuringScenario(args.baseUrl);
  } else if (args.scenario === 'odd-hour') {
    await triggerOddHourScenario(args.baseUrl);
  } else if (args.scenario === 'outbound-fraud') {
    await triggerOutboundFraudScenario(args.baseUrl);
  } else if (args.scenario === 'refund-fraud') {
    await triggerRefundFraudScenario(args.baseUrl);
  } else if (args.scenario === 'merchant-takeover') {
    await triggerMerchantTakeoverScenario(args.baseUrl);
  } else if (args.scenario === 'mule') {
    await triggerMuleScenario(args.baseUrl);
  } else if (args.scenario === 'all') {
    await runNormalStream(args.baseUrl, 20, args.rate, false);
    await triggerFraudScenario(args.baseUrl);
    await triggerStructuringScenario(args.baseUrl);
    await triggerOddHourScenario(args.baseUrl);
    await triggerOutboundFraudScenario(args.baseUrl);
    await triggerRefundFraudScenario(args.baseUrl);
    await triggerMerchantTakeoverScenario(args.baseUrl);
    await triggerMuleScenario(args.baseUrl);
  } else {
    console.error(
      `Unknown scenario "${args.scenario}". Use normal | fraud | structuring | odd-hour | outbound-fraud | refund-fraud | merchant-takeover | mule | all.`
    );
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
  triggerOutboundFraudScenario,
  triggerRefundFraudScenario,
  triggerMerchantTakeoverScenario,
  triggerMuleScenario,
  postMerchantLogin,
  randomId,
  randomGateway,
  randomMerchantAccount,
  DEMO_CITY_HUBS,
  MERCHANT_RECEIVER_POOL,
  GATEWAY_POOL,
};
