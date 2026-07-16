// Broadcasts every scored transaction and every new structuring alert to connected dashboard
// clients, per the WebSocket /ws contract in architecture.md Section 7.
const { WebSocketServer } = require('ws');

function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // `ws` sockets and the WebSocketServer itself are EventEmitters: an 'error' event with no
  // registered listener throws synchronously at the point ws internally emits it (e.g. an
  // abrupt network drop mid-handshake, a malformed frame, a proxy reset) — completely outside
  // any of this app's own try/catch blocks, since it's ws's internal dispatch, not application
  // code. Left unhandled, that's an uncaught exception that crashes the entire process for
  // every connected dashboard client, not just the one that had the problem — the same failure
  // class already fixed for broadcast()'s client.send() below, just at the socket-error level
  // instead of the send-error level.
  wss.on('error', (err) => {
    console.error('WebSocket server error:', err.message);
  });

  wss.on('connection', (ws) => {
    ws.on('error', (err) => {
      console.error('WebSocket client connection error:', err.message);
    });

    try {
      ws.send(JSON.stringify({ type: 'connected', data: { message: 'SentinelPay live feed connected' } }));
    } catch (err) {
      console.error('WebSocket welcome message failed:', err.message);
    }
  });

  // Each client.send() is isolated in its own try/catch: broadcast() is called from the
  // synchronous tail of POST /transaction (after the DB write has already succeeded) and from
  // the background job. One flaky dashboard connection must never turn an already-successful
  // transaction into a 500 response, and must never stop the broadcast reaching other clients.
  wss.broadcast = function broadcast(type, data) {
    const payload = JSON.stringify({ type, data });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(payload);
        } catch (err) {
          console.error('WebSocket broadcast to a client failed:', err.message);
        }
      }
    }
  };

  return wss;
}

module.exports = { attachWebSocketServer };
