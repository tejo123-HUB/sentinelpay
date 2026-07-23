// Partial-Feature Completion Pass: Graph Intelligence's Interactive Graph Visualization gap.
// A real force-directed layout on a plain <canvas> (no d3/vis.js/Cytoscape dependency,
// consistent with this project's dependency-light convention) consuming the existing
// GET /graph/relationships and GET /graph/clusters endpoints. Lazily initializes on first view
// (same pattern as map.js -- a canvas has no meaningful size while its tab is hidden).
//
// 3D-styled redesign: the canvas stays a flat 2D drawing surface (still no WebGL/three.js
// dependency), but nodes render as glossy gradient-lit spheres with floor shadows, edges carry
// an animated directional flow, a CSS 3D perspective tilt is applied to the whole stage, and a
// pan/zoom camera (mouse wheel + drag) replaces the old "everything must fit the fixed canvas
// width" layout, which used to force labels to overlap on wide trees.
const GRAPH_MAX_ITERATIONS = 220;
const GRAPH_REPULSION = 2600;
const GRAPH_SPRING_LENGTH = 90;
const GRAPH_SPRING_STRENGTH = 0.02;
const GRAPH_DAMPING = 0.85;

const CLUSTER_PALETTE = ['#2a78d6', '#d0733b', '#4fae4f', '#a24fd6', '#d63b7a', '#3bb0b0', '#c9a227'];
const ROOT_COLOR = '#d03b3b';
const NODE_DEFAULT_COLOR = '#898781';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.18;
const REVEAL_STAGGER_MS = 90; // per tree level, for the level-by-level "assemble" entrance
const REVEAL_DURATION_MS = 420;

let graphCanvas = null;
let graphCtx = null;
let graphStage = null;
let graphInitAttempted = false;
let graphNodes = [];
let graphEdges = [];
let graphAnimationHandle = null;
let draggingNode = null;
let isTreeMode = false;
let flowPhase = 0; // advances every frame to animate the directional "flow" dashes on edges

// Camera (pan/zoom) state -- all node coordinates stay in graph-space; this is applied as a
// single ctx.translate/scale around every draw call, and inverted when converting pointer
// coordinates back to graph-space for hit-testing/dragging.
let camX = 0;
let camY = 0;
let camZoom = 1;
let isPanningCanvas = false;
let panStart = null;

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

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const n = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function shade(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  if (amount >= 0) {
    return `rgb(${clamp(r + (255 - r) * amount)}, ${clamp(g + (255 - g) * amount)}, ${clamp(b + (255 - b) * amount)})`;
  }
  return `rgb(${clamp(r * (1 + amount))}, ${clamp(g * (1 + amount))}, ${clamp(b * (1 + amount))})`;
}

function toGraphCoords(clientX, clientY) {
  const rect = graphCanvas.getBoundingClientRect();
  const scaleX = graphCanvas.width / rect.width;
  const scaleY = graphCanvas.height / rect.height;
  const canvasX = (clientX - rect.left) * scaleX;
  const canvasY = (clientY - rect.top) * scaleY;
  return { x: (canvasX - camX) / camZoom, y: (canvasY - camY) / camZoom };
}

function nodeRevealFactor(node) {
  if (node.revealStart == null) return 1;
  const elapsed = performance.now() - node.revealStart;
  if (elapsed <= 0) return 0;
  if (elapsed >= REVEAL_DURATION_MS) return 1;
  // Cubic ease-out "pop" -- a slight overshoot reads as a node settling into place, which sells
  // the 3D "assembling" entrance better than a linear fade.
  const t = elapsed / REVEAL_DURATION_MS;
  return 1 - Math.pow(1 - t, 3);
}

function scheduleReveal(nodes, { staggerByLevel = true } = {}) {
  const now = performance.now();
  nodes.forEach((node, i) => {
    const delay = staggerByLevel ? (node.level || 0) * REVEAL_STAGGER_MS : (i % 12) * 18;
    node.revealStart = now + delay;
  });
}

function layoutStep() {
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
  }
}

// Draws a soft elliptical contact shadow beneath a node, offset by its depth -- the single
// biggest cue that sells "floating sphere above a lit floor" rather than "flat circle."
function drawNodeShadow(ctx, node, radius, depthScale) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(node.x, node.y + radius * 0.85, radius * 1.05 * depthScale, radius * 0.4 * depthScale, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15, 15, 20, 0.22)';
  ctx.filter = 'blur(2px)';
  ctx.fill();
  ctx.restore();
}

