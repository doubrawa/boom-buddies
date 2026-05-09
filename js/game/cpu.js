/* CPU controller — drives a player with the same {dx,dy,bomb} shape that
   the keyboard input system produces.

   Strategy in priority order:
   1. If the tile we're standing on is in any near-future explosion path,
      BFS to the nearest tile that will be safe by the time we reach it.
   2. If we just arrived at a tile we'd marked for bomb-placement, place
      the bomb (only if we can confirm a safe escape route exists).
   3. Otherwise periodically replan: closest pickup, then closest tile
      adjacent to a crate (= "attack spot"), else wander.
   4. Move cardinally toward whatever target we're committed to.

   The CPU re-evaluates danger every tick but only re-plans goals at most
   every REPLAN_INTERVAL seconds — that keeps movement smooth and bomb
   timing decisive instead of jittery. */

import { TILE } from './field.js';
import { computeExplosionSegments, FUSE_SECONDS } from './bombs.js';

const REPLAN_INTERVAL = 0.4;        // seconds between full goal re-plans
const ARRIVE_EPSILON  = 0.18;       // tiles — close enough to be "on" a tile center
const SAFETY_BUFFER   = 0.5;        // seconds of slack we want before any nearby boom
const BFS_LIMIT       = 12;         // BFS hop cap (cheap; 4 CPUs * ~12 tiles is nothing)
const BOMB_COOLDOWN_S = 0.6;        // throttle bomb-key presses

export function createCpuController(level = 'nice'){
  let target = null;          // {tx, ty} we're walking toward
  let plannedBomb = null;     // {tx, ty} where we WILL place a bomb on arrival
  let lastPlanTime = -999;
  let bombHoldUntil = -999;

  return {
    decide(player, engineView){
      const elapsed = engineView.elapsed;
      const myTx = Math.floor(player.x);
      const myTy = Math.floor(player.y);

      /* 1. Standing in danger? Drop everything and escape. */
      const here = dangerAt(engineView, myTx, myTy);
      if(here < SAFETY_BUFFER + 0.3){
        const escape = findEscape(engineView, player, myTx, myTy, engineView.bombs);
        if(escape){
          target = escape;
          plannedBomb = null;
        }
      }

      /* 2. Arrived where we wanted to drop a bomb? */
      if(plannedBomb && tileReached(player, plannedBomb)){
        const canBomb = player.bombsLive < player.bombMax
          && elapsed > bombHoldUntil
          && canEscapeAfterBomb(engineView, player, myTx, myTy);
        if(canBomb){
          /* Plant + plan retreat. */
          const fakeBomb = makeFakeBomb(myTx, myTy, player.range);
          const escape = findEscape(engineView, player, myTx, myTy, [...engineView.bombs, fakeBomb]);
          target = escape || target;
          plannedBomb = null;
          bombHoldUntil = elapsed + BOMB_COOLDOWN_S;
          return { dx: 0, dy: 0, bomb: true };
        }
        /* Can't safely bomb here — abandon plan. */
        plannedBomb = null;
        target = null;
      }

      /* 3. No live target, or arrived → maybe replan. */
      const arrivedAtTarget = !target || tileReached(player, target);
      if(arrivedAtTarget && elapsed - lastPlanTime > REPLAN_INTERVAL){
        lastPlanTime = elapsed;
        const plan = planNext(engineView, player, level, myTx, myTy);
        target = plan.target;
        plannedBomb = plan.plannedBomb;
      }

      /* 4. Walk one cardinal step toward target. */
      if(target){
        const cx = target.tx + 0.5, cy = target.ty + 0.5;
        const dxr = cx - player.x;
        const dyr = cy - player.y;
        let dx = 0, dy = 0;
        /* Whichever axis has the bigger gap wins this frame.  This naturally
           produces L-shaped paths and prevents corner micro-jitter. */
        if(Math.abs(dxr) > Math.abs(dyr) + 0.02){
          if(Math.abs(dxr) > 0.05) dx = dxr > 0 ? 1 : -1;
        } else {
          if(Math.abs(dyr) > 0.05) dy = dyr > 0 ? 1 : -1;
        }
        return { dx, dy, bomb: false };
      }

      return { dx: 0, dy: 0, bomb: false };
    },
  };
}

/* ====================================================
   Helpers
   ==================================================== */

function tileReached(player, tile){
  return Math.abs(player.x - (tile.tx + 0.5)) < ARRIVE_EPSILON
      && Math.abs(player.y - (tile.ty + 0.5)) < ARRIVE_EPSILON;
}

function makeFakeBomb(tx, ty, range){
  return { id: -1, x: tx, y: ty, range, fuse: FUSE_SECONDS, detonating: false, ownerIdx: -1 };
}

/* Time until any active bomb's blast hits (tx,ty). +Infinity if safe. */
function dangerAt(engineView, tx, ty){
  let minTime = Infinity;
  for(const b of engineView.bombs){
    const fuse = b.detonating ? 0 : b.fuse;
    const segs = computeExplosionSegments(engineView.field, b.x, b.y, b.range);
    for(const s of segs){
      if(s.x === tx && s.y === ty){
        if(fuse < minTime) minTime = fuse;
      }
    }
  }
  return minTime;
}

