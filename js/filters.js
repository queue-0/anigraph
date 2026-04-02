/**
 * filters.js
 * ----------
 * Reads filter state from the sidebar and produces filtered/highlighted
 * subsets of the pre-computed graph (nodes + edges).
 *
 * Key behaviours:
 *  - Meta nodes are only shown if connected to a filtered anime AND their type is visible.
 *  - Highlight mode: instead of hiding nodes, dims non-matching ones.
 *  - Tag edges are capped per node to limit lag.
 *  - Meta node types always use fixed, distinct colors.
 *  - Genre and Tag are separate meta node types.
 *  - No meta↔meta edges are ever created.
 *  - Duplicate edges are deduplicated.
 *  - Node size can be driven by edge count, score, or user score.
 *  - Anime nodes default to uniform size when not scaling by edges.
 */

'use strict';

// ── TAG / GENRE EDGE PERFORMANCE CONTROL ─────────────────────────────────────
const TAG_EDGE_MAX_PER_TAG     = 50;
const GENRE_EDGE_MAX_PER_GENRE = 80;

// ── FIXED META NODE COLORS ────────────────────────────────────────────────────
const META_NODE_COLORS = {
  studio:    '#5eb8ff',   // sky blue
  genre:     '#ffb347',   // orange
  tag:       '#5dde9a',   // mint green
  character: '#ff7eb3',   // pink
  staff:     '#c09cff',   // lavender
};

// ── ANIME TYPE COLORS ─────────────────────────────────────────────────────────
const ANIME_TYPE_COLORS = {
  TV:      '#f0a030',
  MOVIE:   '#e05050',
  OVA:     '#e080d0',
  ONA:     '#a0d060',
  SPECIAL: '#d06030',
  UNKNOWN: '#606060',
};

// ── SEASON COLORS ─────────────────────────────────────────────────────────────
const SEASON_COLORS = {
  SPRING: '#88cc44',
  SUMMER: '#ff9933',
  FALL:   '#cc5522',
  WINTER: '#66aaff',
};

// ── COUNTRY COLORS ────────────────────────────────────────────────────────────
const COUNTRY_COLORS = {
  JP: '#e8483c',  // Japan — red
  CN: '#f0b030',  // China — gold
  KR: '#4488cc',  // Korea — blue
  TW: '#44aa66',  // Taiwan — green
  US: '#9966cc',  // USA — purple
  FR: '#cc4488',  // France — pink
  '??': '#606060',
};
const COUNTRY_LABELS = {
  JP: 'Japan', CN: 'China', KR: 'Korea', TW: 'Taiwan',
  US: 'USA', FR: 'France', '??': 'Unknown',
};

// ── YEAR BANDS ────────────────────────────────────────────────────────────────
const YEAR_BANDS = [
  { max: 1969, label: '≤1969', hue: 0   },
  { max: 1979, label: '1970s', hue: 25  },
  { max: 1989, label: '1980s', hue: 50  },
  { max: 1999, label: '1990s', hue: 100 },
  { max: 2009, label: '2000s', hue: 160 },
  { max: 2014, label: '2010–14', hue: 200 },
  { max: 2019, label: '2015–19', hue: 240 },
  { max: 2024, label: '2020–24', hue: 270 },
  { max: 9999, label: '2025+',   hue: 300 },
];
function yearColor(year) {
  if (!year) return '#555555';
  const band = YEAR_BANDS.find(b => year <= b.max) || YEAR_BANDS[YEAR_BANDS.length - 1];
  return `hsl(${band.hue},70%,55%)`;
}
function yearBandLabel(year) {
  if (!year) return 'Unknown';
  return (YEAR_BANDS.find(b => year <= b.max) || YEAR_BANDS[YEAR_BANDS.length - 1]).label;
}

// ── GRADIENT HELPERS ──────────────────────────────────────────────────────────
/** Map a 0–1 value to a blue→green→yellow→red gradient */
function gradientColor(t) {
  // 0 = cold blue, 0.5 = green/yellow, 1 = hot red
  t = Math.max(0, Math.min(1, t));
  const hue = (1 - t) * 240;  // 240=blue → 0=red
  return `hsl(${hue.toFixed(0)},80%,55%)`;
}

