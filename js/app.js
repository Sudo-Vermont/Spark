// app.js — orchestrates PeerJS (serverless WebRTC), speech, Gemini coach, and UI

// Global state shared with gemini.js
const AppState = {
  transcript: [],
  remoteVideoEl: null,
  connected: false
};

(() => {
  const $ = id => document.getElementById(id);

  const els = {
    setupScreen:      $('setupScreen'),
    startBtn:         $('startBtn'),
    videoArea:        $('videoArea'),
    sidebar:          $('sidebar'),
    localVideo:       $('localVideo'),
    localOverlay:     $('localOverlay'),
    remoteVideo:      $('remoteVideo'),
    remoteOverlay:    $('remoteOverlay'),
    connectedFlash:   $('connectedFlash'),
    strangerLabel:    $('strangerLabel'),
    waitingTitle:     $('waitingTitle'),
    waitingSub:       $('waitingSub'),
    roomBadge:        $('roomBadge'),
    statusDot:        $('statusDot'),
    statusText:       $('statusText'),
    sessionTimer:     $('sessionTimer'),
    endBtn:           $('endBtn'),
    muteBtn:          $('muteBtn'),
    micPickBtn:       $('micPickBtn'),
    micDropdown:      $('micDropdown'),
    camBtn:           $('camBtn'),
    youInput:         $('youInput'),
    youSendBtn:       $('youSendBtn'),
    youMicBtn:        $('youMicBtn'),
    speechStatus:     $('speechStatus'),
    transcriptContainer: $('transcriptContainer'),
    transcriptIndicator: $('transcriptIndicator'),
    moodNote:            $('moodNote')
  };

  AppState.remoteVideoEl = els.remoteVideo;

  let peer = null;       // PeerJS instance
  let conn = null;       // DataConnection (for transcript relay)
  let call = null;       // MediaConnection
  let myProfile = null;
  let partnerProfile = null;
  let introTimer = null;

  Profile.init(); // populate splash avatar picker + saved name/bio
  let localStream = null;
  let timerInterval = null;
  let sessionStart = null;
  let muted = false;
  let camOff = false;
  let activeMicId = null;

  // Matchmaking slots — everyone walks them in the SAME order (0,1,2...) so a
  // waiter parked on any slot is always found by the next searcher. Random
  // order caused both users to wait on different slots and never meet.
  const SLOTS = 8;
  const CALL_TIMEOUT_MS = 6000;
  let searchGen = 0; // bumped to cancel any in-flight search loops
  function slotId(n) { return `spark-match-waiting-${n}`; }

  // ── Start / setup ──
  els.startBtn.addEventListener('click', async () => {
    myProfile = Profile.commit(); // save + read profile from splash inputs

    // Camera + mic — try video+audio, fall back to audio-only
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      els.localVideo.srcObject = localStream;
      els.localVideo.addEventListener('loadedmetadata', () => {
        els.localOverlay.style.display = 'none';
      }, { once: true });
    } catch (e) {
      console.warn('Camera+mic failed:', e.message);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        els.localOverlay.querySelector('.video-placeholder-text').textContent = 'camera unavailable';
      } catch (e2) {
        console.warn('Audio also failed:', e2.message);
        els.localOverlay.querySelector('.video-placeholder-text').textContent = 'no camera or mic — check permissions';
      }
    }

    // Hide setup, show app
    els.setupScreen.classList.add('fade-out');
    setTimeout(() => els.setupScreen.style.display = 'none', 400);
    els.videoArea.style.display = 'flex';
    els.sidebar.style.display   = 'flex';

    // Init modules
    GeminiCoach.init();
    MusicSync.init();
    WatchSync.init();
    initSpeech();
    initControls();
    initPeer();

    setStatus('searching');
    els.roomBadge.textContent = '';
    els.waitingTitle.textContent = 'Finding a match…';
    els.waitingSub.textContent   = 'Looking for someone to connect you with';
  });

  // ICE servers — multiple STUN servers across regions for global connectivity
  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.nextcloud.com:443' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      {
        urls: 'turn:global.relay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:global.relay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:global.relay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  };

  // ── PeerJS — matchmaking ──
  // Walk slots 0..N-1 in order:
  //  - Slot free  → claim it and wait for a caller.
  //  - Slot taken → its occupant is waiting; call them.
  //  - Occupant busy or dead → skip to the next slot, wrap around after a pause.
  function initPeer() {
    searchGen++;
    searchSlot(0, searchGen);
  }

  function searchSlot(idx, gen) {
    if (gen !== searchGen) return; // search was cancelled
    if (idx >= SLOTS) {
      setTimeout(() => searchSlot(0, gen), 1500);
      return;
    }
    const waitId = slotId(idx);
    peer = new Peer(waitId, { debug: 0, config: ICE_CONFIG });
    let claimed = false;

    peer.on('open', () => {
      claimed = true;
      console.log('Waiting on slot:', waitId);
    });

    peer.on('error', (err) => {
      if (gen !== searchGen) return;
      if (err.type === 'unavailable-id') {
        // Slot taken — someone is waiting there; call them
        try { peer.destroy(); } catch(e){}
        callWaiter(waitId, idx, gen);
      } else if (!claimed) {
        console.warn('PeerJS error while claiming:', err.type);
        try { peer.destroy(); } catch(e){}
        setTimeout(() => searchSlot(0, gen), 1500);
      } else {
        console.warn('PeerJS error while waiting:', err.type);
      }
    });

    // Waiter: incoming call
    const pendingDcs = new Map(); // data channels by remote peer id, until a call picks one
    peer.on('call', (incomingCall) => {
      if (AppState.connected || call) {
        // Already matched — reject so the prober moves on
        try { incomingCall.close(); } catch(e){}
        return;
      }
      console.log('Matched! Incoming call');
      call = incomingCall;
      let gotStream = false;

      // Adopt this caller's data channel; close any stray probes from other callers
      const partnerDc = pendingDcs.get(incomingCall.peer);
      if (partnerDc) conn = partnerDc;
      pendingDcs.forEach((dc, pid) => {
        if (pid !== incomingCall.peer) { try { dc.close(); } catch(e){} }
      });
      pendingDcs.clear();

      call.answer(localStream || new MediaStream());
      call.on('stream', (rs) => { gotStream = true; onRemoteStream(rs); });
      call.on('close', () => {
        if (gotStream) {
          onDisconnected('partner left');
        } else {
          // Handshake never completed (caller gave up) — keep waiting on this slot
          call = null;
          if (conn) { try { conn.close(); } catch(e){} conn = null; }
        }
      });
      call.on('error', (e) => console.warn('Call error:', e));
    });

    // Waiter: data channel (callers also use it to detect we're busy)
    peer.on('connection', (dc) => {
      // Our matched partner's channel can arrive after their call — always accept it
      if (call && dc.peer === call.peer) {
        conn = dc;
        dc.on('data', onDataReceived);
        return;
      }
      if (AppState.connected || call) {
        dc.on('open', () => {
          try { dc.send({ type: 'busy' }); } catch(e){}
          setTimeout(() => { try { dc.close(); } catch(e){} }, 500);
        });
        return;
      }
      pendingDcs.set(dc.peer, dc);
      conn = dc;
      dc.on('data', onDataReceived);
    });

    // If the signaling server drops us while waiting, reconnect so the slot stays live
    const thisPeer = peer;
    peer.on('disconnected', () => {
      if (gen !== searchGen || AppState.connected || thisPeer !== peer) return;
      try { thisPeer.reconnect(); } catch(e){}
    });
  }

  function callWaiter(waitId, slotIdx, gen) {
    const myId = `spark-caller-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    peer = new Peer(myId, { debug: 0, config: ICE_CONFIG });

    let gotStream = false;
    let settled = false;
    let timer = null;

    const giveUp = (why) => {
      if (settled || gotStream || gen !== searchGen) return;
      settled = true;
      clearTimeout(timer);
      console.log(`Slot ${waitId} ${why} — trying next slot`);
      try { peer.destroy(); } catch(e){}
      call = null; conn = null;
      searchSlot(slotIdx + 1, gen);
    };

    peer.on('open', () => {
      if (gen !== searchGen) return;
      console.log('Slot taken — calling waiter:', waitId);

      conn = peer.connect(waitId);
      conn.on('data', (d) => {
        if (d && d.type === 'busy') { giveUp('is busy'); return; }
        onDataReceived(d);
      });

      call = peer.call(waitId, localStream || new MediaStream());
      timer = setTimeout(() => giveUp('timed out'), CALL_TIMEOUT_MS);
      call.on('stream', (rs) => {
        gotStream = true;
        clearTimeout(timer);
        console.log('Matched!');
        onRemoteStream(rs);
      });
      call.on('close', () => { gotStream ? onDisconnected('partner left') : giveUp('rejected the call'); });
      call.on('error', () => giveUp('call errored'));
    });

    peer.on('error', (err) => {
      if (gotStream) { console.warn('Caller peer error:', err.type); return; }
      // peer-unavailable = waiter left between our claim attempt and the call
      giveUp(err.type || 'peer error');
    });
  }

  function onDataReceived(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'transcript' && typeof data.text === 'string' && data.text.trim()) {
      // Partner's speech transcription — silent, feeds the coach only
      addTranscriptLine('them', data.text.slice(0, 500));
      GeminiCoach.showTyping(false);
      GeminiCoach.triggerAnalysis(AppState.transcript);
    }
    if (data.type === 'profile') {
      const p = Profile.sanitize(data.profile || {});
      if (JSON.stringify(p) !== JSON.stringify(partnerProfile)) {
        partnerProfile = p;
        showPartnerProfile(p);
      }
    }
    if (data.type === 'chat' && typeof data.text === 'string' && data.text.trim()) {
      const text = data.text.slice(0, 500);
      addChatBubble('them', text);
      addTranscriptLine('them', text); // silent — feeds the coach
      GeminiCoach.triggerAnalysis(AppState.transcript);
    }
    if (data.type === 'music') {
      MusicSync.setPartnerTrack(data.track || null);
      // On mobile the music card lives in the closed sheet — show a dot on the toggle
      const st = $('sidebarToggle');
      if (st && !$('sidebar').classList.contains('open')) st.classList.add('notify');
    }
    if (data.type === 'music-sync') {
      MusicSync.applySync(data);
    }
    if (data.type === 'watch') {
      WatchSync.setPartnerVideo(data.track || null);
    }
    if (data.type === 'watch-sync') {
      WatchSync.applySync(data);
    }
  }

  // ── Remote stream received ──
  function onRemoteStream(remoteStream) {
    els.remoteVideo.srcObject = remoteStream;
    els.remoteVideo.play().catch(() => {});

    // Fire onConnected as soon as possible — loadedmetadata is unreliable
    // on some browsers/stream types, so use a 1.5s fallback too.
    let connected = false;
    const doConnect = () => { if (!connected) { connected = true; onConnected(); } };
    els.remoteVideo.addEventListener('loadedmetadata', doConnect, { once: true });
    setTimeout(doConnect, 1500);

    // Defer AudioContext creation to avoid blocking video rendering on connect
    setTimeout(() => SpeechManager.startPartner(remoteStream), 1000);
  }

  // ── Connected ──
  function onConnected() {
    if (AppState.connected) return; // 'stream' can fire more than once
    AppState.connected = true;
    AppState.transcript = [];
    GeminiCoach.resetTopics();

    els.remoteOverlay.style.display = 'none';
    els.strangerLabel.style.display = 'block';

    els.connectedFlash.classList.add('show');
    setTimeout(() => els.connectedFlash.classList.remove('show'), 700);

    setStatus('live');
    startTimer();

    // Enable input
    els.youInput.disabled   = false;
    els.youSendBtn.disabled = false;
    els.youMicBtn.disabled  = false;
    els.youInput.placeholder = 'Type a message…';
    const chatLog = $('chatLog');
    if (chatLog) chatLog.innerHTML = '';

    els.transcriptIndicator.classList.add('live');
    els.transcriptContainer.innerHTML = '<div class="transcript-empty" id="txEmpty">conversation started — start talking!</div>';

    if (SpeechManager.isSupported()) {
      setTimeout(() => { SpeechManager.startYours(); }, 600);
      els.speechStatus.textContent = '● auto-transcribing';
    }

    GeminiCoach.startPeriodic(AppState.transcript, 16000);
    GeminiCoach.showCoachUI();
    if (els.moodNote) els.moodNote.textContent = 'live analysis running...';

    // Send our profile — retry a few times since the data channel may open late
    const sendProfile = () => {
      if (conn?.open && myProfile) try { conn.send({ type: 'profile', profile: myProfile }); } catch(e){}
    };
    [300, 1200, 3000].forEach(ms => setTimeout(sendProfile, ms));

    // Music — wire up callbacks so track shares and sync events reach the partner
    MusicSync.setOnShare((track) => {
      if (conn?.open) try { conn.send({ type: 'music', track }); } catch(e){}
    });
    MusicSync.setOnSyncSend((payload) => {
      if (conn?.open) try { conn.send({ type: 'music-sync', ...payload }); } catch(e){}
    });
    WatchSync.setOnShare((track) => {
      if (conn?.open) try { conn.send({ type: 'watch', track }); } catch(e){}
    });
    WatchSync.setOnSyncSend((payload) => {
      if (conn?.open) try { conn.send({ type: 'watch-sync', ...payload }); } catch(e){}
    });
  }

  // ── Disconnected ──
  function onDisconnected(reason) {
    // Ignore stray close events after teardown (closing our own call echoes 'close')
    if (!AppState.connected && !peer && !call && !conn) return;
    searchGen++; // cancel any pending slot-search retries
    AppState.connected = false;
    GeminiCoach.stopPeriodic();
    SpeechManager.stopAll();
    stopTimer();
    setStatus('ready');

    if (call)  { try { call.close();  } catch(e){} call = null; }
    if (conn)  { try { conn.close();  } catch(e){} conn = null; }
    if (peer)  { try { peer.destroy(); } catch(e){} peer = null; }

    els.remoteVideo.srcObject = null;
    els.remoteOverlay.style.display = 'flex';
    const chatLogEl = $('chatLog');
    if (chatLogEl) chatLogEl.innerHTML = '';
    els.waitingTitle.textContent = reason || 'Disconnected';
    els.waitingSub.textContent   = '';
    els.strangerLabel.style.display = 'none';
    els.strangerLabel.textContent = 'Partner';
    partnerProfile = null;
    clearTimeout(introTimer);
    const introEl = $('partnerIntro');
    if (introEl) introEl.style.display = 'none';

    // Show "Start New Chat" button
    let newChatBtn = $('newChatBtn');
    if (!newChatBtn) {
      newChatBtn = document.createElement('button');
      newChatBtn.id = 'newChatBtn';
      newChatBtn.className = 'btn-new-chat';
      newChatBtn.textContent = '🔁 Start New Chat';
      newChatBtn.addEventListener('click', startNewChat);
      els.remoteOverlay.querySelector('.waiting-state').appendChild(newChatBtn);
    }
    newChatBtn.style.display = 'inline-flex';

    els.youInput.disabled   = true;
    els.youSendBtn.disabled = true;
    els.youMicBtn.disabled  = true;
    els.speechStatus.textContent = '';
    els.transcriptIndicator.classList.remove('live');

    GeminiCoach.setScanning('session ended');
    GeminiCoach.showTyping(false);
    GeminiCoach.hideCoachUI();
    MusicSync.resetPartner();
    MusicSync.setOnShare(null);
    MusicSync.setOnSyncSend(null);
    WatchSync.resetPartner();
    WatchSync.setOnShare(null);
    WatchSync.setOnSyncSend(null);

    ['energy','curiosity','humor','depth'].forEach(k => {
      const b = $('mood-' + k), p = $('pct-' + k);
      if (b) b.style.width = '0%';
      if (p) p.textContent = '—';
    });
  }

  function startNewChat() {
    const newChatBtn = $('newChatBtn');
    if (newChatBtn) newChatBtn.style.display = 'none';

    AppState.transcript = [];
    GeminiCoach.resetTopics();
    GeminiCoach.setScanning('waiting to connect');

    els.waitingTitle.textContent = 'Finding a match…';
    els.waitingSub.textContent   = '';
    els.transcriptContainer.innerHTML = '<div class="transcript-empty">transcript appears when connected</div>';

    setStatus('searching');
    initPeer();
  }

  // Clean up peer connections when the tab is closed
  window.addEventListener('beforeunload', () => {
    if (call)  { try { call.close();  } catch(e){} }
    if (conn)  { try { conn.close();  } catch(e){} }
    if (peer)  { try { peer.destroy(); } catch(e){} }
  });

  // ── Speech ──
  function initSpeech() {
    SpeechManager.init((text) => {
      if (!AppState.connected) return;
      addTranscriptLine('you', text);
      GeminiCoach.triggerAnalysis(AppState.transcript);
    });
    if (!SpeechManager.isSupported()) {
      els.speechStatus.textContent = '(use Chrome for auto-transcription)';
      els.youMicBtn.style.display = 'none';
    }
  }

  // ── Controls ──
  function initControls() {
    els.endBtn.addEventListener('click', () => onDisconnected('you ended the chat'));

    els.muteBtn.addEventListener('click', () => {
      muted = !muted;
      localStream?.getAudioTracks().forEach(t => t.enabled = !muted);
      els.muteBtn.textContent = muted ? '🔇' : '🎤';
      els.muteBtn.classList.toggle('active', muted);
    });

    // Mic picker
    const micPickBtn  = $('micPickBtn');
    const micDropdown = $('micDropdown');

    micPickBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (micDropdown.classList.contains('open')) {
        micDropdown.classList.remove('open');
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');
      const currentId = localStream?.getAudioTracks()[0]?.getSettings()?.deviceId;
      micDropdown.innerHTML = mics.map(m => {
        const label = m.label || `Microphone ${mics.indexOf(m) + 1}`;
        const sel   = m.deviceId === currentId ? ' selected' : '';
        return `<div class="mic-option${sel}" data-id="${m.deviceId}">${label}</div>`;
      }).join('') || '<div class="mic-option" style="pointer-events:none;opacity:0.5">No microphones found</div>';
      micDropdown.classList.add('open');
    });

    micDropdown.addEventListener('click', async (e) => {
      const opt = e.target.closest('.mic-option');
      if (!opt || !opt.dataset.id) return;
      micDropdown.classList.remove('open');
      await switchMic(opt.dataset.id);
    });

    document.addEventListener('click', () => micDropdown.classList.remove('open'));
    micDropdown.addEventListener('click', e => e.stopPropagation());

    // Mobile bottom sheet (music + mood)
    const sidebarToggle = $('sidebarToggle');
    const sheetBackdrop = $('sheetBackdrop');
    if (sidebarToggle) sidebarToggle.addEventListener('click', () => {
      const open = els.sidebar.classList.toggle('open');
      sidebarToggle.classList.remove('notify');
      if (sheetBackdrop) sheetBackdrop.classList.toggle('show', open);
    });
    if (sheetBackdrop) sheetBackdrop.addEventListener('click', () => {
      els.sidebar.classList.remove('open');
      sheetBackdrop.classList.remove('show');
    });

    els.camBtn.addEventListener('click', () => {
      camOff = !camOff;
      localStream?.getVideoTracks().forEach(t => t.enabled = !camOff);
      els.camBtn.textContent = camOff ? '📵' : '📷';
      els.camBtn.classList.toggle('active', camOff);
      els.localOverlay.style.display = camOff ? 'flex' : 'none';
    });

    els.youSendBtn.addEventListener('click', submitYours);
    els.youInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitYours(); });

    els.youMicBtn.addEventListener('mousedown',  startPTT);
    els.youMicBtn.addEventListener('touchstart', startPTT, { passive: true });
    els.youMicBtn.addEventListener('mouseup',    endPTT);
    els.youMicBtn.addEventListener('touchend',   endPTT);
  }

  async function switchMic(deviceId) {
    if (!localStream) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } }, video: false });
      const newTrack  = newStream.getAudioTracks()[0];
      const oldTrack  = localStream.getAudioTracks()[0];
      if (oldTrack) { oldTrack.stop(); localStream.removeTrack(oldTrack); }
      localStream.addTrack(newTrack);
      newTrack.enabled = !muted; // keep mute state across mic switches
      activeMicId = deviceId;
      // Hot-swap in active call without renegotiation
      if (call?.peerConnection) {
        const sender = call.peerConnection.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) sender.replaceTrack(newTrack);
      }
    } catch (e) {
      console.warn('Mic switch failed:', e);
    }
  }

  function submitYours() {
    const text = els.youInput.value.trim();
    if (!text || !AppState.connected) return;
    els.youInput.value = '';
    addChatBubble('you', text);
    addTranscriptLine('you', text); // silent — feeds the coach
    if (conn?.open) conn.send({ type: 'chat', text });
    GeminiCoach.triggerAnalysis(AppState.transcript);
  }

  // ── Partner profile display ──
  function showPartnerProfile(p) {
    const name = p.name || 'Stranger';
    els.strangerLabel.textContent = `${p.avatar} ${name}`;
    const intro = $('partnerIntro');
    if (intro) {
      $('piAvatar').textContent = p.avatar;
      $('piName').textContent = `You're chatting with ${name}`;
      const bio = $('piBio');
      bio.textContent = p.bio || '';
      bio.style.display = p.bio ? 'block' : 'none';
      intro.style.display = 'flex';
      clearTimeout(introTimer);
      introTimer = setTimeout(() => { intro.style.display = 'none'; }, 7000);
    }
  }

  // ── Chat bubbles over the partner video ──
  function addChatBubble(who, text) {
    const log = $('chatLog');
    if (!log) return;
    const b = document.createElement('div');
    b.className = 'chat-bubble ' + (who === 'you' ? 'you' : 'them');
    b.textContent = text; // textContent — no HTML injection
    log.appendChild(b);
    while (log.children.length > 8) log.removeChild(log.firstChild);
  }

  let pttActive = false;
  async function startPTT() {
    if (!AppState.connected || pttActive) return;
    pttActive = true;
    els.youMicBtn.classList.add('recording');
    els.speechStatus.textContent = '● listening...';
    const text = await SpeechManager.pushToTalk();
    pttActive = false;
    els.youMicBtn.classList.remove('recording');
    els.speechStatus.textContent = SpeechManager.isSupported() ? '● auto-transcribing' : '';
    if (text && AppState.connected) {
      addChatBubble('you', text);
      addTranscriptLine('you', text); // silent — feeds the coach
      if (conn?.open) conn.send({ type: 'chat', text });
      GeminiCoach.triggerAnalysis(AppState.transcript);
    }
  }
  function endPTT() { pttActive = false; els.youMicBtn.classList.remove('recording'); }

  // ── Transcript ──
  function addTranscriptLine(who, text) {
    AppState.transcript.push({ who, text, ts: Date.now() });
    // Cap in-memory transcript to avoid unbounded growth
    if (AppState.transcript.length > 50) AppState.transcript.splice(0, 10);
    const empty = $('txEmpty');
    if (empty) empty.remove();
    const line = document.createElement('div');
    line.className = 'transcript-line';
    line.innerHTML = `<span class="transcript-who ${who}">${who === 'you' ? 'You' : 'Them'}</span><span class="transcript-text">${esc(text)}</span>`;
    els.transcriptContainer.appendChild(line);
    els.transcriptContainer.scrollTop = els.transcriptContainer.scrollHeight;
    while (els.transcriptContainer.children.length > 30) {
      els.transcriptContainer.removeChild(els.transcriptContainer.firstChild);
    }
  }

  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Status / timer ──
  function setStatus(s) {
    const map = { ready:{ cls:'', text:'ready' }, searching:{ cls:'searching', text:'searching...' }, live:{ cls:'live', text:'live' } };
    const v = map[s] || { cls:'', text:s };
    els.statusDot.className = 'status-dot' + (v.cls ? ' ' + v.cls : '');
    els.statusText.textContent = v.text;
  }

  function startTimer() {
    sessionStart = Date.now();
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const e = Math.floor((Date.now() - sessionStart) / 1000);
      els.sessionTimer.textContent = `${String(Math.floor(e/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    els.sessionTimer.textContent = '00:00';
  }
})();
