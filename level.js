// @ts-check
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ── Sprite atlas ───────────────────────────────────────────────────────────────
const SHEET_COLS = 16;

/**
 * UV bounds for sprite `index` in a SHEET_COLS-wide atlas.
 * Three.js textures have flipY=true by default: UV (0,0) = bottom-left of image.
 * @param {number} index
 * @returns {{ u0:number, u1:number, v0:number, v1:number }}
 */
function spriteRegion(index) {
  const col = index % SHEET_COLS;
  const row = Math.floor(index / SHEET_COLS);
  return {
    u0:  col        / SHEET_COLS,
    u1: (col + 1)   / SHEET_COLS,
    v0: 1 - (row + 1) / SHEET_COLS, // bottom of sprite in UV space
    v1: 1 -  row      / SHEET_COLS, // top of sprite in UV space
  };
}

/**
 * Build a BufferGeometry for a single tile at the origin.
 * Translate the result to world position after calling this.
 *
 * Side faces are tiled once per unit of height: a tile of height H shows
 * H copies of the side sprite stacked vertically. This requires separate
 * (non-shared) vertices at each sprite boundary so each quad can carry its
 * own UV range independently.
 *
 * @param {number} height
 * @param {number} topIdx
 * @param {number} sideIdx
 * @param {number} bottomIdx
 * @returns {THREE.BufferGeometry}
 */
function buildTileGeometry(height, topIdx, sideIdx, bottomIdx) {
  const T = spriteRegion(topIdx);
  const S = spriteRegion(sideIdx);
  const B = spriteRegion(bottomIdx);

  /** @type {number[]} */ const pos = [];
  /** @type {number[]} */ const nor = [];
  /** @type {number[]} */ const uv  = [];
  /** @type {number[]} */ const ind = [];

  /**
   * Append one quad (4 verts, 2 tris) to the buffers.
   * verts = [BL, BR, TL, TR] — bottom-left / bottom-right / top-left / top-right
   *   as seen from the face's outward direction.
   * @param {[number,number,number][]} verts
   * @param {[number,number,number]} normal
   * @param {{ u0:number, u1:number, v0:number, v1:number }} r
   */
  /**
   * flip=true reverses triangle winding so the geometric normal matches the
   * stored buffer normal (required for gl_FrontFacing to agree with the normal
   * attribute and for lighting to work with FrontSide rendering).
   */
  const quad = (verts, normal, r, flip = false) => {
    const base = pos.length / 3;
    for (const v of verts) { pos.push(...v); nor.push(...normal); }
    //  BL        BR        TL        TR
    uv.push(r.u0, r.v0,  r.u1, r.v0,  r.u0, r.v1,  r.u1, r.v1);
    if (flip) {
      // Reversed winding: BL→TL→BR, TL→TR→BR
      ind.push(base, base+2, base+1,  base+1, base+2, base+3);
    } else {
      // Default winding: BL→BR→TL, BR→TR→TL
      ind.push(base, base+1, base+2,  base+1, base+3, base+2);
    }
  };

  const h = height;

  // ── Top face (+Y) ──────────────────────────────────────────────────────────
  // flip=true: winding produces (0,+1,0) to match stored normal
  quad([[0,h,0],[1,h,0],[0,h,1],[1,h,1]], [0, 1, 0], T, true);

  // ── Bottom face (-Y) ───────────────────────────────────────────────────────
  // flip=true: winding produces (0,-1,0) to match stored normal
  quad([[0,0,1],[1,0,1],[0,0,0],[1,0,0]], [0,-1, 0], B, true);

  // ── Side faces: one quad per unit of height ────────────────────────────────
  // Each iteration produces one sprite-height strip on all four sides.
  // Separate vertex sets per strip means no shared UV at stripe boundaries,
  // so each sprite can independently span [v0, v1] without distortion.
  for (let k = 0; k < h; k++) {
    const y0 = k, y1 = k + 1;

    // Front (+Z) — default winding produces (0,0,+1) ✓
    quad([[0,y0,1],[1,y0,1],[0,y1,1],[1,y1,1]], [0,0, 1], S);
    // Back (-Z) — default winding produces (0,0,-1) ✓
    quad([[1,y0,0],[0,y0,0],[1,y1,0],[0,y1,0]], [0,0,-1], S);
    // Right (+X) — flip=true: winding produces (+1,0,0) ✓
    quad([[1,y0,0],[1,y0,1],[1,y1,0],[1,y1,1]], [ 1,0, 0], S, true);
    // Left (-X) — flip=true: winding produces (-1,0,0) ✓
    quad([[0,y0,1],[0,y0,0],[0,y1,1],[0,y1,0]], [-1,0, 0], S, true);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(nor), 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(uv),  2));
  geo.setIndex(ind);
  return geo;
}

