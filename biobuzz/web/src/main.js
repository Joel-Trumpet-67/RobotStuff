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
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15181d);
scene.fog = new THREE.Fog(0x15181d, 9, 22);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302c, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2.5, 7, 3.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 1, far: 15 });
sun.shadow.bias = -0.0005;
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, 1, 0.03, 60);
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- state ----------
const input = new Input();
const settings = { alliance: 'red', start: 'alliance', mode: 'match' };
let assets, world, robot, match;
let running = false;
let camMode = 'chase'; // chase | driver | overhead
let fieldCentric = true;
let showAim = false;
let simTime = 0;
let intakeToggle = false;

const aimLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints(new Array(40).fill(0).map(() => new THREE.Vector3())),
  new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: 0.8 }),
);
aimLine.visible = false;
scene.add(aimLine);

// ---------- menu wiring ----------
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
$('to-menu').onclick = () => {
  $('results').classList.add('hidden');
  showMenu(false);
};

function showMenu(canResume) {
  $('menu').classList.remove('hidden');
  $('resume').classList.toggle('hidden', !canResume);
  running = false;
}

function setPaused(p) {
  if (p) showMenu(true);
  else {
    $('menu').classList.add('hidden');
    running = true;
    last = performance.now();
  }
}

// ---------- start positions (G304: own side, touching the wall, not in LZ/FLOWER) ----------
function startPose(alliance, where) {
  const W = world.wall;
  const h = robot.half.z + 0.003;
  const s = alliance === 'red' ? -1 : 1; // red is -X
  // face the field centre; robot forward is -Z at yaw 0
  const faceCentre = (x, z) => Math.atan2(x, z); // yaw so forward points from (x,z) to origin
  let x, z;
  if (where === 'alliance') { x = s * (W - h); z = 0; }
  else if (where === 'back') { x = s * 1.0; z = -(W - h); }
  else { x = s * 1.0; z = W - h; }
  // mirror so blue's "back"/"audience" picks are the same walls
  return { x, z, yaw: faceCentre(x, z) };
}

function driverAxes(alliance) {
  // Field-centric reference: "forward" points away from your ALLIANCE AREA.
  const s = alliance === 'red' ? 1 : -1;
  return { fwd: new THREE.Vector3(s, 0, 0), right: new THREE.Vector3(0, 0, s) };
}

// ---------- toasts / HUD ----------
function toast(text, color) {
  const d = document.createElement('div');
  d.className = `toast ${color}`;
  d.textContent = text;
  $('toasts').prepend(d);
  setTimeout(() => d.classList.add('fade'), 2200);
  setTimeout(() => d.remove(), 3000);
}

function fmt(secs) {
  if (secs == null) return '∞';
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let hudTimer = 0;
function updateHud(dt) {
  const c = match.clock;
  $('period').textContent = c.label;
  $('time').textContent = fmt(c.secs);
  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 0.25;
    const s = match.final || match.score();
    $('score-red').textContent = s.red.total;
    $('score-blue').textContent = s.blue.total;
    const a = settings.alliance;
    const lines = [
      `Intake: <b>${robot.intakeOn ? 'ON' : 'off'}</b>`,
      `Drive: <b>${fieldCentric ? 'field-centric' : 'robot-centric'}</b>`,
      `Camera: <b>${camMode}</b>`,
      `HIVE load: <b>${world.hiveLoad(a).toFixed(1)}</b> / ${CONFIG.hive.tipAt}`,
      `NECTAR in area: <b>${match.nectarPool[a]}</b> · can enter: <b>${match.nectarAllowed(a)}</b>`,
    ];
    $('status-lines').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  }
  const hop = $('hopper');
  const want = robot.hopper.map((p) => p.kind).join(',');
  if (hop.dataset.k !== want) {
    hop.dataset.k = want;
    hop.innerHTML = '';
    for (let i = 0; i < CONFIG.robot.hopperSize; i++) {
      const d = document.createElement('span');
      const p = robot.hopper[i];
      d.className = 'slot ' + (p ? p.kind : 'empty');
      hop.appendChild(d);
    }
  }
}

