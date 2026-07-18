// Section 17 (FA041/FA043/FA044/FA045/FA053): a real graph-data endpoint, closing the "the data
// model supports the query, no dedicated endpoint" gap the Section 17 verification pass found for
// Relationship Graph / Transaction Graph / Graph-Based AML / Suspicious Network / Network Risk
// Scoring. Returns a plain {nodes, edges} JSON structure an investigator (or a future frontend
// graph widget) can render -- not a graph database, not a clustering algorithm, and not a UI
// library (Community Detection/Graph Clustering/Interactive Graph Visualization remain explicitly
// out of scope, Section 16 Category 4), just the SQL self-joins this project already uses
// elsewhere (structuring, sharedIdentifierRisk) reshaped into a graph-shaped response.
const express = require('express');
const router = express.Router();

const { requireApiKey } = require('../middleware/apiKeyAuth');
const { MAX_ID_LENGTH } = require('../validate');

const DEFAULT_CLUSTER_LIMIT = 20;
const MAX_CLUSTER_LIMIT = 100;

const VALID_DEPTHS = [1, 2];
// Bounds worst-case query cost regardless of how connected an account's network is -- same
// reasoning as MULE_SCORE_MAX_RECEIPTS_SCANNED (config.js): an unbounded expansion would grow
// per-request cost without limit for a genuinely high-degree hub account.
const GRAPH_MAX_NODES = 50;

// Every query here carries an explicit LIMIT GRAPH_MAX_NODES: GRAPH_MAX_NODES exists precisely to
// bound worst-case cost for a high-degree hub account or a widely-shared device/IP, and a query
// with no LIMIT would materialize every matching row before the JS-side truncation below ever got
// a chance to apply -- the exact "unbounded regardless of how connected an account's network is"
// scenario this file's own header comment says it avoids.
function fetchTransactionCounterparties(db, accountId) {
  const outgoing = db
    .prepare(
      'SELECT receiver_id AS counterparty, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE sender_id = ? GROUP BY receiver_id LIMIT ?'
    )
    .all(accountId, GRAPH_MAX_NODES)
    .map((r) => ({ source: accountId, target: r.counterparty, count: r.n, total_amount: r.total }));

  const incoming = db
    .prepare(
      'SELECT sender_id AS counterparty, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE receiver_id = ? GROUP BY sender_id LIMIT ?'
    )
    .all(accountId, GRAPH_MAX_NODES)
    .map((r) => ({ source: r.counterparty, target: accountId, count: r.n, total_amount: r.total }));

  return [...outgoing, ...incoming];
}

// Same shared-identifier reasoning as server/rules/sharedIdentifierRisk.js / outboundContext.js,
// but unbounded by a recency window: this is an on-demand investigative view ("everything linked
// to this account, ever"), not a real-time scoring check where an old, now-irrelevant device
// reassignment should stop mattering.
function fetchSharedIdentifierLinks(db, accountId) {
  const ownValues = db
    .prepare('SELECT DISTINCT device_id, ip_address, identity_hash FROM transactions WHERE sender_id = ?')
    .all(accountId);

  const deviceIds = [...new Set(ownValues.map((r) => r.device_id).filter(Boolean))];
  const ipAddresses = [...new Set(ownValues.map((r) => r.ip_address).filter(Boolean))];
  const identityHashes = [...new Set(ownValues.map((r) => r.identity_hash).filter(Boolean))];

  const links = [];
  function findLinked(column, values, edgeType) {
    for (const value of values) {
      const rows = db
        .prepare(`SELECT DISTINCT sender_id FROM transactions WHERE ${column} = ? AND sender_id != ? LIMIT ?`)
        .all(value, accountId, GRAPH_MAX_NODES);
      for (const r of rows) {
        links.push({ source: accountId, target: r.sender_id, type: edgeType, detail: value });
      }
    }
  }
  // column names are always one of these three hardcoded literals, never derived from request
  // input -- same safe-interpolation reasoning already applied to outboundContext.js's identical
  // pattern.
  findLinked('device_id', deviceIds, 'shared_device');
  findLinked('ip_address', ipAddresses, 'shared_ip');
  findLinked('identity_hash', identityHashes, 'shared_identity_hash');

  return links;
}

