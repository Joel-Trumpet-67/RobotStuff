import { CONFIG } from './config.js';

const P = CONFIG.points;
const M = CONFIG.match;

function rectHitsCircle(rect, x, z, r) {
  const cx = Math.max(rect.x[0], Math.min(x, rect.x[1]));
  const cz = Math.max(rect.z[0], Math.min(z, rect.z[1]));
  return (x - cx) ** 2 + (z - cz) ** 2 <= r * r;
}

function pointInRect(rect, x, z) {
  return x >= rect.x[0] && x <= rect.x[1] && z >= rect.z[0] && z <= rect.z[1];
}

/** Does a convex quad (robot footprint) at least partially overlap an axis-aligned rect? */
function quadHitsRect(corners, rect) {
  if (corners.some((c) => pointInRect(rect, c.x, c.z))) return true;
  // rect corners inside quad
  const quad = [corners[0], corners[1], corners[3], corners[2]];
  const inside = (px, pz) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      const cr = (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
      if (cr !== 0) {
        if (sign === 0) sign = Math.sign(cr);
        else if (Math.sign(cr) !== sign) return false;
      }
    }
    return true;
  };
  for (const x of rect.x) for (const z of rect.z) if (inside(x, z)) return true;
  return false;
}

export class Match {
  /**
   * mode: 'match' (timed) or 'free'
   */
  constructor(world, robot, alliance, mode, hooks) {
    this.world = world;
    this.robot = robot;
    this.alliance = alliance;
    this.mode = mode;
    this.hooks = hooks; // { toast(text, color), end(results) }
    this.zones = world.info.zones;
    this.t = 0; // seconds since countdown began
    this.phase = mode === 'free' ? 'free' : 'countdown';
    this.tips = { red: [], blue: [] }; // list of 'auto'|'teleop'
    this.nectarPool = { red: 5, blue: 5 };
    this.nectarEntered = { red: 0, blue: 0 };
    this.lastDrop = { red: -9, blue: -9 };
    this.reentry = { red: 0, blue: 0 }; // NECTAR that left the FIELD may come back any time (G426 note)
    this.autoScore = null;
    this.flowersAnnounced = false;
    this.final = null;
  }

  /** Seconds left in the MATCH (teleop clock), used for 60 s rules. */
  get matchRemaining() {
    if (this.phase === 'free') return 0; // free drive: everything unlocked
    const teleStart = M.countdown + M.auto + M.transition;
    if (this.t < teleStart) return M.teleop + 1;
    return Math.max(0, M.teleop - (this.t - teleStart));
  }

  get clock() {
    const t = this.t;
    switch (this.phase) {
      case 'countdown': return { label: 'GET READY', secs: M.countdown - t };
      case 'auto': return { label: 'AUTO', secs: M.countdown + M.auto - t };
      case 'transition': return { label: 'PICK UP CONTROLLERS', secs: M.countdown + M.auto + M.transition - t };
      case 'teleop': return { label: this.matchRemaining <= M.flowerUnlock ? 'TELEOP · FLOWERS OPEN' : 'TELEOP', secs: this.matchRemaining };
      case 'settle':
      case 'done': return { label: 'MATCH OVER', secs: 0 };
      default: return { label: 'FREE DRIVE', secs: null };
    }
  }

  get robotEnabled() {
    return this.phase === 'auto' || this.phase === 'teleop' || this.phase === 'free';
  }

  step(dt, events) {
    this.t += dt;
    const prev = this.phase;
    if (this.phase !== 'free') {
      const a = M.countdown, b = a + M.auto, c = b + M.transition, d = c + M.teleop;
      if (this.t < a) this.phase = 'countdown';
      else if (this.t < b) this.phase = 'auto';
      else if (this.t < c) this.phase = 'transition';
      else if (this.t < d) this.phase = 'teleop';
      else if (this.t < d + M.settle) this.phase = 'settle';
      else this.phase = 'done';
    }
    if (prev !== this.phase) this.onPhase(prev, this.phase);

    // HIVE tips (from the world) count for the HIVE's alliance
    for (const e of events) {
      if (e.type !== 'tipped') continue;
      const when = this.phase === 'auto' || this.phase === 'transition' || this.phase === 'countdown' ? 'auto' : 'teleop';
      this.tips[e.color].push(when);
      this.hooks.toast(`${e.color.toUpperCase()} HIVE TIP  +${P.tip}`, e.color);
    }

    // Start a tip when the up CELL is heavy enough
    for (const color of ['red', 'blue']) {
      const hive = this.world.hives[color];
      if (!hive.anim && this.world.hiveLoad(color) >= CONFIG.hive.tipAt) hive.startTip();
    }

    if (this.matchRemaining <= M.flowerUnlock && !this.flowersAnnounced && this.phase === 'teleop') {
      this.flowersAnnounced = true;
      this.hooks.toast('1:00 — FLOWERS & all NECTAR unlocked', 'neutral');
    }

    this.humanPlayers();
    this.returnStrays(dt);
  }