function showResults(s) {
  const a = settings.alliance;
  const rows = [
    ['LEAVE', 'leave', (v) => v],
    ['AUTO PARK', 'autoPark', (v) => v],
    ['HIVE TIPS (auto)', 'tipsAuto', (v) => `${v} × ${CONFIG.points.tip}`],
    ['HIVE TIPS (teleop)', 'tipsTeleop', (v) => `${v} × ${CONFIG.points.tip}`],
    ['Left in CELL', 'cell', (v) => v],
    ['FLOWER owned', 'flower', (v) => v],
    ['Bottom NECTAR bonus', 'bottomNectar', (v) => v],
    ['GARDEN', 'garden', (v) => v],
    ['TELEOP PARK', 'teleopPark', (v) => v],
  ];
  const tr = rows.map(([label, k, f]) => `<tr><td>${label}</td><td class="red">${f(s.red[k])}</td><td class="blue">${f(s.blue[k])}</td></tr>`).join('');
  const rp = s[a].rp;
  $('result-title').textContent = s.red.total === s.blue.total ? 'Tie' : (s.red.total > s.blue.total ? 'Red' : 'Blue') + ' wins';
  $('result-body').innerHTML = `
    <table class="breakdown"><tr><th></th><th class="red">Red</th><th class="blue">Blue</th></tr>${tr}
    <tr class="total"><td>Total</td><td class="red">${s.red.total}</td><td class="blue">${s.blue.total}</td></tr></table>
    <p class="rp">Your RP: SWARM ${rp.swarm ? '✔' : '✘'} · POLLINATOR 1 ${rp.pollinator1 ? '✔' : '✘'} · POLLINATOR 2 ${rp.pollinator2 ? '✔' : '✘'}</p>`;
  $('results').classList.remove('hidden');
  running = false;
}

// ---------- match setup ----------
function startMatch() {
  $('results').classList.add('hidden');
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  if (robot) robot.remove();
  world.build();
  robot = new Robot(world, assets, settings.alliance);
  const pose = startPose(settings.alliance, settings.start);
  robot.place(pose.x, pose.z, pose.yaw);

  // Pre-loads (§10.3.1): 4 POLLEN in our robot. The other three robots are absent,
  // so their pre-loads go in the centre of that ALLIANCE's LOADING ZONE against the wall.
  const r = CONFIG.pieces.pollen.radius;
  const mine = [];
  for (let i = 0; i < 4; i++) mine.push(world.addPiece('pollen', [0, -5 - i, 0]));
  robot.preload(mine);
  for (const color of ['red', 'blue']) {
    const lz = world.info.zones.loading[color];
    const sx = color === 'red' ? 1 : -1;
    const wallX = color === 'red' ? lz.x[0] : lz.x[1];
    const cz = (lz.z[0] + lz.z[1]) / 2;
    const robotsAbsent = color === settings.alliance ? 1 : 2;
    for (let row = 0; row < robotsAbsent; row++) {
      for (let i = 0; i < 4; i++) {
        world.addPiece('pollen', [wallX + sx * (r + 0.002 + row * 2 * r), r + 0.003, cz + (i - 1.5) * 2 * r * 1.02]);
      }
    }
  }

  match = new Match(world, robot, settings.alliance, settings.mode, { toast, end: showResults });
  camMode = 'chase';
  intakeToggle = false;
  input.queue.length = 0; // drop keys pressed while in the menu
  simTime = 0;
  snapCamera = true;
  running = true;
  last = performance.now();
}

