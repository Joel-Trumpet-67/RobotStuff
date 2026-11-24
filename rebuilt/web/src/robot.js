import * as THREE from 'three';
import RAPIER from 'rapier';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CONFIG } from './config.js';
import { G, groups } from './world.js';

const R = CONFIG.robot;
const HOP = CONFIG.hopper;
const IN = CONFIG.intake;
const FR = CONFIG.fuel.radius;
const NET = CONFIG.net;

/** Knotted diamond netting: thin dark cord on transparent. One tile = one diamond. */
function netTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#141518';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(0, 64); g.lineTo(64, 0); g.lineTo(128, 64); g.lineTo(64, 128); g.closePath();
  g.stroke();
  g.fillStyle = '#141518';
  for (const [x, y] of [[0, 64], [64, 0], [128, 64], [64, 128]]) { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Bumper fabric: alliance color with a subtle cordura weave. */
function fabricTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 2) {
    g.fillStyle = y % 4 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.05)';
    g.fillRect(0, y, 128, 1);
  }
  for (let i = 0; i < 900; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
    g.fillRect(Math.random() * 128, Math.random() * 128, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 1);
  return tex;
}

/** Team number decal (white, transparent background). */
function numberDecal(text) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d');
  g.font = '900 132px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.strokeText(text, 256, 86);
  g.fillStyle = '#ffffff';
  g.fillText(text, 256, 86);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Slide position (rotations) -> roller axle (forward distance, height) in robot frame. */
function rollerAt(slide) {
  const d = IN.extended - slide;
  return { out: IN.rollerOutAt60 - IN.outPerRot * d, up: IN.rollerUpAt60 - IN.risePerRot * d };
}

/**
 * Expanding hopper (254-style): the front wall rides out with the slide, just behind the
 * roller. The floor extension stops short of the wall, leaving a slot the roller lifts FUEL
 * up through.
 */
function hopperAt(slide) {
  const hs = HOP.size / 2;
  const roller = rollerAt(slide);
  const wallOut = Math.max(hs, roller.out - 0.014);
  const floorEnd = Math.max(hs, wallOut - 2 * FR - 0.02);
  return { hs, roller, wallOut, floorEnd };
}

/**
 * Swerve chassis + bumpers + open-top FUEL box + over-the-bumper slide intake.
 * Robot faces -Z locally; the intake end is the front.
 */
