// @ts-check
import * as THREE from 'three';

const SHEET_COLS    = 16;
const SPRITE_INDEX  = 4;
const TRIGGER_DIST  = 1.2; // horizontal distance to trigger level transition

export class Chest {
  /** @param {THREE.Texture} spritesheet */
  constructor(spritesheet) {
    const tex = spritesheet.clone();
    tex.needsUpdate = true;

    const col = SPRITE_INDEX % SHEET_COLS;
    const row = Math.floor(SPRITE_INDEX / SHEET_COLS);
    tex.offset.set(col / SHEET_COLS, 1 - (row + 1) / SHEET_COLS);
    tex.repeat.set(1 / SHEET_COLS, 1 / SHEET_COLS);

    const mat = new THREE.SpriteMaterial({
      map:         tex,
      transparent: true,
      alphaTest:   0.1,
    });

    /** @type {THREE.Sprite} */
    this.mesh = new THREE.Sprite(mat);
    this.mesh.center.set(0.5, 0); // anchor at bottom
    this.mesh.scale.set(1, 1, 1);

    /** World position of the chest's base. @type {THREE.Vector3} */
    this.position = new THREE.Vector3(0, -100, 0); // off-screen until placed
    this.mesh.position.copy(this.position);
  }

  /**
   * Move the chest to world position (x, y, z) where y is the floor level.
   * @param {number} x @param {number} y @param {number} z
   */
  place(x, y, z) {
    this.position.set(x, y, z);
    this.mesh.position.set(x, y, z);
  }

  /**
   * Returns true when the player centre is within trigger distance (XZ plane).
   * @param {THREE.Vector3} playerPos
   */
  isTriggered(playerPos) {
    const dx = playerPos.x - this.position.x;
    const dz = playerPos.z - this.position.z;
    return Math.sqrt(dx * dx + dz * dz) < TRIGGER_DIST;
  }
}
