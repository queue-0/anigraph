/**
 * anilist.js
 * ----------
 * Handles fetching an AniList user's anime list.
 * Uses the public GraphQL API — no API key needed for public lists.
 * Fetches user scores alongside list status.
 */

'use strict';

// userList[status] = Set of numeric AniList media IDs
window.userList       = {};
window.userScores     = {};  // al_id → user's score (0–100 scale, normalized to 0–10)
window.userListLoaded = false;

const ANILIST_STATUSES = ['COMPLETED','PLANNING','CURRENT','PAUSED','DROPPED','REPEATING'];

// Status display labels & colors for "Completion Status" color mode
window.COMPLETION_STATUS_COLORS = {
  COMPLETED:  '#40c080',  // green
  CURRENT:    '#4080c0',  // blue
  PLANNING:   '#9060c0',  // purple
  PAUSED:     '#c0a040',  // amber
  DROPPED:    '#c04040',  // red
  REPEATING:  '#40c0c0',  // teal
  RELATED:    '#808080',  // grey — anime related to list entries but not explicitly listed
};
window.COMPLETION_STATUS_LABELS = {
  COMPLETED:  'Completed',
  CURRENT:    'Watching',
  PLANNING:   'Planning',
  PAUSED:     'On-Hold',
  DROPPED:    'Dropped',
  REPEATING:  'Rewatching',
  RELATED:    'Related',
};

/**
 * Fetch all lists for a given AniList username.
 * Populates window.userList, window.userScores, and calls applyFiltersAndRender.
 */
async function fetchUserList() {
  const username = document.getElementById('username-input').value.trim();
  if (!username) return;

  const btn    = document.getElementById('fetch-list-btn');
  const status = document.getElementById('user-status');

  btn.disabled = true;
  status.textContent = 'Connecting to AniList…';
  status.className   = 'user-status loading';

  // Reset
  window.userList   = {};
  window.userScores = {};
  window.userListLoaded = false;
  ANILIST_STATUSES.forEach(s => { window.userList[s] = new Set(); });
  window.userList['RELATED'] = new Set();

  const query = `
    query ($name: String) {
      MediaListCollection(userName: $name, type: ANIME) {
        lists {
          status
          entries {
            mediaId
            score(format: POINT_10_DECIMAL)
          }
        }
      }
    }
  `;

  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body: JSON.stringify({ query, variables: { name: username } }),
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const err = await res.json();
        if (err.errors) msg = err.errors[0].message;
      } catch(_) {}
      throw new Error(msg);
    }

    const data = await res.json();
    if (data.errors) throw new Error(data.errors[0].message);

    const lists = data?.data?.MediaListCollection?.lists || [];
    let total = 0;
    lists.forEach(list => {
      const s = list.status || 'COMPLETED';
      if (!window.userList[s]) window.userList[s] = new Set();
      list.entries.forEach(e => {
        window.userList[s].add(e.mediaId);
        // Store score if non-zero (0 means unscored)
        if (e.score && e.score > 0) {
          window.userScores[e.mediaId] = e.score;
        }
        total++;
      });
    });

    // Populate RELATED: anime that are graph-neighbors of list entries but not
    // explicitly on the list. This is computed in app.js after graph loads.
    window.userListLoaded = true;

    status.textContent = `✓ Loaded ${total} anime from ${username}`;
    status.className   = 'user-status success';

    // Show status filter + extra color-by options
    document.getElementById('list-status-filter').style.display = 'block';
    const completionRow = document.getElementById('colorby-completion-row');
    if (completionRow) completionRow.style.display = 'flex';
    const userScoreRow = document.getElementById('colorby-userscore-row');
    if (userScoreRow) userScoreRow.style.display = 'flex';
    const scoreDeltaRow = document.getElementById('colorby-scoredelta-row');
    if (scoreDeltaRow) scoreDeltaRow.style.display = 'flex';
    const nodeSizeUserScore = document.getElementById('nodeSizeBy-userscore-row');
    if (nodeSizeUserScore) nodeSizeUserScore.style.display = 'flex';

    // Enable user mode option
    const modeUserOpt = document.getElementById('mode-user-option');
    if (modeUserOpt) {
      modeUserOpt.disabled = false;
      modeUserOpt.textContent = `My List (${total})`;
    }

    // Compute related anime from graph edges
    computeRelatedAnime();

    applyFiltersAndRender();

  } catch (err) {
    console.error('AniList fetch error:', err);
    status.textContent = '✗ ' + (err.message || 'Unknown error');
    status.className   = 'user-status error';
  } finally {
    btn.disabled = false;
  }
}

/**
 * Walk the graph edges to find anime that are direct neighbors of list entries
 * but not themselves on the list. Mark them as RELATED.
 */
