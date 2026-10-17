/**
 * Процедурний звуковий рушій Web Audio API з симуляцією тракту дешевого мікрофона
 * нагрудної камери (Axon Body 3):
 * - Вузькосмугова частотна характеристика мікрофона (300 Hz – 3.6 kHz)
 * - Жорсткий асиметричний кліпінг (WaveShaper) при пострілах та вибухах
 * - Автоматичне просідання (ducking) навколишніх звуків під час перевантаження мікрофона
 * - Звук вмикання окулярів нічного бачення AN/PVS-31 (писк високовольтного перетворювача)
 * - Сигнал тактичної рації при ротації карти та командних подіях
 */
export class BodycamAudioEngine {
  constructor() {
    this.ctx = null;
    this.initialized = false;
    this.isMuted = false;
    this.clipAmount = 0.85;
    this.tinnitusLevel = 0.0;
    this.stressLevel = 0.15;
    this.breathTimer = 0;
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.initialized && this.outputGain && this.ctx) {
      this.outputGain.gain.setValueAtTime(this.isMuted ? 0.0 : 1.0, this.ctx.currentTime);
    }
    return this.isMuted;
  }

  init() {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
      return;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();

    // Головний вихідний вузол для миттєвого режиму без звуку [Z]
    this.outputGain = this.ctx.createGain();
    this.outputGain.gain.value = this.isMuted ? 0.0 : 1.0;
    this.outputGain.connect(this.ctx.destination);

    // Вузькосмуговий фільтр дешевого електретного мікрофона нагрудної камери
    this.highpass = this.ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = 290;
    this.highpass.Q.value = 0.85;

    this.midPeak = this.ctx.createBiquadFilter();
    this.midPeak.type = 'peaking';
    this.midPeak.frequency.value = 1850;
    this.midPeak.Q.value = 1.4;
    this.midPeak.gain.value = 7.5;

    this.lowpass = this.ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 3650;
    this.lowpass.Q.value = 0.9;

    // Фільтр глухоти при контузії від гранати
    this.concussionFilter = this.ctx.createBiquadFilter();
    this.concussionFilter.type = 'lowpass';
    this.concussionFilter.frequency.value = 16000;

    // Нелінійний WaveShaper для жорсткого перевантаження (кліпінгу) мікрофона
    this.clipper = this.ctx.createWaveShaper();
    this.updateClipCurve(this.clipAmount);
    this.clipper.oversample = '2x';

    // Агресивний AGC-компресор нагрудної камери
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 4;
    this.compressor.ratio.value = 18;
    this.compressor.attack.value = 0.001;
    this.compressor.release.value = 0.28;

    // Штучна клаустрофобна реверберація
    this.reverbConvolver = this.ctx.createConvolver();
    this.reverbConvolver.buffer = this.createConcreteImpulse(1.25, 3.8);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.36;

    this.masterBus = this.ctx.createGain();
    this.masterBus.gain.value = 0.9;

    this.masterBus.connect(this.highpass);
    this.masterBus.connect(this.reverbConvolver);
    this.reverbConvolver.connect(this.reverbGain);
    this.reverbGain.connect(this.highpass);

    this.highpass.connect(this.midPeak);
    this.midPeak.connect(this.lowpass);
    this.lowpass.connect(this.concussionFilter);
    this.concussionFilter.connect(this.clipper);
    this.clipper.connect(this.compressor);
    this.compressor.connect(this.outputGain);

    this.startMicPreampHiss();

    this.tinnitusOsc = this.ctx.createOscillator();
    this.tinnitusOsc.type = 'sine';
    this.tinnitusOsc.frequency.value = 4180;
    this.tinnitusGain = this.ctx.createGain();
    this.tinnitusGain.gain.value = 0.0;
    this.tinnitusOsc.connect(this.tinnitusGain);
    this.tinnitusGain.connect(this.outputGain);
    this.tinnitusOsc.start();

    this.initialized = true;
  }

  updateClipCurve(amount = 0.85) {
    this.clipAmount = amount;
    if (!this.clipper) return;
    const samples = 2048;
    const curve = new Float32Array(samples);
    const k = 12 + amount * 95;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      const raw = ((1 + k) * x) / (1 + k * Math.abs(x));
      curve[i] = Math.max(-0.78, Math.min(0.84, raw + 0.06 * x * x));
    }
    this.clipper.curve = curve;
  }

  createConcreteImpulse(duration = 1.25, decay = 3.8) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const impulse = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, decay);
        const earlyBoost = i < rate * 0.06 ? 1.55 : 1.0;
        data[i] = (Math.random() * 2 - 1) * env * earlyBoost;
      }
    }
    return impulse;
  }

  startMicPreampHiss() {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate * 2, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.011;
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    const gain = this.ctx.createGain();
    gain.gain.value = 0.12;
    noise.connect(gain);
    gain.connect(this.highpass);
    noise.start();
  }

  /**
   * Характерний звук опускання кріплення шолома та високочастотний писк
   * запуску окулярів нічного бачення AN/PVS-31 (Клавіша [N])
   */
  playNvgToggle(turningOn = true) {
    if (!this.initialized || this.isMuted) return;
    const now = this.ctx.currentTime;

    // 1. Механічне клацання відкидного кронштейна Wilcox G24 на шоломі
    const clickOsc = this.ctx.createOscillator();
    clickOsc.type = 'square';
    clickOsc.frequency.setValueAtTime(turningOn ? 920 : 740, now);
    clickOsc.frequency.exponentialRampToValueAtTime(280, now + 0.045);

    const clickGain = this.ctx.createGain();
    clickGain.gain.setValueAtTime(0.32, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    clickOsc.connect(clickGain);
    clickGain.connect(this.masterBus);
    clickOsc.start(now);
    clickOsc.stop(now + 0.055);

    // 2. Високочастотний писк конденсатора ЕОП (1.6 kHz -> 8.8 kHz при вмиканні)
    const whineOsc = this.ctx.createOscillator();
    whineOsc.type = 'sine';
    const whineGain = this.ctx.createGain();

    if (turningOn) {
      whineOsc.frequency.setValueAtTime(1650, now + 0.04);
      whineOsc.frequency.exponentialRampToValueAtTime(8400, now + 0.72);
      whineGain.gain.setValueAtTime(0.14, now + 0.04);
      whineGain.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
    } else {
      whineOsc.frequency.setValueAtTime(6200, now + 0.03);
      whineOsc.frequency.exponentialRampToValueAtTime(950, now + 0.38);
      whineGain.gain.setValueAtTime(0.10, now + 0.03);
      whineGain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);
    }

    whineOsc.connect(whineGain);
    whineGain.connect(this.outputGain);
    whineOsc.start(now + 0.03);
    whineOsc.stop(now + 0.88);
  }

  /**
   * Тактичний сигнал рації Motorola/Axon при зміні карти кожні 60 с або командному очку
   */
  playRadioBeep(type = 'map_rotate') {
    if (!this.initialized) return;
    const now = this.ctx.currentTime;

    const tone = (start, freq, dur = 0.06, amp = 0.18) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(amp, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.connect(g);
      g.connect(this.masterBus);
      osc.start(start);
      osc.stop(start + dur + 0.01);
    };

    if (type === 'map_rotate') {
      tone(now, 2150, 0.055, 0.24);
      tone(now + 0.075, 2650, 0.085, 0.26);
    } else {
      tone(now, 1850, 0.045, 0.16);
    }
  }

  playGunshot(isPlayer = true, distance = 0) {
    if (!this.initialized) return;
    const now = this.ctx.currentTime;
    const distAtten = isPlayer ? 1.0 : Math.max(0.16, 1.0 / (1.0 + distance * 0.08));

    const noiseDur = 0.32;
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * noiseDur), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length;
      const crack = i < this.ctx.sampleRate * 0.018 ? 3.2 : 1.0;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.4) * crack;
    }

    const noiseSrc = this.ctx.createBufferSource();
    noiseSrc.buffer = buf;

    const shotGain = this.ctx.createGain();
    const peakGain = (isPlayer ? 3.6 : 2.0) * distAtten * (0.55 + this.clipAmount);
    shotGain.gain.setValueAtTime(peakGain, now);
    shotGain.gain.exponentialRampToValueAtTime(0.01, now + noiseDur);

    noiseSrc.connect(shotGain);
    shotGain.connect(this.masterBus);
    noiseSrc.start(now);

    const punchOsc = this.ctx.createOscillator();
    punchOsc.type = 'triangle';
    punchOsc.frequency.setValueAtTime(isPlayer ? 155 : 130, now);
    punchOsc.frequency.exponentialRampToValueAtTime(36, now + 0.11);

    const punchGain = this.ctx.createGain();
    punchGain.gain.setValueAtTime(1.8 * distAtten, now);
    punchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    punchOsc.connect(punchGain);
    punchGain.connect(this.masterBus);
    punchOsc.start(now);
    punchOsc.stop(now + 0.12);

    if (isPlayer) {
      const boltOsc = this.ctx.createOscillator();
      boltOsc.type = 'sawtooth';
      boltOsc.frequency.setValueAtTime(1420, now + 0.015);
      boltOsc.frequency.exponentialRampToValueAtTime(520, now + 0.065);

      const boltGain = this.ctx.createGain();
      boltGain.gain.setValueAtTime(0.45, now + 0.015);
      boltGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

      boltOsc.connect(boltGain);
      boltGain.connect(this.masterBus);
      boltOsc.start(now + 0.015);
      boltOsc.stop(now + 0.075);

      this.scheduleShellBounce(now + 0.38 + Math.random() * 0.12);
    }
  }

  scheduleShellBounce(startTime) {
    if (!this.initialized) return;
    const bounces = 3;
    for (let b = 0; b < bounces; b++) {
      const t = startTime + b * (0.09 + Math.random() * 0.04);
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      const baseFreq = 3250 + Math.random() * 480;
      osc.frequency.setValueAtTime(baseFreq, t);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.18, t + 0.028);

      const g = this.ctx.createGain();
      const amp = 0.12 * Math.pow(0.55, b);
      g.gain.setValueAtTime(amp, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.032);

      osc.connect(g);
      g.connect(this.masterBus);
      osc.start(t);
      osc.stop(t + 0.035);
    }
  }

  playFootstep(inPuddle = false, sprinting = false) {
    if (!this.initialized) return;
    const now = this.ctx.currentTime;

    const thudOsc = this.ctx.createOscillator();
    thudOsc.type = 'sine';
    thudOsc.frequency.setValueAtTime(inPuddle ? 120 : 95, now);
    thudOsc.frequency.exponentialRampToValueAtTime(38, now + 0.075);

    const thudGain = this.ctx.createGain();
    thudGain.gain.setValueAtTime(sprinting ? 0.42 : 0.25, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);

    thudOsc.connect(thudGain);
    thudGain.connect(this.masterBus);
    thudOsc.start(now);
    thudOsc.stop(now + 0.09);

    const rustleDur = inPuddle ? 0.16 : 0.11;
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * rustleDur), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const env = Math.sin((i / data.length) * Math.PI);
      data[i] = (Math.random() * 2 - 1) * env * (inPuddle ? 0.36 : 0.22);
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = inPuddle ? 2400 : 1650;
    filter.Q.value = 1.2;

    src.connect(filter);
    filter.connect(this.masterBus);
    src.start(now);
  }

  playGearRustle(intensity = 0.25) {
    if (!this.initialized) return;
    const now = this.ctx.currentTime;
    const dur = 0.18;
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const env = Math.sin((i / data.length) * Math.PI);
      data[i] = (Math.random() * 2 - 1) * env * intensity;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1450;
    src.connect(bp);
    bp.connect(this.masterBus);
    src.start(now);
  }

  playWeaponHandling(type = 'reload') {
    if (!this.initialized) return;
    const now = this.ctx.currentTime;
    this.playGearRustle(0.32);

    const click = (time, freq, dur = 0.04, amp = 0.28) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, time);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.45, time + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(amp, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + dur);
      osc.connect(g);
      g.connect(this.masterBus);
      osc.start(time);
      osc.stop(time + dur + 0.01);
    };

    if (type === 'dry') {
      click(now, 1650, 0.025, 0.35);
    } else if (type === 'check') {
      click(now + 0.08, 920, 0.04, 0.24);
      click(now + 0.55, 1180, 0.035, 0.28);
    } else if (type === 'reload') {
      click(now + 0.12, 880, 0.045, 0.34);
      click(now + 0.68, 640, 0.06, 0.38);
      click(now + 1.05, 1120, 0.05, 0.42);
      click(now + 1.42, 1560, 0.045, 0.46);
    }
  }

  playFlashbangExplosion(distance = 4.0) {
    if (!this.initialized) return;
    const now = this.ctx.currentTime;
    const closeness = Math.max(0.15, Math.min(1.0, 10.0 / Math.max(distance, 2.0)));

    const dur = 0.85;
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 1.45) * 4.5;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(4.8 * closeness, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + dur);

    src.connect(g);
    g.connect(this.masterBus);
    src.start(now);

    this.concussionFilter.frequency.cancelScheduledValues(now);
    this.concussionFilter.frequency.setValueAtTime(380, now);
    this.concussionFilter.frequency.exponentialRampToValueAtTime(14000, now + 5.5 * closeness);

    this.tinnitusGain.gain.cancelScheduledValues(now);
    this.tinnitusGain.gain.setValueAtTime(0.16 * closeness, now + 0.05);
    this.tinnitusGain.gain.exponentialRampToValueAtTime(0.0001, now + 5.8 * closeness);
  }

  playImpact(type = 'concrete') {
    if (!this.initialized) return;
    const now = this.ctx.currentTime;

    if (type === 'bodycam_drop') {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(210, now);
      osc.frequency.exponentialRampToValueAtTime(28, now + 0.24);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(2.6, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
      osc.connect(g);
      g.connect(this.masterBus);
      osc.start(now);
      osc.stop(now + 0.27);
      return;
    }

    const dur = 0.09;
    const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2.0);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = type === 'flesh' ? 620 : 2150;

    const g = this.ctx.createGain();
    g.gain.value = type === 'flesh' ? 0.65 : 0.45;

    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterBus);
    src.start(now);
  }

  updateBreathing(dt, stress = 0.2) {
    if (!this.initialized) return;
    this.stressLevel = Math.max(0.15, Math.min(1.0, stress));
    const breathInterval = 2.4 - this.stressLevel * 1.35;
    this.breathTimer += dt;

    if (this.breathTimer >= breathInterval) {
      this.breathTimer = 0;
      const now = this.ctx.currentTime;
      const dur = 0.48 - this.stressLevel * 0.16;
      const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * dur), this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const env = Math.sin((i / data.length) * Math.PI);
        data[i] = (Math.random() * 2 - 1) * env;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 980 + this.stressLevel * 320;
      bp.Q.value = 2.1;

      const g = this.ctx.createGain();
      g.gain.value = 0.045 + this.stressLevel * 0.12;

      src.connect(bp);
      bp.connect(g);
      g.connect(this.masterBus);
      src.start(now);
    }
  }
}
