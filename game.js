// @ts-check
import * as THREE from 'three';
import { Level }      from './level.js';
import { Player }     from './player.js';
import { GameCamera } from './camera.js';
import { initInput, updateInput, input } from './input.js';
import { Chest }      from './chest.js';
import { loadSounds, playSound } from './sound.js';

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
// 'title'         — title screen; level visible, player/shadow hidden, fixed camera.
// 'playing'       — normal gameplay.
// 'levelcomplete' — between levels; player frozen, overlay visible.
// 'finish'        — all levels done.
let gameState = 'title';
const titleEl         = /** @type {HTMLElement} */ (document.getElementById('title-screen'));
const hudEl           = /** @type {HTMLElement} */ (document.getElementById('hud'));
const hudLevelEl      = /** @type {HTMLElement} */ (document.getElementById('hud-level'));
const hudStatsEl      = /** @type {HTMLElement} */ (document.getElementById('hud-stats'));
const finishEl        = /** @type {HTMLElement} */ (document.getElementById('finish-screen'));
const finishTimeEl    = /** @type {HTMLElement} */ (document.getElementById('finish-time'));
const finishDeathEl   = /** @type {HTMLElement} */ (document.getElementById('finish-deaths'));
const levelCompleteEl = /** @type {HTMLElement} */ (document.getElementById('levelcomplete-screen'));
const lcLevelTimeEl   = /** @type {HTMLElement} */ (document.getElementById('lc-level-time'));
const lcDeathsEl      = /** @type {HTMLElement} */ (document.getElementById('lc-deaths'));
const lcTotalTimeEl   = /** @type {HTMLElement} */ (document.getElementById('lc-total-time'));

// Stats tracked across a full run (reset when starting a new game).
let totalDeaths   = 0;
let gameStartTime = 0; // Date.now() when playing begins

// Per-level stats — reset on each new level load and on death.
let levelDeaths = 0;
let levelTimer  = 0; // seconds since last respawn on this level

// Seconds the level-complete overlay has been visible (gate for jump input).
let levelCompleteTimer = 0;

// ── Iris-wipe transition ───────────────────────────────────────────────────────
/** Duration of each transition half (close or open), in seconds. Change freely. */
const TRANSITION_SECS = 0.5;

const transitionOverlay = /** @type {HTMLElement} */ (document.getElementById('transition-overlay'));
/** @type {'none'|'closing'|'closed'|'opening'} */
let transitionPhase = 'none';
let transitionTimer = 0;
/** @type {(() => void)|null} */
let transitionCallback = null;
let transitionMaxRadius = Math.hypot(window.innerWidth, window.innerHeight);

/**
 * Set the iris radius.  0 = fully black screen; transitionMaxRadius = fully clear.
 * @param {number} r
 */
function setIrisRadius(r) {
  transitionOverlay.style.background =
    `radial-gradient(circle at 50% 50%, transparent ${r}px, black ${r + 1}px)`;
}

/**
 * Start an iris-close → execute callback → iris-open sequence.
 * @param {() => void} callback  Runs when the screen is fully black (midpoint).
 */
function startTransition(callback) {
  transitionPhase    = 'closing';
  transitionTimer    = 0;
  transitionCallback = callback;
}

/** Advance the transition animation; call once per frame before state logic. */
function updateTransition(dt) {
  if (transitionPhase === 'none') return;
  transitionTimer += dt;
  const t = Math.min(transitionTimer / TRANSITION_SECS, 1);
  if (transitionPhase === 'closing') {
    setIrisRadius((1 - t) * transitionMaxRadius);
    if (t >= 1) {
      if (transitionCallback) { transitionCallback(); transitionCallback = null; }
      transitionPhase = 'closed';
      transitionTimer = 0;
    }
  } else if (transitionPhase === 'closed') {
    setIrisRadius(0);
    if (!levelLoading) {
      transitionPhase = 'opening';
      transitionTimer = 0;
    }
  } else {
    setIrisRadius(t * transitionMaxRadius);
    if (t >= 1) {
      transitionPhase = 'none';
      setIrisRadius(transitionMaxRadius); // ensure fully clear
    }
  }
}

// Initialise overlay to fully clear so it's invisible on page load.
setIrisRadius(transitionMaxRadius);

