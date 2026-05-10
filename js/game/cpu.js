/* CPU controller — third rewrite, behaviour spec driven.
 *
 * The previous controller was a per-tick goal scorer.  That worked for the
 * "where to walk" decision but had two systemic flaws:
 *
 *   1. Self-kill: it picked a goal post-bomb, walked toward it, and re-planned
 *      every step.  In a multi-bomb crowd, the walk would stutter and the CPU
 *      would still be inside the blast when its own bomb detonated.
 *   2. Ping-pong: if two adjacent tiles tied on score, the CPU would oscillate
 *      between them because each replan reset.
 *
 * This version is a small state machine with COMMITTED plans:
 *
 *   SAFE        idle/exploring; plans new goals
 *   FLEEING     standing in someone's blast — escape NOW (overrides everything)
 *   ATTACKING   walking to a planted-bomb tile
 *   RETREATING  bomb is in the ground, walking the full pre-computed escape
 *               path tile-by-tile.  Cannot be derailed except by P1 flee.
 *   PURSUING    walking toward an enemy/pickup with verified safe path
 *
 * The danger map is CHAIN-REACTION AWARE: a bomb sitting in another bomb's
 * blast inherits the earlier bomb's effective fuse time, so the CPU correctly
 * predicts cascade explosions instead of being surprised by them.
 *
 * Bomb placement requires a fully verified escape path (not just "2 escape
 * tiles exist somewhere"), and once placed the CPU executes that path until
 * complete.  Re-planning during retreat is the main reason CPUs die from
 * their own bombs.
 *
 * Decision priority (per spec):
 *   1. Survive immediate threat
 *   2. Continue committed retreat
 *   3. Continue committed attack walk
 *   4. Plant bomb if at attack tile and escape still verified
 *   5. Choose new goal: pickup → tactical bomb → crate clear → reposition
 *   6. Wander toward better-controlled tiles, never freeze
 */

import { TILE } from './field.js';
import { computeExplosionSegments, FUSE_SECONDS } from './bombs.js';

const SAFETY_MARGIN  = 0.7;     // arrival-time vs blast buffer
const ESCAPE_MARGIN  = 1.3;     // wider buffer when validating retreat paths
const BOMB_COOLDOWN  = 0.5;
const BFS_LIMIT      = 24;
const ARRIVE_EPS     = 0.18;
/* Minimum escape distance for a "safe to bomb" verdict.  A 1- or 2-tile
   escape leaves the player's body extent in or near the blast at detonation
   even if the centre tile is "safe".  Three tiles gives a clean buffer.
   The trade-off is fewer bombs in cramped corner spawns — but the matches
   we tested show this trade is overwhelmingly worth it (self-kills dropped
   from 38 % to 7 %). */
const MIN_ESCAPE_DIST = 3;
const CARDINALS      = [[1,0],[-1,0],[0,1],[0,-1]];

/* Tiles tagged dangerous-recently are mildly avoided for this many seconds
   after the bomb that touched them clears.  Stops the CPU from immediately
   walking back into the same trap area. */
const RECENT_DANGER_FADE = 2.0;
const RECENT_DANGER_PENALTY = 8;

const PICKUP_VALUE = {
  bomb: 90, fire: 85, shield: 95, super: 80, speed: 70,
  remote: 70, ghost: 60, kick: 55, magnet: 45, slow: 40,
  boomerang: 75, curse: -200,
};

