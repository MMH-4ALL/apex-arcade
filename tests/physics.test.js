import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CarController } from "../js/car.js";
import { createMeshColliders, TrackBroadphase } from "../js/track.js";

// The production modules need keyboard event targets, not a DOM or WebGL renderer.
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
};
const STEP = 1 / 60;

function advance(world, car, seconds) {
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    car.beforeStep(STEP);
    world.step(STEP);
  }
  car.afterStep(1);
}

function flatWorld(height = 1.4) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new TrackBroadphase();
  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  ground.aabbNeedsUpdate = true;
  world.addBody(ground);
  const car = new CarController({
    world,
    scene: new THREE.Scene(),
    spawn: { position: { x: 0, y: height, z: 0 }, heading: 0 },
  });
  car.setEnabled(true);
  return { world, car };
}

test("suspension settles, acceleration has a speed limit, steering and reverse work", () => {
  const { world, car } = flatWorld();
  advance(world, car, 3);
  assert.equal(car.contactCount, 4);
  assert(Math.abs(car.body.position.y - 0.56) < 0.06);
  assert(Math.abs(car.body.velocity.y) < 0.05);
  car.setTouchControl("accelerate", true);
  advance(world, car, 15);
  assert(car.speedKmh > 125 && car.speedKmh < 160);
  car.setTouchControl("right", true);
  advance(world, car, 1);
  assert(car.body.position.x > 1, "right steering turns +Z toward +X");
  car.setTouchControl("right", false);
  car.setTouchControl("accelerate", false);
  car.setTouchControl("brake", true);
  advance(world, car, 4);
  assert(car.signedSpeed < -3, "holding brake eventually selects reverse");
  assert(car.speedKmh < 43, "reverse has its own lower speed limit");
  car.reset({ position: { x: 4, y: 2, z: 6 }, heading: Math.PI });
  assert.equal(car.body.velocity.length(), 0);
  assert.equal(car.body.angularVelocity.length(), 0);
  assert.equal(car.controls.brake, 0);
  assert.equal(car.body.position.x, 4);
  car.destroy();
  car.destroy();
  assert.equal(world.bodies.includes(car.body), false);
});

test("accelerating and steering in the air cannot create propulsion or yaw torque", () => {
  const { world, car } = flatWorld(30);
  car.setTouchControl("accelerate", true);
  car.setTouchControl("right", true);
  advance(world, car, 0.5);
  assert.equal(car.grounded, false);
  assert(Math.abs(car.body.velocity.x) < 0.001);
  assert(Math.abs(car.body.velocity.z) < 0.001);
  assert(Math.abs(car.body.angularVelocity.y) < 0.001);
  assert(car.body.velocity.y < -4);
  car.destroy();
});

test("the handbrake releases side grip while normal tires catch a slide", () => {
  function lateralSpeed(handbrake) {
    const { world, car } = flatWorld();
    advance(world, car, 2);
    car.body.velocity.set(10, 0, 20);
    car.setTouchControl("handbrake", handbrake);
    advance(world, car, 0.5);
    const result = Math.abs(car.body.velocity.x);
    car.destroy();
    return result;
  }
  assert(lateralSpeed(true) > lateralSpeed(false) + 1);
});

test("the optimized broadphase matches Cannon AABB collision candidates", () => {
  const world = new CANNON.World();
  let seed = 9731;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let i = 0; i < 50; i++) {
    const body = new CANNON.Body({
      mass: i % 4 === 0 ? 1 : 0,
      shape: new CANNON.Box(new CANNON.Vec3(1.5, 0.8, 2)),
      position: new CANNON.Vec3(
        random() * 16 - 8,
        random() * 4,
        random() * 16 - 8,
      ),
    });
    if (i % 11 === 0) body.type = CANNON.Body.KINEMATIC;
    if (i % 9 === 0) body.collisionFilterMask = 0;
    body.quaternion.setFromEuler(0, random() * Math.PI, 0);
    body.aabbNeedsUpdate = true;
    world.addBody(body);
  }
  const optimized = new TrackBroadphase();
  const reference = new CANNON.NaiveBroadphase();
  reference.useBoundingBoxes = true;
  const candidates = (broadphase) => {
    const a = [],
      b = [];
    broadphase.collisionPairs(world, a, b);
    return a
      .map((body, i) => [body.id, b[i].id].sort((x, y) => x - y).join(":"))
      .sort();
  };
  assert.deepEqual(candidates(optimized), candidates(reference));
  const query = new CANNON.AABB({
    lowerBound: new CANNON.Vec3(-2, -1, -2),
    upperBound: new CANNON.Vec3(2, 5, 2),
  });
  const ids = (bodies) => bodies.map((body) => body.id).sort((a, b) => a - b);
  assert.deepEqual(
    ids(optimized.aabbQuery(world, query)),
    ids(reference.aabbQuery(world, query)),
  );
});

