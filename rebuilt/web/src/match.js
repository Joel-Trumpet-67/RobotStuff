import { CONFIG } from './config.js';

const M = CONFIG.match;

/** Match clock, HUB active/inactive SHIFTS (§6.4.1), and FUEL points (§6.5). */
export class Match {
  constructor(world, mode, hooks) {
    this.world = world;
    this.mode = mode;
    this.hooks = hooks;
    this.t = 0;
    this.phase = mode === 'free' ? 'free' : 'countdown';
    this.fuel = { red: { auto: 0, teleop: 0, wasted: 0 }, blue: { auto: 0, teleop: 0, wasted: 0 } };
    this.firstInactive = null; // alliance whose HUB is inactive in SHIFT 1
    this.final = null;
    this.lastSegment = null;
  }

  get teleStart() {
    return M.countdown + M.auto + M.delay;
  }

  /** seconds into TELEOP (negative before it starts) */
  get teleT() {
    return this.t - this.teleStart;
  }

  segmentAt(t) {
    if (this.mode === 'free') return 'free';
    const a = M.countdown, b = a + M.auto, c = b + M.delay;
    if (t < a) return 'countdown';
    if (t < b) return 'auto';
    if (t < c) return 'delay';
    const tt = t - c;
    if (tt < M.transition) return 'transition';
    if (tt < M.transition + 4 * M.shift) return `shift${1 + Math.floor((tt - M.transition) / M.shift)}`;
    if (tt < M.teleop) return 'endgame';
    if (tt < M.teleop + M.grace) return 'settle';
    return 'done';
  }

  hubActiveAt(color, t) {
    const seg = this.segmentAt(t);
    if (!seg.startsWith('shift')) return seg !== 'countdown' && seg !== 'done';
    const n = Number(seg.slice(5));
    const inactive = n % 2 === 1 ? this.firstInactive : this.firstInactive === 'red' ? 'blue' : 'red';
    return color !== inactive;
  }

  /** FUEL counts if the HUB is active now or deactivated within the last 3 s (§6.5). */
  credited(color, t) {
    for (let back = 0; back <= M.grace; back += 0.25) {
      if (t - back < 0) break;
      if (this.hubActiveAt(color, t - back)) return true;
    }
    return false;
  }

  get robotEnabled() {
    return ['auto', 'transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame', 'free'].includes(this.phase);
  }

  get clock() {
    const t = this.t;
    const a = M.countdown, b = a + M.auto, c = b + M.delay;
    const labels = {
      countdown: 'GET READY', auto: 'AUTO', delay: 'AUTO SCORING', transition: 'TRANSITION SHIFT',
      shift1: 'SHIFT 1', shift2: 'SHIFT 2', shift3: 'SHIFT 3', shift4: 'SHIFT 4', endgame: 'END GAME',
      settle: 'MATCH OVER', done: 'MATCH OVER', free: 'FREE DRIVE',
    };
    let secs = null;
    if (this.phase === 'countdown') secs = a - t;
    else if (this.phase === 'auto') secs = b - t;
    else if (this.phase === 'delay') secs = 0;
    else if (this.phase !== 'free') secs = Math.max(0, M.teleop - (t - c));
    return { label: labels[this.phase], secs };
  }

  step(dt, events) {
    this.t += dt;
    const prev = this.phase;
    this.phase = this.segmentAt(this.t);
    if (prev !== this.phase) this.onPhase(prev, this.phase);

    for (const e of events) {
      if (e.type !== 'score') continue;
      const t = this.t;
      const ok = this.mode === 'free' || this.credited(e.color, t);
      const period = t < this.teleStart ? 'auto' : 'teleop';
      if (ok) this.fuel[e.color][period]++;
      else this.fuel[e.color].wasted++;
    }

    // HUB deactivation warning 3 s ahead (Table 5-3)
    for (const color of ['red', 'blue']) {
      if (this.mode === 'free' || !this.firstInactive) continue;
      const now = this.hubActiveAt(color, this.t);
      const soon = this.hubActiveAt(color, this.t + 3);
      const key = `${color}-${Math.floor(this.teleT / M.shift)}`;
      if (now && !soon && this.warned !== key && this.phase !== 'endgame') {
        this.warned = key;
        this.hooks.toast(`${color.toUpperCase()} HUB deactivating in 3`, color);
      }
    }
  }

  onPhase(from, to) {
    if (to === 'auto') this.hooks.toast('AUTO — go!', 'neutral');
    if (to === 'delay') this.hooks.toast('AUTO over', 'neutral');
    if (to === 'transition') {
      const r = this.fuel.red.auto, b = this.fuel.blue.auto;
      this.firstInactive = r > b ? 'red' : b > r ? 'blue' : Math.random() < 0.5 ? 'red' : 'blue';
      const why = r === b ? 'tie, FMS picked' : 'scored more in AUTO';
      this.hooks.toast(`${this.firstInactive.toUpperCase()} HUB inactive in SHIFT 1 (${why})`, this.firstInactive);
    }
    if (to.startsWith('shift')) {
      const active = ['red', 'blue'].filter((c) => this.hubActiveAt(c, this.t));
      this.hooks.toast(`${to.replace('shift', 'SHIFT ')} — ${active.map((c) => c.toUpperCase()).join(' & ')} HUB active`, active[0]);
    }
    if (to === 'endgame') this.hooks.toast('END GAME — both HUBS active', 'neutral');
    if (to === 'settle') this.hooks.toast('MATCH OVER', 'neutral');
    if (to === 'done') {
      this.final = this.score();
      this.hooks.end(this.final);
    }
  }

  score() {
    const P = CONFIG.points;
    const out = {};
    for (const c of ['red', 'blue']) {
      const f = this.fuel[c];
      const fuelPts = (f.auto + f.teleop) * P.fuel;
      out[c] = {
        fuelAuto: f.auto, fuelTeleop: f.teleop, wasted: f.wasted, tower: 0,
        total: fuelPts,
        rp: {
          energized: f.auto + f.teleop >= P.rp.energized,
          supercharged: f.auto + f.teleop >= P.rp.supercharged,
          traversal: false,
        },
      };
    }
    return out;
  }
}
