/* High-fidelity CPU smoke test harness.  Mirrors the engine's per-tick
   loop including chain detonations, bombByTile, passthrough cleanup, and
   pickup spawn — anything that affects CPU survival.

   Loaded only by the test page; not part of the runtime game. */

import { TILE, createField } from './field.js';
import { stepPlayer, tilesUnderPlayer } from './players.js';
import { createBomb, computeExplosionSegments, playerOnTile, FUSE_SECONDS, EXPLOSION_TTL } from './bombs.js';
import { createPickup, pickRandomPickup, applyPickup, DROP_CHANCE } from './pickups.js';
import { createCpuController } from './cpu.js';

function seedRng(seed){
  let s = seed;
  return () => { s = (s*9301 + 49297) % 233280; return s / 233280; };
}

function makePlayer(idx, sx, sy){
  return {
    idx, charId: 'mochi', name: 'cpu' + idx, scheme: null, type: 'cpu', mode: 'cpu',
    x: sx + 0.5, y: sy + 0.5, speed: 4.5, facing: 'down',
    alive: true, bombMax: 1, bombsLive: 0, range: 2,
    passthrough: new Set(),
    hasRemote: false, hasSuper: false, hasBoomerang: false, hasKick: false,
    hasGlove: false, hasIce: false, hasMagnet: false,
    shieldStacks: 0, ghostUntil: 0, slowUntil: 0, collected: [],
  };
}

/* Run one match using the same per-tick logic the engine uses.  Returns a
   detailed log: every bomb placement, every death (with attribution), every
   movement sample, and oscillation/stuck-tile counters. */
