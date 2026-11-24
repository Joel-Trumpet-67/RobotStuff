import * as THREE from 'three';
import RAPIER from 'rapier';
import { CONFIG } from './config.js';

const F = CONFIG.field;

// Collision groups: (membership << 16) | filter. Lets robot wheels ignore FUEL (no beaching).
export const G = { FIELD: 1, FUEL: 2, ROBOT: 4 };
export const groups = (member, filter) => (member << 16) | filter;
const FIELD_GROUPS = groups(G.FIELD, 0xffff);
const FR = CONFIG.fuel.radius;

function gatherTrimesh(meshes) {
  const verts = [];
  const idx = [];
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const base = verts.length / 3;
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      verts.push(v.x, v.y, v.z);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) idx.push(base + i);
  }
  return { verts: new Float32Array(verts), idx: new Uint32Array(idx) };
}

/** HUB geometry for an alliance. Blue is from CAD; red mirrors X. */
export function hubGeom(color) {
  const H = CONFIG.hub;
  const s = color === 'blue' ? 1 : -1;
  const xs = H.box.x.map((x) => x * s).sort((a, b) => a - b);
  const cx = (xs[0] + xs[1]) / 2;
  const neutralFace = color === 'blue' ? xs[0] : xs[1]; // side facing the NEUTRAL ZONE
  return { x: xs, z: H.box.z, cx, cz: 0, neutralFace, outward: -s };
}

export class World {
  constructor(scene, assets) {
    this.scene = scene;
    this.assets = assets;
    this.info = assets.fieldInfo;
  }

  build() {
    if (this.root) this.scene.remove(this.root);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.physics.timestep = 1 / CONFIG.physicsHz;
    this.fixed = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    this.buildFloor();
    this.buildField();
    this.buildHubs();
    this.buildFuel();
  }

