// gemini.js — calls Google Gemini API (text-only, no canvas/video frames)
// Text-only keeps memory low and is faster + more reliable than vision

const GeminiCoach = (() => {
  let apiKey = null;
  let analysisTimer = null;
  let busy = false;
  let detectedTopics = new Set();
  let coachVisible = false;

  const $ = id => document.getElementById(id);

  function setKey(key) { apiKey = key; }

  function init() {
    $('coachClose').addEventListener('click', hidePanel);
    $('coachToggle').addEventListener('click', showPanel);
    $('coachRefresh').addEventListener('click', () => {
      if (window.AppState) triggerAnalysis(AppState.transcript);
    });
    $('analyzeNowBtn').addEventListener('click', () => {
      if (window.AppState) triggerAnalysis(AppState.transcript);
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

  function startPeriodic(transcriptRef, ms = 16000) {
    stopPeriodic();
    setTimeout(() => triggerAnalysis(transcriptRef), 5000);
    analysisTimer = setInterval(() => triggerAnalysis(transcriptRef), ms);
  }

  function stopPeriodic() {
    if (analysisTimer) { clearInterval(analysisTimer); analysisTimer = null; }
    busy = false;
  }

  async function triggerAnalysis(transcript) {
    if (busy || !apiKey) return;
    const lines = (transcript || []).slice(-12)
      .map(l => `${l.who === 'you' ? 'Me' : 'Partner'}: ${l.text}`)
      .join('\n');
    if (!lines) return;   // nothing to analyze yet

    busy = true;
    const hintEl    = $('coachHint');
    const refreshBtn = $('coachRefresh');
    if (hintEl)     hintEl.classList.add('loading');
    if (refreshBtn) refreshBtn.classList.add('spinning');

    const prompt = `You are a real-time conversation coach whispering advice to help someone have a better video chat.

Recent transcript:
${lines}

Rules:
- Give coaching SUGGESTIONS only — never write lines for the user to say verbatim
- Be warm, specific, and brief
- Base advice on what you actually read in the transcript

Respond ONLY with valid JSON, no markdown, no code fences:
{
  "hint": "one specific coaching tip (max 2 sentences)",
  "sentiment": "positive" or "neutral" or "negative",
  "energy": <0-100>,
  "curiosity": <0-100>,
  "humor": <0-100>,
  "depth": <0-100>,
  "topics": ["2-4 short topic labels from the conversation"],
  "questions": ["3 natural questions the user could ask next"],
  "suggestedTopics": ["3-4 topic directions worth exploring"]
}`;

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        }
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const raw   = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const clean = raw.replace(/```json|```/g, '').trim();
      applyResult(JSON.parse(clean));
    } catch (e) {
      console.warn('Gemini error:', e.message);
      if (hintEl) hintEl.textContent = `Coach error: ${e.message}`;
    } finally {
      if (hintEl)     hintEl.classList.remove('loading');
      if (refreshBtn) refreshBtn.classList.remove('spinning');
      busy = false;
    }
  }

  function applyResult(d) {
    const hintEl = $('coachHint');
    if (hintEl && d.hint) hintEl.textContent = d.hint;

    if (d.suggestedTopics?.length)
      $('coachTopics').innerHTML = d.suggestedTopics.map(t => `<span class="coach-topic-btn">${t}</span>`).join('');

    if (d.questions?.length)
      $('coachQuestions').innerHTML = d.questions.map(q => `<div class="coach-question">${q}</div>`).join('');

    // Analysis bar
    const sent = d.sentiment || 'neutral';
    const emoji = sent === 'positive' ? '😊' : sent === 'negative' ? '😕' : '😐';
    const snippet = (d.hint || '').slice(0, 90) + ((d.hint?.length || 0) > 90 ? '…' : '');
    const topicTags = (d.topics || []).slice(0, 3).map(t => `<span class="topic-tag">${t}</span>`).join('');

    $('analysisContent').innerHTML = `
      <div class="analysis-section">
        <div class="analysis-label">Sentiment</div>
        <div class="analysis-value"><span class="sentiment-pill ${sent}">${emoji} ${sent}</span></div>
      </div>
      <div class="analysis-divider"></div>
      <div class="analysis-section" style="flex:1;min-width:0">
        <div class="analysis-label">✦ transcript analysis</div>
        <div class="analysis-value live-text">${snippet}</div>
      </div>
      ${topicTags ? `<div class="analysis-divider"></div><div class="analysis-section"><div class="analysis-label">Topics</div><div class="topic-tags">${topicTags}</div></div>` : ''}`;

    // Mood bars
    ['energy','curiosity','humor','depth'].forEach(k => {
      const v = d[k];
      if (typeof v !== 'number') return;
      const val = Math.min(100, Math.max(0, Math.round(v)));
      const bar = $('mood-' + k), pct = $('pct-' + k);
      if (bar) bar.style.width = val + '%';
      if (pct) pct.textContent = val + '%';
    });
    const note = $('moodNote');
    if (note) note.textContent = '✦ transcript analyzed';

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