  onPhase(from, to) {
    if (to === 'auto') this.hooks.toast('AUTO — go!', 'neutral');
    if (to === 'transition') {
      this.autoScore = this.assessRobot('auto');
      this.hooks.toast('AUTO over', 'neutral');
    }
    if (to === 'teleop') this.hooks.toast('TELEOP', 'neutral');
    if (to === 'settle') {
      this.teleopPark = this.assessRobot('teleop');
      this.hooks.toast('MATCH OVER', 'neutral');
    }
    if (to === 'done') {
      this.final = this.score();
      this.hooks.end(this.final);
    }
  }

  /** LEAVE + PARK for the player's robot (other robots are absent). */
  assessRobot(period) {
    const res = { red: { leave: 0, park: 0 }, blue: { leave: 0, park: 0 } };
    const r = this.robot;
    const corners = r.corners();
    const lz = this.zones.loading[this.alliance];
    const parked = quadHitsRect(corners, lz);
    if (period === 'auto') {
      const W = this.world.wall - 0.01;
      const touching = corners.some((c) => Math.abs(c.x) >= W || Math.abs(c.z) >= W);
      res[this.alliance].leave = touching ? 0 : P.leave;
    }
    res[this.alliance].park = parked ? P.park : 0;
    return res;
  }

  /** Full score as of now (live estimate during the match, final at the end). */
  score() {
    const out = {};
    for (const c of ['red', 'blue']) {
      out[c] = {
        leave: this.autoScore ? this.autoScore[c].leave : 0,
        autoPark: this.autoScore ? this.autoScore[c].park : 0,
        tipsAuto: this.tips[c].filter((w) => w === 'auto').length,
        tipsTeleop: this.tips[c].filter((w) => w === 'teleop').length,
        cell: 0, flower: 0, bottomNectar: 0, garden: 0,
        teleopPark: this.teleopPark ? this.teleopPark[c].park : 0,
      };
    }
    const pieces = this.world.pieces.filter((p) => p.body);

    // Pieces left in an upward-facing CELL score for that HIVE's alliance
    for (const c of ['red', 'blue']) {
      const hive = this.world.hives[c];
      if (hive.anim) continue;
      for (const p of pieces) if (hive.inCell(p.body.translation(), hive.upCell)) out[c].cell += P.cell;
    }

    // FLOWERS: owner = alliance with the top-most NECTAR of its color in the scoring volume
    for (const f of this.world.info.flowers) {
      const inside = [];
      for (const p of pieces) {
        const t = p.body.translation();
        const d = Math.hypot(t.x - f.center[0], t.z - f.center[1]);
        if (d < f.radius + 0.02 && t.y + p.radius > f.score_y[0] && t.y - p.radius < f.score_y[1]) inside.push({ p, y: t.y });
      }
      const nectar = inside.filter((i) => i.p.isNectar).sort((a, b) => b.y - a.y);
      if (!nectar.length) continue;
      const owner = nectar[0].p.color;
      out[owner].flower += inside.length * P.flower;
      const bottom = nectar[nectar.length - 1].p.color;
      out[bottom].bottomNectar += P.bottomNectar;
    }

    // GARDENS: any piece at least partially in the zone, for the garden's color
    for (const c of ['red', 'blue']) {
      const g = this.zones.garden[c];
      for (const p of pieces) {
        const t = p.body.translation();
        if (rectHitsCircle(g, t.x, t.z, p.radius)) out[c].garden += P.garden;
      }
    }

    for (const c of ['red', 'blue']) {
      const s = out[c];
      s.auto = s.leave + s.autoPark + s.tipsAuto * P.tip;
      s.teleop = s.tipsTeleop * P.tip + s.cell + s.flower + s.bottomNectar + s.garden + s.teleopPark;
      s.total = s.auto + s.teleop;
      const tips = s.tipsAuto + s.tipsTeleop;
      s.rp = {
        swarm: s.leave + s.autoPark + s.teleopPark >= P.rp.swarm,
        pollinator1: tips >= P.rp.pollinator1,
        pollinator2: tips >= P.rp.pollinator2,
      };
    }
    return out;
  }