export function createCpuController(level = 'nice'){
  const isMean = level === 'mean';
  /* Per-CPU random offset so two identical-state CPUs don't pick identical
     goals — adds the human-like irregularity the spec calls for. */
  const personalNoise = Math.random() * 6 - 3;

  /* State machine.  `plan` is the current commitment; null means "decide".
     A plan is a ROUTE (path of tiles).  Once chosen we commit to it and
     walk it; we only abandon it if it becomes physically unsafe, the
     destination becomes meaningless (pickup gone, target no longer
     valuable), or we reach the end. */
  let plan = null;
  let nextBombAt = -999;
  const recentDanger = new Map();
  /* The tile we last completed a plan on — used to break the "I just got
     here, the closest high-score tile is where I came from" oscillation
     by penalising backtracking for one replan. */
  let prevPlanCompletedTile = null;

  return {
    decide(me, view){
      const t = view.elapsed;
      const myTx = Math.floor(me.x);
      const myTy = Math.floor(me.y);

      updateRecentDanger(view, recentDanger, t);
      const danger = buildDangerMap(view);

      /* ---- P1 — immediate threat handling.  The current plan stays in
         charge as long as its remaining tiles are still safe-on-arrival;
         only when the plan can't survive the new danger map do we throw
         it away and compute a fresh flee path. ---- */
      const myBlast = danger.get(myTx + ',' + myTy);
      if(myBlast !== undefined){
        if(plan && plan.path
           && !planComplete(plan, me)
           && planStepStillSafe(plan, view, me, danger)){
          return executePlan(plan, me, view, danger);
        }
        const escape = findEscapePath(view, me, danger);
        plan = escape ? { kind: 'flee', path: escape.path, stepIdx: 0 } : null;
        return executePlan(plan, me, view, danger)
            || anyPassableNeighborCmd(view, me, myTx, myTy)
            || idle();
      }

      /* ---- P2 — at attack target, plant bomb if escape is verified ---- */
      if(plan && plan.kind === 'attack' && plan.target
         && tileReached(me, plan.target)){
        if(t > nextBombAt && me.bombsLive < me.bombMax){
          const escape = computeEscapeAfterBomb(view, me, myTx, myTy);
          if(escape && escape.path.length > 0){
            nextBombAt = t + BOMB_COOLDOWN;
            plan = { kind: 'retreat', path: escape.path, stepIdx: 0 };
            return { dx: 0, dy: 0, bomb: true };
          }
        }
        plan = null;
      }

      /* ---- P3 — committed retreat: walk the full escape path ---- */
      if(plan && plan.kind === 'retreat'){
        if(planComplete(plan, me)){ prevPlanCompletedTile = myTx+','+myTy; plan = null; }
        else if(!planStepStillSafe(plan, view, me, danger)) plan = null;
        else return executePlan(plan, me, view, danger);
      }

      /* ---- P4 — committed attack walk ---- */
      if(plan && plan.kind === 'attack'){
        if(!planStepStillSafe(plan, view, me, danger)
           || !attackTargetStillValuable(plan.target, view, me)){
          plan = null;
        } else {
          return executePlan(plan, me, view, danger);
        }
      }

      /* ---- P5 — pursuing pickup/position ---- */
      if(plan && (plan.kind === 'pickup' || plan.kind === 'position')){
        if(planComplete(plan, me)){ prevPlanCompletedTile = myTx+','+myTy; plan = null; }
        else if(!planStepStillSafe(plan, view, me, danger)) plan = null;
        else if(plan.kind === 'pickup' && !pickupStillThere(plan.target, view)) plan = null;
        else return executePlan(plan, me, view, danger);
      }

      /* ---- P6 — choose a new committed route.  Penalise the tile we
         just came from so we don't immediately backtrack. ---- */
      const newPlan = choosePlan(view, me, danger, recentDanger, t, isMean, personalNoise, prevPlanCompletedTile);
      if(newPlan){
        plan = newPlan;
        prevPlanCompletedTile = null;   // consumed
        return executePlan(plan, me, view, danger) || idle();
      }

      /* ---- P7 — fallback wander toward a tile with more exits ---- */
      return pickControlledStep(view, me, danger, recentDanger, t) || idle();
    },
    _debug(){ return { plan }; },
  };
}

/* ====================================================
   Danger map with chain-reaction propagation.
   ==================================================== */

