/**
 * graph.js
 * --------
 * Force-graph instance, rendering, interaction.
 *
 * Performance improvements:
 *  - Reduced nodeRelSize; coolingTime reduced so simulation stops faster
 *  - Collision force disabled by default (too expensive at 10k+ nodes);
 *    only enabled when node count is below threshold
 *  - Link canvas object (relation labels) only runs when zoomed in
 *  - currentNodes lookup uses a Map instead of Array.find()
 *  - warmupTicks / cooldownTicks tuned for fast initial layout
 *  - d3 alphaDecay increased so sim stops sooner
 */

'use strict';

let graphInstance  = null;
let showLinks      = true;
let selectedNodeId = null;
let neighborIds    = new Set();
let currentLinks   = [];
let currentNodeMap = new Map();  // id → node (faster than find())

// Legend highlight
let legendHighlightKey = null;
let legendHighlightVal = null;

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const COLLISION_NODE_THRESHOLD = 3000;  // disable collision above this count
const NODE_REL_SIZE = 5;

// ── INIT ──────────────────────────────────────────────────────────────────────
function initGraph() {
  const wrap = document.getElementById('graph-canvas');
  graphInstance = ForceGraph()(wrap);

  graphInstance
    .backgroundColor('#0d0a07')
    .nodeRelSize(NODE_REL_SIZE)
    .nodeColor(n => resolveNodeColor(n))
    .nodeVal(n => n.val || 1)
    .nodeLabel('')
    .linkColor(l => resolveLinkColor(l))
    .linkWidth(l => resolveLinkWidth(l))
    .linkDirectionalArrowLength(0)
    .linkCanvasObjectMode(() => 'after')
    .linkCanvasObject((link, ctx, globalScale) => drawLinkLabel(link, ctx, globalScale))
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick)
    // Performance: stop simulation sooner
    .d3AlphaDecay(0.03)
    .d3VelocityDecay(0.4)
    .warmupTicks(30)
    .cooldownTicks(150)
    .cooldownTime(4000);

  // Repulsion — moderate, stops at reasonable distance
  const chargeForce = graphInstance.d3Force('charge');
  if (chargeForce?.strength) {
    chargeForce.strength(-80).distanceMax(400);
  }

  // Collision only for smaller graphs
  try {
    if (typeof d3 !== 'undefined') {
      graphInstance.d3Force('collision',
        d3.forceCollide(n => {
          const r = Math.sqrt(Math.max(1, n.val || 1)) * NODE_REL_SIZE;
          return r + (n.data?.type !== 'anime' ? 8 : 3);
        }).strength(0.5)
      );
    }
  } catch (_) {}

  // Zoom controls
  document.getElementById('zoom-in').onclick  = () =>
    graphInstance.zoom(graphInstance.zoom() * 1.3, 300);
  document.getElementById('zoom-out').onclick = () =>
    graphInstance.zoom(graphInstance.zoom() * 0.7, 300);
  document.getElementById('zoom-fit').onclick = () =>
    graphInstance.zoomToFit(500);
  document.getElementById('toggle-links').onclick = () => {
    showLinks = !showLinks;
    graphInstance.linkVisibility(showLinks);
  };

  // Tooltip mouse tracking
  document.getElementById('graph-canvas').addEventListener('mousemove', e => {
    const tt = document.getElementById('tooltip');
    if (tt.style.display === 'none') return;
    const x = Math.min(e.clientX + 14, window.innerWidth  - 280);
    const y = Math.min(e.clientY - 10, window.innerHeight - 240);
    tt.style.left = x + 'px';
    tt.style.top  = y + 'px';
  });

  // Background click → deselect
  document.getElementById('graph-canvas').addEventListener('click', e => {
    if (!e._nodeClicked) { clearSelection(); clearLegendHighlight(); }
  });

  // Legend click
  document.getElementById('legend').addEventListener('click', e => {
    const item = e.target.closest('.legend-item[data-legend-key]');
    if (!item) return;
    const key = item.dataset.legendKey;
    const val = item.dataset.legendVal;
    if (legendHighlightKey === key && legendHighlightVal === val) {
      clearLegendHighlight();
    } else {
      legendHighlightKey = key;
      legendHighlightVal = val;
      clearSelection();
      refreshColors();
    }
    document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('legend-active'));
    if (legendHighlightKey) item.classList.add('legend-active');
  });
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function renderGraph({ nodes, links, filteredAnime, highlightedAnime, visibleMeta }) {
  if (!graphInstance) return;
  currentLinks   = links;
  currentNodeMap = new Map(nodes.map(n => [n.id, n]));
  clearSelection();
  clearLegendHighlight();

  // Disable collision for large graphs
  try {
    if (typeof d3 !== 'undefined') {
      if (nodes.length > COLLISION_NODE_THRESHOLD) {
        graphInstance.d3Force('collision', null);
      } else {
        graphInstance.d3Force('collision',
          d3.forceCollide(n => {
            const r = Math.sqrt(Math.max(1, n.val || 1)) * NODE_REL_SIZE;
            return r + (n.data?.type !== 'anime' ? 8 : 3);
          }).strength(0.5)
        );
      }
    }
  } catch (_) {}

  graphInstance.graphData({ nodes, links });

  const animeCount = filteredAnime.length + (highlightedAnime?.length || 0);
  document.getElementById('stat-nodes').textContent  = filteredAnime.length.toLocaleString();
  document.getElementById('stat-meta').textContent   = visibleMeta.length.toLocaleString();
  document.getElementById('stat-edges').textContent  = links.length.toLocaleString();

  // Cluster stats (async so it doesn't block rendering)
  setTimeout(() => {
    const { count, largest } = calculateAnimeClusters(nodes, links);
    document.getElementById('stat-clusters').textContent        = count.toLocaleString();
    document.getElementById('stat-largest-cluster').textContent = largest.toLocaleString();

    const minCluster = parseInt(document.getElementById('min-cluster-size')?.value) || 1;
    if (minCluster > 1 && window.countClustersOfMinSize) {
      const filtered = window.countClustersOfMinSize(nodes, links, minCluster);
      document.getElementById('stat-clusters').textContent = `${filtered.toLocaleString()} (≥${minCluster})`;
    }

    const chain = calculateLongestChain(nodes, links);
    document.getElementById('stat-longest-chain').textContent = chain.toLocaleString();
  }, 100);

  setTimeout(() => graphInstance.zoomToFit(700, 40), 500);
}

