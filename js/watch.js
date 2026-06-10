// watch.js — synchronized YouTube watch party over the data channel

const WatchSync = (() => {
  let onShare = null;
  let onSyncSend = null;

  let player = null;
  let currentVideoId = null;
  let isController = false;

  let unlocked = false;
  let pendingSync = null;
  let syncInterval = null;

  // ── YouTube IFrame API (shared global queue — music.js defines onYouTubeIframeAPIReady) ──
  function ensureYTApi() {
    return new Promise(resolve => {
      if (window.__ytReady) { resolve(); return; }
      (window.__ytReadyCbs = window.__ytReadyCbs || []).push(resolve);
      if (document.getElementById('yt-api-script')) return;
      const s = document.createElement('script');
      s.id = 'yt-api-script';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
  }

  // ── URL parsing ──
  function extractVideoId(input) {
    try {
      const u = new URL(input.trim());
      if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
      if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    } catch {}
    return null;
  }

  function makePlayer(elId, videoId, autoplay, controls, onStateChange) {
    return new Promise(resolve => {
      if (!document.getElementById(elId)) { resolve(null); return; }
      new YT.Player(elId, {
        videoId,
        playerVars: { autoplay, controls, rel: 0, modestbranding: 1, fs: 1, iv_load_policy: 3 },
        events: {
          onReady: e => resolve(e.target),
          onStateChange,
        }
      });
    });
  }

  // ── Modal ──
  function openModal() {
    const m = document.getElementById('watchModal');
    if (m) { m.style.display = 'flex'; }
  }

  function closeModal() {
    const m = document.getElementById('watchModal');
    if (m) m.style.display = 'none';
    // Don't destroy the player — just hide so audio keeps going
  }

  // ── Controller player (the person who shared — full controls) ──
  async function createControllerPlayer(videoId) {
    destroyCurrentPlayer();
    currentVideoId = videoId;
    isController = true;
    unlocked = true;

    const area = document.getElementById('watchPlayerArea');
    if (area) area.innerHTML = '<div class="watch-player-wrap"><div id="watch-yt"></div></div>';

    await ensureYTApi();
    player = await makePlayer('watch-yt', videoId, 1, 1, handleStateChange);
    startPeriodicSync();
  }

  function handleStateChange(event) {
    if (!isController || !onSyncSend) return;
    const time = player ? player.getCurrentTime() : 0;
    if (event.data === YT.PlayerState.PLAYING) {
      onSyncSend({ action: 'play', time, videoId: currentVideoId });
    } else if (event.data === YT.PlayerState.PAUSED) {
      onSyncSend({ action: 'pause', time, videoId: currentVideoId });
    }
  }

  function startPeriodicSync() {
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(() => {
      if (!isController || !onSyncSend || !player) return;
      try {
        if (player.getPlayerState() === YT.PlayerState.PLAYING) {
          onSyncSend({ action: 'sync', time: player.getCurrentTime(), videoId: currentVideoId });
        }
      } catch(e) {}
    }, 15000);
  }

  // ── Mirror player (partner's synced view — no controls) ──
  async function createMirrorPlayer(videoId) {
    destroyCurrentPlayer();
    currentVideoId = videoId;
    isController = false;
    unlocked = false;
    pendingSync = null;

    openModal();

    const area = document.getElementById('watchPlayerArea');
    if (area) area.innerHTML = `
      <div class="watch-player-wrap"><div id="watch-yt"></div></div>
      <button class="watch-unlock-btn" id="watchUnlockBtn">▶ Click to sync audio</button>
    `;

    document.getElementById('watchUnlockBtn')?.addEventListener('click', () => {
      document.getElementById('watchUnlockBtn')?.remove();
      unlocked = true;
      if (pendingSync && player) {
        applySync(pendingSync);
        pendingSync = null;
      } else if (player) {
        try { player.playVideo(); } catch(e) {}
      }
    });

    await ensureYTApi();
    player = await makePlayer('watch-yt', videoId, 0, 0, null);
  }

  // ── Apply sync from partner ──
  function applySync(data) {
    if (!player) return;
    if (!unlocked) { pendingSync = data; return; }
    try {
      if (data.action === 'play') {
        player.seekTo(data.time || 0, true);
        player.playVideo();
      } else if (data.action === 'pause') {
        player.pauseVideo();
        player.seekTo(data.time || 0, true);
      } else if (data.action === 'sync') {
        const cur = player.getCurrentTime();
        if (Math.abs(cur - (data.time || 0)) > 3) player.seekTo(data.time, true);
      }
    } catch(e) {}
  }

  function destroyCurrentPlayer() {
    if (player) { try { player.destroy(); } catch(e) {} player = null; }
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  }

  // ── Share handler ──
  async function handleShare() {
    const input = document.getElementById('watchInput');
    const btn   = document.getElementById('watchShareBtn');
    const raw   = input?.value?.trim();
    if (!raw) return;

    const videoId = extractVideoId(raw);
    if (!videoId) {
      if (input) { input.classList.add('watch-input-error'); setTimeout(() => input.classList.remove('watch-input-error'), 1400); }
      return;
    }

    if (btn) btn.textContent = '...';
    await createControllerPlayer(videoId);
    if (btn) btn.textContent = 'Watch';
    if (input) input.value = '';

    if (onShare) onShare({ videoId });
  }

  // ── Called by app.js ──
  function setPartnerVideo(raw) {
    const videoId = typeof raw?.videoId === 'string'
      ? raw.videoId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20)
      : null;
    if (!videoId) return;
    createMirrorPlayer(videoId);
  }

  function resetPartner() {
    if (isController) return; // keep your own player running after partner leaves
    destroyCurrentPlayer();
    unlocked = false;
    pendingSync = null;
    currentVideoId = null;
    const area = document.getElementById('watchPlayerArea');
    if (area) area.innerHTML = '<div class="watch-idle-msg">Paste a YouTube link above to watch together</div>';
  }

  function setOnShare(cb) { onShare = cb; }
  function setOnSyncSend(cb) { onSyncSend = cb; }

  function init() {
    document.getElementById('watchBtn')?.addEventListener('click', openModal);
    document.getElementById('watchCloseBtn')?.addEventListener('click', closeModal);
    document.getElementById('watchShareBtn')?.addEventListener('click', handleShare);
    document.getElementById('watchInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleShare(); });

    // Close on backdrop click
    document.getElementById('watchModal')?.addEventListener('click', e => {
      if (e.target.id === 'watchModal') closeModal();
    });
  }

  return { init, setOnShare, setOnSyncSend, setPartnerVideo, applySync, resetPartner };
})();
