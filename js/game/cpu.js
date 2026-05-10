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
const STUCK_TICKS_MAX = 8;          // can't move for this many ticks → abandon route, replan

const PICKUP_VALUE = {
  bomb: 100, fire: 100, shield: 80,
  remote: 70, ghost: 60, kick: 60, magnet: 50, slow: 40,
  hook: 60, dash: 60, earthquake: 50,
  curse: -1,
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
  /* Track the previous tile we were on so EXPLORE can avoid the
     "ping-pong between adjacent tiles in a tight spawn corner" case:
     when the only EXPLORE candidate is the tile we just came from, we
     idle instead of walking back. */
  let prevTile = null;
  let curTile = null;

  return {
    decide(me, view){
      const myTx = Math.floor(me.x);
      const myTy = Math.floor(me.y);
      const tileKey = myTx + ',' + myTy;
      if(curTile !== null && curTile !== tileKey){
        prevTile = curTile;
      }
      curTile = tileKey;
      const danger = buildDangerMap(view);

      /* ── SURVIVAL REFLEX ──────────────────────────────────────────────
         Two ways this trips:
           a) Our actual current tile is about to explode (any bomb covers
              it within SURVIVAL_THRESHOLD).
           b) An enemy bomb shares our row OR column.  We don't know the
              enemy's range, so we treat foreign bombs as unbounded — if
              they're in line with us we flee preemptively.
         A committed escape route that ends on a permanently safe tile
         (clear of both actual danger and foreign line-of-fire) suppresses
         the reflex; we trust the plan in that case. */
      const foreignWorst = buildForeignWorstDanger(view, me);
      const myBlast = danger.get(myTx + ',' + myTy);
      const inActualBlast = myBlast !== undefined && myBlast < SURVIVAL_THRESHOLD;
      const inForeignThreat = foreignWorst.has(myTx + ',' + myTy);
      if((inActualBlast || inForeignThreat)
         && !routeWillSave(route, stepIdx, danger, foreignWorst)){
        const flee = findFleeStep(me, view, danger, foreignWorst);
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

      /* ── PLAN ROUTE if we don't have one ──────────────────────────────
         When our own bomb is still ticking and we're safely outside the
         blast, three cases:
           a) We can place another bomb (multi-bomb pickup, bombsLive <
              bombMax) → fall through to planning.  The chain-bonus in the
              scorer will prefer placements that cascade with the first.
           b) We can't place more, but we have hasRemote → detonate it now.
           c) Else → just wait it out.  Replanning here would walk us back
              through the existing blast. */
      if(!route || stepIdx >= route.steps.length){
        const safeHere = !danger.has(myTx + ',' + myTy);
        const liveOwn  = me.bombsLive > 0;
        const canPlaceMore = me.bombsLive < me.bombMax;
        if(safeHere && liveOwn && !canPlaceMore){
          if(me.hasRemote){
            return { dx: 0, dy: 0, bomb: true };
          }
          return idle();
        }
        const allowBomb = view.elapsed >= startupDelay;
        route = planRoute(me, view, danger, allowBomb, prevTile);
        stepIdx = 0;
        if(!route) return idle();
      }

      /* ── ROUTE INTEGRITY ─────────────────────────────────────────────
         The next tile we'd walk onto must not be about to explode AND
         must still be passable.  If another CPU's bomb covers it (blast)
         or sits on it (blocking the tile), abandon the route and replan. */
      if(!nextStepStillSafe(route, stepIdx, danger, view, me)){
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

function planRoute(me, view, danger, allowBomb = true, prevTile = null){
  /* BFS reachability — every path tile must be currently passable AND
     safe-on-arrival under the current danger map. */
  const reach = bfsSafe(me, view, danger);

  /* Soft priority: each goal type produces its best scored candidate; we
     pick the highest-scoring across all kinds.  Score weights are tuned
     so the user's example works (enemy at dist 10 vs pickup at dist 2 →
     pickup wins) without losing the obvious cases (close attack > far
     pickup; massive crate cluster > nearby pickup). */
  const candidates = [];
  if(allowBomb){
    const a = planAttackCandidate(me, view, reach);
    if(a) candidates.push(a);
    const c = planClearCandidate(me, view, reach);
    if(c) candidates.push(c);
  }
  const pu = planPickupCandidate(me, view, reach);
  if(pu) candidates.push(pu);
  const ps = planPursueCandidate(me, view, reach);
  if(ps) candidates.push(ps);

  if(candidates.length){
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const includeBomb = best.kind === 'attack' || best.kind === 'clear';
    return assembleRoute(best.kind, me, reach, best.x, best.y, includeBomb, best.escape || null);
  }

  return planExplore(me, view, reach, prevTile);
}

/* ATTACK candidate: a bomb position whose blast hits at least one
   reachable enemy, with a verified escape.  Returns the highest-scoring
   spot or null. */
function planAttackCandidate(me, view, reach){
  if(me.bombsLive >= me.bombMax) return null;
  const enemies = view.players.filter(p => p.idx !== me.idx && p.alive);
  if(enemies.length === 0) return null;
  const reachableEnemies = enemies.filter(e => reach.has(Math.floor(e.x) + ',' + Math.floor(e.y)));
  if(reachableEnemies.length === 0) return null;

  const enemyTiles = new Set(reachableEnemies.map(e => Math.floor(e.x) + ',' + Math.floor(e.y)));
  const chainTiles = ownBombBlastTiles(view, me);
  let best = null;
  for(const [k, info] of reach){
    const [x, y] = k.split(',').map(Number);
    const segs = computeExplosionSegments(view.field, x, y, me.range);
    let hits = 0;
    for(const s of segs) if(enemyTiles.has(s.x + ',' + s.y)) hits++;
    if(hits === 0) continue;
    const escape = computeEscape(me, view, x, y, 2, me.range + 2);
    if(!escape) continue;
    const chains = chainTiles.has(k);
    /* Base 100 + 30 per enemy hit − 8 per tile of distance + chain bonus. */
    const score = 100 + hits * 30 - info.dist * 8 + (chains ? 100 : 0);
    if(isBetterCandidate({ x, y, score }, best)){
      best = { kind: 'attack', x, y, score, dist: info.dist, escape };
    }
  }
  return best;
}

/* PURSUE candidate: walk toward the closest reachable enemy without
   bombing.  Lower base than ATTACK so a real attack window always wins
   when one is available. */
function planPursueCandidate(me, view, reach){
  const enemies = view.players.filter(p => p.idx !== me.idx && p.alive);
  if(enemies.length === 0) return null;
  let closest = null;
  for(const e of enemies){
    const ex = Math.floor(e.x), ey = Math.floor(e.y);
    const info = reach.get(ex + ',' + ey);
    if(!info || info.dist === 0) continue;
    if(!closest || info.dist < closest.dist){
      closest = { x: ex, y: ey, dist: info.dist };
    }
  }
  if(!closest) return null;
  /* Base 80 − 6 per tile.  Beats far pickups when the enemy is close (dist
     1 → 74), loses to a nearby pickup when the enemy is across the map. */
  const score = 80 - closest.dist * 6;
  return { kind: 'pursue', x: closest.x, y: closest.y, score, dist: closest.dist };
}

/* Goal 4 (always-on fallback): EXPLORE — pick the farthest reachable safe
   tile and walk there.  Never returns null as long as ANY neighbour is
   reachable, EXCEPT when the only candidate at max distance is the tile
   we just came from (prevTile).  Without that exception, a CPU stuck in
   a tight 2-3-tile spawn corner would ping-pong between the two adjacent
   tiles forever — visible to the user as the back-and-forth.  Returning
   null lets the outer idle path keep us put until the world changes. */
function planExplore(me, view, reach, prevTile = null){
  let best = null;
  for(const [k, info] of reach){
    if(info.dist === 0) continue;
    if(!best || info.dist > best.dist){
      const [x, y] = k.split(',').map(Number);
      best = { x, y, dist: info.dist, key: k };
    }
  }
  if(!best) return null;
  /* Refuse to walk back to the tile we just left if it's the only
     "farthest" candidate we found — that's the ping-pong case. */
  if(best.dist === 1 && best.key === prevTile) return null;
  return assembleRoute('explore', me, reach, best.x, best.y, false, null);
}

/* CLEAR candidate: a bomb position that destroys at least one crate.
   Score is scaled by how many crates remain on the field — early game
   (lots of crates) we prioritise CLEAR; late game (few crates) it drops
   well below ATTACK and PICKUP, since end-game is about killing not
   chopping wood. */
function planClearCandidate(me, view, reach){
  if(me.bombsLive >= me.bombMax) return null;
  const chainTiles = ownBombBlastTiles(view, me);
  const totalCrates = countCrates(view.field);
  /* Multiplier: ~1.2 when ≥60 crates left, smoothly down to 0.3 when
     few are left.  Threshold 60 is a typical post-spawn crate count on
     a medium field. */
  const crateFactor = Math.min(1.2, Math.max(0.3, totalCrates / 60));

  let best = null;
  for(const [k, info] of reach){
    const [x, y] = k.split(',').map(Number);
    const segs = computeExplosionSegments(view.field, x, y, me.range);
    let crates = 0;
    for(const s of segs){
      if(view.field.at(s.x, s.y) === TILE.BOX) crates++;
    }
    if(crates === 0) continue;
    const escape = computeEscape(me, view, x, y, 2, me.range + 2);
    if(!escape) continue;
    const chains = chainTiles.has(k);
    const rawScore = 50 + crates * 30 - info.dist * 6 + (chains ? 200 : 0);
    const score = rawScore * crateFactor;
    if(isBetterCandidate({ x, y, score }, best)){
      best = { kind: 'clear', x, y, score, dist: info.dist, escape };
    }
  }
  return best;
}

function countCrates(field){
  let c = 0;
  for(let y = 0; y < field.height; y++){
    for(let x = 0; x < field.width; x++){
      if(field.at(x, y) === TILE.BOX) c++;
    }
  }
  return c;
}

/* PICKUP candidate: closest reachable pickup with a positive value
   (skipping Curse).  Base score and distance falloff are tuned so that
   pickups out-prioritise CLEAR almost across the board — only a really
   fat multi-crate cluster beats a reachable pickup.  ATTACK with a real
   hit still wins because attack adds 30 per enemy hit. */
function planPickupCandidate(me, view, reach){
  if(view.pickups.length === 0) return null;
  let best = null;
  for(const pu of view.pickups){
    const info = reach.get(pu.x + ',' + pu.y);
    if(!info) continue;
    const value = PICKUP_VALUE[pu.type] ?? 30;
    if(value <= 0) continue;
    /* Base 160 − 3 per tile.  Even pickups 15 tiles away score 115,
       beating a 2-crate CLEAR (typical ~92).  Big 4-5-crate clears still
       outscore. */
    const score = 160 - info.dist * 3;
    if(!best || score > best.score){
      best = { kind: 'pickup', x: pu.x, y: pu.y, score, dist: info.dist };
    }
  }
  return best;
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

/* Survival reflex: find a flee target and return a single step toward it.
   Two-tier preference:
     1. CORNER escape — closest tile that's outside both the actual danger
        map AND every foreign bomb's worst-case row/column.  This is the
        "around the corner" position the user asks for.
     2. FAR escape — closest tile outside the actual danger map.  Used when
        no true corner is reachable; we accept staying in some enemy's
        line-of-fire as long as we're not in an immediate blast. */
function findFleeStep(me, view, danger, foreignWorst){
  const visited = bfsSafe(me, view, danger);
  const myTx = Math.floor(me.x), myTy = Math.floor(me.y);
  let cornerBest = null;
  let farBest = null;
  for(const [k, info] of visited){
    if(info.dist === 0) continue;
    if(danger.has(k)) continue;
    const inForeign = foreignWorst && foreignWorst.has(k);
    if(!inForeign){
      if(!cornerBest || info.dist < cornerBest.dist){
        const [x, y] = k.split(',').map(Number);
        cornerBest = { x, y, dist: info.dist };
      }
    } else {
      /* Still in some foreign line-of-fire, but at least clear of immediate
         actual danger.  Prefer the FARTHEST such tile (more tiles between
         us and the enemy bomb's source = harder for a long-range bomb to
         reach us). */
      if(!farBest || info.dist > farBest.dist){
        const [x, y] = k.split(',').map(Number);
        farBest = { x, y, dist: info.dist };
      }
    }
  }
  const best = cornerBest || farBest;
  if(!best){
    /* Truly trapped — pick any passable neighbour. */
    for(const [dx, dy] of CARDINALS){
      if(isPassable(view, me, myTx + dx, myTy + dy)){
        return { x: myTx + dx, y: myTy + dy };
      }
    }
    return null;
  }
  /* Walk the first step of the path toward the chosen flee tile. */
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

/* Stable comparison for goal candidates: prefer higher score; on a tie
   prefer (smaller y, smaller x).  Without a deterministic tiebreak the CPU
   flips between equal candidates each replan — the user-reported "back and
   forth between two equally good crate-bomb spots" oscillation. */
function isBetterCandidate(c, best){
  if(!best) return true;
  if(c.score !== best.score) return c.score > best.score;
  if(c.y !== best.y) return c.y < best.y;
  return c.x < best.x;
}

/* Set of tiles currently inside any of OUR own ticking bombs' blasts.
   Used by planAttack/planClear to score chain-reaction placements: a
   second bomb on one of these tiles will cascade with the first. */
function ownBombBlastTiles(view, me){
  const set = new Set();
  for(const b of view.bombs){
    if(b.ownerIdx !== me.idx) continue;
    const segs = computeExplosionSegments(view.field, b.x, b.y, b.range);
    for(const s of segs) set.add(s.x + ',' + s.y);
  }
  return set;
}

/* Worst-case danger from foreign (non-own) bombs.  We don't know the
   enemy's actual range, so we treat each foreign bomb as if its blast
   reached the maximum possible distance — implemented as a giant range
   passed to computeExplosionSegments, which still respects walls and
   crates as blockers.  Result: the full row + column from each enemy
   bomb tile (until obstacles), so we know which tiles share line-of-fire
   with an enemy bomb regardless of its actual range. */
function buildForeignWorstDanger(view, me){
  const set = new Set();
  const maxRange = Math.max(view.field.width, view.field.height);
  for(const b of view.bombs){
    if(b.ownerIdx === me.idx) continue;
    const segs = computeExplosionSegments(view.field, b.x, b.y, maxRange);
    for(const s of segs) set.add(s.x + ',' + s.y);
  }
  return set;
}

/* True if the current route ends on a tile that's permanently safe under
   BOTH the actual danger map AND the worst-case foreign-bomb threat —
   meaning the committed plan delivers us to a tile where we're clear of
   our own blasts and out of line-of-fire of every enemy bomb.  Suppresses
   the survival reflex while we're correctly walking our own escape. */
function routeWillSave(route, stepIdx, danger, foreignWorst){
  if(!route || stepIdx >= route.steps.length) return false;
  const last = route.steps[route.steps.length - 1];
  const k = last.x + ',' + last.y;
  if(danger.has(k)) return false;
  if(foreignWorst && foreignWorst.has(k)) return false;
  return true;
}

/* Check if the very next tile we'd walk onto is still safe to enter.  We
   don't validate the entire remaining path (the user wants commitment),
   only the immediate next step.  This catches the most common failure:
   another CPU dropped a bomb between our planning and now.

   Transit tiles (we'll walk through and off) only need a small buffer.
   The final step (where we stop) needs the full ESCAPE_MARGIN. */
function nextStepStillSafe(route, stepIdx, danger, view, me){
  if(!route || stepIdx >= route.steps.length) return true;
  const step = route.steps[stepIdx];
  if(step.kind === 'bomb') return true;
  /* Passability: a bomb just dropped on this tile blocks it; without
     this check the CPU walks at the bomb until stuck-detection fires. */
  if(!isPassable(view, me, step.x, step.y)) return false;
  const speed = Math.max(me.speed, 1);
  const arriveT = 1 / speed;
  const blastT = danger.get(step.x + ',' + step.y);
  if(blastT === undefined) return true;
  const isFinal = stepIdx === route.steps.length - 1;
  const buffer = isFinal ? ESCAPE_MARGIN : 0.3;
  return blastT > arriveT + buffer;
}
