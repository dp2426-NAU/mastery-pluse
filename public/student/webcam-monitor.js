// Best-effort webcam attention monitor: detects the student's face turning
// away from the screen, or their eyes closing for a sustained stretch,
// using MediaPipe's Face Landmarker running entirely inside this browser
// tab. NO VIDEO FRAME IS EVER SENT ANYWHERE — detection happens locally;
// the only thing that ever leaves this tab is a strike count and, once 3+
// strikes are reached, one small still-frame snapshot (a few tens of KB).
//
// This is head-pose / eye-closure *approximation*, not proof of anything —
// lighting, webcam angle, and glasses all affect it. It's a signal for the
// instructor to look closer, exactly like the tab-switch/fullscreen trail
// already in this app, never a claim of certainty.
//
// If the camera can't be used for any reason (permission denied, no
// camera, the model fails to load), the exam proceeds anyway and the
// instructor just sees "no webcam signal" instead of a hard block — same
// "detect, don't pretend to prevent" honesty as the rest of the integrity
// features here.
(function () {
  const YAW_THRESHOLD_DEG = 28;      // sustained head turn past this angle counts as "away"
  const EYE_CLOSED_SCORE = 0.6;      // blendshape score (0-1), both eyes, to count as "eyes closed"
  const SUSTAIN_MS = 700;            // must persist this long to count (filters normal blinks/glances)
  const COOLDOWN_MS = 1500;          // minimum gap between two counted strikes
  const SAMPLE_MS = 400;             // how often the webcam frame is sampled
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  const TASKS_VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

  let landmarker = null;
  let videoEl = null;
  let stream = null;
  let sampleTimer = null;
  let awayStartedAt = null;
  let lastEventAt = 0;
  let strikeCount = 0;
  let onStrike = null;
  let running = false;

  // Standard rotation-matrix -> yaw extraction. MediaPipe hands back a
  // column-major 4x4 facial transformation matrix per detected face.
  function yawFromMatrix(m) {
    const r20 = m[2], r00 = m[0], r10 = m[1];
    return Math.atan2(-r20, Math.sqrt(r00 * r00 + r10 * r10)) * (180 / Math.PI);
  }

  function blendshapeScore(result, name) {
    const cats = result.faceBlendshapes && result.faceBlendshapes[0] && result.faceBlendshapes[0].categories;
    if (!cats) return 0;
    const hit = cats.find((c) => c.categoryName === name);
    return hit ? hit.score : 0;
  }

  function captureSnapshot() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 240; canvas.height = 180;
      canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.55);
    } catch { return null; }
  }

  async function ensureModel() {
    if (landmarker) return landmarker;
    // Dynamic import — works from a plain classic script, no type="module" needed.
    const { FaceLandmarker, FilesetResolver } = await import(TASKS_VISION_URL);
    const filesetResolver = await FilesetResolver.forVisionTasks(`${TASKS_VISION_URL}/wasm`);
    landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: true,
      runningMode: 'VIDEO',
      numFaces: 1,
    });
    return landmarker;
  }

  function sampleOnce() {
    if (!running || !landmarker || !videoEl || videoEl.readyState < 2) return;
    let result;
    try {
      result = landmarker.detectForVideo(videoEl, performance.now());
    } catch { return; }

    const faces = result.faceLandmarks || [];
    const matrices = result.facialTransformationMatrixes || [];
    let attentive = true;

    if (faces.length === 0) {
      attentive = false; // no face in frame at all counts as "away"
    } else {
      const yaw = matrices[0] ? yawFromMatrix(matrices[0].data) : 0;
      const eyesClosed = blendshapeScore(result, 'eyeBlinkLeft') > EYE_CLOSED_SCORE
        && blendshapeScore(result, 'eyeBlinkRight') > EYE_CLOSED_SCORE;
      if (Math.abs(yaw) > YAW_THRESHOLD_DEG || eyesClosed) attentive = false;
    }

    const now = Date.now();
    if (!attentive) {
      if (!awayStartedAt) awayStartedAt = now;
      if (now - awayStartedAt >= SUSTAIN_MS && now - lastEventAt >= COOLDOWN_MS) {
        lastEventAt = now;
        awayStartedAt = now; // require a fresh sustain period before the next strike
        strikeCount += 1;
        if (strikeCount >= 3 && onStrike) onStrike(strikeCount, captureSnapshot());
      }
    } else {
      awayStartedAt = null;
    }
  }

  // cb(count, snapshotDataUrlOrNull) is called every strike from the 3rd
  // onward — resolves to {ok:true} once running, or {ok:false, reason} if
  // the camera/model couldn't be started (caller should proceed without it).
  async function start(cb) {
    onStrike = cb;
    strikeCount = 0; awayStartedAt = null; lastEventAt = 0; running = true;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
    } catch {
      running = false;
      return { ok: false, reason: 'permission-denied' };
    }

    videoEl = document.createElement('video');
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    try { await videoEl.play(); } catch { /* some browsers still fire frames without an explicit play */ }

    try {
      await ensureModel();
    } catch {
      stop();
      return { ok: false, reason: 'model-load-failed' };
    }

    sampleTimer = setInterval(sampleOnce, SAMPLE_MS);
    return { ok: true };
  }

  function stop() {
    running = false;
    if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    videoEl = null;
  }

  window.MasteryPulseWebcam = { start, stop };
})();
