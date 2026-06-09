// gemini.js — calls Google Gemini API directly from the browser
// Uses gemini-2.0-flash (fast, cheap, supports vision)
// API key is stored only in memory (never persisted)

const GeminiCoach = (() => {
  let apiKey = null;
  let analysisTimer = null;
  let busy = false;
  let detectedTopics = new Set();
  let coachVisible = false;

  // DOM refs
  const $ = id => document.getElementById(id);

  function setKey(key) { apiKey = key; }

  function init() {
    $('coachClose').addEventListener('click', hidePanel);
    $('coachToggle').addEventListener('click', showPanel);
    $('coachRefresh').addEventListener('click', () => {
      if (window.AppState) triggerAnalysis(AppState.transcript, AppState.remoteVideoEl);
    });
    $('analyzeNowBtn').addEventListener('click', () => {
      if (window.AppState) triggerAnalysis(AppState.transcript, AppState.remoteVideoEl);
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

  function showCoachUI() {
    $('coachToggle').style.display = 'flex';
    showPanel();
  }

  function hideCoachUI() {
    $('coachPanel').classList.add('hidden');
    $('coachToggle').style.display = 'none';
  }

  function startPeriodic(transcriptRef, remoteVideoElRef, ms = 14000) {
    stopPeriodic();
    setTimeout(() => triggerAnalysis(transcriptRef, remoteVideoElRef), 4000);
    analysisTimer = setInterval(() => triggerAnalysis(transcriptRef, remoteVideoElRef), ms);
  }

  function stopPeriodic() {
    if (analysisTimer) { clearInterval(analysisTimer); analysisTimer = null; }
    busy = false;
  }

  // Capture a JPEG frame from a video element → base64
  function captureFrame(videoEl, quality = 0.65) {
    if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) return null;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 480 / videoEl.videoWidth);
    canvas.width  = Math.round(videoEl.videoWidth  * scale);
    canvas.height = Math.round(videoEl.videoHeight * scale);
    canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality).split(',')[1];
  }

  async function triggerAnalysis(transcript, remoteVideoEl) {
    if (busy || !apiKey) return;
    busy = true;

    const hintEl = $('coachHint');
    const refreshBtn = $('coachRefresh');
    if (hintEl) hintEl.classList.add('loading');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    // Build Gemini request parts
    const parts = [];

    // Video frame (local video of YOU so Gemini can see your expressions too,
    // plus remote if available)
    const localFrame  = captureFrame(document.getElementById('localVideo'));
    const remoteFrame = captureFrame(remoteVideoEl);

    if (remoteFrame) {
      parts.push({ text: "This is the live video frame of the person you're chatting with:" });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: remoteFrame } });
    }
    if (localFrame) {
      parts.push({ text: "This is your own live video frame (how you look right now):" });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: localFrame } });
    }

    const lines = (transcript || []).slice(-10)
      .map(l => `${l.who === 'you' ? 'Me' : 'Partner'}: ${l.text}`)
      .join('\n') || '(no transcript yet — conversation just started)';

    parts.push({ text: `
You are a real-time conversation coach whispering advice to help someone have a better video chat.

Recent transcript:
${lines}

${remoteFrame ? 'Analyze the video frames AND the transcript to give coaching advice.' : 'Analyze the transcript to give coaching advice.'}

Rules:
- Give coaching SUGGESTIONS only — never write lines for the user to say verbatim
- Be warm, specific, and brief
- Base advice on what you actually see/hear, not generic tips

Respond ONLY with valid JSON, no markdown, no code fences:
{
  "hint": "one specific coaching tip — what to notice, what angle to take, how to react (max 2 sentences)",
  "sentiment": "positive" or "neutral" or "negative",
  "energy": <0-100>,
  "curiosity": <0-100>,
  "humor": <0-100>,
  "depth": <0-100>,
  "topics": ["2-4 short topic labels from the conversation"],
  "questions": ["3 natural questions the user could ask next"],
  "suggestedTopics": ["3-4 topic directions worth exploring"]
}` });

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }] })
        }
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const clean = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      applyResult(parsed, !!remoteFrame);
    } catch (e) {
      console.warn('Gemini error:', e.message);
      // Show error in hint briefly
      if (hintEl) hintEl.textContent = `Analysis error: ${e.message}. Check your API key.`;
    } finally {
      if (hintEl) hintEl.classList.remove('loading');
      if (refreshBtn) refreshBtn.classList.remove('spinning');
      busy = false;
    }
  }

  function applyResult(d, hadFrame) {
    // Coach hint
    const hintEl = $('coachHint');
    if (hintEl && d.hint) hintEl.textContent = d.hint;

    // Topics
    if (d.suggestedTopics?.length) {
      $('coachTopics').innerHTML = d.suggestedTopics.map(t => `<span class="coach-topic-btn">${t}</span>`).join('');
    }

    // Questions
    if (d.questions?.length) {
      $('coachQuestions').innerHTML = d.questions.map(q => `<div class="coach-question">${q}</div>`).join('');
    }

    // Analysis bar
    const sent = d.sentiment || 'neutral';
    const emoji = sent === 'positive' ? '😊' : sent === 'negative' ? '😕' : '😐';
    const snippet = (d.hint || 'Analyzing...').slice(0, 90) + ((d.hint?.length || 0) > 90 ? '…' : '');
    const topicTags = (d.topics || []).slice(0, 3).map(t => `<span class="topic-tag">${t}</span>`).join('');

    $('analysisContent').innerHTML = `
      <div class="analysis-section">
        <div class="analysis-label">Sentiment</div>
        <div class="analysis-value"><span class="sentiment-pill ${sent}">${emoji} ${sent}</span></div>
      </div>
      <div class="analysis-divider"></div>
      <div class="analysis-section" style="flex:1;min-width:0">
        <div class="analysis-label">${hadFrame ? '✦ video + transcript' : '✦ transcript'}</div>
        <div class="analysis-value live-text">${snippet}</div>
      </div>
      ${topicTags ? `<div class="analysis-divider"></div><div class="analysis-section"><div class="analysis-label">Topics</div><div class="topic-tags">${topicTags}</div></div>` : ''}`;

    // Mood bars
    const moods = { energy: d.energy, curiosity: d.curiosity, humor: d.humor, depth: d.depth };
    Object.entries(moods).forEach(([k, v]) => {
      if (typeof v !== 'number') return;
      const val = Math.min(100, Math.max(0, Math.round(v)));
      const bar = $('mood-' + k);
      const pct = $('pct-' + k);
      if (bar) bar.style.width = val + '%';
      if (pct) pct.textContent = val + '%';
    });
    const note = $('moodNote');
    if (note) note.textContent = hadFrame ? '✦ video + transcript analyzed' : '✦ transcript analyzed';

    // Topics sidebar
    if (d.topics?.length) {
      d.topics.forEach(t => detectedTopics.add(t));
      renderTopics();
    }
  }

  function renderTopics() {
    const el = $('detectedTopics');
    if (!el || !detectedTopics.size) return;
    el.innerHTML = '';
    detectedTopics.forEach(t => {
      const s = document.createElement('span');
      s.className = 'topic-pill';
      s.textContent = t;
      el.appendChild(s);
    });
  }

  function resetTopics() {
    detectedTopics.clear();
    const el = $('detectedTopics');
    if (el) el.innerHTML = '<span class="topic-empty">none detected yet</span>';
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

  return {
    setKey, init,
    showCoachUI, hideCoachUI, showPanel, hidePanel,
    startPeriodic, stopPeriodic,
    triggerAnalysis, setScanning, resetTopics, showTyping
  };
})();