  /** NECTAR the human player is allowed to enter right now (G426). */
  nectarAllowed(color) {
    if (this.matchRemaining <= M.flowerUnlock) return this.nectarPool[color];
    const earned = this.tips[color].length - this.nectarEntered[color] + this.reentry[color];
    return Math.max(0, Math.min(earned, this.nectarPool[color]));
  }

  humanPlayers() {
    const live = this.phase === 'auto' || this.phase === 'teleop' || this.phase === 'free';
    if (!live) return;
    for (const color of ['red', 'blue']) {
      if (this.nectarAllowed(color) <= 0) continue;
      if (this.t - this.lastDrop[color] < CONFIG.humanPlayer.interval) continue;
      const lz = this.zones.loading[color];
      if (color === this.alliance) {
        // drop when our robot comes within 3 ft of the LOADING ZONE
        const p = this.robot.position;
        const cx = Math.max(lz.x[0], Math.min(p.x, lz.x[1]));
        const cz = Math.max(lz.z[0], Math.min(p.z, lz.z[1]));
        if (Math.hypot(p.x - cx, p.z - cz) > CONFIG.humanPlayer.radius) continue;
      }
      this.dropNectar(color);
    }
  }

  dropNectar(color) {
    const lz = this.zones.loading[color];
    const r = CONFIG.pieces.nectar.radius;
    // pick the spot in the zone farthest from the robot
    const rp = this.robot.position;
    let best = null, bestD = -1;
    for (let i = 0; i < 6; i++) {
      const x = lz.x[0] + r + Math.random() * (lz.x[1] - lz.x[0] - 2 * r);
      const z = lz.z[0] + r + Math.random() * (lz.z[1] - lz.z[0] - 2 * r);
      const d = Math.hypot(x - rp.x, z - rp.z);
      if (d > bestD) { bestD = d; best = [x, z]; }
    }
    this.world.addPiece(`${color}_nectar`, [best[0], 0.25, best[1]]);
    this.nectarPool[color]--;
    if (this.reentry[color] > 0) this.reentry[color]--;
    else if (this.matchRemaining > M.flowerUnlock) this.nectarEntered[color]++;
    this.lastDrop[color] = this.t;
    const tray = this.world.nectarTray[color];
    for (let i = 0; i < tray.length; i++) tray[i].visible = i < this.nectarPool[color];
    if (color === this.alliance) this.hooks.toast('Human player: NECTAR in', color);
  }

  /** Pieces that leave the FIELD: field staff put POLLEN back; NECTAR returns to its ALLIANCE AREA. */
  returnStrays(dt) {
    const W = this.world.wall;
    for (const p of this.world.pieces) {
      if (!p.body) continue;
      const t = p.body.translation();
      const out = Math.abs(t.x) > W + 0.02 || Math.abs(t.z) > W + 0.02 || t.y < -1;
      p.outTime = out && t.y < 0.25 ? p.outTime + dt : 0;
      if (p.outTime < 1.5) continue;
      p.outTime = 0;
      p.despawn();
      if (p.isNectar) {
        p.mesh.visible = false;
        this.world.pieces.splice(this.world.pieces.indexOf(p), 1);
        this.world.scene.remove(p.mesh);
        this.nectarPool[p.color]++;
        this.reentry[p.color]++;
        const tray = this.world.nectarTray[p.color];
        for (let i = 0; i < tray.length; i++) tray[i].visible = i < this.nectarPool[p.color];
      } else {
        const cx = Math.max(-W + 0.1, Math.min(t.x, W - 0.1));
        const cz = Math.max(-W + 0.1, Math.min(t.z, W - 0.1));
        p.spawn([cx, 0.2, cz]);
      }
    }
  }
}
