// Partial-Feature Completion Pass: Section 26 "Future AI Features" -- AI Chat Assistant, Natural
// Language Fraud Search, AI Fraud Investigation Assistant, AI Fraud Report Generator, AI Fraud
// Insights. (Predictive Merchant Risk, the sixth item in this category, is covered by
// GET /merchants/:id/risk-forecast in server/routes/entityIntelligence.js -- server/forecasting.js
// -- not duplicated here.)
//
// PROD: Claude API (Anthropic) for genuinely free-form natural-language understanding and
// generation -- DEMO: every function here has a real, deterministic, rule-based implementation
// that requires no API key and always works, matching this project's `// PROD: X -- DEMO: Y`
// convention (mlClient.js's ML_SERVING_MODE=vertex stub, notifications.js's per-channel env-var
// gates). When ANTHROPIC_API_KEY is set, callLlm() genuinely calls the Claude API to produce a
// richer answer; on any failure (missing key, network error, bad response) it falls back to the
// deterministic path rather than erroring -- a demo running with no API key configured is not a
// degraded experience, it's the default one.
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-5';
const LLM_TIMEOUT_MS = 8000;
const LLM_MAX_TOKENS = 600;

function llmConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Calls the Claude API with a system prompt (the deterministic context this module already
 * gathered) and a user message. Returns null on any failure -- callers always have a
 * deterministic fallback and must never surface a raw API error to the dashboard.
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @returns {Promise<string|null>}
 */
async function callLlm(systemPrompt, userMessage) {
  if (!llmConfigured()) return null;
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: LLM_MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content || []).map((block) => block.text || '').join('').trim();
    return text || null;
  } catch {
    return null;
  }
}

// ---- Natural Language Fraud Search ----

const DECISION_PATTERNS = [
  { pattern: /\bblock(ed|s)?\b/i, decisions: ['block'] },
  { pattern: /\bstep.?up|\bchallenge(d)?\b|\b2fa\b|\botp\b/i, decisions: ['step_up'] },
  { pattern: /\ballow(ed)?\b/i, decisions: ['allow'] },
  { pattern: /\bflag(ged)?\b|\brisky\b|\bsuspicious\b/i, decisions: ['step_up', 'block'] },
];

const TIME_UNIT_MS = { hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };

const MAX_SEARCH_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 50;

/**
 * Parses a free-text fraud-search query into structured filters, entirely with regexes over
 * well-known phrasings ("blocked transactions over 5000 in the last 7 days") -- no LLM required
 * for this to work, since a fraud analyst's queries in practice cluster around a small,
 * predictable vocabulary (decision + amount threshold + time window).
 * @param {string} query
 * @returns {{ decisions: string[]|null, minAmount: number|null, maxAmount: number|null, sinceIso: string|null, limit: number, understood: string[] }}
 */
function parseNaturalLanguageQuery(query) {
  const text = (query || '').toLowerCase();
  const understood = [];

  let decisions = null;
  for (const { pattern, decisions: d } of DECISION_PATTERNS) {
    if (pattern.test(text)) {
      decisions = d;
      understood.push(`decision: ${d.join('/')}`);
      break;
    }
  }

  let minAmount = null;
  const overMatch = text.match(/(?:over|above|greater than|more than|>\s*)\s*₹?\s*([\d,]+(?:\.\d+)?)/);
  if (overMatch) {
    minAmount = Number(overMatch[1].replace(/,/g, ''));
    understood.push(`amount > ${minAmount}`);
  }

  let maxAmount = null;
  const underMatch = text.match(/(?:under|below|less than|<\s*)\s*₹?\s*([\d,]+(?:\.\d+)?)/);
  if (underMatch) {
    maxAmount = Number(underMatch[1].replace(/,/g, ''));
    understood.push(`amount < ${maxAmount}`);
  }

  let sinceIso = null;
  const relativeMatch = text.match(/last\s+(\d+)\s*(hour|day|week|month)s?/);
  if (relativeMatch) {
    const n = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    sinceIso = new Date(Date.now() - n * TIME_UNIT_MS[unit]).toISOString();
    understood.push(`in the last ${n} ${unit}(s)`);
  } else if (/\btoday\b/.test(text)) {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    sinceIso = startOfDay.toISOString();
    understood.push('today');
  } else if (/\byesterday\b/.test(text)) {
    sinceIso = new Date(Date.now() - TIME_UNIT_MS.day).toISOString();
    understood.push('in the last 24 hours');
  }

  const limitMatch = text.match(/\b(?:top|first|limit)\s+(\d+)\b/);
  const limit = limitMatch ? Math.min(Number(limitMatch[1]), MAX_SEARCH_LIMIT) : DEFAULT_SEARCH_LIMIT;

  return { decisions, minAmount, maxAmount, sinceIso, limit, understood };
}

