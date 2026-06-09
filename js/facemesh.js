// facemesh.js — local face analysis via MediaPipe Face Mesh (no API, no tokens)

const FaceAnalyzer = (() => {
  let mesh = null;
  let ready = false;
  let lastMetrics = null;

  // Key MediaPipe Face Mesh landmark indices
  const IDX = {
    foreheadTop:     10,
    chin:           152,
    leftCheek:      234,
    rightCheek:     454,
    noseTip:          4,
    noseBridge:     168,
    leftEyeOuter:    33,   // person's right eye outer
    leftEyeInner:   133,
    rightEyeOuter:  263,   // person's left eye outer
    rightEyeInner:  362,
    leftMouth:       61,
    rightMouth:     291,
    leftEyebrow:     70,
    rightEyebrow:   300,
    upperLip:        13,
    lowerLip:        14,
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

  function computeMetrics(lm) {
    const p = lm;

    // ── Dimensions ──
    const faceW = dist2d(p[IDX.leftCheek], p[IDX.rightCheek]);
    const faceH = dist2d(p[IDX.foreheadTop], p[IDX.chin]);
    if (faceW < 0.05 || faceH < 0.05) return null; // face too small / not centered

    // ── Golden ratio score (ideal w/h ≈ 0.618) ──
    const ratio = faceW / faceH;
    const goldenScore = clamp(Math.round(100 - Math.abs(ratio - 0.618) * 300));

    // ── Symmetry ──
    // Compare paired distances from nose tip
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

    // ── Canthal tilt ──
    // Angle of the line connecting outer eye corners (positive = upward tilt = hunter eyes)
    const canthalAngleDeg = angle(p[IDX.leftEyeOuter], p[IDX.rightEyeOuter]);
    // Positive = right side higher (mirror: left corner higher = upward tilt)
    const canthalLabel = canthalAngleDeg > 2  ? `+${canthalAngleDeg.toFixed(1)}° ▲ hunter` :
                         canthalAngleDeg < -2 ? `${canthalAngleDeg.toFixed(1)}° ▼ soft` :
                                                `${canthalAngleDeg.toFixed(1)}° neutral`;

    // ── Facial thirds ──
    // Top third: forehead to brow; mid: brow to nose base; lower: nose to chin
    const browLevel   = (p[IDX.leftEyebrow].y + p[IDX.rightEyebrow].y) / 2;
    const noseBase    = p[2]; // just above upper lip
    const foreheadH   = Math.abs(browLevel - p[IDX.foreheadTop].y);
    const midfaceH    = Math.abs(noseBase.y - browLevel);
    const lowerH      = Math.abs(p[IDX.chin].y - noseBase.y);
    const totalH      = foreheadH + midfaceH + lowerH || 1;
    const ideal       = 1 / 3;
    const thirdsScore = clamp(Math.round(100 - (
      Math.abs(foreheadH / totalH - ideal) +
      Math.abs(midfaceH  / totalH - ideal) +
      Math.abs(lowerH    / totalH - ideal)
    ) * 200));

    // ── Overall ──
    const overall = clamp(Math.round((symmetryScore * 0.4 + goldenScore * 0.3 + thirdsScore * 0.3)));

    const label = overall >= 80 ? 'Excellent' :
                  overall >= 65 ? 'Good' :
                  overall >= 50 ? 'Average' : 'Below average';

    return { symmetryScore, goldenScore, thirdsScore, canthalLabel, overall, label };
  }

  function init() {
    if (typeof FaceMesh === 'undefined') {
      console.warn('MediaPipe FaceMesh not loaded');
      return;
    }
    mesh = new FaceMesh({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
    });
    mesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    mesh.onResults((results) => {
      if (results.multiFaceLandmarks?.length) {
        lastMetrics = computeMetrics(results.multiFaceLandmarks[0]);
      } else {
        lastMetrics = null;
      }
    });
    ready = true;
  }

  async function analyze(videoEl) {
    if (!ready || !mesh || !videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) {
      return null;
    }
    try {
      await mesh.send({ image: videoEl });
    } catch (e) {
      // ignore frame errors
    }
    return lastMetrics;
  }

  return { init, analyze };
})();
