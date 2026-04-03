/**
 * graph.js — Anigraph
 *
 * Layout: warmupTicks run synchronously (blocking on a worker-like RAF loop),
 * then positions are frozen. A loading overlay shows progress during warmup.
 * Meta nodes get strong outward centrifugal pre-positioning.
 * Jittered initial positions prevent circle formations.
 */
'use strict';

let graphInstance  = null;
let showLinks      = true;
let selectedNodeId = null;
let neighborIds    = new Set();
let currentLinks   = [];
let currentNodeMap = new Map();
let legendHighlightKey = null;
let legendHighlightVal = null;
let _highlightedClusterIds = null;
let _highlightedChainIds   = null;

const NODE_REL_SIZE = 5;

// ── RENDER LOADING OVERLAY ─────────────────────────────────────────────────────
function showRenderOverlay(msg) {
  let el = document.getElementById('render-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'render-overlay';
    el.innerHTML = `
      <div class="render-overlay-inner">
        <div class="render-overlay-msg" id="render-overlay-msg"></div>
        <div class="render-overlay-bar-wrap"><div class="render-overlay-bar" id="render-overlay-bar"></div></div>
      </div>`;
    document.getElementById('graph-wrap')?.appendChild(el);
  }
  document.getElementById('render-overlay-msg').textContent = msg || 'Computing layout…';
  document.getElementById('render-overlay-bar').style.width = '0%';
  el.style.display = 'flex';
}
function updateRenderOverlay(pct, msg) {
  const bar = document.getElementById('render-overlay-bar');
  const msg_el = document.getElementById('render-overlay-msg');
  if (bar) bar.style.width = Math.round(pct) + '%';
  if (msg_el && msg) msg_el.textContent = msg;
}
function hideRenderOverlay() {
  const el = document.getElementById('render-overlay');
  if (el) el.style.display = 'none';
}

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
    .linkCanvasObject((link, ctx, gs) => drawLinkLabel(link, ctx, gs))
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick)
    .enableNodeDrag(false)
    .d3AlphaDecay(0.04)
    .d3VelocityDecay(0.5)
    .warmupTicks(120)     // we handle warmup manually in renderGraph
    .cooldownTicks(0)
    .cooldownTime(0)
    .onEngineStop(() => {
      const gd = graphInstance.graphData();
      gd.nodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
      hideRenderOverlay();
    });

  // Tuned charge: strong, distance-limited to avoid pulling distant clusters
  const charge = graphInstance.d3Force('charge');
  if (charge?.strength) charge.strength(-150).distanceMax(600);

  // No link distance force — let charge handle spread
  graphInstance.d3Force('link')?.distance(40).strength(0.5);

  // No collision — too expensive at 10k+ nodes
  graphInstance.d3Force('collision', null);

  // ── Zoom controls ─────────────────────────────────────────────────────────
  document.getElementById('zoom-in').onclick  = () => graphInstance.zoom(graphInstance.zoom() * 1.3, 300);
  document.getElementById('zoom-out').onclick = () => graphInstance.zoom(graphInstance.zoom() * 0.7, 300);
  document.getElementById('zoom-fit').onclick = () => graphInstance.zoomToFit(500);
  document.getElementById('toggle-links').onclick = () => {
    showLinks = !showLinks;
    graphInstance.linkVisibility(showLinks);
  };

  // ── Tooltip tracking ──────────────────────────────────────────────────────
  document.getElementById('graph-canvas').addEventListener('mousemove', e => {
    const tt = document.getElementById('tooltip');
    if (tt.style.display === 'none') return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const x = (e.clientX + 14 + 280 > vw) ? e.clientX - 290 : e.clientX + 14;
    const y = Math.min(e.clientY - 10, vh - 260);
    tt.style.left = x + 'px';
    tt.style.top  = y + 'px';
  });

  // ── Background click ───────────────────────────────────────────────────────
  document.getElementById('graph-canvas').addEventListener('click', e => {
    if (!e._nodeClicked) {
      clearSelection(); clearLegendHighlight(); clearClusterChainHighlight();
    }
  });

  // ── Legend click ──────────────────────────────────────────────────────────
  document.getElementById('legend').addEventListener('click', e => {
    const item = e.target.closest('.legend-item[data-legend-key]');
    if (!item) return;
    const key = item.dataset.legendKey, val = item.dataset.legendVal;
    if (legendHighlightKey === key && legendHighlightVal === val) {
      clearLegendHighlight();
    } else {
      legendHighlightKey = key; legendHighlightVal = val;
      clearSelection(); clearClusterChainHighlight(); refreshColors();
    }
    document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('legend-active'));
    if (legendHighlightKey) item.classList.add('legend-active');
  });
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function renderGraph({ nodes, links, filteredAnime, highlightedAnime, visibleMeta }) {
  if (!graphInstance) return;

  // Un-freeze all nodes
  nodes.forEach(n => { delete n.fx; delete n.fy; delete n.x; delete n.y; });

  currentLinks   = links;
  currentNodeMap = new Map(nodes.map(n => [n.id, n]));

  clearSelection();
  clearLegendHighlight();

  // Show loading overlay
  const warmupCount = nodes.length > 8000 ? 50 : nodes.length > 3000 ? 80 : nodes.length > 1000 ? 120 : 180;
  showRenderOverlay(`Computing layout… (${nodes.length.toLocaleString()} nodes)`);

  // Set warmup ticks and let onEngineStop hide the overlay
  graphInstance
    .warmupTicks(warmupCount)
    .cooldownTicks(0)
    .cooldownTime(0);

  graphInstance.graphData({ nodes, links });

  // Animate overlay progress bar during warmup (approximate)
  const startTime = performance.now();
  const estimatedMs = warmupCount * (nodes.length > 5000 ? 8 : nodes.length > 1000 ? 4 : 2);
  const progressInterval = setInterval(() => {
    const elapsed = performance.now() - startTime;
    const pct = Math.min(95, (elapsed / estimatedMs) * 100);
    updateRenderOverlay(pct);
    if (pct >= 95) clearInterval(progressInterval);
  }, 100);
  // Ensure interval is cleared when engine stops
  graphInstance.onEngineStop(() => {
    clearInterval(progressInterval);
    updateRenderOverlay(100, 'Freezing positions…');
    const gd = graphInstance.graphData();
    gd.nodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
    setTimeout(() => {
      hideRenderOverlay();
      graphInstance.zoomToFit(600, 40);
    }, 200);
  });

  // Stats
  document.getElementById('stat-nodes').textContent = filteredAnime.length.toLocaleString();
  document.getElementById('stat-meta').textContent  = visibleMeta.length.toLocaleString();
  document.getElementById('stat-edges').textContent = links.length.toLocaleString();

  // Cluster + chain stats async
  setTimeout(() => {
    const { count, largest, largestClusterIds } = calculateAnimeClusters(nodes, links);
    document.getElementById('stat-clusters').textContent        = count.toLocaleString();
    document.getElementById('stat-largest-cluster').textContent = largest.toLocaleString();
    window._largestClusterIds = largestClusterIds;

    const minCluster = parseInt(document.getElementById('min-cluster-size')?.value) || 1;
    if (minCluster > 1) {
      const f = countClustersOfMinSize(nodes, links, minCluster);
      document.getElementById('stat-clusters').textContent = `${f.toLocaleString()} (≥${minCluster})`;
    }

    const { length: chainLen, ids: chainIds } = calculateLongestChain(nodes, links);
    document.getElementById('stat-longest-chain').textContent = chainLen.toLocaleString();
    window._longestChainIds = chainIds;
    refreshColors();
  }, 100);
}

