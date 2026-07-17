// Section 16, Category 20/21: records mutations to the editable registries (business_accounts,
// fraud_lists) -- who (by IP, since this build has no user auth -- Section 15.6), what, and
// when. A real audit trail of admin actions, distinct from the flags/audit-trail dashboard,
// which records fraud *detections*, not registry *edits*.
const crypto = require('node:crypto');

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ action: string, targetType: string, targetId?: string, detail?: string, actorIp?: string }} entry
 */
function recordAdminAction(db, { action, targetType, targetId, detail, actorIp }) {
  db.prepare(
    'INSERT INTO admin_audit_log (log_id, action, target_type, target_id, detail, actor_ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(`log_${crypto.randomUUID()}`, action, targetType, targetId || null, detail || null, actorIp || null, new Date().toISOString());
}

module.exports = { recordAdminAction };
