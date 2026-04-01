/**
 * graph.js
 * --------
 * Initialises the force-graph instance and handles node hover/click,
 * zoom controls, and tooltip rendering.
 */

'use strict';

let graphInstance = null;
let showLinks = true;

// ── INIT ──────────────────────────────────────────────────────────────────────

function initGraph() {
  const wrap = document.getElementById('graph-canvas');

  graphInstance = ForceGraph()(wrap)
    .backgroundColor('#0d0a07')
    .nodeRelSize(6)
    .nodeColor(n => n.color || '#e8a030')
    .nodeLabel('')            // we use our own tooltip
    .linkColor(l => {
      switch (l.kind) {
        case 'related':   return 'rgba(212,163,68,0.25)';
        case 'studio':    return 'rgba(64,128,192,0.2)';
        case 'tag':       return 'rgba(64,160,96,0.2)';
        case 'character': return 'rgba(192,64,96,0.2)';
        case 'staff':     return 'rgba(144,96,192,0.2)';
        default:          return 'rgba(212,163,68,0.15)';
      }
    })
    .linkWidth(0.8)
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick);

  // Zoom controls
  document.getElementById('zoom-in').onclick = () => {
    graphInstance.zoom(graphInstance.zoom() * 1.3, 400);
  };
  document.getElementById('zoom-out').onclick = () => {
    graphInstance.zoom(graphInstance.zoom() * 0.7, 400);
  };
  document.getElementById('zoom-fit').onclick = () => graphInstance.zoomToFit(600);
  document.getElementById('toggle-links').onclick = () => {
    showLinks = !showLinks;
    graphInstance.linkVisibility(showLinks);
  };

  // Tooltip positioning
  document.getElementById('graph-canvas').addEventListener('mousemove', e => {
    const tt = document.getElementById('tooltip');
    if (tt.style.display === 'none') return;
    const x = e.clientX + 14;
    const y = e.clientY - 10;
    tt.style.left = Math.min(x, window.innerWidth - 280) + 'px';
    tt.style.top  = Math.min(y, window.innerHeight - 220) + 'px';
  });
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function renderGraph({ nodes, links, filteredAnime, visibleMeta }) {
  graphInstance.graphData({ nodes, links });

  const animeCount = filteredAnime.length;
  const metaCount  = visibleMeta.length;

  document.getElementById('stat-nodes').textContent    = animeCount.toLocaleString();
  document.getElementById('stat-meta').textContent     = metaCount.toLocaleString();
  document.getElementById('stat-edges').textContent    = links.length.toLocaleString();

  const clusters = calculateAnimeClusters(nodes, links);
  document.getElementById('stat-clusters').textContent = clusters.toLocaleString();

  setTimeout(() => graphInstance.zoomToFit(800, 50), 600);
}

// ── TOOLTIP ───────────────────────────────────────────────────────────────────

function handleNodeHover(node) {
  const tt = document.getElementById('tooltip');
  if (!node) { tt.style.display = 'none'; return; }

  const n = node.data;
  if (!n) { tt.style.display = 'none'; return; }

  let html = '';

  if (n.type === 'anime') {
    const mins   = totalMinutes(n);
    const minsStr = mins > 0 ? `${Math.round(mins)} min` : 'Unknown';
    const studio = (n.studio_ids || [])
      .map(id => window._nodeById?.get(id)?.name).filter(Boolean).join(', ') || '—';
    const tags = (n.tag_ids || [])
      .slice(0, 8).map(id => window._nodeById?.get(id)?.name).filter(Boolean).join(', ');
    const score  = n.score ? n.score.toFixed(2) : '—';
    const year   = n.year || '?';
    const season = n.season || '';

    html = `
      <div class="tt-title">${esc(n.title)}</div>
      ${n.title_en && n.title_en !== n.title
        ? `<div class="tt-subtitle">${esc(n.title_en)}</div>` : ''}
      <div class="tt-badge" style="background:rgba(212,163,68,0.15);color:var(--gold2);">${n.anime_type}</div>
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
      <div class="tt-badge" style="background:rgba(64,128,192,0.2);color:#80b0e0;">Studio</div>
    `;
  } else if (n.type === 'tag') {
    html = `
      <div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(64,160,96,0.2);color:#80c080;">Tag / Genre</div>
    `;
  } else if (n.type === 'character') {
    html = `
      <div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(192,64,96,0.2);color:#e080a0;">Character</div>
    `;
  } else if (n.type === 'staff') {
    html = `
      <div class="tt-title">${esc(n.name)}</div>
      <div class="tt-badge" style="background:rgba(144,96,192,0.2);color:#c0a0e0;">Staff</div>
    `;
  }

  tt.innerHTML = html;
  tt.style.display = 'block';
}

function handleNodeClick(node) {
  if (!node?.data) return;
  const n = node.data;
  if (n.type === 'anime' && n.al_url) {
    window.open(n.al_url, '_blank');
  }
}

// ── UTIL ──────────────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
