// Workhorse project page: clips that load and play only while they are watched, the nav that
// marks the section you are in, and the figures you work by hand.

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const DWELL = 500;      // ms a figure stays on screen before it starts, so a page jump starts nothing

// Runs `fn` once, the first time a quarter of `el` has stayed on screen for DWELL.
function onceWatched(el, fn) {
  let wait = 0;
  const ob = new IntersectionObserver(([e]) => {
    clearTimeout(wait);
    if (e.intersectionRatio >= 0.25) wait = setTimeout(() => { ob.disconnect(); fn(); }, DWELL);
  }, { threshold: 0.25 });
  ob.observe(el);
}

// Runs `fn` once `el` is about a screen away: posters, the film's length and the warp's frame are
// fetched then, ahead of the figure, and not as the page opens.
const nearBy = new Map();
const near = new IntersectionObserver((es) => {
  for (const e of es) {
    if (!e.isIntersecting) continue;
    near.unobserve(e.target);
    nearBy.get(e.target)();
    nearBy.delete(e.target);
  }
}, { rootMargin: '1000px 0px' });
const whenNear = (el, fn) => { nearBy.set(el, fn); near.observe(el); };

// --- clips ---
// Every clip belongs to one player, the figure it sits in.  A player holds one or more groups of
// videos -- a single clip, a take and its robot's camera, the wipe's two copies -- and the first
// video of a group keeps the clock the others follow.  The group plays once a quarter of the
// figure has stayed on screen for DWELL, pauses as it leaves, and lets go of its download once the
// figure is out of sight, so the clip in view has the line to itself.  A clip the visitor paused
// stays paused, and under reduced motion nothing starts on its own.

document.querySelectorAll('video[data-poster]').forEach((v) => whenNear(v, () => {
  v.poster = v.dataset.poster;
  delete v.dataset.poster;
  if (v.controls && !v.hasAttribute('data-autoplay')) v.preload = 'metadata';   // shows its length
}));

// The hero and the robot's camera keep their address in data-src and fetch nothing before it is set.
// Chrome and Firefox on Linux cannot decode HEVC, so every clip has an H.264 twin.  A <video>
// with two <source> children picks for itself; these lazy ones carry their address in a dataset
// and have to be told.  The codec string must be the full one: a bare "hvc1" is answered "no"
// even by browsers that do decode it, which would send everyone to the larger file.
const HEVC = document.createElement('video')
  .canPlayType('video/mp4; codecs="hvc1.2.4.L153.B0"') !== '';

const attach = (v) => {
  if (!v.dataset.src) return;
  const h264 = v.dataset.srcH264;
  v.src = (HEVC || !h264) ? v.dataset.src : h264;
  delete v.dataset.src;
  // Firefox answers canPlayType for HEVC on hosts where it has no decoder -- its support
  // is Windows, macOS and Android only -- so the answer is not trusted on its own.
  if (h264 && v.src !== h264) v.addEventListener('error', () => {
    v.src = h264;
    v.load();
  }, { once: true });
};

// Stops a video's download and frees its decoder.  Its time is kept aside and set again only as
// it plays: a time set on an emptied video makes the browser fetch it straight back.
const resumeAt = new WeakMap();
const release = (v) => {
  if (v.readyState === 0 && v.networkState !== v.NETWORK_LOADING) return;     // holds nothing
  if (document.pictureInPictureElement === v) return;                         // watched elsewhere
  resumeAt.set(v, v.currentTime);
  v.pause();
  v.load();
};

// `other` keeps to `lead`'s clock: it starts once the lead has a frame to show, waits when the lead
// waits, and is pulled back when it drifts by more than `tol` s.  The drift is measured across the
// loop point, so the two wrapping a moment apart is not one.
function follow(lead, other, tol) {
  const align = () => {
    if (other.readyState < 2 || other.seeking) return;
    const d = Math.abs(other.currentTime - lead.currentTime);
    const across = Number.isFinite(lead.duration) ? Math.abs(lead.duration - d) : d;
    if (Math.min(d, across) > tol) other.currentTime = lead.currentTime;
  };
  lead.addEventListener('playing', () => {
    attach(other);
    align();
    other.play().catch(() => {});
  });
  for (const e of ['pause', 'waiting']) lead.addEventListener(e, () => other.pause());
  for (const e of ['seeked', 'timeupdate']) lead.addEventListener(e, align);
  other.addEventListener('loadeddata', align);
}

