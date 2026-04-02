/**
 * graph.js
 * --------
 * Initialises the force-graph instance and handles:
 *  - Node hover/click with tooltip
 *  - Node selection → highlight connected nodes
 *  - Relation labels on anime↔anime edges
 *  - Zoom controls
 *  - Better force simulation (spread nodes, meta node padding)
 */

'use strict';

let graphInstance  = null;
let showLinks      = true;
let selectedNodeId = null;   // currently selected node id (click to select)
let neighborIds    = new Set(); // node_ids directly connected to selected node
let currentLinks   = [];     // last rendered links (for neighbor lookup)

// ── INIT ──────────────────────────────────────────────────────────────────────

function initGraph() {
  const wrap = document.getElementById('graph-canvas');

  graphInstance = ForceGraph()(wrap)
    .backgroundColor('#0d0a07')
    .nodeRelSize(6)
    .nodeColor(n => resolveNodeColor(n))
    .nodeLabel('')                    // custom tooltip
    .linkColor(l => resolveLinkColor(l))
    .linkWidth(l => resolveLinkWidth(l))
    .linkDirectionalArrowLength(0)
    .linkCanvasObjectMode(() => 'after')
    .linkCanvasObject((link, ctx, globalScale) => drawLinkLabel(link, ctx, globalScale))
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick);

  // ── Force simulation tweaks ────────────────────────────────────────────────
  // force-graph exposes the underlying d3 simulation via .d3Force(name).
  // We mutate the existing 'charge' force rather than replacing it, to avoid
  // needing a d3 reference (which isn't exported by the force-graph UMD bundle).
  const d3Lib = (typeof d3 !== 'undefined' ? d3 : ForceGraph.d3);

  // Overwrite Charge
  graphInstance.d3Force('charge', d3Lib.forceManyBody()
    .strength(-120)
    .distanceMax(600)
  );

  // Overwrite Collision
  graphInstance.d3Force('collision', d3Lib.forceCollide(n => {
    const base = Math.sqrt(Math.max(1, n.val || 1)) * 6;
    if (n.data?.type !== 'anime') return base + 14;
    return base + 4;
  }));

  // Reheat the simulation to make sure nodes start rendering
  graphInstance.d3ReheatSimulation();

  // ── Zoom controls ──────────────────────────────────────────────────────────
  document.getElementById('zoom-in').onclick  = () =>
    graphInstance.zoom(graphInstance.zoom() * 1.3, 400);
  document.getElementById('zoom-out').onclick = () =>
    graphInstance.zoom(graphInstance.zoom() * 0.7, 400);
  document.getElementById('zoom-fit').onclick = () =>
    graphInstance.zoomToFit(600);
  document.getElementById('toggle-links').onclick = () => {
    showLinks = !showLinks;
    graphInstance.linkVisibility(showLinks);
  };

  // ── Tooltip mouse tracking ─────────────────────────────────────────────────
  document.getElementById('graph-canvas').addEventListener('mousemove', e => {
    const tt = document.getElementById('tooltip');
    if (tt.style.display === 'none') return;
    const x = e.clientX + 14;
    const y = e.clientY - 10;
    tt.style.left = Math.min(x, window.innerWidth  - 280) + 'px';
    tt.style.top  = Math.min(y, window.innerHeight - 220) + 'px';
  });

  // Click on canvas background → deselect
  document.getElementById('graph-canvas').addEventListener('click', e => {
    // Only deselect if the click was NOT on a node (node click fires onNodeClick first)
    if (!e._nodeClicked) {
      clearSelection();
    }
  });
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function renderGraph({ nodes, links, filteredAnime, visibleMeta }) {
  currentLinks = links;
  clearSelection();

  graphInstance.graphData({ nodes, links });

  document.getElementById('stat-nodes').textContent  = filteredAnime.length.toLocaleString();
  document.getElementById('stat-meta').textContent   = visibleMeta.length.toLocaleString();
  document.getElementById('stat-edges').textContent  = links.length.toLocaleString();

  const clusters = calculateAnimeClusters(nodes, links);
  document.getElementById('stat-clusters').textContent = clusters.toLocaleString();

  setTimeout(() => graphInstance.zoomToFit(800, 50), 600);
}

