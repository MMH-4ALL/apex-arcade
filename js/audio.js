/** Small synthesized engine: no sound files or autoplay permissions required. */
export class EngineAudio {
  constructor() {
    this.enabled = false;
    this.context = null;
  }
  async toggle() {
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return false;
      this.context = new AudioContext();
      this.oscillator = this.context.createOscillator();
      this.oscillator.type = "sawtooth";
      this.filter = this.context.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = 400;
      this.gain = this.context.createGain();
      this.gain.gain.value = 0;
      this.oscillator
        .connect(this.filter)
        .connect(this.gain)
        .connect(this.context.destination);
      this.oscillator.start();
    }
    if (this.enabled) {
      this.gain.gain.setTargetAtTime(0, this.context.currentTime, 0.05);
      this.enabled = false;
    } else {
      await this.context.resume();
      this.enabled = true;
    }
    return this.enabled;
  }
  update(speed, throttle, active) {
    if (!this.context || !this.enabled) return;
    const now = this.context.currentTime;
    const rev = Math.min(1, Math.abs(speed) / 160);
    const gearRev = (rev * 4) % 1;
    this.oscillator.frequency.setTargetAtTime(
      38 + gearRev * 65 + (throttle ? 12 : 0),
      now,
      0.12,
    );
    this.filter.frequency.setTargetAtTime(180 + rev * 700, now, 0.1);
    this.gain.gain.setTargetAtTime(active ? 0.022 + rev * 0.018 : 0, now, 0.08);
  }
  destroy() {
    this.oscillator?.stop();
    this.context?.close();
    this.enabled = false;
    this.context = null;
    this.oscillator = null;
  }
}
