import * as THREE from 'three';
import RAPIER from 'rapier';
import { CONFIG } from './config.js';

const WALL = 1.8288; // inside face of the perimeter, 72 in from centre
const WALL_H = 0.31;

/** Collect positions/indices of every mesh under `root`, transformed by `toSpace`. */
function gatherTrimesh(meshes, toSpace) {
  const verts = [];
  const idx = [];
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const base = verts.length / 3;
    mesh.updateWorldMatrix(true, false);
    const m = toSpace ? toSpace.clone().multiply(mesh.matrixWorld) : mesh.matrixWorld;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      verts.push(v.x, v.y, v.z);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) idx.push(base + i);
  }
  return { verts: new Float32Array(verts), idx: new Uint32Array(idx) };
}

export class Piece {
  constructor(world, kind, pos) {
    this.world = world;
    this.kind = kind; // 'pollen' | 'red_nectar' | 'blue_nectar'
    this.isNectar = kind !== 'pollen';
    this.color = kind === 'pollen' ? 'pollen' : kind.split('_')[0];
    const spec = this.isNectar ? CONFIG.pieces.nectar : CONFIG.pieces.pollen;
    this.radius = spec.radius;
    this.mass = spec.mass;
    this.weight = this.isNectar ? CONFIG.hive.nectarWeight : CONFIG.hive.pollenWeight;
    this.mesh = new THREE.Mesh(world.ballGeo(this.radius), world.ballMat(kind));
    this.mesh.castShadow = true;
    world.scene.add(this.mesh);
    this.body = null;
    this.outTime = 0;
    if (pos) this.spawn(pos);
  }

  spawn(pos, vel) {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos[0], pos[1], pos[2])
      .setCcdEnabled(true)
      .setLinearDamping(0.15)
      .setAngularDamping(0.6);
    this.body = this.world.physics.createRigidBody(desc);
    if (vel) this.body.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
    const col = RAPIER.ColliderDesc.ball(this.radius)
      .setMass(this.mass)
      .setRestitution(CONFIG.pieces.restitution)
      .setFriction(CONFIG.pieces.friction);
    this.world.physics.createCollider(col, this.body);
    this.mesh.visible = true;
    this.mesh.parent !== this.world.scene && this.world.scene.add(this.mesh);
  }

  despawn() {
    if (this.body) this.world.physics.removeRigidBody(this.body);
    this.body = null;
  }

  get pos() {
    return this.body ? this.body.translation() : null;
  }

  sync() {
    if (!this.body) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}