// ── SELECTION / HIGHLIGHT ─────────────────────────────────────────────────────

function selectNode(nodeId) {
  selectedNodeId = nodeId;

  // Build neighbor set from current links
  neighborIds = new Set();
  currentLinks.forEach(l => {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    if (src === nodeId) neighborIds.add(tgt);
    if (tgt === nodeId) neighborIds.add(src);
  });

  // Force color & opacity refresh
  graphInstance.nodeColor(n => resolveNodeColor(n));
  graphInstance.linkColor(l => resolveLinkColor(l));
  graphInstance.linkWidth(l => resolveLinkWidth(l));
}

function clearSelection() {
  selectedNodeId = null;
  neighborIds    = new Set();
  graphInstance?.nodeColor(n => resolveNodeColor(n));
  graphInstance?.linkColor(l => resolveLinkColor(l));
  graphInstance?.linkWidth(l => resolveLinkWidth(l));
}

// ── COLOR / OPACITY RESOLVERS ─────────────────────────────────────────────────

function resolveNodeColor(n) {
  const base = n.color || '#e8a030';
  if (selectedNodeId === null) return base;

  // Selected node → bright
  if (n.id === selectedNodeId) return base;
  // Neighbor → normal color
  if (neighborIds.has(n.id)) return base;
  // Non-neighbor → dim
  return dimColor(base, 0.15);
}

function resolveLinkColor(l) {
  const src = typeof l.source === 'object' ? l.source.id : l.source;
  const tgt = typeof l.target === 'object' ? l.target.id : l.target;

  const baseAlpha = (l.kind === 'related') ? 0.6 : 0.35;

  if (selectedNodeId !== null) {
    // Only highlight edges connected to selected node
    if (src !== selectedNodeId && tgt !== selectedNodeId) {
      return getLinkBaseColor(l.kind, 0.04);
    }
  }

  return getLinkBaseColor(l.kind, baseAlpha);
}

function resolveLinkWidth(l) {
  if (selectedNodeId === null) return 0.8;
  const src = typeof l.source === 'object' ? l.source.id : l.source;
  const tgt = typeof l.target === 'object' ? l.target.id : l.target;
  if (src === selectedNodeId || tgt === selectedNodeId) return 2;
  return 0.3;
}

function getLinkBaseColor(kind, alpha) {
  const a = alpha.toFixed(2);
  switch (kind) {
    case 'related':   return `rgba(212,163,68,${a})`;
    case 'studio':    return `rgba(94,184,255,${a})`;
    case 'tag':       return `rgba(93,222,154,${a})`;
    case 'character': return `rgba(255,126,179,${a})`;
    case 'staff':     return `rgba(192,156,255,${a})`;
    default:          return `rgba(212,163,68,${a})`;
  }
}

/** Dim a hex/hsl/rgba color by blending toward dark background */
function dimColor(color, opacity) {
  // Return as rgba with low opacity (works for any format)
  // Parse hex to rgb
  let r = 100, g = 80, b = 50;
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    r = parseInt(hex[1].slice(0,2), 16);
    g = parseInt(hex[1].slice(2,4), 16);
    b = parseInt(hex[1].slice(4,6), 16);
  }
  return `rgba(${r},${g},${b},${opacity})`;
}

// ── LINK LABEL (canvas) ───────────────────────────────────────────────────────