/**
 * Build a BufferGeometry for a solid box occupying world space
 * [wx0, wx1] × [wy0, wy1] × [wz0, wz1].  Every face is tiled with 1×1 unit
 * sprites in the same atlas convention as buildTileGeometry.
 *
 * @param {number} wx0 @param {number} wy0 @param {number} wz0
 * @param {number} wx1 @param {number} wy1 @param {number} wz1
 * @param {number} topIdx @param {number} sideIdx @param {number} bottomIdx
 * @returns {THREE.BufferGeometry}
 */
function buildBoxGeometry(wx0, wy0, wz0, wx1, wy1, wz1, topIdx, sideIdx, bottomIdx) {
  const T = spriteRegion(topIdx);
  const S = spriteRegion(sideIdx);
  const B = spriteRegion(bottomIdx);

  /** @type {number[]} */ const pos = [];
  /** @type {number[]} */ const nor = [];
  /** @type {number[]} */ const uv  = [];
  /** @type {number[]} */ const ind = [];

  const quad = (verts, normal, r, flip = false) => {
    const base = pos.length / 3;
    for (const v of verts) { pos.push(...v); nor.push(...normal); }
    uv.push(r.u0, r.v0,  r.u1, r.v0,  r.u0, r.v1,  r.u1, r.v1);
    if (flip) {
      ind.push(base, base+2, base+1,  base+1, base+2, base+3);
    } else {
      ind.push(base, base+1, base+2,  base+1, base+3, base+2);
    }
  };

  const W = wx1 - wx0; // width  in world units
  const H = wy1 - wy0; // height
  const D = wz1 - wz0; // depth

  // ── Top face (+Y at wy1) ───────────────────────────────────────────────────
  for (let xi = 0; xi < W; xi++) for (let zi = 0; zi < D; zi++) {
    const x = wx0+xi, z = wz0+zi;
    quad([[x,wy1,z],[x+1,wy1,z],[x,wy1,z+1],[x+1,wy1,z+1]], [0, 1, 0], T, true);
  }

  // ── Bottom face (-Y at wy0) ────────────────────────────────────────────────
  for (let xi = 0; xi < W; xi++) for (let zi = 0; zi < D; zi++) {
    const x = wx0+xi, z = wz0+zi;
    quad([[x,wy0,z+1],[x+1,wy0,z+1],[x,wy0,z],[x+1,wy0,z]], [0,-1, 0], B, true);
  }

  // ── Front face (+Z at wz1) ────────────────────────────────────────────────
  for (let xi = 0; xi < W; xi++) for (let yi = 0; yi < H; yi++) {
    const x = wx0+xi, y = wy0+yi;
    quad([[x,y,wz1],[x+1,y,wz1],[x,y+1,wz1],[x+1,y+1,wz1]], [0, 0, 1], S);
  }

  // ── Back face (-Z at wz0) ─────────────────────────────────────────────────
  for (let xi = 0; xi < W; xi++) for (let yi = 0; yi < H; yi++) {
    const x = wx0+xi, y = wy0+yi;
    quad([[x+1,y,wz0],[x,y,wz0],[x+1,y+1,wz0],[x,y+1,wz0]], [0, 0,-1], S);
  }

  // ── Right face (+X at wx1) ────────────────────────────────────────────────
  for (let zi = 0; zi < D; zi++) for (let yi = 0; yi < H; yi++) {
    const z = wz0+zi, y = wy0+yi;
    quad([[wx1,y,z],[wx1,y,z+1],[wx1,y+1,z],[wx1,y+1,z+1]], [ 1, 0, 0], S, true);
  }

  // ── Left face (-X at wx0) ─────────────────────────────────────────────────
  for (let zi = 0; zi < D; zi++) for (let yi = 0; yi < H; yi++) {
    const z = wz0+zi, y = wy0+yi;
    quad([[wx0,y,z+1],[wx0,y,z],[wx0,y+1,z+1],[wx0,y+1,z]], [-1, 0, 0], S, true);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(nor), 3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(uv),  2));
  geo.setIndex(ind);
  return geo;
}