/** @param {number} totalSeconds */
function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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

  hudLevelEl.textContent = `Level ${n}: ${level.levelName}`;
  levelDeaths = 0;
  levelTimer  = 0;
  levelLoading = false;
}

// ── Sounds ────────────────────────────────────────────────────────────────────
// 0 = jump  1 = chest  2 = death  (files under assets/sounds/)
await loadSounds(3);

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
  transitionMaxRadius = Math.hypot(window.innerWidth, window.innerHeight);
  if (transitionPhase === 'none') setIrisRadius(transitionMaxRadius);
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
  updateTransition(dt);

  // ── Title state ────────────────────────────────────────────────────────────
  if (gameState === 'title') {
    cam.camera.position.copy(TITLE_CAM_POS);
    cam.camera.lookAt(TITLE_CAM_TARGET);

    if (transitionPhase === 'none' && input.jumpPressed) {
      startTransition(() => {
        titleEl.style.display = 'none';
        hudEl.style.display   = 'block';
        player.mesh.visible   = true;
        playerShadow.visible  = true;
        totalDeaths   = 0;
        gameStartTime = Date.now();
        player.respawn(spawn.x, spawn.y, spawn.z);
        gameState = 'playing';
      });
    }

    renderer.render(scene, cam.camera);
    return;
  }

  // ── Finish state ───────────────────────────────────────────────────────────
  if (gameState === 'finish') {
    cam.camera.position.copy(TITLE_CAM_POS);
    cam.camera.lookAt(TITLE_CAM_TARGET);

    if (transitionPhase === 'none' && !levelLoading && input.jumpPressed) {
      startTransition(() => {
        finishEl.style.display = 'none';
        hudEl.style.display    = 'block';
        player.mesh.visible    = true;
        playerShadow.visible   = true;
        totalDeaths   = 0;
        gameStartTime = Date.now();
        currentLevel  = 1;
        gameState     = 'playing';
        loadLevel(1);
      });
    }

    renderer.render(scene, cam.camera);
    return;
  }

  // ── Level-complete state ───────────────────────────────────────────────────
  if (gameState === 'levelcomplete') {
    levelCompleteTimer += dt;
    cam.update(dt, player, input); // camera keeps drifting for a nice feel

    if (transitionPhase === 'none' && levelCompleteTimer >= 0.5 && input.jumpPressed) {
      startTransition(() => {
        levelCompleteEl.style.display = 'none';
        if (currentLevel >= MAX_LEVELS) {
          // All levels done — hand off to finish screen.
          const elapsed = (Date.now() - gameStartTime) / 1000;
          finishTimeEl.textContent  = `Time: ${formatTime(elapsed)}`;
          finishDeathEl.textContent = `Deaths: ${totalDeaths}`;
          finishEl.style.display    = 'flex';
          player.mesh.visible       = false;
          playerShadow.visible      = false;
          hudEl.style.display       = 'none';
          gameState = 'finish';
        } else {
          currentLevel++;
          loadLevel(currentLevel);
          hudEl.style.display = 'block';
          gameState = 'playing';
        }
      });
    }

    renderer.render(scene, cam.camera);
    return;
  }

  // ── Playing state ──────────────────────────────────────────────────────────
  levelTimer += dt;
  hudStatsEl.textContent = `${formatTime(levelTimer)}  ·  ${levelDeaths} death${levelDeaths !== 1 ? 's' : ''}`;

  player.update(dt, input, level, cam.yaw);
  cam.update(dt, player, input);

  if (player.position.y < KILL_Y) {
    totalDeaths++;
    levelDeaths++;
    levelTimer = 0;
    playSound(2); // death
    player.respawn(spawn.x, spawn.y, spawn.z);
  }

  // When the player reaches the chest, show the level-complete overlay.
  if (!levelLoading && chest.isTriggered(player.position)) {
    playSound(1); // chest
    lcLevelTimeEl.textContent = `Level time: ${formatTime(levelTimer)}`;
    lcDeathsEl.textContent    = `Deaths: ${levelDeaths}`;
    lcTotalTimeEl.textContent = `Total time: ${formatTime((Date.now() - gameStartTime) / 1000)}`;
    levelCompleteEl.style.display = 'flex';
    hudEl.style.display = 'none';
    levelCompleteTimer = 0;
    gameState = 'levelcomplete';
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