const quiet = new WeakSet();          // pauses the page made, which are not the visitor's

// `sound` is null for a figure whose clips always play muted, or else the visitor's choice, which
// starts on for the results.
function player(box, groups, { auto = true, tol = 0.25, sound = null } = {}) {
  let cur = 0, want = auto && !reduced.matches, shown = false, start = 0, drop = 0;
  const lead = () => groups[cur][0];
  const run = () => {
    const v = lead();
    attach(v);
    const t = resumeAt.get(v);
    resumeAt.delete(v);
    if (t) v.currentTime = t;
    if (sound !== null) v.muted = !sound;
    v.play().catch((e) => {
      // A browser plays sound only once the visitor has clicked or tapped the page.  Until then
      // the clip plays muted and its sound button turns the sound on; any other refusal leaves
      // the poster and the play button up.
      if (e.name !== 'NotAllowedError' || v.muted) return;
      v.muted = true;
      v.play().catch(() => {});
    });
  };
  const halt = () => {
    const v = lead();
    if (v.paused || document.pictureInPictureElement === v) return;
    quiet.add(v);
    v.pause();
  };
  for (const [v, ...rest] of groups) {
    rest.forEach((o) => follow(v, o, tol));
    v.addEventListener('play', () => { if (v === lead()) want = true; });
    v.addEventListener('pause', () => { if (!quiet.delete(v) && v === lead()) want = false; });
  }
  new IntersectionObserver(([e]) => {
    clearTimeout(start);
    if (e.isIntersecting) clearTimeout(drop);
    shown = e.intersectionRatio >= 0.25;
    if (shown) {
      if (want) start = setTimeout(run, DWELL);
      return;
    }
    halt();
    if (!e.isIntersecting) drop = setTimeout(() => groups[cur].forEach(release), 1000);
  }, { threshold: [0, 0.25] }).observe(box);
  return {
    get lead() { return lead(); },
    get sound() { return sound; },
    leads: groups.map((g) => g[0]),
    toggle() {
      if (lead().paused) run();
      else lead().pause();
    },
    toggleSound() {                    // a muted clip turns its sound on, a sounding one off
      sound = lead().muted;
      lead().muted = !sound;
    },
    select(i) {                        // another group of the figure; it plays from its start
      halt();
      groups[cur].forEach(release);
      cur = i;
      want = !reduced.matches;
      resumeAt.set(lead(), 0);
      if (shown && want) run();
    },
  };
}

// The control row under the results gallery, the one place a clip is a record to scrub through:
// play or pause, a scrubber, the time and, where the player has one, its sound -- all on the
// player's lead.  Returns its redraw, for a player that changes lead.
const SPEAKER = '<path d="M1 4.2h2.2L6.4 1.5v9L3.2 7.8H1z"/>';
const ICON = {
  play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z"/></svg>',
  pause: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z"/></svg>',
  sound: `<svg viewBox="0 0 12 12" aria-hidden="true">${SPEAKER}<path d="M8 3.9a2.9 2.9 0 0 1 0 4.2M9.4 2.5a4.9 4.9 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`,
  muted: `<svg viewBox="0 0 12 12" aria-hidden="true">${SPEAKER}<path d="M8 4.5l3 3M11 4.5l-3 3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`,
};
const clock = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '–:––');

