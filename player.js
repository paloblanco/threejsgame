// @ts-check
import * as THREE from 'three';
import { TILE_TYPES } from './level.js';

/** @typedef {import('./input.js').InputState} InputState */

// ── Physics constants ──────────────────────────────────────────────────────────
const GRAVITY      = -22;
const JUMP_SPEED   =  9;
const WALK_SPEED   =  5;
const ACCEL_GROUND = 22;
const ACCEL_AIR    =  6;

// ── Bounding volume (half-extents, centre = this.position) ────────────────────
const PH = 0.50; // half-height  →  total 1.0 unit = one block tall
const PW = 0.22; // half-width/depth

const GROUND_REACH  = 0.28; // extra downward reach for ground snap
const WALK_FRAME_SECS = 0.10; // seconds per walk animation frame

// ── Sprite atlas ───────────────────────────────────────────────────────────────
const SHEET_COLS = 16;

// ── Reusable raycasting objects ────────────────────────────────────────────────
const _rc     = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _DOWN   = Object.freeze(new THREE.Vector3(0, -1, 0));
const _UP     = Object.freeze(new THREE.Vector3(0,  1, 0));
const _WALL_DIRS = [
  new THREE.Vector3( 1, 0,  0),
  new THREE.Vector3(-1, 0,  0),
  new THREE.Vector3( 0, 0,  1),
  new THREE.Vector3( 0, 0, -1),
];
const _GND_OFF = /** @type {[number,number][]} */ ([
  [ 0,      0     ],
  [ PW*0.8, PW*0.8],
  [-PW*0.8, PW*0.8],
  [ PW*0.8,-PW*0.8],
  [-PW*0.8,-PW*0.8],
]);
/** @type {THREE.Intersection[]} */
const _hits = [];

// ── Player ─────────────────────────────────────────────────────────────────────

export class Player {
  /**
   * @param {THREE.Texture} spritesheetTexture
   *   The shared spritesheet. A clone is made for the player so its per-frame
   *   offset/repeat changes don't affect tile materials.
   */
  constructor(spritesheetTexture) {
    // ── Physics state ──────────────────────────────────────────────────────
    this.position    = new THREE.Vector3(2, 5, 2);
    this.velocity    = new THREE.Vector3();
    this.onGround    = false;
    this.facingAngle = 0;   // yaw the character is moving toward (radians)
    this.groundType  = 's';
    this._speed      = 0;
    this._squashTimer = 0;

    // ── Sprite animation state ─────────────────────────────────────────────
    /**
     * Map of direction name → [idleFrame, walkFrame1, walkFrame2?, ...].
     * Assigned here so they're easy to change without digging into methods.
     *
     * Directions are camera-relative:
     *   'front' — player faces toward the camera
     *   'back'  — player faces away from the camera
     *   'right' — player faces the camera's right
     *   'left'  — reuses 'right' frames but mirrored horizontally
     *
     * @type {Record<string, number[]>}
     */
    this.sprites = {
      front: [238, 240, 239, 240, 239],
      back:  [253, 255, 254, 255, 254],
      right: [246, 248, 247,249,247],
    };

    /** Current camera-relative direction. @type {'front'|'back'|'right'} */
    this._spriteDir    = 'front';
    /** True when showing a horizontally-mirrored 'right' sprite (left-facing). */
    this._spriteMirror = false;
    /** Index into the current direction's frame array (0 = idle/first frame). */
    this._walkFrame    = 0;
    /** Seconds since the last walk-frame advance. */
    this._walkTimer    = 0;

    // ── Three.js billboard sprite ──────────────────────────────────────────
    // Clone the texture so per-frame offset/repeat don't affect tile materials.
    const tex = spritesheetTexture.clone();
    tex.needsUpdate = true;
    tex.wrapS = THREE.RepeatWrapping; // required for negative repeat (mirror)
    tex.wrapT = THREE.ClampToEdgeWrapping;

    const mat = new THREE.SpriteMaterial({
      map:         tex,
      transparent: true,
      alphaTest:   0.1,
    });

    /** The Three.js object added to the scene. @type {THREE.Sprite} */
    this.mesh = new THREE.Sprite(mat);
    // Anchor at the bottom so position = feet; scale matches 1-unit tile height.
    this.mesh.center.set(0.5, 0);
    this.mesh.scale.set(1, 1, 1);

    // Show the idle-front sprite immediately
    this._applySpriteIndex(this.sprites.front[0], false);
  }

