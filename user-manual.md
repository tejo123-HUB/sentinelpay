# SentinelPay — User Manual
### How It Actually Works, Explained in Plain Language

This document explains SentinelPay for someone who has never seen the code — a judge, a teammate joining late, or you six months from now. It focuses on **what happens in the real world** when a transaction flows through the system, with concrete worked examples.

---

## 1. What Problem Is This Solving, in Plain Terms?

Imagine you run a merchant business — an online store, a marketplace, a subscription service. Every second, thousands of small payments flow through your system — someone buying a ₹40 item, someone paying a ₹200 subscription renewal, someone getting a ₹500 refund. You take those payments through several payment gateways (Stripe, Razorpay, PayPal, and the like), and each gateway only shows you its own slice of the picture. Somewhere across that flood, spread across gateways so no single one sees the whole pattern, a small number of these transactions are fraudulent or are part of a money-laundering operation hiding inside otherwise-ordinary commerce.

You can't manually review millions of transactions. You also can't afford to slow every single payment down by seconds while a heavyweight fraud check runs — customers would abandon checkout. And you can't just block anything unusual, because that would also block your genuine customers, which costs you their trust and their business.

**SentinelPay sits in the middle of that payment flow, wired into every gateway you use** — between "customer hits pay" and "money actually moves" — and makes an instant decision: let it through, ask for extra verification, or stop it, all within milliseconds, without a human ever looking at it in real time. Your own senior risk/compliance team gets one aggregated view across every gateway, instead of piecing it together from several separate dashboards.

---

## 2. Who "Uses" This System, and How?

There's no separate app end-users open. Instead, three groups interact with SentinelPay differently:

| Who | What they see | How |
|---|---|---|
| **Each payment gateway you use (Stripe, Razorpay, PayPal, etc.)** | Nothing visual — just an API response | Sends every transaction to `POST /transaction`, gets back a decision in milliseconds, and acts on it (allow the payment / show an OTP screen / reject it) |
| **Your business's senior risk/compliance team** | The live dashboard | Watches transactions stream in across every gateway, sees flagged ones highlighted, investigates structuring alerts |
| **The end customer paying money** | Nothing directly — but they experience the outcome | A normal payment goes through instantly; a suspicious one might trigger an OTP prompt; a blocked one shows as "transaction declined" |

So in real deployment, SentinelPay is invisible infrastructure — like a security guard checking IDs at a door so fast that honest visitors barely notice, while stopping the ones who shouldn't get through.

---

## 3. The Journey of a Single Transaction (Step by Step)

Here's exactly what happens, in order, every time money moves:

1. **A transaction is initiated** — a customer paying the business, or the business sending money out (a refund, a payout, a bank settlement).
2. **The gateway calls `POST /transaction`** with details: who's sending, who's receiving, how much, from where, from which device, and what type of transaction it is.
3. **SentinelPay saves the transaction** to its database immediately, so there's a permanent record regardless of the outcome.
4. **A fast lookup always checks**: is this sender or receiver already flagged as part of a known money-laundering pattern from the background structuring analysis (explained in Section 5)? This runs on *every* transaction, no exceptions — a known laundering ring doesn't get a pass just because it's paying the business instead of being paid by it.
5. **If money is leaving the business** (the sender is one of your registered business accounts — see Section 8), the full behavioral analysis runs: five general-purpose rule checks (is this account sending money unusually fast? did it just "teleport" to a new city? is this amount way bigger than usual? is this an unrecognized device? is this a strange hour?), four checks purpose-built for outbound risk (is this refund backed by a real purchase? is this a receiver we've never paid before? are we paying out far more than we're taking in? are we suddenly fanning out to several new receivers at once?), and a machine learning model catching subtler patterns. A customer simply paying the business skips this step entirely and goes straight to a decision — a stolen card used to pay you is the card network's/payment gateway's problem (chargebacks, CVV checks), not something this system polices.
6. **All of this combines into one fraud score from 0–100**, plus (for outbound transactions above a configurable amount) a hard floor that guarantees at least a step-up review regardless of score.
7. **A decision is made instantly:**
   - Score under 40 → **Allow** (payment goes through normally)
   - Score 40–80 → **Step-up** (ask for extra verification, like an OTP)
   - Score over 80 → **Block** (payment is stopped)
8. **The gateway receives this decision** in the same instant and acts on it — completing the payment, prompting for OTP, or showing a decline message.
9. **Everything is logged** to the live dashboard, so your risk team can see it happen in real time and investigate further if needed.