function scoreColor(score) {
  if (score == null) return '#555555';
  return gradientColor((score - 0) / 10);
}

function durationColor(mins) {
  if (!mins || mins <= 0) return '#555555';
  // cap at 2000 minutes for colour range
  return gradientColor(Math.min(mins, 2000) / 2000);
}

function scoreDeltaColor(delta) {
  // delta range roughly -5 to +5; map to 0–1
  return gradientColor((delta + 5) / 10);
}

// ── FILTER STATE READER ───────────────────────────────────────────────────────
function getFilters() {
  const types = new Set(
    [...document.querySelectorAll('#type-checkboxes input:checked')].map(i => i.value)
  );
  const visibleNodeTypes = new Set(
    [...document.querySelectorAll('#node-type-visibility input:checked')].map(i => i.value)
  );
  const releaseStatuses = new Set(
    [...document.querySelectorAll('#release-status-checkboxes input:checked')].map(i => i.value)
  );
  const yearFrom  = parseInt(document.getElementById('year-from').value)   || 0;
  const yearTo    = parseInt(document.getElementById('year-to').value)     || 9999;
  const epMin     = parseInt(document.getElementById('ep-min').value)      || 0;
  const epMax     = parseInt(document.getElementById('ep-max').value)      || 999999;
  const lenMin    = parseFloat(document.getElementById('len-min').value)   || 0;
  const lenMax    = parseFloat(document.getElementById('len-max').value)   || 999999;
  const scoreMin  = parseFloat(document.getElementById('score-min').value) ?? 0;
  const scoreMax  = parseFloat(document.getElementById('score-max').value) ?? 10;

  const selTags    = [...document.getElementById('tag-select').selectedOptions].map(o => o.value);
  const selGenres  = [...document.getElementById('genre-select').selectedOptions].map(o => o.value);
  const selStudios = [...document.getElementById('studio-select').selectedOptions].map(o => o.value);
  const selChars   = [...document.getElementById('character-select').selectedOptions].map(o => o.value);
  const selStaff   = [...document.getElementById('staff-select').selectedOptions].map(o => o.value);

  // Country filter
  const selCountries = new Set(
    [...document.querySelectorAll('#country-checkboxes input:checked')].map(i => i.value)
  );

  const search    = document.getElementById('search-input').value.trim().toLowerCase();
  const colorBy   = document.querySelector('input[name="colorby"]:checked')?.value || 'node_type';
  const nodeSizeBy = document.querySelector('input[name="nodeSizeBy"]:checked')?.value || 'default';

  const minClusterSize = parseInt(document.getElementById('min-cluster-size')?.value) || 1;

  // Mode
  const mode = document.getElementById('mode-select')?.value || 'all';

  // Highlight flags
  const hlAnimetype    = document.getElementById('highlight-animetype')?.checked    || false;
  const hlReleaseStatus = document.getElementById('highlight-releasestatus')?.checked || false;
  const hlYear         = document.getElementById('highlight-year')?.checked         || false;
  const hlEpisodes     = document.getElementById('highlight-episodes')?.checked     || false;
  const hlLength       = document.getElementById('highlight-length')?.checked       || false;
  const hlScore        = document.getElementById('highlight-score')?.checked        || false;
  const hlGenres       = document.getElementById('highlight-genres')?.checked       || false;
  const hlTags         = document.getElementById('highlight-tags')?.checked         || false;
  const hlCountry      = document.getElementById('highlight-country')?.checked      || false;
  const hlStudios      = document.getElementById('highlight-studios')?.checked      || false;
  const hlChars        = document.getElementById('highlight-characters')?.checked   || false;
  const hlStaff        = document.getElementById('highlight-staff')?.checked        || false;

  return {
    types, visibleNodeTypes, releaseStatuses,
    yearFrom, yearTo, epMin, epMax, lenMin, lenMax, scoreMin, scoreMax,
    selTags, selGenres, selStudios, selChars, selStaff, selCountries,
    search, colorBy, nodeSizeBy, minClusterSize, mode,
    highlights: {
      animetype: hlAnimetype,
      releasestatus: hlReleaseStatus,
      year: hlYear,
      episodes: hlEpisodes,
      length: hlLength,
      score: hlScore,
      genres: hlGenres,
      tags: hlTags,
      country: hlCountry,
      studios: hlStudios,
      characters: hlChars,
      staff: hlStaff,
    },
  };
}