function controls(p, after) {
  const row = document.createElement('div');
  row.className = 'bar';
  row.innerHTML = '<button type="button"></button><input type="range" min="0" max="1000" value="0" aria-label="Seek"><span></span>'
    + (p.sound === null ? '' : '<button type="button"></button>');
  const [button, seek, time, loud] = row.children;
  after.after(row);
  let held = false;                    // the scrubber is in the visitor's hand
  const show = () => {
    const v = p.lead, d = v.duration, t = v.currentTime;
    button.innerHTML = v.paused ? ICON.play : ICON.pause;
    button.setAttribute('aria-label', v.paused ? 'Play' : 'Pause');
    if (!held) seek.value = d ? Math.round((t / d) * 1000) : 0;
    time.textContent = `${clock(t)} / ${clock(d)}`;
    if (!loud) return;
    loud.innerHTML = v.muted ? ICON.muted : ICON.sound;
    loud.setAttribute('aria-label', v.muted ? 'Turn the sound on' : 'Turn the sound off');
  };
  button.addEventListener('click', () => p.toggle());
  loud?.addEventListener('click', () => p.toggleSound());
  seek.addEventListener('pointerdown', () => { held = true; });
  for (const e of ['pointerup', 'pointercancel', 'change']) seek.addEventListener(e, () => { held = false; });
  seek.addEventListener('input', () => {
    const v = p.lead;
    if (Number.isFinite(v.duration)) v.currentTime = (seek.value / 1000) * v.duration;
  });
  for (const v of p.leads) {
    v.controls = false;                // the row stands in for the browser's own
    for (const e of ['play', 'pause', 'timeupdate', 'durationchange', 'emptied', 'volumechange']) {
      v.addEventListener(e, () => { if (v === p.lead) show(); });
    }
  }
  show();
  return show;
}