export function runMatch({ seed, presetId = 'medium', cpuCount = 6, dt = 0.05, maxSeconds = 90, dropChance = 0 } = {}){
  const rng = seedRng(seed);
  const field = createField(presetId, cpuCount, rng);
  const players = [];
  const ctrls = new Map();
  for(let i = 0; i < cpuCount; i++){
    const [sx, sy] = field.spawns[i];
    players.push(makePlayer(i, sx, sy));
    ctrls.set(i, createCpuController(i === 0 ? 'nice' : 'mean'));
  }
  const bombs = [];
  const bombByTile = new Map();
  const pickups = [];
  const pickupByTile = new Map();
  const explosions = [];
  let elapsed = 0;
  const log = {
    seed, bombsPlaced: 0, deaths: [], events: [],
    posSamples: players.map(() => []),
    oscEvents: [],
    stuckEvents: [],
  };
  const view = {
    field, players, bombs, pickups,
    get elapsed(){ return elapsed; },
  };
  const prevBomb = new Map();
  /* Tracks per-player movement history for oscillation/stuck detection. */
  const lastPositions = players.map(() => []);

  const totalTicks = Math.ceil(maxSeconds / dt);
  for(let i = 0; i < totalTicks; i++){
    elapsed = i * dt;

    /* Per-player phase — exactly mirrors engine.js order. */
    for(const p of players){
      if(!p.alive) continue;
      const ctrl = ctrls.get(p.idx);
      const action = ctrl.decide(p, view);
      const wasBomb = prevBomb.get(p.idx) || false;
      const r = {
        dx: action.dx | 0, dy: action.dy | 0,
        bomb: !!action.bomb,
        bombEdge: !!action.bomb && !wasBomb,
      };
      prevBomb.set(p.idx, r.bomb);

      /* Build solid set excluding bombs in player's passthrough. */
      const solid = new Set();
      for(const b of bombs){
        if(!p.passthrough.has(b.id)) solid.add(b.x + ',' + b.y);
      }

      /* Step player. */
      stepPlayer(p, r.dx, r.dy, dt, field, solid, elapsed);

      /* Passthrough cleanup. */
      if(p.passthrough.size > 0){
        const overlap = new Set(tilesUnderPlayer(p).map(([x,y]) => x+','+y));
        for(const id of [...p.passthrough]){
          const b = bombs.find(x => x.id === id);
          if(!b || !overlap.has(b.x+','+b.y)) p.passthrough.delete(id);
        }
      }

      /* Pickup. */
      for(const [tx, ty] of tilesUnderPlayer(p)){
        const key = tx + ',' + ty;
        const pid = pickupByTile.get(key);
        if(pid != null){
          const pi = pickups.findIndex(x => x.id === pid);
          if(pi >= 0){
            applyPickup(p, pickups[pi].type, { elapsed, slowOthers: () => {} });
            pickups.splice(pi, 1);
            pickupByTile.delete(key);
          }
        }
      }

      /* Bomb placement on rising edge. */
      if(r.bombEdge && p.bombsLive < p.bombMax){
        const tx = Math.floor(p.x), ty = Math.floor(p.y);
        if(field.at(tx, ty) === TILE.FLOOR && !bombByTile.has(tx+','+ty)){
          const range = p.hasSuper ? Math.max(field.width, field.height) : p.range;
          const bomb = createBomb({ ownerIdx: p.idx, x: tx, y: ty, range });
          if(p.hasRemote) bomb.fuse = Infinity;
          if(p.hasSuper){ bomb.super = true; p.hasSuper = false; }
          if(p.hasBoomerang){
            bomb.boomerang = { phase: 1, fullRange: p.range, delay: 0.5 };
            p.hasBoomerang = false;
          }
          bombs.push(bomb);
          bombByTile.set(tx+','+ty, bomb.id);
          p.bombsLive++;
          p.passthrough.add(bomb.id);
          log.bombsPlaced++;
          log.events.push({ t:+elapsed.toFixed(2), type:'bomb', idx:p.idx, pos:[tx,ty] });
        }
      }
    }

    /* Tick fuses. */
    for(const b of bombs){
      if(b.detonating) continue;
      b.fuse -= dt;
      if(b.fuse <= 0) b.detonating = true;
    }

    /* Resolve detonations + chain reactions (mirrors engine). */
    const queue = bombs.filter(b => b.detonating);
    while(queue.length){
      const b = queue.shift();
      const idx = bombs.indexOf(b);
      if(idx >= 0) bombs.splice(idx, 1);
      bombByTile.delete(b.x+','+b.y);
      const owner = players.find(p => p.idx === b.ownerIdx);
      const isBoomerang1 = b.boomerang && b.boomerang.phase === 1;
      if(owner && !isBoomerang1) owner.bombsLive = Math.max(0, owner.bombsLive - 1);
      const segs = computeExplosionSegments(field, b.x, b.y, b.range);
      explosions.push({ segments: segs, ttl: EXPLOSION_TTL });
      for(const s of segs){
        if(field.at(s.x, s.y) === TILE.BOX){
          field.set(s.x, s.y, TILE.FLOOR);
          if(rng() < dropChance){
            const type = pickRandomPickup(rng);
            const pickup = createPickup(type, s.x, s.y);
            pickups.push(pickup);
            pickupByTile.set(s.x+','+s.y, pickup.id);
          }
        }
        const chainId = bombByTile.get(s.x+','+s.y);
        if(chainId){
          const chained = bombs.find(x => x.id === chainId);
          if(chained && !chained.detonating){
            chained.detonating = true;
            queue.push(chained);
          }
        }
        for(const p of players){
          if(!p.alive) continue;
          if(playerOnTile(p, s.x, s.y)){
            if(p.shieldStacks > 0){
              p.shieldStacks--;
              continue;
            }
            p.alive = false;
            log.deaths.push({
              t: +elapsed.toFixed(2), idx: p.idx, by: b.ownerIdx,
              self: b.ownerIdx === p.idx,
              pos: [+p.x.toFixed(2), +p.y.toFixed(2)],
              blastTile: [s.x, s.y],
            });
          }
        }
      }
      if(isBoomerang1){
        const phase2 = createBomb({ ownerIdx: b.ownerIdx, x: b.x, y: b.y, range: b.boomerang.fullRange });
        phase2.fuse = b.boomerang.delay;
        phase2.boomerang = { phase: 2 };
        bombs.push(phase2);
        bombByTile.set(phase2.x+','+phase2.y, phase2.id);
        if(owner) owner.passthrough.add(phase2.id);
      }
    }

    /* Decay explosions. */
    for(const e of explosions) e.ttl -= dt;
    for(let k = explosions.length - 1; k >= 0; k--){
      if(explosions[k].ttl <= 0) explosions.splice(k, 1);
    }

    /* Sample positions for oscillation/stuck detection. */
    if(i % 4 === 0){
      players.forEach((p, pi) => {
        if(!p.alive) return;
        const tile = [Math.floor(p.x), Math.floor(p.y)];
        const hist = lastPositions[pi];
        hist.push({ t: elapsed, tile });
        if(hist.length > 20) hist.shift();
        log.posSamples[pi].push({ t:+elapsed.toFixed(2), pos:[+p.x.toFixed(2), +p.y.toFixed(2)] });
      });
    }

    /* End condition. */
    const aliveCount = players.filter(p => p.alive).length;
    if(aliveCount <= 1) break;
  }

  /* Detect oscillation: ≥6 same-pair-of-tile transitions within 1s. */
  players.forEach((p, pi) => {
    const hist = lastPositions[pi];
    let transitions = 0;
    let pairs = new Map();
    for(let i = 1; i < hist.length; i++){
      const a = hist[i-1].tile.join(','), b = hist[i].tile.join(',');
      if(a !== b){
        const key = [a, b].sort().join('|');
        pairs.set(key, (pairs.get(key) || 0) + 1);
        transitions++;
      }
    }
    for(const [k, n] of pairs){
      if(n >= 6) log.oscEvents.push({ idx: pi, pair: k, count: n });
    }
  });

  /* Detect stuck: same tile for >2s while alive. */
  players.forEach((p, pi) => {
    const hist = lastPositions[pi];
    if(hist.length < 10) return;
    let runStart = 0, runTile = null;
    for(let i = 0; i < hist.length; i++){
      const tile = hist[i].tile.join(',');
      if(tile !== runTile){
        if(runTile !== null && hist[i].t - hist[runStart].t > 2.0){
          log.stuckEvents.push({ idx: pi, tile: runTile, durSec: +(hist[i].t - hist[runStart].t).toFixed(1) });
        }
        runTile = tile; runStart = i;
      }
    }
  });

  return {
    seed,
    finalT: +elapsed.toFixed(2),
    survivors: players.filter(p => p.alive).map(p => p.idx),
    deaths: log.deaths,
    selfKills: log.deaths.filter(d => d.self).length,
    crossKills: log.deaths.filter(d => !d.self).length,
    bombsPlaced: log.bombsPlaced,
    oscEvents: log.oscEvents,
    stuckEvents: log.stuckEvents,
    deathReport: log.deaths.map(d =>
      `t=${d.t} ${d.self?'SELF':'KILL'} idx=${d.idx} by=${d.by} on ${d.blastTile.join(',')}`
    ),
  };
}

/* Run a battery of seeds and produce a summary. */
export function runBattery(seeds, opts = {}){
  const matches = seeds.map(seed => runMatch({ seed, ...opts }));
  return {
    matches,
    aggregate: {
      totalSelfKills: matches.reduce((a, m) => a + m.selfKills, 0),
      totalCrossKills: matches.reduce((a, m) => a + m.crossKills, 0),
      totalBombs: matches.reduce((a, m) => a + m.bombsPlaced, 0),
      avgDuration: +(matches.reduce((a, m) => a + m.finalT, 0) / matches.length).toFixed(1),
      oscillatingMatches: matches.filter(m => m.oscEvents.length > 0).length,
      stuckMatches: matches.filter(m => m.stuckEvents.length > 0).length,
      totalDeaths: matches.reduce((a, m) => a + m.deaths.length, 0),
    },
  };
}
