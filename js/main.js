import * as THREE from "three";
import * as CANNON from "cannon-es";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CarController } from "./car.js?v=1.0.1";
import { WheelRig } from "./wheels.js?v=1.0.1";
import { loadTrack, drawCircuit, TrackBroadphase } from "./track.js";
import { RaceSession, formatTime } from "./race.js";
import { EngineAudio } from "./audio.js";

window.__gameBooted = true;
clearTimeout(window.__bootTimeout);
const $ = (id) => document.getElementById(id);
const canvas = $("viewport");
const FIXED_STEP = 1 / 60;
const BEST_KEY = "apex-arcade:qatar:v1:best";
let renderer, scene, camera, world, car, track, race;
let state = "loading",
  previousTime = 0,
  accumulator = 0,
  countdownTime = 0;
let lastCountdown = "",
  surfaceTime = 0,
  onRoad = true,
  surfaceCheck = 0;
let bestTime = readBest(),
  toastTimeout,
  miniPosition,
  checkpointMarker;
let touchOn = matchMedia("(pointer: coarse)").matches;
let wheelRig;
const engineAudio = new EngineAudio();
const cameraPosition = new THREE.Vector3();
const cameraTarget = new THREE.Vector3();
const cameraDirection = new THREE.Vector3(0, 0, 1);
const desiredCamera = new THREE.Vector3();
const desiredTarget = new THREE.Vector3();
const forward = new THREE.Vector3();
const sunTarget = new THREE.Vector3();
let sun;

function readBest() {
  try {
    const value = Number(localStorage.getItem(BEST_KEY));
    return value > 10 && Number.isFinite(value) ? value : Infinity;
  } catch {
    return Infinity;
  }
}
function showToast(text, duration = 3000) {
  clearTimeout(toastTimeout);
  $("toast").textContent = text;
  $("toast").hidden = false;
  toastTimeout = setTimeout(() => {
    $("toast").hidden = true;
  }, duration);
}
function loadingProgress(value, text) {
  $("loading-progress").style.width = `${Math.round(value * 100)}%`;
  $("loading-message").textContent = text;
}

async function init() {
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    scene = new THREE.Scene();
    scene.background = new THREE.Color("#b4d9db");
    scene.fog = new THREE.Fog("#b4d9db", 500, 1800);
    camera = new THREE.PerspectiveCamera(
      52,
      innerWidth / innerHeight,
      0.1,
      2600,
    );
    scene.add(new THREE.AmbientLight(0xfff2d9, 1.1));
    scene.add(new THREE.HemisphereLight(0xd8f5ff, 0xbfb28d, 1.6));
    sun = new THREE.DirectionalLight(0xfff2cf, 3.0);
    sun.position.set(80, 120, 50);
    sun.castShadow = true;
    sun.shadow.mapSize.set(touchOn ? 1024 : 2048, touchOn ? 1024 : 2048);
    Object.assign(sun.shadow.camera, {
      left: -65,
      right: 65,
      top: 65,
      bottom: -65,
      near: 1,
      far: 340,
    });
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.035;
    scene.add(sun, sun.target);
    world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -9.82, 0),
      allowSleep: true,
    });
    world.broadphase = new TrackBroadphase();
    world.solver.iterations = 12;
    world.defaultContactMaterial.friction = 0.16;
    world.defaultContactMaterial.restitution = 0.02;
    loadingProgress(0.08, "Unpacking the Qatar circuit…");
    const [loadedTrack, carGltf] = await Promise.all([
      loadTrack(scene, world, (progress) =>
        loadingProgress(0.1 + progress * 0.65, "Laying down the tarmac…"),
      ),
      new GLTFLoader().loadAsync(
        new URL("../assets/car/car.glb", import.meta.url).href,
      ),
    ]);
    track = loadedTrack;
    loadingProgress(0.82, "Tuning the suspension…");
    const model = carGltf.scene;
    model.position.y = -0.56;
    const carMaterials = new Set();
    model.traverse((mesh) => {
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (const material of Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]) {
        if (!carMaterials.has(material)) {
          material.color.convertSRGBToLinear();
          carMaterials.add(material);
        }
      }
    });
    wheelRig = new WheelRig(model);
    car = new CarController({ world, scene, model, spawn: track.spawn });
    car.onReset = respawn;
    race = new RaceSession(track.gates, { onLap: completeLap });
    addEnvironment();
    addCheckpointMarker();
    // Settle springs while controls and the lap timer are still disabled.
    for (let i = 0; i < 100; i++) {
      car.beforeStep(FIXED_STEP);
      world.step(FIXED_STEP);
    }
    car.afterStep(1);
    configureUI();
    snapCamera(true);
    resize();
    loadingProgress(1, "The circuit is yours.");
    await renderer.compileAsync(scene, camera);
    $("loading").hidden = true;
    $("welcome").hidden = false;
    $("loading").setAttribute("aria-busy", "false");
    state = "menu";
    requestAnimationFrame(frame);
  } catch (error) {
    console.error("Apex Arcade could not start:", error);
    $("loading-title").textContent = "A LITTLE PIT STOP.";
    $("loading-message").textContent =
      `${error.message} Check your connection and serve this folder over HTTP. All assets must stay beside index.html.`;
    $("retry-button").hidden = false;
    document.querySelector(".spinner").hidden = true;
    $("loading").setAttribute("aria-busy", "false");
  }
}