// ── Tile gameplay properties ───────────────────────────────────────────────────

/**
 * @typedef {Object} TileTypeDef
 * @property {number}  friction
 * @property {string}  name
 * @property {number}  color    - Fallback colour (not used when a texture is present).
 * @property {number}  [damage]
 */

/** @type {Record<string, TileTypeDef>} */
export const TILE_TYPES = {
  's':  { color: 0x888899, friction: 0.85, name: 'stone' },
  'g':  { color: 0x4c8040, friction: 0.85, name: 'grass' },
  'ic': { color: 0xaaddff, friction: 0.12, name: 'ice'   },
  'la': { color: 0xff5500, friction: 0.85, name: 'lava', damage: 20 },
  'd':  { color: 0xb8843c, friction: 0.80, name: 'dirt'  },
  'w':  { color: 0x4466aa, friction: 0.85, name: 'wood'  },
};

/**
 * @typedef {Object} TileData
 * @property {number} height
 * @property {string} type
 */

// ── Level ──────────────────────────────────────────────────────────────────────

export class Level {
  constructor() {
    /** @type {Map<string, TileData>} Grid keyed "row,col". */
    this.grid = new Map();

    /**
     * Floating boxes from the level JSON.
     * @type {{ xMin:number, xMax:number, yMin:number, yMax:number, zMin:number, zMax:number, type:string }[]}
     */
    this.boxes = [];

    /**
     * Spawn/goal objects from the level JSON "objects" array.
     * @type {{ type:string, x:number, y:number, z:number }[]}
     */
    this.objects = [];

    /** Display name from the level JSON "levelName" field. @type {string} */
    this.levelName = '';

    /** @type {THREE.Group} */
    this.mesh = new THREE.Group();

    this.rows = 0;
    this.cols = 0;
  }

