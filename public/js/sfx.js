// Pure WebAudio Tactile Neo-Brutalist Micro-SFX Engine (Zero External Audio Dependencies)
class BrutalSFX {
  constructor() {
    this.enabled = localStorage.getItem('oddware_sfx') !== 'off';
    this.ctx = null;
  }

  ensure() {
    if (!this.enabled) return false;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    } catch (_) {
      return false;
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('oddware_sfx', this.enabled ? 'on' : 'off');
    if (this.enabled) this.click();
    return this.enabled;
  }

  tick() {
    if (!this.ensure()) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(1100, t);
    g.gain.setValueAtTime(0.018, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
    o.connect(g);
    g.connect(this.ctx.destination);
    o.start(t);
    o.stop(t + 0.025);
  }

  click() {
    if (!this.ensure()) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(340, t);
    o.frequency.exponentialRampToValueAtTime(680, t + 0.055);
    g.gain.setValueAtTime(0.045, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    o.connect(g);
    g.connect(this.ctx.destination);
    o.start(t);
    o.stop(t + 0.06);
  }

  boot() {
    if (!this.ensure()) return;
    [260, 390, 520, 780].forEach((freq, idx) => {
      const t = this.ctx.currentTime + idx * 0.045;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.04, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      o.connect(g);
      g.connect(this.ctx.destination);
      o.start(t);
      o.stop(t + 0.09);
    });
  }
}

export const sfx = new BrutalSFX();