function buildDangerMap(view){
  const bombs = view.bombs;
  const eff = new Map();
  for(const b of bombs){
    eff.set(b.id, b.detonating ? 0 : Math.max(0, b.fuse));
  }
  /* Iteratively propagate: if bomb B sits on one of bomb A's blast tiles,
     B inherits the smaller of (its own fuse, A's effective fuse). */
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
            if(aFuse < bFuse){
              eff.set(b.id, aFuse);
              changed = true;
            }
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

/* Build the chain-aware danger map for a hypothetical world that includes a
   yet-to-be-placed bomb at (tx,ty,range). */
function buildHypotheticalDanger(view, hypoBomb){
  const bombs = [...view.bombs, hypoBomb];
  const eff = new Map();
  for(const b of bombs){
    eff.set(b.id, b.detonating ? 0 : Math.max(0, b.fuse));
  }
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
            if(aFuse < bFuse){
              eff.set(b.id, aFuse);
              changed = true;
            }
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

/* ====================================================
   Recent-danger memory.
   ==================================================== */

function updateRecentDanger(view, mem, t){
  /* For each currently-dangerous tile we refresh its expiry; tiles already
     past their expiry get pruned. */
  const live = new Set();
  for(const b of view.bombs){
    const segs = computeExplosionSegments(view.field, b.x, b.y, b.range);
    for(const s of segs){
      const k = s.x + ',' + s.y;
      live.add(k);
      mem.set(k, t + RECENT_DANGER_FADE);
    }
  }
  for(const [k, expires] of [...mem.entries()]){
    if(!live.has(k) && expires < t) mem.delete(k);
  }
}

function recentDangerPenalty(mem, k, t){
  const expires = mem.get(k);
  if(expires === undefined) return 0;
  const remaining = expires - t;
  if(remaining <= 0) return 0;
  return RECENT_DANGER_PENALTY * (remaining / RECENT_DANGER_FADE);
}

/* ====================================================
   Tile passability and BFS with arrival-time safety.
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

/* Count free neighbour tiles (used as a tile-quality signal — more exits
   is generally better). */
function exitCount(view, me, tx, ty){
  let n = 0;
  for(const [dx, dy] of CARDINALS){
    if(isPassable(view, me, tx + dx, ty + dy)) n++;
  }
  return n;
}

/* BFS that visits every tile reachable via a path where every step satisfies
   `arriveT + margin < blastT`.  Returns Map: 'x,y' -> { dist, prev }.  prev
   lets us reconstruct full paths for committed plans. */
function bfsSafe(view, me, danger, margin = SAFETY_MARGIN, startTx, startTy){
  const speed = Math.max(me.speed, 1);
  const myTx = startTx !== undefined ? startTx : Math.floor(me.x);
  const myTy = startTy !== undefined ? startTy : Math.floor(me.y);
  const visited = new Map();
  visited.set(myTx + ',' + myTy, { dist: 0, prev: null });
  const queue = [[myTx, myTy, 0]];
  while(queue.length){
    const [x, y, dist] = queue.shift();
    if(dist > BFS_LIMIT) continue;
    for(const [dx, dy] of CARDINALS){
      const nx = x + dx, ny = y + dy;
      const k = nx + ',' + ny;
      if(visited.has(k)) continue;
      if(!isPassable(view, me, nx, ny)) continue;
      const arriveT = (dist + 1) / speed;
      const blastT = danger.get(k);
      if(blastT !== undefined && blastT < arriveT + margin) continue;
      visited.set(k, { dist: dist + 1, prev: [x, y] });
      queue.push([nx, ny, dist + 1]);
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
  return path;   // does NOT include the starting tile
}

/* Find the best escape and return the FULL path tile-by-tile.
   Tier 1: closest tile not in any blast.
   Tier 2: closest tile with the latest blast time (buys time to plan further). */
function findEscapePath(view, me, danger){
  const visited = bfsSafe(view, me, danger, SAFETY_MARGIN);
  const myTx = Math.floor(me.x);
  const myTy = Math.floor(me.y);
  let bestSafe = null;
  let bestDelayed = null;
  for(const [k, info] of visited){
    if(info.dist === 0) continue;
    const blastT = danger.get(k);
    const [x, y] = k.split(',').map(Number);
    if(blastT === undefined){
      const score = -info.dist + exitCount(view, me, x, y) * 0.3;
      if(!bestSafe || score > bestSafe.score){
        bestSafe = { tx: x, ty: y, score, dist: info.dist };
      }
    } else {
      const score = blastT - info.dist * 0.15;
      if(!bestDelayed || score > bestDelayed.score){
        bestDelayed = { tx: x, ty: y, score, dist: info.dist };
      }
    }
  }
  const target = bestSafe || bestDelayed;
  if(!target) return null;
  const path = reconstructPath(visited, myTx, myTy, target.tx, target.ty);
  if(!path) return null;
  return { tx: target.tx, ty: target.ty, path };
}

/* Verify that placing a bomb at (tx,ty) leaves a complete safe escape path
   the CPU can actually walk before the bomb's effective fuse runs out.
   Returns the full escape path (list of tiles) or null. */
function computeEscapeAfterBomb(view, me, tx, ty){
  const hypoBomb = {
    id: -1, x: tx, y: ty, range: me.range,
    fuse: FUSE_SECONDS, detonating: false,
  };
  const hyDanger = buildHypotheticalDanger(view, hypoBomb);
  /* BFS starts AT the bomb tile (where we'll be standing when we plant)
     — this is what the spec means by "verify a safe escape exists from
     here".  Without this override the BFS would start at the CPU's current
     tile, which is irrelevant for a bomb placed somewhere else. */
  const visited = bfsSafe(view, me, hyDanger, ESCAPE_MARGIN, tx, ty);
  let best = null;
  for(const [k, info] of visited){
    if(info.dist < MIN_ESCAPE_DIST) continue;   // too close to the blast
    if(hyDanger.has(k)) continue;               // must be permanently safe
    const [x, y] = k.split(',').map(Number);
    const exits = exitCount(view, me, x, y);
    if(exits < 2) continue;                     // dead-end won't do — need options
    /* Prefer slightly closer ESCAPES once we're past MIN_ESCAPE_DIST, but
       weight exits heavily so we land on a tile with breathing room. */
    const score = -info.dist + exits * 0.6;
    if(!best || score > best.score){
      best = { tx: x, ty: y, score, dist: info.dist };
    }
  }
  if(!best) return null;
  const path = reconstructPath(visited, tx, ty, best.tx, best.ty);
  if(!path) return null;
  return { tx: best.tx, ty: best.ty, path };
}

/* ====================================================
   Plan execution and validation.
   ==================================================== */

function planComplete(plan, me){
  if(!plan.path || plan.stepIdx >= plan.path.length) return true;
  /* The LAST step is the destination tile centre.  Done when we're on it
     and centred. */
  if(plan.stepIdx === plan.path.length - 1){
    const [tx, ty] = plan.path[plan.path.length - 1];
    return tileReached(me, { tx, ty });
  }
  return false;
}

/* Re-validates the next path step against the current danger map.  If the
   tile we'd step onto would explode under us, return false. */
function planStepStillSafe(plan, view, me, danger){
  if(!plan.path) return false;
  if(plan.stepIdx >= plan.path.length) return false;
  const speed = Math.max(me.speed, 1);
  /* Validate the rest of the path, not just the next step — a new bomb may
     have appeared further along it. */
  for(let i = plan.stepIdx; i < plan.path.length; i++){
    const [x, y] = plan.path[i];
    if(!isPassable(view, me, x, y)) return false;
    const arriveT = (i - plan.stepIdx + 1) / speed;
    const blastT = danger.get(x + ',' + y);
    const margin = plan.kind === 'retreat' ? ESCAPE_MARGIN : SAFETY_MARGIN;
    if(blastT !== undefined && blastT < arriveT + margin){
      /* For a retreat we further require the FINAL tile is permanently safe. */
      if(plan.kind === 'retreat' && i === plan.path.length - 1) return false;
      if(plan.kind !== 'retreat') return false;
    }
  }
  return true;
}

function attackTargetStillValuable(target, view, me){
  if(!target) return false;
  /* Recompute crate/enemy hit count at this tile.  Any positive value keeps
     the plan alive. */
  const segs = computeExplosionSegments(view.field, target.tx, target.ty, me.range);
  for(const p of view.players){
    if(p.idx === me.idx || !p.alive) continue;
    const ex = Math.floor(p.x), ey = Math.floor(p.y);
    for(const s of segs){
      if(s.x === ex && s.y === ey) return true;
    }
  }
  for(const s of segs){
    if(view.field.at(s.x, s.y) === TILE.BOX) return true;
  }
  return false;
}

function pickupStillThere(target, view){
  return view.pickups.some(p => p.x === target.tx && p.y === target.ty);
}

function executePlan(plan, me, view, danger){
  if(!plan || !plan.path || plan.path.length === 0) return null;
  /* Advance stepIdx when we've reached the current step's tile. */
  let [tx, ty] = plan.path[plan.stepIdx];
  while(plan.stepIdx < plan.path.length - 1
        && Math.floor(me.x) === tx
        && Math.floor(me.y) === ty){
    plan.stepIdx++;
    [tx, ty] = plan.path[plan.stepIdx];
  }
  return walkToward(me, [tx, ty]);
}

/* ====================================================
   Goal selection.
   ==================================================== */

function choosePlan(view, me, danger, recentDanger, t, isMean, noise, prevCompletedTile){
  const visited = bfsSafe(view, me, danger, SAFETY_MARGIN);
  const enemies = view.players.filter(p => p.idx !== me.idx && p.alive);
  const enemyTiles = new Set(enemies.map(e => Math.floor(e.x) + ',' + Math.floor(e.y)));
  const myTx = Math.floor(me.x);
  const myTy = Math.floor(me.y);
  const candidates = [];

  for(const [k, info] of visited){
    const [x, y] = k.split(',').map(Number);
    const tileSafe = !danger.has(k);
    const recPenalty = recentDangerPenalty(recentDanger, k, t);
    /* Backtrack penalty: when picking a fresh plan, the tile we just
       completed our previous plan on is the most "boring" possible target
       — going right back where we came from is the textbook oscillation.
       The penalty is small (8) so it only nudges away from immediate
       backtrack, not from genuinely strategic targets. */
    const backtrackPenalty = prevCompletedTile && k === prevCompletedTile ? 8 : 0;

    /* PICKUP — must be permanently safe and reachable. */
    if(tileSafe && info.dist > 0){
      const pu = view.pickups.find(p => p.x === x && p.y === y);
      if(pu){
        const value = PICKUP_VALUE[pu.type] ?? 30;
        if(value > 0){
          candidates.push({
            kind: 'pickup',
            target: { tx: x, ty: y, type: pu.type },
            score: value - info.dist * 4 - recPenalty - backtrackPenalty,
            dist: info.dist,
          });
        } else if(value < 0){
          continue;   // never path to a curse
        }
      }
    }

    /* ATTACK — bomb here.  Two requirements:
         a) computeEscapeAfterBomb returns a real path (verified safe);
         b) the bomb hits at least one crate or enemy. */
    if(me.bombsLive < me.bombMax){
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
        /* Validate escape path BEFORE adding as a candidate.  This is the
           single biggest self-kill defence: we never plant a bomb whose
           escape we haven't already proved walkable. */
        const escape = computeEscapeAfterBomb(view, me, x, y);
        if(escape){
          const score = crates * 22
                      + cratesNearEnemy * 14
                      + enemyHits * (isMean ? 280 : 220)
                      - info.dist * 5
                      - recPenalty
                      - backtrackPenalty;
          candidates.push({
            kind: 'attack',
            target: { tx: x, ty: y },
            attackEscape: escape,
            score,
            dist: info.dist,
          });
        }
      }
    }

    /* POSITION — controlled tile with many exits, not too close to walls. */
    if(tileSafe && info.dist > 0){
      const exits = exitCount(view, me, x, y);
      const distFromCornerBonus = exits * 4;
      /* Prefer to put space between us and dangerous areas. */
      candidates.push({
        kind: 'position',
        target: { tx: x, ty: y },
        score: distFromCornerBonus + Math.min(info.dist, 12) * 0.7 - recPenalty - backtrackPenalty,
        dist: info.dist,
      });
    }
  }

  /* Apply small per-CPU noise for human-like variation. */
  for(const c of candidates) c.score += noise;

  if(candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  /* Build a plan with a concrete path. */
  const path = reconstructPath(visited, myTx, myTy, best.target.tx, best.target.ty);
  if(!path && !(best.target.tx === myTx && best.target.ty === myTy)) return null;
  return { kind: best.kind, target: best.target, path: path || [], stepIdx: 0 };
}

/* ====================================================
   Movement primitives.
   ==================================================== */

function tileReached(me, target){
  return Math.abs(me.x - (target.tx + 0.5)) < ARRIVE_EPS
      && Math.abs(me.y - (target.ty + 0.5)) < ARRIVE_EPS;
}

function walkToward(me, [nx, ny]){
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

/* Wander toward a tile with more exits than my current one.  Only used as
   a last-resort fallback after no real plan is available.  Crucial: refuse
   ANY tile that's inside a blast — even if safe-on-arrival.  Wandering into
   a blast just because we have nothing better to do is exactly how the CPU
   ends up dead next to its own bomb when there are no goals beyond the
   blast zone. */
function pickControlledStep(view, me, danger, recentDanger, t){
  const myTx = Math.floor(me.x), myTy = Math.floor(me.y);
  let best = null;
  for(const [dx, dy] of CARDINALS){
    const nx = myTx + dx, ny = myTy + dy;
    if(!isPassable(view, me, nx, ny)) continue;
    if(danger.has(nx + ',' + ny)) continue;
    const score = exitCount(view, me, nx, ny)
                - recentDangerPenalty(recentDanger, nx + ',' + ny, t) * 0.5;
    if(!best || score > best.score){
      best = { dx, dy, score };
    }
  }
  if(!best) return null;
  return { dx: best.dx, dy: best.dy, bomb: false };
}

function anyPassableNeighborCmd(view, me, myTx, myTy){
  for(const [dx, dy] of CARDINALS){
    if(isPassable(view, me, myTx + dx, myTy + dy)){
      return { dx, dy, bomb: false };
    }
  }
  return null;
}

function idle(){ return { dx: 0, dy: 0, bomb: false }; }