// A take with the robot's camera.  The small view is the one you click, and its ↗ says so: the
// two trade places, each moving from where it was.  A click on the big one plays or pauses, as on
// any clip.
function duo(box, p) {
  const views = [...box.querySelectorAll('.view')];
  if (views.length < 2) {
    views[0].addEventListener('click', () => p.toggle());
    return;
  }
  for (const view of views) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swap';
    b.textContent = '↗';
    b.title = view.classList.contains('cam') ? "Enlarge the robot's camera" : 'Enlarge the third-person view';
    b.setAttribute('aria-label', b.title);
    view.append(b);
  }
  const swap = () => {
    views.forEach((v) => v.getAnimations().forEach((a) => a.cancel()));
    const was = views.map((v) => v.getBoundingClientRect());
    for (const v of views) {
      v.classList.toggle('big');
      v.classList.toggle('small');
    }
    if (reduced.matches) return;
    views.forEach((v, i) => {
      const a = was[i], b = v.getBoundingClientRect();
      v.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width})` },
                 { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.4,0,.2,1)' });
    });
  };
  box.addEventListener('click', (e) => {
    const view = e.target.closest('.view');
    if (!view) return;
    if (view.classList.contains('big')) { p.toggle(); return; }
    const focused = view.contains(document.activeElement);
    swap();
    if (focused) box.querySelector('.small .swap').focus({ preventScroll: true });
  });
}

// A clip that illustrates a figure loops with no control row and is worked on its picture: a
// click plays or pauses it, and so do Space and Enter once the picture has the focus.  The
// browser's own controls stay in the markup for a page without the script.
function byHand(el, p) {
  p.leads.forEach((v) => { v.controls = false; });
  el.tabIndex = 0;
  el.setAttribute('aria-label', 'Clip: Space plays or pauses it');
  el.addEventListener('keydown', (e) => {
    if (e.target !== el || (e.key !== ' ' && e.key !== 'Enter')) return;
    e.preventDefault();
    p.toggle();
  });
}

document.querySelectorAll('video[data-autoplay]').forEach((v) => {
  if (v.closest('.duo, .wipe')) return;                  // those play as part of their figure
  if (v.closest('#failures')) {
    // The reel was shot with sound and the impacts are half of what it shows, so it takes
    // the gallery's own bar -- play, scrubber, clock and a sound button -- rather than the
    // browser's controls, which no other figure on the page uses.
    v.controls = false;
    const p = player(v, [[v]], { sound: true });
    v.addEventListener('click', () => p.toggle());
    controls(p, v);
    return;
  }
  const p = player(v, [[v]]);
  v.addEventListener('click', () => p.toggle());
  byHand(v, p);
});

// The film is started by hand and keeps the browser's controls, for its sound and full screen.
document.querySelectorAll('video[controls]:not([data-autoplay])').forEach((v) => player(v, [[v]], { auto: false }));

document.querySelectorAll('.duo').forEach((box) => {
  if (box.closest('.gallery')) return;
  const p = player(box, [[...box.querySelectorAll('.take video, .cam video')]]);
  duo(box, p);
  byHand(box, p);
});

// The results, one take at a time, picked from a strip of all of them under the box.
document.querySelectorAll('.gallery').forEach((g) => {
  const slides = [...g.querySelectorAll('.slide')];
  const p = player(g, slides.map((s) => [...s.querySelectorAll('.take video, .cam video')]), { sound: true });
  slides.forEach((s) => duo(s.querySelector('.duo'), p));
  const redraw = controls(p, g.querySelector('.slides'));
  const strip = document.createElement('div');
  strip.className = 'strip';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', 'Results');
  const tabs = slides.map((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.innerHTML = `<img src="${s.dataset.thumb}" alt="" width="400" height="225" loading="lazy" decoding="async"><span>${s.dataset.name}</span>`;
    b.addEventListener('click', () => pick(i));
    strip.append(b);
    return b;
  });
  g.append(strip);
  const pick = (i, first = false) => {
    slides.forEach((s, k) => { s.hidden = k !== i; });
    tabs.forEach((b, k) => {
      b.setAttribute('aria-selected', String(k === i));
      b.tabIndex = k === i ? 0 : -1;
    });
    if (first) return;
    p.select(i);
    redraw();
  };
  strip.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    const i = (tabs.indexOf(document.activeElement) + step + tabs.length) % tabs.length;
    tabs[i].focus();
    pick(i);
  });
  pick(0, true);
});

// --- the hero reel ---
// Its still is drawn with the page, and the reel is fetched once the rest has arrived -- or after
// 2.5 s on a slow line, where the load event can be minutes away.  It plays only while the teaser
// is on screen, so a link into the middle of the page fetches nothing for it.
const heroClip = document.querySelector('.hero-bg');
let heroReady = false, heroStart = 0;
const heroShown = () => scrollY < innerHeight * 0.85 * 0.99;      // where the page covers it
const syncHero = () => {
  clearTimeout(heroStart);
  if (!heroReady || reduced.matches || !heroShown()) {
    heroClip.pause();
    return;
  }
  if (heroClip.paused) heroStart = setTimeout(() => { attach(heroClip); heroClip.play().catch(() => {}); }, DWELL);
};
const heroArrives = () => { heroReady = true; syncHero(); };
addEventListener('load', heroArrives, { once: true });
setTimeout(heroArrives, 2500);

// --- nav: a border once you leave the hero, and the current section marked ---
const nav = document.getElementById('nav');
const links = [...document.querySelectorAll('#nav .links a')];
const sections = links
  .map((a) => document.querySelector(a.getAttribute('href')))
  .filter(Boolean);

const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    links.forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id));
  }
}, { rootMargin: '-45% 0px -50% 0px' });

sections.forEach((s) => spy.observe(s));

const heroEl = document.getElementById('top');          // not `top`: that name is already window.top
new IntersectionObserver(([e]) => nav.classList.toggle('stuck', !e.isIntersecting), { threshold: 0.02 })
  .observe(heroEl);

// --- things rise into place the first time they are seen ---
const rise = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in');
    rise.unobserve(e.target);
  }
}, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`;   // a short stagger inside a group
  rise.observe(el);
});

