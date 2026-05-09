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
const SAFETY_BUFFER   = 1.2;        // seconds of slack before any nearby blast — single-hit-kill so margin matters
const BFS_LIMIT       = 14;
const BOMB_COOLDOWN_S = 0.6;

/* Pickup priority weights (per type).  Higher = more eager to grab.
   Curse is negative — actively avoided.  These values are blended with
   distance: score = priority - dist * 4. */
const PICKUP_VALUE = {
  bomb:   90,   // extra carry slot — huge
  fire:   85,   // bigger blast
  shield: 95,   // free life (one-hit-kill rules)
  mend:   95,   // also a free shield stack
  super:  80,   // nuke once
  speed:  70,
  remote: 70,
  ghost:  60,
  kick:   55,
  magnet: 45,
  slow:   40,
  curse: -200,  // run away
};

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

      /* 4. Walk one cardinal step toward target.  Tie-break: drain the larger
         remaining gap first.  Picking strict >= (not strict >) keeps the
         choice stable across ticks and avoids zigzagging. */
      if(target){
        const cx = target.tx + 0.5, cy = target.ty + 0.5;
        const dxr = cx - player.x;
        const dyr = cy - player.y;
        const adx = Math.abs(dxr), ady = Math.abs(dyr);
        let dx = 0, dy = 0;
        if(adx > 0.05 || ady > 0.05){
          if(adx >= ady) dx = Math.sign(dxr);
          else            dy = Math.sign(dyr);
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

/* Stricter than findEscape: needs at least TWO distinct safe destinations so
   a single blocked corridor doesn't trap us.  This makes the AI refuse bomb
   placements that would put it in a one-exit deathtrap. */
function canEscapeAfterBomb(engineView, player, tx, ty){
  const fakeBomb = makeFakeBomb(tx, ty, player.range);
  const allBombs = [...engineView.bombs, fakeBomb];
  return countSafeEscapes(engineView, player, tx, ty, allBombs, 2) >= 2;
}

function countSafeEscapes(engineView, player, fromTx, fromTy, bombs, needAtLeast){
  const visited = new Set();
  const queue = [[fromTx, fromTy, 0]];
  visited.add(fromTx + ',' + fromTy);
  const speed = Math.max(player.speed, 1);
  let found = 0;
  while(queue.length){
    const [x, y, dist] = queue.shift();
    if(dist > BFS_LIMIT) continue;
    let minTime = Infinity;
    for(const b of bombs){
      const fuse = b.detonating ? 0 : b.fuse;
      const segs = computeExplosionSegments(engineView.field, b.x, b.y, b.range);
      for(const s of segs){
        if(s.x === x && s.y === y && fuse < minTime) minTime = fuse;
      }
    }
    const arriveTime = dist / speed;
    if(dist > 0 && (minTime === Infinity || minTime > arriveTime + SAFETY_BUFFER)){
      found++;
      if(found >= needAtLeast) return found;
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
  return found;
}

/* Pick the next goal by scoring every reachable candidate within the BFS
   horizon and returning the highest score.  Scoring rules:

     pickup at (x,y)          :  PICKUP_VALUE[type] - dist*4
     bomb spot at (x,y)       :  cratesInBlast*22 + enemiesInBlast*180 - dist*5
                                 (mean CPU: +25 per enemy in blast on top)
     chase enemy (mean only)  :  120 - dist*8     (encourages closing distance
                                                   even with no immediate bomb)
     wander                   :  12 - dist        (a low-score fallback so we
                                                   never freeze)

   Curse pickups end up with negative scores; they're filtered before
   selection so the CPU never targets a debuff. */
function planNext(engineView, player, level, myTx, myTy){
  const canPlace = player.bombsLive < player.bombMax;
  const isMean = level === 'mean';
  const speed = Math.max(player.speed, 1);

  /* Enemy data for blast-targeting + chase scoring. */
  const enemies = engineView.players.filter(p => p.idx !== player.idx && p.alive);
  const enemyTilePos = enemies.map(e => ({ x: Math.floor(e.x), y: Math.floor(e.y) }));
  const enemyTileKey = new Set(enemyTilePos.map(e => e.x + ',' + e.y));

  /* Bake a single bomb-segments map up front so each candidate scoring is
     O(1) lookup instead of recomputing segments per check. */
  const dangerByTile = new Map();   // 'x,y' -> earliest blast time
  for(const b of engineView.bombs){
    const fuse = b.detonating ? 0 : b.fuse;
    const segs = computeExplosionSegments(engineView.field, b.x, b.y, b.range);
    for(const s of segs){
      const k = s.x + ',' + s.y;
      const cur = dangerByTile.get(k);
      if(cur === undefined || fuse < cur) dangerByTile.set(k, fuse);
    }
  }

  /* Will (x,y) still be safe by the time we walk there at full speed? */
  function arrivalSafe(x, y, dist){
    const t = dangerByTile.get(x + ',' + y);
    if(t === undefined) return true;            // not in any blast — safe forever
    const arriveT = dist / speed;
    return t > arriveT + SAFETY_BUFFER;
  }

  const visited = new Set();
  const queue = [[myTx, myTy, 0]];
  visited.add(myTx + ',' + myTy);

  const candidates = [];

  while(queue.length){
    const [x, y, dist] = queue.shift();
    if(dist > BFS_LIMIT) continue;

    const safeHere = arrivalSafe(x, y, dist);

    /* PICKUP: never path to a tile that's about to explode. */
    const pu = engineView.pickups.find(pp => pp.x === x && pp.y === y);
    if(pu && dist > 0 && safeHere){
      const value = PICKUP_VALUE[pu.type] ?? 30;
      if(value > 0){
        candidates.push({ type:'pickup', target:{tx:x, ty:y, dist}, plannedBomb:null, score: value - dist*4 });
      }
    }

    /* ATTACK: count crates + enemies in blast.  Path-clear bonus: crates
       within 4 tiles of any enemy score extra (clearing the way to them). */
    if(canPlace && safeHere && canEscapeAfterBomb(engineView, player, x, y)){
      const segs = computeExplosionSegments(engineView.field, x, y, player.range);
      let crates = 0, cratesNearEnemy = 0, enemyHits = 0;
      for(const s of segs){
        if(engineView.field.at(s.x, s.y) === TILE.BOX){
          crates++;
          for(const e of enemyTilePos){
            if(Math.abs(s.x - e.x) + Math.abs(s.y - e.y) <= 4){ cratesNearEnemy++; break; }
          }
        }
        if(enemyTileKey.has(s.x + ',' + s.y)) enemyHits++;
      }
      if(crates > 0 || enemyHits > 0){
        const score = crates*18 + cratesNearEnemy*15 + enemyHits*(isMean?220:180) - dist*5;
        candidates.push({ type:'attack', target:{tx:x, ty:y, dist}, plannedBomb:{tx:x, ty:y}, score });
      }
    }

    /* CHASE (mean only): stand next to an enemy.  Filter for safety. */
    if(isMean && dist > 0 && dist <= 8 && safeHere){
      let nearEnemy = false;
      for(const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        if(enemyTileKey.has((x+dx) + ',' + (y+dy))){ nearEnemy = true; break; }
      }
      if(nearEnemy){
        candidates.push({ type:'chase', target:{tx:x, ty:y, dist}, plannedBomb:null, score: 120 - dist*8 });
      }
    }

    /* WANDER fallback — every reachable safe tile gets a small score so
       the AI keeps moving when no big goal is available. */
    if(dist > 0 && safeHere){
      candidates.push({ type:'wander', target:{tx:x, ty:y, dist}, plannedBomb:null, score: Math.max(2, 16 - dist*2) });
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

  if(candidates.length === 0){
    /* Truly trapped.  Last-resort: walk to ANY passable neighbour, even if
       that tile is in a blast zone — better to gamble on movement than
       freeze and definitely die. */
    for(const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      if(isPassable(engineView, player, myTx+dx, myTy+dy)){
        return { target: {tx: myTx+dx, ty: myTy+dy, dist: 1}, plannedBomb: null };
      }
    }
    return { target: null, plannedBomb: null };
  }

  candidates.sort((a, b) => {
    if(b.score !== a.score) return b.score - a.score;
    return (a.target.dist ?? 0) - (b.target.dist ?? 0);
  });
  const best = candidates[0];
  return { target: best.target, plannedBomb: best.plannedBomb };
}
