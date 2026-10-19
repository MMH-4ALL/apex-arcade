import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/** Loader and collision extraction share the same baked world coordinates. */
export async function loadTrack(scene, world, onProgress = () => {}) {
  const response = await fetch(
    new URL("../assets/track/route.json", import.meta.url),
  );
  if (!response.ok)
    throw new Error(`Circuit data could not be loaded (${response.status}).`);
  const data = await response.json();
  if (!Array.isArray(data.points) || data.points.length < 3)
    throw new Error("The circuit route is invalid.");
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(
    new URL("../assets/track/track.glb", import.meta.url).href,
    (event) => onProgress(event.total ? event.loaded / event.total : 0.25),
  );
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const roadMeshes = [],
    bodies = [],
    allMeshes = [];
  const material = new CANNON.Material("track");
  const renderedMaterials = new Set();
  root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.receiveShadow = true;
    mesh.castShadow = /barrier|stand|building|tree|tower/i.test(mesh.name);
    mesh.frustumCulled = true;
    for (const m of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material]) {
      if (!renderedMaterials.has(m)) {
        m.color.convertSRGBToLinear();
        renderedMaterials.add(m);
      }
    }
    // The archive omitted its fence alpha material. Reconstruct a visible open
    // safety mesh so the barrier remains readable without an opaque 25m wall.
    if (mesh.name === "Barrier_Wall") {
      mesh.material = new THREE.MeshBasicMaterial({
        color: 0x647d74,
        wireframe: true,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
      });
      mesh.castShadow = false;
    }
    allMeshes.push(mesh);
    const isRoad =
      (data.roadMeshNames || ["Road"]).includes(mesh.name) ||
      /asphalt/i.test(mesh.name);
    if (isRoad) roadMeshes.push(mesh);
    if (
      isRoad ||
      /terrain|barrier|collision/i.test(mesh.name) ||
      mesh.userData.collidable
    ) {
      bodies.push(...createMeshColliders(mesh, world, material, isRoad));
    }
  });
  if (!roadMeshes.length) throw new Error("The circuit has no road mesh.");
  scene.add(root);
  const points = data.points.map((p) => new THREE.Vector3(...p));
  const gates = createGates(points, data.roadWidth || 16);
  const first = gates[0];
  const spawn = data.spawn || {
    position: {
      x: first.position.x - first.forward.x * 6,
      y: first.position.y + 0.72,
      z: first.position.z - first.forward.z * 6,
    },
    heading: Math.atan2(first.forward.x, first.forward.z),
  };
  addStartLine(scene, first, data.roadWidth || 16);
  const raycaster = new THREE.Raycaster();
  raycaster.ray.direction.set(0, -1, 0);
  const rayOrigin = new THREE.Vector3();
  return {
    root,
    data,
    points,
    gates,
    spawn,
    roadMeshes,
    bodies,
    bounds: new THREE.Box3().setFromObject(root),
    isOnRoad(position) {
      rayOrigin.set(position.x, position.y + 3, position.z);
      raycaster.ray.origin.copy(rayOrigin);
      raycaster.far = 8;
      return raycaster.intersectObjects(roadMeshes, false).length > 0;
    },
    respawnAt(index) {
      const gate = gates[index];
      return {
        position: {
          x: gate.position.x + gate.forward.x * 3,
          y: gate.position.y + 0.8,
          z: gate.position.z + gate.forward.z * 3,
        },
        heading: Math.atan2(gate.forward.x, gate.forward.z),
      };
    },
    dispose() {
      bodies.forEach((body) => world.removeBody(body));
      root.removeFromParent();
      allMeshes.forEach((mesh) => {
        mesh.geometry.dispose();
        (Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material]
        ).forEach((m) => m.dispose());
      });
    },
  };
}

/** A racing world has hundreds of static chunks and very few moving bodies.
 * Avoid SAP's quadratic static/static scan; never emit a static/static pair. */
