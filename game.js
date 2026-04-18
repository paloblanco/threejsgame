// @ts-check
import * as THREE from 'three';
import { Level }      from './level.js';
import { Player }     from './player.js';
import { GameCamera } from './camera.js';
import { initInput, updateInput, input } from './input.js';

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

scene.add(player.mesh);

// ── Load level ────────────────────────────────────────────────────────────────
await level.load(
  './assets/levels/level1.csv',
  './assets/levels/level1.json',
  spritesheet,
  scene,
);

player.respawn(2, 10, 2);

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

// ── Input ─────────────────────────────────────────────────────────────────────
initInput();

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  cam.onResize();
});

// ── Game loop ─────────────────────────────────────────────────────────────────
const clock  = new THREE.Clock();
const SPAWN  = new THREE.Vector3(2, 10, 2);
const KILL_Y = -15;

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);

  updateInput();
  player.update(dt, input, level, cam.yaw);
  cam.update(dt, player, input);

  if (player.position.y < KILL_Y) {
    player.respawn(SPAWN.x, SPAWN.y, SPAWN.z);
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
