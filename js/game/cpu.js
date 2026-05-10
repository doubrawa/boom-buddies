/* CPU controller — clean rewrite per user spec.
 *
 *   Priority of goals (the CPU tries each in turn):
 *     1. ATTACK  — drop a bomb where its blast hits an enemy
 *     2. CLEAR   — drop a bomb that destroys crates (preferring crates near
 *                  enemies, so we open paths toward them)
 *     3. PICKUP  — walk to the nearest reachable power-up
 *
 *   For the chosen goal we build a complete ROUTE: walk steps to reach the
 *   target tile, the bomb-plant step (if applicable), then walk steps to a
 *   verified safe escape tile.  The CPU then executes the route step by step
 *   and DOES NOT reconsider its goal mid-route — once the goal is chosen, we
 *   commit.  Replanning happens only when the route is fully done (or in the
 *   one survival-reflex case below).
 *
 *   The single exception is a survival reflex: if the CPU's CURRENT tile is
 *   about to explode in < 1.5 s and the route's next step doesn't escape it,
 *   we abandon the route and walk the closest safe step.  This is a reflex,
 *   not goal weighing.
 *
 *   Routes that include a bomb-plant always have the escape pre-computed at
 *   plan time, so under a single CPU's bomb the escape is guaranteed safe.
 *   Other CPUs placing bombs on our path is the inherent risk of "no
 *   midway re-evaluation".
 */

import { TILE } from './field.js';
import { computeExplosionSegments, FUSE_SECONDS } from './bombs.js';

const CARDINALS = [[1,0],[-1,0],[0,1],[0,-1]];
const ARRIVE_EPS = 0.18;
const BFS_LIMIT = 24;
const ESCAPE_MARGIN = 1.2;          // arrival + this < blast time
/* Threshold above the max fuse (3 s) so we react to ANY bomb covering our
   tile, even one just placed.  This is the only mid-route override; without
   it the CPU walks committed escape paths that another CPU's bomb has cut. */
const SURVIVAL_THRESHOLD = 4.0;
const STUCK_TICKS_MAX = 30;         // can't move for this many ticks → abandon

const PICKUP_VALUE = {
  bomb: 100, fire: 100, shield: 80, super: 80, speed: 70,
  remote: 70, ghost: 60, kick: 60, magnet: 50, slow: 40,
  boomerang: 70, curse: -1,
};

export function createCpuController(level = 'nice'){
  let route = null;     // { kind: 'attack'|'clear'|'pickup', steps: [{x,y,kind: 'walk'|'bomb'}] }
  let stepIdx = 0;
  let stuckTicks = 0;
  let lastPos = null;
  /* Random startup delay (0-1.5 s) prevents 6 CPUs from all dropping their
     first bomb on the same tick.  Synchronised early bombs make the field
     unplannable: every CPU's escape route gets cut by a neighbour's bomb. */
  const startupDelay = Math.random() * 1.5;

  return {
    decide(me, view){
      const myTx = Math.floor(me.x);
      const myTy = Math.floor(me.y);
      const danger = buildDangerMap(view);

      /* ── SURVIVAL REFLEX ──────────────────────────────────────────────
         Only kicks in when the route can't save us in time — either we have
         no route, or the route's final destination is itself in a blast.
         A committed escape after our own bomb-plant looks like "I'm in my
         own blast zone but my route ends on a safe tile" — that's NOT a
         survival emergency, just normal route execution. */
      const myBlast = danger.get(myTx + ',' + myTy);
      if(myBlast !== undefined && myBlast < SURVIVAL_THRESHOLD
         && !routeWillSave(route, stepIdx, danger)){
        const flee = findFleeStep(me, view, danger);
        if(flee){
          route = null; stepIdx = 0;
          return walkToward(me, flee);
        }
      }

      /* ── STUCK DETECTION ──────────────────────────────────────────────
         If we haven't moved a meaningful amount for STUCK_TICKS_MAX ticks
         (e.g. another CPU dropped a bomb in our path), drop the route and
         replan. */
      const posKey = me.x.toFixed(1) + ',' + me.y.toFixed(1);
      if(posKey === lastPos) stuckTicks++;
      else { stuckTicks = 0; lastPos = posKey; }
      if(stuckTicks > STUCK_TICKS_MAX){
        route = null; stepIdx = 0; stuckTicks = 0;
      }

      /* ── PLAN ROUTE if we don't have one ────────────────────────────── */
      if(!route || stepIdx >= route.steps.length){
        const allowBomb = view.elapsed >= startupDelay;
        route = planRoute(me, view, danger, allowBomb);
        stepIdx = 0;
        if(!route) return idle();
      }

      /* ── ROUTE INTEGRITY ─────────────────────────────────────────────
         The next tile we'd walk onto must not be about to explode.  If
         another CPU's bomb covers it, abandon the route and replan. */
      if(!nextStepStillSafe(route, stepIdx, danger, me)){
        route = null; stepIdx = 0;
        return idle();
      }

      /* ── EXECUTE current step ───────────────────────────────────────── */
      const step = route.steps[stepIdx];

      if(step.kind === 'bomb'){
        /* Plant when fully centred on the bomb tile. */
        if(myTx === step.x && myTy === step.y && tileReached(me, step)){
          if(me.bombsLive < me.bombMax){
            stepIdx++;
            return { dx: 0, dy: 0, bomb: true };
          }
          /* Capacity full — wait one tick. */
          return idle();
        }
        return walkToward(me, step);
      }

      /* Walk step.  EVERY step must be fully centred on before advancing,
         so the CPU walks to the centre of each tile before turning.
         Otherwise it changes axis mid-tile and the body extent straddles
         perpendicular tiles around corners — that's the "hanging at
         corners" feel.  Centring at every step costs a couple of extra
         ticks per turn but keeps movement clean and predictable. */
      if(myTx === step.x && myTy === step.y){
        if(!tileReached(me, step)) return walkToward(me, step);
        stepIdx++;
        if(stepIdx >= route.steps.length) return idle();
        return walkToward(me, route.steps[stepIdx]);
      }
      return walkToward(me, step);
    },
    _debug(){ return { route, stepIdx }; },
  };
}