export class Robot {
  constructor(world, alliance) {
    this.world = world;
    this.alliance = alliance;
    this.half = R.frame / 2 + R.bumperThick;
    this.group = new THREE.Group();
    world.scene.add(this.group);

    // ---- materials ----
    const M = (o) => new THREE.MeshStandardMaterial(o);
    const frameMat = M({ color: 0x343a42, metalness: 0.55, roughness: 0.42 }); // powder-coated tube
    const alu = M({ color: 0xc9ced6, metalness: 0.85, roughness: 0.32 });
    const aluDark = M({ color: 0x8d949e, metalness: 0.8, roughness: 0.38 });
    const black = M({ color: 0x15161a, roughness: 0.55, metalness: 0.2 });
    const rubber = M({ color: 0x1b1c1f, roughness: 0.95 });
    const pan = M({ color: 0x1f2227, roughness: 0.8, metalness: 0.1 });
    const poly = M({ color: 0xd8e8f6, transparent: true, opacity: 0.16, roughness: 0.08, metalness: 0.0, depthWrite: false, side: THREE.DoubleSide });
    const hdpe = M({ color: 0x2c3038, roughness: 0.75 });
    const bumperHex = alliance === 'red' ? '#c42a20' : '#1f4fbf';
    const fabric = M({ map: fabricTexture(bumperHex), roughness: 0.92 });
    const add = (geo, mat, x, y, z, parent = this.group, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    const box = (w, h, d, mat, x, y, z, parent, shadow) => add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, parent, shadow);

    // ---- frame: 2x1 tube perimeter, cross member, corner gussets, belly pan ----
    const fh = R.frame / 2;
    const tube = 0.0254, tubeH = 0.0508, frameY = 0.078;
    box(R.frame, tubeH, tube, frameMat, 0, frameY, fh - tube / 2);
    box(R.frame, tubeH, tube, frameMat, 0, frameY, -fh + tube / 2);
    box(tube, tubeH, R.frame - 2 * tube, frameMat, fh - tube / 2, frameY, 0);
    box(tube, tubeH, R.frame - 2 * tube, frameMat, -fh + tube / 2, frameY, 0);
    box(R.frame - 2 * tube, tubeH, tube, frameMat, 0, frameY, 0.06);
    box(R.frame - 0.01, 0.003, R.frame - 0.01, pan, 0, frameY - tubeH / 2 - 0.0015, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const gus = box(0.09, 0.003, 0.09, alu, sx * (fh - 0.045), frameY + tubeH / 2 + 0.0015, sz * (fh - 0.045));
      gus.rotation.y = Math.PI / 4;
    }
    // electronics on the belly pan (visible between bumpers and the hopper floor)
    box(0.18, 0.075, 0.075, black, -0.12, 0.095, 0.2); // battery
    box(0.05, 0.02, 0.03, M({ color: 0xc23b2e, roughness: 0.6 }), -0.12, 0.14, 0.2);
    box(0.16, 0.035, 0.1, M({ color: 0xe6e6e6, roughness: 0.5 }), 0.13, 0.072, 0.18); // controller
    box(0.13, 0.03, 0.09, M({ color: 0xd9682b, roughness: 0.55 }), 0.13, 0.07, -0.05); // power hub

    // ---- bumpers: rounded fabric segments, team number on every side ----
    const bt = R.bumperThick, bh = R.bumperHeight, by = R.bumperBottom + bh / 2;
    const outer = R.frame + 2 * bt;
    const decal = M({ map: numberDecal(CONFIG.teamNumber), transparent: true, roughness: 0.8, depthWrite: false });
    for (const s of [
      { w: outer, d: bt, x: 0, z: -(fh + bt / 2), n: [0, 0, -1] },
      { w: outer, d: bt, x: 0, z: fh + bt / 2, n: [0, 0, 1] },
      { w: bt, d: R.frame, x: fh + bt / 2, z: 0, n: [1, 0, 0] },
      { w: bt, d: R.frame, x: -(fh + bt / 2), z: 0, n: [-1, 0, 0] },
    ]) {
      add(new RoundedBoxGeometry(s.w, bh, s.d, 3, 0.022), fabric, s.x, by, s.z);
      const n = new THREE.Vector3(...s.n);
      const off = Math.min(s.w, s.d) / 2 + 0.0015;
      const label = add(new THREE.PlaneGeometry(0.34, 0.106), decal, s.x + n.x * off, by, s.z + n.z * off, this.group, false);
      label.lookAt(label.position.clone().add(n));
    }

    // ---- swerve modules ----
    this.modules = [];
    const mo = fh - R.moduleInset;
    const treadGeo = new THREE.CylinderGeometry(R.wheelRadius, R.wheelRadius, 0.038, 28);
    const hubGeo = new THREE.CylinderGeometry(R.wheelRadius * 0.62, R.wheelRadius * 0.62, 0.04, 20);
    for (const [x, z] of [[-mo, -mo], [mo, -mo], [-mo, mo], [mo, mo]]) {
      add(new RoundedBoxGeometry(0.125, 0.012, 0.125, 2, 0.01), alu, x, 0.112, z); // top plate
      add(new RoundedBoxGeometry(0.11, 0.035, 0.11, 2, 0.01), black, x, 0.09, z); // housing
      for (const [ox, oz, h] of [[0.026, 0.026, 0.085], [-0.026, -0.026, 0.07]]) { // drive + steer motors
        add(new THREE.CylinderGeometry(0.03, 0.03, h, 24), black, x + ox, 0.118 + h / 2, z + oz);
        add(new THREE.CylinderGeometry(0.031, 0.031, 0.008, 24), aluDark, x + ox, 0.122, z + oz);
      }
      const steer = new THREE.Group();
      steer.position.set(x, R.wheelRadius, z);
      this.group.add(steer);
      const roll = new THREE.Group();
      const tread = new THREE.Mesh(treadGeo, rubber);
      tread.rotation.z = Math.PI / 2;
      tread.castShadow = true;
      const hub = new THREE.Mesh(hubGeo, alu);
      hub.rotation.z = Math.PI / 2;
      roll.add(tread, hub);
      for (let i = 0; i < 3; i++) { // spokes so you can see it roll
        const sp = new THREE.Mesh(new THREE.BoxGeometry(0.041, 0.008, R.wheelRadius * 1.1), black);
        sp.rotation.x = (i / 3) * Math.PI;
        roll.add(sp);
      }
      steer.add(roll);
      this.modules.push({ x, z, steer, roll, angle: 0 });
    }

    // ---- FUEL box: HDPE floor, polycarb walls in an aluminum angle frame ----
    const hs = HOP.size / 2, hh = HOP.top - HOP.floorY;
    const edge = 0.02;
    box(HOP.size, 0.008, HOP.size, hdpe, 0, HOP.floorY, 0);
    for (const [x, z, w, d] of [[0, hs, HOP.size, 0.004], [-hs, 0, 0.004, HOP.size], [hs, 0, 0.004, HOP.size]]) {
      box(w, hh, d, poly, x, HOP.floorY + hh / 2, z, this.group, false);
    }
    for (const x of [-hs, hs]) box(edge, hh, edge, alu, x, HOP.floorY + hh / 2, hs); // back posts
    for (const x of [-hs, hs]) box(edge, hh * 0.98, edge * 0.8, aluDark, x, HOP.floorY + hh / 2, 0); // mid posts
    box(HOP.size + edge, edge, edge, alu, 0, HOP.top, hs); // back top rail
    box(HOP.size + edge, edge, edge, alu, 0, HOP.floorY + 0.01, hs); // back bottom rail
    for (const x of [-hs, hs]) {
      box(edge, edge, HOP.size, alu, x, HOP.top, 0); // side top rails
      box(edge, edge, HOP.size, alu, x, HOP.floorY + 0.01, 0); // side bottom rails
    }

    // Moving parts of the expanding hopper (resized/positioned every frame in sync())
    this.hopVis = {
      front: box(HOP.size, hh, 0.004, poly, 0, HOP.floorY + hh / 2, -hs, this.group, false),
      frontRail: box(HOP.size + 2 * edge, edge, edge, alu, 0, HOP.top, -hs),
      floor: box(HOP.size, 0.008, 1, hdpe, 0, HOP.floorY, -hs),
      sides: [-1, 1].map((s) => box(0.004, hh, 1, poly, s * (hs + 0.012), HOP.floorY + hh / 2, -hs, this.group, false)),
      rails: [-1, 1].map((s) => box(edge * 0.8, edge * 0.8, 1, aluDark, s * (hs + 0.014), HOP.top - 0.016, -hs)),
    };
    // front posts ride with the front wall
    this.hopVis.frontPosts = [-1, 1].map((s) => box(edge, hh, edge, alu, s * hs, HOP.floorY + hh / 2, -hs));

    // ---- net: diamond netting on a thin black frame, flared out a little, with a roof ----
    const netTex = netTexture();
    this.netVis = [0, 1, 2, 3, 4].map(() => {
      const t = netTex.clone();
      t.needsUpdate = true;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        M({ map: t, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.95 }));
      this.group.add(m);
      return m;
    });
    const cord = M({ color: 0x0f1012, roughness: 0.6, metalness: 0.3 });
    const rodGeo = new THREE.CylinderGeometry(0.005, 0.005, 1, 8);
    this.netFrame = [0, 1, 2, 3].map(() => {
      const m = new THREE.Mesh(rodGeo, cord);
      m.castShadow = true;
      this.group.add(m);
      return m;
    });

