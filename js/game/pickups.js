/* Power-up pickups: entities that sit on a floor tile until a player walks
   over them.  Drops happen when a box is destroyed; the goodieFreq slider
   in the lobby controls drop probability. */

/* Drop probabilities for the lobby slider's three positions. */
export const DROP_CHANCE = [0.15, 0.30, 0.50];

/* Drop pool. `bomb` and `fire` appear twice so they're drawn at double
   the rate of the rest — bread-and-butter upgrades, but not so dominant
   that the exotic powerups never show up. */
export const PICKUP_POOL = [
  'bomb', 'bomb', 'fire', 'fire',
  'remote', 'shield', 'ghost', 'slow',
  'kick', 'magnet',
  'confuse', 'flash', 'earthquake',
];

/* Caps so a runaway match doesn't produce comical superplayers. */
export const MAX_BOMBS = 8;
export const MAX_RANGE = 8;

/* Ghost duration (seconds while phasing through walls). */
export const GHOST_DURATION = 5;
/* Slow duration applied to OTHER players (seconds). */
export const SLOW_DURATION = 3;
/* Slow multiplier (40%). */
export const SLOW_FACTOR = 0.4;
/* Magnet: pull pickups within this many tiles toward the holder. */
export const MAGNET_RADIUS = 4;
/* How often a magnet drags each pickup one tile closer (seconds). */
export const MAGNET_STEP_INTERVAL = 0.25;
/* How long the magnet effect stays active after pickup. */
export const MAGNET_DURATION = 5;
/* Kick: how often a kicked bomb advances one tile (seconds).  A
   higher interval = slower bomb — current 0.25 makes a kicked bomb
   roll at roughly walking pace instead of zipping across the board. */
export const KICK_STEP_INTERVAL = 0.25;
/* How long the kick ability stays active after pickup. */
export const KICK_DURATION = 5;
/* Earthquake: total duration and how often bombs jiggle a tile. */
export const EARTHQUAKE_DURATION = 3;
export const EARTHQUAKE_INTERVAL = 0.5;
/* Flash: temporary super-speed buff (multiplier × base speed, duration). */
export const FLASH_DURATION = 5;
export const FLASH_MULTIPLIER = 2;
/* Confuse: how long (seconds) the picker's own controls are inverted. */
export const CONFUSE_DURATION = 5;

let nextPickupId = 1;

export function createPickup(type, x, y){
  return { id: nextPickupId++, type, x, y };
}

export function pickRandomPickup(rng = Math.random){
  return PICKUP_POOL[Math.floor(rng() * PICKUP_POOL.length)];
}

/* Apply a picked-up power-up to the player.  `ctx` exposes engine helpers
   for effects that need access to world state (slow, hook, swap,
   earthquake) — keeps pickups.js decoupled from engine internals. */
export function applyPickup(player, type, ctx){
  switch(type){
    case 'bomb':
      player.bombMax = Math.min(MAX_BOMBS, player.bombMax + 1);
      break;
    case 'fire':
      player.range = Math.min(MAX_RANGE, player.range + 1);
      break;
    case 'remote':
      player.hasRemote = true;
      break;
    case 'shield':
      player.shieldStacks = (player.shieldStacks || 0) + 1;
      break;
    case 'ghost':
      player.ghostUntil = ctx.elapsed + GHOST_DURATION;
      break;
    case 'slow':
      ctx.slowOthers(player, SLOW_DURATION);
      break;
    case 'kick':
      player.kickUntil = Math.max(player.kickUntil || 0, ctx.elapsed + KICK_DURATION);
      break;
    case 'magnet':
      player.magnetUntil = Math.max(player.magnetUntil || 0, ctx.elapsed + MAGNET_DURATION);
      break;
    /* Confuse — flips the picker's own movement controls for a few
       seconds.  Self-debuff: a tempting but punishing pickup. */
    case 'confuse':
      player.confusedUntil = Math.max(player.confusedUntil || 0, ctx.elapsed + CONFUSE_DURATION);
      break;
    /* Flash — temporary super-speed buff.  Stacks duration if picked
       up again before expiry. */
    case 'flash':
      player.flashUntil = Math.max(player.flashUntil || 0, ctx.elapsed + FLASH_DURATION);
      break;
    /* Earthquake — for the next few seconds every live bomb jiggles one
       tile in a random direction at a fixed cadence. */
    case 'earthquake':
      ctx.startEarthquake();
      break;
  }
  /* Maintain a list of all collected types for the HUD display. */
  if(!player.collected) player.collected = [];
  player.collected.push(type);
}
