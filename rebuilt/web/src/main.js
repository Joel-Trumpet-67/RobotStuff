import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import RAPIER from 'rapier';
import { CONFIG } from './config.js';
import { World } from './world.js';
import { Robot } from './robot.js';
import { Match } from './match.js';
import { Input } from './input.js';

const $ = (id) => document.getElementById(id);

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15181d);
scene.fog = new THREE.Fog(0x15181d, 18, 40);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302c, 1.15));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(3, 12, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 2048);
Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 6, bottom: -6, near: 1, far: 30 });
sun.shadow.bias = -0.0006;
scene.add(sun);

const camera = new THREE.PerspectiveCamera(58, 1, 0.05, 80);
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- state ----------
const input = new Input();
const settings = { alliance: 'red', start: 'center', mode: 'match' };
let assets, world, robot, match;
let running = false;
let camMode = 'follow'; // follow | driver | overhead
let fieldCentric = true;
let last = performance.now();
let acc = 0;
let snapCamera = true;

document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    settings[seg.dataset.name] = b.dataset.value;
  });
});
$('start').onclick = () => startMatch();
$('resume').onclick = () => setPaused(false);
$('again').onclick = () => startMatch();
$('to-menu').onclick = () => { $('results').classList.add('hidden'); showMenu(false); };

function showMenu(canResume) {
  $('menu').classList.remove('hidden');
  $('resume').classList.toggle('hidden', !canResume);
  running = false;
}
function setPaused(p) {
  if (p) return showMenu(true);
  $('menu').classList.add('hidden');
  running = true;
  last = performance.now();
}

/** Your DRIVER STATION looks down the field: red looks toward +X, blue toward -X. */
function allianceAxes(alliance) {
  const s = alliance === 'red' ? 1 : -1;
  return { fwd: new THREE.Vector3(s, 0, 0), right: new THREE.Vector3(0, 0, s) };
}

/** G303: BUMPERS overlap the ROBOT STARTING LINE, not touching a BUMP. */
function startPose(alliance, where) {
  const { fwd, right } = allianceAxes(alliance);
  const line = 4.2675; // centre of the 2 in starting-line tape (CAD)
  const back = line + robot.half - 0.03; // bumper front just over the line
  const lateral = { left: -3.3, center: 0, right: 3.3 }[where];
  const x = -fwd.x * back + right.x * lateral;
  const z = right.z * lateral;
  const yaw = Math.atan2(-fwd.x, -fwd.z); // face down the field
  return { x, z, yaw };
}

// ---------- HUD ----------
function toast(text, color) {
  const d = document.createElement('div');
  d.className = `toast ${color || ''}`;
  d.textContent = text;
  $('toasts').prepend(d);
  setTimeout(() => d.classList.add('fade'), 2400);
  setTimeout(() => d.remove(), 3200);
}
const fmt = (s) => (s == null ? '∞' : `${Math.floor(Math.ceil(Math.max(0, s)) / 60)}:${String(Math.ceil(Math.max(0, s)) % 60).padStart(2, '0')}`);

let hudTimer = 0;
function updateHud(dt) {
  const c = match.clock;
  $('period').textContent = c.label;
  $('time').textContent = fmt(c.secs);
  for (const color of ['red', 'blue']) {
    const on = match.mode === 'free' || match.hubActiveAt(color, match.t);
    $(`hub-${color}`).classList.toggle('active', on);
    $(`hub-${color}`).textContent = `${color.toUpperCase()} HUB ${on ? 'ACTIVE' : 'OFF'}`;
  }
  hudTimer -= dt;
  if (hudTimer > 0) return;
  hudTimer = 0.2;
  const s = match.final || match.score();
  $('score-red').textContent = s.red.total;
  $('score-blue').textContent = s.blue.total;
  const v = robot.body.linvel();
  $('status-lines').innerHTML = [
    `Team <b>${CONFIG.teamNumber}</b> · ${settings.alliance}`,
    `Speed: <b>${Math.hypot(v.x, v.z).toFixed(1)}</b> m/s`,
    `Drive: <b>${fieldCentric ? 'field-centric' : 'robot-centric'}</b>`,
    `FUEL in box: <b>${robot.hopperCount()}</b>`,
    `Intake: <b>${robot.slide > 1 ? (robot.rollerOn ? 'out · running' : 'out') : 'in'}</b>`,
    `Camera: <b>${camMode}</b>`,
  ].map((l) => `<div>${l}</div>`).join('');
}

function showResults(s) {
  const a = settings.alliance;
  const rows = [
    ['FUEL (AUTO)', 'fuelAuto'],
    ['FUEL (TELEOP)', 'fuelTeleop'],
    ['FUEL in inactive HUB (0 pts)', 'wasted'],
    ['TOWER', 'tower'],
  ];
  const tr = rows.map(([l, k]) => `<tr><td>${l}</td><td class="red">${s.red[k]}</td><td class="blue">${s.blue[k]}</td></tr>`).join('');
  const rp = s[a].rp;
  $('result-title').textContent = s.red.total === s.blue.total ? 'Tie' : `${s.red.total > s.blue.total ? 'Red' : 'Blue'} wins`;
  $('result-body').innerHTML = `
    <table class="breakdown"><tr><th></th><th class="red">Red</th><th class="blue">Blue</th></tr>${tr}
    <tr class="total"><td>Total</td><td class="red">${s.red.total}</td><td class="blue">${s.blue.total}</td></tr></table>
    <p class="rp">Your RP: ENERGIZED ${rp.energized ? '✔' : '✘'} · SUPERCHARGED ${rp.supercharged ? '✔' : '✘'} · TRAVERSAL ${rp.traversal ? '✔' : '✘'}</p>`;
  $('results').classList.remove('hidden');
  running = false;
}