All of this — steps 3 through 8 — happens in well under a second.

---

## 4. Worked Example #1 — A Normal, Everyday Transaction

**Scenario:** Priya buys a ₹150 coffee from a café she visits every week, using her phone, during her regular lunch hour.

**What SentinelPay sees:** Priya is the customer here — money is moving *into* the business, not out of it — so no behavioral scoring runs at all (Section 3). The only check that ever runs regardless of direction is the structuring-alert lookup, and Priya's account isn't linked to any known laundering pattern.

**Result:** Fraud score 0 → **Allow**, instantly. Priya's payment completes without ever touching the rule engine or the ML model; she never knows any of this happened.

---

## 5. Worked Example #2 — A Compromised Business Account Draining Funds

**Scenario:** Someone gains access to one of your business's own payout accounts — a stolen admin credential, a compromised integration key. Within 90 seconds, it issues 6 rapid payouts to receivers it has never paid before, and the last one appears to originate 400 km away from where the previous one happened seconds earlier — physically impossible to travel in that time, and from a device never seen on this account before.

**What SentinelPay sees:**
- **Velocity check** flags it: 6 payouts in under 2 minutes is far above normal for this account.
- **Impossible travel check** flags it: 400 km in under a minute implies an impossible speed.
- **Device mismatch check** flags it: this device has never been linked to this business account before.
- **Payout to new receiver** flags it: several of these receivers have never been paid by this account before.
- **Outbound fan-out burst** flags it: three or more distinct new receivers paid within a 10-minute window is exactly the shape a draining attack produces — catchable immediately, without waiting for the slower background structuring scan.

**Result:** These flags combine into a fraud score well above 80 → **Block**. The response includes the reasons, e.g.:
```json
{
  "decision": "block",
  "fraud_score": 100,
  "reasons": [
    "6 transactions in 90 seconds",
    "412 km location jump in under 60 seconds",
    "Transaction from a previously unseen device",
    "Payout to a receiver this business account has never paid before",
    "3 distinct new payout receivers in a short window"
  ]
}
```
This is what makes the system trustworthy — it's not a black box saying "blocked," it's giving specific, human-readable reasons your risk team can understand immediately. Notice what's *not* here: nothing about the customers paying you. A stolen card used to pay your business is the card network's/payment gateway's problem (chargebacks, CVV checks) — this system is watching money leave the business, not money arriving from customers.

---

## 6. Worked Example #3 — The Middle Ground (Step-Up Review)

**Scenario:** Your business issues a ₹8,000 refund to a customer — but that customer has no record of ever actually buying anything from this business account. On its own, this isn't necessarily malicious (maybe it's a goodwill gesture, maybe a rare cross-account edge case), but it's exactly the shape a fake-refund laundering attempt takes, so it shouldn't sail through unreviewed either.

**What SentinelPay sees:**
- **Refund without purchase check** flags it: the refund has no matching prior purchase from this customer at this business account.
- Nothing else is unusual — no velocity issue, no new-device flag, no fan-out pattern.

**Result:** One moderate flag pushes the score into the 40–80 range → **Step-up review**, not an automatic block. This is the system protecting against false positives — a single unusual refund gets flagged for a human to look at, rather than being either silently allowed or aggressively blocked outright.

---

## 7. Worked Example #4 — The Structuring / Money-Laundering Pattern (the system's signature feature)

This is the scenario that most fraud systems miss entirely, because no single transaction in it looks suspicious on its own.

**Scenario:** An account (Account A) is being used to launder ₹80,000. Instead of one large, obviously suspicious transfer, the money is split into 40 separate transactions of ₹2,000 each — each individually small enough to avoid triggering a single-transaction alert. These are sent to 6 different receiving accounts (B, C, D, E, F, G) within a 10-minute window. Five of those six receiving accounts then withdraw more than 80% of what they received within the next 30 minutes — a classic "mule account" pattern.

**What a naive fraud system would see:** 40 individual ₹2,000 transactions, each unremarkable on its own. Nothing gets flagged. The laundering succeeds.

