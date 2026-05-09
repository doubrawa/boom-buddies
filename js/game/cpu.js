/* CPU controller — full rewrite.

   Per-tick decision tree, in strict priority order.  The whole algorithm
   rests on two primitives:

     dangerMap    : tile -> earliest blast time at that tile (Infinity = safe)
     bfsSafe      : reachability map from my tile, where every step satisfies
                    `arrivalTime + SAFETY_MARGIN < blastTime` so the CPU never
                    walks into a tile that'll explode under its feet.

   With those, every decision becomes "pick the best safe destination":

     P1  My current tile is in a blast that fires soon → flee.
     P2  I'm standing on a planned bomb spot and can survive → plant + flee.
     P3  Reached a non-bomb goal → drop it, replan.
     P4  Time to replan? → score every reachable safe tile, pick best.
     P5  Walk one BFS step toward the goal (the path is rebuilt every tick,
         so it adapts to new bombs as they appear).
     P6  No goal → safely wander; never freeze. */

import { TILE } from './field.js';
import { computeExplosionSegments, FUSE_SECONDS } from './bombs.js';

const REPLAN_INTERVAL = 0.2;     // seconds between full goal re-plans
const SAFETY_MARGIN   = 1.0;     // seconds slack between arrival and blast
const BOMB_COOLDOWN   = 0.4;     // seconds — minimum gap between plants
const BFS_LIMIT       = 20;      // BFS depth cap
const ARRIVE_EPS      = 0.18;    // tile-centre tolerance for "arrived"
/* P1 flee fires when my tile will explode within this window.  Set above
   FUSE_SECONDS so the CPU starts running the moment ANY bomb's blast covers
   its tile, rather than waiting for the fuse to burn down. */
const FLEE_THRESHOLD  = 4.0;

const CARDINALS = [[1,0],[-1,0],[0,1],[0,-1]];

/* Pickup priority weights.  Curse is heavily negative so the CPU avoids it.
   Score = value - dist*4 in planGoal. */
const PICKUP_VALUE = {
  bomb:   90, fire:   85, shield: 95, super:  80,
  speed:  70, remote: 70, ghost:  60, kick:   55,
  magnet: 45, slow:   40, boomerang: 75, curse: -200,
};

export function createCpuController(level = 'nice'){
  const isMean = level === 'mean';
  let goal = null;          // { tx, ty, action: 'walk' | 'bomb' }
  let lastPlanAt = -999;
  let nextBombAt = -999;

  return {
    decide(me, view){
      const t = view.elapsed;
      const myTx = Math.floor(me.x);
      const myTy = Math.floor(me.y);
      const danger = buildDangerMap(view);

      /* ---- P1 — flee if my current tile is in any active blast.  We use a
         generous threshold (FLEE_THRESHOLD) so the CPU starts moving away
         from its own freshly-placed bomb immediately, not 2 seconds later
         when it's already too late.  Pickups/attacks have to wait. ---- */
      const myBlastT = danger.get(myTx + ',' + myTy);
      if(myBlastT !== undefined && myBlastT < FLEE_THRESHOLD){
        const escape = findFleePath(view, me, danger);
        if(escape && escape.firstStep) return walkToward(me, escape.firstStep);
        return anyPassableNeighbor(view, me, myTx, myTy) || idle();
      }

      /* ---- P2 — sitting on a bomb-plan tile? Plant if it's still safe. ---- */
      if(goal && goal.action === 'bomb' && tileReached(me, goal)){
        if(t > nextBombAt
           && me.bombsLive < me.bombMax
           && canSafelyBomb(view, me, myTx, myTy, danger)){
          nextBombAt = t + BOMB_COOLDOWN;
          goal = null;   // next tick will plan a flee path automatically
          return { dx: 0, dy: 0, bomb: true };
        }
        /* Conditions changed since planning — drop it and replan. */
        goal = null;
      }

      /* ---- P3 — non-bomb goal already reached → forget it. ---- */
      if(goal && goal.action !== 'bomb' && tileReached(me, goal)) goal = null;

      /* ---- P4 — replan goal if we're due. ---- */
      if(!goal || t - lastPlanAt > REPLAN_INTERVAL){
        lastPlanAt = t;
        const fresh = planGoal(view, me, danger, isMean);
        if(fresh) goal = fresh;
      }

      /* ---- P5 — walk along the BFS-safe path toward the goal. ---- */
      if(goal){
        /* Already on the goal tile but not yet centred: walk toward centre so
           tileReached fires.  Without this the CPU enters the tile, BFS
           returns dist=0 (no firstStep), the goal is dropped, and the CPU
           drifts away without ever reaching the bomb-plant moment. */
        if(myTx === goal.tx && myTy === goal.ty){
          return walkToward(me, [myTx, myTy]);
        }
        const path = pathFindSafe(view, me, danger, goal.tx, goal.ty);
        if(path && path.firstStep) return walkToward(me, path.firstStep);
        /* Goal isn't reachable safely right now — drop it. */
        goal = null;
      }

      /* ---- P6 — no goal: pick a safe step in some direction. ---- */
      return pickSafeWander(view, me, danger)
          || anyPassableNeighbor(view, me, myTx, myTy)
          || idle();
    },
  };
}