// ── CLUSTER / CHAIN HIGHLIGHT ─────────────────────────────────────────────────
function highlightLargestCluster() {
  if (!window._largestClusterIds?.size) return;
  clearSelection(); clearLegendHighlight();
  _highlightedClusterIds = window._largestClusterIds;
  _highlightedChainIds   = null;
  refreshColors();
}
function highlightLongestChain() {
  if (!window._longestChainIds?.size) return;
  clearSelection(); clearLegendHighlight();
  _highlightedChainIds   = window._longestChainIds;
  _highlightedClusterIds = null;
  refreshColors();
}
function clearClusterChainHighlight() {
  _highlightedClusterIds = null;
  _highlightedChainIds   = null;
  document.querySelectorAll('.stat-clickable').forEach(b => b.classList.remove('active'));
  refreshColors();
}

// ── SELECTION ─────────────────────────────────────────────────────────────────
function selectNode(nodeId) {
  selectedNodeId = nodeId;
  neighborIds    = new Set();
  for (const l of currentLinks) {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    if (src === nodeId || tgt === nodeId) {
      const other = src === nodeId ? tgt : src;
      if (currentNodeMap.get(other)?.data?.type === 'anime') neighborIds.add(other);
    }
  }
  refreshColors();
}
function clearSelection()      { selectedNodeId = null; neighborIds = new Set(); refreshColors(); }
function clearLegendHighlight() {
  legendHighlightKey = null; legendHighlightVal = null;
  document.querySelectorAll('.legend-item').forEach(el => el.classList.remove('legend-active'));
  refreshColors();
}
function refreshColors() {
  if (!graphInstance) return;
  graphInstance.nodeColor(n => resolveNodeColor(n));
  graphInstance.linkColor(l => resolveLinkColor(l));
  graphInstance.linkWidth(l => resolveLinkWidth(l));
}