// ---------- match ----------
function startMatch() {
  $('results').classList.add('hidden');
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  if (robot) robot.remove();
  world.build();
  robot = new Robot(world, settings.alliance);
  const pose = startPose(settings.alliance, settings.start);
  robot.place(pose.x, pose.z, pose.yaw);
  match = new Match(world, settings.mode, { toast, end: showResults });
  camMode = 'follow';
  input.queue.length = 0;
  snapCamera = true;
  acc = 0;
  running = true;
  last = performance.now();
}

// ---------- camera ----------
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
function updateCamera(dt) {
  const { fwd } = allianceAxes(settings.alliance);
  let pos, look;
  if (robot && camMode === 'follow') {
    // Fixed third person: behind the robot from your DRIVER STATION side, always looking
    // toward the opposing DRIVER STATION (does not turn with the robot).
    const p = robot.position;
    pos = p.clone().addScaledVector(fwd, -3.0).add(new THREE.Vector3(0, 2.3, 0));
    look = p.clone().addScaledVector(fwd, 2.2).add(new THREE.Vector3(0, 0.2, 0));
  } else if (camMode === 'driver') {
    pos = fwd.clone().multiplyScalar(-9.4).add(new THREE.Vector3(0, 1.75, 0));
    look = fwd.clone().multiplyScalar(-1).add(new THREE.Vector3(0, 0, 0));
  } else {
    pos = new THREE.Vector3(0, 15, 0.01);
    look = new THREE.Vector3(0, 0, 0);
  }
  const k = snapCamera ? 1 : 1 - Math.exp(-dt * 7);
  camPos.lerp(pos, k);
  camLook.lerp(look, k);
  snapCamera = false;
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// ---------- loop ----------
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!world || !robot) {
    renderer.render(scene, camera);
    return;
  }

  const inp = input.read();
  for (const a of inp.pressed) {
    if (a === 'pause') {
      if (!$('results').classList.contains('hidden')) continue;
      if (running) setPaused(true);
      else if (!$('resume').classList.contains('hidden')) setPaused(false);
      continue;
    }
    if (!running) continue;
    if (a === 'camera') camMode = { follow: 'driver', driver: 'overhead', overhead: 'follow' }[camMode];
    if (a === 'cam1') camMode = 'follow';
    if (a === 'cam2') camMode = 'driver';
    if (a === 'cam3') camMode = 'overhead';
    if (a === 'driveMode') fieldCentric = !fieldCentric;
    if (a === 'intakeIn') robot.retract();
  }

  if (running) {
    let dir;
    if (fieldCentric) {
      const { fwd, right } = allianceAxes(settings.alliance);
      dir = fwd.clone().multiplyScalar(inp.y).addScaledVector(right, inp.x);
    } else {
      const { fwd, right } = robot.axes();
      dir = fwd.clone().multiplyScalar(inp.y).addScaledVector(right, inp.x);
    }
    robot.drive(dir.x, dir.z, inp.turn);
    if (inp.intakeHold) robot.setIntake(true);
    else if (robot.rollerOn) robot.setIntake(false); // roller stops; slide stays out until X
    robot.enabled = match.robotEnabled;

    acc += dt;
    const h = 1 / CONFIG.physicsHz;
    let steps = 0;
    while (acc >= h && steps < 6) {
      acc -= h;
      steps++;
      robot.step(h);
      world.step();
      const events = world.stepHubs(match.t);
      match.step(h, events);
      if (!running) break;
    }
    if (steps === 6) acc = 0; // don't spiral if the machine can't keep up
    world.stepStrays(dt);
    world.sync();
    robot.sync(dt);
    updateHud(dt);
  }

  updateCamera(dt);
  renderer.render(scene, camera);
}

async function boot() {
  await RAPIER.init();
  const [field, fieldInfo] = await Promise.all([
    new GLTFLoader().loadAsync('assets/field.glb'),
    fetch('assets/field.json').then((r) => r.json()),
  ]);
  assets = { field: field.scene, fieldInfo };
  world = new World(scene, assets);
  world.build();
  camera.position.set(-10.5, 6, 7.5);
  camera.lookAt(0, 0, 0);
  $('loading').classList.add('hidden');
  window.sim = { get world() { return world; }, get robot() { return robot; }, get match() { return match; }, CONFIG };
}

requestAnimationFrame(frame);
boot().catch((e) => {
  console.error(e);
  $('loading').querySelector('.panel').textContent = 'Failed to load: ' + e.message;
});