export class TrackBroadphase extends CANNON.Broadphase {
  constructor() {
    super();
    this.useBoundingBoxes = true;
  }
  collisionPairs(world, pairs1, pairs2) {
    const moving = world.bodies.filter(
      (body) => body.type !== CANNON.Body.STATIC,
    );
    for (let i = 0; i < moving.length; i++) {
      const body = moving[i];
      for (const other of world.bodies) {
        if (other.type !== CANNON.Body.STATIC) continue;
        if (this.needBroadphaseCollision(body, other))
          this.intersectionTest(body, other, pairs1, pairs2);
      }
      for (let j = i + 1; j < moving.length; j++) {
        if (this.needBroadphaseCollision(body, moving[j]))
          this.intersectionTest(body, moving[j], pairs1, pairs2);
      }
    }
  }
  aabbQuery(world, aabb, result = []) {
    for (const body of world.bodies) {
      if (body.aabbNeedsUpdate) body.updateAABB();
      if (body.aabb.overlaps(aabb)) result.push(body);
    }
    return result;
  }
}

/** Cannon trimesh indices are signed 16-bit internally: keep each chunk below 32768 vertices.
 * Applying matrixWorld here avoids render/collision transform mismatch. */
export function createMeshColliders(mesh, world, material, isRoad = false) {
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute("position");
  const indices = geometry.index;
  const triangleCount = Math.floor(
    (indices ? indices.count : positions.count) / 3,
  );
  const buckets = new Map();
  const corners = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  const cellSize = 192;
  // Spatial chunks keep Cannon broadphase bounds tight. Sequential OBJ triangle
  // chunks can span the whole circuit and force expensive irrelevant contacts.
  for (let t = 0; t < triangleCount; t++) {
    for (let c = 0; c < 3; c++) {
      const index = indices ? indices.getX(t * 3 + c) : t * 3 + c;
      corners[c]
        .fromBufferAttribute(positions, index)
        .applyMatrix4(mesh.matrixWorld);
    }
    const x = Math.floor(
      (corners[0].x + corners[1].x + corners[2].x) / (3 * cellSize),
    );
    const z = Math.floor(
      (corners[0].z + corners[1].z + corners[2].z) / (3 * cellSize),
    );
    const key = `${x},${z}`;
    if (!buckets.has(key))
      buckets.set(key, {
        x: (x + 0.5) * cellSize,
        z: (z + 0.5) * cellSize,
        triangles: [],
      });
    const bucket = buckets.get(key);
    for (const p of corners)
      bucket.triangles.push(p.x - bucket.x, p.y, p.z - bucket.z);
  }
  const bodies = [];
  for (const bucket of buckets.values()) {
    for (let offset = 0; offset < bucket.triangles.length; offset += 54000) {
      const vertices = bucket.triangles.slice(offset, offset + 54000);
      const faces = Array.from({ length: vertices.length / 3 }, (_, i) => i);
      const shape = new CANNON.Trimesh(vertices, faces);
      // Cannon-es 0.20's octree visits descendants even after the parent misses.
      // Pruning those branches preserves query results and makes large tracks viable.
      shape.tree.aabbQuery = function (aabb, result = []) {
        const queue = [this];
        while (queue.length) {
          const node = queue.pop();
          if (!node.aabb.overlaps(aabb)) continue;
          for (const id of node.data) result.push(id);
          for (const child of node.children) queue.push(child);
        }
        return result;
      };
      const body = new CANNON.Body({
        mass: 0,
        material,
        shape,
        position: new CANNON.Vec3(bucket.x, 0, bucket.z),
        collisionFilterGroup: 1,
      });
      body.isRoad = isRoad;
      world.addBody(body);
      bodies.push(body);
    }
  }
  return bodies;
}

