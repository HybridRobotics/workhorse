// The whole-body tracker as a scene you can turn, in place of a video of one camera angle.
//
// The robot's shape arrives once as a glTF, a node per body; the motion arrives as a flat block of
// transforms, one per body per frame, baked by video/scripts/site_tracker3d.py from the reference
// motion in the policy's own export.  Nothing is solved here: each frame sets 30 transforms.
// The camera orbits the robot and travels with it, so dragging turns the view without losing it.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

const BASE = './static/models/';
const VER = '?v=3';               // the model files are versioned too, or a cached
                                  // rollout is served in place of a new one
const PLANE = 30;                 // how much ground is drawn, metres
const TEXREPEAT = 2;              // tiles per metre, so a square is 0.25 m as the render shows
const EYE = 0.85;                  // the height the view holds, so a crouch does not drag it down

// MuJoCo stores a quaternion w first, three.js last; and the capture is z-up where three is y-up,
// so the whole scene is tipped once at the root rather than every transform being rewritten.
const quat = (q, i) => new THREE.Quaternion(q[i + 4], q[i + 5], q[i + 6], q[i + 3]);

// Both scenes play their motion on one clock, so the two bodies stay in step and a click pauses
// both.  The clock runs only while a scene is drawn, and a pause holds it, so play resumes on the
// frame it stopped at.  Under reduced motion it starts paused.
const clock = { t: 0, last: null, paused: matchMedia('(prefers-reduced-motion: reduce)').matches,
                hosts: new Set() };
const tick = (now) => {
  if (clock.last !== null && !clock.paused) clock.t += Math.min(now - clock.last, 100) / 1000;
  clock.last = now;
};
const touch = !matchMedia('(hover: hover)').matches;
const hintText = () => clock.paused
  ? `Paused \u00b7 ${touch ? 'tap' : 'click'} to play`
  : touch ? 'Drag to turn \u00b7 tap to pause' : 'Drag to turn \u00b7 hover a marker \u00b7 click to pause';
const setPaused = (paused) => {
  clock.paused = paused;
  for (const h of clock.hosts) {
    h.dataset.paused = paused;
    h.querySelector('.hint').textContent = hintText();
  }
};

// MuJoCo's own look, so this reads as the same scene as the clip beside it: a checkered ground in
// two blues with a light edge mark, under a gradient sky.  The values are the simulator's defaults.
function ground() {
  const N = 512, c = document.createElement('canvas');
  c.width = c.height = N;
  const x = c.getContext('2d');
  x.fillStyle = '#41617e';                            // sampled off the simulator's own render
  x.fillRect(0, 0, N, N);
  x.fillStyle = '#1d3e5b';
  x.fillRect(0, 0, N / 2, N / 2);
  x.fillRect(N / 2, N / 2, N / 2, N / 2);
  x.strokeStyle = 'rgba(190,205,220,0.5)';            // markrgb, as it lands after lighting
  x.lineWidth = 2;
  x.strokeRect(1, 1, N - 2, N - 2);
  const t = new THREE.CanvasTexture(c);
  // These were read off a finished frame, so they are sRGB already; left unmarked three treats
  // them as linear and converts on output, which washes the whole scene out.
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(PLANE * TEXREPEAT, PLANE * TEXREPEAT);
  t.anisotropy = 8;
  return t;
}

