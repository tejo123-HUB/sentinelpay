const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.API_KEY = 'test-key-for-automated-tests';

function freshServer() {
  delete require.cache[require.resolve('../server/index')];
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
