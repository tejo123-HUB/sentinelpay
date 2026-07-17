const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.API_KEY = 'test-key-for-automated-tests';

function freshServer() {
  // Also clear rateLimit.js's (and websocket.js's, which captures a reference to it) cache —
  // rateLimit.js reads RATE_LIMIT_MAX_PER_MINUTE once at module-load time into a module-level
  // constant, so a stale cached instance would silently ignore an env var change between tests.
  delete require.cache[require.resolve('../server/index')];
  delete require.cache[require.resolve('../server/middleware/rateLimit')];
  delete require.cache[require.resolve('../server/websocket')];
  const { app, server } = require('../server/index');
  return new Promise((resolve) => {
    if (server.listening) return resolve({ app, server });
    server.once('listening', () => resolve({ app, server }));
  });
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

function httpGetWithHeaders(port, path, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.API_KEY },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('websocket: an unhandled per-client error event does not crash the server (regression)', async () => {
  const { app, server } = await freshServer();
  const port = server.address().port;

  try {
    // Confirm the server is responsive before forcing an error.
    assert.equal(await httpGet(port, '/health'), 200);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?apiKey=${encodeURIComponent(process.env.API_KEY)}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    // Reach into the real per-connection ws instance the server holds and force an 'error'
    // event on it directly, simulating an abrupt network-level failure ws itself would emit
    // internally (which this app's own try/catch blocks around send() can't intercept, since
    // it's ws's internal dispatch, not application code raising the error).
    const wss = app.locals.wss;
    assert.ok(wss, 'expected the server to expose its WebSocketServer instance');
    const [serverSideClient] = wss.clients;
    assert.ok(serverSideClient, 'expected the server to have registered the connected client');

    let uncaught = false;
    process.once('uncaughtException', () => {
      uncaught = true;
    });

    serverSideClient.emit('error', new Error('simulated abrupt network failure'));

    // Give the event loop a tick, then confirm the server is still alive and responsive —
    // this is the actual regression being guarded against, not just that emit() didn't throw
    // synchronously (Node dispatches EventEmitter listeners synchronously, so if this test
    // process is still executing at all past the emit() call, a listener was in fact registered).
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(uncaught, false, 'the error event should have been handled, not left uncaught');
    assert.equal(await httpGet(port, '/health'), 200, 'server must still be alive and responsive');

    ws.close();
  } finally {
    server.close();
  }
});

test('websocket: the handshake is rate-limited, sharing the same per-IP budget as the HTTP API (regression)', async () => {
  // Regression: the WS upgrade path runs entirely outside Express's middleware chain (the `ws`
  // library intercepts the HTTP upgrade before any app.use() middleware ever sees it), so
  // server/index.js's rate-limit middleware never applied to it at all — a flood of handshake
  // attempts was completely unthrottled even after rate limiting was added everywhere else.
  const WsClient = require('ws');
  const originalLimit = process.env.RATE_LIMIT_MAX_PER_MINUTE;
  process.env.RATE_LIMIT_MAX_PER_MINUTE = '3';
  try {
    const { server } = await freshServer();
    const port = server.address().port;
    try {
      // Exhaust the shared per-IP budget via plain HTTP first, to confirm the WS path is reading
      // from the *same* counter (server/middleware/rateLimit.js's checkAndRecord), not an
      // independent one an attacker could bypass by splitting a flood across HTTP and WS.
      for (let i = 0; i < 3; i += 1) {
        const status = await httpGetWithHeaders(port, '/transactions', { 'X-API-Key': process.env.API_KEY });
        assert.equal(status, 200);
      }

      const rejection = await new Promise((resolve, reject) => {
        const client = new WsClient(`ws://127.0.0.1:${port}/ws?apiKey=${encodeURIComponent(process.env.API_KEY)}`);
        client.on('unexpected-response', (req, res) => resolve({ statusCode: res.statusCode }));
        client.on('open', () => reject(new Error('expected the handshake to be rejected once the budget was exhausted')));
        client.on('error', () => {}); // an 'unexpected-response'-triggered close also emits 'error'; already handled above
      });

      assert.equal(rejection.statusCode, 429);
    } finally {
      server.close();
    }
  } finally {
    if (originalLimit === undefined) delete process.env.RATE_LIMIT_MAX_PER_MINUTE;
    else process.env.RATE_LIMIT_MAX_PER_MINUTE = originalLimit;
  }
});

test('websocket: rejects an oversized incoming frame (maxPayload regression)', async () => {
  // Regression: the WebSocketServer had no maxPayload configured, so `ws`'s own unconfigured
  // default (100 MiB per frame) applied — an authenticated client could force a large allocation
  // per message even though nothing downstream ever reads incoming WS data (there's no
  // `ws.on('message', ...)` handler anywhere in this app; the feed is broadcast-only).
  const { server } = await freshServer();
  const port = server.address().port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?apiKey=${encodeURIComponent(process.env.API_KEY)}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    const closeEvent = await new Promise((resolve) => {
      ws.addEventListener('close', resolve);
      ws.send('x'.repeat(5000)); // comfortably over MAX_PAYLOAD_BYTES (1024)
    });

    assert.equal(closeEvent.code, 1009, 'expected the connection to close with code 1009 (message too big)');
  } finally {
    server.close();
  }
});