// ── SELECTION ─────────────────────────────────────────────────────────────────
function selectNode(nodeId) {
  selectedNodeId = nodeId;
  neighborIds    = new Set();

  for (const l of currentLinks) {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    if (src === nodeId || tgt === nodeId) {
      const otherId   = src === nodeId ? tgt : src;
      const otherNode = currentNodeMap.get(otherId);
      if (otherNode?.data?.type === 'anime') neighborIds.add(otherId);
    }
  }
  refreshColors();
}

function clearSelection() {
  selectedNodeId = null;
  neighborIds    = new Set();
  refreshColors();
}

function clearLegendHighlight() {
  legendHighlightKey = null;
  legendHighlightVal = null;
  document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('legend-active'));
  refreshColors();
}

function refreshColors() {
  graphInstance?.nodeColor(n => resolveNodeColor(n));
  graphInstance?.linkColor(l => resolveLinkColor(l));
  graphInstance?.linkWidth(l => resolveLinkWidth(l));
}

// ── COLOR RESOLVERS ───────────────────────────────────────────────────────────
function resolveNodeColor(n) {
  const base = n.color || '#e8a030';

  if (legendHighlightKey && !selectedNodeId) {
    return nodMatchesLegend(n, legendHighlightKey, legendHighlightVal)
      ? base : dimColor(base, 0.1);
  }

  if (selectedNodeId !== null) {
    if (n.id === selectedNodeId || neighborIds.has(n.id)) return base;
    return dimColor(base, 0.1);
  }

  if (n.dimmed) return dimColor(base, 0.18);
  return base;
}