/* ====================================================
   Route planning — try each priority in order.
   ==================================================== */

function planRoute(me, view, danger, allowBomb = true){
  /* BFS reachability — every path tile must be currently passable AND
     safe-on-arrival under the current danger map. */
  const reach = bfsSafe(me, view, danger);

  /* New priority order, per user spec:
       1. Free path to enemy   →  ATTACK (if a bombing position works) or
                                  PURSUE (walk closer); requires the enemy
                                  tile to be reachable.
       2. Free path to pickup  →  PICKUP
       3. Clear-bomb           →  pick the spot that hits the MOST crates
       4. Explore              →  fallback so we never idle. */
  const enemyGoal = planEnemyGoal(me, view, reach, allowBomb);
  if(enemyGoal) return enemyGoal;

  const pickup = planPickup(me, view, reach);
  if(pickup) return pickup;

  if(allowBomb){
    const clear = planClear(me, view, danger, reach);
    if(clear) return clear;
  }
  return planExplore(me, view, reach);
}

/* Goal 1: enemy is on a tile we can already reach.  Prefer ATTACK (a bomb
   spot whose blast covers the enemy) when one exists with a verified
   escape.  Otherwise PURSUE — just walk straight at the closest reachable
   enemy and let the next replan re-check for an attack window. */
function planEnemyGoal(me, view, reach, allowBomb){
  const enemies = view.players.filter(p => p.idx !== me.idx && p.alive);
  if(enemies.length === 0) return null;

  const reachableEnemies = enemies.filter(e => {
    const k = Math.floor(e.x) + ',' + Math.floor(e.y);
    return reach.has(k);
  });
  if(reachableEnemies.length === 0) return null;

  /* Try ATTACK first. */
  if(allowBomb && me.bombsLive < me.bombMax){
    const enemyTiles = new Set(reachableEnemies.map(e => Math.floor(e.x) + ',' + Math.floor(e.y)));
    let best = null;
    for(const [k, info] of reach){
      const [x, y] = k.split(',').map(Number);
      const segs = computeExplosionSegments(view.field, x, y, me.range);
      let hits = 0;
      for(const s of segs) if(enemyTiles.has(s.x + ',' + s.y)) hits++;
      if(hits === 0) continue;
      const escape = computeEscape(me, view, x, y, me.range + 2, me.range + 2);
      if(!escape) continue;
      const score = hits * 100 - info.dist;
      if(!best || score > best.score){
        best = { x, y, dist: info.dist, score, escape };
      }
    }
    if(best) return assembleRoute('attack', me, reach, best.x, best.y, true, best.escape);
  }

  /* No good attack window yet — close the gap.  Pick the closest reachable
     enemy and route straight to their tile. */
  let closest = null;
  for(const e of reachableEnemies){
    const ex = Math.floor(e.x), ey = Math.floor(e.y);
    const info = reach.get(ex + ',' + ey);
    if(!closest || info.dist < closest.dist){
      closest = { x: ex, y: ey, dist: info.dist };
    }
  }
  if(!closest || closest.dist === 0) return null;
  return assembleRoute('pursue', me, reach, closest.x, closest.y, false, null);
}

