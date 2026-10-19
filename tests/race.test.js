import test from "node:test";
import assert from "node:assert/strict";
import { RaceSession, formatTime } from "../js/race.js";

// A square circuit with a different forward normal at each checkpoint.
// No DOM, graphics context, network connection, or npm packages are needed.
const gates = [
  { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, z: 1 }, halfWidth: 4 },
  { position: { x: 0, y: 0, z: 20 }, forward: { x: 1, z: 0 }, halfWidth: 4 },
  { position: { x: 20, y: 0, z: 20 }, forward: { x: 0, z: -1 }, halfWidth: 4 },
  { position: { x: 20, y: 0, z: 0 }, forward: { x: -1, z: 0 }, halfWidth: 4 },
];

function makeRace() {
  const laps = [],
    checkpoints = [];
  const race = new RaceSession(gates, {
    onLap: (result) => laps.push(result),
    onCheckpoint: (index) => checkpoints.push(index),
  });
  race.update(0, { x: 0, y: 0, z: -4 });
  return { race, laps, checkpoints };
}

function cross(race, index, dt = 2) {
  const { position: p, forward: n } = gates[index];
  race.update(dt, { x: p.x - n.x * 2, y: p.y, z: p.z - n.z * 2 });
  race.update(dt, { x: p.x + n.x * 2, y: p.y, z: p.z + n.z * 2 });
}

test("a complete lap requires every gate in order and interpolates finish time", () => {
  const { race, laps, checkpoints } = makeRace();
  for (const index of [1, 2, 3]) cross(race, index);
  assert.deepEqual(checkpoints, [1, 2, 3]);
  assert.equal(race.nextGate, 0);
  assert.equal(race.progress, 1);
  assert.equal(laps.length, 0);
  cross(race, 0);
  assert.deepEqual(laps, [{ lap: 1, time: 15, valid: true }]);
  assert.equal(
    race.elapsed,
    1,
    "the portion after the crossing belongs to the next lap",
  );
  assert.equal(race.lap, 2);
  assert.equal(race.nextGate, 1);
  assert.equal(race.progress, 0);
  for (const index of [1, 2, 3, 0]) cross(race, index);
  assert.deepEqual(laps[1], { lap: 2, time: 16, valid: true });
});

test("oscillating across the start line cannot generate a lap", () => {
  const { race, laps, checkpoints } = makeRace();
  for (let i = 0; i < 30; i++)
    race.update(0.1, { x: 0, y: 0, z: i % 2 ? -3 : 3 });
  assert.equal(laps.length, 0);
  assert.deepEqual(checkpoints, []);
  assert.equal(race.nextGate, 1);
  assert.equal(race.lap, 1);
});

test("crossing checkpoints out of sequence cannot skip the next checkpoint", () => {
  const { race, laps, checkpoints } = makeRace();
  cross(race, 2);
  cross(race, 3);
  cross(race, 0);
  assert.equal(race.nextGate, 1);
  assert.deepEqual(checkpoints, []);
  assert.equal(laps.length, 0);
  cross(race, 1);
  assert.equal(race.nextGate, 2);
  cross(race, 0);
  assert.equal(race.nextGate, 2);
  assert.equal(laps.length, 0);
});

test("crossing the finish in reverse does not complete an otherwise ready lap", () => {
  const { race, laps } = makeRace();
  for (const index of [1, 2, 3]) cross(race, index);
  race.update(1, { x: 0, y: 0, z: 2 });
  race.update(1, { x: 0, y: 0, z: -2 });
  assert.equal(race.nextGate, 0);
  assert.equal(laps.length, 0);
  race.update(1, { x: 0, y: 0, z: 2 });
  assert.equal(laps.length, 1);
  assert.equal(laps[0].valid, true);
});

test("a reverse checkpoint crossing receives no checkpoint credit", () => {
  const { race, checkpoints } = makeRace();
  // Approach the positive side outside the gate first, then return through it.
  race.update(1, { x: 2, y: 0, z: 40 });
  race.update(1, { x: 2, y: 0, z: 20 });
  race.update(1, { x: -2, y: 0, z: 20 });
  assert.deepEqual(checkpoints, []);
  assert.equal(race.nextGate, 1);
});

test("crossing a gate plane outside its width or altitude receives no credit", () => {
  for (const { y, z } of [
    { y: 0, z: 24.1 },
    { y: 5.1, z: 20 },
  ]) {
    const { race, checkpoints } = makeRace();
    race.update(1, { x: -2, y, z });
    race.update(1, { x: 2, y, z });
    assert.equal(race.nextGate, 1);
    assert.deepEqual(checkpoints, []);
  }
});

test("respawning invalidates the lap and clears the segment used for gate detection", () => {
  const { race, laps } = makeRace();
  cross(race, 1);
  race.invalidate();
  assert.equal(race.valid, false);
  assert.equal(race.previous, null);
  assert.equal(race.lastGate, 1);
  assert.equal(race.nextGate, 2);
  // A teleport across the next plane must not be treated as driving through it.
  race.update(0.1, { x: 20, y: 0, z: 18 });
  assert.equal(race.nextGate, 2);
  for (const index of [2, 3, 0]) cross(race, index);
  assert.equal(laps.length, 1);
  assert.equal(laps[0].valid, false);
  assert.equal(
    race.valid,
    true,
    "a fresh lap becomes eligible after the finish",
  );
  for (const index of [1, 2, 3, 0]) cross(race, index);
  assert.equal(laps[1].valid, true);
});

test("sustained off-road driving invalidates a lap until its finish", () => {
  const { race, laps } = makeRace();
  const position = { x: 0, y: 0, z: -4 };
  race.update(0.8, position, false);
  race.update(0.7, position, false);
  assert.equal(race.valid, true, "the 1.5 second grace period is inclusive");
  race.update(0.01, position, false);
  assert.equal(race.valid, false);
  race.update(0.1, position, true);
  assert.equal(
    race.valid,
    false,
    "returning to the road does not restore lap eligibility",
  );
  for (const index of [1, 2, 3, 0]) cross(race, index);
  assert.equal(laps[0].valid, false);
  assert.equal(race.valid, true);
});

test("separate brief off-road excursions do not accumulate", () => {
  const { race } = makeRace();
  const position = { x: 0, y: 0, z: -4 };
  race.update(1, position, false);
  race.update(0.1, position, true);
  race.update(1, position, false);
  assert.equal(race.valid, true);
  assert.equal(race.offTrackTime, 1);
});

test("restart restores all timing, checkpoint, and eligibility state", () => {
  const { race } = makeRace();
  cross(race, 1);
  race.invalidate();
  race.update(2, { x: 200, y: 0, z: 200 }, false);
  race.restart();
  assert.equal(race.elapsed, 0);
  assert.equal(race.lap, 1);
  assert.equal(race.nextGate, 1);
  assert.equal(race.lastGate, 0);
  assert.equal(race.valid, true);
  assert.equal(race.previous, null);
  assert.equal(race.offTrackTime, 0);
});

test("time formatting handles milliseconds, minute rollover, and missing records", () => {
  assert.equal(formatTime(0), "00:00.000");
  assert.equal(formatTime(12.3459), "00:12.345");
  assert.equal(formatTime(61.007), "01:01.007");
  assert.equal(formatTime(6000), "100:00.000");
  for (const value of [Infinity, NaN, -1])
    assert.equal(formatTime(value), "— — : — — . — — —");
});

test("a circuit with fewer than three gates is rejected", () => {
  assert.throws(() => new RaceSession(gates.slice(0, 2)), /at least three/);
});
