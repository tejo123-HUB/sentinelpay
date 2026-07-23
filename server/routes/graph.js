// Section 17 (FA041/FA043/FA044/FA045/FA053): a real graph-data endpoint, closing the "the data
// model supports the query, no dedicated endpoint" gap the Section 17 verification pass found for
// Relationship Graph / Transaction Graph / Graph-Based AML / Suspicious Network / Network Risk
// Scoring. Returns a plain {nodes, edges} JSON structure an investigator (or the dashboard's Graph
// tab, dashboard/graph.js) can render, reusing the SQL self-joins this project already uses
// elsewhere (structuring, sharedIdentifierRisk) reshaped into a graph-shaped response.
//
// Community Detection/Graph Clustering (originally out of scope here) is now real, via the
// Continuous Learning Extension's server/graphIntelligence.js union-find pass over the persisted
// graph_edges table -- see enrichNodesWithGraphIntelligence below and GET /graph/clusters.
// Interactive Graph Visualization (also originally out of scope) is now real too, via
// dashboard/graph.js's canvas force-directed layout consuming this endpoint -- see the Graph tab.
const express = require('express');
const router = express.Router();

const { requireApiKey, requireRole } = require('../middleware/apiKeyAuth');
const { MAX_ID_LENGTH } = require('../validate');

const DEFAULT_CLUSTER_LIMIT = 20;
const MAX_CLUSTER_LIMIT = 100;

const VALID_DEPTHS = [1, 2];
// Bounds worst-case query cost regardless of how connected an account's network is -- same
// reasoning as MULE_SCORE_MAX_RECEIPTS_SCANNED (config.js): an unbounded expansion would grow
// per-request cost without limit for a genuinely high-degree hub account.
const GRAPH_MAX_NODES = 50;
// Defense-in-depth cap on how many persisted clusters one /graph/relationships call scans to
// annotate nodes -- generous enough to never matter at this project's real scale, but bounds
// worst-case table growth the same way GRAPH_MAX_NODES bounds worst-case account connectivity.
const MAX_CLUSTERS_SCANNED = 5000;

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
  // Found during a full-project security review: this query had no LIMIT, contradicting this
  // file's own header comment that every query here bounds worst-case cost -- a high-volume
  // sender account forced a full unbounded scan+DISTINCT on every /graph/relationships call.
  // Bounding it also transitively bounds findLinked() below, since deviceIds/ipAddresses/etc. can
  // now never exceed GRAPH_MAX_NODES distinct values.
  const ownValues = db
    .prepare('SELECT DISTINCT device_id, ip_address, identity_hash, bank_account_hash FROM transactions WHERE sender_id = ? LIMIT ?')
    .all(accountId, GRAPH_MAX_NODES);

  const deviceIds = [...new Set(ownValues.map((r) => r.device_id).filter(Boolean))];
  const ipAddresses = [...new Set(ownValues.map((r) => r.ip_address).filter(Boolean))];
  const identityHashes = [...new Set(ownValues.map((r) => r.identity_hash).filter(Boolean))];
  const bankAccountHashes = [...new Set(ownValues.map((r) => r.bank_account_hash).filter(Boolean))];

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
  findLinked('bank_account_hash', bankAccountHashes, 'shared_bank_account');

  return links;
}

// Found during a full-project security review: every route in this file was viewer-accessible
// (requireApiKey only), matching this codebase's general "reads are viewer-open" convention -- but
// unlike typical read routes (aggregate analytics), these expose raw cross-account linkage (shared
// device/IP/identity/bank_account hashes, blocked-payment chains, cluster membership lists), which
// is comparably sensitive to what 17.32 already elevated above viewer level for other routes
// exposing more than a typical read (evidence content, custom-rule internals, push-subscription
// management). The demo dashboard is unaffected -- server/index.js always injects the admin
// API_KEY into the served HTML, never a viewer-scoped one -- this only tightens access for a
// caller using a separately-configured API_KEY_VIEWER directly against the API.

// GET /graph/relationships?account_id=&depth=1|2 -- Section 17 (Category 4, Graph Intelligence).
router.get('/graph/relationships', requireApiKey, requireRole('analyst'), (req, res) => {
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
  // Found during a full-project security review: unbounded full-table scan on every
  // /graph/relationships call. Bounded generously (MAX_CLUSTERS_SCANNED) rather than tightly:
  // this must still find the correct cluster for any of `nodes` regardless of table size at
  // real project scale, this is defense-in-depth against pathological growth, not a change meant
  // to affect normal-scale behavior.
  const clusterRows = db.prepare('SELECT cluster_id, member_ids_json FROM graph_clusters LIMIT ?').all(MAX_CLUSTERS_SCANNED);
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
router.get('/graph/clusters', requireApiKey, requireRole('analyst'), (req, res) => {
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

// GET /graph/blocked-tree?account_id=... -- Returns a tree of blocked payments
router.get('/graph/blocked-tree', requireApiKey, requireRole('analyst'), (req, res) => {
  const db = req.app.locals.db;
  const accountId = req.query.account_id;

  if (typeof accountId !== 'string' || accountId.trim() === '' || accountId.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: 'account_id is required' });
  }

  const maxDepth = 3;
  const nodes = new Map(); // id -> level
  const edges = [];
  let currentLevelNodes = [accountId];
  nodes.set(accountId, 0);
  let truncated = false;

  // Found during a full-project security review: each level queried up to 50 rows *per node at
  // that level* with no cap on the total node count across the whole traversal -- level 1 could
  // add up to 50 nodes, level 2 up to 50 more for *each* of those (<=2,500), level 3 up to 50 more
  // for *each* of those (<=125,000), a combinatorial explosion of synchronous SQL statements from
  // one GET. GRAPH_MAX_NODES now bounds the total node count the same way it already bounds
  // /graph/relationships, and the traversal stops issuing new queries once the cap is hit.
  outer: for (let depth = 0; depth < maxDepth; depth++) {
    const nextLevelNodes = [];
    for (const node of currentLevelNodes) {
      if (nodes.size >= GRAPH_MAX_NODES) {
        truncated = true;
        break outer;
      }
      const txs = db.prepare("SELECT sender_id, receiver_id, amount FROM transactions WHERE (sender_id = ? OR receiver_id = ?) AND decision = 'block' LIMIT 50")
        .all(node, node);

      for (const tx of txs) {
        const other = tx.sender_id === node ? tx.receiver_id : tx.sender_id;
        if (!nodes.has(other)) {
          if (nodes.size >= GRAPH_MAX_NODES) {
            truncated = true;
            break;
          }
          nodes.set(other, depth + 1);
          nextLevelNodes.push(other);
          // Keep edge direction as from sender to receiver
          edges.push({ source: tx.sender_id, target: tx.receiver_id, amount: tx.amount });
        }
      }
    }
    if (nextLevelNodes.length === 0) break;
    currentLevelNodes = nextLevelNodes;
  }

  const resultNodes = Array.from(nodes.entries()).map(([id, level]) => ({
    id,
    type: level === 0 ? 'root' : 'blocked',
    level
  }));

  res.json({ root: accountId, nodes: resultNodes, edges, truncated });
});

module.exports = router;