function configureUI() {
  $("track-name").textContent = `${track.data.name.toUpperCase()} CIRCUIT`;
  $("circuit-label").textContent = track.data.name;
  $("circuit-detail").textContent =
    `${(track.data.length / 1000).toFixed(2)} KM · DRY TARMAC · TIME ATTACK`;
  $("checkpoint-total").textContent =
    `/ ${String(track.gates.length).padStart(2, "0")}`;
  $("best-time").textContent = formatTime(bestTime);
  drawCircuit($("welcome-map"), track.points, { width: 160, height: 110 });
  miniPosition = drawCircuit($("minimap"), track.points, { marker: true });
  $("start-button").addEventListener("click", startRace);
  $("reset-button").addEventListener("click", () => {
    respawn();
    canvas.focus({ preventScroll: true });
  });
  $("pause-button").addEventListener("click", pause);
  $("resume-button").addEventListener("click", resume);
  $("restart-button").addEventListener("click", () => {
    $("pause-dialog").close();
    startRace();
  });
  $("menu-button").addEventListener("click", returnToMenu);
  $("pause-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    resume();
  });
  $("touch-button").addEventListener("click", () => {
    touchOn = !touchOn;
    updateTouch();
  });
  $("sound-button").addEventListener("click", async () => {
    try {
      const enabled = await engineAudio.toggle();
      $("sound-button").setAttribute("aria-pressed", String(enabled));
      $("sound-button").setAttribute(
        "aria-label",
        enabled ? "Mute engine sound" : "Enable engine sound",
      );
    } catch {
      showToast("Audio is unavailable in this browser.");
    }
  });
  document.querySelectorAll("[data-control]").forEach((button) => {
    const activePointers = new Set();
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      activePointers.add(event.pointerId);
      car.setTouchControl(button.dataset.control, true);
      button.classList.add("pressed");
    });
    const release = (event) => {
      activePointers.delete(event.pointerId);
      if (!activePointers.size) {
        car.setTouchControl(button.dataset.control, false);
        button.classList.remove("pressed");
      }
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    button.addEventListener("contextmenu", (event) => event.preventDefault());
  });
  window.addEventListener("keydown", (event) => {
    if (event.code === "Escape" && !event.repeat) {
      if (state === "paused") resume();
      else if (state === "racing" || state === "countdown") pause();
    }
  });
  window.addEventListener("blur", () => {
    if (state === "racing" || state === "countdown") pause();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && (state === "racing" || state === "countdown"))
      pause();
  });
  window.addEventListener("resize", resize);
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    pause();
    showToast("Graphics connection lost. Reload the page to recover.", 30000);
  });
  updateTouch();
}

function updateTouch() {
  $("touch-button").setAttribute("aria-pressed", String(touchOn));
  $("touch-button").setAttribute(
    "aria-label",
    touchOn ? "Hide touch controls" : "Show touch controls",
  );
  $("touch-controls").hidden =
    !touchOn || !["racing", "countdown"].includes(state);
  document.body.classList.toggle(
    "touch-on",
    touchOn && ["racing", "countdown"].includes(state),
  );
  car?.clearInput();
  document
    .querySelectorAll("[data-control]")
    .forEach((b) => b.classList.remove("pressed"));
}