  // ── Per-frame update ───────────────────────────────────────────────────────

  /**
   * @param {number}          dt
   * @param {InputState}      inp
   * @param {THREE.Object3D}  levelMesh
   * @param {number}          cameraYaw
   */
  update(dt, inp, levelMesh, cameraYaw) {
    this._applyMovement(dt, inp, cameraYaw);
    this._applyGravity(dt);
    this._integrate(dt);
    this._resolveCollisions(levelMesh);
    this._updateFacing();
    this._updateSprite(dt, cameraYaw);
    this._syncMesh();
  }

  // ── Physics ────────────────────────────────────────────────────────────────

  /** @param {number} dt @param {InputState} inp @param {number} cameraYaw */
  _applyMovement(dt, inp, cameraYaw) {
    const cos   = Math.cos(cameraYaw);
    const sin   = Math.sin(cameraYaw);
    const wishX =  inp.move.x * cos + inp.move.z * sin;
    const wishZ = -inp.move.x * sin + inp.move.z * cos;

    const def     = TILE_TYPES[this.groundType] ?? TILE_TYPES['s'];
    const friction = this.onGround ? def.friction : 1.0;
    const accel    = this.onGround ? ACCEL_GROUND : ACCEL_AIR;
    const t        = Math.min(accel * friction * dt, 1);

    this.velocity.x += (wishX * WALK_SPEED - this.velocity.x) * t;
    this.velocity.z += (wishZ * WALK_SPEED - this.velocity.z) * t;

    if (inp.jumpPressed && this.onGround) {
      this.velocity.y   = JUMP_SPEED;
      this.onGround     = false;
      this._squashTimer = -0.18;
    }
  }

  /** @param {number} dt */
  _applyGravity(dt) {
    if (!this.onGround) this.velocity.y += GRAVITY * dt;
  }

  /** @param {number} dt */
  _integrate(dt) {
    this.position.addScaledVector(this.velocity, dt);
  }

  /** @param {THREE.Object3D} levelMesh */
  _resolveCollisions(levelMesh) {
    const wasOnGround  = this.onGround;
    this.onGround   = false;
    this.groundType = 's';

    // 1. Ground — 5-point downward sweep
    let bestGroundY    = -Infinity;
    let bestGroundType = 's';
    let foundGround    = false;

    for (const [ox, oz] of _GND_OFF) {
      _origin.set(this.position.x + ox, this.position.y, this.position.z + oz);
      _rc.set(_origin, _DOWN);
      _rc.near = 0;
      _rc.far  = PH + GROUND_REACH;
      _hits.length = 0;
      _rc.intersectObject(levelMesh, true, _hits);
      if (_hits.length > 0 && _hits[0].point.y > bestGroundY) {
        bestGroundY    = _hits[0].point.y;
        bestGroundType = /** @type {string} */ (_hits[0].object.userData?.tileType ?? 's');
        foundGround    = true;
      }
    }

    if (foundGround && this.velocity.y <= 0.2) {
      this.position.y = bestGroundY + PH;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.onGround   = true;
      this.groundType = bestGroundType;
      if (!wasOnGround) this._squashTimer = 0.14;
    }

    // 2. Ceiling
    _origin.copy(this.position);
    _rc.set(_origin, _UP);
    _rc.near = 0;
    _rc.far  = PH + 0.04;
    _hits.length = 0;
    _rc.intersectObject(levelMesh, true, _hits);
    if (_hits.length > 0 && this.velocity.y > 0) {
      this.position.y = _hits[0].point.y - PH;
      this.velocity.y = 0;
    }

    // 3. Walls — max penetration across 2 heights per direction
    const wallYLow = this.position.y - PH + 0.15;
    const wallYMid = this.position.y;

    for (const dir of _WALL_DIRS) {
      let maxPen = 0;
      for (const wy of [wallYLow, wallYMid]) {
        _origin.set(this.position.x, wy, this.position.z);
        _rc.set(_origin, dir);
        _rc.near = 0;
        _rc.far  = PW + 0.04;
        _hits.length = 0;
        _rc.intersectObject(levelMesh, true, _hits);
        if (_hits.length > 0) maxPen = Math.max(maxPen, PW + 0.04 - _hits[0].distance);
      }
      if (maxPen > 0) {
        this.position.x -= dir.x * maxPen;
        this.position.z -= dir.z * maxPen;
        if (dir.x !== 0 && Math.sign(this.velocity.x) === Math.sign(dir.x)) this.velocity.x = 0;
        if (dir.z !== 0 && Math.sign(this.velocity.z) === Math.sign(dir.z)) this.velocity.z = 0;
      }
    }
  }

