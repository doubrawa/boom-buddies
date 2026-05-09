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

function canEscapeAfterBomb(engineView, player, tx, ty){
  const fakeBomb = makeFakeBomb(tx, ty, player.range);
  const allBombs = [...engineView.bombs, fakeBomb];
  return findEscape(engineView, player, tx, ty, allBombs) != null;
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

  /* Enemy positions for blast-targeting + chase scoring. */
  const enemies = engineView.players.filter(p => p.idx !== player.idx && p.alive);
  const enemyTileKey = new Set(enemies.map(p => Math.floor(p.x) + ',' + Math.floor(p.y)));

  const visited = new Set();
  const queue = [[myTx, myTy, 0]];
  visited.add(myTx + ',' + myTy);

  const candidates = [];   // { type, target, plannedBomb, score }

  while(queue.length){
    const [x, y, dist] = queue.shift();
    if(dist > BFS_LIMIT) continue;

    /* Pickup at this tile? */
    const pu = engineView.pickups.find(pp => pp.x === x && pp.y === y);
    if(pu && dist > 0){
      const value = PICKUP_VALUE[pu.type] ?? 30;
      if(value > 0){
        candidates.push({ type:'pickup', target:{tx:x, ty:y, dist}, plannedBomb:null, score: value - dist*4 });
      }
      /* Negative-value pickups (curse) don't get added; we don't path to them. */
    }

    /* Bomb spot at this tile?  Score by what the blast would actually hit. */
    if(canPlace && dist >= 0 && canEscapeAfterBomb(engineView, player, x, y)){
      const segs = computeExplosionSegments(engineView.field, x, y, player.range);
      let crates = 0, enemyHits = 0;
      for(const s of segs){
        if(engineView.field.at(s.x, s.y) === TILE.BOX) crates++;
        if(enemyTileKey.has(s.x + ',' + s.y)) enemyHits++;
      }
      if(crates > 0 || enemyHits > 0){
        const score = crates * 22 + enemyHits * (isMean ? 205 : 180) - dist * 5;
        candidates.push({ type:'attack', target:{tx:x, ty:y, dist}, plannedBomb:{tx:x, ty:y}, score });
      }
    }

    /* Mean CPU chase: stand next to (not on) an enemy if reachable. */
    if(isMean && dist > 0 && dist <= 8){
      let nearEnemy = false;
      for(const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        if(enemyTileKey.has((x+dx) + ',' + (y+dy))){ nearEnemy = true; break; }
      }
      if(nearEnemy){
        candidates.push({ type:'chase', target:{tx:x, ty:y, dist}, plannedBomb:null, score: 120 - dist*8 });
      }
    }

    /* Tiny fallback wander score so the AI never returns null when there's
       at least one reachable neighbour. */
    if(dist === 1){
      candidates.push({ type:'wander', target:{tx:x, ty:y, dist}, plannedBomb:null, score: 12 - dist });
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

  if(candidates.length === 0) return { target: null, plannedBomb: null };

  /* Pick highest score.  Stable tiebreak by type priority then distance. */
  candidates.sort((a, b) => {
    if(b.score !== a.score) return b.score - a.score;
    return (a.target.dist ?? 0) - (b.target.dist ?? 0);
  });
  const best = candidates[0];
  return { target: best.target, plannedBomb: best.plannedBomb };
}