**What SentinelPay sees:**
1. The **background structuring job** (running every 5–10 seconds) notices Account A has sent an unusually large *total* (₹80,000) across an unusually large *number* of small transactions (40) within a short window — this trips the **split detection** threshold.
2. It then checks: how many different accounts did A pay in that window? Six distinct receivers, none of whom A had ever transacted with before — this trips **fan-out detection**.
3. It then watches those six receiving accounts: five of them withdraw over 80% of what they just received within 30 minutes — this trips **rapid withdrawal correlation**, the "mule account" signal.
4. All of this gets bundled into a **single structuring alert** — not 40 separate low-value flags, which would be noise a human analyst couldn't act on.

**What shows up on the dashboard:**
```json
{
  "type": "structuring_alert",
  "sender_id": "A",
  "receiver_ids": ["B", "C", "D", "E", "F", "G"],
  "total_amount": 80000,
  "transaction_count": 40,
  "withdrawal_ratio": 0.83,
  "window": "10 minutes"
}
```
A fraud analyst sees one clear, actionable alert: *"₹80,000 structured across 40 transactions from Account A into 6 accounts; 5 of them withdrew 83% of received funds within 30 minutes."* Any future transaction touching Account A or the linked receiver accounts is now automatically pushed toward the "block" tier, even if that individual transaction looks small and unremarkable — because the system now knows it's part of a known pattern.

**Why this matters in real life:** This is exactly the technique real money launderers use to stay under the radar of transaction-by-transaction monitoring (a technique commonly called "smurfing" or "structuring"). Catching it requires looking at *relationships between accounts over time*, not just individual transactions — which is what makes this feature genuinely differentiated, not just another fraud checklist item.

---

## 8. How the Dashboard Is Actually Used (Real-World Workflow)

In a real deployment, a fraud operations analyst would have this dashboard open on a screen throughout their shift:

- A **live table** scrolls with every transaction as it's processed, color-coded green (allow), yellow (step-up), red (block). Sender and receiver are collapsed into one **ID** column showing whichever side is the customer — the business side is inferred from the **Business Accounts** registry (below), so an analyst doesn't have to mentally filter out their own accounts on every row.
- A **Business Accounts** strip lets you register which account IDs are your own (a text field, editable any time) — this is what tells the system which side of a transaction is "the business" for both the dashboard's ID column *and* the fraud detection pipeline itself: only transactions sent *from* a registered business account get behavioral fraud/AML scoring at all (Section 3).
- **Counters** at the top show at a glance: how many transactions processed today, how many flagged, how many blocked, how many stepped up.
- A **dedicated structuring alerts panel** surfaces laundering patterns as soon as they're detected — this is the panel an analyst would check first, since it represents the highest-value, hardest-to-spot-manually cases.
- Clicking into any flagged transaction or alert shows the human-readable reasons, so the analyst doesn't have to reverse-engineer *why* something was flagged.

In the hackathon demo specifically, this dashboard is what you'd have projected on screen while your simulator runs — judges watch transactions flow in live, then watch a scripted attack get caught and explained on screen in real time.

---

## 9. What Happens After a Block or Alert, in a Real Deployment?

It's worth being honest about scope here: SentinelPay makes the **real-time decision** (allow/step-up/block) and raises alerts. In a full production system, a few things would typically happen next, which are outside this project's current scope but worth understanding for the pitch:

- **Blocked transactions** would typically notify the customer and may require manual review by your own risk team before any restriction is lifted.
- **Structuring alerts** would typically be escalated to your business's own senior risk/compliance team for investigation — that's who's running this dashboard. If a pattern looks serious enough, they'd loop in whichever payment processor or banking partner is involved; formal anti-money-laundering (AML) reporting to regulators is that partner's statutory obligation, not something an ordinary merchant carries itself.
- **Step-up outcomes** feed back into the system over time — if a business account keeps confirming unusual-but-legitimate outbound transactions, its behavioral baseline (like `avg_transaction_amount`) naturally adjusts, reducing future false positives.

---

## 10. Quick Reference — The Three Outcomes

| Score | Outcome | What the payer experiences | What it usually means |
|---|---|---|---|
| < 40 | **Allow** | Payment completes instantly, no interruption | Transaction matches expected behavior |
| 40–80 | **Step-up** | Prompted for OTP/biometric confirmation | Something is unusual but not clearly fraudulent |
| > 80 | **Block** | Payment declined immediately | Strong evidence of fraud or a known laundering pattern |

---

*This manual complements `architecture.md` (the technical build spec) and `CLAUDE.md` (the build-automation entrypoint). Update this document if the real-world behavior of the system changes — e.g., if thresholds are retuned, or if the step-up flow changes.*
