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
    r.onerror = (e) => { if (e.error !== 'no-speech') console.warn('SR error:', e.error); };
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
      const r = new SR();
      r.continuous     = false;
      r.interimResults = false;
      r.lang = 'en-US';
      let got = false;
      r.onresult = (e) => { got = true; res(e.results[0][0].transcript); };
      r.onerror  = () => res(null);
      r.onend    = () => { if (!got) res(null); };
      try { r.start(); } catch(e) { res(null); }
    });
  }

  return { isSupported, init, startYours, startPartner, stopAll, pushToTalk };
})();
