// Keyboard, mouse and gamepad input. Flight axes are smoothed so tapping a
// key gives a gentle nudge and holding it ramps to full deflection.

const AXES = {
  pitch: [['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']],      // + is stick back / nose up
  roll: [['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']],
  yaw: [['KeyE'], ['KeyQ']],
  throttle: [['KeyR', 'Equal'], ['KeyF', 'Minus']],
};
const ACTIONS = {
  KeyX: 'flapsDown', KeyZ: 'flapsUp', KeyC: 'camera', KeyM: 'chart', KeyT: 'timeAccel', KeyG: 'autopilot',
  KeyN: 'tune', KeyH: 'help', Escape: 'pause', KeyP: 'pause', KeyL: 'gps', KeyO: 'weatherOverlay',
};

export class Input {
  constructor(el) {
    this.keys = new Set();
    this.pitch = 0; this.roll = 0; this.yaw = 0;      // smoothed -1..1
    this.raw = { pitch: 0, roll: 0, yaw: 0, throttle: 0 };
    this.brake = 0;
    this.look = { yaw: 0, pitch: 0, dragging: false, idle: 0 };
    this.zoom = 1;
    this.handlers = {};
    this.padPrev = [];
    this.enabled = true;

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      const a = ACTIONS[e.code];
      if (a) this.fire(a, e.shiftKey);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    el.addEventListener('pointerdown', (e) => { this.look.dragging = true; el.setPointerCapture(e.pointerId); });
    el.addEventListener('pointerup', () => { this.look.dragging = false; });
    el.addEventListener('pointermove', (e) => {
      if (!this.look.dragging) return;
      this.look.yaw -= e.movementX * 0.005; this.look.pitch = Math.max(-1.2, Math.min(1.3, this.look.pitch + e.movementY * 0.004));
      this.look.idle = 0;
    });
    el.addEventListener('wheel', (e) => { this.zoom = Math.max(0.5, Math.min(3, this.zoom * (e.deltaY > 0 ? 1.1 : 0.9))); e.preventDefault(); }, { passive: false });
    el.addEventListener('dblclick', () => { this.look.yaw = 0; this.look.pitch = 0; });
  }

  on(action, fn) { this.handlers[action] = fn; }
  fire(action, shift) { if (this.enabled) this.handlers[action]?.(shift); }
  axis(name) {
    const [pos, neg] = AXES[name];
    return (pos.some((k) => this.keys.has(k)) ? 1 : 0) - (neg.some((k) => this.keys.has(k)) ? 1 : 0);
  }

  update(dt) {
    const r = this.raw;
    r.pitch = this.axis('pitch'); r.roll = this.axis('roll'); r.yaw = this.axis('yaw'); r.throttle = this.axis('throttle');
    let brake = this.keys.has('Space') || this.keys.has('KeyB') ? 1 : 0;

    let gp = null;
    for (const p of navigator.getGamepads?.() || []) if (p && p.connected && p.axes.length >= 2) { gp = p; break; }
    let analog = false;
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const ax = dz(gp.axes[0]), ay = dz(gp.axes[1]), az = dz(gp.axes[2] || 0);
      if (ax || ay || az) { analog = true; this.roll = ax * Math.abs(ax); this.pitch = ay * Math.abs(ay); this.yaw = az; r.roll = ax; r.pitch = ay; r.yaw = az; }
      const b = (i) => gp.buttons[i]?.value || 0;
      r.throttle += b(7) - b(6);
      brake = Math.max(brake, b(0));
      const edge = (i, action) => { const d = b(i) > 0.5; if (d && !this.padPrev[i]) this.fire(action); this.padPrev[i] = d; };
      edge(2, 'flapsDown'); edge(3, 'flapsUp'); edge(1, 'camera'); edge(9, 'pause'); edge(8, 'chart');
    }
    if (!analog) {
      for (const k of ['pitch', 'roll', 'yaw']) {
        const target = r[k], rate = target !== 0 ? (Math.sign(target) !== Math.sign(this[k]) && this[k] !== 0 ? 6 : 2.6) : 5;
        this[k] += Math.max(-rate * dt, Math.min(rate * dt, target - this[k]));
      }
    }
    this.brake = brake;
    // Free-look springs back after a few idle seconds.
    if (!this.look.dragging) {
      this.look.idle += dt;
      if (this.look.idle > 4) { const k = Math.exp(-dt * 2.5); this.look.yaw *= k; this.look.pitch *= k; }
    }
  }
}
