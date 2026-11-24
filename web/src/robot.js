import * as THREE from 'three';
import RAPIER from 'rapier';
import { CONFIG, MAX_SPEED } from './config.js';

const HALF_H = 0.155;

export class Robot {
  constructor(world, assets, alliance) {
    this.world = world;
    this.alliance = alliance;
    const b = assets.robotInfo.bounds;
    this.half = { x: (b.hi[0] - b.lo[0]) / 2, z: (b.hi[2] - b.lo[2]) / 2 };
    this.height = b.hi[1];

    this.group = new THREE.Group();
    const model = assets.robot.clone(true);
    model.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    this.wheels = {};
    for (const n of ['wheel_fl', 'wheel_fr', 'wheel_bl', 'wheel_br']) this.wheels[n] = model.getObjectByName(n);
    this.group.add(model);
    // alliance color band so the robot is identifiable (G414)
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(this.half.x * 2 + 0.01, 0.035, this.half.z * 2 + 0.01),
      new THREE.MeshStandardMaterial({ color: alliance === 'red' ? CONFIG.pieces.red : CONFIG.pieces.blue, roughness: 0.6 }),
    );
    band.position.y = 0.075;
    this.group.add(band);
    world.scene.add(this.group);

    this.hopper = []; // Piece[] being held
    this.hopperMeshes = [];
    for (let i = 0; i < CONFIG.robot.hopperSize; i++) {
      const m = new THREE.Mesh(world.ballGeo(CONFIG.pieces.pollen.radius), world.ballMat('pollen'));
      m.visible = false;
      m.position.set(-0.11 + i * 0.075, 0.2, 0.0);
      this.group.add(m);
      this.hopperMeshes.push(m);
    }

