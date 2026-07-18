// Section 15.16, Feature 6: extends the graph engine to detect money flowing out of a business
// account and back into the same account via intermediate hops -- Merchant -> A -> Merchant,
// Merchant -> A -> B -> Merchant, Merchant -> A -> B -> C -> Merchant. Pure function, same
// "no I/O" convention as pipeline.js, so it's directly unit-testable; backgroundJob.js supplies
// the DB-backed transaction list and persists any cycles found.
const { CIRCULAR_FLOW } = require('../config');

function buildAdjacency(transactions) {
  const adjacency = new Map();
  for (const t of transactions) {
    if (!adjacency.has(t.sender_id)) adjacency.set(t.sender_id, []);
    adjacency.get(t.sender_id).push({ receiverId: t.receiver_id, amount: t.amount, timestamp: t.timestamp });
  }
  return adjacency;
}

// DFS from `origin`, following sender->receiver edges, looking for a path that returns to
// `origin` within maxHops intermediate accounts. The closing edge back to origin doesn't count
// against maxHops -- so maxHops=3 permits up to "Merchant -> A -> B -> C -> Merchant" (3
// intermediates, 4 edges total), matching the spec's three examples exactly.
//
// otherOriginIds excludes every OTHER business account from being used as an intermediate hop
// (found live, seeding a multi-store demo): this system's "origins" are the operator's own
// registered storefronts, which legitimately move money between each other and share a customer
// base constantly -- a path that merely passes through another of the business's own stores
// (Store A -> customer -> Store B -> customer -> Store A) is ordinary multi-store commerce, not
// the layering-through-unrelated-accounts pattern this detector exists to catch. Real laundering
// layering routes through accounts *outside* the business's own network. Without this exclusion,
// any two stores sharing enough customers over a long enough window will eventually produce a
// coincidental "cycle" purely by chance, and once found, both stores' entire future transaction
// stream gets treated as involving an active alert (the receiver_ids-membership check in
// alertLookup.js correctly still flags genuine non-business intermediate suspects).
function findCycleFromOrigin(adjacency, origin, maxHops, otherOriginIds) {
  function dfs(current, path, visited, totalAmount, timestamps, hopCount) {
    const edges = adjacency.get(current) || [];
    for (const edge of edges) {
      if (edge.receiverId === origin && path.length >= 2) {
        return {
          path: [...path, origin],
          totalAmount: totalAmount + edge.amount,
          timestamps: [...timestamps, edge.timestamp],
        };
      }
      if (otherOriginIds.has(edge.receiverId)) continue;
      const nextHopCount = hopCount + 1;
      if (nextHopCount <= maxHops && !visited.has(edge.receiverId)) {
        visited.add(edge.receiverId);
        const result = dfs(
          edge.receiverId,
          [...path, edge.receiverId],
          visited,
          totalAmount + edge.amount,
          [...timestamps, edge.timestamp],
          nextHopCount
        );
        visited.delete(edge.receiverId);
        if (result) return result;
      }
    }
    return null;
  }

  return dfs(origin, [origin], new Set([origin]), 0, [], 0);
}

/**
 * @param {Array<{sender_id, receiver_id, amount, timestamp}>} transactions - recent transactions
 *   within the circular-flow lookback window
 * @param {Iterable<string>} originIds - accounts to check as cycle origins (the business's own
 *   registered accounts -- circular flow only matters relative to money that started there)
 * @returns {Array<{ originId: string, path: string[], totalAmount: number, transactionCount: number, windowStart: string, windowEnd: string }>}
 */
function detectCircularFlow(transactions, originIds) {
  const adjacency = buildAdjacency(transactions);
  const cycles = [];
  const originIdSet = new Set(originIds);

  for (const originId of originIds) {
    // Every OTHER origin is excluded as an intermediate hop for this search, but the origin
    // being searched from must stay reachable as the closing node -- that's what path.length >= 2
    // in findCycleFromOrigin's `edge.receiverId === origin` check already guards, independent of
    // this exclusion set.
    const otherOriginIds = new Set([...originIdSet].filter((id) => id !== originId));
    const cycle = findCycleFromOrigin(adjacency, originId, CIRCULAR_FLOW.MAX_CYCLE_HOPS, otherOriginIds);
    if (!cycle) continue;

    const timestampsMs = cycle.timestamps.map((t) => new Date(t).getTime());
    cycles.push({
      originId,
      path: cycle.path,
      totalAmount: cycle.totalAmount,
      transactionCount: cycle.path.length - 1,
      windowStart: new Date(Math.min(...timestampsMs)).toISOString(),
      windowEnd: new Date(Math.max(...timestampsMs)).toISOString(),
    });
  }

  return cycles;
}

module.exports = detectCircularFlow;