/* ====================================================
   Pure helpers — operate on the engine view.
   ==================================================== */

function idle(){ return { dx: 0, dy: 0, bomb: false }; }

/* For each tile in any active bomb's blast: earliest fuse time across all
   bombs whose blast covers that tile.  Tiles not in this map are safe. */
function buildDangerMap(view){
  const map = new Map();
  for(const b of view.bombs){
    const fuse = b.detonating ? 0 : Math.max(0, b.fuse);
    const segs = computeExplosionSegments(view.field, b.x, b.y, b.range);
    for(const s of segs){
      const k = s.x + ',' + s.y;
      const cur = map.get(k);
      if(cur === undefined || fuse < cur) map.set(k, fuse);
    }
  }
  return map;
}

function isPassable(view, me, tx, ty){
  const f = view.field;
  if(tx < 0 || ty < 0 || tx >= f.width || ty >= f.height) return false;
  if(f.at(tx, ty) !== TILE.FLOOR) return false;
  for(const b of view.bombs){
    if(b.x === tx && b.y === ty && !me.passthrough.has(b.id)) return false;
  }
  return true;
}

/* BFS from `me`'s current tile.  A tile gets visited only if the CPU can step
   onto it AT a time when it isn't (yet) in a blast (arrival + SAFETY_MARGIN
   strictly earlier than the tile's blast time).  Returns Map: 'x,y' ->
   { dist, firstStep: [x,y] | null }.  firstStep is the immediate cardinal
   move from `me`'s tile that leads onto the path to this tile. */
function bfsSafe(view, me, danger){
  const speed = Math.max(me.speed, 1);
  const myTx = Math.floor(me.x);
  const myTy = Math.floor(me.y);
  const visited = new Map();
  visited.set(myTx + ',' + myTy, { dist: 0, firstStep: null });
  const queue = [[myTx, myTy, 0]];
  while(queue.length){
    const [x, y, dist] = queue.shift();
    if(dist > BFS_LIMIT) continue;
    const here = visited.get(x + ',' + y);
    for(const [dx, dy] of CARDINALS){
      const nx = x + dx, ny = y + dy;
      const k = nx + ',' + ny;
      if(visited.has(k)) continue;
      if(!isPassable(view, me, nx, ny)) continue;
      const arriveT = (dist + 1) / speed;
      const blastT = danger.get(k);
      if(blastT !== undefined && blastT < arriveT + SAFETY_MARGIN) continue;
      const firstStep = here.firstStep || [nx, ny];
      visited.set(k, { dist: dist + 1, firstStep });
      queue.push([nx, ny, dist + 1]);
    }
  }
  return visited;
}

function pathFindSafe(view, me, danger, targetTx, targetTy){
  const reach = bfsSafe(view, me, danger);
  return reach.get(targetTx + ',' + targetTy) || null;
}

