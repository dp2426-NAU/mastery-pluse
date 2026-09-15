// A slowly rotating 3D node graph behind the landing page's hero — a
// literal picture of the thing this project actually is: a client-server
// network with live activity flowing between nodes. Pure decoration, so it
// degrades to nothing rather than breaking anything: no Three.js loaded,
// no WebGL, or reduced-motion preferred → the canvas just stays empty and
// the flat navy background shows through, no error, no layout shift.
(function () {
  const canvas = document.getElementById('netBg');
  if (!canvas || !window.THREE) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch {
    return; // no WebGL available — leave the canvas blank
  }

  const stage = canvas.parentElement;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.z = 22;

  // Fewer nodes on small screens — this is decoration, not worth a frame drop.
  const NODE_COUNT = window.innerWidth < 640 ? 32 : 60;
  const SPREAD = { x: 26, y: 12, z: 10 };
  const LINK_DIST = 7.5;

  const nodePositions = [];
  const posArray = new Float32Array(NODE_COUNT * 3);
  for (let i = 0; i < NODE_COUNT; i++) {
    const x = (Math.random() - 0.5) * SPREAD.x * 2;
    const y = (Math.random() - 0.5) * SPREAD.y * 2;
    const z = (Math.random() - 0.5) * SPREAD.z * 2;
    nodePositions.push(new THREE.Vector3(x, y, z));
    posArray[i * 3] = x; posArray[i * 3 + 1] = y; posArray[i * 3 + 2] = z;
  }

  // Nodes = the accent blue used everywhere else for "this is live."
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  const pointsMat = new THREE.PointsMaterial({ color: 0x5b8cff, size: 0.24, transparent: true, opacity: 0.85, sizeAttenuation: true });
  scene.add(new THREE.Points(pointsGeo, pointsMat));

  // Links between nearby nodes, in the institutional gold — a network
  // graph, not a random starfield.
  const linePositions = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    for (let j = i + 1; j < NODE_COUNT; j++) {
      if (nodePositions[i].distanceTo(nodePositions[j]) < LINK_DIST) {
        linePositions.push(nodePositions[i].x, nodePositions[i].y, nodePositions[i].z);
        linePositions.push(nodePositions[j].x, nodePositions[j].y, nodePositions[j].z);
      }
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePositions), 3));
  const lineMat = new THREE.LineBasicMaterial({ color: 0xc9a24b, transparent: true, opacity: 0.16 });
  scene.add(new THREE.LineSegments(lineGeo, lineMat));

  function resize() {
    const w = stage.clientWidth || 1;
    const h = stage.clientHeight || 1;
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  // Pause rendering when the tab isn't visible — no point spending battery
  // animating a background nobody's looking at.
  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; });

  function animate() {
    if (running) {
      const t = Date.now() * 0.00004;
      scene.rotation.y = t;
      scene.rotation.x = Math.sin(t * 0.6) * 0.08;
      renderer.render(scene, camera);
    }
    requestAnimationFrame(animate);
  }
  animate();
})();
