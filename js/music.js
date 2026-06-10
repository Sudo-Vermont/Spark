// music.js — YouTube IFrame player with real-time sync over the data channel

const MusicSync = (() => {
  let onShare = null;
  let onSyncSend = null;

  let yoursPlayer = null;
  let theirsPlayer = null;
  let yoursVideoId = null;
  let isController = false;

  let ytReady = false;
  let ytReadyCbs = [];

  let theirsUnlocked = false;
  let pendingSync = null;
  let syncInterval = null;

  // ── YouTube IFrame API ──
  function ensureYTApi() {
    return new Promise(resolve => {
      if (ytReady) { resolve(); return; }
      ytReadyCbs.push(resolve);
      if (document.getElementById('yt-api-script')) return;
      const s = document.createElement('script');
      s.id = 'yt-api-script';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
  }

  window.onYouTubeIframeAPIReady = () => {
    ytReady = true;
    ytReadyCbs.forEach(cb => cb());
    ytReadyCbs = [];
  };

  // ── URL parsing ──
  function extractVideoId(input) {
    try {
      const u = new URL(input.trim());
      if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
      if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    } catch {}
    return null;
  }

  // Creates a YT.Player inside the element with the given id (replaces it with an iframe)
  function makePlayer(elId, videoId, autoplay, controls, onStateChange) {
    return new Promise(resolve => {
      if (!document.getElementById(elId)) { resolve(null); return; }
      new YT.Player(elId, {
        videoId,
        playerVars: { autoplay, controls, rel: 0, modestbranding: 1, fs: 0, iv_load_policy: 3 },
        events: {
          onReady: e => resolve(e.target),
          onStateChange,
        }
      });
    });
  }

  // ── Yours (the person who shared — full controls) ──
  async function createYoursPlayer(videoId) {
    destroyPlayer('yours');
    yoursVideoId = videoId;
    isController = true;

    const el = document.getElementById('musicYours');
    if (el) el.innerHTML = '<div class="music-player-wrap"><div id="yours-yt"></div></div>';

    await ensureYTApi();
    yoursPlayer = await makePlayer('yours-yt', videoId, 1, 1, handleYoursStateChange);
    startPeriodicSync();
  }

  function handleYoursStateChange(event) {
    if (!isController || !onSyncSend) return;
    const time = yoursPlayer ? yoursPlayer.getCurrentTime() : 0;
    if (event.data === YT.PlayerState.PLAYING) {
      onSyncSend({ action: 'play', time, videoId: yoursVideoId });
    } else if (event.data === YT.PlayerState.PAUSED) {
      onSyncSend({ action: 'pause', time, videoId: yoursVideoId });
    }
  }

  function startPeriodicSync() {
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(() => {
      if (!isController || !onSyncSend || !yoursPlayer) return;
      try {
        if (yoursPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
          onSyncSend({ action: 'sync', time: yoursPlayer.getCurrentTime(), videoId: yoursVideoId });
        }
      } catch(e) {}
    }, 15000);
  }

  // ── Theirs (partner's mirror — no controls, syncs to partner's state) ──
  async function createTheirsPlayer(videoId) {
    destroyPlayer('theirs');
    theirsUnlocked = false;
    pendingSync = null;

    const el = document.getElementById('musicTheirs');
    if (!el) return;
    el.innerHTML = `
      <div class="music-player-wrap"><div id="theirs-yt"></div></div>
      <button class="music-unlock-btn" id="musicUnlockBtn">▶ Click to sync audio</button>
    `;

    document.getElementById('musicUnlockBtn')?.addEventListener('click', () => {
      document.getElementById('musicUnlockBtn')?.remove();
      theirsUnlocked = true;
      if (pendingSync && theirsPlayer) {
        applySync(pendingSync);
        pendingSync = null;
      } else if (theirsPlayer) {
        try { theirsPlayer.playVideo(); } catch(e) {}
      }
    });

    await ensureYTApi();
    theirsPlayer = await makePlayer('theirs-yt', videoId, 0, 0, null);
  }

  // ── Receive sync events from partner and mirror their player state ──
  function applySync(data) {
    if (!theirsPlayer) return;
    if (!theirsUnlocked) { pendingSync = data; return; }
    try {
      if (data.action === 'play') {
        theirsPlayer.seekTo(data.time || 0, true);
        theirsPlayer.playVideo();
      } else if (data.action === 'pause') {
        theirsPlayer.pauseVideo();
        theirsPlayer.seekTo(data.time || 0, true);
      } else if (data.action === 'sync') {
        const cur = theirsPlayer.getCurrentTime();
        if (Math.abs(cur - (data.time || 0)) > 3) theirsPlayer.seekTo(data.time, true);
      }
    } catch(e) {}
  }

  function destroyPlayer(which) {
    if (which === 'yours' && yoursPlayer) {
      try { yoursPlayer.destroy(); } catch(e) {}
      yoursPlayer = null;
    }
    if (which === 'theirs' && theirsPlayer) {
      try { theirsPlayer.destroy(); } catch(e) {}
      theirsPlayer = null;
    }
  }

  // ── Share handler ──
  async function handleShare() {
    const input = document.getElementById('musicInput');
    const btn   = document.getElementById('musicShareBtn');
    const raw   = input?.value?.trim();
    if (!raw) return;

    const videoId = extractVideoId(raw);
    if (!videoId) {
      if (input) { input.classList.add('music-input-error'); setTimeout(() => input.classList.remove('music-input-error'), 1400); }
      return;
    }

    if (btn) btn.textContent = '...';
    await createYoursPlayer(videoId);
    if (btn) btn.textContent = 'Share';
    if (input) input.value = '';

    if (onShare) onShare({ videoId });
  }

  // ── Called by app.js when partner sends a track ──
  function setPartnerTrack(raw) {
    const videoId = typeof raw?.videoId === 'string'
      ? raw.videoId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20)
      : null;
    if (!videoId) return;
    isController = false;
    createTheirsPlayer(videoId);
  }

  function resetPartner() {
    destroyPlayer('theirs');
    theirsUnlocked = false;
    pendingSync = null;
    if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
    isController = false;
    const el = document.getElementById('musicTheirs');
    if (el) el.innerHTML = '<span class="music-idle">not sharing</span>';
  }

  function setOnShare(cb) { onShare = cb; }
  function setOnSyncSend(cb) { onSyncSend = cb; }

  function init() {
    const btn   = document.getElementById('musicShareBtn');
    const input = document.getElementById('musicInput');
    if (btn)   btn.addEventListener('click', handleShare);
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') handleShare(); });
  }

  return { init, setOnShare, setOnSyncSend, setPartnerTrack, applySync, resetPartner };
})();
