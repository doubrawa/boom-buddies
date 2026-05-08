/* Bombs and explosions.
   - A bomb sits on an integer tile, ticks down a fuse, then detonates.
   - Detonation produces an explosion: a center segment plus four arms, each
     stopping at the first pillar OR the first box (which is destroyed).
   - Bombs caught in another bomb's explosion detonate immediately (chain). */

import { TILE } from './field.js';

export const FUSE_SECONDS = 3.0;
export const HOT_THRESHOLD = 1.0;     // last second pulses hot
export const EXPLOSION_TTL = 0.45;    // visible flash duration

let nextBombId = 1;

export function createBomb({ ownerIdx, x, y, range }){
  return {
    id: nextBombId++,
    ownerIdx,
    x, y,
    range,
    fuse: FUSE_SECONDS,
    detonating: false,
  };
}

/* Returns the list of tiles affected by an explosion centered at (cx, cy).
   Each entry: { x, y, kind } where kind ∈ 'center' | 'arm-h' | 'arm-v'.
   Pillars block; boxes are included as the last segment of an arm and stop
   further propagation in that direction. */
export function computeExplosionSegments(field, cx, cy, range){
  const segs = [{ x: cx, y: cy, kind: 'center' }];
  const dirs = [
    [ 1,  0, 'arm-h'],
    [-1,  0, 'arm-h'],
    [ 0,  1, 'arm-v'],
    [ 0, -1, 'arm-v'],
  ];
  for(const [dx, dy, kind] of dirs){
    for(let i = 1; i <= range; i++){
      const nx = cx + dx * i;
      const ny = cy + dy * i;
      const t = field.at(nx, ny);
      if(t === TILE.PILLAR) break;
      segs.push({ x: nx, y: ny, kind });
      if(t === TILE.BOX) break;
    }
  }
  return segs;
}

/* AABB overlap between a player at (cx, cy) tile-coords with HALF extents,
   and an integer tile at (tx, ty). */
export function playerOnTile(p, tx, ty, half = 0.40){
  return p.x + half > tx && p.x - half < tx + 1 &&
         p.y + half > ty && p.y - half < ty + 1;
}