class Hive {
  constructor(world, color, info, group, colliderMeshes) {
    this.color = color;
    this.info = info;
    this.group = group; // THREE.Group positioned at the pivot
    this.tipAngle = THREE.MathUtils.degToRad(info.tip_rotation_deg);
    // The CAD pose is state 0. Red starts with its audience (+Z) cell up, so its
    // first tip rotates +X; blue starts with the scoring (-Z) cell up, so -X.
    this.sign = info.start_up_cell === 'audience' ? 1 : -1;
    this.state = 0; // 0 = CAD pose, 1 = tipped
    this.angle = 0;
    this.anim = null;
    this.tips = 0;

    const p = info.pivot;
    this.body = world.physics.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p[0], p[1], p[2]),
    );
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const { verts, idx } = gatherTrimesh(colliderMeshes, inv);
    world.physics.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(0.5), this.body);
  }

  /** The cell currently facing up ('audience' or 'scoring'). */
  get upCell() {
    const start = this.info.start_up_cell;
    if (this.state === 0) return start;
    return start === 'audience' ? 'scoring' : 'audience';
  }

  /** World point -> hive-local (pivot-relative, CAD pose) */
  toLocal(p) {
    const v = new THREE.Vector3(p.x - this.info.pivot[0], p.y - this.info.pivot[1], p.z - this.info.pivot[2]);
    v.applyAxisAngle(new THREE.Vector3(1, 0, 0), -this.angle);
    return v;
  }

  inCell(p, cellName, margin = 0) {
    const c = this.info.cells_local[cellName];
    const l = this.toLocal(p);
    return (
      l.x > c.lo[0] - margin && l.x < c.hi[0] + margin &&
      l.y > c.lo[1] - margin && l.y < c.hi[1] + margin &&
      l.z > c.lo[2] - margin && l.z < c.hi[2] + margin
    );
  }

  startTip() {
    if (this.anim) return false;
    const from = this.angle;
    const to = this.state === 0 ? this.sign * this.tipAngle : 0;
    this.anim = { from, to, t: 0 };
    return true;
  }

  step(dt) {
    if (!this.anim) return null;
    this.anim.t = Math.min(1, this.anim.t + dt / CONFIG.hive.tipSeconds);
    const s = this.anim.t;
    // slow start (the hive creeps, then falls), damped finish
    const e = s < 0.5 ? 2 * s * s : 1 - Math.pow(-2 * s + 2, 2) / 2;
    this.angle = this.anim.from + (this.anim.to - this.anim.from) * e;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.angle);
    this.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    this.group.quaternion.copy(q);
    if (this.anim.t >= 1) {
      this.anim = null;
      this.state = 1 - this.state;
      this.tips++;
      return 'tipped';
    }
    return null;
  }
}

