// background.js (MV3 service worker)

const ext = typeof browser !== 'undefined' ? browser : chrome;

// Cache token in-memory (service worker lifecycle aware)
let SPOTIFY_TOKEN = null;
let SPOTIFY_TOKEN_EXP = 0; // epoch seconds

async function getStoredCredentials() {
  const { spotifyClientId, spotifyClientSecret } = await ext.storage.sync.get([
    'spotifyClientId',
    'spotifyClientSecret'
  ]);
  return { spotifyClientId, spotifyClientSecret };
}

async function fetchSpotifyToken(clientId, clientSecret) {
  const creds = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) throw new Error(`Token error: ${res.status}`);
  const data = await res.json();
  // expires_in typically ~3600s
  SPOTIFY_TOKEN = data.access_token;
  SPOTIFY_TOKEN_EXP = Math.floor(Date.now() / 1000) + (data.expires_in - 60); // refresh 1m early
  return SPOTIFY_TOKEN;
}

async function getSpotifyToken() {
  const now = Math.floor(Date.now() / 1000);
  if (SPOTIFY_TOKEN && now < SPOTIFY_TOKEN_EXP) return SPOTIFY_TOKEN;

  const { spotifyClientId, spotifyClientSecret } = await getStoredCredentials();
  if (!spotifyClientId || !spotifyClientSecret) return null;

  try {
    return await fetchSpotifyToken(spotifyClientId, spotifyClientSecret);
  } catch (e) {
    console.warn('Spotify token fetch failed:', e);
    return null;
  }
}

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSpotifyQuery({ track, artist, rawQuery }) {
  if (track && artist) {
    // Track/artist fields produce much better precision in Spotify search
    // Use quotes to bias exact phrase matches, but keep a fallback rawQuery in case
    const t = track.replace(/"/g, '');
    const a = artist.replace(/"/g, '');
    return `track:"${t}" artist:"${a}"`;
  }
  return rawQuery || '';
}

async function searchSpotifyExact({ track, artist, rawQuery }) {
  const token = await getSpotifyToken();
  if (!token) return null; // no creds: caller should fall back to search page

  const q = buildSpotifyQuery({ track, artist, rawQuery });
  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', q);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', '5');   // fetch a few to rank
  url.searchParams.set('market', 'US'); // helps with availability

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    console.warn('Spotify search failed:', res.status);
    return null;
  }
  const data = await res.json();
  const items = data?.tracks?.items || [];
  if (!items.length) return null;

  // Light ranking: prefer exact-ish normalized name match if track provided
  if (track) {
    const nTarget = normalize(track);
    let best = null;
    let bestScore = -1;

    for (const it of items) {
      const name = normalize(it.name);
      let score = 0;
      if (name === nTarget) score = 3;
      else if (name.includes(nTarget) || nTarget.includes(name)) score = 2;

      // bonus if artist string matches one of the artists
      if (artist) {
        const nArtist = normalize(artist);
        const hasArtist = it.artists.some(a => {
          const na = normalize(a.name);
          return na === nArtist || na.includes(nArtist) || nArtist.includes(na);
        });
        if (hasArtist) score += 1.5;
      }

      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }

    if (best) return `https://open.spotify.com/track/${best.id}`;
  }

  // Otherwise first result
  return `https://open.spotify.com/track/${items[0].id}`;
}

ext.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg || msg.type !== 'OPEN_SPOTIFY_FOR_TITLE') return;

  // Attempt exact resolution via API (if credentials available)
  let url = null;
  try {
    url = await searchSpotifyExact(msg.payload);
  } catch (e) {
    console.warn('Exact lookup error:', e);
  }

  if (!url) {
    // Fallback: open Spotify search page
    const q = msg.payload.rawQuery || '';
    url = `https://open.spotify.com/search/${encodeURIComponent(q)}`;
  }

  // Open in a new tab
  await ext.tabs.create({ url, active: true });
});
