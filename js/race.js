/** Pure lap logic. Gates must be crossed in sequence and in the forward direction. */
export class RaceSession {
  constructor(gates, { onLap = () => {}, onCheckpoint = () => {} } = {}) {
    if (gates.length < 3)
      throw new Error("A circuit needs at least three checkpoint gates.");
    this.gates = gates;
    this.onLap = onLap;
    this.onCheckpoint = onCheckpoint;
    this.restart();
  }
  restart() {
    this.lap = 1;
    this.elapsed = 0;
    this.nextGate = 1;
    this.lastGate = 0;
    this.valid = true;
    this.previous = null;
    this.offTrackTime = 0;
  }
  invalidate() {
    this.valid = false;
    this.previous = null;
  }
  update(dt, position, onRoad = true) {
    this.elapsed += dt;
    this.offTrackTime = onRoad ? 0 : this.offTrackTime + dt;
    if (this.offTrackTime > 1.5) this.valid = false;
    if (this.previous) {
      const gate = this.gates[this.nextGate];
      const p = gate.position,
        n = gate.forward;
      const oldSide =
        (this.previous.x - p.x) * n.x + (this.previous.z - p.z) * n.z;
      const newSide = (position.x - p.x) * n.x + (position.z - p.z) * n.z;
      if (oldSide <= 0 && newSide > 0) {
        const fraction = -oldSide / (newSide - oldSide);
        const x =
          this.previous.x + (position.x - this.previous.x) * fraction - p.x;
        const z =
          this.previous.z + (position.z - this.previous.z) * fraction - p.z;
        const y = this.previous.y + (position.y - this.previous.y) * fraction;
        if (
          Math.abs(x * n.z - z * n.x) <= gate.halfWidth &&
          Math.abs(y - p.y) < 5
        ) {
          this.lastGate = this.nextGate;
          if (this.nextGate === 0) {
            // Interpolate finish crossing within the fixed simulation step.
            const remainder = dt * (1 - fraction);
            this.onLap({
              lap: this.lap,
              time: this.elapsed - remainder,
              valid: this.valid,
            });
            this.lap++;
            this.elapsed = remainder;
            this.valid = true;
            this.offTrackTime = 0;
          } else this.onCheckpoint(this.nextGate);
          this.nextGate = (this.nextGate + 1) % this.gates.length;
        }
      }
    }
    this.previous = { x: position.x, y: position.y, z: position.z };
  }
  get progress() {
    return this.nextGate === 0 ? 1 : (this.nextGate - 1) / this.gates.length;
  }
}
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "— — : — — . — — —";
  const ms = Math.floor(seconds * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