function nodMatchesLegend(n, key, val) {
  const d = n.data;
  if (!d) return false;
  switch (key) {
    case 'node_type':  return d.type === 'anime';
    case 'anime_type': return d.anime_type === val;
    case 'year_band': {
      const band = (window.YEAR_BANDS || []).find(b => b.label === val);
      if (!band) return false;
      const idx  = (window.YEAR_BANDS || []).indexOf(band);
      const minY = idx > 0 ? (window.YEAR_BANDS[idx - 1].max + 1) : 0;
      return d.year >= minY && d.year <= band.max;
    }
    case 'season':         return (d.season || 'Unknown') === val;
    case 'release_status': return (d.release_status || 'UNKNOWN') === val;
    case 'completion': {
      const st = getUserStatusForAnime ? getUserStatusForAnime(d.al_id) : null;
      return st === val;
    }
    case 'meta_type': return d.type === val;
    default: return false;
  }
}

function resolveLinkColor(l) {
  const src = typeof l.source === 'object' ? l.source.id : l.source;
  const tgt = typeof l.target === 'object' ? l.target.id : l.target;
  const base = l.kind === 'related' ? 0.35 : 0.18;

  if (selectedNodeId !== null) {
    if (src !== selectedNodeId && tgt !== selectedNodeId) return getLinkColor(l.kind, 0.03);
    return getLinkColor(l.kind, base);
  }

  if (legendHighlightKey) {
    const sn = currentNodeMap.get(src);
    const tn = currentNodeMap.get(tgt);
    const sm = sn && nodMatchesLegend(sn, legendHighlightKey, legendHighlightVal);
    const tm = tn && nodMatchesLegend(tn, legendHighlightKey, legendHighlightVal);
    if (!sm && !tm) return getLinkColor(l.kind, 0.03);
  }

  return getLinkColor(l.kind, base);
}

function resolveLinkWidth(l) {
  if (!selectedNodeId && !legendHighlightKey) return 0.5;
  const src = typeof l.source === 'object' ? l.source.id : l.source;
  const tgt = typeof l.target === 'object' ? l.target.id : l.target;

  if (selectedNodeId) {
    return (src === selectedNodeId || tgt === selectedNodeId) ? 2 : 0.15;
  }
  if (legendHighlightKey) {
    const sn = currentNodeMap.get(src);
    const tn = currentNodeMap.get(tgt);
    const sm = sn && nodMatchesLegend(sn, legendHighlightKey, legendHighlightVal);
    const tm = tn && nodMatchesLegend(tn, legendHighlightKey, legendHighlightVal);
    return (sm || tm) ? 1.5 : 0.15;
  }
  return 0.5;
}

function getLinkColor(kind, alpha) {
  const a = alpha.toFixed(2);
  switch (kind) {
    case 'related': return `rgba(255,255,255,${a})`;
    case 'studio':  return `rgba(94,184,255,${a})`;
    case 'genre':   return `rgba(255,179,71,${a})`;
    case 'tag':     return `rgba(93,222,154,${a})`;
    default:        return `rgba(255,255,255,${a})`;
  }
}

function dimColor(color, opacity) {
  let r = 100, g = 80, b = 50;
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    r = parseInt(hex[1].slice(0,2), 16);
    g = parseInt(hex[1].slice(2,4), 16);
    b = parseInt(hex[1].slice(4,6), 16);
  }
  return `rgba(${r},${g},${b},${opacity})`;
}

