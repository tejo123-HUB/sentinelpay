const { initDb } = require('../server/db');
const { upsertEdge } = require('../server/graphIntelligence');

function main() {
  const db = initDb();
  const nowIso = new Date().toISOString();

  // Create 4 distinct users that form a highly risky fraud ring
  const ringMembers = ['fraud_ring_A', 'fraud_ring_B', 'fraud_ring_C', 'fraud_ring_D'];

  ringMembers.forEach(userId => {
    // Ensure they exist in users table
    db.prepare('INSERT OR IGNORE INTO users (user_id, created_at) VALUES (?, ?)').run(userId, nowIso);
    
    // Give them an explicitly high reputation risk score (95) to ensure they exceed the CLUSTER_RISK_THRESHOLD of 60
    db.prepare(`
      INSERT INTO entity_reputation (entity_id, entity_type, txn_count, flag_count, score, last_updated_at)
      VALUES (?, 'user', 10, 8, 95, ?)
      ON CONFLICT(entity_id, entity_type) DO UPDATE SET score = 95, flag_count = 8, txn_count = 10, last_updated_at = ?
    `).run(userId, nowIso, nowIso);
  });

  // Link them all together so they form a single Connected Component (Cluster)
  upsertEdge(db, ringMembers[0], ringMembers[1], 'transaction', 500, nowIso);
  upsertEdge(db, ringMembers[1], ringMembers[2], 'transaction', 500, nowIso);
  upsertEdge(db, ringMembers[2], ringMembers[3], 'transaction', 500, nowIso);
  upsertEdge(db, ringMembers[3], ringMembers[0], 'shared_device', 0, nowIso); // Ring closure via shared device

  console.log("Successfully seeded a highly risky cluster (fraud_ring_A, B, C, D) into the database.");
  console.log("The background job (runGraphClusterScan) will automatically discover it on its next 7-second tick.");
  
  db.close();
}

if (require.main === module) {
  main();
}
