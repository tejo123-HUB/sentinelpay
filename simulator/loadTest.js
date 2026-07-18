// Section 16, Category 23: Load Testing, distinct from benchmark.js above -- that script sends
// one request at a time and measures single-stream latency; this one holds a configurable number
// of concurrent workers hammering POST /transaction for a fixed duration and measures sustained
// throughput (requests/sec) under real concurrency, the thing "high throughput processing" and
// "<150ms latency" (architecture.md Section 11) actually need to be validated under, not just a
// clean sequential run.
//
// Usage: node simulator/loadTest.js [--concurrency=20] [--duration=10] [--base-url=http://127.0.0.1:3000]
const { generateNormalTransaction, postTransaction } = require('./simulate_transactions');

function parseArgs(argv) {
  const args = {
    concurrency: 20,
    durationSeconds: 10,
    baseUrl: process.env.SIMULATOR_BASE_URL || 'http://127.0.0.1:3000',
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'concurrency') args.concurrency = Number(value);
    else if (key === 'duration') args.durationSeconds = Number(value);
    else if (key === 'base-url') args.baseUrl = value;
  }
  return args;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

// One worker: fires requests back-to-back (no think-time) until deadlineMs, appending every
// successful request's latency to the shared `latencies` array and counting errors separately --
// a slow/failing worker must not stall the others, since they're independent loop iterations.
async function runWorker(baseUrl, deadlineMs, latencies, errorCounter) {
  while (Date.now() < deadlineMs) {
    const tx = generateNormalTransaction();
    const start = performance.now();
    try {
      const { status } = await postTransaction(baseUrl, tx);
      const elapsed = performance.now() - start;
      if (status === 201) {
        latencies.push(elapsed);
      } else {
        errorCounter.count += 1;
      }
    } catch {
      errorCounter.count += 1;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `Load test :: ${args.concurrency} concurrent workers against ${args.baseUrl} for ${args.durationSeconds}s`
  );

  const latencies = [];
  const errorCounter = { count: 0 };
  const startMs = Date.now();
  const deadlineMs = startMs + args.durationSeconds * 1000;

  const workers = Array.from({ length: args.concurrency }, () => runWorker(args.baseUrl, deadlineMs, latencies, errorCounter));
  await Promise.all(workers);

  const wallClockSeconds = (Date.now() - startMs) / 1000;
  const totalRequests = latencies.length + errorCounter.count;

  if (totalRequests === 0) {
    console.error('\nNo requests completed — is the server running?');
    process.exitCode = 1;
    return;
  }

  latencies.sort((a, b) => a - b);
  const mean = latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;

  console.log('\n=== Sustained load results ===');
  console.log(`  wall clock:        ${wallClockSeconds.toFixed(2)}s`);
  console.log(`  total requests:    ${totalRequests}`);
  console.log(`  successful:        ${latencies.length}`);
  console.log(`  errors:            ${errorCounter.count}`);
  console.log(`  throughput:        ${(totalRequests / wallClockSeconds).toFixed(1)} req/s`);
  console.log('\n=== Latency under concurrent load (successful requests only) ===');
  console.log(`  mean:   ${mean.toFixed(2)} ms`);
  console.log(`  p50:    ${percentile(latencies, 50).toFixed(2)} ms`);
  console.log(`  p95:    ${percentile(latencies, 95).toFixed(2)} ms`);
  console.log(`  p99:    ${percentile(latencies, 99).toFixed(2)} ms`);
  console.log(`  max:    ${latencies.length > 0 ? Math.max(...latencies).toFixed(2) : '0.00'} ms`);
}

main().catch((err) => {
  console.error('Load test crashed:', err);
  process.exitCode = 1;
});
