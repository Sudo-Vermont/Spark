// gemini.js — 100% local coaching: face mesh math + keyword analysis (no API, no tokens)

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

  // ── Public API (same shape as before so app.js needs no changes) ──
  function setKey() {} // no-op, kept for compatibility

  // const/let at top level don't attach to window, so check the binding itself
  function getTranscript() {
    return (typeof AppState !== 'undefined' && AppState.transcript) ? AppState.transcript : [];
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function init() {
    FaceAnalyzer.init();
    faceReady = true;

    $('coachClose').addEventListener('click', hidePanel);
    $('coachToggle').addEventListener('click', showPanel);
    $('coachRefresh').addEventListener('click', () => {
      const btn = $('coachRefresh');
      btn.classList.add('spinning');
      setTimeout(() => btn.classList.remove('spinning'), 900);
      runAnalysis(getTranscript());
      dealQuestions();
    });
    $('analyzeNowBtn').addEventListener('click', () => runAnalysis(getTranscript()));
    // Tapping a suggested question deals a fresh set
    $('coachQuestions').addEventListener('click', (e) => {
      if (e.target.closest('.coach-question')) dealQuestions();
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
  function hideCoachUI() {
    $('coachPanel').classList.add('hidden');
    $('coachToggle').style.display = 'none';
    resetPartnerMood();
  }

  function resetPartnerMood() {
    const e = $('partnerMoodEmoji'), l = $('partnerMoodLabel'), c = $('partnerMoodConf');
    if (e) e.textContent = '—';
    if (l) l.textContent = 'not connected';
    if (c) c.textContent = '';
    setBar('fm-smile', 'fv-smile', 0);
    setBar('fm-alert', 'fv-alert', 0);
  }

  function startPeriodic(transcriptRef, intervalMs = 8000) {
    stopPeriodic();
    // Read the transcript fresh each tick — AppState.transcript gets reassigned on reconnect
    setTimeout(() => runAnalysis(getTranscript()), 3000);
    analysisTimer = setInterval(() => runAnalysis(getTranscript()), intervalMs);
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
    if (msgs.length === 0) return;

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
          <div class="analysis-value live-text">${esc(snippet)}</div>
        </div>`;
    }

    // Update mood bars from message counts + sentiment
    const energy    = Math.min(100, Math.round((total / 20) * 100));
    const curiosity = Math.min(100, msgs.filter(m => m.text.includes('?')).length * 20);
    const humor     = Math.min(100, words.filter(w => ['haha','lol','lmao','funny','joke','hahaha'].includes(w)).length * 25);
    const depth     = Math.min(100, Math.round(msgs.reduce((s, m) => s + m.text.split(' ').length, 0) / Math.max(1, total) * 5));
    updateMoodBars({ energy, curiosity, humor, depth });

    // Re-deal questions only when detected topics change
    updateQuestions(foundTopics);
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
        const bar = $('fm-' + k);
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
    'music 🎵':  ['What artist have you been listening to nonstop?', 'Do you play any instruments?', 'What concert changed your life?', 'What song instantly puts you in a good mood?', 'Headphones or speakers person?', 'What\'s a guilty-pleasure song you secretly love?'],
    'movies 🎬': ['What\'s the last great movie you watched?', 'Are you more into films or series?', 'What genre do you always go back to?', 'What movie could you rewatch forever?', 'Cinema or couch?', 'What\'s a movie everyone loves but you don\'t get?'],
    'travel ✈️': ['What\'s the best place you\'ve ever visited?', 'Where do you want to go next?', 'Do you prefer cities or nature?', 'Window or aisle seat?', 'What\'s the weirdest food you tried abroad?', 'Solo travel or with friends?'],
    'food 🍕':   ['What\'s your go-to comfort food?', 'Do you cook or prefer eating out?', 'Best meal you\'ve ever had?', 'What food could you eat every day?', 'Sweet or savory?', 'What\'s a dish you wish you could make?'],
    'sports ⚽': ['Do you play any sports or just watch?', 'What team are you loyal to no matter what?', 'What\'s your gym routine like?', 'Best live game you\'ve ever been to?'],
    'gaming 🎮': ['What game are you addicted to right now?', 'Console, PC or mobile?', 'Do you prefer solo or multiplayer?', 'What game have you sunk the most hours into?', 'What game do you wish you could play again for the first time?'],
    'tech 💻':   ['What tech are you excited about lately?', 'Are you into coding?', 'What app do you use the most?', 'What gadget could you not live without?', 'What do you think about AI?'],
    'school 📚': ['What are you studying?', 'What subject do you actually enjoy?', 'What do you want to do after school?', 'Are you a last-minute crammer or a planner?'],
    'art 🎨':    ['Do you make any art yourself?', 'What\'s your creative outlet?', 'Where do you find inspiration?', 'Digital or traditional?'],
    'career 💼': ['What do you do for work?', 'What\'s your dream job?', 'Would you rather love your job or get paid more?', 'What\'s the best career advice you\'ve gotten?'],
    'family 👨‍👩‍👧': ['Do you have siblings?', 'Are you close with your family?', 'What\'s a family tradition you love?'],
  };

  const GENERAL_QUESTIONS = [
    'What\'s something you\'ve been really into lately?',
    'If you could travel anywhere right now, where?',
    'What\'s a show that changed how you think?',
    'What\'s the best thing that happened to you this week?',
    'Are you a morning person or a night owl?',
    'What\'s a skill you wish you had?',
    'What would you do with a free year and unlimited money?',
    'What\'s your most unpopular opinion?',
    'What\'s something that always makes you laugh?',
    'If you could have dinner with anyone, who?',
    'What\'s a small thing that instantly makes your day better?',
    'What were you obsessed with as a kid?',
  ];

  // Shuffled pool — deals 3 at a time, refills when it runs low
  let questionPool = [];
  let activeTopics = [];

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildPool() {
    let qs = [];
    activeTopics.forEach(t => { if (QUESTIONS_BY_TOPIC[t]) qs = qs.concat(QUESTIONS_BY_TOPIC[t]); });
    return shuffle(qs.concat(GENERAL_QUESTIONS));
  }

  function dealQuestions() {
    if (questionPool.length < 3) questionPool = buildPool();
    const qs = questionPool.splice(0, 3);
    const el = $('coachQuestions');
    if (el) el.innerHTML = qs.map(q => `<div class="coach-question">${q}</div>`).join('');
  }

  function updateQuestions(topics) {
    const key = topics.join('|');
    if (key === activeTopics.join('|')) return; // keep current set until topics change
    activeTopics = topics;
    questionPool = buildPool();
    dealQuestions();
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