export class World {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.info = assets.fieldInfo;
    this._geos = new Map();
    this._mats = new Map();
  }

  ballGeo(r) {
    if (!this._geos.has(r)) this._geos.set(r, new THREE.SphereGeometry(r, 20, 14));
    return this._geos.get(r);
  }

  ballMat(kind) {
    if (!this._mats.has(kind)) {
      const c = kind === 'pollen' ? CONFIG.pieces.pollen.color : kind.startsWith('red') ? CONFIG.pieces.red : CONFIG.pieces.blue;
      this._mats.set(kind, new THREE.MeshStandardMaterial({ color: c, roughness: 0.55 }));
    }
    return this._mats.get(kind);
  }

  /** Build everything: called once per match (fresh physics world). */
  build() {
    if (this.root) this.scene.remove(this.root);
    for (const p of this.pieces || []) this.scene.remove(p.mesh);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = 1 / CONFIG.physicsHz;

    this.buildFloor();
    this.buildFieldMeshes();
    this.buildPieces();
  }

  buildFloor() {
    // Ground outside the field
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 14),
      new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.002;
    ground.receiveShadow = true;
    this.root.add(ground);

    // 6x6 foam tiles with seams
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = '#4a4d52';
    g.fillRect(0, 0, 1024, 1024);
    g.strokeStyle = '#34373b';
    g.lineWidth = 3;
    for (let i = 0; i <= 6; i++) {
      const s = (i / 6) * 1024;
      g.beginPath(); g.moveTo(s, 0); g.lineTo(s, 1024); g.stroke();
      g.beginPath(); g.moveTo(0, s); g.lineTo(1024, s); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const tiles = new THREE.Mesh(
      new THREE.PlaneGeometry(WALL * 2, WALL * 2),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }),
    );
    tiles.rotation.x = -Math.PI / 2;
    tiles.receiveShadow = true;
    this.root.add(tiles);

    // Physics: floor + perimeter walls (boxes, more robust than the CAD panels)
    const floor = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(8, 0.1, 8).setTranslation(0, -0.1, 0).setFriction(0.8), floor);
    const t = 0.05;
    const walls = [
      [WALL + t, WALL_H / 2, 0, t, WALL_H / 2, WALL + 2 * t],
      [-WALL - t, WALL_H / 2, 0, t, WALL_H / 2, WALL + 2 * t],
      [0, WALL_H / 2, WALL + t, WALL + 2 * t, WALL_H / 2, t],
      [0, WALL_H / 2, -WALL - t, WALL + 2 * t, WALL_H / 2, t],
    ];
    for (const [x, y, z, hx, hy, hz] of walls) {
      this.physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.3), floor);
    }
  }

  buildFieldMeshes() {
    const field = this.assets.field.clone(true);
    this.root.add(field);
    field.updateMatrixWorld(true);

    const staticMeshes = [];
    const hiveMeshes = { red: [], blue: [] };
    field.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const name = o.name || o.parent?.name || '';
      if (name.includes('_glass')) {
        // polycarbonate perimeter panels
        o.material = o.material.clone();
        o.material.color.setHex(0xb8c8d8);
        o.material.transparent = true;
        o.material.opacity = 0.28;
        o.material.depthWrite = false;
        o.castShadow = false;
      }
      if (name.includes('_tape')) { o.castShadow = false; return; } // visual only
      if (name.startsWith('hive_red')) hiveMeshes.red.push(o);
      else if (name.startsWith('hive_blue')) hiveMeshes.blue.push(o);
      else staticMeshes.push(o);
    });

    // Static trimesh
    const { verts, idx } = gatherTrimesh(staticMeshes);
    const body = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.physics.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(0.5), body);

    // HIVES: reparent their meshes under a pivot group so they can rotate
    this.hives = {};
    for (const color of ['red', 'blue']) {
      const info = this.info.hives[color];
      const pivot = new THREE.Group();
      pivot.position.fromArray(info.pivot);
      this.root.add(pivot);
      pivot.updateMatrixWorld(true);
      for (const m of hiveMeshes[color]) {
        // glb stores hive geometry pivot-relative; keep it that way under the pivot
        pivot.add(m);
        m.position.set(0, 0, 0);
        m.quaternion.identity();
        m.scale.set(1, 1, 1);
      }
      pivot.updateMatrixWorld(true);
      this.hives[color] = new Hive(this, color, info, pivot, hiveMeshes[color]);
    }
  }

  buildPieces() {
    this.pieces = [];
    this.nectarTray = { red: [], blue: [] }; // display-only balls in the ALLIANCE AREAS
    for (const p of this.info.pieces_cad) {
      const [x, y, z] = p.pos;
      const outside = Math.abs(x) > WALL;
      if (p.kind === 'pollen' && outside) continue; // pre-loads: handled by the match
      if (p.kind !== 'pollen' && outside) {
        const color = p.kind.split('_')[0];
        const m = new THREE.Mesh(this.ballGeo(CONFIG.pieces.nectar.radius), this.ballMat(p.kind));
        m.position.set(x, CONFIG.pieces.nectar.radius + 0.03, z);
        m.castShadow = true;
        this.root.add(m);
        this.nectarTray[color].push(m);
        continue;
      }
      // nudge up slightly so CAD-touching balls don't start interpenetrating
      this.pieces.push(new Piece(this, p.kind, [x, y + 0.004, z]));
    }
  }

  addPiece(kind, pos, vel) {
    const p = new Piece(this, kind, pos);
    if (vel) p.body.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
    this.pieces.push(p);
    return p;
  }

  step() {
    const events = [];
    for (const color of ['red', 'blue']) {
      const ev = this.hives[color].step(1 / CONFIG.physicsHz);
      if (ev) events.push({ type: ev, color });
    }
    this.physics.step();
    return events;
  }

  sync() {
    for (const p of this.pieces) p.sync();
  }

  /** Weight resting in each HIVE's upward-facing CELL. */
  hiveLoad(color) {
    const hive = this.hives[color];
    if (hive.anim) return 0;
    let w = 0;
    for (const p of this.pieces) {
      if (!p.body) continue;
      const v = p.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed > CONFIG.hive.restSpeed) continue;
      if (hive.inCell(p.body.translation(), hive.upCell)) w += p.weight;
    }
    return w;
  }

  get wall() {
    return WALL;
  }
}