// --- the teaser gives way to the page: its text fades and it drifts as the first screen scrolls ---
const hero = document.querySelector('.hero');
const onScroll = () => {
  const p = Math.min(1, scrollY / Math.max(1, innerHeight * 0.85));
  hero.style.setProperty('--lift', p.toFixed(3));
  hero.style.setProperty('--fade', (1 - Math.min(1, p * 1.35)).toFixed(3));
  syncHero();
};
addEventListener('scroll', () => requestAnimationFrame(onScroll), { passive: true });
onScroll();

// The teaser has no resting place halfway: when the scrolling stops inside the handover, it
// settles on whichever end is nearer.
const mainTop = () => document.querySelector('main').offsetTop;
let settle;
addEventListener('scroll', () => {
  clearTimeout(settle);
  settle = setTimeout(() => {
    const end = mainTop();
    if (scrollY <= 4 || scrollY >= end - 4) return;
    scrollTo({ top: scrollY < end * 0.5 ? 0 : end, behavior: reduced.matches ? 'auto' : 'smooth' });
  }, 140);
}, { passive: true });

// A drag that survives the pointer leaving the box: the move and the release are listened for on
// the window.  A mouse acts from the press; a touch acts only once it moves, since a touch that the
// browser turns into a vertical scroll is cancelled and must leave the figure as it was.  `move`
// gets the pointer and the press, each normalised to the box.
function onDrag(stage, { start = () => {}, move }) {
  stage.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    const at = (m) => {
      const r = stage.getBoundingClientRect();
      const c = (v) => Math.min(1, Math.max(0, v));
      return [c((m.clientX - r.left) / r.width), c((m.clientY - r.top) / r.height)];
    };
    const p0 = at(e);
    start();
    if (e.pointerType === 'mouse') move(p0, p0);
    const mv = (m) => move(at(m), p0);
    const end = () => {
      removeEventListener('pointermove', mv);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  });
}

// --- the wipe: the same file plays twice, each copy clipped to its own side of the divider; the
//     divider follows the pointer or the arrow keys, Space plays or pauses, and the two copies
//     keep one clock ---
document.querySelectorAll('.wipe').forEach((fig) => {
  const stage = fig.querySelector('.stage');
  const [after, before] = stage.querySelectorAll('video');
  const p = player(stage, [[before, after]], { tol: 0.12 });
  let split = 50;
  const set = (x) => {
    split = Math.min(100, Math.max(0, x));
    stage.style.setProperty('--split', `${split.toFixed(1)}%`);
    stage.setAttribute('aria-valuenow', String(Math.round(split)));
  };
  stage.tabIndex = 0;
  stage.setAttribute('role', 'slider');
  stage.setAttribute('aria-label', 'Divider between the recorded and the edited image; Space plays or pauses');
  stage.setAttribute('aria-valuemin', '0');
  stage.setAttribute('aria-valuemax', '100');
  set(split);
  onDrag(stage, { move: ([x]) => set(x * 100) });
  stage.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      p.toggle();
      return;
    }
    const step = { ArrowLeft: -5, ArrowRight: 5 }[e.key];
    if (!step) return;
    e.preventDefault();
    set(split + step);
  });
});