/* Closest tile that's not in any active blast — the place to wait it out. */
function findFleePath(view, me, danger){
  const reach = bfsSafe(view, me, danger);
  let best = null;
  for(const [k, r] of reach){
    if(r.dist === 0) continue;
    if(danger.has(k)) continue;       // still inside a blast — keep looking
    if(!best || r.dist < best.dist){
      const [x, y] = k.split(',').map(Number);
      best = { tx: x, ty: y, dist: r.dist, firstStep: r.firstStep };
    }
  }
  return best;
}

/* Could I plant a bomb at (tx,ty) and still find ≥2 distinct safe escape
   tiles before the new bomb's fuse expires?  Two escapes prevents a single
   blocked corridor from turning the placement into a deathtrap. */
function canSafelyBomb(view, me, tx, ty, baseDanger){
  if(me.bombsLive >= me.bombMax) return false;
  const post = new Map(baseDanger);
  const segs = computeExplosionSegments(view.field, tx, ty, me.range);
  for(const s of segs){
    const k = s.x + ',' + s.y;
    const cur = post.get(k);
    if(cur === undefined || FUSE_SECONDS < cur) post.set(k, FUSE_SECONDS);
  }
  return countSafeEscapes(view, me, tx, ty, post, 2) >= 2;
}

/* BFS from (fromTx,fromTy) under the supplied danger map; returns count of
   distinct tiles that aren't in any blast at all (early-exit when ≥needed). */
function countSafeEscapes(view, me, fromTx, fromTy, danger, needed){
  const speed = Math.max(me.speed, 1);
  const queue = [[fromTx, fromTy, 0]];
  const visited = new Set([fromTx + ',' + fromTy]);
  let count = 0;
  while(queue.length){
    const [x, y, dist] = queue.shift();
    if(dist > BFS_LIMIT) continue;
    if(dist > 0 && !danger.has(x + ',' + y)){
      count++;
      if(count >= needed) return count;
    }
    for(const [dx, dy] of CARDINALS){
      const nx = x + dx, ny = y + dy;
      const k = nx + ',' + ny;
      if(visited.has(k)) continue;
      visited.add(k);
      if(!isPassable(view, me, nx, ny)) continue;
      const arriveT = (dist + 1) / speed;
      const blastT = danger.get(k);
      if(blastT !== undefined && blastT < arriveT + SAFETY_MARGIN) continue;
      queue.push([nx, ny, dist + 1]);
    }
  }
  return count;
}

/* Score every reachable safe tile.  Categories:

     pickup       value - dist*4         (skip negative-value pickups)
     bomb-attack  crates*18
                  + cratesNearEnemy*10   (path-clear bonus)
                  + enemyHits*180-240    (mean variant amps this)
                  - dist*5
     pursue       (mean) tiles 2-5 from an enemy get a chase bonus
     explore      tiny floor score so the CPU never freezes

   Highest score wins.  Ties break by lower distance via stable sort. */
