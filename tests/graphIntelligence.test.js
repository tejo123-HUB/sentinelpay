// Continuous Learning Extension, Phase C: graph-relationship discovery (server/graphIntelligence.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { SCHEMA } = require('../server/db');
const { updateReputationAfterTransaction } = require('../server/reputation');
const {
  upsertEdge,
  findClusters,
  discoverClusters,
  persistDiscoveredClusters,
  clusterId,
} = require('../server/graphIntelligence');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function flagTransactions(db, senderId, receiverId, n, flagged) {
  for (let i = 0; i < n; i++) {
    updateReputationAfterTransaction(db, { sender_id: senderId, receiver_id: receiverId, timestamp: '2026-07-18T10:00:00.000Z' }, flagged ? [{ flagged: true }] : []);
  }
}

// ---- findClusters (pure) ----

test('findClusters: a ring of 3 accounts trading with each other forms one cluster', () => {
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'a' },
  ];
  const clusters = findClusters(edges, 3);
  assert.equal(clusters.length, 1);
  assert.deepEqual([...clusters[0]].sort(), ['a', 'b', 'c']);
});

test('findClusters: two unrelated pairs stay separate, and below minClusterSize are dropped', () => {
  const edges = [
    { source: 'x', target: 'y' }, // isolated pair, size 2 -- below default min of 3
    { source: 'p', target: 'q' },
    { source: 'q', target: 'r' },
  ];
  const clusters = findClusters(edges, 3);
  assert.equal(clusters.length, 1);
  assert.deepEqual([...clusters[0]].sort(), ['p', 'q', 'r']);
});

test('findClusters: a chain of many nodes all resolves to a single connected component', () => {
  const edges = [];
  for (let i = 0; i < 10; i++) edges.push({ source: `n${i}`, target: `n${i + 1}` });
  const clusters = findClusters(edges, 3);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 11);
});

// ---- upsertEdge ----

test('upsertEdge: repeated calls accumulate weight/txn_count/total_amount rather than duplicating rows', () => {
  const db = buildTestDb();
  upsertEdge(db, 'biz_1', 'cust_1', 'transaction', 100, '2026-07-18T10:00:00.000Z');
  upsertEdge(db, 'biz_1', 'cust_1', 'transaction', 50, '2026-07-18T10:05:00.000Z');

  const rows = db.prepare('SELECT * FROM graph_edges WHERE source = ? AND target = ? AND edge_type = ?').all('biz_1', 'cust_1', 'transaction');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].txn_count, 2);
  assert.equal(rows[0].total_amount, 150);
  assert.equal(rows[0].last_seen_at, '2026-07-18T10:05:00.000Z');
});

test('upsertEdge: a self-loop (source === target) is a no-op', () => {
  const db = buildTestDb();
  upsertEdge(db, 'a', 'a', 'transaction', 100, '2026-07-18T10:00:00.000Z');
  const count = db.prepare('SELECT COUNT(*) AS n FROM graph_edges').get().n;
  assert.equal(count, 0);
});

// ---- discoverClusters / persistDiscoveredClusters (DB-backed) ----

test('discoverClusters: a low-risk cluster (clean history) is found by union-find but filtered out by the risk threshold', () => {
  const db = buildTestDb();
  const now = new Date('2026-07-18T10:00:00.000Z').getTime();
  upsertEdge(db, 'clean_a', 'clean_b', 'transaction', 100, '2026-07-18T09:59:00.000Z');
  upsertEdge(db, 'clean_b', 'clean_c', 'transaction', 100, '2026-07-18T09:59:00.000Z');
  flagTransactions(db, 'clean_a', 'clean_b', 20, false);
  flagTransactions(db, 'clean_b', 'clean_c', 20, false);

  const clusters = discoverClusters(db, now);
  assert.equal(clusters.length, 0);
});

test('discoverClusters: a ring whose members all have an elevated reputation risk is surfaced', () => {
  const db = buildTestDb();
  const now = new Date('2026-07-18T10:00:00.000Z').getTime();
  upsertEdge(db, 'ring_a', 'ring_b', 'transaction', 100, '2026-07-18T09:59:00.000Z');
  upsertEdge(db, 'ring_b', 'ring_c', 'transaction', 100, '2026-07-18T09:59:00.000Z');
  upsertEdge(db, 'ring_c', 'ring_a', 'transaction', 100, '2026-07-18T09:59:00.000Z');
  for (const [s, r] of [['ring_a', 'ring_b'], ['ring_b', 'ring_c'], ['ring_c', 'ring_a']]) {
    flagTransactions(db, s, r, 20, true);
  }

  const clusters = discoverClusters(db, now);
  assert.equal(clusters.length, 1);
  assert.deepEqual([...clusters[0].members].sort(), ['ring_a', 'ring_b', 'ring_c']);
  assert.ok(clusters[0].riskScore >= 60);
});

test('discoverClusters: an edge outside the lookback window does not connect two otherwise-unrelated accounts', () => {
  const db = buildTestDb();
  const now = new Date('2026-07-18T10:00:00.000Z').getTime();
  // Seeded far outside GRAPH_INTELLIGENCE.CLUSTER_LOOKBACK_MS (24h) -- must not count.
  upsertEdge(db, 'old_a', 'old_b', 'transaction', 100, '2026-07-01T00:00:00.000Z');
  const clusters = discoverClusters(db, now);
  assert.equal(clusters.length, 0);
});

test('persistDiscoveredClusters: the same member set is idempotent (updates in place, never duplicates)', () => {
  const db = buildTestDb();
  const first = persistDiscoveredClusters(db, [{ members: ['a', 'b', 'c'], riskScore: 80 }], '2026-07-18T10:00:00.000Z');
  assert.equal(first.length, 1);

  const second = persistDiscoveredClusters(db, [{ members: ['c', 'a', 'b'], riskScore: 85 }], '2026-07-18T11:00:00.000Z');
  assert.equal(second.length, 0); // same members (any order) -> same clusterId -> not "newly persisted"

  const rows = db.prepare('SELECT * FROM graph_clusters').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].risk_score, 85); // updated in place
  assert.equal(rows[0].cluster_id, clusterId(['a', 'b', 'c']));
});