/**
 * Executes a parsed query against the transactions table. Pure SQL, no LLM in the execution path
 * even if one was used (or not) to help parse the query -- this project's tables are the source
 * of truth, never something an LLM free-generates.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<typeof parseNaturalLanguageQuery>} parsed
 */
function executeNaturalLanguageSearch(db, parsed) {
  const clauses = [];
  const params = [];
  if (parsed.decisions) {
    clauses.push(`decision IN (${parsed.decisions.map(() => '?').join(',')})`);
    params.push(...parsed.decisions);
  }
  if (parsed.minAmount !== null) {
    clauses.push('amount > ?');
    params.push(parsed.minAmount);
  }
  if (parsed.maxAmount !== null) {
    clauses.push('amount < ?');
    params.push(parsed.maxAmount);
  }
  if (parsed.sinceIso) {
    clauses.push('timestamp >= ?');
    params.push(parsed.sinceIso);
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT transaction_id, sender_id, receiver_id, amount, timestamp, decision, fraud_score, purpose
       FROM transactions ${whereClause} ORDER BY timestamp DESC LIMIT ?`
    )
    .all(...params, parsed.limit);
  return rows;
}

// ---- AI Fraud Insights ----

/**
 * Compares the last `windowMs` against the equal-length period immediately before it, and
 * generates human-readable bullet insights from the deltas -- a real, traceable comparison
 * (Explainability's own "never just a score" rule extends naturally to this feature), not an
 * LLM-generated summary of numbers the LLM itself might get wrong.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} windowMs
 * @param {number} nowMs
 * @returns {string[]}
 */
function generateFraudInsights(db, windowMs, nowMs = Date.now()) {
  const currentSinceIso = new Date(nowMs - windowMs).toISOString();
  const priorSinceIso = new Date(nowMs - windowMs * 2).toISOString();

  function periodStats(sinceIso, untilIso) {
    return db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blocked,
          COALESCE(SUM(CASE WHEN decision = 'block' THEN amount ELSE 0 END), 0) AS blocked_amount,
          COALESCE(AVG(fraud_score), 0) AS avg_score
         FROM transactions WHERE timestamp >= ? AND timestamp < ?`
      )
      .get(sinceIso, untilIso);
  }

  const current = periodStats(currentSinceIso, new Date(nowMs).toISOString());
  const prior = periodStats(priorSinceIso, currentSinceIso);

  const insights = [];
  function percentChange(now, before) {
    if (before === 0) return now > 0 ? Infinity : 0;
    return ((now - before) / before) * 100;
  }

  const blockedChange = percentChange(current.blocked, prior.blocked);
  if (Number.isFinite(blockedChange) && Math.abs(blockedChange) >= 15) {
    insights.push(`Blocked transaction count ${blockedChange > 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(blockedChange))}% versus the previous period (${prior.blocked} -> ${current.blocked}).`);
  } else if (!Number.isFinite(blockedChange) && current.blocked > 0) {
    insights.push(`Blocked transactions went from 0 to ${current.blocked} versus the previous period.`);
  }

  const amountChange = percentChange(current.blocked_amount, prior.blocked_amount);
  if (Number.isFinite(amountChange) && Math.abs(amountChange) >= 15) {
    insights.push(`Blocked amount ${amountChange > 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(amountChange))}% versus the previous period (₹${prior.blocked_amount.toFixed(2)} -> ₹${current.blocked_amount.toFixed(2)}).`);
  }

  if (current.total > 0 && prior.total > 0 && Math.abs(current.avg_score - prior.avg_score) >= 5) {
    insights.push(`Average fraud score ${current.avg_score > prior.avg_score ? 'increased' : 'decreased'} from ${prior.avg_score.toFixed(1)} to ${current.avg_score.toFixed(1)}.`);
  }

  const newAlerts = db
    .prepare('SELECT COUNT(*) AS n FROM structuring_alerts WHERE created_at >= ?')
    .get(currentSinceIso).n;
  if (newAlerts > 0) {
    insights.push(`${newAlerts} new structuring/layering alert(s) were raised in this period.`);
  }

  if (insights.length === 0) {
    insights.push('No significant change in fraud activity compared to the previous period.');
  }

  return insights;
}

// ---- AI Fraud Report Generator ----

/**
 * Template-based narrative report (never an LLM free-generation of the numbers themselves --
 * every figure here comes straight from the same analytics queries GET /analytics/summary and
 * GET /analytics/trend already use, so the report can never state a number the underlying data
 * doesn't actually support).
 * @param {object} summary - GET /analytics/summary's response shape
 * @param {string[]} insights - from generateFraudInsights
 * @param {Array<{flag_type: string, count: number}>} topFrauds
 * @returns {string}
 */