function drawLinkLabel(link, ctx, globalScale) {
  // Only draw relation labels on anime↔anime edges that have a label,
  // and only when zoomed in enough to read them
  if (link.kind !== 'related' || !link.relationLabel) return;
  if (globalScale < 2) return;  // too zoomed out to be readable

  const src = link.source;
  const tgt = link.target;
  if (!src || !tgt || typeof src !== 'object') return;

  const midX = (src.x + tgt.x) / 2;
  const midY = (src.y + tgt.y) / 2;

  const label    = link.relationLabel;
  const fontSize = Math.max(2, 8 / globalScale);

  ctx.save();
  ctx.font         = `${fontSize}px "Noto Sans JP", sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // Background pill
  const textW = ctx.measureText(label).width;
  const pad   = fontSize * 0.4;
  ctx.fillStyle = 'rgba(13,10,7,0.85)';
  ctx.beginPath();
  ctx.roundRect
    ? ctx.roundRect(midX - textW/2 - pad, midY - fontSize/2 - pad, textW + pad*2, fontSize + pad*2, 3)
    : ctx.rect(midX - textW/2 - pad, midY - fontSize/2 - pad, textW + pad*2, fontSize + pad*2);
  ctx.fill();

  // Text
  ctx.fillStyle = 'rgba(212,163,68,0.9)';
  ctx.fillText(label, midX, midY);
  ctx.restore();
}

// ── TOOLTIP ───────────────────────────────────────────────────────────────────

function handleNodeHover(node) {
  const tt = document.getElementById('tooltip');
  if (!node) { tt.style.display = 'none'; return; }

  const n = node.data;
  if (!n) { tt.style.display = 'none'; return; }

  let html = '';

  if (n.type === 'anime') {
    const mins     = totalMinutes(n);
    const minsStr  = mins > 0 ? `${Math.round(mins)} min` : 'Unknown';
    const studio   = (n.studio_ids || [])
      .map(id => window._nodeById?.get(id)?.name).filter(Boolean).join(', ') || '—';
    const tags     = (n.tag_ids || [])
      .slice(0, 8).map(id => window._nodeById?.get(id)?.name).filter(Boolean).join(', ');
    const score    = n.score ? n.score.toFixed(2) : '—';
    const year     = n.year  || '?';
    const season   = n.season || '';

    // Completion status badge (if user list loaded)
    let statusBadge = '';
    if (window.userListLoaded && getUserStatusForAnime) {
      const st = getUserStatusForAnime(n.al_id);
      if (st) {
        const col   = (window.COMPLETION_STATUS_COLORS || {})[st] || '#808080';
        const label = (window.COMPLETION_STATUS_LABELS || {})[st] || st;
        statusBadge = `<div class="tt-badge" style="background:${col}22;color:${col};">${label}</div>`;
      }
    }

    html = `
      <div class="tt-title">${esc(n.title)}</div>
      ${n.title_en && n.title_en !== n.title
        ? `<div class="tt-subtitle">${esc(n.title_en)}</div>` : ''}
      <div class="tt-badge" style="background:rgba(232,160,48,0.15);color:var(--gold2);">${n.anime_type}</div>
      ${statusBadge}
      <div class="tt-row"><span class="tt-key">Season</span> ${season} ${year}</div>
      <div class="tt-row"><span class="tt-key">Episodes</span> ${n.episodes || '?'}</div>
      <div class="tt-row"><span class="tt-key">Studio</span> ${esc(studio)}</div>
      <div class="tt-row"><span class="tt-key">Duration</span> ${minsStr}</div>
      <div class="tt-row"><span class="tt-key">Score</span> ${score}</div>
      ${tags ? `<div class="tt-tags">${esc(tags)}</div>` : ''}
    `;
  } else if (n.type === 'studio') {
    html = `
      <div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(94,184,255,0.15);color:#5eb8ff;">Studio</div>
    `;
  } else if (n.type === 'tag') {
    html = `
      <div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(93,222,154,0.15);color:#5dde9a;">Tag / Genre</div>
    `;
  } else if (n.type === 'character') {
    html = `
      <div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(255,126,179,0.15);color:#ff7eb3;">Character</div>
    `;
  } else if (n.type === 'staff') {
    html = `
      <div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(192,156,255,0.15);color:#c09cff;">Staff</div>
    `;
  }

  tt.innerHTML      = html;
  tt.style.display  = 'block';
}

function handleNodeClick(node, event) {
  if (!node) return;
  // Mark the event so the canvas background click handler doesn't deselect immediately
  if (event) event._nodeClicked = true;

  if (selectedNodeId === node.id) {
    // Second click on same node → deselect
    clearSelection();
    return;
  }

  selectNode(node.id);

  // Open AniList page on click for anime nodes
  if (node.data?.type === 'anime' && node.data?.al_url) {
    window.open(node.data.al_url, '_blank');
  }
}

// ── UTIL ──────────────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