  buildFloor() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 30),
      new THREE.MeshStandardMaterial({ color: 0x24272d, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.006;
    ground.receiveShadow = true;
    this.root.add(ground);

    // Carpet with a subtle weave so motion reads at speed
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#5a5d63';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2200; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
      g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(22, 11);
    tex.anisotropy = 8;
    const carpet = new THREE.Mesh(
      new THREE.PlaneGeometry(F.halfX * 2 + 0.6, F.halfZ * 2 + 0.6),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }),
    );
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.y = -0.001;
    carpet.receiveShadow = true;
    this.root.add(carpet);

    // Physics: floor + boundary walls (guardrails on the long sides, ALLIANCE WALLS on the ends)
    this.physics.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.1, 30).setTranslation(0, -0.1, 0).setFriction(0.9)
      .setCollisionGroups(FIELD_GROUPS), this.fixed);
    const t = 0.1;
    const walls = [
      [0, F.guardrailH / 2, F.halfZ + t, F.halfX + 1, F.guardrailH / 2, t],
      [0, F.guardrailH / 2, -F.halfZ - t, F.halfX + 1, F.guardrailH / 2, t],
      [F.halfX + t, F.allianceWallH / 2, 0, t, F.allianceWallH / 2, F.halfZ + 1],
      [-F.halfX - t, F.allianceWallH / 2, 0, t, F.allianceWallH / 2, F.halfZ + 1],
    ];
    for (const [x, y, z, hx, hy, hz] of walls) {
      this.physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.3)
        .setCollisionGroups(FIELD_GROUPS), this.fixed);
    }
  }

  buildField() {
    const field = this.assets.field.clone(true);
    this.root.add(field);
    field.updateMatrixWorld(true);
    const solid = [];
    field.traverse((o) => {
      if (!o.isMesh) return;
      const name = o.name || o.parent?.name || '';
      o.receiveShadow = true;
      o.castShadow = !name.includes('_tape');
      if (name.includes('_glass')) {
        o.material = o.material.clone();
        o.material.color.setHex(0xc4d4e4);
        o.material.transparent = true;
        o.material.opacity = 0.22;
        o.material.depthWrite = false;
        o.castShadow = false;
      }
      if (name.includes('_tape') || name.includes('_hub')) return; // hub uses simple colliders
      solid.push(o);
    });
    const { verts, idx } = gatherTrimesh(solid);
    this.physics.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(0.6).setCollisionGroups(FIELD_GROUPS), this.fixed);
  }

  buildHubs() {
    const H = CONFIG.hub;
    this.hubs = {};
    for (const color of ['red', 'blue']) {
      const h = hubGeom(color);
      const hx = (h.x[1] - h.x[0]) / 2;
      const hz = (h.z[1] - h.z[0]) / 2;
      // solid body up to the top of the panels
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, H.box.top / 2, hz).setTranslation(h.cx, H.box.top / 2, 0).setFriction(0.4)
          .setCollisionGroups(FIELD_GROUPS),
        this.fixed,
      );
      // funnel rim: four thin walls around the opening so FUEL can land in it
      const rimH = (H.funnelTop - H.box.top) / 2;
      const rimY = H.box.top + rimH;
      const w = 0.03;
      const o = H.opening;
      for (const [x, z, sx, sz] of [
        [h.cx + o + w, 0, w, o + 2 * w],
        [h.cx - o - w, 0, w, o + 2 * w],
        [h.cx, o + w, o, w],
        [h.cx, -o - w, o, w],
      ]) {
        this.physics.createCollider(
          RAPIER.ColliderDesc.cuboid(sx, rimH, sz).setTranslation(x, rimY, z).setFriction(0.3).setCollisionGroups(FIELD_GROUPS),
          this.fixed,
        );
      }
      this.hubs[color] = { ...h, queue: [] };
    }
  }

  buildFuel() {
    const n = 600;
    const geo = new THREE.SphereGeometry(FR, 18, 12);
    const mat = new THREE.MeshStandardMaterial({ color: CONFIG.fuel.color, roughness: 0.75 });
    this.fuelMesh = new THREE.InstancedMesh(geo, mat, n);
    this.fuelMesh.castShadow = true;
    this.fuelMesh.receiveShadow = true;
    this.fuelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.fuelMesh);
    this.fuel = [];

    // DEPOT and OUTPOST CHUTE FUEL from the CAD (§6.3.4 A, B)
    for (const p of this.info.fuel_cad) {
      const inNeutral = Math.abs(p[0]) < 2;
      if (inNeutral) continue; // NEUTRAL ZONE is laid out below (408 with no pre-loads)
      const inChute = p[1] > 0.2;
      // Chute FUEL is held by the CHUTE DOOR; no HUMAN PLAYER yet, so it stays put.
      this.addFuel([p[0], p[1] + 0.003, p[2]], !inChute);
    }

    // NEUTRAL ZONE (§6.3.4.1): ~206 in x 72 in box with a 2 in divider on the CENTER LINE.
    // No robot pre-loads in this sim, so all 408 non-staged FUEL go here: 2 x 6 columns x 34 rows.
    const depth = 1.8288, width = 5.2324, gap = 0.0508;
    const rows = 34;
    const dz = width / rows;
    for (const side of [-1, 1]) {
      for (let col = 0; col < 6; col++) {
        // 6 x 5.91 in is a hair over the 35 in half-box, so give each ball 2 mm of room
        const x = side * (gap / 2 + FR + col * (2 * FR + 0.002));
        for (let r = 0; r < rows; r++) {
          const z = -width / 2 + dz / 2 + r * dz;
          const j = () => (Math.random() - 0.5) * 0.006;
          this.addFuel([x + j(), FR + 0.002, z + j()], true);
        }
      }
    }
    this.fuelMesh.count = this.fuel.length;
    this.sync();
  }

  addFuel(pos, dynamic) {
    const f = { body: null, fixedPos: null, inHub: null };
    if (dynamic) {
      f.body = this.makeFuelBody(pos);
    } else {
      f.fixedPos = new THREE.Vector3(...pos);
    }
    this.fuel.push(f);
    return f;
  }

  makeFuelBody(pos, vel) {
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos[0], pos[1], pos[2])
        .setLinearDamping(0.35)
        .setAngularDamping(1.2)
        .setCcdEnabled(true)
        .setCanSleep(true),
    );
    if (vel) body.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
    this.physics.createCollider(
      RAPIER.ColliderDesc.ball(FR).setMass(CONFIG.fuel.mass).setRestitution(CONFIG.fuel.restitution).setFriction(CONFIG.fuel.friction)
        .setCollisionGroups(groups(G.FUEL, 0xffff)),
      body,
    );
    return body;
  }

  /**
   * Detect FUEL dropping through a HUB opening; hold it for the processing delay, then
   * spit it out of a random exit toward the NEUTRAL ZONE. Returns scoring events.
   */
  stepHubs(time) {
    const H = CONFIG.hub;
    const events = [];
    for (const [color, hub] of Object.entries(this.hubs)) {
      for (const f of this.fuel) {
        if (!f.body) continue;
        const t = f.body.translation();
        if (t.y > H.box.top + 0.02 && t.y < H.funnelTop + 0.3 &&
            Math.abs(t.x - hub.cx) < H.opening && Math.abs(t.z) < H.opening && f.body.linvel().y < 0.5) {
          if (t.y < H.box.top + FR + 0.08) {
            this.physics.removeRigidBody(f.body);
            f.body = null;
            f.inHub = color;
            hub.queue.push({ f, at: time + H.processDelay });
            events.push({ type: 'score', color, time });
          }
        }
      }
      while (hub.queue.length && hub.queue[0].at <= time) {
        const { f } = hub.queue.shift();
        const z = H.exitZ[Math.floor(Math.random() * H.exitZ.length)] + (Math.random() - 0.5) * 0.1;
        const sp = H.exitSpeed[0] + Math.random() * (H.exitSpeed[1] - H.exitSpeed[0]);
        const x = hub.neutralFace + hub.outward * (FR + 0.03);
        f.body = this.makeFuelBody([x, H.exitY, z], [hub.outward * sp, 0.2, (Math.random() - 0.5) * 1.2]);
        f.inHub = null;
      }
    }
    return events;
  }

  /** FUEL that leaves the FIELD is put back near where it left (FIELD STAFF stand-in). */
  stepStrays(dt) {
    for (const f of this.fuel) {
      if (!f.body) continue;
      const t = f.body.translation();
      const out = Math.abs(t.x) > F.halfX + 0.05 || Math.abs(t.z) > F.halfZ + 0.05 || t.y < -1;
      f.out = out && t.y < 0.3 ? (f.out || 0) + dt : 0;
      if (f.out > 1.5) {
        this.physics.removeRigidBody(f.body);
        const x = Math.max(-F.halfX + 0.3, Math.min(t.x, F.halfX - 0.3));
        const z = Math.max(-F.halfZ + 0.3, Math.min(t.z, F.halfZ - 0.3));
        f.body = this.makeFuelBody([x, 0.3, z]);
        f.out = 0;
      }
    }
  }

  step() {
    this.physics.step();
  }

  sync() {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this.fuel.forEach((f, i) => {
      if (f.body) {
        const t = f.body.translation();
        const r = f.body.rotation();
        m.compose(p.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), one);
      } else if (f.anim) {
        m.compose(f.anim, q.identity(), one); // being carried by an intake
      } else if (f.fixedPos) {
        m.compose(f.fixedPos, q.identity(), one);
      } else {
        m.copy(hidden); // inside a HUB
      }
      this.fuelMesh.setMatrixAt(i, m);
    });
    this.fuelMesh.instanceMatrix.needsUpdate = true;
  }
}
