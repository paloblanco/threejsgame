// @ts-check
import * as THREE from 'three';
import { TILE_TYPES } from './level.js';
import { playSound } from './sound.js';

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

const GROUND_SNAP   = 0.50; // feet can be this far below tile top and still snap to surface
const WALK_FRAME_SECS = 0.10; // seconds per walk animation frame

// ── Sprite atlas ───────────────────────────────────────────────────────────────
const SHEET_COLS = 16;

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
      front: [0, 1, 2, 3],
      back:  [32, 33, 34, 35],
      right: [16, 17, 18, 19],
      dead:  [0, 1, 2, 3],   // placeholder — replace with real death-anim indices
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
   * @param {number}                     dt
   * @param {InputState}                 inp
   * @param {import('./level.js').Level} level
   * @param {number}                     cameraYaw
   */
  update(dt, inp, level, cameraYaw) {
    this._applyMovement(dt, inp, cameraYaw);
    this._applyGravity(dt);
    this._integrate(dt);
    this._resolveCollisions(level);
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
      playSound(0); // jump
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

  /** @param {import('./level.js').Level} level */
  _resolveCollisions(level) {
    const wasOnGround = this.onGround;
    this.onGround   = false;
    this.groundType = 's';

    const colliders = level.getNearbyColliders(this.position.x, this.position.z, 2);

    // ── Pass 1: Y (vertical) ────────────────────────────────────────────────────
    let groundY    = -Infinity;
    let groundType = 's';
    let ceilY      =  Infinity;

    for (const t of colliders) {
      const ox = Math.min(this.position.x + PW, t.xMax) - Math.max(this.position.x - PW, t.xMin);
      const oz = Math.min(this.position.z + PW, t.zMax) - Math.max(this.position.z - PW, t.zMin);
      if (ox <= 0 || oz <= 0) continue;

      const feetY = this.position.y - PH;
      const headY = this.position.y + PH;

      // Ground: player centre above tile centre, feet near or just below tile top.
      if (this.position.y > (t.yMin + t.yMax) * 0.5 && feetY >= t.yMax - GROUND_SNAP && feetY <= t.yMax + 0.05) {
        if (t.yMax > groundY) { groundY = t.yMax; groundType = t.type; }
      }
      // Ceiling: tile starts above player's feet AND the vertical penetration
      // (headY - yMin) is the smallest axis, meaning this is a bottom-face
      // contact and not a side contact the XZ pass should handle.
      const headPen = headY - t.yMin;
      if (feetY < t.yMin && headPen > 0 && headPen < ox && headPen < oz) {
        if (t.yMin < ceilY) ceilY = t.yMin;
      }
    }

    if (groundY > -Infinity && this.velocity.y <= 0.2) {
      this.position.y = groundY + PH;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.onGround   = true;
      this.groundType = groundType;
      if (!wasOnGround) this._squashTimer = 0.14;
    }

    if (ceilY < Infinity && this.velocity.y > 0) {
      this.position.y = ceilY - PH;
      this.velocity.y = 0;
    }

    // ── Pass 2: XZ (horizontal) — 3 iterations to resolve corners ───────────────
    // Push direction is determined by velocity rather than tile-centre comparison.
    // The centre comparison fails when the player crosses a tile's midpoint while
    // airborne above it (oy=0 so no XZ collision that frame): when they land the
    // centre test picks the wrong side and launches them through the wall.
    // Using velocity gives the correct "which side did I come from" answer and
    // also handles multi-tile walls where the player can drift past tile centres.
    // Fallback to centre comparison only when velocity on that axis is ~zero
    // (player was pushed to rest against the wall in a previous iteration).
    for (let iter = 0; iter < 3; iter++) {
      for (const t of colliders) {
        const oy = Math.min(this.position.y + PH, t.yMax) - Math.max(this.position.y - PH, t.yMin);
        if (oy <= 0) continue;

        const ox = Math.min(this.position.x + PW, t.xMax) - Math.max(this.position.x - PW, t.xMin);
        const oz = Math.min(this.position.z + PW, t.zMax) - Math.max(this.position.z - PW, t.zMin);
        if (ox <= 0 || oz <= 0) continue;

        if (ox <= oz) {
          const push = this.velocity.x >  0.001 ? -ox
                     : this.velocity.x < -0.001 ?  ox
                     : this.position.x > (t.xMin + t.xMax) * 0.5 ? ox : -ox;
          this.position.x += push;
          if (Math.sign(this.velocity.x) !== Math.sign(push)) this.velocity.x = 0;
        } else {
          const push = this.velocity.z >  0.001 ? -oz
                     : this.velocity.z < -0.001 ?  oz
                     : this.position.z > (t.zMin + t.zMax) * 0.5 ? oz : -oz;
          this.position.z += push;
          if (Math.sign(this.velocity.z) !== Math.sign(push)) this.velocity.z = 0;
        }
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
        this._walkFrame = (this._walkFrame + 1) % 4;
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

  /** Begin the death sprite sequence (call once on death). */
  startDeath() {
    this._walkFrame = 0;
    this._walkTimer = 0;
  }

  /**
   * Advance the death sprite animation only — no physics.
   * @param {number} dt
   */
  updateDead(dt) {
    this._walkTimer += dt;
    if (this._walkTimer >= WALK_FRAME_SECS) {
      this._walkTimer = 0;
      this._walkFrame = (this._walkFrame + 1) % this.sprites.dead.length;
    }
    this._applySpriteIndex(this.sprites.dead[this._walkFrame], false);
    this._syncMesh();
  }

  /**
   * Teleport player; y is feet level.
   * @param {number} x @param {number} y @param {number} z
   */
  respawn(x, y, z) {
    this.position.set(x, y + PH, z);
    this.velocity.set(0, 0, 0);
    this.onGround  = false;
    this._walkFrame = 0;
    this._walkTimer = 0;
  }
}
