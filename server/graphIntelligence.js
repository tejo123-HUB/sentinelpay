// Continuous Learning Extension, Phase C: real graph-relationship discovery -- persisted edges
// (graph_edges) plus a periodic union-find connected-components pass (graph_clusters), reopening
// Section 16 Category 4 (Community Detection/Graph Clustering), previously out of scope for the
// same reason as the ML items (architecture.md Section 16/17).
//
// PROD: a real graph database (e.g. Neo4j) with a live community-detection job -- DEMO:
// graph_edges/graph_clusters in SQLite, with discoverClusters below playing that job's role.
//
// findClusters is a pure function (no I/O), same "pure algorithm, impure DB-backed orchestration"
// split server/structuring/circularFlow.js + backgroundJob.js already established -- directly
// unit-testable without a database.
const crypto = require('node:crypto');
const { GRAPH_INTELLIGENCE } = require('./config');
const { computeReputationScore } = require('./reputation');

/**
 * Incrementally upserts one edge between two accounts -- mirrors entity_baselines' upsert
 * pattern. Directed (source -> target) in storage (so a transaction's actual sender/receiver
 * order is preserved for display), but findClusters below treats the graph as undirected for
 * connectivity purposes, matching how a real mule ring's money can flow in either direction
 * between two members.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} source
 * @param {string} target
 * @param {'transaction'|'shared_device'|'shared_ip'|'shared_identity_hash'} edgeType
 * @param {number} amount
 * @param {string} nowIso
 */
function upsertEdge(db, source, target, edgeType, amount, nowIso) {
  if (!source || !target || source === target) return;
  db.prepare(
    `INSERT INTO graph_edges (source, target, edge_type, weight, txn_count, total_amount, last_seen_at)
     VALUES (?, ?, ?, 1, 1, ?, ?)
     ON CONFLICT(source, target, edge_type) DO UPDATE SET
       weight = weight + 1,
       txn_count = txn_count + 1,
       total_amount = total_amount + excluded.total_amount,
       last_seen_at = excluded.last_seen_at`
  ).run(source, target, edgeType, amount || 0, nowIso);
}

/**
 * Union-find connected-components over an edge list, treated as undirected. Pure function -- no
 * DB access, directly unit-testable.
 * @param {Array<{source: string, target: string}>} edges
 * @param {number} minClusterSize
 * @returns {string[][]} each element is one cluster's member ids
 */
function findClusters(edges, minClusterSize = GRAPH_INTELLIGENCE.MIN_CLUSTER_SIZE) {
  const parent = new Map();

  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path compression: flatten the chain so future find() calls for any node visited here are O(1).
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  for (const edge of edges) {
    union(edge.source, edge.target);
  }

  const groups = new Map();
  for (const node of parent.keys()) {
    const root = find(node);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(node);
  }

  return [...groups.values()].filter((members) => members.length >= minClusterSize);
}

// A deterministic id from the sorted member set -- the same real-world cluster (found again on a
// later scan, possibly with edges discovered in a different order) always maps to the same
// cluster_id, so persistDiscoveredClusters can update it in place instead of duplicating it.
function clusterId(members) {
  const digest = crypto.createHash('sha256').update([...members].sort().join(',')).digest('hex');
  return `cluster_${digest.slice(0, 16)}`;
}

/**
 * Reads recent edges, finds connected components, scores each by its members' average
 * reputation risk (server/reputation.js), and returns only the clusters risky enough to be worth
 * surfacing -- clustering alone isn't the signal (see GRAPH_INTELLIGENCE.CLUSTER_RISK_THRESHOLD's
 * comment), clustering combined with elevated reputation is.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} nowMs
 * @returns {Array<{ members: string[], riskScore: number }>}
 */
function discoverClusters(db, nowMs) {
  const sinceIso = new Date(nowMs - GRAPH_INTELLIGENCE.CLUSTER_LOOKBACK_MS).toISOString();
  const edges = db.prepare('SELECT source, target FROM graph_edges WHERE last_seen_at >= ?').all(sinceIso);
  const clusters = findClusters(edges, GRAPH_INTELLIGENCE.MIN_CLUSTER_SIZE);

  const scored = clusters.map((members) => {
    const scores = members.map((m) => computeReputationScore(db, m, 'user').score);
    const riskScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { members, riskScore };
  });

  return scored.filter((c) => c.riskScore >= GRAPH_INTELLIGENCE.CLUSTER_RISK_THRESHOLD);
}

/**
 * Persists newly-discovered risky clusters (idempotent via the deterministic clusterId above --
 * a cluster found again on a later scan updates its existing row's risk_score/discovered_at
 * rather than duplicating it). Returns only the clusters that are genuinely new, for the caller
 * to broadcast -- an already-known cluster being re-scored isn't a new alert.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ members: string[], riskScore: number }>} clusters
 * @param {string} nowIso
 * @returns {Array<{ cluster_id: string, members: string[], risk_score: number }>}
 */
function persistDiscoveredClusters(db, clusters, nowIso) {
  const newlyPersisted = [];
  for (const cluster of clusters) {
    const id = clusterId(cluster.members);
    const existing = db.prepare('SELECT cluster_id FROM graph_clusters WHERE cluster_id = ?').get(id);
    if (existing) {
      db.prepare('UPDATE graph_clusters SET risk_score = ?, discovered_at = ? WHERE cluster_id = ?').run(
        cluster.riskScore,
        nowIso,
        id
      );
      continue;
    }
    db.prepare(
      'INSERT INTO graph_clusters (cluster_id, member_ids_json, risk_score, discovered_at) VALUES (?, ?, ?, ?)'
    ).run(id, JSON.stringify(cluster.members), cluster.riskScore, nowIso);
    newlyPersisted.push({ cluster_id: id, members: cluster.members, risk_score: cluster.riskScore });
  }
  return newlyPersisted;
}

module.exports = { upsertEdge, findClusters, discoverClusters, persistDiscoveredClusters, clusterId };
