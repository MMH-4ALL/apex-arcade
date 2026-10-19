import * as THREE from "three";
import * as CANNON from "cannon-es";

// Coordinates: metres, +Y up, +Z forward. Physics always runs at a fixed step.
const MASS = 850;
const MAX_FORWARD_SPEED = 43; // 155 km/h before drag.
const MAX_REVERSE_SPEED = 11;
const KEY_ACTIONS = new Map([
  ["KeyW", "accelerate"],
  ["ArrowUp", "accelerate"],
  ["KeyS", "brake"],
  ["ArrowDown", "brake"],
  ["KeyA", "left"],
  ["ArrowLeft", "left"],
  ["KeyD", "right"],
  ["ArrowRight", "right"],
  ["Space", "handbrake"],
]);
const TOUCH_ALIASES = {
  forward: "accelerate",
  throttle: "accelerate",
  backward: "brake",
  reverse: "brake",
  steerLeft: "left",
  steerRight: "right",
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Dynamic chassis with four spring/damper suspension probes and arcade grip. */
export class CarController {
  constructor({ world, scene, model = null, spawn = null }) {
    this.world = world;
    this.scene = scene;
    this.enabled = false;
    this.onReset = null;
    this.grounded = false;
    this.contactCount = 0;
    this.drifting = false;
    this.slip = 0;
    this.steering = 0;
    this.controls = {
      accelerate: 0,
      brake: 0,
      left: 0,
      right: 0,
      forward: 0,
      backward: 0,
      handbrake: false,
      steering: 0,
      throttle: 0,
    };
    this._keys = new Set();
    this._touch = new Set();
    this._destroyed = false;
    this._spawn = { position: { x: 0, y: 1.5, z: 0 }, heading: 0 };
    this._previousPosition = new CANNON.Vec3();
    this._previousQuaternion = new CANNON.Quaternion();
    this._up = new CANNON.Vec3(0, 1, 0);
    this._forward = new CANNON.Vec3(0, 0, 1);
    this._right = new CANNON.Vec3(1, 0, 0);
    this._normal = new CANNON.Vec3(0, 1, 0);
    this._work = new CANNON.Vec3();
    this._force = new CANNON.Vec3();
    this._pointVelocity = new CANNON.Vec3();
    this._groundVelocity = new CANNON.Vec3();
    this._tilt = new CANNON.Vec3();
    this._tiltVelocity = new CANNON.Vec3();

    this.material = new CANNON.Material("car-chassis");
    this.body = new CANNON.Body({
      mass: MASS,
      material: this.material,
      linearDamping: 0.025,
      angularDamping: 0.38,
      allowSleep: false,
      // Track bodies use Cannon's default group 1; probes cannot hit this car.
      collisionFilterGroup: 2,
      collisionFilterMask: 1,
    });
    this.body.addShape(new CANNON.Box(new CANNON.Vec3(0.86, 0.23, 1.76)));
    // Cannon-es implements sphere↔trimesh contacts, but not box↔trimesh.
    // These supports make imported road edges and barriers physically solid.
    // Their bottoms stay 0.23m above a flat road at normal suspension height.
    for (const z of [-1.35, 0, 1.35]) {
      for (const x of [-0.5, 0.5]) {
        this.body.addShape(
          new CANNON.Sphere(0.36),
          new CANNON.Vec3(x, 0.03, z),
        );
      }
    }
    this.body.userData = { kind: "car" };
    world.addBody(this.body);

    this.visual = new THREE.Group();
    this.visual.name = "player-car";
    this._fallbackWheels = [];
    this._ownsModel = !model;
    this.visual.add(model || this._makeFallbackModel());
    scene.add(this.visual);

    this._wheels = [-1.27, 1.27].flatMap((z) =>
      [-0.76, 0.76].map((x) => ({
        mount: new CANNON.Vec3(x, 0, z),
        from: new CANNON.Vec3(),
        to: new CANNON.Vec3(),
        relative: new CANNON.Vec3(),
        normal: new CANNON.Vec3(),
        result: new CANNON.RaycastResult(),
        compression: 0,
        contact: false,
      })),
    );

    this._onKeyDown = (event) => {
      if (!this.enabled || this._isEditable(event.target)) return;
      if (event.code === "KeyR") {
        event.preventDefault();
        if (!event.repeat) {
          if (typeof this.onReset === "function") this.onReset();
          else this.reset();
        }
        return;
      }
      if (KEY_ACTIONS.has(event.code)) {
        event.preventDefault();
        this._keys.add(event.code);
        this._refreshControls();
      }
    };
    this._onKeyUp = (event) => {
      if (KEY_ACTIONS.has(event.code)) {
        if (this.enabled && !this._isEditable(event.target))
          event.preventDefault();
        this._keys.delete(event.code);
        this._refreshControls();
      }
    };
    this._onBlur = () => this.clearInput();
    this._onVisibility = () => {
      if (document.hidden) this.clearInput();
    };
    window.addEventListener("keydown", this._onKeyDown, { passive: false });
    window.addEventListener("keyup", this._onKeyUp, { passive: false });
    window.addEventListener("blur", this._onBlur);
    document.addEventListener("visibilitychange", this._onVisibility);
    this.reset(spawn || this._spawn);
  }

  get signedSpeed() {
    this.body.quaternion.vmult(CANNON.Vec3.UNIT_Z, this._work);
    return this.body.velocity.dot(this._work);
  }

  get speedKmh() {
    return Math.abs(this.signedSpeed) * 3.6;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.clearInput();
  }

  setTouchControl(action, pressed) {
    action = TOUCH_ALIASES[action] || action;
    if (!["accelerate", "brake", "left", "right", "handbrake"].includes(action))
      return;
    if (pressed && this.enabled) this._touch.add(action);
    else this._touch.delete(action);
    this._refreshControls();
  }

  clearInput() {
    this._keys.clear();
    this._touch.clear();
    this._refreshControls();
  }

  setSpawn(spawn) {
    this._spawn = {
      position: {
        x: Number(spawn.position.x) || 0,
        y: Number.isFinite(spawn.position.y) ? spawn.position.y : 1.5,
        z: Number(spawn.position.z) || 0,
      },
      heading: Number(spawn.heading) || 0,
    };
  }

  reset(spawn = null) {
    if (spawn) this.setSpawn(spawn);
    const { position, heading } = this._spawn;
    this.body.position.set(position.x, position.y, position.z);
    this.body.quaternion.setFromAxisAngle(CANNON.Vec3.UNIT_Y, heading);
    this.body.previousPosition.copy(this.body.position);
    this.body.interpolatedPosition.copy(this.body.position);
    this.body.previousQuaternion.copy(this.body.quaternion);
    this.body.interpolatedQuaternion.copy(this.body.quaternion);
    this._previousPosition.copy(this.body.position);
    this._previousQuaternion.copy(this.body.quaternion);
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
    this.body.force.setZero();
    this.body.torque.setZero();
    this.body.aabbNeedsUpdate = true;
    this.body.wakeUp();
    this.grounded = false;
    this.contactCount = 0;
    this.steering = 0;
    this.slip = 0;
    this.drifting = false;
    this.clearInput();
    this.afterStep(1);
  }

  /** Call immediately before EACH world.step(fixedDt), including catch-up steps. */
  beforeStep(dt) {
    if (this._destroyed) return;
    const body = this.body;
    this._previousPosition.copy(body.position);
    this._previousQuaternion.copy(body.quaternion);
    body.quaternion.vmult(CANNON.Vec3.UNIT_Y, this._up);
    body.quaternion.vmult(CANNON.Vec3.UNIT_Z, this._forward);
    this._normal.setZero();
    this.contactCount = 0;

    for (const wheel of this._wheels) {
      body.pointToWorldFrame(wheel.mount, wheel.from);
      this._up.scale(-0.77, this._work);
      wheel.from.vadd(this._work, wheel.to);
      wheel.result.reset();
      wheel.contact = false;
      wheel.compression = 0;
      this.world.raycastClosest(
        wheel.from,
        wheel.to,
        {
          collisionFilterMask: 1,
          skipBackfaces: false,
        },
        wheel.result,
      );
      if (!wheel.result.hasHit || !wheel.result.body) continue;
      wheel.normal.copy(wheel.result.hitNormalWorld);
      // Imported triangle winding does not affect the suspension direction.
      if (wheel.normal.dot(this._up) < 0) wheel.normal.negate(wheel.normal);
      if (wheel.normal.dot(this._up) < 0.25) continue;
      const springLength = Math.max(0.06, wheel.result.distance - 0.28);
      wheel.compression = 0.39 - springLength;
      if (wheel.compression < -0.035) continue;
      wheel.contact = true;
      this.contactCount++;
      this._normal.vadd(wheel.normal, this._normal);
      body.getVelocityAtWorldPoint(wheel.from, this._pointVelocity);
      wheel.result.body.getVelocityAtWorldPoint(
        wheel.result.hitPointWorld,
        this._groundVelocity,
      );
      this._pointVelocity.vsub(this._groundVelocity, this._pointVelocity);
      const normalVelocity = this._pointVelocity.dot(wheel.normal);
      const damping = normalVelocity < 0 ? 1700 : 1900;
      const springForce = clamp(
        wheel.compression * 19000 - normalVelocity * damping,
        0,
        11000,
      );
      wheel.normal.scale(springForce, this._force);
      wheel.from.vsub(body.position, wheel.relative);
      body.applyForce(this._force, wheel.relative);
    }

    this.grounded = this.contactCount > 0;
    const targetSteer = this.enabled ? this.controls.steering : 0;
    this.steering += (targetSteer - this.steering) * (1 - Math.exp(-dt * 10));
    this.drifting = false;
    if (!this.grounded) {
      this.slip = 0;
      return; // Gravity and collisions govern the car while airborne.
    }
    this._normal.normalize();
    // Project the driving basis onto the road, so banks and slopes remain physical.
    this._normal.scale(this._forward.dot(this._normal), this._work);
    this._forward.vsub(this._work, this._forward);
    if (this._forward.lengthSquared() < 0.01) return;
    this._forward.normalize();
    this._normal.cross(this._forward, this._right);
    this._right.normalize();
    const longitudinalSpeed = body.velocity.dot(this._forward);
    const lateralSpeed = body.velocity.dot(this._right);
    const absoluteSpeed = Math.abs(longitudinalSpeed);
    const handbrake = this.enabled && this.controls.handbrake;
    const accelerate = this.enabled && this.controls.accelerate > 0;
    const reverse = this.enabled && this.controls.brake > 0;
    const traction = Math.min(1, this.contactCount / 2);
    let acceleration = 0;

    if (accelerate && reverse) {
      acceleration =
        -Math.sign(longitudinalSpeed) * Math.min(25, absoluteSpeed / dt);
    } else if (accelerate) {
      acceleration =
        longitudinalSpeed < -1.2
          ? 24
          : 12 *
            (1 -
              clamp(
                (longitudinalSpeed - MAX_FORWARD_SPEED * 0.72) /
                  (MAX_FORWARD_SPEED * 0.28),
                0,
                1,
              ));
    } else if (reverse) {
      acceleration =
        longitudinalSpeed > 1.2
          ? -25
          : -7 *
            (1 -
              clamp(
                (-longitudinalSpeed - MAX_REVERSE_SPEED * 0.65) /
                  (MAX_REVERSE_SPEED * 0.35),
                0,
                1,
              ));
    }
    if (handbrake) {
      acceleration *= 0.3;
      acceleration -=
        Math.sign(longitudinalSpeed) * Math.min(5.5, absoluteSpeed / dt);
    }
    const coast = !accelerate && !reverse ? 1.05 : 0;
    const resistance = Math.min(
      absoluteSpeed / dt,
      0.38 + coast + 0.001 * longitudinalSpeed * longitudinalSpeed,
    );
    acceleration -= Math.sign(longitudinalSpeed) * resistance;
    this._forward.scale(MASS * acceleration * traction, this._force);
    body.applyForce(this._force);

    // Space reduces side grip: the chassis can rotate into a controlled slide.
    const grip = handbrake ? 2.4 : 10;
    const sideAcceleration = clamp(
      -lateralSpeed * grip,
      handbrake ? -6 : -17,
      handbrake ? 6 : 17,
    );
    this._right.scale(MASS * sideAcceleration * traction, this._force);
    body.applyForce(this._force);
    this.slip = Math.abs(lateralSpeed);
    this.drifting = this.slip > 2.1 && absoluteSpeed > 5;

    const maxYawRate = Math.min(1.55, 18 / (absoluteSpeed + 4));
    const targetYawRate =
      this.steering *
      maxYawRate *
      clamp(absoluteSpeed / 3, 0, 1) *
      Math.sign(longitudinalSpeed) *
      (handbrake ? 1.28 : 1);
    const currentYawRate = body.angularVelocity.dot(this._normal);
    const yawTorque =
      clamp(
        (targetYawRate - currentYawRate) * body.inertia.y * 8.5,
        -10500,
        10500,
      ) * traction;
    this._normal.scale(yawTorque, this._force);
    body.torque.vadd(this._force, body.torque);

    // Limited grounded stabilization keeps an arcade chassis settled on banks.
    // It never rights an overturned vehicle or introduces air steering.
    if (this.contactCount >= 2 && this._up.dot(this._normal) > 0.3) {
      this._up.cross(this._normal, this._tilt);
      this._normal.scale(currentYawRate, this._work);
      body.angularVelocity.vsub(this._work, this._tiltVelocity);
      this._tilt.scale(5800, this._tilt);
      this._tiltVelocity.scale(1450, this._tiltVelocity);
      this._tilt.vsub(this._tiltVelocity, this._tilt);
      body.torque.vadd(this._tilt, body.torque);
    }
  }

  /** Interpolate the physics pose for rendering; alpha is accumulator/fixedDt. */
  afterStep(alpha = 1) {
    alpha = clamp(alpha, 0, 1);
    const a = this._previousPosition;
    const b = this.body.position;
    this.visual.position.set(
      a.x + (b.x - a.x) * alpha,
      a.y + (b.y - a.y) * alpha,
      a.z + (b.z - a.z) * alpha,
    );
    const previous = this._previousQuaternion;
    this.visual.quaternion.set(previous.x, previous.y, previous.z, previous.w);
    this.visual.quaternion.slerp(
      new THREE.Quaternion(
        this.body.quaternion.x,
        this.body.quaternion.y,
        this.body.quaternion.z,
        this.body.quaternion.w,
      ),
      alpha,
    );
    for (const wheel of this._fallbackWheels) {
      wheel.rotation.x = -this.body.position.z / 0.28;
      if (wheel.userData.front) wheel.rotation.y = this.steering * 0.36;
    }
  }

  getForwardVector(target = new THREE.Vector3()) {
    return target.set(0, 0, 1).applyQuaternion(this.visual.quaternion);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.clearInput();
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._onBlur);
    document.removeEventListener("visibilitychange", this._onVisibility);
    this.world.removeBody(this.body);
    this.scene.remove(this.visual);
    if (this._ownsModel) {
      const materials = new Set();
      this.visual.traverse((object) => {
        object.geometry?.dispose();
        if (object.material) materials.add(object.material);
      });
      for (const material of materials) material.dispose();
    }
  }

  _isEditable(target) {
    return (
      target instanceof Element &&
      Boolean(
        target.closest('input, textarea, select, [contenteditable="true"]'),
      )
    );
  }

  _refreshControls() {
    const held = new Set(this._touch);
    for (const code of this._keys) held.add(KEY_ACTIONS.get(code));
    for (const action of ["accelerate", "brake", "left", "right"]) {
      this.controls[action] = this.enabled && held.has(action) ? 1 : 0;
    }
    this.controls.handbrake = this.enabled && held.has("handbrake");
    // A positive Y rotation turns +Z toward +X: positive steering is right.
    this.controls.steering = this.controls.right - this.controls.left;
    this.controls.throttle = this.controls.accelerate - this.controls.brake;
    this.controls.forward = this.controls.accelerate;
    this.controls.backward = this.controls.brake;
  }

  _makeFallbackModel() {
    const group = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({
      color: 0xff553a,
      roughness: 0.36,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x132b38,
      roughness: 0.75,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x89d9e7,
      roughness: 0.16,
    });
    const cream = new THREE.MeshStandardMaterial({
      color: 0xfff2d4,
      roughness: 0.5,
    });
    const box = (width, height, depth, material, x, y, z) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(width, height, depth),
        material,
      );
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    box(1.72, 0.4, 3.8, paint, 0, -0.02, 0);
    box(1.4, 0.47, 1.7, glass, 0, 0.4, -0.22);
    box(1.44, 0.08, 1.35, paint, 0, 0.66, -0.3);
    box(0.2, 0.01, 1.1, cream, -0.27, 0.19, 1.2);
    box(0.2, 0.01, 1.1, cream, 0.27, 0.19, 1.2);
    box(1.48, 0.12, 0.22, dark, 0, 0.2, -1.8);
    for (const x of [-0.6, 0.6]) {
      box(0.35, 0.12, 0.035, cream, x, 0.04, 1.92);
      box(0.32, 0.1, 0.035, paint, x, 0.04, -1.92);
    }
    for (const z of [-1.27, 1.27]) {
      for (const x of [-0.88, 0.88]) {
        const pivot = new THREE.Group();
        pivot.position.set(x, -0.28, z);
        pivot.userData.front = z > 0;
        const tire = new THREE.Mesh(
          new THREE.CylinderGeometry(0.28, 0.28, 0.22, 12),
          dark,
        );
        tire.rotation.z = Math.PI / 2;
        tire.castShadow = true;
        pivot.add(tire);
        group.add(pivot);
        this._fallbackWheels.push(pivot);
      }
    }
    return group;
  }
}
