// facemesh.js — local face metrics + remote partner mood detection (no API, no tokens)

const FaceAnalyzer = (() => {
  let mesh     = null;   // for local face metrics (symmetry, golden ratio, etc.)
  let moodMesh = null;   // for remote partner mood detection
  let ready    = false;
  let lastMetrics = null;
  let lastMood    = null;

  // Key MediaPipe Face Mesh landmark indices
  const IDX = {
    foreheadTop:     10,
    chin:           152,
    leftCheek:      234,
    rightCheek:     454,
    noseTip:          4,
    noseBridge:     168,
    // Eyes (viewer-perspective naming)
    leftEyeOuter:    33,   // anatomical right eye outer corner
    leftEyeInner:   133,
    leftEyeUpper:   159,   // upper eyelid center
    leftEyeLower:   145,   // lower eyelid center
    rightEyeOuter:  263,   // anatomical left eye outer corner
    rightEyeInner:  362,
    rightEyeUpper:  386,
    rightEyeLower:  374,
    // Mouth
    leftMouth:       61,
    rightMouth:     291,
    upperLip:        13,
    lowerLip:        14,
    // Brows
    leftEyebrow:     70,
    leftBrowMid:    105,
    rightEyebrow:   300,
    rightBrowMid:   334,
  };

  function dist2d(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }

  function angle(a, b) {
    return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  }

  function clamp(v, min = 0, max = 100) {
    return Math.max(min, Math.min(max, v));
  }

  // ── LOCAL FACE METRICS: symmetry, golden ratio, facial thirds, canthal tilt ──
  function computeMetrics(lm) {
    const p = lm;

    const faceW = dist2d(p[IDX.leftCheek], p[IDX.rightCheek]);
    const faceH = dist2d(p[IDX.foreheadTop], p[IDX.chin]);
    if (faceW < 0.05 || faceH < 0.05) return null; // face too small / not centered

    // Golden ratio score (ideal w/h ≈ 0.618)
    const ratio = faceW / faceH;
    const goldenScore = clamp(Math.round(100 - Math.abs(ratio - 0.618) * 300));

    // Symmetry — compare paired distances from nose tip
    const nose = p[IDX.noseTip];
    const symPairs = [
      [IDX.leftEyeOuter,  IDX.rightEyeOuter],
      [IDX.leftEyeInner,  IDX.rightEyeInner],
      [IDX.leftMouth,     IDX.rightMouth],
      [IDX.leftCheek,     IDX.rightCheek],
      [IDX.leftEyebrow,   IDX.rightEyebrow],
    ];
    let symSum = 0;
    symPairs.forEach(([l, r]) => {
      const dL = dist2d(nose, p[l]);
      const dR = dist2d(nose, p[r]);
      const avg = (dL + dR) / 2 || 1;
      symSum += 1 - Math.abs(dL - dR) / avg;
    });
    const symmetryScore = clamp(Math.round((symSum / symPairs.length) * 100));

    // Canthal tilt — angle of line connecting outer eye corners
    const canthalAngleDeg = angle(p[IDX.leftEyeOuter], p[IDX.rightEyeOuter]);
    const canthalLabel = canthalAngleDeg > 2  ? `+${canthalAngleDeg.toFixed(1)}° ▲ hunter` :
                         canthalAngleDeg < -2 ? `${canthalAngleDeg.toFixed(1)}° ▼ soft` :
                                                `${canthalAngleDeg.toFixed(1)}° neutral`;

    // Facial thirds: forehead / midface / lower face
    const browLevel  = (p[IDX.leftEyebrow].y + p[IDX.rightEyebrow].y) / 2;
    const noseBase   = p[2]; // just above upper lip
    const foreheadH  = Math.abs(browLevel - p[IDX.foreheadTop].y);
    const midfaceH   = Math.abs(noseBase.y - browLevel);
    const lowerH     = Math.abs(p[IDX.chin].y - noseBase.y);
    const totalH     = foreheadH + midfaceH + lowerH || 1;
    const ideal      = 1 / 3;
    const thirdsScore = clamp(Math.round(100 - (
      Math.abs(foreheadH / totalH - ideal) +
      Math.abs(midfaceH  / totalH - ideal) +
      Math.abs(lowerH    / totalH - ideal)
    ) * 200));

    const overall = clamp(Math.round(symmetryScore * 0.4 + goldenScore * 0.3 + thirdsScore * 0.3));
    const label   = overall >= 80 ? 'Excellent' : overall >= 65 ? 'Good' : overall >= 50 ? 'Average' : 'Below average';

    return { symmetryScore, goldenScore, thirdsScore, canthalLabel, overall, label };
  }

  // ── PARTNER MOOD DETECTION: happy / surprised / sad / tired / neutral ──
  function detectMood(lm) {
    const p = lm;
    const faceH = dist2d(p[IDX.foreheadTop], p[IDX.chin]);
    const faceW = dist2d(p[IDX.leftCheek],   p[IDX.rightCheek]);
    if (faceH < 0.05 || faceW < 0.05) return null;

    // Eye Aspect Ratio (EAR) — how open the eyes are
    // EAR = vertical eye height / horizontal eye width
    const leftEAR  = dist2d(p[IDX.leftEyeUpper],  p[IDX.leftEyeLower])  /
                    (dist2d(p[IDX.leftEyeOuter],   p[IDX.leftEyeInner])  || 1);
    const rightEAR = dist2d(p[IDX.rightEyeUpper], p[IDX.rightEyeLower]) /
                    (dist2d(p[IDX.rightEyeOuter],  p[IDX.rightEyeInner]) || 1);
    const EAR = (leftEAR + rightEAR) / 2;
    // ~0.28–0.32 = normal, > 0.38 = wide open, < 0.18 = closed/tired

    // Smile lift — how much mouth corners are above upper lip center
    // In image coords: y=0 is top, so smaller y = higher = smile
    const cornerY   = (p[IDX.leftMouth].y + p[IDX.rightMouth].y) / 2;
    const smileLift = (p[IDX.upperLip].y - cornerY) / faceH;
    // > 0.018 = clear smile, < -0.012 = frown/sad

    // Mouth openness
    const mouthOpen = dist2d(p[IDX.upperLip], p[IDX.lowerLip]) / faceH;

    // Brow raise — distance from brow midpoint to upper eyelid, normalized
    const leftBrowLift  = (p[IDX.leftEyeUpper].y  - p[IDX.leftBrowMid].y)  / faceH;
    const rightBrowLift = (p[IDX.rightEyeUpper].y - p[IDX.rightBrowMid].y) / faceH;
    const browLift = (leftBrowLift + rightBrowLift) / 2;
    // > 0.07 = brows raised (surprise), low = neutral

    // ── Classify mood ──
    let mood, emoji, confidence;

    if (smileLift > 0.018) {
      mood = 'happy';
      emoji = '😊';
      confidence = clamp(Math.round(smileLift * 2500));
    } else if (EAR > 0.37 && browLift > 0.07) {
      mood = 'surprised';
      emoji = '😲';
      confidence = clamp(Math.round(EAR * 220 - 40));
    } else if (smileLift < -0.012) {
      mood = 'sad';
      emoji = '😔';
      confidence = clamp(Math.round(Math.abs(smileLift) * 2000));
    } else if (EAR < 0.18) {
      mood = 'tired';
      emoji = '😴';
      confidence = clamp(Math.round((0.25 - EAR) * 450));
    } else {
      mood = 'neutral';
      emoji = '😐';
      confidence = 65;
    }

    // Score bars (0–100)
    const smileBar  = clamp(Math.round(smileLift * 1500 + 40)); // ~40 at neutral
    const alertness = clamp(Math.round((EAR - 0.10) * 330));    // ~60 when open

    return { mood, emoji, confidence, smileBar, alertness };
  }

  // ── Shared helper: create a FaceMesh instance ──
  function makeMesh(onResultsFn) {
    if (typeof FaceMesh === 'undefined') return null;
    const m = new FaceMesh({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
    });
    m.setOptions({
      maxNumFaces: 1,
      refineLandmarks: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    m.onResults(onResultsFn);
    return m;
  }

  function init() {
    if (typeof FaceMesh === 'undefined') {
      console.warn('MediaPipe FaceMesh not loaded');
      return;
    }
    // Instance 1: local face metrics
    mesh = makeMesh((r) => {
      lastMetrics = r.multiFaceLandmarks?.length ? computeMetrics(r.multiFaceLandmarks[0]) : null;
    });
    // Instance 2: remote partner mood
    moodMesh = makeMesh((r) => {
      lastMood = r.multiFaceLandmarks?.length ? detectMood(r.multiFaceLandmarks[0]) : null;
    });
    ready = true;
  }

  async function analyze(videoEl) {
    if (!ready || !mesh || !videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) return null;
    try { await mesh.send({ image: videoEl }); } catch (e) { /* ignore frame errors */ }
    return lastMetrics;
  }

  async function analyzeMood(videoEl) {
    if (!ready || !moodMesh || !videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) return null;
    try { await moodMesh.send({ image: videoEl }); } catch (e) { /* ignore frame errors */ }
    return lastMood;
  }

  return { init, analyze, analyzeMood };
})();
