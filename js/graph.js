/**
 * graph.js
 * --------
 * Initialises the force-graph instance and handles:
 *  - Node hover/click with tooltip
 *  - Node selection → highlight connected anime nodes (not meta)
 *  - Relation labels on anime↔anime edges
 *  - Zoom controls
 *  - Force simulation
 *  - Node size scales with val; padding radius scales with node size
 *  - Highlight dimming for filter highlight mode
 *  - Legend click highlights
 */

'use strict';

let graphInstance  = null;
let showLinks      = true;
let selectedNodeId = null;
let neighborIds    = new Set();  // anime node_ids adjacent to selected
let currentLinks   = [];
let currentNodes   = [];

// Legend highlight state
let legendHighlightKey = null;
let legendHighlightVal = null;

// ── INIT ──────────────────────────────────────────────────────────────────────
function initGraph() {
  const wrap = document.getElementById('graph-canvas');
  graphInstance = ForceGraph()(wrap);

  graphInstance
    .backgroundColor('#0d0a07')
    .nodeRelSize(6)
    .nodeColor(n => resolveNodeColor(n))
    .nodeVal(n => n.val || 1)
    .nodeLabel('')
    .linkColor(l => resolveLinkColor(l))
    .linkWidth(l => resolveLinkWidth(l))
    .linkDirectionalArrowLength(0)
    .linkCanvasObjectMode(() => 'after')
    .linkCanvasObject((link, ctx, globalScale) => drawLinkLabel(link, ctx, globalScale))
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick);

  // Force simulation tweaks
  const chargeForce = graphInstance.d3Force('charge');
  if (chargeForce && typeof chargeForce.strength === 'function') {
    chargeForce.strength(-150).distanceMax(700);
  }

  // Collision — radius scales with node val/size
  try {
    const d3ref = (typeof d3 !== 'undefined') ? d3 : null;
    if (d3ref) {
      graphInstance.d3Force('collision',
        d3ref.forceCollide(n => {
          // nodeRelSize=6, so visual radius ≈ sqrt(val)*6
          const visualR = Math.sqrt(Math.max(1, n.val || 1)) * 6;
          const nodeType = n.data?.type;
          const padding  = nodeType !== 'anime' ? visualR * 0.8 + 12 : visualR * 0.5 + 4;
          return visualR + padding;
        })
      );
    }
  } catch (_) {}

  // Zoom controls
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

  // Tooltip mouse tracking
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
    if (!e._nodeClicked) {
      clearSelection();
      clearLegendHighlight();
    }
  });

  // Legend click handler
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
    // Visual feedback
    document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('legend-active'));
    if (legendHighlightKey) item.classList.add('legend-active');
  });
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function renderGraph({ nodes, links, filteredAnime, highlightedAnime, visibleMeta }) {
  if (!graphInstance) return;
  currentLinks = links;
  currentNodes = nodes;
  clearSelection();
  clearLegendHighlight();

  graphInstance.graphData({ nodes, links });

  document.getElementById('stat-nodes').textContent  = filteredAnime.length.toLocaleString();
  document.getElementById('stat-meta').textContent   = visibleMeta.length.toLocaleString();
  document.getElementById('stat-edges').textContent  = links.length.toLocaleString();

  const { count, largest } = calculateAnimeClusters(nodes, links);
  document.getElementById('stat-clusters').textContent       = count.toLocaleString();
  document.getElementById('stat-largest-cluster').textContent = largest.toLocaleString();

  const chain = calculateLongestChain(nodes, links);
  document.getElementById('stat-longest-chain').textContent  = chain.toLocaleString();

  setTimeout(() => graphInstance.zoomToFit(800, 50), 600);
}

// ── SELECTION ─────────────────────────────────────────────────────────────────
function selectNode(nodeId) {
  selectedNodeId = nodeId;
  neighborIds = new Set();

  // Only highlight adjacent ANIME nodes (not meta)
  currentLinks.forEach(l => {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    if (src === nodeId || tgt === nodeId) {
      const otherId = src === nodeId ? tgt : src;
      // Only add if it's an anime node
      const otherNode = currentNodes.find(n => n.id === otherId);
      if (otherNode?.data?.type === 'anime') {
        neighborIds.add(otherId);
      }
    }
  });

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

  // Highlight mode dimming (filter mismatch)
  const isDimmedByFilter = n.dimmed === true;

  // Legend highlight
  if (legendHighlightKey && !selectedNodeId) {
    const matches = nodMatchesLegend(n, legendHighlightKey, legendHighlightVal);
    if (!matches) return dimColor(base, 0.12);
    return base;
  }

  // Node selection highlight
  if (selectedNodeId !== null) {
    if (n.id === selectedNodeId) return base;
    if (neighborIds.has(n.id)) return base;
    return dimColor(base, 0.12);
  }

  // Filter highlight mode
  if (isDimmedByFilter) return dimColor(base, 0.2);

  return base;
}