function drawGlossyNode(ctx, node, radius, color, depthScale) {
  const cx = node.x - radius * 0.35;
  const cy = node.y - radius * 0.4;
  const gradient = ctx.createRadialGradient(cx, cy, radius * 0.05, node.x, node.y, radius * 1.15);
  gradient.addColorStop(0, shade(color, 0.65));
  gradient.addColorStop(0.45, shade(color, 0.08));
  gradient.addColorStop(1, shade(color, -0.35));

  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  // Rim light -- a thin brighter arc along the upper-left edge, standard "glossy sphere" cue.
  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, Math.PI * 1.05, Math.PI * 1.75);
  ctx.strokeStyle = shade(color, 0.75);
  ctx.lineWidth = Math.max(1, radius * 0.14);
  ctx.globalAlpha = 0.55 * depthScale;
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Small specular highlight dot -- the classic "shiny marble" tell.
  ctx.beginPath();
  ctx.ellipse(cx, cy, radius * 0.28, radius * 0.18, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fill();
}

function drawFloorGrid(ctx, width, height) {
  // A faint receding grid -- reinforces the perspective tilt applied via CSS on the stage
  // without needing a real 3D renderer.
  ctx.save();
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.06)';
  ctx.lineWidth = 1;
  const step = 40;
  for (let x = 0; x < width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawEdge(ctx, edge, isTree) {
  const a = edge.sourceNode;
  const b = edge.targetNode;
  if (!a || !b) return;

  const revealA = nodeRevealFactor(a);
  const revealB = nodeRevealFactor(b);
  const edgeReveal = Math.min(revealA, revealB);
  if (edgeReveal <= 0) return;

  const colorA = graphColorForNode(a);
  const colorB = graphColorForNode(b);
  const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
  gradient.addColorStop(0, colorA);
  gradient.addColorStop(1, colorB);

  ctx.save();
  ctx.globalAlpha = edgeReveal;

  if (isTree) {
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(236,72,153,0.4)';
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 2.5;
  } else {
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(137,135,129,0.35)';
    ctx.lineWidth = 1;
  }

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  let midX = (a.x + b.x) / 2;
  let midY = (a.y + b.y) / 2;
  if (isTree) {
    const cy = (a.y + b.y) / 2;
    ctx.bezierCurveTo(a.x, cy, b.x, cy, b.x, b.y);
    midY = cy;
  } else {
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  // Directional "money flow" -- a short bright dash traveling from source to receiver, looping
  // continuously. Cheap to compute (no particle system) but reads as animated flow.
  if (edgeReveal > 0.6) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist > 14) {
      const t = ((flowPhase * 0.012) % 1 + 1) % 1;
      const flowT = isTree ? t : (t + (edge.sourceNode.id.length % 7) / 7) % 1;
      const px = isTree
        ? bezierPoint(a.x, a.x, b.x, b.x, flowT)
        : a.x + (b.x - a.x) * flowT;
      const py = isTree
        ? bezierPoint(a.y, midY, midY, b.y, flowT)
        : a.y + (b.y - a.y) * flowT;
      ctx.beginPath();
      ctx.arc(px, py, isTree ? 3 : 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.shadowBlur = 8;
      ctx.shadowColor = colorB;
      ctx.globalAlpha = edgeReveal * 0.95;
      ctx.fill();
    }
  }

  ctx.restore();
}

function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function drawGraph() {
  if (!graphCtx) return;
  const width = graphCanvas.width;
  const height = graphCanvas.height;
  graphCtx.clearRect(0, 0, width, height);
  drawFloorGrid(graphCtx, width, height);

  graphCtx.save();
  graphCtx.translate(camX, camY);
  graphCtx.scale(camZoom, camZoom);

  for (const edge of graphEdges) {
    drawEdge(graphCtx, edge, isTreeMode);
  }

  // Shadows first (all of them), then bodies, so no node's shadow ever paints over a
  // neighboring node's body -- consistent "one lit floor" depth ordering.
  for (const node of graphNodes) {
    const reveal = nodeRevealFactor(node);
    if (reveal <= 0) continue;
    const baseRadius = node.type === 'root' ? (isTreeMode ? 14 : 10) : 5 + Math.min(node.degree || (isTreeMode ? 3 : 0), 10);
    const depthScale = isTreeMode ? Math.max(0.55, 1 - (node.level || 0) * 0.06) : 1;
    const radius = baseRadius * depthScale * reveal;
    drawNodeShadow(graphCtx, node, radius, depthScale);
  }

  for (const node of graphNodes) {
    const reveal = nodeRevealFactor(node);
    if (reveal <= 0) continue;
    const baseRadius = node.type === 'root' ? (isTreeMode ? 14 : 10) : 5 + Math.min(node.degree || (isTreeMode ? 3 : 0), 10);
    const depthScale = isTreeMode ? Math.max(0.55, 1 - (node.level || 0) * 0.06) : 1;
    const radius = baseRadius * depthScale * reveal;
    const color = graphColorForNode(node);

    graphCtx.save();
    graphCtx.globalAlpha = reveal * (isTreeMode ? Math.max(0.5, depthScale) : 1);
    drawGlossyNode(graphCtx, node, radius, color, depthScale);
    graphCtx.restore();

    graphCtx.save();
    graphCtx.globalAlpha = reveal;
    graphCtx.fillStyle = '#3a3a38';
    graphCtx.font = (isTreeMode && node.type === 'root') ? 'bold 12px "IBM Plex Sans", sans-serif' : '11px "IBM Plex Sans", sans-serif';
    const label = node.id.length > 18 ? `${node.id.slice(0, 16)}…` : node.id;
    // A thin white halo behind the label keeps it legible over the floor grid/edges at any zoom.
    graphCtx.lineWidth = 3;
    graphCtx.strokeStyle = 'rgba(255,255,255,0.85)';
    graphCtx.strokeText(label, node.x + radius + 4, node.y + 4);
    graphCtx.fillText(label, node.x + radius + 4, node.y + 4);
    graphCtx.restore();
  }

  graphCtx.restore();
}

function runLayoutAnimation() {
  flowPhase += 1;
  if (isTreeMode) {
    if (graphAnimationHandle) cancelAnimationFrame(graphAnimationHandle);
    // Tree mode has no physics to settle, but the loop keeps running continuously (cheap on a
    // canvas this size) to drive the reveal-in stagger and the ongoing edge flow-dash animation.
    const tick = () => {
      flowPhase += 1;
      drawGraph();
      graphAnimationHandle = requestAnimationFrame(tick);
    };
    tick();
    return;
  }
  let iteration = 0;
  function tick() {
    flowPhase += 1;
    if (iteration >= GRAPH_MAX_ITERATIONS) {
      drawGraph();
      graphAnimationHandle = requestAnimationFrame(function idleFlow() {
        flowPhase += 1;
        drawGraph();
        graphAnimationHandle = requestAnimationFrame(idleFlow);
      });
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

  const roots = graphNodes.filter((n) => n.level === 0);
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

  // Fixed, generous spacing -- no longer compressed to fit the visible canvas width, since the
  // camera (pan/zoom, auto-fit) now handles wide trees instead of forcing labels to overlap.
  const actualHSpacing = 130;
  const actualVSpacing = 110;

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
    positionNode(r, currentX, 60);
    currentX += subtreeLeaves.get(r.id) * actualHSpacing;
  }
}

// Frames the camera (pan + zoom) so every node fits inside the visible canvas with padding --
// replaces the old approach of squeezing the layout itself to the canvas width, which is what
// caused labels to pile up on wide/bushy trees.
function fitViewToContent(padding = 70) {
  if (graphNodes.length === 0) {
    camX = 0;
    camY = 0;
    camZoom = 1;
    return;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of graphNodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  const contentW = Math.max(maxX - minX, 1);
  const contentH = Math.max(maxY - minY, 1);
  const availW = Math.max(graphCanvas.width - padding * 2, 50);
  const availH = Math.max(graphCanvas.height - padding * 2, 50);
  camZoom = Math.min(availW / contentW, availH / contentH, MAX_ZOOM);
  camZoom = Math.max(camZoom, MIN_ZOOM);
  const contentCx = (minX + maxX) / 2;
  const contentCy = (minY + maxY) / 2;
  camX = graphCanvas.width / 2 - contentCx * camZoom;
  camY = graphCanvas.height / 2 - contentCy * camZoom;
}

function setZoom(newZoom, pivotX, pivotY) {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
  const px = pivotX != null ? pivotX : graphCanvas.width / 2;
  const py = pivotY != null ? pivotY : graphCanvas.height / 2;
  // Keep the point under the pivot stationary on screen while zooming.
  const graphPx = (px - camX) / camZoom;
  const graphPy = (py - camY) / camZoom;
  camZoom = clamped;
  camX = px - graphPx * camZoom;
  camY = py - graphPy * camZoom;
  drawGraph();
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
    scheduleReveal(graphNodes, { staggerByLevel: false });
    isTreeMode = false;
    camZoom = 1;
    camX = 0;
    camY = 0;
    runLayoutAnimation();
    setTimeout(() => fitViewToContent(), GRAPH_MAX_ITERATIONS * 16 + 60);

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
    fitViewToContent();
    scheduleReveal(graphNodes, { staggerByLevel: true });
    runLayoutAnimation();

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

function initGraphPointerTilt() {
  if (!graphStage) return;
  const wrap = document.getElementById('graph-canvas-wrap');
  if (!wrap) return;
  wrap.addEventListener('mousemove', (event) => {
    if (isPanningCanvas || draggingNode) return;
    const rect = wrap.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5; // -0.5..0.5
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    graphStage.style.setProperty('--tilt-x', `${(-py * 6).toFixed(2)}deg`);
    graphStage.style.setProperty('--tilt-y', `${(px * 8).toFixed(2)}deg`);
  });
  wrap.addEventListener('mouseleave', () => {
    graphStage.style.setProperty('--tilt-x', '0deg');
    graphStage.style.setProperty('--tilt-y', '0deg');
  });
}

function initGraphInteractions() {
  graphCanvas.addEventListener('mousedown', (event) => {
    const { x, y } = toGraphCoords(event.clientX, event.clientY);
    draggingNode = graphNodes.find((n) => Math.hypot(n.x - x, n.y - y) < 14 / camZoom) || null;
    if (!draggingNode) {
      isPanningCanvas = true;
      panStart = { clientX: event.clientX, clientY: event.clientY, camX, camY };
      graphCanvas.style.cursor = 'grabbing';
    }
  });
  window.addEventListener('mousemove', (event) => {
    if (draggingNode) {
      const { x, y } = toGraphCoords(event.clientX, event.clientY);
      draggingNode.x = x;
      draggingNode.y = y;
      draggingNode.vx = 0;
      draggingNode.vy = 0;
      drawGraph();
      return;
    }
    if (isPanningCanvas && panStart) {
      camX = panStart.camX + (event.clientX - panStart.clientX);
      camY = panStart.camY + (event.clientY - panStart.clientY);
      drawGraph();
    }
  });
  window.addEventListener('mouseup', () => {
    draggingNode = null;
    if (isPanningCanvas) {
      isPanningCanvas = false;
      panStart = null;
      graphCanvas.style.cursor = 'grab';
    }
  });

  graphCanvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = graphCanvas.getBoundingClientRect();
    const scaleX = graphCanvas.width / rect.width;
    const scaleY = graphCanvas.height / rect.height;
    const pivotX = (event.clientX - rect.left) * scaleX;
    const pivotY = (event.clientY - rect.top) * scaleY;
    const nextZoom = event.deltaY < 0 ? camZoom * ZOOM_STEP : camZoom / ZOOM_STEP;
    setZoom(nextZoom, pivotX, pivotY);
  }, { passive: false });

  graphCanvas.addEventListener('dblclick', (event) => {
    const { x, y } = toGraphCoords(event.clientX, event.clientY);
    const clicked = graphNodes.find((n) => Math.hypot(n.x - x, n.y - y) < 14 / camZoom);
    if (clicked) {
      const input = document.getElementById('graph-account-input');
      if (input) input.value = clicked.id;
      loadGraphForAccount(clicked.id);
    }
  });
}

function initGraphZoomControls() {
  const zoomIn = document.getElementById('graph-zoom-in');
  const zoomOut = document.getElementById('graph-zoom-out');
  const zoomReset = document.getElementById('graph-zoom-reset');
  if (zoomIn) zoomIn.addEventListener('click', () => setZoom(camZoom * ZOOM_STEP));
  if (zoomOut) zoomOut.addEventListener('click', () => setZoom(camZoom / ZOOM_STEP));
  if (zoomReset) zoomReset.addEventListener('click', () => {
    fitViewToContent();
    drawGraph();
  });
}

function initGraph() {
  if (graphInitAttempted) return;
  graphInitAttempted = true;

  graphCanvas = document.getElementById('graph-canvas');
  graphStage = document.getElementById('graph-canvas-stage');
  const panel = document.getElementById('graph-canvas-wrap');
  if (!graphCanvas) return;
  graphCtx = graphCanvas.getContext('2d');
  resizeGraphCanvas();
  window.addEventListener('resize', () => {
    resizeGraphCanvas();
    fitViewToContent();
    drawGraph();
  });

  initGraphInteractions();
  initGraphPointerTilt();
  initGraphZoomControls();

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
    fitViewToContent();
    drawGraph();
  }
});

// A newly discovered cluster (Continuous Learning Extension's background scan) refreshes the
// cluster chip list live, same "reuse the existing WebSocket feed" pattern as map.js/audit.js.
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('sentinelpay:graph-cluster', () => loadClustersList());
});