    this.intakeOn = false;
    this.lastShot = 0;
    this.lastEject = 0;
    this.enabled = true;
    this.cmd = { f: 0, s: 0, t: 0 };
    this.vel = { f: 0, s: 0, w: 0 };
  }

  place(x, z, yaw) {
    if (this.body) this.world.physics.removeRigidBody(this.body);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = this.world.physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, 0.002, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCcdEnabled(true),
    );
    this.body.setEnabledRotations(false, true, false, true);
    const col = RAPIER.ColliderDesc.cuboid(this.half.x, HALF_H, this.half.z)
      .setTranslation(0, HALF_H + 0.004, 0)
      .setMass(CONFIG.robot.mass)
      .setFriction(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(0.05);
    this.world.physics.createCollider(col, this.body);
    this.vel = { f: 0, s: 0, w: 0 };
    this.sync();
  }

  get yaw() {
    const r = this.body.rotation();
    return new THREE.Euler().setFromQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w), 'YXZ').y;
  }

  get position() {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  /** world-space forward and right unit vectors */
  axes() {
    const y = this.yaw;
    return {
      fwd: new THREE.Vector3(-Math.sin(y), 0, -Math.cos(y)),
      right: new THREE.Vector3(Math.cos(y), 0, -Math.sin(y)),
    };
  }

  toLocal(p) {
    const pos = this.position;
    const { fwd, right } = this.axes();
    const d = new THREE.Vector3(p.x - pos.x, p.y - pos.y, p.z - pos.z);
    return new THREE.Vector3(d.dot(right), d.y, -d.dot(fwd)); // local: +x right, -z forward
  }

  toWorld(local) {
    const pos = this.position;
    const { fwd, right } = this.axes();
    return pos.clone()
      .addScaledVector(right, local[0])
      .add(new THREE.Vector3(0, local[1], 0))
      .addScaledVector(fwd, -local[2]);
  }

  /**
   * Drive command in robot-local terms: f forward, s strafe right, t turn right; each -1..1.
   * Mecanum desaturation keeps |f|+|s|+|t| <= 1 like real wheel power normalisation.
   */
  drive(f, s, t) {
    const sum = Math.abs(f) + Math.abs(s) + Math.abs(t);
    if (sum > 1) { f /= sum; s /= sum; t /= sum; }
    this.cmd = { f, s, t };
  }

  step(dt, time) {
    if (!this.body) return;
    const k = 0.339; // half track + half wheelbase (from CAD wheel centres)
    const tgt = this.enabled
      ? { f: this.cmd.f * MAX_SPEED, s: this.cmd.s * MAX_SPEED, w: (-this.cmd.t * MAX_SPEED) / k }
      : { f: 0, s: 0, w: 0 };

    // Measure actual local velocity (collisions may have changed it)
    const lv = this.body.linvel();
    const { fwd, right } = this.axes();
    const cur = { f: lv.x * fwd.x + lv.z * fwd.z, s: lv.x * right.x + lv.z * right.z, w: this.body.angvel().y };
    const a = CONFIG.robot.accel * dt;
    const approach = (c, t, step) => (Math.abs(t - c) <= step ? t : c + Math.sign(t - c) * step);
    const nf = approach(cur.f, tgt.f, a);
    const ns = approach(cur.s, tgt.s, a);
    const nw = approach(cur.w, tgt.w, CONFIG.robot.turnAccel * dt);
    const vx = fwd.x * nf + right.x * ns;
    const vz = fwd.z * nf + right.z * ns;
    this.body.setLinvel({ x: vx, y: Math.min(lv.y, 0), z: vz }, true);
    this.body.setAngvel({ x: 0, y: nw, z: 0 }, true);
    this.vel = { f: nf, s: ns, w: nw };

    if (this.enabled) this.runIntake();
  }

  runIntake() {
    if (!this.intakeOn || this.hopper.length >= CONFIG.robot.hopperSize) return;
    const z = CONFIG.intake;
    for (const p of this.world.pieces) {
      if (!p.body) continue;
      const l = this.toLocal(p.body.translation());
      if (l.x > z.x[0] && l.x < z.x[1] && l.y > z.y[0] && l.y < z.y[1] && l.z > z.z[0] && l.z < z.z[1]) {
        p.despawn();
        p.mesh.visible = false;
        this.hopper.push(p);
        if (this.hopper.length >= CONFIG.robot.hopperSize) break;
      }
    }
  }

  preload(pieces) {
    for (const p of pieces) {
      p.despawn();
      p.mesh.visible = false;
      this.hopper.push(p);
    }
  }

  /** Launch the oldest held piece using a preset { speed, angleDeg }. */
  shoot(preset, time) {
    if (!this.enabled || !this.hopper.length || time - this.lastShot < CONFIG.shooter.fireInterval) return null;
    this.lastShot = time;
    const p = this.hopper.shift();
    const { origin, vel } = this.launchState(preset);
    p.spawn([origin.x, origin.y, origin.z], [vel.x, vel.y, vel.z]);
    return p;
  }

  eject(time) {
    if (!this.enabled || !this.hopper.length || time - this.lastEject < 0.3) return;
    this.lastEject = time;
    const p = this.hopper.pop();
    const o = this.toWorld([0, 0.08, -this.half.z - 0.07]);
    const { fwd } = this.axes();
    const lv = this.body.linvel();
    p.spawn([o.x, o.y, o.z], [lv.x + fwd.x * CONFIG.ejectSpeed, 0, lv.z + fwd.z * CONFIG.ejectSpeed]);
  }

  launchState(preset) {
    const origin = this.toWorld(CONFIG.shooter.exitLocal);
    const { fwd } = this.axes();
    const a = THREE.MathUtils.degToRad(preset.angleDeg);
    const lv = this.body.linvel();
    const vel = new THREE.Vector3(
      fwd.x * Math.cos(a) * preset.speed + lv.x,
      Math.sin(a) * preset.speed,
      fwd.z * Math.cos(a) * preset.speed + lv.z,
    );
    return { origin, vel };
  }

  sync(dt = 0) {
    if (!this.body) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    this.group.position.set(t.x, t.y, t.z);
    this.group.quaternion.set(r.x, r.y, r.z, r.w);

    // Spin mecanum wheels from actual motion (wheel surface speed / radius)
    const rad = CONFIG.robot.wheelDiameter / 2;
    const k = 0.339;
    const { f, s, w } = this.vel;
    const tw = -w * k;
    const speeds = { wheel_fl: f + s + tw, wheel_fr: f - s - tw, wheel_bl: f - s + tw, wheel_br: f + s - tw };
    for (const [n, v] of Object.entries(speeds)) {
      if (this.wheels[n]) this.wheels[n].rotation.x -= (v / rad) * dt;
    }

    this.hopperMeshes.forEach((m, i) => {
      const p = this.hopper[i];
      m.visible = !!p;
      if (p) {
        m.geometry = this.world.ballGeo(p.radius);
        m.material = this.world.ballMat(p.kind);
      }
    });
  }

  /** Footprint corners in world XZ */
  corners() {
    const pos = this.position;
    const { fwd, right } = this.axes();
    const out = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      out.push({
        x: pos.x + right.x * sx * this.half.x + fwd.x * sz * this.half.z,
        z: pos.z + right.z * sx * this.half.x + fwd.z * sz * this.half.z,
      });
    }
    return out;
  }

  remove() {
    this.world.scene.remove(this.group);
    if (this.body) this.world.physics.removeRigidBody(this.body);
  }
}
