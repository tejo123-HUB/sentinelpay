// Measures real end-to-end latency for POST /transaction over a batch of simulated traffic,
// and computes a real (not assumed) false-positive comparison between the rule-engine-only
// score and the full pipeline (rules + structuring lookup + ML) — architecture.md Section 11,
// Risks 3 and 4 both require this to be measured, not asserted.
//
// Usage: node simulator/benchmark.js [--count=500] [--base-url=http://127.0.0.1:3000]
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { generateNormalTransaction, postTransaction } = require('./simulate_transactions');
const decide = require('../server/decision');

function parseArgs(argv) {
  const args = { count: 500, baseUrl: process.env.SIMULATOR_BASE_URL || 'http://127.0.0.1:3000' };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'count') args.count = Number(value);
    else if (key === 'base-url') args.baseUrl = value;
  }
  return args;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Benchmark :: sending ${args.count} transactions to ${args.baseUrl}`);

  const latencies = [];
  const transactionIds = [];

  for (let i = 0; i < args.count; i += 1) {
    const tx = generateNormalTransaction();
    const start = performance.now();
    try {
      const { status, body } = await postTransaction(args.baseUrl, tx);
      const elapsed = performance.now() - start;

      if (status === 201) {
        latencies.push(elapsed);
        transactionIds.push(body.transaction_id);
      } else {
        console.error(`Request ${i} failed (${status}):`, body);
      }
    } catch (err) {
      // e.g. connection refused — the server isn't reachable at all. Report and keep going
      // rather than letting one dropped connection abort the whole benchmark run.
      console.error(`Request ${i} errored:`, err.message);
    }

    if ((i + 1) % 100 === 0) console.log(`  ...${i + 1}/${args.count} sent`);
  }

  if (transactionIds.length === 0) {
    console.error('\nAll requests failed — nothing to report. Is the server running?');
    process.exitCode = 1;
    return;
  }

  latencies.sort((a, b) => a - b);
  const mean = latencies.reduce((s, v) => s + v, 0) / latencies.length;

  console.log('\n=== Latency (POST /transaction, full synchronous scoring pipeline) ===');
  console.log(`  n:      ${latencies.length}`);
  console.log(`  mean:   ${mean.toFixed(2)} ms`);
  console.log(`  p50:    ${percentile(latencies, 50).toFixed(2)} ms`);
  console.log(`  p95:    ${percentile(latencies, 95).toFixed(2)} ms`);
  console.log(`  p99:    ${percentile(latencies, 99).toFixed(2)} ms`);
  console.log(`  max:    ${Math.max(...latencies).toFixed(2)} ms`);

  // False-positive comparison: reconstruct what a rules-only score/decision would have been
  // (sum of the weights of whichever rules actually flagged, per the flags table already
  // persisted by the ingestion path) and compare against the full pipeline's stored decision,
  // over this same simulated-legitimate-traffic batch.
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'sentinelpay.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const placeholders = transactionIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT t.transaction_id, t.decision AS full_decision,
              COALESCE(SUM(f.weight), 0) AS rule_weight_sum
       FROM transactions t
       LEFT JOIN flags f ON f.transaction_id = t.transaction_id
       WHERE t.transaction_id IN (${placeholders})
       GROUP BY t.transaction_id`
    )
    .all(...transactionIds);

  let fullPipelineFlagged = 0;
  let rulesOnlyFlagged = 0;
  for (const row of rows) {
    const rulesOnlyDecision = decide(Math.min(row.rule_weight_sum, 100));
    if (row.full_decision !== 'allow') fullPipelineFlagged += 1;
    if (rulesOnlyDecision !== 'allow') rulesOnlyFlagged += 1;
  }

  const reduction =
    rulesOnlyFlagged > 0 ? ((rulesOnlyFlagged - fullPipelineFlagged) / rulesOnlyFlagged) * 100 : 0;

  console.log('\n=== False-positive comparison on this simulated-legitimate-traffic batch ===');
  console.log(`  n:                        ${rows.length}`);
  console.log(`  flagged, rules-only:      ${rulesOnlyFlagged} (${((rulesOnlyFlagged / rows.length) * 100).toFixed(1)}%)`);
  console.log(`  flagged, full pipeline:   ${fullPipelineFlagged} (${((fullPipelineFlagged / rows.length) * 100).toFixed(1)}%)`);
  console.log(`  relative reduction:       ${reduction.toFixed(1)}%`);
  console.log(
    '\nNote: this batch is generated as legitimate traffic, so any non-"allow" decision here is,'
  );
  console.log('by construction, a false positive for the purposes of this comparison.');

  db.close();
}

main().catch((err) => {
  console.error('Benchmark crashed:', err);
  process.exitCode = 1;
});
