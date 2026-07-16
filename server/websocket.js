// Broadcasts every scored transaction and every new structuring alert to connected dashboard
// clients, per the WebSocket /ws contract in architecture.md Section 7.
const { WebSocketServer } = require('ws');

function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
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
