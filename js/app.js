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

  // ── Start / setup ──
  els.startBtn.addEventListener('click', async () => {
    // Load API key from config.js
    const apiKey = (typeof SPARK_CONFIG !== 'undefined') ? SPARK_CONFIG.geminiApiKey : null;
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
      alert('Please add your Gemini API key to js/config.js');
      return;
    }

    GeminiCoach.setKey(apiKey);

    // Get camera + mic
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      els.localVideo.srcObject = localStream;
      els.localVideo.addEventListener('loadedmetadata', () => {
        els.localOverlay.style.display = 'none';
      }, { once: true });
    } catch (e) {
      console.warn('Camera denied:', e.message);
    }

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

    peer = new Peer(waitId, { debug: 1 });

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
      GeminiCoach.triggerAnalysis(AppState.transcript, els.remoteVideo);
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

    SpeechManager.startPartner(remoteStream);
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
      SpeechManager.startYours();
      els.speechStatus.textContent = '● auto-transcribing';
    }

    GeminiCoach.startPeriodic(AppState.transcript, els.remoteVideo, 14000);
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
    els.waitingSub.textContent   = 'Reload the page to find a new match';
    els.strangerLabel.style.display = 'none';

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

  // ── Speech ──
  function initSpeech() {
    SpeechManager.init(
      (text) => {
        if (!AppState.connected) return;
        addTranscriptLine('you', text);
        GeminiCoach.triggerAnalysis(AppState.transcript, els.remoteVideo);
      },
      (text) => {
        if (!AppState.connected) return;
        GeminiCoach.showTyping(false);
        addTranscriptLine('them', text);
        GeminiCoach.triggerAnalysis(AppState.transcript, els.remoteVideo);
      }
    );
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

  function submitYours() {
    const text = els.youInput.value.trim();
    if (!text || !AppState.connected) return;
    els.youInput.value = '';
    addTranscriptLine('you', text);
    // Relay to partner via data channel
    if (conn?.open) conn.send({ type: 'transcript', text });
    GeminiCoach.triggerAnalysis(AppState.transcript, els.remoteVideo);
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
      GeminiCoach.triggerAnalysis(AppState.transcript, els.remoteVideo);
    }
  }
  function endPTT() { pttActive = false; els.youMicBtn.classList.remove('recording'); }

  // ── Transcript ──
  function addTranscriptLine(who, text) {
    AppState.transcript.push({ who, text, ts: Date.now() });
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