// ── COLOR RESOLVER ────────────────────────────────────────────────────────────
function getNodeColor(node, colorBy, nodeById) {
  if (node.type !== 'anime') {
    return META_NODE_COLORS[node.type] || '#808080';
  }

  switch (colorBy) {
    case 'node_type':  return '#e8a030';
    case 'type':       return ANIME_TYPE_COLORS[node.anime_type] || '#606060';
    case 'year':       return yearColor(node.year);
    case 'season':     return SEASON_COLORS[node.season] || '#666666';
    case 'score':      return scoreColor(node.score);
    case 'duration': {
      const mins = totalMinutes(node);
      return durationColor(mins);
    }
    case 'country':    return COUNTRY_COLORS[node.country || '??'] || '#606060';
    case 'completion': {
      const status = getUserStatusForAnime ? getUserStatusForAnime(node.al_id) : null;
      if (!status) return '#555555';
      return (window.COMPLETION_STATUS_COLORS || {})[status] || '#808080';
    }
    case 'user_score': {
      const us = getUserScoreForAnime ? getUserScoreForAnime(node.al_id) : null;
      if (us == null) return '#555555';
      return scoreColor(us);
    }
    case 'score_delta': {
      const us = getUserScoreForAnime ? getUserScoreForAnime(node.al_id) : null;
      if (us == null || node.score == null) return '#555555';
      return scoreDeltaColor(us - node.score);
    }
    default: return '#e8a030';
  }
}

// ── NODE SIZE ─────────────────────────────────────────────────────────────────
// edgeCounts: Map<node_id, count> — passed in from buildGraphData
function getNodeSize(node, nodeSizeBy, edgeCounts) {
  if (node.type !== 'anime') {
    // Meta nodes are consistently larger than default anime size
    if (node.type === 'studio')    return 3.5;
    if (node.type === 'genre')     return 3.2;
    if (node.type === 'tag')       return 2.8;
    if (node.type === 'character') return 2.2;
    if (node.type === 'staff')     return 2.4;
    return 2.5;
  }

  if (nodeSizeBy === 'default') return 1.5;  // uniform for all anime

  if (nodeSizeBy === 'edges') {
    const cnt = edgeCounts?.get(node.node_id) || 0;
    return Math.max(0.8, Math.log(cnt + 1) * 1.2);
  }
  if (nodeSizeBy === 'score') {
    if (!node.score) return 0.8;
    return Math.max(0.5, (node.score / 10) * 3);
  }
  if (nodeSizeBy === 'user_score') {
    const us = getUserScoreForAnime ? getUserScoreForAnime(node.al_id) : null;
    if (us == null) return 0.8;
    return Math.max(0.5, (us / 10) * 3);
  }
  return 1.5;
}

// ── ANIME PASSES FILTER ───────────────────────────────────────────────────────
/**
 * Returns: 'pass' | 'highlight' | 'fail'
 * 'highlight' = passes but only because of highlight mode (dim it but include it)
 */
