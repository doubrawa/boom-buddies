/* Web-Audio sound effects.  Everything is synthesized — no external
   sample files — but the textures are layered enough to read as "game
   SFX" rather than calculator beeps.  Each public sfx fires multiple
   short sources (oscillator + filtered noise + envelopes) wired through
   a shared master gain.

   The AudioContext is created lazily on first play because most browsers
   require a user gesture before audio can start; the very first user
   click anywhere in the app warms it up. */

let ctx = null;
let masterGain = null;
let muted = false;

function ensureCtx(){
  if(ctx) return ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.35;
    masterGain.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

function attachUnlock(){
  const unlock = () => {
    const c = ensureCtx();
    if(c && c.state === 'suspended') c.resume().catch(()=>{});
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}
if(typeof window !== 'undefined') attachUnlock();

export function setMuted(m){ muted = !!m; }
export function isMuted(){ return muted; }

/* ============ low-level helpers ============ */

/* Reusable noise buffer — a single second of white noise, looped/sliced
   as needed.  Cheaper than allocating a buffer per sound. */
let noiseBuf = null;
function getNoiseBuf(c){
  if(noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  const len = Math.floor(c.sampleRate * 2);
  noiseBuf = c.createBuffer(1, len, c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for(let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/* Oscillator with attack/decay envelope and optional frequency sweep. */
function tone({ freq=440, type='sine', dur=0.1, attack=0.005, decay=0.08,
                gain=0.4, freqEnd=null, detune=0, delay=0 } = {}){
  if(muted) return;
  const c = ensureCtx(); if(!c || c.state === 'suspended') return;
  const t = c.currentTime + delay;
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.detune.value = detune;
  if(freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + attack);
  env.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);
  osc.connect(env); env.connect(masterGain);
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
}

/* Filtered noise burst.  `filterType` selects lowpass/bandpass/highpass. */
function noise({ dur=0.4, gain=0.4, filterType='lowpass',
                 freqStart=1200, freqEnd=200, q=1, delay=0 } = {}){
  if(muted) return;
  const c = ensureCtx(); if(!c || c.state === 'suspended') return;
  const t = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = getNoiseBuf(c);
  const filt = c.createBiquadFilter();
  filt.type = filterType;
  filt.Q.value = q;
  filt.frequency.setValueAtTime(freqStart, t);
  filt.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t + dur);
  const env = c.createGain();
  env.gain.setValueAtTime(gain, t);
  env.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(filt); filt.connect(env); env.connect(masterGain);
  src.start(t); src.stop(t + dur + 0.05);
}

/* Detuned-pair oscillator: two oscillators a few cents apart for warmth. */
function fatTone(opts){
  tone({ ...opts, detune: -8 });
  tone({ ...opts, detune: +8, gain: (opts.gain ?? 0.4) * 0.85 });
}

/* ============ public sound API ============ */

/* Bomb place — soft wooden thunk: muffled mid-low pitch + tiny click. */
export function sfxBombPlace(){
  tone({ freq: 180, type: 'sine', dur: 0.12, attack: 0.001, decay: 0.11,
         gain: 0.45, freqEnd: 80 });
  noise({ dur: 0.04, gain: 0.20, filterType: 'highpass',
          freqStart: 4000, freqEnd: 2000 });
}

/* Fuse tick — short clicky blip, low volume so it doesn't drown gameplay. */
export function sfxFuseTick(){
  tone({ freq: 1200, type: 'triangle', dur: 0.04, attack: 0.001, decay: 0.035, gain: 0.14 });
  noise({ dur: 0.02, gain: 0.06, filterType: 'highpass', freqStart: 5000, freqEnd: 3000 });
}

/* Explosion — sub thud + mid crackle + high snap, layered.  Reads as a
   chunky impact rather than the pure sine thump of the old version. */
export function sfxExplosion(){
  /* Sub-bass thump that gives the boom its weight. */
  tone({ freq: 110, type: 'sine', dur: 0.45, attack: 0.001, decay: 0.42,
         gain: 0.6, freqEnd: 35 });
  /* Mid-range body — filtered noise sweeping low. */
  noise({ dur: 0.5, gain: 0.55, filterType: 'lowpass',
          freqStart: 1800, freqEnd: 80 });
  /* Bright initial crackle that gives the attack snap. */
  noise({ dur: 0.12, gain: 0.4, filterType: 'highpass',
          freqStart: 5000, freqEnd: 1500 });
  /* A tiny ringing layer for character. */
  tone({ freq: 220, type: 'square', dur: 0.18, attack: 0.001, decay: 0.16,
         gain: 0.18, freqEnd: 90 });
}

/* Pickup — three rising fat tones forming a triumph triplet. */
export function sfxPickup(){
  fatTone({ freq: 660, type: 'triangle', dur: 0.10, attack: 0.002, decay: 0.08, gain: 0.32 });
  fatTone({ freq: 880, type: 'triangle', dur: 0.11, attack: 0.002, decay: 0.09, gain: 0.32, delay: 0.07 });
  fatTone({ freq: 1318, type: 'triangle', dur: 0.16, attack: 0.002, decay: 0.13, gain: 0.34, delay: 0.15 });
  /* A bright bell-like harmonic on the final note. */
  tone({ freq: 2637, type: 'sine', dur: 0.20, attack: 0.001, decay: 0.18, gain: 0.10, delay: 0.15 });
}

/* Death — descending wail with vibrato-ish dual oscillators. */
export function sfxDeath(){
  tone({ freq: 520, type: 'sawtooth', dur: 0.5, attack: 0.005, decay: 0.45,
         gain: 0.32, freqEnd: 80 });
  tone({ freq: 525, type: 'sawtooth', dur: 0.5, attack: 0.005, decay: 0.45,
         gain: 0.28, freqEnd: 78, detune: 12 });
  noise({ dur: 0.15, gain: 0.18, filterType: 'lowpass',
          freqStart: 800, freqEnd: 200, delay: 0.35 });
}

/* Round end — three-note major triumph with a sustained low under it. */
export function sfxRoundEnd(){
  fatTone({ freq: 523, type: 'triangle', dur: 0.18, attack: 0.005, decay: 0.16, gain: 0.4 });
  fatTone({ freq: 659, type: 'triangle', dur: 0.18, attack: 0.005, decay: 0.16, gain: 0.4, delay: 0.14 });
  fatTone({ freq: 784, type: 'triangle', dur: 0.34, attack: 0.005, decay: 0.32, gain: 0.45, delay: 0.28 });
  tone({ freq: 261, type: 'sine', dur: 0.6, attack: 0.02, decay: 0.55, gain: 0.18 });
}

/* Shield — bright metallic ting, two harmonics. */
export function sfxShield(){
  tone({ freq: 1200, type: 'sine', dur: 0.18, attack: 0.001, decay: 0.16,
         gain: 0.30, freqEnd: 1800 });
  tone({ freq: 2880, type: 'sine', dur: 0.20, attack: 0.001, decay: 0.18,
         gain: 0.12, freqEnd: 4320 });
}

/* Earthquake — a long, deep rumble across the duration of the effect. */
export function sfxEarthquake(){
  /* Sub-rumble: heavily lowpassed noise. */
  noise({ dur: 2.6, gain: 0.55, filterType: 'lowpass',
          freqStart: 220, freqEnd: 80, q: 0.7 });
  /* Body: bandpass noise oscillating in the low-mids. */
  noise({ dur: 2.6, gain: 0.30, filterType: 'bandpass',
          freqStart: 320, freqEnd: 140, q: 1.5 });
  /* A pitched groan layer underneath. */
  tone({ freq: 70, type: 'sawtooth', dur: 2.5, attack: 0.05, decay: 2.45,
         gain: 0.22, freqEnd: 55 });
  tone({ freq: 71, type: 'sawtooth', dur: 2.5, attack: 0.05, decay: 2.45,
         gain: 0.20, freqEnd: 56, detune: -10 });
}