function nodMatchesLegend(n, key, val) {
  const d = n.data;
  if (!d) return false;
  switch (key) {
    case 'type':        return d.type === val;
    case 'anime_type':  return d.anime_type === val;
    case 'year_band': {
      const band = (window.YEAR_BANDS || []).find(b => b.label === val);
      if (!band) return false;
      const prev = (window.YEAR_BANDS || []).find(b => b.max < band.max);
      const minY = prev ? prev.max + 1 : 0;
      return d.year >= minY && d.year <= band.max;
    }
    case 'season':      return (d.season || 'Unknown') === val;
    case 'country':     return (d.country || '??') === val;
    case 'completion': {
      const st = getUserStatusForAnime ? getUserStatusForAnime(d.al_id) : null;
      return st === val;
    }
    case 'meta_type':   return d.type === val;
    default: return false;
  }
}

function resolveLinkColor(l) {
  const src = typeof l.source === 'object' ? l.source.id : l.source;
  const tgt = typeof l.target === 'object' ? l.target.id : l.target;
  const baseAlpha = (l.kind === 'related') ? 0.45 : 0.22;

  if (selectedNodeId !== null) {
    if (src !== selectedNodeId && tgt !== selectedNodeId) {
      return getLinkBaseColor(l.kind, 0.03);
    }
    return getLinkBaseColor(l.kind, baseAlpha);
  }

  if (legendHighlightKey) {
    const srcNode = currentNodes.find(n => n.id === src);
    const tgtNode = currentNodes.find(n => n.id === tgt);
    const srcMatch = srcNode && nodMatchesLegend(srcNode, legendHighlightKey, legendHighlightVal);
    const tgtMatch = tgtNode && nodMatchesLegend(tgtNode, legendHighlightKey, legendHighlightVal);
    if (!srcMatch && !tgtMatch) return getLinkBaseColor(l.kind, 0.03);
  }

  return getLinkBaseColor(l.kind, baseAlpha);
}

function resolveLinkWidth(l) {
  if (selectedNodeId === null && !legendHighlightKey) return 0.6;
  const src = typeof l.source === 'object' ? l.source.id : l.source;
  const tgt = typeof l.target === 'object' ? l.target.id : l.target;

  if (selectedNodeId !== null) {
    if (src === selectedNodeId || tgt === selectedNodeId) return 2;
    return 0.2;
  }

  if (legendHighlightKey) {
    const srcNode = currentNodes.find(n => n.id === src);
    const tgtNode = currentNodes.find(n => n.id === tgt);
    const srcMatch = srcNode && nodMatchesLegend(srcNode, legendHighlightKey, legendHighlightVal);
    const tgtMatch = tgtNode && nodMatchesLegend(tgtNode, legendHighlightKey, legendHighlightVal);
    if (srcMatch || tgtMatch) return 1.5;
    return 0.2;
  }

  return 0.6;
}