// --- the warp: locoman's own training-time augmentation, run here as you drag.
//     For a point at normalised (x, y) and depth Z the interaction matrix gives
//       x' = -vx/Z + x vz/Z + x y wx - (1 + x^2) wy + y wz
//       y' = -vy/Z + y vz/Z + (1 + y^2) wx - x y wy - x wz
//     and the perturbed frame is the original sampled at q - (fx x', fy y').  Depth appears
//     only against the translation, so a camera that merely turns needs no depth map at all:
//     the whole thing is one fragment shader over the recorded frame. ---
document.querySelectorAll('.warp').forEach((fig) => {
  const stage = fig.querySelector('.stage');
  const cvs = stage.querySelector('canvas.gl');
  const svg = stage.querySelector('svg.frustum');
  const read = stage.querySelectorAll('.angle span');
  const hint = stage.querySelector('.hint');
  const fail = () => {
    fig.classList.remove('ready');
    hint.textContent = 'The live warp could not be loaded.';
  };
  const gl = cvs.getContext('webgl2', { antialias: false, alpha: false });
  const MAX = 20 * Math.PI / 180;                       // as far as the camera may be turned
  const K = { fx: 91.6465, fy: 91.6465, cx: 192, cy: 108, w: 384, h: 216 };
  let w = [0, 0, 0];                                    // the twist's rotation, camera frame

  if (!gl) { fail(); return; }

  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, `#version 300 es
    in vec2 p; out vec2 uv;
    void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    in vec2 uv; out vec4 col;
    uniform sampler2D src; uniform vec3 om; uniform vec4 k; uniform vec2 wh;
    void main(){
      vec2 q = vec2(uv.x, 1.0 - uv.y) * wh;            // pixel, origin top left
      float x = (q.x - k.z) / k.x, y = (q.y - k.w) / k.y;
      float dx = x * y * om.x - (1.0 + x * x) * om.y + y * om.z;
      float dy = (1.0 + y * y) * om.x - x * y * om.y - x * om.z;
      vec2 s = (q - vec2(k.x * dx, k.y * dy)) / wh;    // the scene point moved by the flow
      s = clamp(s, vec2(0.5) / wh, 1.0 - vec2(0.5) / wh);
      col = texture(src, s);   // the image was uploaded top row first, so t runs down with y
    }`));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.uniform4f(gl.getUniformLocation(prog, 'k'), K.fx, K.fy, K.cx, K.cy);
  gl.uniform2f(gl.getUniformLocation(prog, 'wh'), K.w, K.h);
  const uOm = gl.getUniformLocation(prog, 'om');

  // the inset: the recorded camera in grey, where it now points in orange, drawn as the deck does
  const FR = [[0, 0, 0], [-0.2, -0.1125, 0.25], [0.2, -0.1125, 0.25], [0.2, 0.1125, 0.25], [-0.2, 0.1125, 0.25]];
  const EDGES = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [2, 3], [3, 4], [4, 1]];
  const eye = [-0.75, -0.45, -0.55], tgt = [0, 0, 0.12], fv = 420;
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const norm = (a) => { const n = Math.hypot(...a); return a.map((v) => v / n); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const fwd = norm(sub(tgt, eye));
  const right = norm(cross(fwd, [0, -1, 0]));
  const Rv = [right, cross(fwd, right), fwd];
  const proj = (P) => {
    const c = Rv.map((r) => r.reduce((s, v, i) => s + v * (P[i] - eye[i]), 0));
    return [fv * c[0] / c[2] + 165, fv * c[1] / c[2] + 125];
  };
  const rot = (P, o) => {                               // Rodrigues, for the small angles here
    const th = Math.hypot(...o);
    if (th < 1e-9) return P;
    const a = o.map((v) => v / th), c = Math.cos(th), s = Math.sin(th);
    const d = a.reduce((t, v, i) => t + v * P[i], 0);
    const x = cross(a, P);
    return P.map((v, i) => v * c + x[i] * s + a[i] * d * (1 - c));
  };
  const poly = (pts, cls) =>
    EDGES.map(([a, b]) => `<line class="${cls}" x1="${pts[a][0].toFixed(1)}" y1="${pts[a][1].toFixed(1)}" x2="${pts[b][0].toFixed(1)}" y2="${pts[b][1].toFixed(1)}"/>`).join('');

  const draw = () => {
    gl.uniform3f(uOm, w[0], w[1], w[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    svg.innerHTML = poly(FR.map(proj), 'was') + poly(FR.map((P) => proj(rot(P, w))), 'now');
    const deg = (r) => `${Math.round(r * 180 / Math.PI)}°`;
    read[0].textContent = deg(w[0]);
    read[1].textContent = deg(w[1]);
  };

  // Until someone takes hold, the camera wanders, on screen and inside the 20 degrees of a drag.
  const phase = Array.from({ length: 4 }, () => Math.random() * 2 * Math.PI);
  let idle = !reduced.matches, raf = 0;
  const wander = (ms) => {
    if (!idle) return;
    const t = ms / 1000;
    const sway = (f, g, i) => 0.45 * MAX * (Math.sin(f * t + phase[i]) + 0.5 * Math.sin(g * t + phase[i + 1]));
    w = [sway(0.83, 0.31, 0), sway(0.61, 0.23, 2), 0];
    draw();
    raf = requestAnimationFrame(wander);
  };
  // The camera turned in any direction, 20 degrees at most.
  const turn = (wx, wy) => {
    const m = Math.hypot(wx, wy);
    if (m > MAX) { wx *= MAX / m; wy *= MAX / m; }
    idle = false;
    w = [wx, wy, 0];
    draw();
  };

  const img = new Image();
  img.onerror = fail;
  img.onload = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    gl.viewport(0, 0, cvs.width, cvs.height);
    draw();
    fig.classList.add('ready');
    stage.tabIndex = 0;
    stage.setAttribute('aria-label', 'The warped frame: arrow keys turn the camera');
    new IntersectionObserver(([e]) => {
      cancelAnimationFrame(raf);
      if (e.isIntersecting) raf = requestAnimationFrame(wander);
    }, { threshold: 0.15 }).observe(fig);
  };
  whenNear(fig, () => { img.src = stage.dataset.src; });

  // The pointer holds the picture, not the camera: drag right and the scene comes right, which
  // means the camera turned the other way.  The turn is the drag's, from where the camera was.
  let w0 = w;
  onDrag(stage, {
    start: () => { w0 = w; },
    move: ([x, y], [x0, y0]) => {
      if (fig.classList.contains('ready')) turn(w0[0] - (y - y0) * 2 * MAX, w0[1] - (x - x0) * 2 * MAX);
    },
  });
  const STEP = 2 * Math.PI / 180;
  stage.addEventListener('keydown', (e) => {
    const k = { ArrowUp: [STEP, 0], ArrowDown: [-STEP, 0], ArrowLeft: [0, STEP], ArrowRight: [0, -STEP] }[e.key];
    if (!k || !fig.classList.contains('ready')) return;
    e.preventDefault();
    turn(w[0] + k[0], w[1] + k[1]);
  });
});