function animeFilterResult(a, filters, nodeById) {
  const hl = filters.highlights;
  let shouldHighlight = false;

  // Helper: test a condition, respect highlight flag
  function check(passes, isHighlight) {
    if (!passes) {
      if (isHighlight) { shouldHighlight = true; return true; /* include, but flag */ }
      return false;
    }
    return true;
  }

  // Anime type
  if (!check(filters.types.has(a.anime_type), hl.animetype)) return 'fail';

  // Release status
  const rs = a.release_status || 'UNKNOWN';
  if (!check(filters.releaseStatuses.has(rs) || filters.releaseStatuses.has('UNKNOWN'), hl.releasestatus)) return 'fail';

  // Year
  if (a.year) {
    if (!check(a.year >= filters.yearFrom && a.year <= filters.yearTo, hl.year)) return 'fail';
  }

  // Episodes
  const eps = a.episodes || 0;
  if (!check(eps >= filters.epMin && eps <= filters.epMax, hl.episodes)) return 'fail';

  // Length
  const mins = totalMinutes(a);
  if (mins > 0) {
    if (!check(mins >= filters.lenMin && mins <= filters.lenMax, hl.length)) return 'fail';
  }

  // Score
  if (a.score != null) {
    if (!check(a.score >= filters.scoreMin && a.score <= filters.scoreMax, hl.score)) return 'fail';
  }

  // Country
  const country = a.country || '??';
  if (filters.selCountries.size > 0) {
    if (!check(filters.selCountries.has(country), hl.country)) return 'fail';
  }

  // Genre filter
  if (filters.selGenres.length > 0) {
    const genreNames = (a.genre_ids || []).map(id => nodeById.get(id)?.name).filter(Boolean);
    if (!check(filters.selGenres.some(g => genreNames.includes(g)), hl.genres)) return 'fail';
  }

  // Tag filter
  if (filters.selTags.length > 0) {
    const tagNames = (a.tag_ids || []).map(id => nodeById.get(id)?.name).filter(Boolean);
    if (!check(filters.selTags.some(t => tagNames.includes(t)), hl.tags)) return 'fail';
  }

  // Studio filter
  if (filters.selStudios.length > 0) {
    const studioNames = (a.studio_ids || []).map(id => nodeById.get(id)?.name).filter(Boolean);
    if (!check(filters.selStudios.some(s => studioNames.includes(s)), hl.studios)) return 'fail';
  }

  // Character / staff filters
  // (These require FETCH_ANILIST data — silently skip if no char_ids)
  // No highlight flag needed since these are unlikely to be huge sets

  // Text search
  if (filters.search) {
    const title   = (a.title    || '').toLowerCase();
    const titleEn = (a.title_en || '').toLowerCase();
    if (!title.includes(filters.search) && !titleEn.includes(filters.search)) return 'fail';
  }

  return shouldHighlight ? 'highlight' : 'pass';
}