function planGoal(view, me, danger, isMean){
  const reach = bfsSafe(view, me, danger);
  const enemies = view.players.filter(p => p.idx !== me.idx && p.alive);
  const enemyTiles = new Set(enemies.map(e => Math.floor(e.x) + ',' + Math.floor(e.y)));
  const candidates = [];

  for(const [k, r] of reach){
    if(r.dist === 0) continue;
    const [x, y] = k.split(',').map(Number);

    /* Bomb-attack candidates: even tiles in some other bomb's blast can be
       valid spots, because the attack BFS is short-term.  But every other
       goal type (pickup/pursue/explore) is a "stand or pause here" plan, and
       must be on a permanently-safe tile or the CPU will walk into a blast
       and wait for it to fire. */
    const tileSafeToStay = !danger.has(k);

    /* PICKUP — only if the tile won't explode under us. */
    if(tileSafeToStay){
      const pu = view.pickups.find(p => p.x === x && p.y === y);
      if(pu){
        const value = PICKUP_VALUE[pu.type] ?? 30;
        if(value > 0){
          candidates.push({ tx: x, ty: y, action: 'walk', score: value - r.dist * 4 });
        }
      }
    }

    /* BOMB-ATTACK at this tile */
    if(canSafelyBomb(view, me, x, y, danger)){
      const segs = computeExplosionSegments(view.field, x, y, me.range);
      let crates = 0, enemyHits = 0, cratesNearEnemy = 0;
      for(const s of segs){
        if(view.field.at(s.x, s.y) === TILE.BOX){
          crates++;
          for(const e of enemies){
            const ex = Math.floor(e.x), ey = Math.floor(e.y);
            if(Math.abs(s.x - ex) + Math.abs(s.y - ey) <= 4){ cratesNearEnemy++; break; }
          }
        }
        if(enemyTiles.has(s.x + ',' + s.y)) enemyHits++;
      }
      if(crates > 0 || enemyHits > 0){
        const score = crates * 18
                    + cratesNearEnemy * 10
                    + enemyHits * (isMean ? 240 : 180)
                    - r.dist * 5;
        candidates.push({ tx: x, ty: y, action: 'bomb', score });
      }
    }

    /* PURSUE — close, but not adjacent (2-5 tiles); mean only. */
    if(tileSafeToStay && isMean && enemies.length > 0){
      let minToEnemy = Infinity;
      for(const e of enemies){
        const d = Math.abs(x - Math.floor(e.x)) + Math.abs(y - Math.floor(e.y));
        if(d < minToEnemy) minToEnemy = d;
      }
      if(minToEnemy >= 2 && minToEnemy <= 5){
        candidates.push({ tx: x, ty: y, action: 'walk', score: 60 - minToEnemy * 8 - r.dist * 3 });
      }
    }

    /* EXPLORE — tiny score so the CPU keeps moving when no big goal exists.
       Permanently-safe destinations only. */
    if(tileSafeToStay){
      candidates.push({ tx: x, ty: y, action: 'walk', score: Math.max(2, 14 - r.dist * 2) });
    }
  }

  if(candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

function tileReached(me, goal){
  return Math.abs(me.x - (goal.tx + 0.5)) < ARRIVE_EPS
      && Math.abs(me.y - (goal.ty + 0.5)) < ARRIVE_EPS;
}

/* Walk one cardinal step toward an adjacent tile [nx,ny].  Drains the larger
   axis gap first so we don't zigzag near the centre. */
function walkToward(me, nextStep){
  if(!nextStep) return idle();
  const [nx, ny] = nextStep;
  const cx = nx + 0.5, cy = ny + 0.5;
  const dxr = cx - me.x, dyr = cy - me.y;
  const adx = Math.abs(dxr), ady = Math.abs(dyr);
  let dx = 0, dy = 0;
  if(adx > 0.05 || ady > 0.05){
    if(adx >= ady) dx = Math.sign(dxr);
    else            dy = Math.sign(dyr);
  }
  return { dx, dy, bomb: false };
}

/* Random safe neighbour — used as P6 fallback. */
function pickSafeWander(view, me, danger){
  const speed = Math.max(me.speed, 1);
  const myTx = Math.floor(me.x), myTy = Math.floor(me.y);
  const dirs = [...CARDINALS];
  for(let i = dirs.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
  }
  for(const [dx, dy] of dirs){
    const nx = myTx + dx, ny = myTy + dy;
    if(!isPassable(view, me, nx, ny)) continue;
    const arriveT = 1 / speed;
    const blastT = danger.get(nx + ',' + ny);
    if(blastT === undefined || blastT > arriveT + SAFETY_MARGIN){
      return { dx, dy, bomb: false };
    }
  }
  return null;
}

/* Last-resort movement: any passable neighbour, even into a blast.  Better
   to gamble on movement than freeze and definitely die. */
function anyPassableNeighbor(view, me, myTx, myTy){
  for(const [dx, dy] of CARDINALS){
    if(isPassable(view, me, myTx + dx, myTy + dy)){
      return { dx, dy, bomb: false };
    }
  }
  return null;
}
