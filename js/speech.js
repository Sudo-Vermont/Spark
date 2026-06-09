// speech.js — Web Speech API for real-time mic transcription

const SpeechManager = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!SR;

  let yourRec = null;
  let partnerRec = null;
  let onYours = null;
  let onPartner = null;
  let active = false;

  function isSupported() { return supported; }

  function init(yourCb, partnerCb) {
    onYours = yourCb;
    onPartner = partnerCb;
  }

  function makeRec(continuous, onFinal, onEnd) {
    if (!supported) return null;
    const r = new SR();
    r.continuous = continuous;
    r.interimResults = true;
    r.lang = 'en-US';
    let buf = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) buf += t + ' ';
        else interim += t;
      }
      if (buf.trim()) { onFinal(buf.trim()); buf = ''; }
    };
    r.onerror = (e) => { if (e.error !== 'no-speech') console.warn('SR error:', e.error); };
    r.onend = () => { if (active && onEnd) onEnd(); };
    return r;
  }

  function startYours() {
    if (!supported || yourRec) return;
    active = true;
    yourRec = makeRec(true, (t) => { if (onYours) onYours(t); }, () => { yourRec = null; if (active) startYours(); });
    try { yourRec.start(); } catch(e) {}
  }

  // Attempt to transcribe the partner's remote audio stream
  function startPartner(remoteStream) {
    if (!supported || !remoteStream || partnerRec) return;
    try {
      const ctx = new AudioContext();
      ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(remoteStream);
      const dst = ctx.createMediaStreamDestination();
      src.connect(dst);
      partnerRec = makeRec(true, (t) => { if (onPartner) onPartner(t); }, () => {
        partnerRec = null;
        if (active) startPartner(dst.stream);
      });
      try { partnerRec.start(); } catch(e) { console.warn('Partner SR start:', e); }
    } catch(e) { console.warn('Partner SR setup:', e); }
  }

  function stopAll() {
    active = false;
    if (yourRec)    { try { yourRec.stop();    } catch(e){} yourRec = null; }
    if (partnerRec) { try { partnerRec.stop(); } catch(e){} partnerRec = null; }
  }

  // Single-shot push-to-talk
  function pushToTalk() {
    return new Promise((res) => {
      if (!supported) return res(null);
      const r = new SR();
      r.continuous = false;
      r.interimResults = false;
      r.lang = 'en-US';
      let got = false;
      r.onresult = (e) => { got = true; res(e.results[0][0].transcript); };
      r.onerror = () => res(null);
      r.onend = () => { if (!got) res(null); };
      try { r.start(); } catch(e) { res(null); }
    });
  }

  return { isSupported, init, startYours, startPartner, stopAll, pushToTalk };
})();
