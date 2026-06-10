// music.js — YouTube Music / YouTube link sharing over the data channel (no API key needed)

const MusicSync = (() => {
  let onShare = null; // set by app.js when a call is active

  // ── URL parsing ──
  function extractVideoId(input) {
    try {
      const u = new URL(input.trim());
      // youtube.com/watch?v=ID  or  music.youtube.com/watch?v=ID
      if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
      // youtu.be/ID
      if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    } catch {}
    return null;
  }

  // ── Metadata via oEmbed (free, no API key, CORS-safe) ──
  async function fetchInfo(videoId) {
    try {
      const url = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`;
      const r = await fetch(url);
      if (!r.ok) return null;
      const d = await r.json();
      return {
        videoId,
        title:     d.title      || 'Unknown title',
        author:    d.author_name || '',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        url:       `https://music.youtube.com/watch?v=${videoId}`,
      };
    } catch { return null; }
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
    const info = await fetchInfo(videoId);
    if (btn) btn.textContent = 'Share';

    if (!info) return;
    if (input) input.value = '';

    setYoursUI(info);
    if (onShare) onShare(info);
  }

  // ── UI ──
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function trackHTML(t) {
    return `<a class="music-track-row" href="${esc(t.url)}" target="_blank" rel="noopener">
      <img class="music-art" src="${esc(t.thumbnail)}" alt="" loading="lazy">
      <div class="music-info">
        <div class="music-name">${esc(t.title)}</div>
        <div class="music-artist">${esc(t.author)}</div>
      </div>
    </a>`;
  }

  function setYoursUI(track) {
    const el = document.getElementById('musicYours');
    if (el) el.innerHTML = track ? trackHTML(track) : '<span class="music-idle">nothing shared</span>';
  }

  function setPartnerTrack(raw) {
    const el = document.getElementById('musicTheirs');
    if (!el) return;
    if (!raw) { el.innerHTML = '<span class="music-idle">not sharing</span>'; return; }
    // Validate — raw comes from an untrusted peer
    const videoId = typeof raw.videoId === 'string' ? raw.videoId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) : null;
    if (!videoId) { el.innerHTML = '<span class="music-idle">not sharing</span>'; return; }
    const t = {
      videoId,
      title:     String(raw.title  || '').slice(0, 200),
      author:    String(raw.author || '').slice(0, 200),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      url:       `https://music.youtube.com/watch?v=${videoId}`,
    };
    el.innerHTML = trackHTML(t);
  }

  function resetPartner() {
    const el = document.getElementById('musicTheirs');
    if (el) el.innerHTML = '<span class="music-idle">not sharing</span>';
  }

  function setOnShare(cb) { onShare = cb; }

  function init() {
    const btn   = document.getElementById('musicShareBtn');
    const input = document.getElementById('musicInput');
    if (btn)   btn.addEventListener('click', handleShare);
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') handleShare(); });
  }

  return { init, setOnShare, setPartnerTrack, resetPartner };
})();