// ── FILTER + BUILD GRAPH DATA ─────────────────────────────────────────────────
function buildGraphData(rawGraph, filters, nodeById) {
  const activeUserIds = getActiveUserIds ? getActiveUserIds() : null;
  const modeIsUser = filters.mode === 'user' && activeUserIds !== null;

  // ── 1. Filter anime nodes ─────────────────────────────────────────────────
  const animeNodes = rawGraph.nodes.filter(n => n.type === 'anime');

  const filteredAnime = [];      // fully passes all filters
  const highlightedAnime = [];   // dim these (highlight mode mismatch)

  // First pass: user list / mode filter
  for (const a of animeNodes) {
    if (modeIsUser && !activeUserIds.has(a.al_id)) continue;
    if (!modeIsUser && activeUserIds !== null && !activeUserIds.has(a.al_id)) continue;

    const result = animeFilterResult(a, filters, nodeById);
    if (result === 'fail') continue;
    if (result === 'highlight') highlightedAnime.push(a);
    else filteredAnime.push(a);
  }

  // All visible anime (for building edges/meta)
  const allVisibleAnime = [...filteredAnime, ...highlightedAnime];
  const filteredAnimeIds   = new Set(filteredAnime.map(n => n.node_id));
  const highlightedAnimeIds = new Set(highlightedAnime.map(n => n.node_id));
  const allVisibleAnimeIds  = new Set(allVisibleAnime.map(n => n.node_id));

  // ── 2. Cluster size filter (post-pass on filteredAnime only) ──────────────
  let clusterFilteredIds = null;
  if (filters.minClusterSize > 1) {
    const clusterMap = buildAnimeClustersMap(allVisibleAnime, rawGraph.edges);
    clusterFilteredIds = new Set();
    for (const [nodeId, clusterNodes] of clusterMap) {
      if (clusterNodes.size >= filters.minClusterSize) {
        clusterFilteredIds.add(nodeId);
      }
    }
  }

  const finalAnime    = clusterFilteredIds
    ? filteredAnime.filter(n => clusterFilteredIds.has(n.node_id))
    : filteredAnime;
  const finalHighlighted = clusterFilteredIds
    ? highlightedAnime.filter(n => clusterFilteredIds.has(n.node_id))
    : highlightedAnime;
  const finalAllAnime = [...finalAnime, ...finalHighlighted];
  const finalAnimeIds = new Set(finalAllAnime.map(n => n.node_id));

  // ── 3. Determine which meta IDs are reachable ─────────────────────────────
  const explicitStudios = new Set(filters.selStudios);
  const explicitTags    = new Set(filters.selTags);
  const explicitGenres  = new Set(filters.selGenres);
  const explicitChars   = new Set(filters.selChars);
  const explicitStaff   = new Set(filters.selStaff);

  const tagEdgeCount   = new Map();
  const genreEdgeCount = new Map();
  const visibleMetaIds = new Set();

  // Build anime→meta adjacency
  for (const e of rawGraph.edges) {
    const sIsAnime = finalAnimeIds.has(e.s);
    const tIsAnime = finalAnimeIds.has(e.t);

    // Only anime↔meta, never meta↔meta
    if (sIsAnime === tIsAnime) continue;  // both anime (handled below) or both meta — skip meta↔meta

    const animeId = sIsAnime ? e.s : e.t;
    const metaId  = sIsAnime ? e.t : e.s;
    const metaNode = nodeById.get(metaId);
    if (!metaNode || metaNode.type === 'anime') continue;
    if (!filters.visibleNodeTypes.has(metaNode.type)) continue;

    // Apply explicit filters per meta type
    if (metaNode.type === 'studio'    && explicitStudios.size > 0 && !explicitStudios.has(metaNode.name)) continue;
    if (metaNode.type === 'tag'       && explicitTags.size    > 0 && !explicitTags.has(metaNode.name))    continue;
    if (metaNode.type === 'genre'     && explicitGenres.size  > 0 && !explicitGenres.has(metaNode.name))  continue;
    if (metaNode.type === 'character' && explicitChars.size   > 0 && !explicitChars.has(metaNode.name))   continue;
    if (metaNode.type === 'staff'     && explicitStaff.size   > 0 && !explicitStaff.has(metaNode.name))   continue;

    // Auto-hide meta nodes whose type matches the current color mode
    // (per requirement: if a color type is selected, hide those meta nodes)
    if (filters.colorBy === 'type'    && metaNode.type === 'tag')    continue;
    if (filters.colorBy === 'country' && metaNode.type === 'studio') continue;

    visibleMetaIds.add(metaId);
  }

  const visibleMeta = rawGraph.nodes.filter(n => visibleMetaIds.has(n.node_id));
  const allVisibleIds = new Set([...finalAnimeIds, ...visibleMetaIds]);

  // ── 4. Build edge set (deduplicated, no meta↔meta) ────────────────────────
  const visibleEdgeKinds = new Set(['related']);
  if (filters.visibleNodeTypes.has('studio'))    visibleEdgeKinds.add('studio');
  if (filters.visibleNodeTypes.has('genre'))     visibleEdgeKinds.add('genre');
  if (filters.visibleNodeTypes.has('tag'))       visibleEdgeKinds.add('tag');
  if (filters.visibleNodeTypes.has('character')) visibleEdgeKinds.add('character');
  if (filters.visibleNodeTypes.has('staff'))     visibleEdgeKinds.add('staff');

  const edgeDedup   = new Set();
  const filteredEdges = [];

  for (const e of rawGraph.edges) {
    if (!allVisibleIds.has(e.s) || !allVisibleIds.has(e.t)) continue;
    if (!visibleEdgeKinds.has(e.k)) continue;

    // No meta↔meta edges
    const sNode = nodeById.get(e.s);
    const tNode = nodeById.get(e.t);
    if (!sNode || !tNode) continue;
    if (sNode.type !== 'anime' && tNode.type !== 'anime') continue;

    // Dedup
    const key = `${Math.min(e.s, e.t)}_${Math.max(e.s, e.t)}_${e.k}`;
    if (edgeDedup.has(key)) continue;
    edgeDedup.add(key);

    // Rate-limit tag/genre edges
    if (e.k === 'tag') {
      const tagId = sNode.type !== 'anime' ? e.s : e.t;
      const cnt = tagEdgeCount.get(tagId) || 0;
      if (cnt >= TAG_EDGE_MAX_PER_TAG) continue;
      tagEdgeCount.set(tagId, cnt + 1);
    }
    if (e.k === 'genre') {
      const genreId = sNode.type !== 'anime' ? e.s : e.t;
      const cnt = genreEdgeCount.get(genreId) || 0;
      if (cnt >= GENRE_EDGE_MAX_PER_GENRE) continue;
      genreEdgeCount.set(genreId, cnt + 1);
    }

    filteredEdges.push(e);
  }

  // ── 5. Build edge count map for node sizing ───────────────────────────────
  const edgeCounts = new Map();
  filteredEdges.forEach(e => {
    edgeCounts.set(e.s, (edgeCounts.get(e.s) || 0) + 1);
    edgeCounts.set(e.t, (edgeCounts.get(e.t) || 0) + 1);
  });

  // ── 6. Assign colors and sizes ────────────────────────────────────────────
  const dimmedIds = highlightedAnimeIds;  // these are "highlight mode mismatch"

  const allNodes = [...finalAnime, ...finalHighlighted, ...visibleMeta];
  allNodes.forEach(n => {
    n._color   = getNodeColor(n, filters.colorBy, nodeById);
    n._dimmed  = dimmedIds.has(n.node_id);
    n._size    = getNodeSize(n, filters.nodeSizeBy, edgeCounts);
  });

  // ── 7. Build force-graph arrays ───────────────────────────────────────────
  const nodes = allNodes.map(n => ({
    id:     n.node_id,
    label:  n.title || n.title_en || n.name || '?',
    color:  n._color,
    dimmed: n._dimmed,
    val:    n._size,
    data:   n,
  }));

  const links = filteredEdges.map(e => ({
    source:        e.s,
    target:        e.t,
    kind:          e.k,
    relationLabel: e.rel || null,
  }));

  return { nodes, links, filteredAnime: finalAnime, highlightedAnime: finalHighlighted, visibleMeta };
}