/* Goal 4 (always-on fallback): EXPLORE — pick the farthest reachable safe
   tile and walk there.  Never returns null as long as ANY neighbour is
   reachable. */
function planExplore(me, view, reach){
  const myTx = Math.floor(me.x), myTy = Math.floor(me.y);
  let best = null;
  for(const [k, info] of reach){
    if(info.dist === 0) continue;
    if(!best || info.dist > best.dist){
      const [x, y] = k.split(',').map(Number);
      best = { x, y, dist: info.dist };
    }
  }
  if(!best) return null;
  return assembleRoute('explore', me, reach, best.x, best.y, false, null);
}

/* Goal 3: CLEAR — drop a bomb that destroys crates.  Per user request:
   pick the bomb position that destroys the MOST boxes.  Crate count is
   the primary score; distance only breaks ties. */
function planClear(me, view, danger, reach){
  if(me.bombsLive >= me.bombMax) return null;

  let best = null;
  for(const [k, info] of reach){
    const [x, y] = k.split(',').map(Number);
    const segs = computeExplosionSegments(view.field, x, y, me.range);
    let crates = 0;
    for(const s of segs){
      if(view.field.at(s.x, s.y) === TILE.BOX) crates++;
    }
    if(crates === 0) continue;
    const escape = computeEscape(me, view, x, y, me.range + 2, me.range + 2);
    if(!escape) continue;
    /* Crates × 1000 dominates the score; distance is only a tiebreak. */
    const score = crates * 1000 - info.dist;
    if(!best || score > best.score){
      best = { x, y, dist: info.dist, score, crates, escape };
    }
  }
  if(!best) return null;
  return assembleRoute('clear', me, reach, best.x, best.y, true, best.escape);
}

/* Goal 2: PICKUP — closest reachable pickup, irrespective of type (skipping
   only the negative ones like Curse).  Per user request: among multiple
   candidates, pick the shortest path. */
function planPickup(me, view, reach){
  if(view.pickups.length === 0) return null;
  let best = null;
  for(const pu of view.pickups){
    const info = reach.get(pu.x + ',' + pu.y);
    if(!info) continue;
    const value = PICKUP_VALUE[pu.type] ?? 30;
    if(value <= 0) continue;
    if(!best || info.dist < best.dist){
      best = { x: pu.x, y: pu.y, dist: info.dist };
    }
  }
  if(!best) return null;
  return assembleRoute('pickup', me, reach, best.x, best.y, false, null);
}

function assembleRoute(kind, me, reach, tx, ty, includeBomb, escape){
  const myTx = Math.floor(me.x), myTy = Math.floor(me.y);
  const walkPath = reconstructPath(reach, myTx, myTy, tx, ty) || [];
  const steps = walkPath.map(([x, y]) => ({ x, y, kind: 'walk' }));
  if(includeBomb){
    steps.push({ x: tx, y: ty, kind: 'bomb' });
    if(escape){
      for(const [x, y] of escape) steps.push({ x, y, kind: 'walk' });
    }
  }
  if(steps.length === 0) return null;
  return { kind, steps };
}

/* ====================================================
   BFS helpers + danger map.
   ==================================================== */

function isPassable(view, me, tx, ty){
  const f = view.field;
  if(tx < 0 || ty < 0 || tx >= f.width || ty >= f.height) return false;
  if(f.at(tx, ty) !== TILE.FLOOR) return false;
  for(const b of view.bombs){
    if(b.x === tx && b.y === ty && !me.passthrough.has(b.id)) return false;
  }
  return true;
}