function sky() {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#26405a');                       // the simulator's sky, darkest overhead
  g.addColorStop(1, '#2f4f6d');                       // and a shade lighter toward the horizon
  x.fillStyle = g;
  x.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shelf(meta) {
  // The shelf of the capture this motion came from, as the replay config describes it: the black
  // 1.22 x 0.61 x 0.93 unit at [-0.1, 1.7, 0] with two board surfaces, turned a half turn about z
  // so its open face (local +Y) is the one the robot walks up to.  The capture's own mesh lives
  // with the dataset, so this is built to those measurements rather than loaded.
  const g = new THREE.Group();
  const [w, d, h] = meta.size;
  const mat = new THREE.MeshLambertMaterial({ color: 0x0b0e0c });
  const slab = (sx, sy, sz, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(x, y, z);
    g.add(m);
  };
  for (const z of meta.boards) slab(w, d, 0.025, 0, 0, z);         // the board the boxes go on
  for (const sx of [-1, 1]) for (const sy of [-1, 1])              // a thin post at each corner
    slab(0.022, 0.022, h, (sx * w) / 2, (sy * d) / 2, h / 2);
  // A rail joins the posts at the top across the back and down both sides; the face the robot
  // reaches into is left open, which is how it stands in the simulator's own frames.
  slab(w, 0.022, 0.022, 0, -d / 2, h);
  for (const sx of [-1, 1]) slab(0.022, d, 0.022, (sx * w) / 2, 0, h);
  g.position.set(meta.pos[0], meta.pos[1], meta.pos[2]);
  g.rotation.z = (meta.yaw * Math.PI) / 180;
  return g;
}

export async function init(host) {
  if (host.dataset.started) return;                // a second observer pass must not build it twice
  host.dataset.started = '1';
  const robot = host.dataset.robot || 'g1';
  const meta = await (await fetch(`${BASE}tracker_${robot}.json${VER}`)).json();

  // The scene keeps the simulator's own colours whichever way the page is themed, so that it and
  // the clip of the second body beside it read as one place.
  const scene = new THREE.Scene();
  scene.background = sky();
  const world = new THREE.Group();                 // z-up capture inside a y-up renderer
  world.rotation.x = -Math.PI / 2;
  scene.add(world);

  scene.add(new THREE.HemisphereLight(0xdce6f2, 0x2a3240, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 6, 8);
  scene.add(sun);

  // The ground has the simulator's own reflectance, so the robot stands in its own reflection:
  // a mirror of the scene under a checker drawn over it at the strength the renders show.
  const mirror = new Reflector(new THREE.PlaneGeometry(PLANE, PLANE),
    { textureWidth: 1024, textureHeight: 1024, color: 0x8899aa });
  mirror.position.z = -0.001;
  world.add(mirror);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(PLANE, PLANE),
    new THREE.MeshBasicMaterial({ map: ground(), transparent: true, opacity: 0.8 }));
  world.add(floor);
  world.add(shelf(meta.shelf));

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 120);
  const controls = new THREE.Object3D();           // placeholder until OrbitControls is attached
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enablePan = false;
  orbit.enableZoom = false;                        // the wheel scrolls the page, as over any figure
  orbit.enableDamping = true;
  orbit.minDistance = 1.6;
  orbit.maxDistance = 12;
  orbit.maxPolarAngle = Math.PI * 0.49;            // never below the floor
  camera.position.set(4.2, 2.0, 4.2);
  // A vertical swipe scrolls the page; OrbitControls sets the canvas to take every touch.
  canvas.style.touchAction = 'pan-y';

  // The robot, matched to the baked order by name.  A body whose geoms are not all one colour
  // exports as several nodes -- "torso_link", "torso_link@1" -- and they all follow that body.
  const gltf = await new GLTFLoader().loadAsync(`${BASE}${robot}.glb${VER}`);
  const rig = new THREE.Group();                 // every body of the machine hangs here
  world.add(rig);
  const byName = new Map();
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    const body = o.name.split('@')[0];
    (byName.get(body) || byName.set(body, []).get(body)).push(o);
  });
  const nodes = meta.bodies.map(n => {
    const srcs = byName.get(n);
    if (!srcs) return null;
    const g = new THREE.Group();
    for (const src of srcs) {
      // The export carries no normals, and averaging them over an indexed mesh rounds every
      // edge off until a machined part reads as a soft shell.  Splitting the triangles first
      // gives the flat faces the simulator shows.
      const geo = src.geometry.toNonIndexed();
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
        vertexColors: true,                       // the model's own silver, black and white
      })));
    }
    const m = g;
    m.matrixAutoUpdate = false;
    rig.add(m);
    return m;
  });

  // The five the tracker is told to follow, in the page's own colours.
  const marks = meta.targets.map(t => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.055, 20, 14),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(t.color) }));
    m.userData.label = t.name;
    world.add(m);
    return m;
  });

  const F = meta.frames, B = meta.bodies.length;
  const buf = await (await fetch(`${BASE}tracker_${robot}.bin${VER}`)).arrayBuffer();
  const body = new Float32Array(buf, 0, F * B * 7);
  const tgt = new Float32Array(buf, F * B * 7 * 4, F * 5 * 7);

  const tip = document.createElement('div');
  tip.className = 'kp-tip';
  host.appendChild(tip);
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let hover = null;
  renderer.domElement.addEventListener('pointermove', e => {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    hover = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  renderer.domElement.addEventListener('pointerleave', () => { hover = null; tip.style.opacity = 0; });

  const size = () => {
    const w = host.clientWidth, h = host.clientHeight;           // the shape the page gives it
    renderer.setSize(w, h, false);    // the drawing buffer only: the stylesheet sizes the canvas, so
                                      // the box can still narrow when the window does
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  size();
  new ResizeObserver(size).observe(host);

  // The camera keeps its own direction and distance, set by dragging, and the whole rig slides
  // along with the robot: the target is where the robot is now, not where it started.
  const follow = new THREE.Vector3();
  const torso = meta.bodies.indexOf('torso_link');
  // A click pauses or plays; the click that ends a drag does not.
  let press = null;
  host.addEventListener('pointerdown', e => { press = [e.clientX, e.clientY]; });
  host.addEventListener('click', e => {
    if (press && Math.hypot(e.clientX - press[0], e.clientY - press[1]) > 4) return;
    setPaused(!clock.paused);
  });

  // The keyboard turns the view about the robot and Space pauses it.
  const STEP = Math.PI / 12;
  const arc = new THREE.Spherical();
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', `The ${robot.toUpperCase()} tracker in 3-D: arrow keys turn the view, Space pauses`);
  canvas.addEventListener('keydown', e => {
    if (e.key === ' ') { e.preventDefault(); setPaused(!clock.paused); return; }
    const k = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[e.key];
    if (!k) return;
    e.preventDefault();
    const off = camera.position.clone().sub(orbit.target);
    arc.setFromVector3(off);
    arc.theta += k[0];
    arc.phi = Math.min(orbit.maxPolarAngle, Math.max(0.1, arc.phi + k[1]));
    camera.position.copy(orbit.target).add(off.setFromSpherical(arc));
  });

  const loop = now => {
    tick(now);
    const k = Math.floor(clock.t * meta.fps) % F;
    host.dataset.k = k;

    for (let b = 0; b < B; b++) {
      const n = nodes[b];
      if (!n) continue;
      const i = (k * B + b) * 7;
      n.matrix.compose(new THREE.Vector3(body[i], body[i + 1], body[i + 2]),
        quat(body, i), new THREE.Vector3(1, 1, 1));
    }
    for (let m = 0; m < 5; m++) {
      const i = (k * 5 + m) * 7;
      marks[m].position.set(tgt[i], tgt[i + 1], tgt[i + 2]);
    }

    const ti = (k * B + torso) * 7;
    follow.set(body[ti], body[ti + 1], EYE);
    world.localToWorld(follow);
    const drift = follow.clone().sub(orbit.target);
    orbit.target.copy(follow);
    camera.position.add(drift);                    // the rig travels, the angle is the viewer's
    orbit.update();

    if (hover) {
      ray.setFromCamera(ptr, camera);
      const hit = ray.intersectObjects(marks, false)[0];
      tip.style.opacity = hit ? 1 : 0;
      if (hit) {
        tip.textContent = hit.object.userData.label;
        tip.style.transform = `translate(${hover.x + 12}px, ${hover.y - 10}px)`;
      }
    }
    renderer.render(scene, camera);
  };
  // Drawn only while on screen, as the clips play only while watched.
  new IntersectionObserver(([e]) => renderer.setAnimationLoop(e.isIntersecting ? loop : null)).observe(host);
  clock.hosts.add(host);
  setPaused(clock.paused);
  host.dataset.ready = '1';
}