// ── COLOR RESOLVERS ───────────────────────────────────────────────────────────
function resolveNodeColor(n) {
  const base = n.color || '#e8a030';
  const activeSet = _highlightedClusterIds || _highlightedChainIds;
  if (activeSet) return activeSet.has(n.id) ? base : dimColor(base, 0.07);
  if (legendHighlightKey && !selectedNodeId)
    return nodeMatchesLegend(n, legendHighlightKey, legendHighlightVal) ? base : dimColor(base, 0.08);
  if (selectedNodeId !== null) {
    if (n.id === selectedNodeId || neighborIds.has(n.id)) return base;
    return dimColor(base, 0.08);
  }
  if (n.dimmed) return dimColor(base, 0.18);
  return base;
}

function nodeMatchesLegend(n, key, val) {
  const d = n.data; if (!d) return false;
  switch (key) {
    case 'anime_type':     return d.anime_type === val;
    case 'year_band': {
      const band = (window.YEAR_BANDS||[]).find(b=>b.label===val); if (!band) return false;
      const idx  = (window.YEAR_BANDS||[]).indexOf(band);
      const minY = idx>0 ? (window.YEAR_BANDS[idx-1].max+1) : 0;
      return d.year>=minY && d.year<=band.max;
    }
    case 'season':         return (d.season||'Unknown')===val;
    case 'release_status': return (d.release_status||'UNKNOWN')===val;
    case 'completion': {
      const st = getUserStatusForAnime ? getUserStatusForAnime(d.al_id) : null;
      return st===val;
    }
    case 'meta_type': return d.type===val;
    default: return false;
  }
}

function resolveLinkColor(l) {
  const src = typeof l.source === 'object' ? l.source.id : l.source;
  const tgt = typeof l.target === 'object' ? l.target.id : l.target;
  const base = (l.kind === 'related') ? 0.35 : 0.18;
  const activeSet = _highlightedClusterIds || _highlightedChainIds;
  if (activeSet) {
    if (!activeSet.has(src) && !activeSet.has(tgt)) return getLinkColor(l.kind, 0.02);
    return getLinkColor(l.kind, base);
  }
  if (selectedNodeId !== null) {
    if (src !== selectedNodeId && tgt !== selectedNodeId) return getLinkColor(l.kind, 0.02);
    return getLinkColor(l.kind, base);
  }
  if (legendHighlightKey) {
    const sn = currentNodeMap.get(src), tn = currentNodeMap.get(tgt);
    if (!nodeMatchesLegend(sn, legendHighlightKey, legendHighlightVal) &&
        !nodeMatchesLegend(tn, legendHighlightKey, legendHighlightVal))
      return getLinkColor(l.kind, 0.02);
  }
  return getLinkColor(l.kind, base);
}

