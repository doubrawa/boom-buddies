/* Player entity: position is in TILE coordinates as floats.
   The hitbox is a centered AABB smaller than a tile so players can squeeze
   between corners when aligned, just like classic Bomberman.

   Movement:
   - Direction comes from the input system as (dx, dy) each in {-1,0,1}.
   - We try the X axis and the Y axis separately, snapping back when blocked.
     This produces natural wall-sliding without diagonal cheats.
   - When only one axis is pressed, we softly nudge the player toward the
     center of the perpendicular axis, so they don't get stuck on corners. */

import { TILE } from './field.js';

const HALF = 0.40;          // hitbox half-extent in tiles
/* Corner-cut: when the player is pressing one axis and gets blocked because
   their perpendicular position is slightly off-center, nudge toward the tile
   center on that perpendicular axis.  This rate is in tiles/sec and only
   applies during an active blocked move — never at rest. */
const CORNER_NUDGE_RATE = 5.0;

export function createPlayer(slot, schemeId, charId, controllerType, displayName){
  return {
    idx: slot.idx,
    charId,
    name: displayName,
    scheme: schemeId,
    type: controllerType,
    x: slot.x + 0.5,
    y: slot.y + 0.5,
    speed: 4.5,
    facing: 'down',
    alive: true,
    bombMax: 1,
    bombsLive: 0,
    range: 2,
    hp: 3,
    maxHp: 3,
    invulnerableUntil: 0,        // engine-elapsed seconds; while > elapsed, immune to bomb damage
    /* Bombs the player overlaps and may step off of. */
    passthrough: new Set(),
    /* Power-up state. */
    hasRemote:    false,
    hasSuper:     false,         // primed: next placed bomb is super
    hasKick:      false,
    hasGlove:     false,
    hasIce:       false,
    hasMagnet:    false,
    shieldStacks: 0,
    ghostUntil:   0,             // engine-elapsed seconds
    slowUntil:    0,
    collected:    [],            // types collected this round, for HUD
  };
}

/* Move one player by dt seconds along (dx,dy).  `elapsed` is the engine
   round-elapsed clock (used for timed effects like ghost / slow). */
export function stepPlayer(p, dx, dy, dt, field, solidBombTiles, elapsed){
  if(!p.alive) return;

  /* normalise so diagonals aren't faster */
  if(dx !== 0 || dy !== 0){
    const m = Math.hypot(dx, dy) || 1;
    dx /= m; dy /= m;
  }

  /* facing — pick whichever axis is dominant */
  if(Math.abs(dx) > Math.abs(dy)){
    p.facing = dx < 0 ? 'left' : 'right';
  } else if(dy !== 0){
    p.facing = dy < 0 ? 'up' : 'down';
  }

  /* Effective speed: half-speed while slowed. */
  const slowed = elapsed != null && elapsed < p.slowUntil;
  const speed = slowed ? p.speed * 0.5 : p.speed;
  /* While ghosted: walls and boxes don't block.  Bombs still block (you can
     glide through walls but not through your own ticking explosives). */
  const ghosting = elapsed != null && elapsed < p.ghostUntil;

  if(dx !== 0){
    const nx = p.x + dx * speed * dt;
    if(canFit(field, nx, p.y, solidBombTiles, ghosting)){
      p.x = nx;
    } else if(dy === 0){
      /* Corner-cut on Y: if blocked moving along X with no Y input, try a
         small nudge toward the nearest Y tile center.  Often that's all that
         was preventing the move (one corner of the AABB clipping a wall). */
      const cy = Math.floor(p.y) + 0.5;
      const off = cy - p.y;
      if(Math.abs(off) > 0.02){
        const nudge = Math.sign(off) * Math.min(CORNER_NUDGE_RATE * dt, Math.abs(off));
        if(canFit(field, nx, p.y + nudge, solidBombTiles, ghosting)){
          p.y += nudge;
          p.x = nx;
        }
      }
    }
  }

  if(dy !== 0){
    const ny = p.y + dy * speed * dt;
    if(canFit(field, p.x, ny, solidBombTiles, ghosting)){
      p.y = ny;
    } else if(dx === 0){
      const cx = Math.floor(p.x) + 0.5;
      const off = cx - p.x;
      if(Math.abs(off) > 0.02){
        const nudge = Math.sign(off) * Math.min(CORNER_NUDGE_RATE * dt, Math.abs(off));
        if(canFit(field, p.x + nudge, ny, solidBombTiles, ghosting)){
          p.x += nudge;
          p.y = ny;
        }
      }
    }
  }
}

/* True iff a HALF-sized AABB centered at (cx,cy) sits on walkable tiles only.
   `solidBombTiles` is an optional Set of "x,y" keys that should be treated
   as blocking (bombs the player is not allowed to walk through).
   When `ghosting` is true, walls and boxes don't block. */
function canFit(field, cx, cy, solidBombTiles, ghosting){
  const x0 = Math.floor(cx - HALF);
  const x1 = Math.floor(cx + HALF);
  const y0 = Math.floor(cy - HALF);
  const y1 = Math.floor(cy + HALF);
  for(let y = y0; y <= y1; y++){
    for(let x = x0; x <= x1; x++){
      /* World boundary always blocks, even while ghosting. */
      if(x < 0 || y < 0 || x >= field.width || y >= field.height) return false;
      if(!ghosting && field.at(x, y) !== TILE.FLOOR) return false;
      if(solidBombTiles && solidBombTiles.has(x + ',' + y)) return false;
    }
  }
  return true;
}

/* Tiles whose AABB the player currently overlaps. */
export function tilesUnderPlayer(p){
  const x0 = Math.floor(p.x - HALF);
  const x1 = Math.floor(p.x + HALF);
  const y0 = Math.floor(p.y - HALF);
  const y1 = Math.floor(p.y + HALF);
  const out = [];
  for(let y = y0; y <= y1; y++)
    for(let x = x0; x <= x1; x++)
      out.push([x, y]);
  return out;
}

