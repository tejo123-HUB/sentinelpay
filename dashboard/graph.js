// Partial-Feature Completion Pass: Graph Intelligence's Interactive Graph Visualization gap.
// A real force-directed layout on a plain <canvas> (no d3/vis.js/Cytoscape dependency,
// consistent with this project's dependency-light convention) consuming the existing
// GET /graph/relationships and GET /graph/clusters endpoints. Lazily initializes on first view
// (same pattern as map.js -- a canvas has no meaningful size while its tab is hidden).
const GRAPH_MAX_ITERATIONS = 220;
const GRAPH_REPULSION = 2600;
const GRAPH_SPRING_LENGTH = 90;
const GRAPH_SPRING_STRENGTH = 0.02;
const GRAPH_DAMPING = 0.85;

const CLUSTER_PALETTE = ['#2a78d6', '#d0733b', '#4fae4f', '#a24fd6', '#d63b7a', '#3bb0b0', '#c9a227'];
const ROOT_COLOR = '#d03b3b';
const NODE_DEFAULT_COLOR = '#898781';

let graphCanvas = null;
let graphCtx = null;
let graphInitAttempted = false;
let graphNodes = [];
let graphEdges = [];
let graphAnimationHandle = null;
let draggingNode = null;
let isTreeMode = false;

