// One-command hackathon demo launcher: boots the server (if not already running), opens the
// dashboard, starts ambient background traffic, and gives you a live menu to fire the scripted
// fraud/structuring/odd-hour scenarios on cue. Ctrl+C or "q" tears everything back down.
//
// Usage: npm run demo   (or: node scripts/demo.js)

'use strict';

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'sentinelpay.db');

// A stale DB from a previous run/demo has every u_sim_* account's location history sitting
// wherever the simulator's hub layout put them *that time*. If this run's hub layout differs
// at all, each account's first transaction now looks like a huge, spurious location jump from
// its old history — producing a wave of step-ups that has nothing to do with actual fraud
// signal. Demo data is meant to be disposable (sentinelpay.db* is gitignored), so start every
// demo from a clean, internally-consistent DB rather than accreted state from past runs.
function resetDemoDatabase() {
  for (const suffix of ['', '-shm', '-wal']) {
    const file = DB_PATH + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

const children = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnChild(cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  children.push(child);
  return child;
}

function killChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // child.kill() alone can leave node.exe orphaned on Windows; taskkill /T also gets any
    // grandchildren.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else {
    child.kill('SIGTERM');
  }
}

function killAll() {
  for (const child of children) killChild(child);
}

async function checkHealth() {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkHealth()) return true;
    await sleep(300);
  }
  return false;
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function runToCompletion(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', () => resolve());
    child.on('error', (err) => {
      console.error(`[demo] failed to run "${cmd} ${args.join(' ')}":`, err.message);
      resolve();
    });
  });
}

function runScenario(scenario) {
  return runToCompletion('node', ['simulator/simulate_transactions.js', `--scenario=${scenario}`]);
}

function printMenu() {
  console.log(`
Dashboard: ${BASE_URL}  (ambient traffic is running in the background)
------------------------------------------------------------------------
  1) Outbound fraud       compromised business account rapidly drains funds -> block
  2) Refund fraud         large refund with no matching prior purchase -> flagged
  3) Structuring pattern  6 transfers -> 3 mules -> 2 rapid withdrawals -> grouped alert
  4) Old inbound "fraud" scenario  kept for reference — no longer blocks (see below)
  5) Old inbound "odd-hour" scenario  kept for reference — no longer blocks (see below)
  6) All of the above, back to back
  7) Latency benchmark (500 legit transactions, prints p50/p95/p99)
  q) Quit — stops the server and background traffic

  Fraud/AML scoring is outbound-only now (money leaving the business) — a customer
  paying you isn't scored, so 4/5 above intentionally just show "allow".
------------------------------------------------------------------------
> `);
}

async function main() {
  console.log('SentinelPay demo launcher\n');
  const skipSeed = process.argv.includes('--no-seed');

  const alreadyUp = await checkHealth();
  if (alreadyUp) {
    console.log(`[demo] server already running at ${BASE_URL} — reusing it as-is (no DB reset/seed).`);
  } else {
    console.log('[demo] resetting demo database for a clean, consistent run...');
    resetDemoDatabase();

    if (!skipSeed) {
      console.log('[demo] seeding evenly-distributed historical demo data (pass --no-seed to skip)...');
      await runToCompletion('node', ['scripts/generate_demo_data.js']);
    }

    console.log('[demo] starting server...');
    spawnChild('node', ['server/index.js']);
    const healthy = await waitForHealth();
    if (!healthy) {
      console.error('[demo] server did not become healthy in time — check the output above.');
      killAll();
      process.exit(1);
    }
    console.log('[demo] server is up.');
  }

  console.log('[demo] opening dashboard in your browser...');
  openBrowser(BASE_URL);

  console.log('[demo] starting ambient background traffic...');
  spawnChild('node', ['simulator/simulate_transactions.js', '--scenario=normal', '--continuous']);

  await sleep(1500);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  printMenu();

  rl.on('line', async (line) => {
    const choice = line.trim().toLowerCase();
    switch (choice) {
      case '1':
        console.log('\n--- firing outbound fraud (account-takeover) scenario ---');
        await runScenario('outbound-fraud');
        break;
      case '2':
        console.log('\n--- firing refund fraud scenario ---');
        await runScenario('refund-fraud');
        break;
      case '3':
        console.log('\n--- firing structuring/layering scenario ---');
        await runScenario('structuring');
        break;
      case '4':
        console.log('\n--- firing old inbound "fraud" scenario (reference only) ---');
        await runScenario('fraud');
        break;
      case '5':
        console.log('\n--- firing old inbound "odd-hour" scenario (reference only) ---');
        await runScenario('odd-hour');
        break;
      case '6':
        console.log('\n--- firing all scenarios back to back ---');
        await runScenario('all');
        break;
      case '7':
        console.log('\n--- running latency benchmark (this takes a bit) ---');
        await runToCompletion('node', ['simulator/benchmark.js', '--count=500']);
        break;
      case 'q':
      case 'quit':
      case 'exit':
        console.log('\n[demo] shutting down (server + background traffic)...');
        rl.close();
        killAll();
        process.exit(0);
        return;
      default:
        console.log(`[demo] unrecognized option "${choice}".`);
    }
    printMenu();
  });

  rl.on('close', () => {
    killAll();
  });
}

process.on('SIGINT', () => {
  console.log('\n[demo] Ctrl+C — shutting down...');
  killAll();
  process.exit(0);
});

main().catch((err) => {
  console.error('[demo] crashed:', err);
  killAll();
  process.exit(1);
});