// ── LINK LABEL ────────────────────────────────────────────────────────────────
function drawLinkLabel(link, ctx, globalScale) {
  if (link.kind !== 'related' || !link.relationLabel || globalScale < 2.5) return;
  const src = link.source, tgt = link.target;
  if (!src || !tgt || typeof src !== 'object') return;

  const midX = (src.x + tgt.x) / 2;
  const midY = (src.y + tgt.y) / 2;
  const label    = link.relationLabel;
  const fontSize = Math.max(2, 7 / globalScale);

  ctx.save();
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw  = ctx.measureText(label).width;
  const pad = fontSize * 0.35;
  ctx.fillStyle = 'rgba(13,10,7,0.82)';
  ctx.fillRect(midX - tw/2 - pad, midY - fontSize/2 - pad, tw + pad*2, fontSize + pad*2);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
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
    const mins    = totalMinutes(n);
    const minsStr = mins > 0 ? `${Math.round(mins)} min` : 'Unknown';
    const studio  = (n.studio_ids || []).map(id => window._nodeById?.get(id)?.name).filter(Boolean).join(', ') || '—';
    const genres  = (n.genre_ids  || []).slice(0,6).map(id => window._nodeById?.get(id)?.name).filter(Boolean).join(', ');
    const tags    = (n.tag_ids    || []).slice(0,5).map(id => window._nodeById?.get(id)?.name).filter(Boolean).join(', ');
    const score   = n.score ? n.score.toFixed(2) : '—';

    let statusBadge = '';
    if (window.userListLoaded && getUserStatusForAnime) {
      const st = getUserStatusForAnime(n.al_id);
      if (st) {
        const col   = (window.COMPLETION_STATUS_COLORS||{})[st]||'#808080';
        const label = (window.COMPLETION_STATUS_LABELS||{})[st]||st;
        statusBadge = `<div class="tt-badge" style="background:${col}22;color:${col};">${label}</div>`;
      }
    }
    let userScoreRow = '';
    if (window.userListLoaded && getUserScoreForAnime) {
      const us = getUserScoreForAnime(n.al_id);
      if (us != null) {
        const delta = n.score ? (us - n.score).toFixed(2) : null;
        const sign  = delta !== null && parseFloat(delta) >= 0 ? '+' : '';
        const col   = delta !== null ? (parseFloat(delta) >= 0 ? '#6c6' : '#c66') : '';
        userScoreRow = `<div class="tt-row"><span class="tt-key">Your Score</span> ${us.toFixed(1)}${delta !== null ? ` <span style="color:${col}">(${sign}${delta})</span>` : ''}</div>`;
      }
    }

    const rsLabel = (window.RELEASE_STATUS_LABELS||{})[n.release_status] || n.release_status || '?';

    html = `
      <div class="tt-title">${esc(n.title)}</div>
      ${n.title_en && n.title_en !== n.title ? `<div class="tt-subtitle">${esc(n.title_en)}</div>` : ''}
      <div class="tt-badge" style="background:rgba(232,160,48,0.15);color:var(--gold2);">${n.anime_type}</div>
      ${statusBadge}
      <div class="tt-row"><span class="tt-key">Season</span> ${n.season||''} ${n.year||'?'}</div>
      <div class="tt-row"><span class="tt-key">Status</span> ${rsLabel}</div>
      <div class="tt-row"><span class="tt-key">Episodes</span> ${n.episodes||'?'}</div>
      <div class="tt-row"><span class="tt-key">Studio</span> ${esc(studio)}</div>
      <div class="tt-row"><span class="tt-key">Duration</span> ${minsStr}</div>
      <div class="tt-row"><span class="tt-key">Score</span> ${score}</div>
      ${userScoreRow}
      ${genres ? `<div class="tt-tags"><b>Genres:</b> ${esc(genres)}</div>` : ''}
      ${tags   ? `<div class="tt-tags"><b>Tags:</b> ${esc(tags)}</div>` : ''}`;

  } else if (n.type === 'studio') {
    html = `<div class="tt-title">${esc(n.name)}</div><div class="tt-badge" style="background:rgba(94,184,255,0.15);color:#5eb8ff;">Studio</div>`;
  } else if (n.type === 'genre') {
    html = `<div class="tt-title">${esc(n.name)}</div><div class="tt-badge" style="background:rgba(255,179,71,0.15);color:#ffb347;">Genre</div>`;
  } else if (n.type === 'tag') {
    html = `<div class="tt-title">${esc(n.name)}</div><div class="tt-badge" style="background:rgba(93,222,154,0.15);color:#5dde9a;">Tag</div>`;
  }

  tt.innerHTML     = html;
  tt.style.display = 'block';
}

function handleNodeClick(node, event) {
  if (!node) return;
  if (event) event._nodeClicked = true;

  if (selectedNodeId === node.id) { clearSelection(); return; }

  clearLegendHighlight();
  selectNode(node.id);

  if (node.data?.type === 'anime' && node.data?.al_url) {
    window.open(node.data.al_url, '_blank');
  }
}

// ── UTIL ──────────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