// --- BibTeX ---
const copy = document.getElementById('copy');
copy?.addEventListener('click', async () => {
  await navigator.clipboard.writeText(document.getElementById('bib').textContent);
  copy.textContent = 'Copied';
  setTimeout(() => (copy.textContent = 'Copy'), 1400);
});

// --- The tracker scenes ---
// three.js and the robots together are heavier than the rest of the page, so none of it is
// fetched until the figure is watched, as a clip would start; the page reads the same without it.
// A machine with no GPU renders WebGL on the CPU, and these two scenes -- 33k triangles each,
// thirty transforms a frame -- peg it and take the whole tab with them.  Where that is what we
// would get, the scene is replaced by the recording of itself the page already carries.
const gpu = (() => {
  const gl = document.createElement('canvas').getContext('webgl2')
    || document.createElement('canvas').getContext('webgl');
  if (!gl) return false;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  return !/swiftshader|llvmpipe|software|microsoft basic/i.test(name);
})();

document.querySelectorAll('[data-lazy3d]').forEach((host) => onceWatched(host, () => {
  if (!gpu) {
    const r = host.dataset.robot || 'g1';
    host.innerHTML = `<video class="frame" autoplay muted loop playsinline`
      + ` poster="./static/images/tracker_${r}.jpg">`
      + `<source src="./static/videos/tracker_${r}.mp4" type='video/mp4; codecs="hvc1.2.4.L153.B0"'>`
      + `<source src="./static/videos/tracker_${r}.h264.mp4" type="video/mp4"></video>`;
    return;
  }
  import('./tracker3d.js?v=18')          // resolved against this script's own URL; versioned like the rest
    .then((m) => m.init(host))
    .catch((err) => {
      host.querySelector('.hint').textContent = 'The 3-D view could not be loaded.';
      console.error('[tracker3d]', err);
    });
}));
