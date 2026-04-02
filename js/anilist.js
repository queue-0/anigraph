/**
 * anilist.js
 * ----------
 * Handles fetching an AniList user's anime list.
 * Uses the public GraphQL API — no API key needed for public lists.
 */

'use strict';

// userList[status] = Set of numeric AniList media IDs
window.userList       = {};
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
};
window.COMPLETION_STATUS_LABELS = {
  COMPLETED:  'Completed',
  CURRENT:    'Watching',
  PLANNING:   'Planning',
  PAUSED:     'On-Hold',
  DROPPED:    'Dropped',
  REPEATING:  'Rewatching',
};

/**
 * Fetch all lists for a given AniList username.
 * Populates window.userList and calls applyFiltersAndRender when done.
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
  window.userList = {};
  window.userListLoaded = false;
  ANILIST_STATUSES.forEach(s => { window.userList[s] = new Set(); });

  const query = `
    query ($name: String) {
      MediaListCollection(userName: $name, type: ANIME) {
        lists {
          status
          entries {
            mediaId
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
        total++;
      });
    });

    window.userListLoaded = true;

    status.textContent = `✓ Loaded ${total} anime from ${username}`;
    status.className   = 'user-status success';

    // Show status filter + completion color-by option
    document.getElementById('list-status-filter').style.display = 'block';
    const completionRow = document.getElementById('colorby-completion-row');
    if (completionRow) completionRow.style.display = 'flex';

    applyFiltersAndRender();

  } catch (err) {
    console.error('AniList fetch error:', err);
    status.textContent = '✗ ' + (err.message || 'Unknown error');
    status.className   = 'user-status error';
  } finally {
    btn.disabled = false;
  }
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
 * Used for "Completion Status" color mode.
 */
function getUserStatusForAnime(al_id) {
  if (!window.userListLoaded) return null;
  for (const status of ANILIST_STATUSES) {
    if (window.userList[status]?.has(al_id)) return status;
  }
  return null;
}

/** Clear the loaded list and reset the UI */
function clearUserList() {
  window.userList = {};
  window.userListLoaded = false;

  document.getElementById('user-status').textContent = '';
  document.getElementById('user-status').className   = 'user-status';
  document.getElementById('username-input').value    = '';
  document.getElementById('list-status-filter').style.display = 'none';

  // Hide completion color-by option and reset radio if it was selected
  const completionRow = document.getElementById('colorby-completion-row');
  if (completionRow) completionRow.style.display = 'none';
  const completionRadio = document.querySelector('input[name="colorby"][value="completion"]');
  if (completionRadio?.checked) {
    document.querySelector('input[name="colorby"][value="node_type"]').checked = true;
  }

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
