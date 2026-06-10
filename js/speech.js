// speech.js — Web Speech API for your mic only
// Partner transcription is handled via the data channel (no AudioContext needed)

const SpeechManager = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!SR;

  let yourRec = null;
  let onYours = null;
  let active  = false;

  function isSupported() { return supported; }

  function init(yourCb) { onYours = yourCb; }

  function startYours() {
    if (!supported || yourRec) return;
    active = true;
    const r = new SR();
    r.continuous     = true;
    r.interimResults = true;
    r.lang = 'en-US';
    let buf = '';
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) buf += e.results[i][0].transcript + ' ';
      }
      if (buf.trim()) { if (onYours) onYours(buf.trim()); buf = ''; }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        active = false; // fatal — restarting would just loop forever
        console.warn('SR disabled:', e.error);
      } else if (e.error !== 'no-speech') {
        console.warn('SR error:', e.error);
      }
    };
    r.onend   = () => { yourRec = null; if (active) startYours(); };
    yourRec = r;
    try { r.start(); } catch(e) {}
  }

  // No-op — kept so call sites don't break
  function startPartner() {}

  function stopAll() {
    active = false;
    if (yourRec) { try { yourRec.stop(); } catch(e){} yourRec = null; }
  }

  function pushToTalk() {
    return new Promise((res) => {
      if (!supported) return res(null);
      // Browsers allow only one active recognition — pause the continuous one first
      const wasActive = active;
      if (yourRec) { active = false; try { yourRec.abort(); } catch(e){} yourRec = null; }
      let finished = false;
      const done = (text) => {
        if (finished) return;
        finished = true;
        if (wasActive) { active = true; startYours(); }
        res(text);
      };
      const r = new SR();
      r.continuous     = false;
      r.interimResults = false;
      r.lang = 'en-US';
      r.onresult = (e) => done(e.results[0][0].transcript);
      r.onerror  = () => done(null);
      r.onend    = () => done(null);
      try { r.start(); } catch(e) { done(null); }
    });
  }

  return { isSupported, init, startYours, startPartner, stopAll, pushToTalk };
})();