// ── CLUSTER HELPERS ───────────────────────────────────────────────────────────

/** Returns Map<nodeId, Set<nodeId>> where each Set is the cluster the node belongs to */
function buildAnimeClustersMap(animeNodes, edges) {
  const animeIds = new Set(animeNodes.map(n => n.node_id));
  const parent   = new Map();
  animeIds.forEach(id => parent.set(id, id));

  function find(x) {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  edges.forEach(e => {
    if (e.k !== 'related') return;
    if (animeIds.has(e.s) && animeIds.has(e.t)) union(e.s, e.t);
  });

  const clusters = new Map();  // root → Set of nodeIds
  animeIds.forEach(id => {
    const root = find(id);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root).add(id);
  });

  // Return nodeId → cluster Set
  const nodeToCluster = new Map();
  for (const [, clusterSet] of clusters) {
    for (const id of clusterSet) {
      nodeToCluster.set(id, clusterSet);
    }
  }
  return nodeToCluster;
}

function calculateAnimeClusters(nodes, links) {
  const animeNodeIds = new Set(nodes.filter(n => n.data?.type === 'anime').map(n => n.id));
  if (animeNodeIds.size === 0) return { count: 0, largest: 0 };

  const adj = new Map();
  animeNodeIds.forEach(id => adj.set(id, []));
  links.forEach(l => {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    if (animeNodeIds.has(src) && animeNodeIds.has(tgt)) {
      adj.get(src).push(tgt);
      adj.get(tgt).push(src);
    }
  });

  const visited = new Set();
  let count = 0, largest = 0;
  animeNodeIds.forEach(id => {
    if (!visited.has(id)) {
      count++;
      let size = 0;
      const stack = [id];
      visited.add(id);
      while (stack.length) {
        const cur = stack.pop();
        size++;
        (adj.get(cur) || []).forEach(nb => {
          if (!visited.has(nb)) { visited.add(nb); stack.push(nb); }
        });
      }
      if (size > largest) largest = size;
    }
  });
  return { count, largest };
}