function getLinkBaseColor(kind, alpha) {
  const a = alpha.toFixed(2);
  switch (kind) {
    case 'related':   return `rgba(255,255,255,${a})`;   // white
    case 'studio':    return `rgba(94,184,255,${a})`;
    case 'genre':     return `rgba(255,179,71,${a})`;
    case 'tag':       return `rgba(93,222,154,${a})`;
    case 'character': return `rgba(255,126,179,${a})`;
    case 'staff':     return `rgba(192,156,255,${a})`;
    default:          return `rgba(255,255,255,${a})`;
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
  if (link.kind !== 'related' || !link.relationLabel) return;
  if (globalScale < 2) return;

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

  const textW = ctx.measureText(label).width;
  const pad   = fontSize * 0.4;
  ctx.fillStyle = 'rgba(13,10,7,0.85)';
  ctx.beginPath();
  ctx.roundRect
    ? ctx.roundRect(midX - textW/2 - pad, midY - fontSize/2 - pad, textW + pad*2, fontSize + pad*2, 3)
    : ctx.rect(midX - textW/2 - pad, midY - fontSize/2 - pad, textW + pad*2, fontSize + pad*2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
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
    const studio  = (n.studio_ids || [])
      .map(id => window._nodeById?.get(id)?.name).filter(Boolean).join(', ') || '—';
    const genres  = (n.genre_ids || [])
      .slice(0, 5).map(id => window._nodeById?.get(id)?.name).filter(Boolean).join(', ');
    const tags    = (n.tag_ids || [])
      .slice(0, 5).map(id => window._nodeById?.get(id)?.name).filter(Boolean).join(', ');
    const score   = n.score ? n.score.toFixed(2) : '—';
    const year    = n.year  || '?';
    const season  = n.season || '';
    const country = window.COUNTRY_LABELS?.[n.country || '??'] || n.country || '?';

    let statusBadge = '';
    if (window.userListLoaded && getUserStatusForAnime) {
      const st = getUserStatusForAnime(n.al_id);
      if (st) {
        const col   = (window.COMPLETION_STATUS_COLORS || {})[st] || '#808080';
        const label = (window.COMPLETION_STATUS_LABELS || {})[st] || st;
        statusBadge = `<div class="tt-badge" style="background:${col}22;color:${col};">${label}</div>`;
      }
    }

    let userScoreRow = '';
    if (window.userListLoaded && getUserScoreForAnime) {
      const us = getUserScoreForAnime(n.al_id);
      if (us != null) {
        const delta = n.score ? (us - n.score).toFixed(2) : null;
        userScoreRow = `<div class="tt-row"><span class="tt-key">Your Score</span> ${us.toFixed(1)}${delta !== null ? ` <span style="color:${parseFloat(delta)>=0?'#6c6':'#c66'}">(${parseFloat(delta)>0?'+':''}${delta})</span>` : ''}</div>`;
      }
    }

    html = `
      <div class="tt-title">${esc(n.title)}</div>
      ${n.title_en && n.title_en !== n.title ? `<div class="tt-subtitle">${esc(n.title_en)}</div>` : ''}
      <div class="tt-badge" style="background:rgba(232,160,48,0.15);color:var(--gold2);">${n.anime_type}</div>
      ${statusBadge}
      <div class="tt-row"><span class="tt-key">Season</span> ${season} ${year}</div>
      <div class="tt-row"><span class="tt-key">Episodes</span> ${n.episodes || '?'}</div>
      <div class="tt-row"><span class="tt-key">Studio</span> ${esc(studio)}</div>
      <div class="tt-row"><span class="tt-key">Country</span> ${esc(country)}</div>
      <div class="tt-row"><span class="tt-key">Duration</span> ${minsStr}</div>
      <div class="tt-row"><span class="tt-key">Score</span> ${score}</div>
      ${userScoreRow}
      <div class="tt-row"><span class="tt-key">Status</span> ${n.release_status || '?'}</div>
      ${genres ? `<div class="tt-tags"><b>Genres:</b> ${esc(genres)}</div>` : ''}
      ${tags   ? `<div class="tt-tags"><b>Tags:</b> ${esc(tags)}</div>`   : ''}
    `;
  } else if (n.type === 'studio') {
    html = `<div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(94,184,255,0.15);color:#5eb8ff;">Studio</div>`;
  } else if (n.type === 'genre') {
    html = `<div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(255,179,71,0.15);color:#ffb347;">Genre</div>`;
  } else if (n.type === 'tag') {
    html = `<div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(93,222,154,0.15);color:#5dde9a;">Tag</div>`;
  } else if (n.type === 'character') {
    html = `<div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(255,126,179,0.15);color:#ff7eb3;">Character</div>`;
  } else if (n.type === 'staff') {
    html = `<div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(192,156,255,0.15);color:#c09cff;">Staff</div>`;
  }

  tt.innerHTML      = html;
  tt.style.display  = 'block';
}

function handleNodeClick(node, event) {
  if (!node) return;
  if (event) event._nodeClicked = true;

  // Toggle selection
  if (selectedNodeId === node.id) {
    clearSelection();
    return;
  }

  clearLegendHighlight();
  selectNode(node.id);

  // Open AniList page for anime nodes
  if (node.data?.type === 'anime' && node.data?.al_url) {
    window.open(node.data.al_url, '_blank');
  }
}

// ── UTIL ──────────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
