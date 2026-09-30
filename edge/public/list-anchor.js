// List viewport snapshots keyed by stable row identity (data-key), so a list rebuilt after Back
// shows the same rows at the same offset even when badges or fonts changed row heights above.

const STORE_KEY = "redstm.listPositions.v1";
const STORE_LIMIT = 40;

function scrollportTop(scroller) {
  return scroller.getBoundingClientRect().top + scroller.clientTop;
}

function rowsOf(scroller, selector) {
  return scroller.querySelectorAll(selector);
}

// Rows run top to bottom, so the first one reaching into the viewport is found by bisection:
// measuring every row above it forces layout of thousands of off-screen rows in a long list.
export function captureListAnchor(scroller, selector = "[data-key]") {
  if (!scroller) return null;
  const top = scrollportTop(scroller);
  const rows = rowsOf(scroller, selector);
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].getBoundingClientRect().bottom > top + 1) high = middle;
    else low = middle + 1;
  }
  // A hidden row measures zero and can end the search a little early; walk on from there.
  for (let index = Math.max(0, low - 1); index < rows.length; index += 1) {
    const row = rows[index];
    const rect = row.getBoundingClientRect();
    if (rect.height && rect.bottom > top + 1) {
      return { key: row.dataset.key ?? null, offset: rect.top - top, scrollTop: scroller.scrollTop };
    }
  }
  return { key: null, offset: 0, scrollTop: scroller.scrollTop };
}

// Returns true when the anchor row was found and aligned; otherwise falls back to the raw offset.
export function restoreListAnchor(scroller, snapshot, selector = "[data-key]") {
  if (!scroller || !snapshot) return false;
  const row = snapshot.key == null ? null
    : [...rowsOf(scroller, selector)].find((candidate) => candidate.dataset.key === String(snapshot.key));
  if (!row) {
    scroller.scrollTop = Math.max(0, Number(snapshot.scrollTop) || 0);
    return false;
  }
  const current = row.getBoundingClientRect().top - scrollportTop(scroller);
  scroller.scrollTop += current - (Number(snapshot.offset) || 0);
  return true;
}

function readStore() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => Array.isArray(item) && item.length === 2) : [];
  } catch {
    return [];
  }
}

export function saveListPosition(route, snapshot) {
  if (!route || !snapshot) return;
  const entries = readStore().filter(([key]) => key !== route);
  entries.push([route, snapshot]);
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(entries.slice(-STORE_LIMIT)));
  } catch {
    // Position memory is a convenience; reading continues without it.
  }
}

export function loadListPosition(route) {
  return readStore().find(([key]) => key === route)?.[1] ?? null;
}