/** BFS to find the longest shortest path in the anime subgraph */
function calculateLongestChain(nodes, links) {
  const animeNodeIds = new Set(nodes.filter(n => n.data?.type === 'anime').map(n => n.id));
  if (animeNodeIds.size === 0) return 0;

  const adj = new Map();
  animeNodeIds.forEach(id => adj.set(id, []));
  links.forEach(l => {
    if (l.kind !== 'related') return;
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    if (animeNodeIds.has(src) && animeNodeIds.has(tgt)) {
      adj.get(src).push(tgt);
      adj.get(tgt).push(src);
    }
  });

  // For performance, sample up to 200 source nodes
  const ids = [...animeNodeIds];
  const sample = ids.length > 200
    ? ids.filter((_, i) => i % Math.ceil(ids.length / 200) === 0)
    : ids;

  let longest = 0;
  for (const start of sample) {
    // BFS
    const dist = new Map([[start, 0]]);
    const queue = [start];
    let maxDist = 0;
    while (queue.length) {
      const cur = queue.shift();
      const d = dist.get(cur);
      for (const nb of (adj.get(cur) || [])) {
        if (!dist.has(nb)) {
          dist.set(nb, d + 1);
          if (d + 1 > maxDist) maxDist = d + 1;
          queue.push(nb);
        }
      }
    }
    if (maxDist > longest) longest = maxDist;
  }
  return longest;
}