  _updateFacing() {
    const h = Math.sqrt(this.velocity.x ** 2 + this.velocity.z ** 2);
    this._speed = h;
    if (h > 0.4) this.facingAngle = Math.atan2(this.velocity.x, this.velocity.z);
  }

  // ── Sprite animation ───────────────────────────────────────────────────────

  /**
   * Determines the camera-relative facing quadrant, advances the walk cycle,
   * and applies the correct atlas UV to the SpriteMaterial.
   *
   * Camera-relative facing math:
   *   rel = facingAngle - cameraYaw
   *   fwd   = cos(rel)   → positive means player faces toward the camera
   *   right = sin(rel)   → positive means player faces the camera's right
   *
   * @param {number} dt
   * @param {number} cameraYaw
   */
  _updateSprite(dt, cameraYaw) {
    // Advance walk timer only while moving
    if (this._speed > 0.5) {
      this._walkTimer += dt;
      if (this._walkTimer >= WALK_FRAME_SECS) {
        this._walkTimer = 0;
        // this._walkFrame = this._walkFrame === 0 ? 1 : 0;
        this._walkFrame = (this._walkFrame + 1) % 5;
      }
    } else {
      this._walkFrame = 0;
      this._walkTimer = 0;
    }

    // Recompute direction only while moving (hold last known dir when idle)
    if (this._speed > 0.3) {
      const rel   = this.facingAngle - cameraYaw;
      const fwd   =  Math.cos(rel); // + = toward camera
      const right =  Math.sin(rel); // + = camera-right

      if (Math.abs(fwd) >= Math.abs(right)) {
        this._spriteDir    = fwd >= 0 ? 'front' : 'back';
        this._spriteMirror = false;
      } else {
        this._spriteDir    = 'right';
        this._spriteMirror = right < 0; // left = mirrored right
      }
    }

    const frames = this.sprites[this._spriteDir];
    const idx    = frames[Math.min(this._walkFrame, frames.length - 1)];
    this._applySpriteIndex(idx, this._spriteMirror);
  }

  /**
   * Set the SpriteMaterial's texture offset/repeat to display sprite `idx`.
   * A negative repeatX mirrors the sprite horizontally.
   * @param {number}  idx
   * @param {boolean} mirror
   */
  _applySpriteIndex(idx, mirror) {
    const col = idx % SHEET_COLS;
    const row = Math.floor(idx / SHEET_COLS);
    const tex = /** @type {THREE.SpriteMaterial} */ (this.mesh.material).map;
    if (!tex) return;

    const v0 = 1 - (row + 1) / SHEET_COLS; // bottom of sprite in UV

    if (mirror) {
      tex.offset.set((col + 1) / SHEET_COLS, v0);
      tex.repeat.set(-1 / SHEET_COLS, 1 / SHEET_COLS);
    } else {
      tex.offset.set(col / SHEET_COLS, v0);
      tex.repeat.set( 1 / SHEET_COLS, 1 / SHEET_COLS);
    }
  }

  _syncMesh() {
    // Sprite anchor is at bottom (center.y = 0), so position at feet.
    this.mesh.position.set(
      this.position.x,
      this.position.y - PH,
      this.position.z,
    );
  }

  /**
   * Teleport player; y is feet level.
   * @param {number} x @param {number} y @param {number} z
   */
  respawn(x, y, z) {
    this.position.set(x, y + PH, z);
    this.velocity.set(0, 0, 0);
    this.onGround = false;
  }
}
