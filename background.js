// background.js — MV3 service worker, PKCE auth (no client secret)
const ext = typeof browser !== 'undefined' ? browser : chrome;

// ======= Config =======
const SPOTIFY_CLIENT_ID = "7a05c83122a040b0b6e76adc32ca4dbe"; // public
const SPOTIFY_SCOPES = ""; // none required for /v1/search
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTH_URL  = "https://accounts.spotify.com/authorize";

// ======= Storage helpers =======
async function getAuth() {
  const { spotifyAuth } = await ext.storage.local.get("spotifyAuth");
  return spotifyAuth || null;
}
async function setAuth(obj) {
  await ext.storage.local.set({ spotifyAuth: obj });
}

// ======= PKCE utilities =======
function b64url(uint8) {
  let str = btoa(String.fromCharCode(...new Uint8Array(uint8)));
  return str.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function randStr(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const buf = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(buf, b => chars[b % chars.length]).join("");
}
async function pkceChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return b64url(digest);
}

// ======= OAuth: start & exchange =======
async function startAuthPKCE(interactive = true) {
  const redirectUri = ext.identity.getRedirectURL(); // register this in Spotify dashboard
  const codeVerifier = randStr(64);
  const codeChallenge = await pkceChallenge(codeVerifier);

  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", SPOTIFY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", codeChallenge);
  if (SPOTIFY_SCOPES) url.searchParams.set("scope", SPOTIFY_SCOPES);

  const redirect = await ext.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive
  });

  const code = new URL(redirect).searchParams.get("code");
  if (!code) throw new Error("No auth code returned");

  // Exchange code -> tokens (no secret in PKCE)
  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const tok = await res.json();

  const expiresAt = Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600) - 60;
  await setAuth({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token, // keep for silent renewals
    expires_at: expiresAt
  });
}

async function refreshToken(refresh_token) {
  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
  const tok = await res.json();
  const current = await getAuth();
  const expiresAt = Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600) - 60;

  await setAuth({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || current?.refresh_token, // Spotify may omit
    expires_at: expiresAt
  });
}

// Return a valid token or null (if user hasn’t authorized and interactive=false)
async function getSpotifyToken({ interactive = true } = {}) {
  const auth = await getAuth();
  const now = Math.floor(Date.now() / 1000);

  if (auth?.access_token && now < (auth.expires_at || 0)) {
    return auth.access_token;
  }
  if (auth?.refresh_token) {
    try {
      await refreshToken(auth.refresh_token);
      return (await getAuth()).access_token;
    } catch (e) {
      console.warn("Refresh failed, restarting auth", e);
      // fall through to new auth if allowed
    }
  }
  if (!interactive) return null;
  await startAuthPKCE(true);
  return (await getAuth())?.access_token || null;
}

// ======= Search logic (unchanged API usage) =======
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
function buildSpotifyQuery({ track, artist, rawQuery }) {
  if (track && artist) {
    const t = track.replace(/"/g, "");
    const a = artist.replace(/"/g, "");
    return `track:"${t}" artist:"${a}"`;
  }
  return rawQuery || "";
}

async function searchSpotifyExact({ track, artist, rawQuery }) {
  const token = await getSpotifyToken({ interactive: true }); // will prompt once
  if (!token) return null;

  const q = buildSpotifyQuery({ track, artist, rawQuery });
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", q);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", "5");
  url.searchParams.set("market", "US");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    console.warn("Spotify search failed:", res.status);
    return null;
  }
  const items = (await res.json())?.tracks?.items || [];
  if (!items.length) return null;

  // light ranking
  if (track) {
    const nTarget = normalize(track);
    let best = null, bestScore = -1;
    for (const it of items) {
      const name = normalize(it.name);
      let score = (name === nTarget ? 3 : (name.includes(nTarget) || nTarget.includes(name) ? 2 : 0));
      if (artist) {
        const nArtist = normalize(artist);
        if (it.artists.some(a => {
          const na = normalize(a.name);
          return na === nArtist || na.includes(nArtist) || nArtist.includes(na);
        })) score += 1.5;
      }
      if (score > bestScore) { bestScore = score; best = it; }
    }
    if (best) return `https://open.spotify.com/track/${best.id}`;
  }
  return `https://open.spotify.com/track/${items[0].id}`;
}

// ======= Message listener =======
ext.runtime.onMessage.addListener(async (msg) => {
  if (!msg || msg.type !== "OPEN_SPOTIFY_FOR_TITLE") return;
  let url = null;
  try { url = await searchSpotifyExact(msg.payload); } catch (e) { console.warn(e); }
  if (!url) {
    const q = msg.payload.rawQuery || "";
    url = `https://open.spotify.com/search/${encodeURIComponent(q)}`;
  }
  await ext.tabs.create({ url, active: true });
});
