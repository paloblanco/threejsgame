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
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// ── Scene ─────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog        = new THREE.Fog(0x87ceeb, 40, 100);

// ── Lighting ──────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.55));

const sun = new THREE.DirectionalLight(0xfff8e0, 1.2);
sun.position.set(15, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near   =  0.5;
sun.shadow.camera.far    = 120;
sun.shadow.camera.left   = -30;
sun.shadow.camera.right  =  30;
sun.shadow.camera.top    =  30;
sun.shadow.camera.bottom = -30;
scene.add(sun);

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
  player.update(dt, input, level.mesh, cam.yaw);
  cam.update(dt, player, input);

  if (player.position.y < KILL_Y) {
    player.respawn(SPAWN.x, SPAWN.y, SPAWN.z);
  }

  renderer.render(scene, cam.camera);
}

loop();