    // ---- scoop: two angled funnel plates (polycarb with aluminum edge) ----
    const scoopMat = M({ color: 0xaeb6c0, metalness: 0.6, roughness: 0.35 });
    this.scoopVis = [-1, 1].map(() => box(0.005, 0.13, 1, scoopMat, 0, 0.08, 0));

    // ---- slide intake: rack arms, roller with compliant wheels, scoop bars ----
    this.slideGroup = new THREE.Group();
    this.group.add(this.slideGroup);
    const armLen = 0.42;
    for (const x of [-(IN.width / 2 + 0.012), IN.width / 2 + 0.012]) {
      const arm = box(0.0127, 0.045, armLen, aluDark, x, 0.0, armLen / 2 - 0.02, this.slideGroup);
      arm.rotation.x = THREE.MathUtils.degToRad(-5);
      box(0.0063, 0.06, 0.15, alu, x * 0.985, -0.012, -0.03, this.slideGroup); // scoop plate
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 16), black, x, 0, 0, this.slideGroup).rotation.z = Math.PI / 2; // bearing
    }
    this.roller = new THREE.Group();
    this.slideGroup.add(this.roller);
    const shaft = add(new THREE.CylinderGeometry(0.008, 0.008, IN.width, 10), alu, 0, 0, 0, this.roller);
    shaft.rotation.z = Math.PI / 2;
    const cw = M({ color: 0x2f9e44, roughness: 0.85 });
    const cwGeo = new THREE.CylinderGeometry(IN.rollerRadius, IN.rollerRadius, 0.022, 14);
    const nWheels = 11;
    for (let i = 0; i < nWheels; i++) { // compliant wheels along the shaft
      const w = add(cwGeo, cw, -IN.width / 2 + 0.02 + (i * (IN.width - 0.04)) / (nWheels - 1), 0, 0, this.roller);
      w.rotation.z = Math.PI / 2;
      w.rotation.x = i * 0.7; // stagger so spin reads
    }
    const barGeo = new THREE.CylinderGeometry(0.0064, 0.0064, IN.width, 6);
    // low bar: ~5 mm ahead of the axle, 27 mm lower (bottom at 141 mm when extended); high bar up the short leg
    add(barGeo, alu, 0, -0.027, -0.035, this.slideGroup).rotation.z = Math.PI / 2;
    add(barGeo, alu, 0, 0.015, -0.05, this.slideGroup).rotation.z = Math.PI / 2;

    this.transit = []; // FUEL travelling up over the bumper
    this.lastGrab = -1;
    this.time = 0;
    this.slide = 0; // rotations
    this.slideTarget = 0;
    this.rollerOn = false;
    this.cmd = { vx: 0, vz: 0, w: 0 };
    this.enabled = true;
  }

  place(x, z, yaw) {
    if (this.body) this.world.physics.removeRigidBody(this.body);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = this.world.physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, 0.002, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setAngularDamping(3)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    const W = this.world.physics;
    const slick = (d) => d.setFriction(0.05).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    // Chassis + bumpers (top just above the bumpers), riding on four frictionless wheel spheres
    const bottom = 0.06, top = R.bumperBottom + R.bumperHeight + 0.012;
    const halfH = (top - bottom) / 2, r = 0.02;
    W.createCollider(slick(RAPIER.ColliderDesc.roundCuboid(this.half - r, halfH - r, this.half - r, r))
      .setTranslation(0, bottom + halfH, 0).setMass(R.mass * 0.85).setRestitution(0.1), this.body);
    for (const m of this.modules) {
      W.createCollider(RAPIER.ColliderDesc.ball(R.wheelRadius).setTranslation(m.x, R.wheelRadius, m.z)
        .setMass((R.mass * 0.1) / 4).setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setCollisionGroups(groups(G.ROBOT, G.FIELD)), this.body);
    }
    // Arcade: an invisible skirt under the bumpers that only touches FUEL, so FUEL is always
    // pushed aside and can never get under the robot (no beaching / ball surfing).
    W.createCollider(RAPIER.ColliderDesc.cuboid(this.half, 0.03, this.half).setTranslation(0, 0.035, 0)
      .setMass(0.1).setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setCollisionGroups(groups(G.ROBOT, G.FUEL)), this.body);
    // FUEL box: floor + four walls (thick enough that FUEL can't tunnel)
    const hs = HOP.size / 2, t = HOP.wall, hh = (HOP.top - HOP.floorY) / 2;
    W.createCollider(RAPIER.ColliderDesc.cuboid(hs, t / 2, hs).setTranslation(0, HOP.floorY - t / 2, 0)
      .setMass(R.mass * 0.05).setFriction(0.5), this.body);
    for (const [x, z, sx, sz] of [[0, hs - t / 2, hs, t / 2], [-hs + t / 2, 0, t / 2, hs], [hs - t / 2, 0, t / 2, hs]]) {
      W.createCollider(RAPIER.ColliderDesc.cuboid(sx, hh, sz).setTranslation(x, HOP.floorY + hh, z)
        .setMass(0.1).setFriction(0.3), this.body);
    }
    // Moving hopper parts: front wall, floor extension, side extensions
    const mk = () => W.createCollider(RAPIER.ColliderDesc.cuboid(0.01, 0.01, 0.01).setMass(0.05).setFriction(0.3), this.body);
    this.hopCol = { front: mk(), floor: mk(), left: mk(), right: mk() };
    this.netCol = [0, 1, 2, 3, 4].map(() => W.createCollider(
      RAPIER.ColliderDesc.cuboid(0.01, 0.01, 0.005).setMass(0.02).setFriction(0.2)
        .setCollisionGroups(groups(G.ROBOT, G.FUEL)), this.body)); // net only stops FUEL
    this.scoopCol = [-1, 1].map(() => W.createCollider(
      RAPIER.ColliderDesc.cuboid(0.003, 0.065, 0.01).setMass(0.05).setFriction(0.1)
        .setCollisionGroups(groups(G.ROBOT, G.FUEL)), this.body)); // only touches FUEL
    this.slide = this.slideTarget = 0;
    this.updateHopper();
    this.sync(0);
  }

  /** Move/resize the expanding-hopper colliders to match the slide. */
  updateHopper() {
    const { hs, wallOut, floorEnd } = hopperAt(this.slide);
    const t = HOP.wall, hh = (HOP.top - HOP.floorY) / 2;
    const c = this.hopCol;
    c.front.setHalfExtents({ x: hs + t, y: hh, z: t / 2 });
    c.front.setTranslationWrtParent({ x: 0, y: HOP.floorY + hh, z: -(wallOut + t / 2) });
    const fl = Math.max(0.002, (wallOut - hs) / 2); // closed floor: FUEL can't fall back out the slot
    c.floor.setHalfExtents({ x: hs, y: t / 2, z: fl });
    c.floor.setTranslationWrtParent({ x: 0, y: HOP.floorY - t / 2, z: -(hs + fl) });
    const sl = Math.max(0.002, (wallOut - hs) / 2);
    for (const [col, s] of [[c.left, -1], [c.right, 1]]) {
      col.setHalfExtents({ x: t / 2, y: hh, z: sl });
      col.setTranslationWrtParent({ x: s * (hs - t / 2), y: HOP.floorY + hh, z: -(hs + sl) });
    }
    this.netPanels().forEach((p, i) => {
      const col = this.netCol[i];
      col.setHalfExtents({ x: p.len / 2, y: p.slant / 2, z: 0.006 });
      col.setTranslationWrtParent(p.center);
      col.setRotationWrtParent(p.quat);
    });
    this.scoopCol.forEach((col, i) => {
      const p = this.scoopPlate(i ? 1 : -1);
      col.setEnabled(p.on);
      col.setHalfExtents({ x: 0.003, y: 0.065, z: p.len / 2 });
      col.setTranslationWrtParent({ x: p.cx, y: 0.08, z: p.cz });
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
      col.setRotationWrtParent({ x: q.x, y: q.y, z: q.z, w: q.w });
    });
  }

  /** Net panels (robot frame): base on the top edge of each box wall, top leaning out a little. */
  netPanels() {
    const { hs, wallOut } = hopperAt(this.slide);
    const h = NET.height, fl = NET.flare;
    const slant = Math.hypot(h, fl);
    const tilt = Math.atan2(fl, h);
    const panels = [
      { bx: 0, bz: hs, nx: 0, nz: 1, len: HOP.size }, // back
      { bx: 0, bz: -wallOut, nx: 0, nz: -1, len: HOP.size }, // front (moves with the slide)
      { bx: -hs, bz: (hs - wallOut) / 2, nx: -1, nz: 0, len: hs + wallOut }, // left
      { bx: hs, bz: (hs - wallOut) / 2, nx: 1, nz: 0, len: hs + wallOut }, // right
    ];
    const out = panels.map((p) => {
      const e = new THREE.Euler(tilt, Math.atan2(p.nx, p.nz), 0, 'YXZ');
      const quat = new THREE.Quaternion().setFromEuler(e);
      const center = { x: p.bx + p.nx * fl / 2, y: HOP.top + h / 2, z: p.bz + p.nz * fl / 2 };
      return { center, quat, euler: e, len: p.len, slant };
    });
    // Roof: net over the whole top, so FUEL can't fly out
    const roofE = new THREE.Euler(-Math.PI / 2, 0, 0);
    out.push({
      center: { x: 0, y: HOP.top + h, z: (hs - wallOut) / 2 },
      quat: new THREE.Quaternion().setFromEuler(roofE),
      euler: roofE,
      len: HOP.size + 2 * fl, // across
      slant: hs + wallOut + 2 * fl, // front to back
    });
    return out;
  }

  /**
   * Scoop side plate (robot frame), a funnel: full bumper width out at the front of the
   * scoop, narrowing to the roller's width at the bumper face, so FUEL that hits anywhere
   * across the front gets guided into the pocket under the roller.
   */
  scoopPlate(side) {
    const roller = rollerAt(this.slide);
    const ax = side * (this.half - 0.01), az = -(roller.out + 0.02); // wide mouth, out front
    const bx = side * (IN.width / 2 - 0.01), bz = -(this.half + 0.005); // narrow end at the bumper
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    return { on: roller.out > this.half + 0.06, cx: (ax + bx) / 2, cz: (az + bz) / 2, len, yaw: Math.atan2(dx, dz) };
  }

  get position() {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  get quaternion() {
    const r = this.body.rotation();
    return new THREE.Quaternion(r.x, r.y, r.z, r.w);
  }

  get yaw() {
    return new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ').y;
  }

  axes() {
    const y = this.yaw;
    return { fwd: new THREE.Vector3(-Math.sin(y), 0, -Math.cos(y)), right: new THREE.Vector3(Math.cos(y), 0, -Math.sin(y)) };
  }

  /** world point -> robot local (full 3D pose) */
  toLocal(p) {
    return new THREE.Vector3(p.x, p.y, p.z).sub(this.position).applyQuaternion(this.quaternion.invert());
  }

  toWorld(x, y, z) {
    return new THREE.Vector3(x, y, z).applyQuaternion(this.quaternion).add(this.position);
  }

  drive(vx, vz, turn) {
    const v = new THREE.Vector2(vx, vz).multiplyScalar(R.maxSpeed);
    let w = -turn * R.maxTurn;
    const rMod = Math.hypot(R.frame / 2 - R.moduleInset, R.frame / 2 - R.moduleInset);
    const peak = v.length() + Math.abs(w) * rMod;
    if (peak > R.maxSpeed) {
      const k = R.maxSpeed / peak;
      v.multiplyScalar(k);
      w *= k;
    }
    this.cmd = { vx: v.x, vz: v.y, w };
  }

  /** intakeHeld: extend + run roller (LT / Shift). retract(): bring the slide in (X). */
  setIntake(held) {
    if (held) this.slideTarget = IN.extended;
    this.rollerOn = held;
  }

  retract() {
    this.slideTarget = 0;
    this.rollerOn = false;
  }

  step(dt) {
    const tgt = this.enabled ? this.cmd : { vx: 0, vz: 0, w: 0 };
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const a = R.accel * dt;
    const dvx = tgt.vx - lv.x, dvz = tgt.vz - lv.z;
    const dl = Math.hypot(dvx, dvz);
    const k = dl > a ? a / dl : 1;
    const dw = tgt.w - av.y;
    this.body.setLinvel({ x: lv.x + dvx * k, y: lv.y, z: lv.z + dvz * k }, true);
    this.body.setAngvel({ x: av.x, y: av.y + Math.sign(dw) * Math.min(Math.abs(dw), R.turnAccel * dt), z: av.z }, true);

    this.time += dt;
    this.stepTransit(dt);
    if (!this.enabled) return;
    const ds = this.slideTarget - this.slide;
    this.slide += Math.sign(ds) * Math.min(Math.abs(ds), IN.speed * dt);
    if (ds !== 0) this.updateHopper();
    if (this.rollerOn) this.runIntake(); // game rule: running intake grabs at any slide position
  }

  /**
   * FUEL in the pocket between the bumper face and the roller gets pulled over the bumper
   * and dropped into the box — if there's room at the drop point (physics decides capacity).
   */
  runIntake() {
    const roller = rollerAt(this.slide);
    const face = this.half;
    const hs = HOP.size / 2 - HOP.wall;
    for (const f of this.world.fuel) {
      if (!f.body) continue;
      const l = this.toLocal(f.body.translation());
      const out = -l.z; // forward distance
      // Arcade: anything touching the front of the robot, across the full bumper width, while
      // the intake runs. The scoop "pushes it up into the roller" even when it physically wouldn't.
      const reach = Math.max(roller.out + 0.04, face + 2 * FR + 0.03);
      if (out < face - 0.01 || out > reach || Math.abs(l.x) > this.half || l.y > 0.25) continue;
      if (this.time - this.lastGrab < IN.minGap) return;
      const spot = this.findDropSpot();
      if (!spot) return; // box is full
      this.lastGrab = this.time;
      this.world.physics.removeRigidBody(f.body);
      f.body = null;
      // Path (robot frame), cubic Bezier. Slide out: straight up behind the roller through the
      // slot at the front of the hopper floor. Slide in: up the front, over the bumper and the
      // box's front wall.
      const { hs: hopHalf, wallOut } = hopperAt(this.slide);
      const p0 = l.clone();
      const p3 = new THREE.Vector3(spot.x, spot.y, spot.z);
      let c1, c2;
      if (wallOut > hopHalf + 2 * FR) {
        const slotZ = -(wallOut - FR - 0.01);
        c1 = new THREE.Vector3(l.x * 0.8, HOP.floorY, slotZ);
        c2 = new THREE.Vector3(spot.x, HOP.floorY + FR + 0.12, slotZ);
      } else {
        c1 = new THREE.Vector3(l.x * 0.8, R.bumperBottom + R.bumperHeight + FR + 0.05, -(face + FR));
        c2 = new THREE.Vector3(spot.x, HOP.top + FR + 0.1, -(hopHalf + 0.03));
      }
      this.transit.push({ f, t: 0, p0, c1, c2, p3 });
      f.anim = this.toWorld(p0.x, p0.y, p0.z);
    }
  }

  stepTransit(dt) {
    const done = [];
    for (const tr of this.transit) {
      tr.t = Math.min(1, tr.t + dt / IN.transferTime);
      const u = tr.t, v = 1 - u;
      const p = tr.p0.clone().multiplyScalar(v * v * v)
        .addScaledVector(tr.c1, 3 * v * v * u)
        .addScaledVector(tr.c2, 3 * v * u * u)
        .addScaledVector(tr.p3, u * u * u);
      tr.f.anim = this.toWorld(p.x, p.y, p.z);
      if (tr.t >= 1) done.push(tr);
    }
    for (const tr of done) {
      this.transit.splice(this.transit.indexOf(tr), 1);
      const w = tr.f.anim;
      const lv = this.body.linvel();
      tr.f.body = this.world.makeFuelBody([w.x, w.y, w.z], [lv.x, lv.y - 0.6, lv.z]);
      tr.f.anim = null;
    }
  }

  /**
   * Find a free spot anywhere in the box: fill the floor (front to back), then the next layer
   * up, and so on up to the net. Returns null only when the box is truly full.
   */
  findDropSpot() {
    const { hs, wallOut } = hopperAt(this.slide);
    const t = HOP.wall;
    const xMax = hs - t - FR - 0.005;
    const zFront = -(wallOut - t - FR - 0.005), zBack = hs - t - FR - 0.005;
    const yTop = HOP.top + NET.height - FR;
    // FUEL near the robot, in robot coordinates (plus spots already claimed by FUEL in transit)
    const near = [];
    const pos = this.position;
    for (const f of this.world.fuel) {
      if (!f.body) continue;
      const w = f.body.translation();
      if ((w.x - pos.x) ** 2 + (w.z - pos.z) ** 2 > 1.5) continue;
      near.push(this.toLocal(w));
    }
    for (const tr of this.transit) near.push(tr.p3);
    const d2 = (2 * FR - 0.004) ** 2;
    const free = (x, y, z) => near.every((n) => (n.x - x) ** 2 + (n.y - y) ** 2 + (n.z - z) ** 2 >= d2);
    // Layers are offset by half a ball so each one nests in the hollows of the one below
    // (stacked-oranges packing), and each layer also tries a half-step offset grid to use gaps.
    const step = 2 * FR;
    let layer = 0;
    for (let y = HOP.floorY + FR + 0.01; y <= yTop; y += step * 0.72, layer++) {
      for (const off of layer % 2 ? [FR, 0] : [0, FR]) {
        for (let z = zFront + off; z <= zBack + 1e-6; z += step) {
          const xs = [];
          for (let x = -xMax + off; x <= xMax + 1e-6; x += step) xs.push(x);
          xs.sort(() => Math.random() - 0.5); // keep the pile even side to side
          for (const x of xs) if (free(x, y, z)) return { x, y, z };
        }
      }
    }
    return null;
  }

  /** FUEL currently inside the box volume */
  hopperCount() {
    const { hs, wallOut } = hopperAt(this.slide);
    let n = 0;
    for (const f of this.world.fuel) {
      if (!f.body) continue;
      const l = this.toLocal(f.body.translation());
      if (Math.abs(l.x) < hs && l.z < hs && l.z > -wallOut && l.y > HOP.floorY - 0.01 && l.y < HOP.top + NET.height + 0.05) n++;
    }
    return n + this.transit.length;
  }

  sync(dt) {
    if (!this.body) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    this.group.position.set(t.x, t.y, t.z);
    this.group.quaternion.set(r.x, r.y, r.z, r.w);

    const roller = rollerAt(this.slide);
    this.slideGroup.position.set(0, roller.up, -roller.out);
    const { hs, wallOut, floorEnd } = hopperAt(this.slide);
    const hv = this.hopVis;
    hv.front.position.z = hv.frontRail.position.z = -wallOut;
    const fl = Math.max(0.001, floorEnd - hs);
    hv.floor.scale.z = fl;
    hv.floor.position.z = -(hs + fl / 2);
    const sl = Math.max(0.001, wallOut - hs);
    for (const m of [...hv.sides, ...hv.rails]) {
      m.scale.z = sl;
      m.position.z = -(hs + sl / 2);
      m.visible = sl > 0.005;
    }
    hv.floor.visible = fl > 0.005;
    const cell = 0.045; // ~1.75 in netting
    this.netPanels().forEach((p, i) => {
      const m = this.netVis[i];
      m.position.set(p.center.x, p.center.y, p.center.z);
      m.rotation.copy(p.euler);
      m.scale.set(p.len, p.slant, 1);
      m.material.map.repeat.set(p.len / cell, p.slant / cell);
    });
    // black frame rods around the roof edge
    {
      const fl = NET.flare, y = HOP.top + NET.height;
      const zb = hs + fl, zf = -(wallOut + fl), xs = hs + fl;
      const [front, back, left, right] = this.netFrame;
      for (const [m, z] of [[front, zf], [back, zb]]) {
        m.position.set(0, y, z); m.rotation.set(0, 0, Math.PI / 2); m.scale.y = 2 * xs;
      }
      for (const [m, x] of [[left, -xs], [right, xs]]) {
        m.position.set(x, y, (zb + zf) / 2); m.rotation.set(Math.PI / 2, 0, 0); m.scale.y = zb - zf;
      }
    }
    for (const m of hv.frontPosts) m.position.z = -wallOut;
    this.scoopVis.forEach((m, i) => {
      const p = this.scoopPlate(i ? 1 : -1);
      m.visible = p.on;
      m.scale.z = p.len;
      m.position.set(p.cx, 0.08, p.cz);
      m.rotation.y = p.yaw;
    });
    if (this.rollerOn) this.roller.rotation.x -= 25 * dt; // underside moves toward the robot

    const lv = this.body.linvel();
    const w = this.body.angvel().y;
    const { fwd, right } = this.axes();
    const vf = lv.x * fwd.x + lv.z * fwd.z;
    const vr = lv.x * right.x + lv.z * right.z;
    for (const m of this.modules) {
      const mx = vr + w * m.z;
      const mz = -vf - w * m.x;
      const sp = Math.hypot(mx, mz);
      if (sp > 0.05) {
        const ang = Math.atan2(mx, mz);
        let diff = ((ang - m.angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        if (Math.abs(diff) > Math.PI / 2) diff -= Math.sign(diff) * Math.PI;
        m.angle += diff * Math.min(1, dt * 18);
        m.dir = Math.cos(ang - m.angle) >= 0 ? 1 : -1;
      }
      m.steer.rotation.y = m.angle;
      m.roll.rotation.x += ((m.dir || 1) * sp / R.wheelRadius) * dt;
    }
  }

  corners() {
    const pos = this.position;
    const { fwd, right } = this.axes();
    const out = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      out.push({ x: pos.x + right.x * sx * this.half + fwd.x * sz * this.half, z: pos.z + right.z * sx * this.half + fwd.z * sz * this.half });
    }
    return out;
  }

  remove() {
    for (const tr of this.transit) tr.f.anim = null;
    this.transit = [];
    this.world.scene.remove(this.group);
    if (this.body) this.world.physics.removeRigidBody(this.body);
  }
}