function startRace() {
  car.setEnabled(false);
  car.reset(track.spawn);
  wheelRig.reset();
  for (let i = 0; i < 100; i++) {
    car.beforeStep(FIXED_STEP);
    world.step(FIXED_STEP);
  }
  car.afterStep(1);
  race.restart();
  surfaceTime = 0;
  onRoad = true;
  accumulator = 0;
  countdownTime = 3.2;
  lastCountdown = "";
  state = "countdown";
  $("welcome").hidden = true;
  $("bottom-caption").hidden = true;
  $("race-hud").hidden = false;
  $("countdown").hidden = false;
  $("pause-button").disabled = false;
  document.body.classList.add("racing");
  checkpointMarker.visible = true;
  updateCheckpointMarker();
  updateTouch();
  snapCamera();
  updateHUD();
  canvas.focus({ preventScroll: true });
}
let previousState = "racing";
function pause() {
  if (!["racing", "countdown"].includes(state)) return;
  previousState = state;
  state = "paused";
  accumulator = 0;
  car.setEnabled(false);
  $("countdown").hidden = true;
  updateTouch();
  engineAudio.update(0, false, false);
  $("pause-dialog").showModal();
  $("resume-button").focus();
}
function resume() {
  if (state !== "paused") return;
  $("pause-dialog").close();
  state = previousState;
  car.setEnabled(state === "racing");
  $("countdown").hidden = state !== "countdown";
  accumulator = 0;
  previousTime = performance.now() / 1000;
  updateTouch();
  canvas.focus({ preventScroll: true });
}
function returnToMenu() {
  $("pause-dialog").close();
  state = "menu";
  car.setEnabled(false);
  car.reset(track.spawn);
  wheelRig.reset();
  $("race-hud").hidden = true;
  $("countdown").hidden = true;
  $("welcome").hidden = false;
  $("bottom-caption").hidden = false;
  $("pause-button").disabled = true;
  document.body.classList.remove("racing");
  checkpointMarker.visible = false;
  updateTouch();
  snapCamera(true);
  $("start-button").focus();
}
function respawn() {
  if (state !== "racing") return;
  race.invalidate();
  car.reset(track.respawnAt(race.lastGate));
  wheelRig.reset();
  onRoad = true;
  surfaceTime = 0;
  accumulator = 0;
  snapCamera();
  showToast(
    "BACK ON TRACK · This lap is unranked. Cross the finish to start a fresh one.",
  );
}
function completeLap(result) {
  if (result.valid && result.time > 10) {
    if (result.time < bestTime) {
      bestTime = result.time;
      try {
        localStorage.setItem(BEST_KEY, String(bestTime));
      } catch {
        /* Private browsing can disable storage. */
      }
      $("best-time").textContent = formatTime(bestTime);
      showToast(`PERSONAL BEST · ${formatTime(bestTime)}`, 5000);
    } else showToast(`LAP ${result.lap} · ${formatTime(result.time)}`, 4500);
  } else showToast("FRESH LAP · Stay on the circuit and make this one count.");
}

