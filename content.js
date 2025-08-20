// content.js – robust YouTube SPA handling
const ext = typeof browser !== 'undefined' ? browser : chrome;

const BUTTON_ID = 'open-in-spotify-btn-yts';
let currentVideoId = null;
let lastUrl = location.href;

// --- early guard: only act on /watch pages
if (!location.pathname.startsWith('/watch')) {
  // Still install observers to catch SPA navigation into /watch
  const urlWatch = setInterval(() => {
    if (location.pathname.startsWith('/watch')) {
      clearInterval(urlWatch);
      scheduleInject();
    }
  }, 300);
}


// ---- utils ----
const parseVideoId = () => new URL(location.href).searchParams.get('v');

function elementReady(selector, within = document, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const found = within.querySelector(selector);
    if (found) return resolve(found);

    const obs = new MutationObserver(() => {
      const el = within.querySelector(selector);
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });

    obs.observe(within, { childList: true, subtree: true });

    if (timeoutMs) {
      setTimeout(() => {
        obs.disconnect();
        // Resolve anyway; caller will retry gracefully
        resolve(null);
      }, timeoutMs);
    }
  });
}

function stripEmojis(s) {
  return s.replace(/[\p{Extended_Pictographic}\u200D]/gu, '');
}
function removeBracketedJunk(s) {
  const COMMON_TAGS = [
    'official video','official music video','music video','official audio','audio',
    'lyrics','lyric video','visualizer','mv','pv','hd','4k','remastered',
    'prod.','prod','prod by','live performance','live','cover','teaser'
  ];
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
  t = t.replace(/\s+(feat\.?|ft\.?)\s+.+$/i, '');
  t = t.replace(/\s+-\s+topic$/i, '');
  return t.trim();
}
function extractTrackAndArtist(title, channelName) {
  const t = sanitizeTitle(title);
  if (!t) return { track: null, artist: null, rawQuery: null };
  const dash = t.split(/\s+-\s+/);
  if (dash.length === 2) {
    const [left, right] = dash;
    if (left && right) return { track: right.trim(), artist: left.trim(), rawQuery: `${right.trim()} ${left.trim()}` };
  }
  const byMatch = t.match(/(.+)\s+by\s+(.+)/i);
  if (byMatch) {
    const track = byMatch[1].trim();
    const artist = byMatch[2].trim();
    return { track, artist, rawQuery: `${track} ${artist}` };
  }
  const cleanedChannel = (channelName || '').replace(/\s+-\s+topic$/i, '').trim() || null;
  const track = t;
  const artist = cleanedChannel;
  const rawQuery = artist ? `${track} ${artist}` : track;
  return { track, artist, rawQuery };
}
function getChannelName() {
  return (
    document.querySelector('ytd-video-owner-renderer a')?.textContent?.trim() ||
    document.querySelector('#channel-name a')?.textContent?.trim() ||
    null
  );
}
function getVideoTitleText() {
  return (
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
    document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim() ||
    document.querySelector('h1.title')?.textContent?.trim() ||
    ''
  );
}

// ---- mounting ----
function removeButton() {
  document.getElementById(BUTTON_ID)?.remove();
}

function createButton() {
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
  const btn = container.querySelector('button.open-spotify-btn');
  btn.addEventListener('click', () => {
    const title = getVideoTitleText();
    const channel = getChannelName();
    const payload = extractTrackAndArtist(title, channel);
    ext.runtime.sendMessage({ type: 'OPEN_SPOTIFY_FOR_TITLE', payload });
  });
  return container;
}

let injectQueued = false;
async function injectButton() {
  injectQueued = false; // clear flag
  // Ensure we're on a watch page and have a video id
  const vid = parseVideoId();
  if (!vid) return;

  // If video changed, remove old button
  if (currentVideoId !== vid) {
    currentVideoId = vid;
    removeButton();
  }

  // Wait for the metadata/title area to exist
  const meta = await elementReady('ytd-watch-metadata');
  if (!meta) return; // will be retried by observers

  // Find a stable anchor under the title
  const anchor =
    meta.querySelector('h1.ytd-watch-metadata') ||
    meta.querySelector('h1') ||
    meta.querySelector('#title') ||
    meta;

  if (!anchor) return;

  // If already present in the correct place, stop
  if (document.getElementById(BUTTON_ID)?.isConnected) return;

  const node = createButton();
  anchor.insertAdjacentElement('afterend', node);
}

// throttle reschedules to avoid hammering
function scheduleInject() {
  if (injectQueued) return;
  injectQueued = true;
  // Two RAFs let Polymer finish a render turn before we probe
  requestAnimationFrame(() => requestAnimationFrame(injectButton));
}

// ---- observers & navigation hooks ----

// 1) React to YouTube’s SPA navigation events if present
window.addEventListener('yt-navigate-start', () => { scheduleInject(); }, true);
window.addEventListener('yt-navigate-finish', () => { scheduleInject(); }, true);
window.addEventListener('yt-page-data-updated', () => { scheduleInject(); }, true);

// 2) Fallback: observe large structural changes (title block is inside ytd-app)
const rootObserver = new MutationObserver((mutList) => {
  // If title/meta re-rendered or URL changed, try again
  for (const m of mutList) {
    if (m.type === 'childList') {
      if ([...m.addedNodes, ...m.removedNodes].some(n =>
        n.nodeType === 1 && (
          n.matches?.('ytd-watch-metadata, ytd-watch-flexy, #primary-inner, #title') ||
          n.querySelector?.('ytd-watch-metadata, ytd-watch-flexy, #primary-inner, #title')
        )
      )) {
        scheduleInject();
        break;
      }
    }
  }
});
rootObserver.observe(document.documentElement, { childList: true, subtree: true });

// 3) Fallback: URL poller (YouTube sometimes suppresses events)
setInterval(() => {
  if (lastUrl !== location.href) {
    lastUrl = location.href;
    scheduleInject();
  }
}, 400);

// 4) When tab becomes visible again, ensure button exists
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleInject();
});

// First run (very early, run_at=document_start)
scheduleInject();
