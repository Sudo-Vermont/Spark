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
  let localStream = null;
  let timerInterval = null;
  let sessionStart = null;
  let muted = false;
  let camOff = false;
  let activeMicId = null;

  // Matchmaking slot IDs — try each in random order so load spreads across slots
  const SLOTS = 8;
  function slotId(n) { return `spark-match-waiting-${n}`; }
  function shuffledSlots() {
    const arr = Array.from({ length: SLOTS }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ── API key — localStorage with fallback to config.js ──
  function getApiKey() {
    return (typeof SPARK_CONFIG !== 'undefined' ? SPARK_CONFIG.groqApiKey : null) || null;
  }

  function saveApiKey(key) {
    localStorage.removeItem('spark_gemini_key'); // clear old Gemini key if any
    localStorage.setItem('spark_groq_key', key);
  }

  // ── Start / setup ──
  els.startBtn.addEventListener('click', async () => {
    // Camera + mic — try video+audio, fall back to audio-only
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      els.localVideo.srcObject = localStream;
      els.localVideo.addEventListener('loadedmetadata', () => {
        els.localOverlay.style.display = 'none';
      }, { once: true });
    } catch (e) {
      console.warn('Camera+mic failed:', e.message);
      // Try audio-only fallback
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        els.localOverlay.querySelector('.video-placeholder-text').textContent = 'camera unavailable';
      } catch (e2) {
        console.warn('Audio also failed:', e2.message);
        // Show user-friendly message but keep going (they can still connect)
        els.localOverlay.querySelector('.video-placeholder-text').textContent = 'no camera or mic found';
        els.startBtn.textContent = '⚠️ Check camera permissions in browser settings, then try again';
      }
    }

    // API key — optional, coaching silently disabled if missing
    let apiKey = getApiKey();
    if (!apiKey) {
      apiKey = prompt('Enter your Groq API key to enable AI coaching:\n(Get one free at https://console.groq.com → API Keys)\n\nLeave blank to skip coaching.');
      if (apiKey && apiKey.trim()) {
        apiKey = apiKey.trim();
        saveApiKey(apiKey);
      } else {
        apiKey = null;
      }
    }
    if (apiKey) GeminiCoach.setKey(apiKey);

    // Hide setup, show app
    els.setupScreen.classList.add('fade-out');
    setTimeout(() => els.setupScreen.style.display = 'none', 400);
    els.videoArea.style.display = 'flex';
    els.sidebar.style.display   = 'flex';

    // Init modules
    GeminiCoach.init();
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

  // ── PeerJS — random matchmaking ──
  // Strategy: try to claim one of N "waiting" slots.
  // If a slot is free → register and wait for a caller (waiter role).
  // If a slot is taken → that person is waiting; call them (caller role).
  function initPeer() {
    trySlots(shuffledSlots(), 0);
  }

  function trySlots(slots, idx) {
    if (idx >= slots.length) {
      // All slots busy — retry after a short pause
      setTimeout(() => trySlots(shuffledSlots(), 0), 2000);
      return;
    }
    const waitId = slotId(slots[idx]);
    const myId   = `spark-caller-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    peer = new Peer(waitId, { debug: 0, config: ICE_CONFIG });

    peer.on('open', () => {
      console.log('Waiting on slot:', waitId);
      // We are now the waiter — sit and listen for an incoming call
    });

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        // Slot taken — someone is waiting there; call them
        peer.destroy();
        callWaiter(waitId, myId);
      } else {
        console.warn('PeerJS error:', err);
        peer.destroy();
        trySlots(slots, idx + 1);
      }
    });

    // Waiter: incoming call
    peer.on('call', (incomingCall) => {
      console.log('Matched! Incoming call from caller');
      call = incomingCall;
      call.answer(localStream || new MediaStream());
      call.on('stream', onRemoteStream);
      call.on('close', () => onDisconnected('partner left'));
      call.on('error', (e) => console.warn('Call error:', e));
    });

    // Waiter: data channel
    peer.on('connection', (dc) => {
      conn = dc;
      dc.on('data', onDataReceived);
    });
  }

  function callWaiter(waitId, myId) {
    peer = new Peer(myId, { debug: 1 });

    peer.on('open', () => {
      console.log('Matched! Calling waiter:', waitId);

      conn = peer.connect(waitId);
      conn.on('open', () => console.log('Data channel open'));
      conn.on('data', onDataReceived);

      call = peer.call(waitId, localStream || new MediaStream());
      call.on('stream', onRemoteStream);
      call.on('close', () => onDisconnected('partner left'));
      call.on('error', (e) => console.warn('Call error:', e));
    });

    peer.on('error', (err) => {
      console.warn('Caller peer error:', err);
      // Waiter may have left — retry from scratch
      peer.destroy();
      setTimeout(() => trySlots(shuffledSlots(), 0), 1500);
    });
  }

  function onDataReceived(data) {
    if (data.type === 'transcript') {
      addTranscriptLine('them', data.text);
      GeminiCoach.showTyping(false);
      GeminiCoach.triggerAnalysis(AppState.transcript);
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
    els.youInput.placeholder = 'Type what you said and press Enter...';

    els.transcriptIndicator.classList.add('live');
    els.transcriptContainer.innerHTML = '<div class="transcript-empty" id="txEmpty">conversation started — start talking!</div>';

    if (SpeechManager.isSupported()) {
      setTimeout(() => { SpeechManager.startYours(); }, 600);
      els.speechStatus.textContent = '● auto-transcribing';
    }

    GeminiCoach.startPeriodic(AppState.transcript, 16000);
    GeminiCoach.showCoachUI();
    if (els.moodNote) els.moodNote.textContent = 'live analysis running...';
  }

  // ── Disconnected ──
  function onDisconnected(reason) {
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
    els.waitingTitle.textContent = reason || 'Disconnected';
    els.waitingSub.textContent   = '';
    els.strangerLabel.style.display = 'none';

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
      if (!muted) newTrack.enabled = true;
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
    addTranscriptLine('you', text);
    // Relay to partner via data channel
    if (conn?.open) conn.send({ type: 'transcript', text });
    GeminiCoach.triggerAnalysis(AppState.transcript);
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
      addTranscriptLine('you', text);
      if (conn?.open) conn.send({ type: 'transcript', text });
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