test('websocket: rejects new connections once the concurrent connection cap is reached (regression)', async () => {
  // Regression: rateLimit.js bounds how *fast* new connections can open, but nothing previously
  // bounded how many could be open *at once* — a long-running demo session could accumulate an
  // unbounded number of connections (each held open, e.g., by a client that never closes cleanly).
  const WsClient = require('ws');
  const originalCap = process.env.WS_MAX_CONCURRENT_CONNECTIONS;
  process.env.WS_MAX_CONCURRENT_CONNECTIONS = '2';
  try {
    const { server } = await freshServer();
    const port = server.address().port;
    try {
      const openSockets = [];
      for (let i = 0; i < 2; i += 1) {
        const ws = new WsClient(`ws://127.0.0.1:${port}/ws?apiKey=${encodeURIComponent(process.env.API_KEY)}`);
        await new Promise((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', reject);
        });
        openSockets.push(ws);
      }

      const rejection = await new Promise((resolve, reject) => {
        const ws = new WsClient(`ws://127.0.0.1:${port}/ws?apiKey=${encodeURIComponent(process.env.API_KEY)}`);
        ws.on('unexpected-response', (req, res) => resolve({ statusCode: res.statusCode }));
        ws.on('open', () => reject(new Error('expected the 3rd connection to be rejected once the cap of 2 was reached')));
        ws.on('error', () => {}); // an 'unexpected-response'-triggered close also emits 'error'; already handled above
      });

      assert.equal(rejection.statusCode, 503);

      for (const ws of openSockets) ws.close();
    } finally {
      server.close();
    }
  } finally {
    if (originalCap === undefined) delete process.env.WS_MAX_CONCURRENT_CONNECTIONS;
    else process.env.WS_MAX_CONCURRENT_CONNECTIONS = originalCap;
  }
});

test('websocket: the heartbeat terminates a connection that stops responding (regression)', async () => {
  // Regression: a connection that dies without a clean close (network drop, a laptop sleeping
  // mid-demo) used to stay in wss.clients until the OS-level TCP timeout eventually noticed —
  // minutes to hours, not a fast reap. Simulates "already missed a pong" by setting isAlive=false
  // directly on the server-side socket right after connecting, before any real heartbeat tick has
  // run — the next tick should terminate it, without needing to wait out real ping/pong network
  // round-trips (which the WebSocket spec/ws library answer automatically at the protocol level,
  // making a genuinely unresponsive client hard to simulate from a normal client).
  const originalInterval = process.env.WS_HEARTBEAT_INTERVAL_MS;
  process.env.WS_HEARTBEAT_INTERVAL_MS = '50'; // small on purpose so this test runs fast
  try {
    const { app, server } = await freshServer();
    const port = server.address().port;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?apiKey=${encodeURIComponent(process.env.API_KEY)}`);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', reject);
      });

      const wss = app.locals.wss;
      const [serverSideClient] = wss.clients;
      assert.ok(serverSideClient, 'expected the server to have registered the connected client');

      serverSideClient.isAlive = false;

      const closeEvent = await new Promise((resolve) => {
        ws.addEventListener('close', resolve);
      });
      assert.ok(closeEvent, 'expected the client to be disconnected by the server-side heartbeat sweep');

      // The client-side close event and the server actually splicing the socket out of
      // wss.clients aren't the same tick — ws.terminate() closes the connection, but wss's own
      // 'close' bookkeeping for that client follows slightly after. Give it a beat.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(wss.clients.size, 0, 'the terminated connection must be removed from wss.clients');
    } finally {
      server.close();
    }
  } finally {
    if (originalInterval === undefined) delete process.env.WS_HEARTBEAT_INTERVAL_MS;
    else process.env.WS_HEARTBEAT_INTERVAL_MS = originalInterval;
  }
});

test('websocket: the transaction broadcast includes full transaction details, not just the HTTP response fields (regression)', async () => {
  // Regression test: the WS broadcast used to be exactly the HTTP response shape
  // ({transaction_id, fraud_score, decision, reasons}) — matching architecture.md's original
  // (too-minimal) documented contract, but missing everything the dashboard's live table and
  // map view actually need to render a row/marker (sender_id, receiver_id, amount, location,
  // etc). Every live transaction rendered as blank dashes in the table, and the map could
  // never plot a live transaction at all.
  const { server } = await freshServer();
  const port = server.address().port;

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?apiKey=${encodeURIComponent(process.env.API_KEY)}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    await new Promise((resolve) => {
      ws.addEventListener('message', function onFirst() {
        ws.removeEventListener('message', onFirst);
        resolve();
      });
    }); // the initial "connected" welcome message

    const messagePromise = new Promise((resolve) => {
      ws.addEventListener('message', (event) => resolve(JSON.parse(event.data)), { once: true });
    });

    const { status } = await httpPost(port, '/transaction', {
      sender_id: 'u_ws_full_1',
      receiver_id: 'u_ws_full_2',
      amount: 321,
      timestamp: '2026-07-18T10:00:00Z',
      location: { lat: 16.5062, lng: 80.648 },
      device_id: 'd_ws_full',
      transaction_type: 'transfer',
    });
    assert.equal(status, 201);

    const message = await messagePromise;
    assert.equal(message.type, 'transaction');
    assert.equal(message.data.sender_id, 'u_ws_full_1');
    assert.equal(message.data.receiver_id, 'u_ws_full_2');
    assert.equal(message.data.amount, 321);
    assert.deepEqual(message.data.location, { lat: 16.5062, lng: 80.648 });
    assert.equal(message.data.transaction_type, 'transfer');
    assert.ok(message.data.transaction_id);

    ws.close();
  } finally {
    server.close();
  }
});
