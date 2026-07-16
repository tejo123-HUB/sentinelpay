const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.DB_PATH = ':memory:';
process.env.PORT = '0';

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

test('websocket: an unhandled per-client error event does not crash the server (regression)', async () => {
  const { app, server } = await freshServer();
  const port = server.address().port;

  try {
    // Confirm the server is responsive before forcing an error.
    assert.equal(await httpGet(port, '/health'), 200);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
