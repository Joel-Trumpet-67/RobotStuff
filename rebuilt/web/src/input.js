// Keyboard + gamepad. read() returns the current state; edge-triggered actions
// (camera, drive mode, aim line, pause, intake toggle) come back as `pressed`.

const DEAD = 0.08;
const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

export class Input {
  constructor() {
    this.keys = new Set();
    this.queue = [];
    this.padPrev = [];
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      const map = {
        KeyC: 'camera', Digit1: 'cam1', Digit2: 'cam2', Digit3: 'cam3',
        KeyM: 'driveMode', Escape: 'pause', KeyX: 'intakeIn',
      };
      if (map[e.code]) this.queue.push(map[e.code]);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  read() {
    const k = (c) => (this.keys.has(c) ? 1 : 0);
    const s = {
      y: k('KeyW') - k('KeyS'), // forward
      x: k('KeyD') - k('KeyA'), // right
      turn: k('ArrowRight') + k('KeyE') - k('ArrowLeft') - k('KeyQ'),
      intakeHold: !!(k('ShiftLeft') || k('ShiftRight')),
      eject: !!k('KeyR'),
      shootHive: !!k('Space'),
      shootFlower: !!k('KeyV'),
      pressed: this.queue.splice(0),
      gamepad: false,
    };

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || pad.mapping !== 'standard') continue;
      s.gamepad = true;
      const lx = dz(pad.axes[0]), ly = dz(pad.axes[1]), rx = dz(pad.axes[2]);
      if (lx || ly) { s.x = lx; s.y = -ly; }
      if (rx) s.turn = rx;
      const b = (i) => pad.buttons[i]?.pressed;
      const v = (i) => pad.buttons[i]?.value ?? 0;
      s.intakeHold ||= v(6) > 0.3; // LT
      s.eject ||= b(4); // LB
      s.shootHive ||= v(7) > 0.3; // RT
      s.shootFlower ||= b(5); // RB
      const edges = { 3: 'camera', 2: 'intakeIn', 8: 'driveMode', 9: 'pause' };
      const prev = this.padPrev[pad.index] || [];
      for (const [i, name] of Object.entries(edges)) if (b(i) && !prev[i]) s.pressed.push(name);
      this.padPrev[pad.index] = pad.buttons.map((x) => x.pressed);
      break; // first standard pad only
    }
    // keep stick magnitude <= 1
    const m = Math.hypot(s.x, s.y);
    if (m > 1) { s.x /= m; s.y /= m; }
    return s;
  }
}
