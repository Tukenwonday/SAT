// WebAudio SFX synthesizer (pure Web Audio API, 0 external audio files)
let audioCtx = null;

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) {
    try { audioCtx = new Ctx(); } catch (e) { return null; }
  }
  if (audioCtx.state === 'suspended') {
    try { audioCtx.resume().catch(() => {}); } catch (e) {}
  }
  return audioCtx;
}

function tone(f0, f1, delay = 0, dur = 0.1, type = 'sine', vol = 0.08) {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    const t = ctx.currentTime + delay;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  } catch (e) {}
}

export const sound = {
  good() { tone(660, 990, 0, 0.1); tone(1320, 1320, 0.02, 0.08, 'sine', 0.05); },
  bad() { tone(220, 130, 0, 0.18, 'sawtooth', 0.07); },
  tick() { tone(1200, 1200, 0, 0.04, 'square', 0.03); },
  pop() { tone(500, 900, 0, 0.09); },
  chime() { tone(784, 784, 0, 0.12); tone(1047, 1047, 0.1, 0.18); },
  alert() { tone(659, 659, 0, 0.12); tone(880, 880, 0.13, 0.16); },
  count(i = 0) { tone(440 + i * 160, 440 + i * 160, 0, 0.12); },
  whoosh() { tone(300, 900, 0, 0.16, 'sine', 0.06); },
  tada() { [523, 659, 784].forEach((f, i) => tone(f, f * 1.01, i * 0.08, 0.14)); },
  fanfare() {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = [
      { f: 349.23, time: 0.00, dur: 0.55, gain: 0.18 },
      { f: 440.00, time: 0.09, dur: 0.55, gain: 0.20 },
      { f: 523.25, time: 0.18, dur: 0.60, gain: 0.22 },
      { f: 659.25, time: 0.27, dur: 0.70, gain: 0.25 },
      { f: 783.99, time: 0.36, dur: 0.85, gain: 0.26 },
      { f: 1046.50, time: 0.46, dur: 1.60, gain: 0.30 }
    ];
    notes.forEach(n => {
      try {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        const t = now + n.time;
        o.frequency.setValueAtTime(n.f, t);
        g.gain.setValueAtTime(n.gain, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t);
        o.stop(t + n.dur + 0.1);
      } catch (e) {}
    });
  }
};