// ── LEGEND BUILDER ────────────────────────────────────────────────────────────
function buildLegend(filteredAnime, colorBy, visibleNodeTypes, visibleMetaForLegend) {
  const container = document.getElementById('legend-items');
  container.innerHTML = '';

  function addItem(color, label, legendKey, legendVal) {
    const div     = document.createElement('div');
    div.className = 'legend-item';
    if (legendKey) {
      div.dataset.legendKey = legendKey;
      div.dataset.legendVal = legendVal;
      div.style.cursor = 'pointer';
      div.title = 'Click to highlight';
    }
    div.innerHTML = `
      <div class="legend-dot" style="background:${color}"></div>
      <span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</span>`;
    container.appendChild(div);
  }

  const totalAnime = filteredAnime.length;

  if (colorBy === 'node_type') {
    addItem('#e8a030', `Anime (${totalAnime.toLocaleString()})`, 'type', 'anime');
  } else if (colorBy === 'type') {
    const counts = {};
    filteredAnime.forEach(a => { counts[a.anime_type] = (counts[a.anime_type] || 0) + 1; });
    Object.entries(ANIME_TYPE_COLORS).forEach(([type, col]) => {
      if (counts[type]) addItem(col, `${type} (${counts[type].toLocaleString()})`, 'anime_type', type);
    });
  } else if (colorBy === 'year') {
    const bandCounts = {};
    filteredAnime.forEach(a => {
      const lbl = yearBandLabel(a.year);
      bandCounts[lbl] = (bandCounts[lbl] || 0) + 1;
    });
    YEAR_BANDS.forEach(b => {
      if (bandCounts[b.label]) {
        addItem(`hsl(${b.hue},70%,55%)`, `${b.label} (${bandCounts[b.label].toLocaleString()})`, 'year_band', b.label);
      }
    });
  } else if (colorBy === 'season') {
    const counts = {};
    filteredAnime.forEach(a => {
      const k = a.season || 'Unknown';
      counts[k] = (counts[k] || 0) + 1;
    });
    Object.entries(SEASON_COLORS).forEach(([s, col]) => {
      if (counts[s]) addItem(col, `${s} (${counts[s].toLocaleString()})`, 'season', s);
    });
    if (counts['Unknown']) addItem('#666666', `Unknown (${counts['Unknown'].toLocaleString()})`, 'season', 'Unknown');
  } else if (colorBy === 'country') {
    const counts = {};
    filteredAnime.forEach(a => { const c = a.country || '??'; counts[c] = (counts[c] || 0) + 1; });
    Object.entries(COUNTRY_COLORS).forEach(([code, col]) => {
      if (counts[code]) addItem(col, `${COUNTRY_LABELS[code] || code} (${counts[code].toLocaleString()})`, 'country', code);
    });
  } else if (colorBy === 'score') {
    addItem(gradientColor(0), 'Low Score');
    addItem(gradientColor(0.5), 'Mid Score');
    addItem(gradientColor(1), 'High Score');
  } else if (colorBy === 'duration') {
    addItem(gradientColor(0), 'Short');
    addItem(gradientColor(0.5), 'Medium');
    addItem(gradientColor(1), 'Long');
  } else if (colorBy === 'completion') {
    const colors  = window.COMPLETION_STATUS_COLORS || {};
    const labels  = window.COMPLETION_STATUS_LABELS || {};
    const counts  = {};
    let notInList = 0;
    filteredAnime.forEach(a => {
      const st = getUserStatusForAnime ? getUserStatusForAnime(a.al_id) : null;
      if (st) counts[st] = (counts[st] || 0) + 1;
      else notInList++;
    });
    Object.entries(colors).forEach(([st, col]) => {
      if (counts[st]) addItem(col, `${labels[st] || st} (${counts[st].toLocaleString()})`, 'completion', st);
    });
    if (notInList > 0) addItem('#555555', `Not in list (${notInList.toLocaleString()})`);
  } else if (colorBy === 'user_score' || colorBy === 'score_delta') {
    addItem(gradientColor(0), colorBy === 'score_delta' ? 'Much lower than global' : 'Low');
    addItem(gradientColor(0.5), colorBy === 'score_delta' ? 'Similar to global' : 'Mid');
    addItem(gradientColor(1), colorBy === 'score_delta' ? 'Much higher than global' : 'High');
  }

  // Separator
  const sep = document.createElement('div');
  sep.style.cssText = 'border-top:1px solid rgba(255,255,255,0.08);margin:6px 0;';
  container.appendChild(sep);

  // Meta node types
  const metaTypes = [
    ['studio',    'Studios'],
    ['genre',     'Genres'],
    ['tag',       'Tags'],
    ['character', 'Characters'],
    ['staff',     'Staff'],
  ];
  const metaCounts = {};
  if (visibleMetaForLegend) {
    visibleMetaForLegend.forEach(n => { metaCounts[n.type] = (metaCounts[n.type] || 0) + 1; });
  }
  metaTypes.forEach(([type, label]) => {
    if (visibleNodeTypes && visibleNodeTypes.has(type)) {
      const cnt = metaCounts[type] || 0;
      addItem(META_NODE_COLORS[type], cnt > 0 ? `${label} (${cnt.toLocaleString()})` : label, 'meta_type', type);
    }
  });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function totalMinutes(anime) {
  if (!anime.duration) return 0;
  const eps = anime.episodes || 1;
  return (eps * anime.duration) / 60;
}

// Export for use in other modules
window.META_NODE_COLORS   = META_NODE_COLORS;
window.ANIME_TYPE_COLORS  = ANIME_TYPE_COLORS;
window.SEASON_COLORS      = SEASON_COLORS;
window.COUNTRY_COLORS     = COUNTRY_COLORS;
window.COUNTRY_LABELS     = COUNTRY_LABELS;
window.YEAR_BANDS         = YEAR_BANDS;
window.gradientColor      = gradientColor;
window.totalMinutes       = totalMinutes;
