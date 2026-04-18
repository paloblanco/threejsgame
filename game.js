// @ts-check
import * as THREE from 'three';
import { Level }      from './level.js';
import { Player }     from './player.js';
import { GameCamera } from './camera.js';
import { initInput, updateInput, input } from './input.js';
import { Chest }      from './chest.js';

// ── Renderer ──────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.BasicShadowMap;
document.body.appendChild(renderer.domElement);

// ── Scene ─────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog        = new THREE.Fog(0x87ceeb, 40, 100);

// ── Lighting ──────────────────────────────────────────────────────────────────
// Ambient is intentionally low so the directional light drives shading.
// Too-high ambient washes out directional contribution and hides shadows.
scene.add(new THREE.AmbientLight(0xffffff, 0.2));

const sun = new THREE.DirectionalLight(0xfff8e0, 0.9);
sun.position.set(15, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near   =  1;
sun.shadow.camera.far    = 80;
sun.shadow.camera.left   = -20;
sun.shadow.camera.right  =  20;
sun.shadow.camera.top    =  20;
sun.shadow.camera.bottom = -20;
scene.add(sun);
// Point the shadow frustum at the level centre so the whole grid is covered.
// The target object must be in the scene for Three.js to use its position.
sun.target.position.set(8, 0, 8);
scene.add(sun.target);

// ── Spritesheet ───────────────────────────────────────────────────────────────
// Loaded once and shared.  Tile materials receive the original; the player
// clones it so per-frame offset/repeat changes don't affect tile rendering.
const spritesheet = await new THREE.TextureLoader().loadAsync('./assets/textures/sprites.png');
spritesheet.magFilter = THREE.NearestFilter; // pixel-art: no interpolation
spritesheet.minFilter = THREE.NearestFilter;
spritesheet.colorSpace = THREE.SRGBColorSpace;

// ── Game objects ──────────────────────────────────────────────────────────────
const level  = new Level();
const player = new Player(spritesheet);
const cam    = new GameCamera();
const chest  = new Chest(spritesheet);

scene.add(player.mesh);
scene.add(chest.mesh);

// ── Game state ────────────────────────────────────────────────────────────────
// 'title'   — title screen; level visible, player/shadow hidden, fixed camera.
// 'playing' — normal gameplay.
let gameState = 'title';
const titleEl = /** @type {HTMLElement} */ (document.getElementById('title-screen'));

// ── Level management ──────────────────────────────────────────────────────────
const MAX_LEVELS = 10;
let currentLevel = 1;
let levelLoading = false;
// Respawn point for the current level (updated on each load).
const spawn = new THREE.Vector3(2.5, 6, 2.5);

/**
 * Load level n, position the player and chest from the objects array.
 * @param {number} n
 */
async function loadLevel(n) {
  levelLoading = true;
  await level.load(
    `./assets/levels/level${n}.csv`,
    `./assets/levels/level${n}.json`,
    spritesheet,
    scene,
  );

  const objects   = level.objects;
  const playerObj = objects.find(o => o.type === 'player') ?? { x: 2.5, y: 1, z: 2.5 };
  const chestObj  = objects.find(o => o.type === 'chest')  ?? { x: 7.5, y: 1, z: 7.5 };

  // Spawn player a few units above the floor so they fall into place.
  spawn.set(playerObj.x, playerObj.y + 5, playerObj.z);
  player.respawn(spawn.x, spawn.y, spawn.z);
  chest.place(chestObj.x, chestObj.y, chestObj.z);

  levelLoading = false;
}

// ── Initial level load ────────────────────────────────────────────────────────
// Load the level geometry for the title screen background; player is hidden
// until the user presses jump.
player.mesh.visible = false;
await loadLevel(currentLevel);

// ── Shadow bake ───────────────────────────────────────────────────────────────
// Level geometry is static; compute the shadow map once on the first frame and
// freeze it so there's no per-frame shadow-map overhead.
sun.shadow.autoUpdate  = true;//false;
sun.shadow.needsUpdate = true; // set back to false automatically after first render

// ── Player blob shadow ────────────────────────────────────────────────────────
// A simple disc that projects down onto the nearest surface below the player.
// Scales with height so it shrinks as the player rises into the air.
const _blobGeo = new THREE.CircleGeometry(0.28, 8);
_blobGeo.rotateX(-Math.PI / 2); // lay flat
const playerShadow = new THREE.Mesh(_blobGeo, new THREE.MeshBasicMaterial({
  color:               0x000000,
  transparent:         true,
  opacity:             0.4,
  depthWrite:          false,
  polygonOffset:       true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits:  -4,
}));
scene.add(playerShadow);
playerShadow.visible = false; // hidden until gameplay starts

// ── Input ─────────────────────────────────────────────────────────────────────
initInput();

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  cam.onResize();
});

// ── Game loop ─────────────────────────────────────────────────────────────────
const clock  = new THREE.Clock();
const KILL_Y = -15;

// Fixed overview camera position for the title screen.
// Positioned high and angled to frame the full 16×16 level.
const TITLE_CAM_POS    = new THREE.Vector3(8, 26, -6);
const TITLE_CAM_TARGET = new THREE.Vector3(8, 1, 8);

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);

  updateInput();

  // ── Title state ────────────────────────────────────────────────────────────
  if (gameState === 'title') {
    cam.camera.position.copy(TITLE_CAM_POS);
    cam.camera.lookAt(TITLE_CAM_TARGET);

    if (input.jumpPressed) {
      gameState = 'playing';
      titleEl.style.display = 'none';
      player.mesh.visible   = true;
      playerShadow.visible  = true;
      // Re-respawn so player drops cleanly onto the floor from the spawn point.
      player.respawn(spawn.x, spawn.y, spawn.z);
      clock.getDelta(); // discard the stalled dt from the title screen pause
    }

    renderer.render(scene, cam.camera);
    return;
  }

  // ── Playing state ──────────────────────────────────────────────────────────
  player.update(dt, input, level, cam.yaw);
  cam.update(dt, player, input);

  if (player.position.y < KILL_Y) {
    player.respawn(spawn.x, spawn.y, spawn.z);
  }

  // Advance to the next level when the player reaches the chest.
  if (!levelLoading && chest.isTriggered(player.position)) {
    currentLevel = currentLevel < MAX_LEVELS ? currentLevel + 1 : 1;
    loadLevel(currentLevel);
  }

  // Project blob shadow onto the nearest surface below the player.
  // player.mesh is anchored at the feet (center.y = 0), so its Y = feet world Y.
  {
    const px = player.position.x, pz = player.position.z;
    const feetY = player.mesh.position.y;
    let groundY = 0;
    for (const c of level.getNearbyColliders(px, pz, 1)) {
      if (px >= c.xMin && px <= c.xMax && pz >= c.zMin && pz <= c.zMax && c.yMax <= feetY + 0.1) {
        if (c.yMax > groundY) groundY = c.yMax;
      }
    }
    const dist = Math.max(0, feetY - groundY);
    const s    = Math.max(0.15, 1.0 - dist * 0.1);
    playerShadow.position.set(px, groundY + 0.01, pz);
    playerShadow.scale.set(s, s, s);
  }

  renderer.render(scene, cam.camera);
}

loop();
