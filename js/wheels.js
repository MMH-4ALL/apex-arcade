import * as THREE from "three";

const AXLE = new THREE.Vector3(1, 0, 0);
const FULL_TURN = Math.PI * 2;
const WHEEL_NAME = /^wheel_(front|rear)_(left|right)$/;

/** Steering rotates around chassis Y; rolling rotates around the tire's own X.
 * Separate pivots keep the axle level at every rolling angle (Ry * Rx).
 */
export class WheelRig {
  constructor(model, { radius = 0.468, maxSteeringAngle = 0.4 } = {}) {
    this.maxSteeringAngle = maxSteeringAngle;
    this.wheels = [];
    this.distance = 0;
    this._spin = new THREE.Quaternion();
    const assemblies = [];
    model.traverse((object) => {
      if (!WHEEL_NAME.test(object.name)) return;
      // A multi-primitive glTF wheel may be a group with similarly named meshes.
      for (let ancestor = object.parent; ancestor && ancestor !== model; ancestor = ancestor.parent) {
        if (WHEEL_NAME.test(ancestor.name)) return;
      }
      assemblies.push(object);
    });
    for (const wheel of assemblies) {
      const parent = wheel.parent;
      const pivot = new THREE.Group();
      pivot.name = `${wheel.name}_steering_pivot`;
      pivot.position.copy(wheel.position);
      parent.add(pivot);
      pivot.add(wheel);
      wheel.position.set(0, 0, 0);
      this.wheels.push({
        wheel,
        pivot,
        front: wheel.name.startsWith("wheel_front_"),
        bindQuaternion: wheel.quaternion.clone(),
        radius,
      });
    }
    this.reset();
  }

  update(dt, signedSpeed, steering) {
    if (!Number.isFinite(dt) || !Number.isFinite(signedSpeed)) return;
    this.distance += signedSpeed * Math.max(0, dt);
    this._setPose(Number.isFinite(steering) ? steering : 0);
  }

  reset() {
    this.distance = 0;
    this._setPose(0);
  }

  _setPose(steering) {
    const angle = THREE.MathUtils.clamp(steering, -1, 1) * this.maxSteeringAngle;
    for (const { wheel, pivot, front, bindQuaternion, radius } of this.wheels) {
      pivot.rotation.y = front ? angle : 0;
      this._spin.setFromAxisAngle(AXLE, (this.distance / radius) % FULL_TURN);
      wheel.quaternion.copy(bindQuaternion).multiply(this._spin);
    }
  }
}