function resolveLinkWidth(l) {
  const activeSet = _highlightedClusterIds || _highlightedChainIds;
  if (!selectedNodeId && !legendHighlightKey && !activeSet) return 0.5;
  const src = typeof l.source === 'object' ? l.source.id : l.source;
  const tgt = typeof l.target === 'object' ? l.target.id : l.target;
  if (activeSet) return (activeSet.has(src) && activeSet.has(tgt)) ? 2.5 : 0.1;
  if (selectedNodeId) return (src===selectedNodeId||tgt===selectedNodeId) ? 2.5 : 0.1;
  if (legendHighlightKey) {
    const sn = currentNodeMap.get(src), tn = currentNodeMap.get(tgt);
    return (nodeMatchesLegend(sn,legendHighlightKey,legendHighlightVal)||
            nodeMatchesLegend(tn,legendHighlightKey,legendHighlightVal)) ? 1.5 : 0.1;
  }
  return 0.5;
}

function getLinkColor(kind, alpha) {
  const a = alpha.toFixed(2);
  // Use CSS vars for configurable colors via window.LINK_COLORS override
  const LC = window.LINK_COLORS || {};
  switch (kind) {
    case 'related':         return `rgba(${LC.related  ||'255,255,255'},${a})`;
    case 'studio':          return `rgba(${LC.studio   ||'94,184,255'},${a})`;
    case 'genre':           return `rgba(${LC.genre    ||'200,130,255'},${a})`;
    case 'tag':             return `rgba(${LC.tag      ||'93,222,154'},${a})`;
    case 'anime_type':      return `rgba(${LC.anime_type||'240,160,48'},${a})`;
    case 'season_node':     return `rgba(${LC.season_node||'136,204,68'},${a})`;
    case 'year_node':       return `rgba(${LC.year_node||'102,170,255'},${a})`;
    case 'status_node':     return `rgba(${LC.status_node||'221,136,170'},${a})`;
    case 'completion_node': return `rgba(${LC.completion_node||'64,192,128'},${a})`;
    default:                return `rgba(255,255,255,${a})`;
  }
}

function dimColor(color, opacity) {
  let r=100,g=80,b=50;
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) { r=parseInt(hex[1].slice(0,2),16); g=parseInt(hex[1].slice(2,4),16); b=parseInt(hex[1].slice(4,6),16); }
  return `rgba(${r},${g},${b},${opacity})`;
}

// ── LINK LABEL ────────────────────────────────────────────────────────────────
function drawLinkLabel(link, ctx, globalScale) {
  if (link.kind !== 'related' || !link.relationLabel || globalScale < 2.5) return;
  const src = link.source, tgt = link.target;
  if (!src || !tgt || typeof src !== 'object') return;
  const midX = (src.x+tgt.x)/2, midY = (src.y+tgt.y)/2;
  const fontSize = Math.max(2, 7/globalScale);
  ctx.save();
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  const tw = ctx.measureText(link.relationLabel).width, pad = fontSize*0.35;
  ctx.fillStyle='rgba(13,10,7,0.82)';
  ctx.fillRect(midX-tw/2-pad, midY-fontSize/2-pad, tw+pad*2, fontSize+pad*2);
  ctx.fillStyle='rgba(255,255,255,0.8)';
  ctx.fillText(link.relationLabel, midX, midY);
  ctx.restore();
}

