import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { WheelRig } from "../js/wheels.js";

const AXLE = new THREE.Vector3(1, 0, 0);
let sourcePromise;
async function modelFixture() {
  sourcePromise ||= (async () => {
    const bytes = await readFile(new URL("../assets/car/car.glb", import.meta.url));
    return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "")).scene;
  })();
  const model = (await sourcePromise).clone(true);
  model.position.y = -0.56;
  model.updateMatrixWorld(true);
  return model;
}

function assertMatrixEqual(a, b) {
  for (let i = 0; i < 16; i++) assert(Math.abs(a.elements[i] - b.elements[i]) < 1e-7);
}

test("the actual GLB has four wheel assemblies and rigging preserves every bind pose", async () => {
  const model = await modelFixture();
  const before = new Map();
  model.traverse(object => { if (object.isMesh) before.set(object, object.matrixWorld.clone()); });
  const rig = new WheelRig(model);
  assert.equal(rig.wheels.length, 4);
  model.updateMatrixWorld(true);
  for (const [mesh, matrix] of before) assertMatrixEqual(mesh.matrixWorld, matrix);
});

test("steered front wheel axles stay level and fixed throughout a full rolling cycle", async () => {
  const model = await modelFixture();
  const rig = new WheelRig(model);
  rig.update(0, 0, -0.8);
  model.updateMatrixWorld(true);
  const initialAxles = rig.wheels.map(({wheel}) => AXLE.clone().applyQuaternion(wheel.getWorldQuaternion(new THREE.Quaternion())));
  for (let i = 0; i < 18; i++) {
    rig.update(0.08, 12, -0.8);
    model.updateMatrixWorld(true);
    rig.wheels.forEach(({wheel}, index) => {
      const axle = AXLE.clone().applyQuaternion(wheel.getWorldQuaternion(new THREE.Quaternion()));
      assert(Math.abs(axle.y) < 1e-7, "a rotating tire must not tip its axle up or down");
      assert(axle.distanceTo(initialAxles[index]) < 1e-7, "rolling cannot alter steering direction");
    });
  }
});

test("all four actual wheels remain centered on their hubs during rolling and steering", async () => {
  const model = await modelFixture();
  const rig = new WheelRig(model);
  model.updateMatrixWorld(true);
  const centers = rig.wheels.map(({wheel}) => wheel.getWorldPosition(new THREE.Vector3()));
  for (const steering of [-1, 0, 1]) {
    rig.update(0.3, 20, steering);
    model.updateMatrixWorld(true);
    rig.wheels.forEach(({wheel}, index) => assert(wheel.getWorldPosition(new THREE.Vector3()).distanceTo(centers[index]) < 1e-7));
  }
});

test("front wheels steer toward the driver's side of input while rear axles remain straight", async () => {
  const model = await modelFixture();
  const rig = new WheelRig(model);
  for (const direction of [-1, 1]) {
    rig.update(0, 0, direction);
    model.updateMatrixWorld(true);
    for (const {front, pivot} of rig.wheels) {
      const heading = new THREE.Vector3(0, 0, 1).applyQuaternion(pivot.getWorldQuaternion(new THREE.Quaternion()));
      if (front) assert(heading.x * direction > 0.1, "positive yaw is driver-left for a +Z-forward car");
      else assert(Math.abs(heading.x) < 1e-7);
    }
  }
});

test("forward rolling turns the tire top forward and reversing unwinds the same travel", async () => {
  const model = await modelFixture();
  const rig = new WheelRig(model);
  rig.update(0.01, 1, 0);
  model.updateMatrixWorld(true);
  for (const {wheel} of rig.wheels) {
    const top = new THREE.Vector3(0, 0.468, 0).applyQuaternion(wheel.quaternion);
    assert(top.z > 0, "the top of a forward-rolling tire moves toward +Z");
  }
  rig.update(0.01, -1, 0);
  assert.equal(rig.distance, 0);
  for (const {wheel, bindQuaternion} of rig.wheels) assert(wheel.quaternion.angleTo(bindQuaternion) < 1e-7);
});

test("respawn reset clears steering and roll without moving wheel mounts", async () => {
  const model = await modelFixture();
  const rig = new WheelRig(model);
  const positions = rig.wheels.map(({pivot}) => pivot.position.clone());
  rig.update(2, 30, 1);
  rig.reset();
  for (const [index, {wheel, pivot, bindQuaternion}] of rig.wheels.entries()) {
    assert(pivot.position.equals(positions[index]));
    assert.equal(pivot.rotation.y, 0);
    assert(wheel.quaternion.angleTo(bindQuaternion) < 1e-7);
  }
});