function buildDangerMap(view){
  /* Chain-aware: a bomb in another bomb's blast inherits the smaller fuse. */
  const bombs = view.bombs;
  const eff = new Map();
  for(const b of bombs) eff.set(b.id, b.detonating ? 0 : Math.max(0, b.fuse));
  let changed = true;
  while(changed){
    changed = false;
    for(const a of bombs){
      const aFuse = eff.get(a.id);
      const aSegs = computeExplosionSegments(view.field, a.x, a.y, a.range);
      for(const s of aSegs){
        for(const b of bombs){
          if(b.id === a.id) continue;
          if(b.x === s.x && b.y === s.y){
            const bFuse = eff.get(b.id);
            if(aFuse < bFuse){ eff.set(b.id, aFuse); changed = true; }
          }
        }
      }
    }
  }
  const map = new Map();
  for(const b of bombs){
    const fuse = eff.get(b.id);
    const segs = computeExplosionSegments(view.field, b.x, b.y, b.range);
    for(const s of segs){
      const k = s.x + ',' + s.y;
      const cur = map.get(k);
      if(cur === undefined || fuse < cur) map.set(k, fuse);
    }
  }
  return map;
}

/* BFS that visits every tile reachable from `me` via passable, safe-on-
   arrival tiles.  Used for general planning. */
function bfsSafe(me, view, danger, startTx, startTy){
  const speed = Math.max(me.speed, 1);
  const sx = startTx !== undefined ? startTx : Math.floor(me.x);
  const sy = startTy !== undefined ? startTy : Math.floor(me.y);
  const visited = new Map();
  visited.set(sx + ',' + sy, { dist: 0, prev: null });
  const queue = [[sx, sy, 0]];
  while(queue.length){
    const [x, y, d] = queue.shift();
    if(d > BFS_LIMIT) continue;
    for(const [dx, dy] of CARDINALS){
      const nx = x + dx, ny = y + dy;
      const k = nx + ',' + ny;
      if(visited.has(k)) continue;
      if(!isPassable(view, me, nx, ny)) continue;
      const arriveT = (d + 1) / speed;
      const blastT = danger.get(k);
      if(blastT !== undefined && blastT < arriveT + ESCAPE_MARGIN) continue;
      visited.set(k, { dist: d + 1, prev: [x, y] });
      queue.push([nx, ny, d + 1]);
    }
  }
  return visited;
}

function reconstructPath(visited, fromTx, fromTy, toTx, toTy){
  const path = [];
  let cur = [toTx, toTy];
  while(cur[0] !== fromTx || cur[1] !== fromTy){
    path.unshift(cur);
    const node = visited.get(cur[0] + ',' + cur[1]);
    if(!node || !node.prev) return null;
    cur = node.prev;
  }
  return path;
}

/* Compute a complete ESCAPE PATH from a hypothetical-bomb tile to a
   permanently-safe destination, returning [[x,y],...] or null.  Callers
   pick how strict the escape distance must be: ATTACK uses range+3 / +4,
   CLEAR uses range+2 / +3 (we can afford a tighter escape when bombing
   crates because crate-clearing is what makes ATTACK options reachable
   in the first place; never bombing because the strict escape is
   unreachable is the worse failure mode). */
function computeEscape(me, view, bx, by, minCornerDist, minStraightDist){
  /* Hypothetical danger map = current bombs + new bomb at (bx,by). */
  const hyDanger = new Map();
  const allBombs = [...view.bombs, { id: -1, x: bx, y: by, range: me.range, fuse: FUSE_SECONDS, detonating: false }];
  const eff = new Map();
  for(const b of allBombs) eff.set(b.id, b.detonating ? 0 : Math.max(0, b.fuse));
  let changed = true;
  while(changed){
    changed = false;
    for(const a of allBombs){
      const aFuse = eff.get(a.id);
      const aSegs = computeExplosionSegments(view.field, a.x, a.y, a.range);
      for(const s of aSegs){
        for(const b of allBombs){
          if(b.id === a.id) continue;
          if(b.x === s.x && b.y === s.y){
            const bFuse = eff.get(b.id);
            if(aFuse < bFuse){ eff.set(b.id, aFuse); changed = true; }
          }
        }
      }
    }
  }
  for(const b of allBombs){
    const fuse = eff.get(b.id);
    const segs = computeExplosionSegments(view.field, b.x, b.y, b.range);
    for(const s of segs){
      const k = s.x + ',' + s.y;
      const cur = hyDanger.get(k);
      if(cur === undefined || fuse < cur) hyDanger.set(k, fuse);
    }
  }

  /* BFS from (bx,by) under the hypothetical danger.  Two tiers, in order:
       1. CORNER escape — destination differs from the bomb tile in BOTH x
          AND y, so a pillar or wall is between us and any future bomb at
          this spot.
       2. STRAIGHT escape — destination shares the bomb's row or column.
          A future fire-up bomb here could reach us, so we walk one more
          tile out. */
  const visited = bfsSafe(me, view, hyDanger, bx, by);
  let cornerBest = null;
  let straightBest = null;
  for(const [k, info] of visited){
    if(hyDanger.has(k)) continue;
    const [x, y] = k.split(',').map(Number);
    const isCorner = (x !== bx) && (y !== by);
    if(isCorner && info.dist >= minCornerDist){
      if(!cornerBest || info.dist < cornerBest.dist){
        cornerBest = { x, y, dist: info.dist };
      }
    } else if(!isCorner && info.dist >= minStraightDist){
      if(!straightBest || info.dist < straightBest.dist){
        straightBest = { x, y, dist: info.dist };
      }
    }
  }
  const best = cornerBest || straightBest;
  if(!best) return null;
  return reconstructPath(visited, bx, by, best.x, best.y);
}

