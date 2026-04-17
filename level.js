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
 * The material should use THREE.DoubleSide to avoid needing to worry about
 * vertex winding order, which is consistent with no back-face culling in a
 * world where the camera can look at any face.
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
  const quad = (verts, normal, r) => {
    const base = pos.length / 3;
    for (const v of verts) { pos.push(...v); nor.push(...normal); }
    //  BL        BR        TL        TR
    uv.push(r.u0, r.v0,  r.u1, r.v0,  r.u0, r.v1,  r.u1, r.v1);
    // tri 1: BL→BR→TL   tri 2: BR→TR→TL
    ind.push(base, base+1, base+2,  base+1, base+3, base+2);
  };

  const h = height;

  // ── Top face (+Y) ──────────────────────────────────────────────────────────
  quad(
    [[0,h,0],[1,h,0],[0,h,1],[1,h,1]],
    [0, 1, 0], T,
  );

  // ── Bottom face (-Y) ───────────────────────────────────────────────────────
  quad(
    [[0,0,1],[1,0,1],[0,0,0],[1,0,0]],
    [0,-1, 0], B,
  );

  // ── Side faces: one quad per unit of height ────────────────────────────────
  // Each iteration produces one sprite-height strip on all four sides.
  // Separate vertex sets per strip means no shared UV at stripe boundaries,
  // so each sprite can independently span [v0, v1] without distortion.
  for (let k = 0; k < h; k++) {
    const y0 = k, y1 = k + 1;

    // Front (+Z)
    quad([[0,y0,1],[1,y0,1],[0,y1,1],[1,y1,1]],  [0,0, 1], S);
    // Back (-Z)
    quad([[1,y0,0],[0,y0,0],[1,y1,0],[0,y1,0]],  [0,0,-1], S);
    // Right (+X)
    quad([[1,y0,0],[1,y0,1],[1,y1,0],[1,y1,1]],  [1,0, 0], S);
    // Left (-X)
    quad([[0,y0,1],[0,y0,0],[0,y1,1],[0,y1,0]], [-1,0, 0], S);
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
   * @param {THREE.Texture} texture
   * @param {THREE.Scene}   scene
   */
  build(csv, tileSprites, texture, scene) {
    scene.remove(this.mesh);
    this.mesh = new THREE.Group();
    this.grid.clear();

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

    // One merged mesh per tile type — one draw call each.
    // DoubleSide avoids needing correct vertex winding; explicit normals
    // in buildTileGeometry() drive lighting correctly from either side.
    for (const [type, geos] of geosByType) {
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;

      const mat = new THREE.MeshLambertMaterial({
        map:         texture,
        color:       0xffffff,
        transparent: true,
        alphaTest:   0.1,
        side:        THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(merged, mat);
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
    this.build(csvText, levelJson.tiles ?? {}, texture, scene);
  }

  /**
   * Return tile data within `radius` grid cells of world position (wx, wz).
   * @param {number} wx
   * @param {number} wz
   * @param {number} [radius=2]
   */
  getNearbyColliders(wx, wz, radius = 2) {
    const col = Math.round(wx);
    const row = Math.round(wz);
    /** @type {{ x:number, z:number, minY:number, maxY:number, type:string }[]} */
    const result = [];
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const tile = this.grid.get(`${row + dr},${col + dc}`);
        if (tile) result.push({ x: col+dc, z: row+dr, minY: 0, maxY: tile.height, type: tile.type });
      }
    }
    return result;
  }
}
