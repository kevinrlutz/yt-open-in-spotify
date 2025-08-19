// content.js
const ext = typeof browser !== 'undefined' ? browser : chrome;

const BUTTON_ID = 'open-in-spotify-btn-yts';
let lastUrl = location.href;

// Common junk to strip from titles
const COMMON_TAGS = [
  'official video', 'official music video', 'music video', 'official audio', 'audio',
  'lyrics', 'lyric video', 'visualizer', 'mv', 'pv', 'hd', '4k', 'remastered',
  'prod.', 'prod', 'prod by', 'live performance', 'live', 'cover', 'teaser'
];

function stripEmojis(s) {
  // remove most emoji/pictographs/symbols
  return s.replace(/[\p{Extended_Pictographic}\u200D]/gu, '');
}

function removeBracketedJunk(s) {
  // remove (...) and [...] chunks that contain common tags or year-only
  return s.replace(/[\(\[]([^\)\]]+)[\)\]]/g, (m, inner) => {
    const low = inner.toLowerCase();
    const isJunk = COMMON_TAGS.some(tag => low.includes(tag)) || /^\s*\d{4}\s*$/.test(inner);
    return isJunk ? '' : ` ${inner} `;
  }).replace(/\s{2,}/g, ' ').trim();
}

function sanitizeTitle(raw) {
  if (!raw) return '';
  let t = raw;

  t = stripEmojis(t);
  t = t.replace(/["“”]+/g, '');
  t = removeBracketedJunk(t);

  // Remove "feat." sections outside brackets
  t = t.replace(/\s+(feat\.?|ft\.?)\s+.+$/i, '');

  // Remove trailing " - Topic" or similar
  t = t.replace(/\s+-\s+topic$/i, '');

  return t.trim();
}

function extractTrackAndArtist(title, channelName) {
  const t = sanitizeTitle(title);
  if (!t) return { track: null, artist: null, rawQuery: null };

  // Pattern: Artist - Track
  const dash = t.split(/\s+-\s+/);
  if (dash.length === 2) {
    const [left, right] = dash;
    if (left && right) {
      return { track: right.trim(), artist: left.trim(), rawQuery: `${right.trim()} ${left.trim()}` };
    }
  }

  // Pattern: Track by Artist
  const byMatch = t.match(/(.+)\s+by\s+(.+)/i);
  if (byMatch) {
    const track = byMatch[1].trim();
    const artist = byMatch[2].trim();
    return { track, artist, rawQuery: `${track} ${artist}` };
  }

  // Fallback: use channel name to bias artist if it looks like an artist channel
  const track = t;
  let artist = null;

  if (channelName) {
    // Drop suffixes like " - Topic"
    const cleanedChannel = channelName.replace(/\s+-\s+topic$/i, '').trim();
    artist = cleanedChannel;
  }

  const rawQuery = artist ? `${track} ${artist}` : track;
  return { track, artist, rawQuery };
}

function getChannelName() {
  const owner = document.querySelector('ytd-video-owner-renderer a');
  if (owner && owner.textContent) return owner.textContent.trim();
  // Alternate selector
  const alt = document.querySelector('#channel-name a');
  return alt?.textContent?.trim() || null;
}

function getVideoTitle() {
  // New YouTube UI
  const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')
         || document.querySelector('h1.ytd-watch-metadata')
         || document.querySelector('h1.title');
  return el?.textContent?.trim() || '';
}

function insertButton() {
  if (document.getElementById(BUTTON_ID)) return;

  // Anchor: below the title block within ytd-watch-metadata
  const meta = document.querySelector('ytd-watch-metadata');
  if (!meta) return;

  const titleNode =
    meta.querySelector('h1.ytd-watch-metadata') ||
    meta.querySelector('#title') ||
    meta;

  const container = document.createElement('div');
  container.id = BUTTON_ID;
  container.className = 'open-spotify-btn-container';

  container.innerHTML = `
    <button class="open-spotify-btn" type="button" title="Open on Spotify">
      <span class="open-spotify-logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M12 0a12 12 0 1 0 0 24A12 12 0 0 0 12 0Zm5.5 17.3a.9.9 0 0 1-1.24.3c-3.4-2.07-7.7-2.54-12.75-1.38a.9.9 0 0 1-.4-1.76c5.48-1.26 10.15-.74 13.93 1.53.43.26.57.82.27 1.31Zm1.72-3.18a1.12 1.12 0 0 1-1.54.38c-3.87-2.37-9.77-3.06-14.36-1.66a1.12 1.12 0 1 1-.64-2.14c5.15-1.54 11.59-.76 15.92 1.9.53.32.7 1.01.33 1.52Zm.15-3.34C15.9 8.03 8.84 7.78 4.36 9.14a1.34 1.34 0 1 1-.77-2.58c5.07-1.52 12.78-1.22 17.6 1.7a1.34 1.34 0 0 1-1.42 2.32Z"></path>
        </svg>
      </span>
      <span>Open in Spotify</span>
    </button>
  `;

  // Place it right under the title (and above the rest of the metadata)
  titleNode.insertAdjacentElement('afterend', container);

  const btn = container.querySelector('button.open-spotify-btn');
  btn.addEventListener('click', () => {
    const title = getVideoTitle();
    const channel = getChannelName();
    const payload = extractTrackAndArtist(title, channel);
    ext.runtime.sendMessage({
      type: 'OPEN_SPOTIFY_FOR_TITLE',
      payload
    });
  });
}

function onNavigate() {
  // Reset and try to inject again for the new video
  removeButton();
  waitForMetaAndInsert();
}

function removeButton() {
  const el = document.getElementById(BUTTON_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function waitForMetaAndInsert(tries = 0) {
  if (document.querySelector('ytd-watch-metadata')) {
    insertButton();
    return;
  }
  if (tries > 40) return; // ~8s max
  setTimeout(() => waitForMetaAndInsert(tries + 1), 200);
}

// Observe URL changes (YouTube SPA)
const urlObserver = setInterval(() => {
  if (lastUrl !== location.href) {
    lastUrl = location.href;
    onNavigate();
  }
}, 500);

// Listen to YouTube’s SPA navigation event if available
window.addEventListener('yt-navigate-finish', onNavigate);

waitForMetaAndInsert();

// Also handle major DOM changes to re-insert if YouTube re-renders title block
const mo = new MutationObserver(() => {
  if (!document.getElementById(BUTTON_ID)) insertButton();
});
mo.observe(document.documentElement, { childList: true, subtree: true });
