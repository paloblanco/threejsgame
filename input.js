// @ts-check

/**
 * Unified input state consumed by player and camera each frame.
 * @typedef {{ x: number, z: number }} Vec2
 */

/**
 * @typedef {Object} InputState
 * @property {Vec2}    move         - Normalised movement vector in local XZ. Range [-1, 1].
 * @property {boolean} jumpPressed  - True only on the frame jump was pressed.
 * @property {Vec2}    cameraDelta  - Accumulated pointer delta in pixels since last frame.
 */

const JOYSTICK_RADIUS = 50; // pixels

/** @type {Set<string>} */
const _keys = new Set();

let _jumpPressed = false;

// Joystick state
let _joyTouchId = -1;
let _joyOriginX = 0;
let _joyOriginY = 0;
let _joyDX = 0;
let _joyDZ = 0;

// Camera-drag state (touch and mouse)
let _camTouchId = -1;
let _camPrevX = 0;
let _camPrevY = 0;
let _camDeltaX = 0;
let _camDeltaY = 0;
let _mouseDown = false;
let _mousePrevX = 0;
let _mousePrevY = 0;

// DOM refs set by initInput
/** @type {HTMLElement | null} */ let _joystickBase = null;
/** @type {HTMLElement | null} */ let _joystickThumb = null;
/** @type {HTMLElement | null} */ let _jumpBtn = null;

/** @type {InputState} */
export const input = {
  move: { x: 0, z: 0 },
  jumpPressed: false,
  cameraDelta: { x: 0, y: 0 },
};

const isMobile = () => 'ontouchstart' in window;

export function initInput() {
  _joystickBase  = document.getElementById('joystick-base');
  _joystickThumb = document.getElementById('joystick-thumb');
  _jumpBtn       = document.getElementById('jump-btn');

  if (isMobile()) {
    if (_joystickBase) _joystickBase.style.display = 'block';
    if (_jumpBtn)      _jumpBtn.style.display = 'flex';
  }

  // Keyboard
  window.addEventListener('keydown', e => {
    _keys.add(e.code);
    if (e.code === 'Space') { _jumpPressed = true; e.preventDefault(); }
  });
  window.addEventListener('keyup', e => _keys.delete(e.code));

  // Touch
  window.addEventListener('touchstart',  _onTouchStart, { passive: false });
  window.addEventListener('touchmove',   _onTouchMove,  { passive: false });
  window.addEventListener('touchend',    _onTouchEnd,   { passive: false });
  window.addEventListener('touchcancel', _onTouchEnd,   { passive: false });

  // Jump button (touch)
  if (_jumpBtn) {
    _jumpBtn.addEventListener('touchstart', e => {
      _jumpPressed = true;
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });
  }

  // Mouse look (right-click drag)
  window.addEventListener('mousedown', e => {
    if (e.button === 2) { _mouseDown = true; _mousePrevX = e.clientX; _mousePrevY = e.clientY; }
  });
  window.addEventListener('mouseup',   e => { if (e.button === 2) _mouseDown = false; });
  window.addEventListener('mousemove', e => {
    if (_mouseDown) {
      _camDeltaX += e.clientX - _mousePrevX;
      _camDeltaY += e.clientY - _mousePrevY;
      _mousePrevX = e.clientX;
      _mousePrevY = e.clientY;
    }
  });
  window.addEventListener('contextmenu', e => e.preventDefault());
}

/** @param {TouchEvent} e */
function _onTouchStart(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    // Left half → joystick
    if (t.clientX < window.innerWidth * 0.5 && _joyTouchId === -1) {
      _joyTouchId = t.identifier;
      _joyOriginX = t.clientX;
      _joyOriginY = t.clientY;
      _joyDX = 0;
      _joyDZ = 0;
      if (_joystickBase) {
        _joystickBase.style.left = `${t.clientX - 50}px`;
        _joystickBase.style.bottom = '';
        _joystickBase.style.top  = `${t.clientY - 50}px`;
      }
    // Right half (not jump btn) → camera drag
    } else if (t.clientX >= window.innerWidth * 0.5 && _camTouchId === -1) {
      if (_jumpBtn && _jumpBtn.contains(/** @type {Element} */ (e.target))) continue;
      _camTouchId = t.identifier;
      _camPrevX = t.clientX;
      _camPrevY = t.clientY;
    }
  }
}

/** @param {TouchEvent} e */
function _onTouchMove(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === _joyTouchId) {
      const dx = t.clientX - _joyOriginX;
      const dy = t.clientY - _joyOriginY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const clamped = Math.min(len, JOYSTICK_RADIUS);
      _joyDX = (dx / len) * (clamped / JOYSTICK_RADIUS);
      _joyDZ = (dy / len) * (clamped / JOYSTICK_RADIUS);
      // Move thumb
      if (_joystickThumb) {
        const nx = (dx / len) * clamped;
        const ny = (dy / len) * clamped;
        _joystickThumb.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
      }
    }
    if (t.identifier === _camTouchId) {
      _camDeltaX += t.clientX - _camPrevX;
      _camDeltaY += t.clientY - _camPrevY;
      _camPrevX = t.clientX;
      _camPrevY = t.clientY;
    }
  }
}

/** @param {TouchEvent} e */
function _onTouchEnd(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === _joyTouchId) {
      _joyTouchId = -1;
      _joyDX = 0;
      _joyDZ = 0;
      if (_joystickThumb) _joystickThumb.style.transform = 'translate(-50%, -50%)';
      if (_joystickBase)  _joystickBase.style.cssText = '';
      if (_joystickBase && isMobile()) _joystickBase.style.display = 'block';
    }
    if (t.identifier === _camTouchId) {
      _camTouchId = -1;
    }
  }
}

/**
 * Call once per frame before updating game objects.
 * Writes into the shared `input` object and resets single-frame fields.
 */
export function updateInput() {
  // Movement from keyboard
  let mx = 0, mz = 0;
  if (_keys.has('KeyA') || _keys.has('ArrowLeft'))  mx -= 1;
  if (_keys.has('KeyD') || _keys.has('ArrowRight')) mx += 1;
  if (_keys.has('KeyW') || _keys.has('ArrowUp'))    mz -= 1;
  if (_keys.has('KeyS') || _keys.has('ArrowDown'))  mz += 1;

  // Touch joystick overrides keyboard when active
  if (_joyTouchId !== -1) { mx = _joyDX; mz = _joyDZ; }

  // Normalise diagonal
  const mlen = Math.sqrt(mx * mx + mz * mz);
  if (mlen > 1) { mx /= mlen; mz /= mlen; }

  input.move.x = mx;
  input.move.z = mz;
  input.jumpPressed = _jumpPressed || _keys.has('Space');
  input.cameraDelta.x = _camDeltaX;
  input.cameraDelta.y = _camDeltaY;

  // Reset single-frame accumulators
  _jumpPressed = false;
  _camDeltaX   = 0;
  _camDeltaY   = 0;
}
