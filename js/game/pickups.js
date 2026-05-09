/* Power-up pickups: entities that sit on a floor tile until a player walks
   over them.  Drops happen when a box is destroyed; the goodieFreq slider
   in the lobby controls drop probability. */

/* Drop probabilities for the lobby slider's three positions. */
export const DROP_CHANCE = [0.15, 0.30, 0.50];

/* All 12 power-ups now have working mechanics — drop pool covers everything. */
export const PICKUP_POOL = [
  'bomb', 'fire', 'speed', 'remote', 'shield', 'super', 'ghost', 'slow',
  'kick', 'magnet', 'curse', 'boomerang',
];

/* Caps so a runaway match doesn't produce comical superplayers. */
export const MAX_BOMBS = 8;
export const MAX_RANGE = 8;
export const MAX_SPEED = 8.5;

/* Ghost duration (seconds while phasing through walls). */
export const GHOST_DURATION = 5;
/* Slow duration applied to OTHER players (seconds). */
export const SLOW_DURATION = 3;
/* Slow multiplier (40%). */
export const SLOW_FACTOR = 0.4;
/* Curse: how long does self-slow last when you pick up a skull? */
export const CURSE_DURATION = 5;
/* Magnet: pull pickups within this many tiles toward the holder. */
export const MAGNET_RADIUS = 4;
/* How often a magnet drags each pickup one tile closer (seconds). */
export const MAGNET_STEP_INTERVAL = 0.25;
/* Kick: how often a kicked bomb advances one tile (seconds). */
export const KICK_STEP_INTERVAL = 0.12;
/* Boomerang: first wave is short-range (1 tile), second wave fires after this
   delay with the player's full bomb range. */
export const BOOMERANG_FIRST_RANGE  = 1;
export const BOOMERANG_SECOND_DELAY = 0.5;

let nextPickupId = 1;

export function createPickup(type, x, y){
  return { id: nextPickupId++, type, x, y };
}

export function pickRandomPickup(rng = Math.random){
  return PICKUP_POOL[Math.floor(rng() * PICKUP_POOL.length)];
}

/* Apply a picked-up power-up to the player.  `slowOthers` is a callback the
   engine provides so the slow power-up can reach into other players' state
   without coupling pickups.js to the engine. */
export function applyPickup(player, type, ctx){
  switch(type){
    case 'bomb':
      player.bombMax = Math.min(MAX_BOMBS, player.bombMax + 1);
      break;
    case 'fire':
      player.range = Math.min(MAX_RANGE, player.range + 1);
      break;
    case 'speed':
      player.speed = Math.min(MAX_SPEED, player.speed + 0.5);
      break;
    case 'remote':
      player.hasRemote = true;
      break;
    case 'shield':
      player.shieldStacks = (player.shieldStacks || 0) + 1;
      break;
    case 'super':
      player.hasSuper = true;
      break;
    case 'ghost':
      player.ghostUntil = ctx.elapsed + GHOST_DURATION;
      break;
    case 'slow':
      ctx.slowOthers(player, SLOW_DURATION);
      break;
    case 'kick':
      player.hasKick = true;
      break;
    case 'magnet':
      player.hasMagnet = true;
      break;
    /* Curse — Skull, the rotten one.  Slows the player who picks it up. */
    case 'curse':
      player.slowUntil = Math.max(player.slowUntil || 0, ctx.elapsed + CURSE_DURATION);
      break;
    /* Boomerang — primes the next placed bomb to fire in two waves: a tiny
       blast on the fuse, then a full-range blast 0.5 s later. */
    case 'boomerang':
      player.hasBoomerang = true;
      break;
  }
  /* Maintain a list of all collected types for the HUD display. */
  if(!player.collected) player.collected = [];
  player.collected.push(type);
}
