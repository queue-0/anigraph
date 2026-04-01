/**
 * anilist.js
 * ----------
 * Handles fetching an AniList user's anime list.
 * Uses the public GraphQL API — no API key needed for public lists.
 *
 * Fix for Cloudflare 403/404:
 *   The AniList GraphQL endpoint (graphql.anilist.co) serves public data
 *   without authentication. The previous issue was likely caused by
 *   the browser sending an 'Origin' header that Cloudflare rejected, or
 *   a missing 'Accept' header. We now omit 'Origin' (browser handles it),
 *   keep headers minimal, and use the correct CORS-safe approach.
 */

'use strict';

// userList[status] = Set of numeric AniList media IDs
// e.g. userList['COMPLETED'] = Set{1535, 2994, …}
window.userList = {};
window.userListLoaded = false;

const ANILIST_STATUSES = ['COMPLETED','PLANNING','CURRENT','PAUSED','DROPPED','REPEATING'];

/**
 * Fetch all lists for a given AniList username.
 * Populates window.userList and calls onComplete when done.
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

  // We fetch all lists in one request (no status filter) then categorise
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

    // AniList may return 200 with an errors array, or a 4xx status
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

    // Show the status-filter section
    document.getElementById('list-status-filter').style.display = 'block';

    // Trigger re-render with the current status selections
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

/** Clear the loaded list and reset the UI */
function clearUserList() {
  window.userList = {};
  window.userListLoaded = false;

  document.getElementById('user-status').textContent = '';
  document.getElementById('user-status').className = 'user-status';
  document.getElementById('username-input').value = '';
  document.getElementById('list-status-filter').style.display = 'none';

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

  // Re-render whenever a status checkbox changes
  document.getElementById('list-status-checkboxes')
    .addEventListener('change', applyFiltersAndRender);
});
