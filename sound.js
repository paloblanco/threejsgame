// @ts-check

/** @type {AudioContext|null} */
let _ctx = null;

function getCtx() {
  if (!_ctx) _ctx = new AudioContext();
  if (_ctx.state === 'suspended') _ctx.resume();
  return _ctx;
}

/** @type {Map<number, AudioBuffer>} */
const _buffers = new Map();

/**
 * Try to load sounds 0 … count-1 from ./assets/sounds/{n}.wav.
 * Missing files are silently skipped.
 * @param {number} count
 */
export async function loadSounds(count) {
  const ctx = getCtx();
  await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      try {
        const res = await fetch(`./assets/sounds/${i}.wav`);
        if (!res.ok) return;
        _buffers.set(i, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch (_) {}
    })
  );
}

/**
 * Play sound n.  No-op if the sound was not loaded.
 * @param {number} n
 */
export function playSound(n) {
  const buf = _buffers.get(n);
  if (!buf) return;
  const ctx = getCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}