function graphColorForNode(node) {
  if (node.type === 'blocked') return '#ec4899';
  if (node.type === 'root') return ROOT_COLOR;
  if (node.cluster_id) {
    // Deterministic color from the cluster id's own characters, so the same cluster always
    // renders the same color across reloads without needing a server-assigned index.
    let hash = 0;
    for (const ch of node.cluster_id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return CLUSTER_PALETTE[hash % CLUSTER_PALETTE.length];
  }
  return NODE_DEFAULT_COLOR;
}

function layoutStep() {
  const width = graphCanvas.width;
  const height = graphCanvas.height;

  for (const a of graphNodes) {
    if (a === draggingNode) continue;
    let fx = 0;
    let fy = 0;
    for (const b of graphNodes) {
      if (a === b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distSq = Math.max(dx * dx + dy * dy, 1);
      const force = GRAPH_REPULSION / distSq;
      const dist = Math.sqrt(distSq);
      fx += (dx / dist) * force;
      fy += (dy / dist) * force;
    }
    a.vx = (a.vx + fx) * GRAPH_DAMPING;
    a.vy = (a.vy + fy) * GRAPH_DAMPING;
  }

  for (const edge of graphEdges) {
    const a = edge.sourceNode;
    const b = edge.targetNode;
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const displacement = dist - GRAPH_SPRING_LENGTH;
    const force = displacement * GRAPH_SPRING_STRENGTH;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    if (a !== draggingNode) {
      a.vx += fx;
      a.vy += fy;
    }
    if (b !== draggingNode) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  for (const node of graphNodes) {
    if (node === draggingNode) continue;
    node.x += node.vx * 0.02;
    node.y += node.vy * 0.02;
    node.x = Math.max(20, Math.min(width - 20, node.x));
    node.y = Math.max(20, Math.min(height - 20, node.y));
  }
}

function drawGraph() {
  if (!graphCtx) return;
  const width = graphCanvas.width;
  const height = graphCanvas.height;
  graphCtx.clearRect(0, 0, width, height);

  if (isTreeMode) {
    graphCtx.shadowBlur = 10;
    graphCtx.shadowColor = 'rgba(236,72,153,0.4)';
    graphCtx.strokeStyle = 'rgba(236,72,153,0.85)';
    graphCtx.lineWidth = 2.5;
  } else {
    graphCtx.shadowBlur = 0;
    graphCtx.strokeStyle = 'rgba(137,135,129,0.35)';
    graphCtx.lineWidth = 1;
  }

  for (const edge of graphEdges) {
    if (!edge.sourceNode || !edge.targetNode) continue;
    graphCtx.beginPath();
    graphCtx.moveTo(edge.sourceNode.x, edge.sourceNode.y);
    if (isTreeMode) {
      const cy = (edge.sourceNode.y + edge.targetNode.y) / 2;
      graphCtx.bezierCurveTo(edge.sourceNode.x, cy, edge.targetNode.x, cy, edge.targetNode.x, edge.targetNode.y);
    } else {
      graphCtx.lineTo(edge.targetNode.x, edge.targetNode.y);
    }
    graphCtx.stroke();
  }

  graphCtx.shadowBlur = isTreeMode ? 12 : 0;

  for (const node of graphNodes) {
    const radius = node.type === 'root' ? (isTreeMode ? 14 : 10) : 5 + Math.min(node.degree || (isTreeMode ? 3 : 0), 10);
    graphCtx.beginPath();
    graphCtx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    graphCtx.fillStyle = graphColorForNode(node);
    
    if (isTreeMode && node.type === 'blocked') {
      graphCtx.shadowColor = 'rgba(236,72,153,0.8)';
    } else {
      graphCtx.shadowColor = 'transparent';
    }
    
    graphCtx.fill();
    graphCtx.strokeStyle = '#ffffff';
    graphCtx.lineWidth = isTreeMode ? 2 : 1.5;
    graphCtx.stroke();

    graphCtx.shadowBlur = 0;
    graphCtx.fillStyle = '#3a3a38';
    graphCtx.font = (isTreeMode && node.type === 'root') ? 'bold 12px "IBM Plex Sans", sans-serif' : '11px "IBM Plex Sans", sans-serif';
    graphCtx.fillText(node.id.length > 18 ? `${node.id.slice(0, 16)}…` : node.id, node.x + radius + 4, node.y + 4);
  }
}

function runLayoutAnimation() {
  if (isTreeMode) {
    if (graphAnimationHandle) cancelAnimationFrame(graphAnimationHandle);
    drawGraph();
    return;
  }
  let iteration = 0;
  function tick() {
    if (iteration >= GRAPH_MAX_ITERATIONS) {
      drawGraph();
      return;
    }
    layoutStep();
    drawGraph();
    iteration += 1;
    graphAnimationHandle = requestAnimationFrame(tick);
  }
  if (graphAnimationHandle) cancelAnimationFrame(graphAnimationHandle);
  tick();
}

function seedRandomPositions() {
  const width = graphCanvas.width || 800;
  const height = graphCanvas.height || 500;
  for (const node of graphNodes) {
    node.x = width / 2 + (Math.random() - 0.5) * width * 0.6;
    node.y = height / 2 + (Math.random() - 0.5) * height * 0.6;
    node.vx = 0;
    node.vy = 0;
  }
}

function layoutTreeNodes() {
  const width = graphCanvas.width || 800;
  const height = graphCanvas.height || 480;
  
  const roots = graphNodes.filter(n => n.level === 0);
  if (roots.length === 0) return;

  const childrenMap = new Map();
  let maxLevel = 0;
  for (const n of graphNodes) {
    childrenMap.set(n.id, []);
    if ((n.level || 0) > maxLevel) maxLevel = n.level || 0;
  }
  
  for (const e of graphEdges) {
    if (!e.sourceNode || !e.targetNode) continue;
    if (e.targetNode.level === e.sourceNode.level + 1) {
      childrenMap.get(e.sourceNode.id).push(e.targetNode);
    } else if (e.sourceNode.level === e.targetNode.level + 1) {
      childrenMap.get(e.targetNode.id).push(e.sourceNode);
    }
  }

  // Calculate leaves per subtree to allocate proportional width
  const subtreeLeaves = new Map();
  function countLeaves(node) {
    const children = childrenMap.get(node.id);
    if (!children || children.length === 0) {
      subtreeLeaves.set(node.id, 1);
      return 1;
    }
    let leaves = 0;
    for (const c of children) {
      leaves += countLeaves(c);
    }
    subtreeLeaves.set(node.id, leaves);
    return leaves;
  }
  
  roots.forEach(countLeaves);
  const totalLeaves = roots.reduce((sum, r) => sum + subtreeLeaves.get(r.id), 0);
  
  // Dynamically scale spacing so it always fits horizontally and vertically
  const H_SPACING = (width - 60) / Math.max(1, totalLeaves);
  const actualHSpacing = Math.min(140, H_SPACING); 
  
  const V_SPACING = (height - 100) / Math.max(1, maxLevel);
  const actualVSpacing = Math.min(110, V_SPACING);
  
  function positionNode(node, xStart, y) {
    const leaves = subtreeLeaves.get(node.id);
    node.x = xStart + (leaves * actualHSpacing) / 2;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    
    let currentX = xStart;
    const children = childrenMap.get(node.id);
    if (children) {
      for (const c of children) {
        positionNode(c, currentX, y + actualVSpacing);
        currentX += subtreeLeaves.get(c.id) * actualHSpacing;
      }
    }
  }
  
  const totalUsedWidth = totalLeaves * actualHSpacing;
  let currentX = (width - totalUsedWidth) / 2; // Center in canvas
  for (const r of roots) {
    positionNode(r, currentX, 50);
    currentX += subtreeLeaves.get(r.id) * actualHSpacing;
  }
}

async function loadGraphForAccount(accountId) {
  const status = document.getElementById('graph-status');
  if (!accountId) return;
  if (status) status.textContent = `Loading relationships for ${accountId}…`;

  try {
    const depth = document.getElementById('graph-depth-select')?.value || '1';
    const res = await authFetch(`/graph/relationships?account_id=${encodeURIComponent(accountId)}&depth=${encodeURIComponent(depth)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      if (status) status.textContent = (body && body.error) || 'Failed to load graph.';
      return;
    }
    const data = await res.json();
    const nodeById = new Map();
    graphNodes = (data.nodes || []).map((n) => {
      const node = { ...n, x: 0, y: 0, vx: 0, vy: 0 };
      nodeById.set(n.id, node);
      return node;
    });
    graphEdges = (data.edges || []).map((e) => ({
      ...e,
      sourceNode: nodeById.get(e.source),
      targetNode: nodeById.get(e.target),
    }));

    seedRandomPositions();
    isTreeMode = false;
    runLayoutAnimation();

    if (status) {
      status.textContent = `${graphNodes.length} node(s), ${graphEdges.length} edge(s)${data.truncated ? ' (truncated at the node cap)' : ''}`;
    }
  } catch (err) {
    console.error('Failed to load graph relationships:', err);
    if (status) status.textContent = 'Failed to load graph.';
  }
}

async function loadBlockedTreeForAccount(accountId) {
  const status = document.getElementById('graph-status');
  if (!accountId) return;
  if (status) status.textContent = `Loading blocked payments tree for ${accountId}…`;

  try {
    const res = await authFetch(`/graph/blocked-tree?account_id=${encodeURIComponent(accountId)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      if (status) status.textContent = (body && body.error) || 'Failed to load blocked tree.';
      return;
    }
    const data = await res.json();
    const nodeById = new Map();
    graphNodes = (data.nodes || []).map((n) => {
      const node = { ...n, x: 0, y: 0, vx: 0, vy: 0 };
      nodeById.set(n.id, node);
      return node;
    });
    graphEdges = (data.edges || []).map((e) => ({
      ...e,
      sourceNode: nodeById.get(e.source),
      targetNode: nodeById.get(e.target),
    }));

    isTreeMode = true;
    layoutTreeNodes();
    drawGraph();

    if (status) {
      status.textContent = `${graphNodes.length} node(s), ${graphEdges.length} blocked payment(s) found.`;
    }
  } catch (err) {
    console.error('Failed to load blocked tree:', err);
    if (status) status.textContent = 'Failed to load blocked tree.';
  }
}

async function loadClustersList() {
  const container = document.getElementById('graph-clusters-list');
  if (!container) return;
  try {
    const res = await authFetch('/graph/clusters?limit=20');
    const data = await res.json();
    const clusters = data.clusters || [];
    if (clusters.length === 0) {
      container.innerHTML = '<span class="empty-state">No risky clusters discovered yet.</span>';
      return;
    }
    container.innerHTML = clusters
      .map(
        (c) =>
          `<button class="graph-cluster-chip" data-members="${escapeHtml(c.members[0])}" title="${escapeHtml(c.members.join(', '))}">
            ${c.members.length} members · risk ${Math.round(c.risk_score)}
          </button>`
      )
      .join('');
  } catch (err) {
    console.error('Failed to load graph clusters:', err);
  }
}

function resizeGraphCanvas() {
  if (!graphCanvas) return;
  const parent = graphCanvas.parentElement;
  if (!parent) return;
  graphCanvas.width = parent.clientWidth || 800;
  graphCanvas.height = 480;
}

function initGraphInteractions() {
  graphCanvas.addEventListener('mousedown', (event) => {
    const rect = graphCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    draggingNode = graphNodes.find((n) => Math.hypot(n.x - x, n.y - y) < 12) || null;
  });
  window.addEventListener('mousemove', (event) => {
    if (!draggingNode) return;
    const rect = graphCanvas.getBoundingClientRect();
    draggingNode.x = event.clientX - rect.left;
    draggingNode.y = event.clientY - rect.top;
    draggingNode.vx = 0;
    draggingNode.vy = 0;
    drawGraph();
  });
  window.addEventListener('mouseup', () => {
    draggingNode = null;
  });

  graphCanvas.addEventListener('dblclick', (event) => {
    const rect = graphCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const clicked = graphNodes.find((n) => Math.hypot(n.x - x, n.y - y) < 12);
    if (clicked) {
      const input = document.getElementById('graph-account-input');
      if (input) input.value = clicked.id;
      loadGraphForAccount(clicked.id);
    }
  });
}

function initGraph() {
  if (graphInitAttempted) return;
  graphInitAttempted = true;

  graphCanvas = document.getElementById('graph-canvas');
  const panel = document.getElementById('graph-canvas-wrap');
  if (!graphCanvas) return;
  graphCtx = graphCanvas.getContext('2d');
  resizeGraphCanvas();
  window.addEventListener('resize', () => {
    resizeGraphCanvas();
    drawGraph();
  });

  initGraphInteractions();

  const form = document.getElementById('graph-search-form');
  const input = document.getElementById('graph-account-input');
  if (form && input) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      loadGraphForAccount(input.value.trim());
    });
  }
  
  const blockedTreeBtn = document.getElementById('graph-blocked-tree-btn');
  if (blockedTreeBtn && input) {
    blockedTreeBtn.addEventListener('click', () => {
      loadBlockedTreeForAccount(input.value.trim());
    });
  }
  const depthSelect = document.getElementById('graph-depth-select');
  if (depthSelect) {
    depthSelect.addEventListener('change', () => {
      if (input && input.value.trim()) loadGraphForAccount(input.value.trim());
    });
  }

  const clustersList = document.getElementById('graph-clusters-list');
  if (clustersList) {
    clustersList.addEventListener('click', (event) => {
      const btn = event.target.closest('.graph-cluster-chip');
      if (!btn) return;
      if (input) input.value = btn.dataset.members;
      loadGraphForAccount(btn.dataset.members);
    });
  }

  loadClustersList();
  if (panel) panel.querySelector('.empty-state')?.remove();
}

document.addEventListener('sentinelpay:view-shown', (event) => {
  if (event.detail.view === 'graph') {
    initGraph();
    resizeGraphCanvas();
    drawGraph();
  }
});

// A newly discovered cluster (Continuous Learning Extension's background scan) refreshes the
// cluster chip list live, same "reuse the existing WebSocket feed" pattern as map.js/audit.js.
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('sentinelpay:graph-cluster', () => loadClustersList());
});