// ---------- camera ----------
let snapCamera = true;
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
function updateCamera(dt) {
  const p = robot.position;
  const { fwd } = robot.axes();
  let pos, look;
  if (camMode === 'chase') {
    pos = p.clone().addScaledVector(fwd, -1.35).add(new THREE.Vector3(0, 0.95, 0));
    look = p.clone().addScaledVector(fwd, 0.7).add(new THREE.Vector3(0, 0.25, 0));
  } else if (camMode === 'driver') {
    const s = settings.alliance === 'red' ? -1 : 1;
    pos = new THREE.Vector3(s * 3.3, 1.65, 0);
    look = new THREE.Vector3(s * 0.4, 0.2, 0);
  } else {
    pos = new THREE.Vector3(0, 6.2, 0.01);
    look = new THREE.Vector3(0, 0, 0);
  }
  const k = snapCamera ? 1 : 1 - Math.exp(-dt * 6);
  camPos.lerp(pos, k);
  camLook.lerp(look, k);
  snapCamera = false;
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// ---------- loop ----------
let last = performance.now();
let acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!world || !robot) { renderer.render(scene, camera); return; }

  const inp = input.read();
  for (const a of inp.pressed) {
    if (a === 'pause') {
      if (!$('results').classList.contains('hidden')) continue;
      if (running) setPaused(true);
      else if (!$('resume').classList.contains('hidden')) setPaused(false);
      continue;
    }
    if (!running) continue;
    if (a === 'camera') camMode = { chase: 'driver', driver: 'overhead', overhead: 'chase' }[camMode];
    if (a === 'cam1') camMode = 'chase';
    if (a === 'cam2') camMode = 'driver';
    if (a === 'cam3') camMode = 'overhead';
    if (a === 'driveMode') fieldCentric = !fieldCentric;
    if (a === 'aim') showAim = !showAim;
    if (a === 'intake') intakeToggle = !intakeToggle;
  }

  if (running) {
    // drive command
    let f, s;
    if (fieldCentric) {
      const d = driverAxes(settings.alliance);
      const want = d.fwd.clone().multiplyScalar(inp.y).addScaledVector(d.right, inp.x);
      const { fwd, right } = robot.axes();
      f = want.dot(fwd);
      s = want.dot(right);
    } else {
      f = inp.y;
      s = inp.x;
    }
    robot.drive(f, s, inp.turn);
    robot.enabled = match.robotEnabled;
    robot.intakeOn = intakeToggle || inp.intakeHold;

    acc += dt;
    const h = 1 / CONFIG.physicsHz;
    while (acc >= h) {
      acc -= h;
      simTime += h;
      robot.step(h, simTime);
      const events = world.step();
      match.step(h, events);
    }

    if (inp.shootHive) robot.shoot(CONFIG.shooter.hive, simTime);
    else if (inp.shootFlower) robot.shoot(CONFIG.shooter.flower, simTime);
    if (inp.eject) robot.eject(simTime);

    world.sync();
    robot.sync(dt);
    updateHud(dt);
  }

  // aim preview (HIVE preset)
  aimLine.visible = showAim && running;
  if (aimLine.visible) {
    const { origin, vel } = robot.launchState(CONFIG.shooter.hive);
    const pts = aimLine.geometry.attributes.position;
    for (let i = 0; i < pts.count; i++) {
      const t = i * 0.03;
      pts.setXYZ(i, origin.x + vel.x * t, origin.y + vel.y * t - 4.905 * t * t, origin.z + vel.z * t);
    }
    pts.needsUpdate = true;
    aimLine.computeLineDistances();
  }

  updateCamera(dt);
  renderer.render(scene, camera);
}

// ---------- boot ----------
async function boot() {
  await RAPIER.init();
  const loader = new GLTFLoader();
  const [field, robotGltf, fieldInfo, robotInfo] = await Promise.all([
    loader.loadAsync('assets/field.glb'),
    loader.loadAsync('assets/robot.glb'),
    fetch('assets/field.json').then((r) => r.json()),
    fetch('assets/robot.json').then((r) => r.json()),
  ]);
  assets = { field: field.scene, robot: robotGltf.scene, fieldInfo, robotInfo };
  world = new World(scene, assets);
  world.build();
  // idle view behind the menu
  camera.position.set(-3.2, 2.6, 3.2);
  camera.lookAt(0, 0.3, 0);
  $('loading').classList.add('hidden');
  window.sim = { get world() { return world; }, get robot() { return robot; }, get match() { return match; }, CONFIG };
}

requestAnimationFrame(frame);
boot().catch((e) => {
  console.error(e);
  $('loading').querySelector('.panel').textContent = 'Failed to load: ' + e.message;
});