function computeRelatedAnime() {
  if (!window.rawGraph || !window.userListLoaded) return;

  // Build set of all explicitly listed al_ids
  const listedIds = new Set();
  ANILIST_STATUSES.forEach(s => {
    (window.userList[s] || new Set()).forEach(id => listedIds.add(id));
  });

  // Build map: al_id → node_id and node_id → al_id for anime nodes
  const alIdToNodeId = new Map();
  const nodeIdToAlId = new Map();
  window.rawGraph.nodes.forEach(n => {
    if (n.type === 'anime') {
      alIdToNodeId.set(n.al_id, n.node_id);
      nodeIdToAlId.set(n.node_id, n.al_id);
    }
  });

  // Build adjacency for anime↔anime edges only
  const animeAdj = new Map();
  window.rawGraph.edges.forEach(e => {
    if (e.k !== 'related') return;
    const sAlId = nodeIdToAlId.get(e.s);
    const tAlId = nodeIdToAlId.get(e.t);
    if (!sAlId || !tAlId) return;
    if (!animeAdj.has(sAlId)) animeAdj.set(sAlId, new Set());
    if (!animeAdj.has(tAlId)) animeAdj.set(tAlId, new Set());
    animeAdj.get(sAlId).add(tAlId);
    animeAdj.get(tAlId).add(sAlId);
  });

  window.userList['RELATED'] = new Set();
  listedIds.forEach(alId => {
    (animeAdj.get(alId) || new Set()).forEach(neighborId => {
      if (!listedIds.has(neighborId)) {
        window.userList['RELATED'].add(neighborId);
      }
    });
  });
}

/** Return a Set of all numeric IDs matching the currently-checked statuses */
function getActiveUserIds() {
  if (!window.userListLoaded) return null;
  const checked = [...document.querySelectorAll('#list-status-checkboxes input:checked')]
    .map(el => el.value);
  const combined = new Set();
  checked.forEach(s => {
    (window.userList[s] || new Set()).forEach(id => combined.add(id));
  });
  return combined;
}

/**
 * Given an al_id, return the user's list status for that anime, or null.
 */
function getUserStatusForAnime(al_id) {
  if (!window.userListLoaded) return null;
  for (const status of ANILIST_STATUSES) {
    if (window.userList[status]?.has(al_id)) return status;
  }
  if (window.userList['RELATED']?.has(al_id)) return 'RELATED';
  return null;
}

/**
 * Return the user's score for an anime (0–10 scale), or null if unscored.
 */
function getUserScoreForAnime(al_id) {
  if (!window.userListLoaded) return null;
  return window.userScores[al_id] ?? null;
}

/** Clear the loaded list and reset the UI */
function clearUserList() {
  window.userList   = {};
  window.userScores = {};
  window.userListLoaded = false;

  document.getElementById('user-status').textContent = '';
  document.getElementById('user-status').className   = 'user-status';
  document.getElementById('username-input').value    = '';
  document.getElementById('list-status-filter').style.display = 'none';

  // Hide extra color-by options and reset radio if one was selected
  ['colorby-completion-row','colorby-userscore-row','colorby-scoredelta-row'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const nodeSizeUserScore = document.getElementById('nodeSizeBy-userscore-row');
  if (nodeSizeUserScore) nodeSizeUserScore.style.display = 'none';

  const activeColorby = document.querySelector('input[name="colorby"]:checked')?.value;
  if (['completion','user_score','score_delta'].includes(activeColorby)) {
    document.querySelector('input[name="colorby"][value="node_type"]').checked = true;
  }
  const activeSize = document.querySelector('input[name="nodeSizeBy"]:checked')?.value;
  if (activeSize === 'user_score') {
    document.querySelector('input[name="nodeSizeBy"][value="default"]').checked = true;
  }

  // Reset mode selector
  const modeUserOpt = document.getElementById('mode-user-option');
  if (modeUserOpt) {
    modeUserOpt.disabled = true;
    modeUserOpt.textContent = 'My List (load username first)';
  }
  const modeSelect = document.getElementById('mode-select');
  if (modeSelect) modeSelect.value = 'all';

  applyFiltersAndRender();
}

// ── Wire up events after DOM ready ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('fetch-list-btn')
    .addEventListener('click', fetchUserList);
  document.getElementById('username-input')
    .addEventListener('keydown', e => { if (e.key === 'Enter') fetchUserList(); });

  document.getElementById('filter-by-list-btn')
    .addEventListener('click', applyFiltersAndRender);

  document.getElementById('clear-list-btn')
    .addEventListener('click', clearUserList);

  document.getElementById('list-status-checkboxes')
    .addEventListener('change', applyFiltersAndRender);
});