function bombAt(engineView, tx, ty){
  return engineView.bombs.find(b => b.x === tx && b.y === ty);
}

/* Can the player walk through (tx,ty)? Walls/boxes block, bombs block unless
   the player is currently passing through that bomb. */
function isPassable(engineView, player, tx, ty){
  if(tx < 0 || ty < 0 || tx >= engineView.field.width || ty >= engineView.field.height) return false;
  if(engineView.field.at(tx, ty) !== TILE.FLOOR) return false;
  const b = bombAt(engineView, tx, ty);
  if(b && !player.passthrough.has(b.id)) return false;
  return true;
}

/* BFS from (fromTx,fromTy) for the nearest tile that is safe by the time we'd
   arrive there.  `bombs` lets the caller include hypothetical bombs (for
   "would I survive after planting?" checks).  Returns {tx,ty} or null. */
function findEscape(engineView, player, fromTx, fromTy, bombs){
  const visited = new Set();
  const queue = [[fromTx, fromTy, 0]];
  visited.add(fromTx + ',' + fromTy);
  const speed = Math.max(player.speed, 1);

  while(queue.length){
    const [x, y, dist] = queue.shift();
    if(dist > BFS_LIMIT) continue;

    /* dangerAt computed against the supplied bomb list. */
    let minTime = Infinity;
    for(const b of bombs){
      const fuse = b.detonating ? 0 : b.fuse;
      const segs = computeExplosionSegments(engineView.field, b.x, b.y, b.range);
      for(const s of segs){
        if(s.x === x && s.y === y && fuse < minTime) minTime = fuse;
      }
    }
    const arriveTime = dist / speed;
    if(minTime === Infinity || minTime > arriveTime + SAFETY_BUFFER){
      if(dist > 0) return { tx: x, ty: y };
    }

    for(const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx = x + dx, ny = y + dy;
      const key = nx + ',' + ny;
      if(visited.has(key)) continue;
      visited.add(key);
      if(!isPassable(engineView, player, nx, ny)) continue;
      queue.push([nx, ny, dist + 1]);
    }
  }
  return null;
}

function canEscapeAfterBomb(engineView, player, tx, ty){
  const fakeBomb = makeFakeBomb(tx, ty, player.range);
  const allBombs = [...engineView.bombs, fakeBomb];
  return findEscape(engineView, player, tx, ty, allBombs) != null;
}

/* Pick the next goal.  Order:
     - Nearest visible pickup   → walk there
     - Nearest tile adjacent to a crate, with a safe bomb spot → walk + plan bomb
     - "Mean" CPU: nearest enemy player tile if within 6 BFS hops → walk close
     - Random adjacent step (wander) */
function planNext(engineView, player, level, myTx, myTy){
  const visited = new Set();
  const queue = [[myTx, myTy, 0]];
  visited.add(myTx + ',' + myTy);

  let bestPickup = null;
  let bestAttack = null;
  let bestEnemy = null;
  let firstFreeNeighbour = null;

  /* Index enemies by tile for cheap lookup. */
  const enemyTiles = new Set();
  if(level === 'mean'){
    for(const op of engineView.players){
      if(op.idx === player.idx || !op.alive) continue;
      enemyTiles.add(Math.floor(op.x) + ',' + Math.floor(op.y));
    }
  }

  while(queue.length){
    const [x, y, dist] = queue.shift();
    if(dist > BFS_LIMIT) continue;

    const pickup = engineView.pickups.find(p => p.x === x && p.y === y);
    if(pickup && !bestPickup) bestPickup = { tx: x, ty: y, dist };

    if(level === 'mean' && enemyTiles.has(x + ',' + y) && dist > 0 && !bestEnemy){
      bestEnemy = { tx: x, ty: y, dist };
    }

    /* Crate-adjacent? Only count if we'd survive a bomb here. */
    if(!bestAttack && dist > 0){
      let hasCrate = false;
      for(const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        if(engineView.field.at(x + dx, y + dy) === TILE.BOX){ hasCrate = true; break; }
      }
      if(hasCrate && canEscapeAfterBomb(engineView, player, x, y)){
        bestAttack = { tx: x, ty: y, dist };
      }
    }

    if(!firstFreeNeighbour && dist === 1) firstFreeNeighbour = { tx: x, ty: y };

    for(const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx = x + dx, ny = y + dy;
      const key = nx + ',' + ny;
      if(visited.has(key)) continue;
      visited.add(key);
      if(!isPassable(engineView, player, nx, ny)) continue;
      queue.push([nx, ny, dist + 1]);
    }
  }

  /* Closer of pickup vs enemy beats attack; otherwise attack. */
  const pickupDist = bestPickup?.dist ?? Infinity;
  const enemyDist  = bestEnemy?.dist ?? Infinity;
  if(pickupDist <= 4 && pickupDist <= enemyDist) return { target: bestPickup, plannedBomb: null };
  if(bestEnemy && enemyDist < 6) return { target: bestEnemy, plannedBomb: null };
  if(bestPickup) return { target: bestPickup, plannedBomb: null };
  if(bestAttack) return { target: bestAttack, plannedBomb: { tx: bestAttack.tx, ty: bestAttack.ty } };
  if(firstFreeNeighbour) return { target: firstFreeNeighbour, plannedBomb: null };
  return { target: null, plannedBomb: null };
}