let fixturePromise;
async function trackFixture() {
  fixturePromise ||= (async () => {
    const bytes = await readFile(
      new URL("../assets/track/track.glb", import.meta.url),
    );
    const gltf = await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "",
    );
    gltf.scene.updateMatrixWorld(true);
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    world.broadphase = new TrackBroadphase();
    world.solver.iterations = 12;
    let barrier;
    gltf.scene.traverse((mesh) => {
      if (
        !mesh.isMesh ||
        !["Road", "Terrain", "Barrier_Wall"].includes(mesh.name)
      )
        return;
      createMeshColliders(
        mesh,
        world,
        new CANNON.Material("track"),
        mesh.name === "Road",
      );
      if (mesh.name === "Barrier_Wall") barrier = mesh;
    });
    const route = JSON.parse(
      await readFile(
        new URL("../assets/track/route.json", import.meta.url),
        "utf8",
      ),
    );
    return { world, barrier, route };
  })();
  return fixturePromise;
}

test("the actual imported Qatar road supports the car and straight-line driving", async () => {
  const { world, route } = await trackFixture();
  const car = new CarController({
    world,
    scene: new THREE.Scene(),
    spawn: route.spawn,
  });
  car.setEnabled(true);
  advance(world, car, 3);
  assert.equal(car.grounded, true);
  assert(Math.abs(car.body.position.y - route.points[0][1] - 0.56) < 0.1);
  car.setTouchControl("accelerate", true);
  advance(world, car, 3);
  assert(car.speedKmh > 80);
  assert(car.body.position.x > 35);
  assert.equal(car.grounded, true);
  car.destroy();
});

test("sphere chassis supports collide with an actual imported barrier triangle", async () => {
  const { barrier } = await trackFixture();
  const positions = barrier.geometry.getAttribute("position");
  const indices = barrier.geometry.index;
  const corners = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  let selected;
  for (let i = 0; i < (indices ? indices.count : positions.count) / 3; i++) {
    corners.forEach((corner, j) =>
      corner
        .fromBufferAttribute(
          positions,
          indices ? indices.getX(i * 3 + j) : i * 3 + j,
        )
        .applyMatrix4(barrier.matrixWorld),
    );
    const normal = corners[1]
      .clone()
      .sub(corners[0])
      .cross(corners[2].clone().sub(corners[0]));
    const area = normal.length();
    normal.normalize();
    if (Math.abs(normal.y) < 0.05 && (!selected || area > selected.area)) {
      selected = {
        center: corners[0]
          .clone()
          .add(corners[1])
          .add(corners[2])
          .multiplyScalar(1 / 3),
        normal,
        area,
      };
    }
  }
  assert(
    selected,
    "the imported safety barrier has vertical collision triangles",
  );
  const { center, normal } = selected;
  const world = new CANNON.World({ gravity: new CANNON.Vec3() });
  world.broadphase = new TrackBroadphase();
  createMeshColliders(barrier, world, new CANNON.Material("wall"));
  const position = center.clone().addScaledVector(normal, 6);
  const car = new CarController({
    world,
    scene: new THREE.Scene(),
    spawn: { position, heading: Math.atan2(-normal.x, -normal.z) },
  });
  car.body.velocity.set(-normal.x * 14, 0, -normal.z * 14);
  let hadContact = false;
  for (let i = 0; i < 120; i++) {
    car.beforeStep(STEP);
    world.step(STEP);
    hadContact ||= world.contacts.length > 0;
  }
  assert(
    hadContact,
    "Cannon generated a real narrowphase contact against the GLB",
  );
  const separation =
    (car.body.position.x - center.x) * normal.x +
    (car.body.position.z - center.z) * normal.z;
  assert(
    separation > 0,
    "the chassis remains on its original side of the wall",
  );
  car.destroy();
});

test("octree branch pruning preserves Cannon query results on the imported meshes", async () => {
  const { world, route } = await trackFixture();
  const shapes = world.bodies
    .flatMap((body) => body.shapes)
    .filter((shape) => shape.tree);
  let comparisons = 0;
  for (
    let i = 0;
    i < shapes.length;
    i += Math.max(1, Math.floor(shapes.length / 12))
  ) {
    const shape = shapes[i];
    const originalQuery = Object.getPrototypeOf(shape.tree).aabbQuery;
    const bounds = shape.tree.aabb;
    for (let sample = 0; sample < 8; sample++) {
      const mix = sample / 7;
      const x = bounds.lowerBound.x * (1 - mix) + bounds.upperBound.x * mix;
      const z = bounds.lowerBound.z * mix + bounds.upperBound.z * (1 - mix);
      const query = new CANNON.AABB({
        lowerBound: new CANNON.Vec3(x - 3, bounds.lowerBound.y - 1, z - 3),
        upperBound: new CANNON.Vec3(x + 3, bounds.upperBound.y + 1, z + 3),
      });
      const expected = originalQuery
        .call(shape.tree, query, [])
        .sort((a, b) => a - b);
      const actual = shape.tree.aabbQuery(query, []).sort((a, b) => a - b);
      assert.deepEqual(actual, expected);
      comparisons++;
    }
  }
  assert(comparisons >= 80);
  assert(route.points.length > 3);
});
