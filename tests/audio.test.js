import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineAudio } from "../js/audio.js";

test("a denied audio resume leaves sound disabled and the next click retries", async () => {
  let attempts = 0;
  const node = () => ({ connect() { return this; }, start() {}, stop() {},
    frequency: { value: 0, setTargetAtTime() {} },
    gain: { value: 0, setTargetAtTime() {} } });
  class AudioContext {
    currentTime = 0;
    destination = {};
    createOscillator = node;
    createBiquadFilter = node;
    createGain = node;
    async resume() {
      if (++attempts === 1) throw new Error("Audio permission denied");
    }
    close() {}
  }
  const original = globalThis.window;
  globalThis.window = { AudioContext };
  try {
    const audio = new EngineAudio();
    await assert.rejects(audio.toggle(), /denied/);
    assert.equal(audio.enabled, false);
    assert.equal(await audio.toggle(), true);
    assert.equal(attempts, 2);
    assert.equal(await audio.toggle(), false);
    audio.destroy();
    audio.destroy();
    assert.equal(audio.context, null);
    assert.equal(audio.enabled, false);
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});
