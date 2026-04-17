// @ts-check
import * as THREE from 'three';

/** @typedef {import('./player.js').Player} Player */
/** @typedef {import('./input.js').InputState} InputState */

const DIST        = 7;      // distance behind player
const HEIGHT      = 3.5;    // height above player centre
const LERP_SPEED  = 8;      // position lerp factor (units/s feel)
const YAW_SENS    = 0.003;  // radians per pixel of pointer delta
const PITCH_MIN   = -0.1;   // radians (look slightly up at most)
const PITCH_MAX   = 0.6;    // radians (look down limit)

export class GameCamera {
  constructor() {
    /** The Three.js camera passed to renderer.render(). @type {THREE.PerspectiveCamera} */
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      300,
    );

    /** Current camera yaw (horizontal angle). Exported so player can read it. @type {number} */
    this.yaw = Math.PI; // start behind the player

    /** @type {number} */
    this._pitch = 0.3;

    /** Smooth look-at target. @type {THREE.Vector3} */
    this._lookTarget = new THREE.Vector3();
  }

  /**
   * @param {number}      dt
   * @param {Player}      player
   * @param {InputState}  inp
   */
  update(dt, player, inp) {
    // Update yaw / pitch from pointer delta
    this.yaw   -= inp.cameraDelta.x * YAW_SENS;
    this._pitch += inp.cameraDelta.y * YAW_SENS;
    this._pitch  = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this._pitch));

    // Desired camera position in a sphere around the player
    const sinYaw   = Math.sin(this.yaw);
    const cosYaw   = Math.cos(this.yaw);
    const cosPitch = Math.cos(this._pitch);
    const sinPitch = Math.sin(this._pitch);

    const idealPos = new THREE.Vector3(
      player.position.x + sinYaw * DIST * cosPitch,
      player.position.y + HEIGHT + sinPitch * DIST,
      player.position.z + cosYaw * DIST * cosPitch,
    );

    // Smoothly move camera toward ideal position
    const alpha = Math.min(LERP_SPEED * dt, 1);
    this.camera.position.lerp(idealPos, alpha);

    // Look at a point slightly above the player's feet
    this._lookTarget.copy(player.position);
    this._lookTarget.y += 0.4;
    this.camera.lookAt(this._lookTarget);
  }

  /** Call on window resize. */
  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