// ── TOOLTIP ───────────────────────────────────────────────────────────────────
function handleNodeHover(node) {
  const tt = document.getElementById('tooltip');
  if (!node) { tt.style.display='none'; return; }
  const n = node.data;
  if (!n) { tt.style.display='none'; return; }
  let html='';
  if (n.type==='anime') {
    const mins=totalMinutes(n), minsStr=mins>0?`${Math.round(mins)} min`:'Unknown';
    const studio=(n.studio_ids||[]).map(id=>window._nodeById?.get(id)?.name).filter(Boolean).join(', ')||'—';
    const genreNames=[
      ...(n.genre_ids||[]).map(id=>window._nodeById?.get(id)?.name),
      ...(n.tag_ids||[]).map(id=>{const nd=window._nodeById?.get(id);return(nd&&window.GENRE_TAGS?.has(nd.name))?nd.name:null;}),
    ].filter(Boolean).slice(0,6);
    const tagNames=(n.tag_ids||[]).map(id=>window._nodeById?.get(id)?.name).filter(name=>name&&!window.GENRE_TAGS?.has(name)).slice(0,5);
    const score=n.score?n.score.toFixed(2):'—';
    let statusBadge='';
    if(window.userListLoaded&&getUserStatusForAnime){
      const st=getUserStatusForAnime(n.al_id);
      if(st){const col=(window.COMPLETION_STATUS_COLORS||{})[st]||'#808080',lbl=(window.COMPLETION_STATUS_LABELS||{})[st]||st;
        statusBadge=`<div class="tt-badge" style="background:${col}22;color:${col};">${lbl}</div>`;}
    }
    let userScoreRow='';
    if(window.userListLoaded&&getUserScoreForAnime){
      const us=getUserScoreForAnime(n.al_id);
      if(us!=null){const delta=n.score?(us-n.score).toFixed(2):null,sign=delta!==null&&parseFloat(delta)>=0?'+':'',col=delta!==null?(parseFloat(delta)>=0?'#6c6':'#c66'):'';
        userScoreRow=`<div class="tt-row"><span class="tt-key">Your Score</span> ${us.toFixed(1)}${delta!==null?` <span style="color:${col}">(${sign}${delta})</span>`:''}</div>`;}
    }
    const rsLabel=(window.RELEASE_STATUS_LABELS||{})[n.release_status]||n.release_status||'?';
    html=`<div class="tt-title">${esc(n.title)}</div>
      ${n.title_en&&n.title_en!==n.title?`<div class="tt-subtitle">${esc(n.title_en)}</div>`:''}
      <div class="tt-badge" style="background:rgba(232,160,48,0.15);color:var(--gold2);">${n.anime_type}</div>
      ${statusBadge}
      <div class="tt-row"><span class="tt-key">Season</span> ${n.season||''} ${n.year||'?'}</div>
      <div class="tt-row"><span class="tt-key">Status</span> ${rsLabel}</div>
      <div class="tt-row"><span class="tt-key">Episodes</span> ${n.episodes||'?'}</div>
      <div class="tt-row"><span class="tt-key">Studio</span> ${esc(studio)}</div>
      <div class="tt-row"><span class="tt-key">Duration</span> ${minsStr}</div>
      <div class="tt-row"><span class="tt-key">Score</span> ${score}</div>
      ${userScoreRow}
      ${genreNames.length?`<div class="tt-tags"><b>Genres:</b> ${esc(genreNames.join(', '))}</div>`:''}
      ${tagNames.length?`<div class="tt-tags"><b>Tags:</b> ${esc(tagNames.join(', '))}</div>`:''}`;
  } else if (n._virtualMeta) {
    const typeLabel={anime_type:'Anime Type',season_node:'Season',year_node:'Year Band',status_node:'Airing Status',completion_node:'List Status'}[n.type]||n.type;
    html=`<div class="tt-title">${esc(n.name)}</div><div class="tt-badge" style="background:${n._color}22;color:${n._color};">${typeLabel}</div>`;
  } else if (n.type==='studio') {
    html=`<div class="tt-title">${esc(n.name)}</div><div class="tt-badge" style="background:rgba(94,184,255,0.15);color:#5eb8ff;">Studio</div>`;
  } else if (n.type==='genre') {
    const gc=window.CONFIGURABLE_COLORS?.genre||'#c882ff';
    html=`<div class="tt-title">${esc(n.name)}</div><div class="tt-badge" style="background:${gc}22;color:${gc};">Genre</div>`;
  } else if (n.type==='tag') {
    html=`<div class="tt-title">${esc(n.name)}</div><div class="tt-badge" style="background:rgba(93,222,154,0.15);color:#5dde9a;">Tag</div>`;
  }
  tt.innerHTML=html; tt.style.display='block';
}

function handleNodeClick(node, event) {
  if (!node) return;
  if (event) event._nodeClicked = true;
  if (selectedNodeId===node.id) { clearSelection(); return; }
  clearLegendHighlight(); clearClusterChainHighlight(); selectNode(node.id);
  if (node.data?.type==='anime' && node.data?.al_url) window.open(node.data.al_url,'_blank');
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
