// coach.js — 100% local coaching: face mesh math + keyword analysis (no API, no tokens)

const GeminiCoach = (() => {
  let analysisTimer = null;
  let detectedTopics = new Set();
  let coachVisible   = false;
  let faceReady      = false;

  const $ = id => document.getElementById(id);

  // ── Keyword maps ──
  const TOPIC_MAP = {
    'music 🎵':    ['music','song','songs','artist','band','concert','playlist','spotify','album','genre','rap','pop','rock','jazz'],
    'movies 🎬':   ['movie','movies','film','films','watch','netflix','cinema','series','show','episode','actor','director','hbo','disney'],
    'travel ✈️':   ['travel','country','city','trip','vacation','flight','visit','abroad','europe','asia','beach','hotel','passport'],
    'food 🍕':     ['food','eat','eating','restaurant','cook','cooking','meal','dinner','lunch','breakfast','pizza','sushi','recipe'],
    'sports ⚽':   ['sport','sports','game','team','play','football','basketball','soccer','nfl','nba','workout','gym','fitness'],
    'tech 💻':     ['tech','technology','computer','phone','app','code','coding','software','ai','startup','developer','programming'],
    'school 📚':   ['school','college','university','study','class','homework','exam','degree','major','grade','campus','professor'],
    'gaming 🎮':   ['game','games','gaming','xbox','playstation','pc','minecraft','roblox','fortnite','stream','twitch','esports'],
    'art 🎨':      ['art','drawing','painting','design','creative','photography','fashion','style','aesthetic'],
    'career 💼':   ['work','job','career','internship','salary','business','money','startup','entrepreneur','interview'],
    'family 👨‍👩‍👧':  ['family','parents','mom','dad','sister','brother','home','house','kids','children','relationship'],
  };

  const POSITIVE_WORDS = new Set(['good','great','love','like','awesome','cool','nice','happy','fun','excited','amazing','wow','yes','totally','definitely','sure','agree','interesting','funny','haha','lol','lmao','enjoying']);
  const NEGATIVE_WORDS = new Set(['bad','hate','boring','sad','angry','tired','upset','annoying','no','nope','ugh','whatever','idk','dunno','eh']);

  // Rule-based conversation tips
  const TIPS_QUIET    = ['Break the silence — ask them about their day!', 'Try asking an open-ended question to get things going.', 'Start with something light: "What have you been up to lately?"'];
  const TIPS_BALANCE  = ['You\'re doing most of the talking — give them space to share too.', 'Ask a question and then really listen to the answer.'];
  const TIPS_LISTEN   = ['Great — you\'re letting them talk! Add your own take to keep it balanced.', 'Share something about yourself to connect better.'];
  const TIPS_GOING    = ['Good energy! Build on what they just said.', 'Nice flow — try going deeper on the current topic.', 'You\'re vibing! Ask a "why" question to get more insight.'];
  const TIPS_POSITIVE = ['The mood is positive — great time to be a bit more playful!', 'Things are going well — keep the energy up!'];
  const TIPS_TOPIC    = (t) => [`You\'re talking about ${t} — ask something more specific to go deeper.`, `Dig into ${t} more — what\'s their personal experience with it?`];

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ── Public API (same shape as before so app.js needs no changes) ──
  function setKey() {} // no-op, kept for compatibility

  function init() {
    FaceAnalyzer.init();
    faceReady = true;

    $('coachClose').addEventListener('click', hidePanel);
    $('coachToggle').addEventListener('click', showPanel);
    $('coachRefresh').addEventListener('click', () => {
      if (window.AppState) runAnalysis(AppState.transcript);
    });
    $('analyzeNowBtn').addEventListener('click', () => {
      if (window.AppState) runAnalysis(AppState.transcript);
    });
  }

  function showPanel() {
    coachVisible = true;
    $('coachPanel').classList.remove('hidden');
    $('coachToggle').style.display = 'none';
  }

  function hidePanel() {
    coachVisible = false;
    $('coachPanel').classList.add('hidden');
    $('coachToggle').style.display = 'flex';
  }

  function showCoachUI() { $('coachToggle').style.display = 'flex'; showPanel(); }
  function hideCoachUI() { $('coachPanel').classList.add('hidden'); $('coachToggle').style.display = 'none'; }

  function startPeriodic(transcriptRef) {
    stopPeriodic();
    setTimeout(() => runAnalysis(transcriptRef), 3000);
    analysisTimer = setInterval(() => runAnalysis(transcriptRef), 8000);
  }

  function stopPeriodic() {
    if (analysisTimer) { clearInterval(analysisTimer); analysisTimer = null; }
  }

  // ── Core analysis ──
  async function runAnalysis(transcript) {
    analyzeTranscript(transcript);
    await analyzeFace();
    await analyzePartnerFace();
  }

  function analyzeTranscript(transcript) {
    const msgs = transcript || [];
    const hintEl = $('coachHint');

    if (msgs.length === 0) {
      if (hintEl) hintEl.textContent = 'Say something to get started!';
      return;
    }

    // Count speaker balance
    const youCount  = msgs.filter(m => m.who === 'you').length;
    const themCount = msgs.filter(m => m.who === 'them').length;
    const total     = youCount + themCount;

    // Sentiment from last 8 messages
    const recentText = msgs.slice(-8).map(m => m.text.toLowerCase()).join(' ');
    const words = recentText.split(/\W+/);
    let pos = 0, neg = 0;
    words.forEach(w => { if (POSITIVE_WORDS.has(w)) pos++; if (NEGATIVE_WORDS.has(w)) neg++; });
    const sentiment = pos > neg * 1.5 ? 'positive' : neg > pos * 1.5 ? 'negative' : 'neutral';

    // Topic detection
    const allText = msgs.map(m => m.text.toLowerCase()).join(' ');
    const foundTopics = [];
    for (const [label, keywords] of Object.entries(TOPIC_MAP)) {
      if (keywords.some(k => allText.includes(k))) foundTopics.push(label);
    }
    foundTopics.forEach(t => detectedTopics.add(t));
    renderTopics();
    updateTopicBtns(foundTopics);

    // Pick conversation tip
    let tip;
    if (total < 3)                          tip = pick(TIPS_QUIET);
    else if (youCount > themCount * 2.5)    tip = pick(TIPS_BALANCE);
    else if (themCount > youCount * 2.5)    tip = pick(TIPS_LISTEN);
    else if (sentiment === 'positive')      tip = pick(TIPS_POSITIVE);
    else if (foundTopics.length > 0)        tip = pick(TIPS_TOPIC(foundTopics[foundTopics.length - 1]));
    else                                    tip = pick(TIPS_GOING);

    if (hintEl) hintEl.textContent = tip;

    // Update sentiment in analysis bar
    const emoji = sentiment === 'positive' ? '😊' : sentiment === 'negative' ? '😕' : '😐';
    const lastMsg = msgs[msgs.length - 1];
    const snippet = lastMsg ? `${lastMsg.who === 'you' ? 'You' : 'Them'}: ${lastMsg.text}`.slice(0, 80) : '';

    const analysisEl = $('analysisContent');
    if (analysisEl) {
      analysisEl.innerHTML = `
        <div class="analysis-section">
          <div class="analysis-label">Sentiment</div>
          <div class="analysis-value"><span class="sentiment-pill ${sentiment}">${emoji} ${sentiment}</span></div>
        </div>
        <div class="analysis-divider"></div>
        <div class="analysis-section" style="flex:1;min-width:0">
          <div class="analysis-label">✦ local analysis</div>
          <div class="analysis-value live-text">${snippet}</div>
        </div>`;
    }

    // Update mood bars from message counts + sentiment
    const energy    = Math.min(100, Math.round((total / 20) * 100));
    const curiosity = Math.min(100, msgs.filter(m => m.text.includes('?')).length * 20);
    const humor     = Math.min(100, words.filter(w => ['haha','lol','lmao','funny','joke','hahaha'].includes(w)).length * 25);
    const depth     = Math.min(100, Math.round(msgs.reduce((s, m) => s + m.text.split(' ').length, 0) / Math.max(1, total) * 5));
    updateMoodBars({ energy, curiosity, humor, depth });

    // Update questions based on topics
    updateQuestions(foundTopics, sentiment);
  }

  async function analyzePartnerFace() {
    const videoEl = document.getElementById('remoteVideo');
    if (!faceReady || !videoEl) return;
    const m = await FaceAnalyzer.analyzeMood(videoEl);

    const emojiEl = $('partnerMoodEmoji');
    const labelEl = $('partnerMoodLabel');
    const confEl  = $('partnerMoodConf');

    if (!m) {
      if (emojiEl) emojiEl.textContent = '—';
      if (labelEl) labelEl.textContent = 'no face detected';
      if (confEl)  confEl.textContent  = '';
      setBar('fm-smile', 'fv-smile', 0);
      setBar('fm-alert', 'fv-alert', 0);
      return;
    }

    if (emojiEl) emojiEl.textContent = m.emoji;
    if (labelEl) labelEl.textContent = m.mood;
    if (confEl)  confEl.textContent  = m.confidence + '%';
    setBar('fm-smile', 'fv-smile', m.smileBar);
    setBar('fm-alert', 'fv-alert', m.alertness);
  }

  async function analyzeFace() {
    const videoEl = document.getElementById('localVideo');
    if (!faceReady || !videoEl) return;
    const m = await FaceAnalyzer.analyze(videoEl);

    const overall  = $('faceOverall');
    if (!m) {
      if (overall) overall.textContent = 'no face detected';
      ['symmetry','thirds','golden'].forEach(k => {
        const bar = $('fm-' + k), val = $('fv-' + k.replace('fm-',''));
        if (bar) bar.style.width = '0%';
      });
      $('fv-symmetry') && ($('fv-symmetry').textContent = '—');
      $('fv-thirds')   && ($('fv-thirds').textContent   = '—');
      $('fv-golden')   && ($('fv-golden').textContent   = '—');
      $('fv-canthal')  && ($('fv-canthal').textContent  = '—');
      return;
    }

    setBar('fm-symmetry', 'fv-symmetry', m.symmetryScore);
    setBar('fm-thirds',   'fv-thirds',   m.thirdsScore);
    setBar('fm-golden',   'fv-golden',   m.goldenScore);
    if ($('fv-canthal')) $('fv-canthal').textContent = m.canthalLabel;
    if (overall) overall.textContent = `Overall: ${m.overall}/100 — ${m.label}`;
  }

  function setBar(barId, valId, score) {
    const bar = $(barId), val = $(valId);
    if (bar) bar.style.width = score + '%';
    if (val) val.textContent = score + '%';
  }

  function updateMoodBars(scores) {
    Object.entries(scores).forEach(([k, v]) => {
      const bar = $('mood-' + k), pct = $('pct-' + k);
      if (bar) bar.style.width = v + '%';
      if (pct) pct.textContent = v + '%';
    });
    const note = $('moodNote');
    if (note) note.textContent = '✦ local analysis';
  }

  function updateTopicBtns(topics) {
    const el = $('coachTopics');
    if (!el) return;
    if (topics.length === 0) {
      el.innerHTML = '<span class="coach-topic-btn" style="opacity:0.4">none yet</span>';
    } else {
      el.innerHTML = topics.map(t => `<span class="coach-topic-btn">${t}</span>`).join('');
    }
  }

  const QUESTIONS_BY_TOPIC = {
    'music 🎵':  ['What artist have you been listening to nonstop?', 'Do you play any instruments?', 'What concert changed your life?'],
    'movies 🎬': ['What\'s the last great movie you watched?', 'Are you more into films or series?', 'What genre do you always go back to?'],
    'travel ✈️': ['What\'s the best place you\'ve ever visited?', 'Where do you want to go next?', 'Do you prefer cities or nature?'],
    'food 🍕':   ['What\'s your go-to comfort food?', 'Do you cook or prefer eating out?', 'Best meal you\'ve ever had?'],
    'gaming 🎮': ['What game are you addicted to right now?', 'Console, PC or mobile?', 'Do you prefer solo or multiplayer?'],
    'tech 💻':   ['What tech are you excited about lately?', 'Are you into coding?', 'What app do you use the most?'],
  };

  const DEFAULT_QUESTIONS = [
    'What\'s something you\'ve been really into lately?',
    'If you could travel anywhere right now, where?',
    'What\'s a show that changed how you think?',
  ];

  function updateQuestions(topics, sentiment) {
    const el = $('coachQuestions');
    if (!el) return;
    let questions = DEFAULT_QUESTIONS;
    for (const t of topics) {
      if (QUESTIONS_BY_TOPIC[t]) { questions = QUESTIONS_BY_TOPIC[t]; break; }
    }
    el.innerHTML = questions.map(q => `<div class="coach-question">${q}</div>`).join('');
  }

  function renderTopics() {
    const el = $('detectedTopics');
    if (!el || !detectedTopics.size) return;
    el.innerHTML = '';
    detectedTopics.forEach(t => {
      const s = document.createElement('span');
      s.className = 'topic-pill';
      s.textContent = t.split(' ')[0];
      el.appendChild(s);
    });
  }

  function resetTopics() {
    detectedTopics.clear();
    const el = $('detectedTopics');
    if (el) el.innerHTML = '<span class="topic-empty">none detected yet</span>';
    updateTopicBtns([]);
  }

  function setScanning(msg) {
    const el = $('analysisContent');
    if (!el) return;
    el.innerHTML = `<div class="analysis-scanning"><span>${msg || 'waiting to connect'}</span>${!msg ? '<div class="scan-dots"><span></span><span></span><span></span></div>' : ''}</div>`;
  }

  function showTyping(show) {
    const el = $('typingIndicator');
    if (el) el.classList.toggle('show', show);
  }

  // Compatibility shim — app.js calls triggerAnalysis(transcript)
  function triggerAnalysis(transcript) { runAnalysis(transcript); }

  return {
    setKey, init,
    showCoachUI, hideCoachUI, showPanel, hidePanel,
    startPeriodic, stopPeriodic,
    triggerAnalysis, setScanning, resetTopics, showTyping
  };
})();