/* Survival reflex: find the closest tile not in any blast, return a single
   step toward it. */
function findFleeStep(me, view, danger){
  const visited = bfsSafe(me, view, danger);
  const myTx = Math.floor(me.x), myTy = Math.floor(me.y);
  let best = null;
  for(const [k, info] of visited){
    if(info.dist === 0) continue;
    if(danger.has(k)) continue;
    if(!best || info.dist < best.dist){
      const [x, y] = k.split(',').map(Number);
      best = { x, y, dist: info.dist };
    }
  }
  if(!best){
    /* Truly trapped — pick any passable neighbour. */
    for(const [dx, dy] of CARDINALS){
      if(isPassable(view, me, myTx + dx, myTy + dy)){
        return { x: myTx + dx, y: myTy + dy };
      }
    }
    return null;
  }
  /* Walk the first step of the path toward the safe tile. */
  const path = reconstructPath(visited, myTx, myTy, best.x, best.y);
  if(!path || path.length === 0) return null;
  return { x: path[0][0], y: path[0][1] };
}

/* ====================================================
   Movement primitives.
   ==================================================== */

function tileReached(me, target){
  return Math.abs(me.x - (target.x + 0.5)) < ARRIVE_EPS
      && Math.abs(me.y - (target.y + 0.5)) < ARRIVE_EPS;
}

function walkToward(me, target){
  const cx = target.x + 0.5, cy = target.y + 0.5;
  const dxr = cx - me.x, dyr = cy - me.y;
  const adx = Math.abs(dxr), ady = Math.abs(dyr);
  let dx = 0, dy = 0;
  if(adx > 0.05 || ady > 0.05){
    if(adx >= ady) dx = Math.sign(dxr);
    else            dy = Math.sign(dyr);
  }
  return { dx, dy, bomb: false };
}

function idle(){ return { dx: 0, dy: 0, bomb: false }; }

/* True if the current route ends on a tile that's permanently safe — meaning
   the committed plan WILL deliver us to safety.  Used to suppress the
   survival reflex while we're correctly executing our own escape. */
function routeWillSave(route, stepIdx, danger){
  if(!route || stepIdx >= route.steps.length) return false;
  const last = route.steps[route.steps.length - 1];
  return !danger.has(last.x + ',' + last.y);
}

/* Check if the very next tile we'd walk onto is still safe to enter.  We
   don't validate the entire remaining path (the user wants commitment),
   only the immediate next step.  This catches the most common failure:
   another CPU dropped a bomb between our planning and now.

   Transit tiles (we'll walk through and off) only need a small buffer.
   The final step (where we stop) needs the full ESCAPE_MARGIN. */
function nextStepStillSafe(route, stepIdx, danger, me){
  if(!route || stepIdx >= route.steps.length) return true;
  const step = route.steps[stepIdx];
  if(step.kind === 'bomb') return true;
  const speed = Math.max(me.speed, 1);
  const arriveT = 1 / speed;
  const blastT = danger.get(step.x + ',' + step.y);
  if(blastT === undefined) return true;
  const isFinal = stepIdx === route.steps.length - 1;
  const buffer = isFinal ? ESCAPE_MARGIN : 0.3;
  return blastT > arriveT + buffer;
}