function generateReportNarrative(summary, insights, topFrauds) {
  const lines = [];
  lines.push(
    `Over the reporting period, SentinelPay processed ${summary.total_processed} transaction(s), allowing ${summary.allowed}, step-up-challenging ${summary.step_up}, and blocking ${summary.blocked} (a ${summary.fraud_percent}% overall fraud rate).`
  );
  lines.push(`Blocked value totaled ₹${summary.blocked_amount.toFixed(2)}, with an estimated ₹${summary.recovered_amount.toFixed(2)} plausibly protected by step-up challenges.`);
  if (topFrauds.length > 0) {
    lines.push(`The most common detector was "${topFrauds[0].flag_type}" (${topFrauds[0].count} occurrence(s)).`);
  }
  for (const insight of insights) lines.push(insight);
  return lines.join(' ');
}

// ---- AI Chat Assistant / AI Fraud Investigation Assistant ----

/**
 * Deterministic intent router over a small, well-defined set of question shapes a fraud analyst
 * actually asks -- summary stats, a specific transaction/account lookup, top risky entities. Falls
 * back to a helpful "here's what I can answer" message for anything else, rather than pretending
 * to understand.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} message
 */
function answerDeterministically(db, message) {
  const text = (message || '').toLowerCase();

  const txIdMatch = message.match(/\bt_[a-z0-9-]{6,}\b/i);
  if (txIdMatch) {
    const row = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(txIdMatch[0]);
    if (!row) return `I couldn't find a transaction with id ${txIdMatch[0]}.`;
    const flags = db.prepare('SELECT reason FROM flags WHERE transaction_id = ?').all(row.transaction_id);
    const reasonText = flags.length > 0 ? ` Reasons: ${flags.map((f) => f.reason).join('; ')}.` : '';
    return `Transaction ${row.transaction_id}: ${row.sender_id} -> ${row.receiver_id}, ₹${row.amount}, scored ${row.fraud_score} (${row.decision}).${reasonText}`;
  }

  if (/\b(summary|overview|how many|total)\b/.test(text)) {
    const summary = db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN decision='block' THEN 1 ELSE 0 END) AS blocked, SUM(CASE WHEN decision='step_up' THEN 1 ELSE 0 END) AS step_up FROM transactions`
      )
      .get();
    return `So far: ${summary.total} transaction(s) processed, ${summary.blocked} blocked, ${summary.step_up} step-up challenged.`;
  }

  // Code-review follow-up: deliberately a single fixed dimension (sender_id), not the
  // dimension-aware logic GET /analytics/top-risky uses (customers/merchants/vendors/devices/etc.,
  // keyed by sender_id OR receiver_id depending on dimension) -- a quick, good-enough answer for a
  // chat question, not meant to be equivalent to that endpoint. A caller who needs a specific
  // dimension should use GET /analytics/top-risky directly.
  if (/\btop risk|riskiest|most risky\b/.test(text)) {
    const rows = db
      .prepare(
        `SELECT t.sender_id AS id, COUNT(DISTINCT f.transaction_id) AS n FROM flags f JOIN transactions t ON t.transaction_id = f.transaction_id GROUP BY t.sender_id ORDER BY n DESC LIMIT 3`
      )
      .all();
    if (rows.length === 0) return 'No flagged activity on record yet.';
    return `Top flagged accounts (by sender): ${rows.map((r) => `${r.id} (${r.n} flag(s))`).join(', ')}. For a specific dimension (merchants/vendors/devices/etc.), use the Analytics tab's Top Risky panel.`;
  }

  return "I can answer questions about a specific transaction (mention its transaction_id), give an overall summary, or list the riskiest accounts. Try: \"give me a summary\" or \"what are the top risky accounts\".";
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} message
 * @param {string|null} caseContext - a plain-text summary of a case's timeline, if this chat is
 *   scoped to one ("AI Fraud Investigation Assistant" use of the same endpoint)
 * @returns {Promise<{ reply: string, source: 'llm'|'rule_based' }>}
 */
async function answerChatMessage(db, message, caseContext) {
  const deterministicReply = answerDeterministically(db, message);

  if (llmConfigured()) {
    const systemPrompt =
      'You are a fraud-operations assistant embedded in the SentinelPay dashboard. Answer concisely (2-4 sentences), grounded only in the context provided below -- never invent transaction IDs, amounts, or account IDs that are not present in it.\n\n' +
      `Deterministic lookup result for this message: ${deterministicReply}` +
      (caseContext ? `\n\nCase context:\n${caseContext}` : '');
    const llmReply = await callLlm(systemPrompt, message);
    if (llmReply) return { reply: llmReply, source: 'llm' };
  }

  return { reply: deterministicReply, source: 'rule_based' };
}

module.exports = {
  llmConfigured,
  callLlm,
  parseNaturalLanguageQuery,
  executeNaturalLanguageSearch,
  generateFraudInsights,
  generateReportNarrative,
  answerDeterministically,
  answerChatMessage,
};
