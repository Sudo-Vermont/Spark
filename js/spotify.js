// spotify.js — Spotify "Now Playing" sync via PKCE OAuth (no backend, no Premium needed)

const SpotifySync = (() => {
  const SCOPES = 'user-read-currently-playing user-read-playback-state';
  let token = null;
  let currentTrack = null;
  let onTrackChange = null;
  let pollTimer = null;

  function clientId() {
    return (typeof SPARK_CONFIG !== 'undefined' && SPARK_CONFIG.spotifyClientId) || '';
  }
  function redirectUri() { return location.origin + location.pathname; }

  // ── PKCE helpers ──
  async function pkceChallenge() {
    const arr = new Uint8Array(64);
    crypto.getRandomValues(arr);
    const verifier = btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return { verifier, challenge };
  }

  // ── Auth ──
  async function connect() {
    if (!clientId()) { alert('Add your Spotify Client ID to js/config.js.'); return; }
    const { verifier, challenge } = await pkceChallenge();
    localStorage.setItem('spark_spotify_verifier', verifier);
    const params = new URLSearchParams({
      client_id: clientId(),
      response_type: 'code',
      redirect_uri: redirectUri(),
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    location.href = `https://accounts.spotify.com/authorize?${params}`;
  }

  async function exchangeCode(code) {
    const verifier = localStorage.getItem('spark_spotify_verifier');
    if (!verifier) return false;
    try {
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
          client_id: clientId(),
          code_verifier: verifier,
        }),
      });
      const data = await r.json();
      if (data.access_token) {
        token = data.access_token;
        localStorage.setItem('spark_spotify_token', token);
        if (data.refresh_token) localStorage.setItem('spark_spotify_refresh', data.refresh_token);
        localStorage.removeItem('spark_spotify_verifier');
        return true;
      }
      console.warn('Spotify exchange error:', data);
    } catch(e) { console.warn('Spotify token exchange failed:', e); }
    return false;
  }

  async function tryRefresh() {
    const rt = localStorage.getItem('spark_spotify_refresh');
    if (!rt) return false;
    try {
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: rt,
          client_id: clientId(),
        }),
      });
      const data = await r.json();
      if (data.access_token) {
        token = data.access_token;
        localStorage.setItem('spark_spotify_token', token);
        if (data.refresh_token) localStorage.setItem('spark_spotify_refresh', data.refresh_token);
        return true;
      }
    } catch(e) {}
    return false;
  }

  function clearAuth() {
    token = null;
    localStorage.removeItem('spark_spotify_token');
    localStorage.removeItem('spark_spotify_refresh');
  }

  function disconnect() {
    clearAuth();
    currentTrack = null;
    stopPolling();
    updateYoursUI();
  }

  function isConnected() { return !!token; }

  // ── API ──
  async function fetchNowPlaying(retried = false) {
    if (!token) return null;
    try {
      const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (r.status === 401) {
        if (retried) { clearAuth(); updateYoursUI(); return null; }
        const ok = await tryRefresh();
        if (!ok) { clearAuth(); updateYoursUI(); return null; }
        return fetchNowPlaying(true);
      }
      if (r.status === 204 || !r.ok) return null;
      const data = await r.json();
      if (!data?.item) return null;
      return {
        name:     data.item.name,
        artist:   data.item.artists.map(a => a.name).join(', '),
        albumArt: data.item.album.images?.[2]?.url || data.item.album.images?.[0]?.url || null,
        uri:      data.item.external_urls?.spotify || null,
        isPlaying: data.is_playing,
      };
    } catch { return null; }
  }

  // ── Polling ──
  function startPolling(onChange) {
    // Don't clobber a real callback with null (init passes null; onConnected passes the real fn)
    if (onChange != null) onTrackChange = onChange;
    stopPolling();
    const tick = async () => {
      const t = await fetchNowPlaying();
      const uriChanged   = (t?.uri      ?? null)  !== (currentTrack?.uri      ?? null);
      const stateChanged = (t?.isPlaying ?? false) !== (currentTrack?.isPlaying ?? false);
      currentTrack = t;
      updateYoursUI();
      if ((uriChanged || stateChanged) && onTrackChange) onTrackChange(t);
    };
    tick();
    pollTimer = setInterval(tick, 8000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function getCurrent() { return currentTrack; }

  // ── UI ──
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function trackHTML(t) {
    const artHtml = t.albumArt
      ? `<img class="spotify-art" src="${esc(t.albumArt)}" alt="" loading="lazy">`
      : `<div class="spotify-art"></div>`;
    const href   = t.uri ? esc(t.uri) : '#';
    const attrs  = t.uri ? ' target="_blank" rel="noopener"' : '';
    return `<a class="spotify-track-row" href="${href}"${attrs}>
      ${artHtml}
      <div class="spotify-info">
        <div class="spotify-name">${esc(t.name)}</div>
        <div class="spotify-artist">${esc(t.artist)}</div>
      </div>
      <span class="spotify-play-state">${t.isPlaying ? '▶' : '⏸'}</span>
    </a>`;
  }

  function updateYoursUI() {
    const el = document.getElementById('spotifyYours');
    if (!el) return;
    if (!token) {
      el.innerHTML = '<button class="spotify-connect-btn" id="spotifyConnectBtn">Connect Spotify</button>';
      document.getElementById('spotifyConnectBtn')?.addEventListener('click', connect);
      return;
    }
    el.innerHTML = currentTrack ? trackHTML(currentTrack) : '<span class="spotify-idle">nothing playing</span>';
  }

  function setPartnerTrack(raw) {
    const el = document.getElementById('spotifyTheirs');
    if (!el) return;
    if (!raw) { el.innerHTML = '<span class="spotify-idle">not sharing</span>'; return; }
    // Validate before touching the DOM — partner data is untrusted
    const t = {
      name:     String(raw.name   || '').slice(0, 200),
      artist:   String(raw.artist || '').slice(0, 200),
      albumArt: typeof raw.albumArt === 'string' && raw.albumArt.startsWith('https://i.scdn.co/') ? raw.albumArt : null,
      uri:      typeof raw.uri     === 'string' && raw.uri.startsWith('https://open.spotify.com/') ? raw.uri : null,
      isPlaying: !!raw.isPlaying,
    };
    el.innerHTML = trackHTML(t);
  }

  function resetPartner() {
    const el = document.getElementById('spotifyTheirs');
    if (el) el.innerHTML = '<span class="spotify-idle">not sharing</span>';
  }

  async function init() {
    // Handle PKCE callback — Spotify redirects back with ?code=... in the URL
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (code) {
      history.replaceState(null, '', location.pathname); // clean the URL immediately
      const ok = await exchangeCode(code);
      if (ok) {
        const note = document.getElementById('spotifyReturnNote');
        if (note) note.style.display = 'block';
      }
    }

    // Load stored token
    if (!token) {
      const stored = localStorage.getItem('spark_spotify_token');
      if (stored) token = stored;
    }

    updateYoursUI();
    if (token) startPolling(null); // show your track in sidebar even before a match
  }

  return { init, connect, disconnect, isConnected, startPolling, stopPolling, getCurrent, setPartnerTrack, resetPartner };
})();