  /**
   * Parse CSV + build sprite-UV'd geometry into the scene.
   *
   * CSV cell format: `{height}{type}` — e.g. `1s`, `4s`, `0g`.
   * Height 0 = empty cell (no geometry).
   *
   * @param {string}        csv
   * @param {object}        tileSprites  - The `.tiles` object from the level JSON.
   *   Shape: `{ [typeKey]: { side:number, top:number, bottom:number } }`
   * @param {any[]}         boxes        - The `.boxes` array from the level JSON.
   * @param {THREE.Texture} texture
   * @param {THREE.Scene}   scene
   */
  build(csv, tileSprites, boxes, texture, scene) {
    scene.remove(this.mesh);
    this.mesh = new THREE.Group();
    this.grid.clear();
    this.boxes = [];

    const rows = csv.trim().split('\n').map(r =>
      r.trim().split(',').map(c => c.trim())
    );
    this.rows = rows.length;
    this.cols = Math.max(...rows.map(r => r.length));

    /** @type {Map<string, THREE.BufferGeometry[]>} */
    const geosByType = new Map();

    const DEFAULT_SPRITES = { side: 0, top: 0, bottom: 0 };

    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        const cell = rows[r][c];

        // Format: one-or-more digits then one-or-more letters, e.g. "1s", "4s", "0g"
        const match = cell.match(/^(\d+)([a-z]+)$/i);
        if (!match) continue;

        const height = parseInt(match[1], 10);
        const type   = match[2].toLowerCase();
        if (height === 0) continue;

        this.grid.set(`${r},${c}`, { height, type });

        const sp  = /** @type {any} */ (tileSprites)[type] ?? DEFAULT_SPRITES;
        const geo = buildTileGeometry(height, sp.top, sp.side, sp.bottom);
        // Tile geometry sits on y=0, so no Y offset needed when translating.
        geo.translate(c, 0, r);

        if (!geosByType.has(type)) geosByType.set(type, []);
        geosByType.get(type)?.push(geo);
      }
    }

    // ── Boxes ──────────────────────────────────────────────────────────────────
    for (const b of boxes) {
      const wx0 = b.x0,     wy0 = b.y0,     wz0 = b.z0;
      const wx1 = b.x1 + 1, wy1 = b.y1 + 1, wz1 = b.z1 + 1;

      this.boxes.push({ xMin: wx0, xMax: wx1, yMin: wy0, yMax: wy1, zMin: wz0, zMax: wz1, type: b.type });

      const sp  = /** @type {any} */ (tileSprites)[b.type] ?? DEFAULT_SPRITES;
      const geo = buildBoxGeometry(wx0, wy0, wz0, wx1, wy1, wz1, sp.top, sp.side, sp.bottom);
      if (!geosByType.has(b.type)) geosByType.set(b.type, []);
      geosByType.get(b.type)?.push(geo);
    }

    // One merged mesh per tile type — one draw call each.
    for (const [type, geos] of geosByType) {
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;

      const mat = new THREE.MeshLambertMaterial({
        map:       texture,
        color:     0xffffff,
        alphaTest: 0.1,
      });

      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow    = true;
      mesh.receiveShadow = true;
      mesh.userData.tileType = type; // read by raycaster in player.js
      this.mesh.add(mesh);
    }

    scene.add(this.mesh);
  }

  /**
   * Fetch both CSV and level JSON then call build().
   * @param {string}        csvUrl
   * @param {string}        jsonUrl
   * @param {THREE.Texture} texture
   * @param {THREE.Scene}   scene
   */
  async load(csvUrl, jsonUrl, texture, scene) {
    const [csvText, levelJson] = await Promise.all([
      fetch(csvUrl).then(r => r.text()),
      fetch(jsonUrl).then(r => r.json()),
    ]);
    this.build(csvText, levelJson.tiles ?? {}, levelJson.boxes ?? [], texture, scene);
    this.objects   = levelJson.objects   ?? [];
    this.levelName = levelJson.levelName ?? '';
  }

  /**
   * Return colliders near world position (wx, wz): grid tiles within `radius`
   * cells, plus any boxes that overlap the search area.
   *
   * Each collider has explicit world-space AABB bounds.
   *
   * @param {number} wx
   * @param {number} wz
   * @param {number} [radius=2]
   * @returns {{ xMin:number, xMax:number, yMin:number, yMax:number, zMin:number, zMax:number, type:string }[]}
   */
  getNearbyColliders(wx, wz, radius = 2) {
    const col = Math.round(wx);
    const row = Math.round(wz);
    const result = [];

    // Grid tiles
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const tile = this.grid.get(`${row + dr},${col + dc}`);
        if (tile) result.push({
          xMin: col+dc,   xMax: col+dc+1,
          yMin: 0,        yMax: tile.height,
          zMin: row+dr,   zMax: row+dr+1,
          type: tile.type,
        });
      }
    }

    // Boxes — include any whose footprint overlaps the search area
    for (const b of this.boxes) {
      if (b.xMax > col - radius && b.xMin < col + radius + 1 &&
          b.zMax > row - radius && b.zMin < row + radius + 1) {
        result.push(b);
      }
    }

    return result;
  }
}