function frame(milliseconds) {
  const now = milliseconds / 1000;
  const dt = Math.min(Math.max(now - (previousTime || now), 0), 0.05);
  previousTime = now;
  if (state === "countdown") {
    countdownTime -= dt;
    const label =
      countdownTime > 0.2 ? String(Math.ceil(countdownTime - 0.2)) : "GO!";
    if (label !== lastCountdown) {
      $("countdown").textContent = label;
      lastCountdown = label;
    }
    if (countdownTime <= 0) {
      state = "racing";
      car.setEnabled(true);
      setTimeout(() => {
        if (state === "racing") $("countdown").hidden = true;
      }, 650);
    }
  }
  if (state === "racing" || state === "menu" || state === "countdown") {
    accumulator += dt;
    while (accumulator >= FIXED_STEP) {
      car.beforeStep(FIXED_STEP);
      if (state === "racing" && !onRoad && car.grounded) {
        car.body.velocity.x *= 0.994;
        car.body.velocity.z *= 0.994;
      }
      world.step(FIXED_STEP);
      if (state === "racing") {
        surfaceCheck += FIXED_STEP;
        if (surfaceCheck > 0.1) {
          onRoad = track.isOnRoad(car.body.position);
          surfaceCheck = 0;
        }
        race.update(FIXED_STEP, car.body.position, onRoad);
        surfaceTime = onRoad ? 0 : surfaceTime + FIXED_STEP;
      }
      accumulator -= FIXED_STEP;
    }
    car.afterStep(accumulator / FIXED_STEP);
    if (state === "racing") {
      if (
        car.body.position.y < -15 ||
        car.body.position.length() > 5000 ||
        (surfaceTime > 5 && car.speedKmh < 2)
      )
        respawn();
      updateHUD();
      updateCheckpointMarker();
      animateWheels(dt);
    }
    updateCamera(dt);
  }
  engineAudio.update(car.speedKmh, car.controls.accelerate, state === "racing");
  sunTarget.copy(car.visual.position);
  sun.target.position.copy(sunTarget);
  sun.position.copy(sunTarget).add(new THREE.Vector3(-70, 115, 55));
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function updateHUD() {
  const speed = Math.round(car.speedKmh);
  $("speed").textContent = String(speed).padStart(3, "0");
  $("gear").textContent =
    car.signedSpeed < -0.6
      ? "R"
      : speed < 2
        ? "N"
        : Math.min(5, Math.floor(speed / 32) + 1);
  $("lap-time").textContent = formatTime(race.elapsed);
  $("lap-number").textContent = String(race.lap).padStart(2, "0");
  $("lap-valid").textContent = race.valid ? "TIME ATTACK" : "UNRANKED LAP";
  $("lap-valid").classList.toggle("invalid", !race.valid);
  $("checkpoint-label").textContent =
    race.nextGate === 0
      ? "FINISH LINE"
      : `CHECKPOINT ${String(race.nextGate).padStart(2, "0")}`;
  $("lap-progress").style.width = `${race.progress * 100}%`;
  const n = track.gates[race.nextGate].forward;
  const wrongWay = car.body.velocity.x * n.x + car.body.velocity.z * n.z < -3;
  $("surface-label").textContent = wrongWay
    ? "WRONG WAY"
    : !onRoad
      ? "OFF TRACK"
      : car.drifting
        ? "HOLD THAT SLIDE"
        : "ON THE LINE";
  document
    .querySelectorAll(".rev-bars i")
    .forEach((bar, index) =>
      bar.classList.toggle("on", (speed / 155) * 12 > index),
    );
  miniPosition(car.body.position);
}
function animateWheels(dt) {
  wheelRig.update(dt, car.signedSpeed, car.steering);
}

function snapCamera(menu = false) {
  forward
    .set(0, 0, 1)
    .applyQuaternion(car.visual.quaternion)
    .setY(0)
    .normalize();
  cameraDirection.copy(forward);
  const right = new THREE.Vector3().crossVectors(
    new THREE.Vector3(0, 1, 0),
    forward,
  );
  cameraPosition
    .copy(car.visual.position)
    .addScaledVector(forward, menu ? -12 : -9.5)
    .addScaledVector(right, menu ? Math.min(8, camera.aspect * 5) : 0)
    .add(new THREE.Vector3(0, menu ? 6 : 4.8, 0));
  cameraTarget
    .copy(car.visual.position)
    .addScaledVector(forward, menu ? 6 : 4)
    .add(new THREE.Vector3(0, 1.0, 0));
  camera.position.copy(cameraPosition);
  camera.lookAt(cameraTarget);
}
function updateCamera(dt) {
  forward
    .set(0, 0, 1)
    .applyQuaternion(car.visual.quaternion)
    .setY(0)
    .normalize();
  cameraDirection.lerp(forward, 1 - Math.exp(-dt * 5.5)).normalize();
  const menu = state === "menu";
  const speedFactor = Math.min(car.speedKmh / 155, 1);
  desiredCamera
    .copy(car.visual.position)
    .addScaledVector(cameraDirection, menu ? -12 : -9.5 - speedFactor * 2.5);
  if (menu) {
    const right = new THREE.Vector3().crossVectors(
      new THREE.Vector3(0, 1, 0),
      cameraDirection,
    );
    desiredCamera.addScaledVector(right, Math.min(8, camera.aspect * 5));
  }
  desiredCamera.y += menu ? 6 : 4.8;
  desiredCamera.y = Math.max(desiredCamera.y, car.visual.position.y + 2.5);
  desiredTarget
    .copy(car.visual.position)
    .addScaledVector(cameraDirection, menu ? 6 : 4 + speedFactor * 2);
  desiredTarget.y += 1;
  cameraPosition.lerp(desiredCamera, 1 - Math.exp(-dt * 7));
  cameraTarget.lerp(desiredTarget, 1 - Math.exp(-dt * 9));
  camera.position.copy(cameraPosition);
  camera.lookAt(cameraTarget);
  camera.fov = THREE.MathUtils.lerp(
    camera.fov,
    menu ? 47 : 52 + speedFactor * 7,
    1 - Math.exp(-dt * 3),
  );
  camera.updateProjectionMatrix();
}
function resize() {
  const width = canvas.clientWidth,
    height = canvas.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function addCheckpointMarker() {
  checkpointMarker = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xe34b26,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
  });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.25, 4), mat);
    post.position.set(side * 7.5, 0.7, 0);
    checkpointMarker.add(post);
  }
  const shape = new THREE.Shape();
  shape.moveTo(-0.8, -1);
  shape.lineTo(0, 0);
  shape.lineTo(0.8, -1);
  shape.lineTo(0.8, -0.4);
  shape.lineTo(0, 0.6);
  shape.lineTo(-0.8, -0.4);
  shape.closePath();
  const arrow = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
  arrow.rotation.x = Math.PI / 2;
  arrow.position.y = 0.08;
  checkpointMarker.add(arrow);
  checkpointMarker.visible = false;
  scene.add(checkpointMarker);
}
function updateCheckpointMarker() {
  const gate = track.gates[race.nextGate];
  checkpointMarker.position.copy(gate.position);
  checkpointMarker.rotation.y = Math.atan2(gate.forward.x, gate.forward.z);
}
function addEnvironment() {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000),
    new THREE.MeshStandardMaterial({ color: 0xddcaa2, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1;
  floor.receiveShadow = true;
  scene.add(floor);
  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  ground.position.y = -1;
  ground.aabbNeedsUpdate = true;
  world.addBody(ground);
  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: 0x9b7455,
    roughness: 1,
  });
  const leafMaterial = new THREE.MeshStandardMaterial({
    color: 0x6c9569,
    roughness: 1,
    side: THREE.DoubleSide,
  });
  const trees = Math.min(40, Math.floor(track.points.length / 25));
  for (let i = 0; i < trees; i++) {
    const index = Math.floor((i * track.points.length) / trees);
    const p = track.points[index],
      next = track.points[(index + 1) % track.points.length];
    const tangent = next.clone().sub(p).normalize();
    const side = new THREE.Vector3(tangent.z, 0, -tangent.x).multiplyScalar(
      i % 2 ? 25 : -25,
    );
    const palm = new THREE.Group();
    palm.position.copy(p).add(side);
    palm.position.y = p.y - 0.1;
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.25, 6, 5),
      trunkMaterial,
    );
    trunk.position.y = 3;
    trunk.castShadow = true;
    palm.add(trunk);
    for (let frond = 0; frond < 7; frond++) {
      const leaf = new THREE.Mesh(
        new THREE.ConeGeometry(0.7, 4.5, 3),
        leafMaterial,
      );
      leaf.position.set(
        Math.sin((frond * Math.PI * 2) / 7) * 1.8,
        5.8,
        Math.cos((frond * Math.PI * 2) / 7) * 1.8,
      );
      leaf.rotation.set(
        Math.cos((frond * Math.PI * 2) / 7) * 1.25,
        0,
        -Math.sin((frond * Math.PI * 2) / 7) * 1.25,
      );
      leaf.castShadow = true;
      palm.add(leaf);
    }
    scene.add(palm);
  }
  const clouds = new THREE.Group();
  const cloudMaterial = new THREE.MeshBasicMaterial({
    color: 0xe9f3ed,
    transparent: true,
    opacity: 0.7,
    fog: true,
  });
  const cloudGeo = new THREE.IcosahedronGeometry(1, 1);
  for (let i = 0; i < 15; i++) {
    const cloud = new THREE.Mesh(cloudGeo, cloudMaterial);
    cloud.position.set(
      Math.sin(i * 7) * 1000,
      130 + (i % 4) * 25,
      Math.cos(i * 9) * 1100,
    );
    cloud.scale.set(50 + (i % 3) * 20, 8, 18);
    clouds.add(cloud);
  }
  scene.add(clouds);
}

init();