function createGates(points, width) {
  // Gates every ~55m prevent lap credit from start-line oscillation and shortcuts.
  const gates = [];
  let distance = Infinity;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) distance += points[i].distanceTo(points[i - 1]);
    if (distance < 55) continue;
    const before = points[(i - 1 + points.length) % points.length];
    const after = points[(i + 1) % points.length];
    const forward = after.clone().sub(before).setY(0).normalize();
    gates.push({
      position: points[i].clone(),
      forward,
      halfWidth: width * 0.62,
    });
    distance = 0;
  }
  return gates;
}

function addStartLine(scene, gate, width) {
  const group = new THREE.Group();
  group.position.copy(gate.position);
  group.position.y += 0.045;
  group.rotation.y = Math.atan2(gate.forward.x, gate.forward.z);
  const white = new THREE.MeshBasicMaterial({
    color: 0xf8f4e9,
    side: THREE.DoubleSide,
  });
  const dark = new THREE.MeshBasicMaterial({
    color: 0x252e30,
    side: THREE.DoubleSide,
  });
  const cell = width / 16;
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 16; col++) {
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(cell, cell),
        (col + row) % 2 ? white : dark,
      );
      tile.rotation.x = -Math.PI / 2;
      tile.position.set((col - 7.5) * cell, 0, (row - 0.5) * cell);
      group.add(tile);
    }
  const banner = createBanner("APEX  /  TIME ATTACK");
  const archHeight = 7;
  banner.position.set(0, archHeight, 0);
  group.add(banner);
  const poleMaterial = new THREE.MeshStandardMaterial({
    color: 0xe34b26,
    roughness: 0.8,
  });
  for (const side of [-1, 1]) {
    const pole = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, archHeight, 0.35),
      poleMaterial,
    );
    pole.position.set(side * (width / 2 + 1), archHeight / 2, 0);
    pole.castShadow = true;
    group.add(pole);
  }
  scene.add(group);
}

function createBanner(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#202c2c";
  ctx.fillRect(0, 0, 1024, 96);
  ctx.fillStyle = "#f5f1e8";
  ctx.font = "bold 42px Arial";
  ctx.textAlign = "center";
  ctx.fillText(text, 512, 63);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.BoxGeometry(18, 1.6, 0.3),
    new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }),
  );
}

export function drawCircuit(
  svg,
  points,
  { width = 180, height = 150, marker = false } = {},
) {
  const xs = points.map((p) => p.x),
    zs = points.map((p) => p.z);
  const minX = Math.min(...xs),
    minZ = Math.min(...zs);
  const rangeX = Math.max(...xs) - minX,
    rangeZ = Math.max(...zs) - minZ;
  const scale = Math.min((width - 26) / rangeX, (height - 26) / rangeZ);
  const offsetX = (width - rangeX * scale) / 2,
    offsetZ = (height - rangeZ * scale) / 2;
  const project = (p) => ({
    x: offsetX + (p.x - minX) * scale,
    y: offsetZ + (p.z - minZ) * scale,
  });
  const path =
    points
      .map((p, i) => {
        const v = project(p);
        return `${i ? "L" : "M"}${v.x.toFixed(2)},${v.y.toFixed(2)}`;
      })
      .join(" ") + " Z";
  svg.innerHTML = `<path d="${path}" fill="none" stroke="#f5f1e8" stroke-width="8" stroke-linejoin="round"/><path d="${path}" fill="none" stroke="#65756a" stroke-width="3" stroke-linejoin="round"/>`;
  const first = project(points[0]);
  svg.innerHTML += `<circle cx="${first.x}" cy="${first.y}" r="3" fill="#e34b26"/>`;
  let dot;
  if (marker) {
    dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", "#e34b26");
    dot.setAttribute("stroke", "#fff");
    dot.setAttribute("stroke-width", "1.5");
    svg.append(dot);
  }
  return (position) => {
    if (!dot) return;
    const p = project(position);
    dot.setAttribute("cx", p.x);
    dot.setAttribute("cy", p.y);
  };
}