// GET /graph/relationships?account_id=&depth=1|2 -- Section 17 (Category 4, Graph Intelligence).
router.get('/graph/relationships', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const accountId = req.query.account_id;
  const depth = VALID_DEPTHS.includes(Number(req.query.depth)) ? Number(req.query.depth) : 1;

  if (typeof accountId !== 'string' || accountId.trim() === '' || accountId.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: 'account_id is required' });
  }

  const nodeIds = new Set([accountId]);
  const edges = [];

  const directTxEdges = fetchTransactionCounterparties(db, accountId);
  const directLinkEdges = fetchSharedIdentifierLinks(db, accountId);
  for (const e of [...directTxEdges, ...directLinkEdges]) {
    edges.push(e);
    nodeIds.add(e.source);
    nodeIds.add(e.target);
  }

  // depth=2: one more transaction-only hop from each depth-1 node -- shared-identifier expansion
  // is deliberately not repeated at depth 2 (that would combinatorially chain unrelated accounts
  // through a single popular device/IP). Bounded two ways: the outer loop stops issuing new
  // queries once the cap is already reached, and fetchTransactionCounterparties itself now caps
  // each node's own contribution via SQL LIMIT -- an in-loop node/edge check here would be
  // ineffective anyway, since one edge endpoint is always `node` itself, already a member of
  // nodeIds, so a "neither endpoint already known" condition can never fire.
  if (depth === 2) {
    const depth1Nodes = [...nodeIds].filter((id) => id !== accountId);
    for (const node of depth1Nodes) {
      if (nodeIds.size >= GRAPH_MAX_NODES) break;
      for (const e of fetchTransactionCounterparties(db, node)) {
        edges.push(e);
        nodeIds.add(e.source);
        nodeIds.add(e.target);
      }
    }
  }

  const baseNodes = [...nodeIds].slice(0, GRAPH_MAX_NODES).map((id) => ({
    id,
    type: id === accountId ? 'root' : 'connected',
  }));
  const keptNodeIds = new Set(baseNodes.map((n) => n.id));
  const trimmedEdges = edges.filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target));
  const nodes = enrichNodesWithGraphIntelligence(db, baseNodes);

  res.json({ root: accountId, depth, nodes, edges: trimmedEdges, truncated: nodeIds.size > GRAPH_MAX_NODES });
});

// Continuous Learning Extension, Phase C: annotates each node with its persisted graph_clusters
// membership (server/graphIntelligence.js's periodic union-find pass, not recomputed live here)
// and its degree in graph_edges -- cheap reads over the now-persisted tables, additive to the
// existing live self-join response rather than a replacement for it.
function enrichNodesWithGraphIntelligence(db, nodes) {
  const clusterRows = db.prepare('SELECT cluster_id, member_ids_json FROM graph_clusters').all();
  const clusterByMember = new Map();
  for (const row of clusterRows) {
    let members = [];
    try {
      members = JSON.parse(row.member_ids_json);
    } catch {
      members = [];
    }
    for (const m of members) clusterByMember.set(m, row.cluster_id);
  }

  const degreeStmt = db.prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE source = ? OR target = ?');
  return nodes.map((node) => ({
    ...node,
    cluster_id: clusterByMember.get(node.id) || null,
    degree: degreeStmt.get(node.id, node.id).n,
  }));
}

// GET /graph/clusters?limit=20 -- Continuous Learning Extension, Phase C: the persisted,
// periodically-discovered mule-ring/community clusters (server/graphIntelligence.js), distinct
// from GET /graph/relationships' single-account live neighborhood view above.
router.get('/graph/clusters', requireApiKey, (req, res) => {
  const db = req.app.locals.db;
  const requested = Number(req.query.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_CLUSTER_LIMIT) : DEFAULT_CLUSTER_LIMIT;

  const rows = db
    .prepare('SELECT cluster_id, member_ids_json, risk_score, discovered_at FROM graph_clusters ORDER BY risk_score DESC LIMIT ?')
    .all(limit);

  res.json({
    clusters: rows.map((r) => ({
      cluster_id: r.cluster_id,
      members: JSON.parse(r.member_ids_json),
      risk_score: Number(r.risk_score.toFixed(2)),
      discovered_at: r.discovered_at,
    })),
  });
});

module.exports = router;
