// spotify.js — "Now Playing" sync over the data channel (no backend, no Premium needed)

const SpotifySync = (() => {
  const SCOPES = 'user-read-currently-playing user-read-playback-state';
  let token = null;
  let currentTrack = null;
  let onTrackChange = null;
  let pollTimer = null;

  function redirectUri() {
    return location.origin + location.pathname;
  }

  // ── Auth ──
  function connect() {
    const clientId = (typeof SPARK_CONFIG !== 'undefined' && SPARK_CONFIG.spotifyClientId) || '';
    if (!clientId) {
      alert('Add your Spotify Client ID to js/config.js to use this feature.\n\nGet one free at developer.spotify.com — see the setup note in config.js.');
      return;
    }
    sessionStorage.setItem('spark_spotify_redirect', '1');
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'token',
      redirect_uri: redirectUri(),
      scope: SCOPES,
      show_dialog: 'false',
    });
    location.href = `https://accounts.spotify.com/authorize?${params}`;
  }

  function disconnect() {
    token = null;
    currentTrack = null;
    sessionStorage.removeItem('spark_spotify_token');
    stopPolling();
    updateYoursUI();
  }

  function isConnected() { return !!token; }

  // ── API ──
  async function fetchNowPlaying() {
    if (!token) return null;
    try {
      const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (r.status === 401) {
        token = null;
        sessionStorage.removeItem('spark_spotify_token');
        updateYoursUI();
        return null;
      }
      if (r.status === 204 || !r.ok) return null;
      const data = await r.json();
      if (!data?.item) return null;
      return {
        name: data.item.name,
        artist: data.item.artists.map(a => a.name).join(', '),
        albumArt: data.item.album.images?.[2]?.url || data.item.album.images?.[0]?.url || null,
        uri: data.item.external_urls?.spotify || null,
        isPlaying: data.is_playing,
      };
    } catch { return null; }
  }

  // ── Polling ──
  function startPolling(onChange) {
    onTrackChange = onChange;
    stopPolling();
    const tick = async () => {
      const t = await fetchNowPlaying();
      const uriChanged   = (t?.uri   || null) !== (currentTrack?.uri   || null);
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

  // ── UI helpers ──
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function trackHTML(t) {
    const artHtml = t.albumArt
      ? `<img class="spotify-art" src="${esc(t.albumArt)}" alt="" loading="lazy">`
      : `<div class="spotify-art"></div>`;
    const href   = t.uri ? esc(t.uri) : '#';
    const target = t.uri ? ' target="_blank" rel="noopener"' : '';
    return `<a class="spotify-track-row" href="${href}"${target}>
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
    // Validate data from partner before touching the DOM
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

  function init() {
    // Read token from sessionStorage (set during OAuth redirect handling at bottom of file)
    const stored = sessionStorage.getItem('spark_spotify_token');
    if (stored) {
      token = stored;
      startPolling(null); // onChange set properly in onConnected
    }
    updateYoursUI();
  }

  return { init, connect, disconnect, isConnected, startPolling, stopPolling, getCurrent, setPartnerTrack, resetPartner };
})();

// Handle Spotify OAuth redirect — runs immediately when the script loads (DOM is ready)
// Spotify returns the token in the URL hash after the user authorizes the app
(function handleSpotifyRedirect() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const t = hash.get('access_token');
  if (!t) return;
  sessionStorage.setItem('spark_spotify_token', t);
  sessionStorage.removeItem('spark_spotify_redirect');
  history.replaceState(null, '', location.pathname);
  // Show "connected" note on the splash screen so the user knows to click Start
  const note = document.getElementById('spotifyReturnNote');
  if (note) note.style.display = 'block';
}());
