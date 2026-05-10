/* Game engine — owns state, runs the rAF loop, mediates between
   field/players/input/bombs and the rendering DOM in screens/game.js.

   The engine is rendering-agnostic: it tells the renderer what changed and
   the renderer decides how to draw. */

import { createField, FIELD_PRESETS, TILE } from './field.js';
import { createInput, CONTROL_SCHEMES } from './input.js';
import { createPlayer, stepPlayer, tilesUnderPlayer } from './players.js';
import { createBomb, computeExplosionSegments, playerOnTile, playerHitByBlast, EXPLOSION_TTL } from './bombs.js';
import {
  createPickup, pickRandomPickup, applyPickup,
  DROP_CHANCE, SLOW_DURATION,
  MAGNET_RADIUS, MAGNET_STEP_INTERVAL, KICK_STEP_INTERVAL,
  BOOMERANG_FIRST_RANGE, BOOMERANG_SECOND_DELAY,
} from './pickups.js';
import { createCpuController } from './cpu.js';

const HUMAN_SCHEMES = ['wasd', 'arrows', 'ijkl', 'numpad'];
/* Lobby-level speed setting applied uniformly to every player. */
const SPEED_FACTORS = { slow: 0.7, normal: 1.0, fast: 1.5 };
const BASE_SPEED = 4.5;

export function createEngine(lobby, hooks, opts = {}){
  const presetId = lobby.fieldSize in FIELD_PRESETS ? lobby.fieldSize : 'medium';
  /* 'remote' players are humans driven by a network peer.  Treated like
     'human' with scheme=null in the input loop; action comes from opts.remoteInputProvider. */
  const activePlayers = lobby.players.filter(p => p.mode !== 'off');
  const remoteInputProvider = opts.remoteInputProvider || (() => ({ dx:0, dy:0, bomb:false }));
  const field = createField(presetId, activePlayers.length);
  const input = createInput();
  const timeLimit = lobby.timeLimit || 0;     // 0 = infinite
  const speedFactor = SPEED_FACTORS[lobby.speed] ?? 1.0;
  const baseSpeed = BASE_SPEED * speedFactor;

  const players = [];
  const cpus = new Map();         // idx -> cpu controller for cpu-mode players
  let cpuCount = 0;
  activePlayers.forEach((cfg, i) => {
    const spawn = field.spawns[i] || field.spawns[0];
    const slot = { idx: i, x: spawn[0], y: spawn[1] };
    /* Scheme is bound to the slot's active position (matches lobby.js).
       Toggling a slot from human to CPU keeps later humans' bindings
       intact — their schemes don't shift up. */
    const scheme = cfg.mode === 'human' ? (HUMAN_SCHEMES[i] || null) : null;
    players.push(createPlayer(slot, scheme, cfg.id, cfg.mode, cfg.name, baseSpeed));
    if(cfg.mode === 'cpu'){
      /* First CPU per match is "nice", later ones get "mean" — keeps things
         interesting when several CPUs are in play.  Easy to tune later. */
      const level = cpuCount === 0 ? 'nice' : 'mean';
      cpus.set(i, createCpuController(level));
      cpuCount++;
    }
  });

  const bombs = [];
  const explosions = [];
  const pickups = [];                     // power-ups sitting on the board
  const bombByTile = new Map();
  const pickupByTile = new Map();         // 'x,y' -> pickup id
  let pendingEvents = [];
  const prevBomb = new Map();

  const goodieFreq = lobby.goodieFreq != null ? lobby.goodieFreq : 1;
  const dropChance = DROP_CHANCE[goodieFreq] ?? DROP_CHANCE[1];

  /* Slow callback handed to applyPickup so it can affect other players. */
  function slowOthers(self, durationSec){
    for(const other of players){
      if(other === self || !other.alive) continue;
      other.slowUntil = Math.max(other.slowUntil || 0, elapsed + durationSec);
    }
  }

  /* Round-tracking. */
  let elapsed = 0;
  const kosByIdx = new Map();         // idx -> kills this round (excl. self-KOs)
  let roundEndedFired = false;

  /* What CPUs see on every tick.  Live references — they read the same arrays
     gameplay mutates each tick, so the CPU is always reasoning about the
     current world. */
  const cpuView = {
    field, bombs, pickups, players,
    get elapsed(){ return elapsed; },
  };

  let rafHandle = null;
  let timeoutHandle = null;
  let lastTime = 0;
  let running = false;

  function tick(now){
    if(!running) return;
    if(!lastTime) lastTime = now;
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    elapsed += dt;

    /* 1. Apply input — humans from keyboard, CPUs from their controller. */
    for(const p of players){
      if(!p.alive){ continue; }

      let r;
      if(p.type === 'human' && p.scheme){
        const wasBomb = prevBomb.get(p.idx) || false;
        r = input.read(p.scheme, wasBomb);
      } else if(p.type === 'cpu'){
        const cpu = cpus.get(p.idx);
        if(!cpu){ continue; }
        const action = cpu.decide(p, cpuView);
        const wasBomb = prevBomb.get(p.idx) || false;
        r = {
          dx: action.dx, dy: action.dy, bomb: action.bomb,
          bombEdge: action.bomb && !wasBomb,
        };
      } else if(p.type === 'remote'){
        const action = remoteInputProvider(p.idx) || { dx:0, dy:0, bomb:false };
        const wasBomb = prevBomb.get(p.idx) || false;
        r = {
          dx: action.dx | 0, dy: action.dy | 0, bomb: !!action.bomb,
          bombEdge: !!action.bomb && !wasBomb,
        };
      } else {
        continue;   // 'off' — filtered above, but safe
      }
      prevBomb.set(p.idx, r.bomb);

      const ghosting = elapsed < (p.ghostUntil || 0);
      const solid = new Set();
      if(!ghosting){
        for(const b of bombs){
          if(!p.passthrough.has(b.id)) solid.add(b.x + ',' + b.y);
        }
      }

      /* Kick: if pressing into a bomb directly in front of us and hasKick,
         start the bomb sliding in our move direction.  We still don't move
         (the bomb still blocks us) — classic Bomberman foot-tap behaviour. */
      if(p.hasKick && (r.dx !== 0 || r.dy !== 0)){
        const dirX = Math.abs(r.dx) >= Math.abs(r.dy) ? Math.sign(r.dx) : 0;
        const dirY = dirX === 0 ? Math.sign(r.dy) : 0;
        if(dirX !== 0 || dirY !== 0){
          const myTx = Math.floor(p.x), myTy = Math.floor(p.y);
          const targetX = myTx + dirX, targetY = myTy + dirY;
          const bombId = bombByTile.get(targetX + ',' + targetY);
          if(bombId != null){
            const target = bombs.find(b => b.id === bombId);
            if(target && !target.kickDir){
              target.kickDir = { dx: dirX, dy: dirY };
              target.kickNextStep = elapsed + KICK_STEP_INTERVAL;
              /* The kicker no longer passes through it — they kicked it,
                 they can't follow into the same tile. */
              p.passthrough.delete(target.id);
            }
          }
        }
      }

      stepPlayer(p, r.dx, r.dy, dt, field, solid, elapsed);

      if(p.passthrough.size > 0){
        const overlap = new Set(tilesUnderPlayer(p).map(([x,y]) => x+','+y));
        for(const id of [...p.passthrough]){
          const b = bombs.find(x => x.id === id);
          if(!b || !overlap.has(b.x+','+b.y)) p.passthrough.delete(id);
        }
      }

      /* Pickup detection: any pickup tile we now overlap is collected. */
      for(const [tx, ty] of tilesUnderPlayer(p)){
        const key = tx + ',' + ty;
        const pid = pickupByTile.get(key);
        if(pid != null){
          const pi = pickups.findIndex(x => x.id === pid);
          if(pi >= 0){
            const pu = pickups[pi];
            applyPickup(p, pu.type, { elapsed, slowOthers });
            pickups.splice(pi, 1);
            pickupByTile.delete(key);
            pendingEvents.push({ type: 'pickupTaken', idx: p.idx, pickup: pu });
          }
        }
      }

      /* Bomb placement, with remote-detonate fallback when at max. */
      if(r.bombEdge){
        if(p.bombsLive < p.bombMax){
          const tx = Math.floor(p.x);
          const ty = Math.floor(p.y);
          if(field.at(tx, ty) === TILE.FLOOR && !bombByTile.has(tx+','+ty)){
            const fullRange = p.hasSuper ? Math.max(field.width, field.height) : p.range;
            /* Boomerang primes the placed bomb: first wave uses a tiny range,
               and the engine schedules a second wave at fullRange after a
               short delay.  Super still wins on its own bomb. */
            const range = p.hasBoomerang ? BOOMERANG_FIRST_RANGE : fullRange;
            const bomb = createBomb({ ownerIdx: p.idx, x: tx, y: ty, range });
            if(p.hasRemote) bomb.fuse = Infinity;
            if(p.hasSuper){ bomb.super = true; p.hasSuper = false; }
            if(p.hasBoomerang){
              bomb.boomerang = { phase: 1, fullRange, delay: BOOMERANG_SECOND_DELAY };
              p.hasBoomerang = false;
            }
            bombs.push(bomb);
            bombByTile.set(tx+','+ty, bomb.id);
            p.bombsLive++;
            p.passthrough.add(bomb.id);
            pendingEvents.push({ type: 'bombPlaced', bomb });
          }
        } else if(p.hasRemote){
          /* At max — remote-detonate every bomb of mine that's still ticking. */
          for(const b of bombs){
            if(b.ownerIdx === p.idx && !b.detonating){
              b.detonating = true;
            }
          }
        }
      }
    }

    /* 2a. Step kicked bombs — one tile per KICK_STEP_INTERVAL until they hit
       an obstacle (wall, box, another bomb, or a player). */
    for(const b of bombs){
      if(!b.kickDir) continue;
      if(elapsed < (b.kickNextStep || 0)) continue;
      const nx = b.x + b.kickDir.dx, ny = b.y + b.kickDir.dy;
      let blocked = field.at(nx, ny) !== TILE.FLOOR;
      if(!blocked && bombByTile.has(nx + ',' + ny)) blocked = true;
      if(!blocked){
        for(const other of players){
          if(!other.alive) continue;
          if(playerOnTile(other, nx, ny)){ blocked = true; break; }
        }
      }
      if(blocked){
        b.kickDir = null;
        b.kickNextStep = 0;
      } else {
        bombByTile.delete(b.x + ',' + b.y);
        b.x = nx; b.y = ny;
        bombByTile.set(b.x + ',' + b.y, b.id);
        b.kickNextStep = elapsed + KICK_STEP_INTERVAL;
      }
    }

    /* 2b. Magnet pull — players with hasMagnet drag nearby pickups one tile
       closer along the dominant axis at MAGNET_STEP_INTERVAL cadence. */
    for(const holder of players){
      if(!holder.alive || !holder.hasMagnet) continue;
      const hx = Math.floor(holder.x), hy = Math.floor(holder.y);
      for(const pu of pickups){
        const dx = hx - pu.x, dy = hy - pu.y;
        const manhattan = Math.abs(dx) + Math.abs(dy);
        if(manhattan === 0 || manhattan > MAGNET_RADIUS) continue;
        if(elapsed < (pu.nextMagnetStep || 0)) continue;
        const stepX = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0;
        const stepY = stepX === 0 ? Math.sign(dy) : 0;
        const nx = pu.x + stepX, ny = pu.y + stepY;
        if(field.at(nx, ny) !== TILE.FLOOR) continue;
        if(pickupByTile.has(nx + ',' + ny)) continue;
        pickupByTile.delete(pu.x + ',' + pu.y);
        pu.x = nx; pu.y = ny;
        pickupByTile.set(pu.x + ',' + pu.y, pu.id);
        pu.nextMagnetStep = elapsed + MAGNET_STEP_INTERVAL;
      }
    }

    /* 3. Tick fuses. */
    for(const b of bombs){
      if(b.detonating) continue;
      b.fuse -= dt;
      if(b.fuse <= 0) b.detonating = true;
    }

    /* 3. Resolve detonations + chain reactions. */
    const queue = bombs.filter(b => b.detonating);
    while(queue.length){
      const b = queue.shift();
      const idx = bombs.indexOf(b);
      if(idx >= 0) bombs.splice(idx, 1);
      bombByTile.delete(b.x+','+b.y);
      const owner = players.find(p => p.idx === b.ownerIdx);
      /* Boomerang phase-1 keeps the bombsLive slot occupied — the second
         wave we spawn below releases it. */
      const isBoomerangPhase1 = b.boomerang && b.boomerang.phase === 1;
      if(owner && !isBoomerangPhase1) owner.bombsLive = Math.max(0, owner.bombsLive - 1);

      const segs = computeExplosionSegments(field, b.x, b.y, b.range);
      explosions.push({ segments: segs, ttl: EXPLOSION_TTL });
      pendingEvents.push({ type: 'bombDetonated', bomb: b, segments: segs });

      for(const s of segs){
        /* Step 1: burn any pre-existing pickup on this tile (before we
           potentially drop a fresh one as a result of breaking a box). */
        const preBurnId = pickupByTile.get(s.x+','+s.y);
        if(preBurnId != null){
          const pi = pickups.findIndex(x => x.id === preBurnId);
          if(pi >= 0){
            pickups.splice(pi, 1);
            pickupByTile.delete(s.x+','+s.y);
            pendingEvents.push({ type: 'pickupBurned', x: s.x, y: s.y });
          }
        }
        if(field.at(s.x, s.y) === TILE.BOX){
          field.set(s.x, s.y, TILE.FLOOR);
          pendingEvents.push({ type: 'boxBroken', x: s.x, y: s.y });
          if(Math.random() < dropChance){
            const type = pickRandomPickup();
            const pickup = createPickup(type, s.x, s.y);
            pickups.push(pickup);
            pickupByTile.set(s.x+','+s.y, pickup.id);
            pendingEvents.push({ type: 'pickupDropped', pickup });
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
          /* Use tolerance-aware hit test: a sprite that just barely
             grazes a blast tile (≤ 25 % of body extent into the tile)
             survives.  This forgives slight off-centre positions during
             corner turns. */
          if(playerHitByBlast(p, s.x, s.y)){
            /* Shield absorbs one full hit before death. */
            if(p.shieldStacks > 0){
              p.shieldStacks -= 1;
              pendingEvents.push({ type: 'shieldUsed', idx: p.idx });
              continue;
            }
            p.alive = false;
            if(b.ownerIdx !== p.idx){
              kosByIdx.set(b.ownerIdx, (kosByIdx.get(b.ownerIdx) || 0) + 1);
            }
            pendingEvents.push({ type: 'playerKilled', idx: p.idx, by: b.ownerIdx });
          }
        }
      }

      /* Schedule the second wave AFTER segment processing — otherwise the
         phase-2 bomb would sit in bombByTile during phase-1's center-tile
         chain check and detonate immediately. */
      if(isBoomerangPhase1){
        const phase2 = createBomb({
          ownerIdx: b.ownerIdx, x: b.x, y: b.y, range: b.boomerang.fullRange,
        });
        phase2.fuse = b.boomerang.delay;
        phase2.boomerang = { phase: 2 };
        bombs.push(phase2);
        bombByTile.set(phase2.x+','+phase2.y, phase2.id);
        if(owner) owner.passthrough.add(phase2.id);
      }
    }

    /* 4. Decay explosions. */
    for(const e of explosions) e.ttl -= dt;
    for(let i = explosions.length - 1; i >= 0; i--){
      if(explosions[i].ttl <= 0) explosions.splice(i, 1);
    }

    /* 5. Round-end check (fires once). */
    if(!roundEndedFired){
      const result = checkRoundEnd();
      if(result){
        roundEndedFired = true;
        if(hooks.onRoundEnd) hooks.onRoundEnd(result);
      }
    }

    /* 6. Render hooks. */
    if(hooks.onTick) hooks.onTick(dt);
    if(hooks.onEvents && pendingEvents.length){
      hooks.onEvents(pendingEvents);
      pendingEvents = [];
    }
    if(hooks.onRender) hooks.onRender();

    scheduleNext();
  }

  function checkRoundEnd(){
    const alive = players.filter(p => p.alive);
    const total = players.length;
    const baseResult = (winnerIdx, reason) => ({
      winnerIdx,
      durationSec: elapsed,
      kos: new Map(kosByIdx),
      reason,
    });
    if(total >= 2 && alive.length <= 1){
      return baseResult(alive[0]?.idx ?? null, 'last-standing');
    }
    if(total === 1 && alive.length === 0){
      return baseResult(null, 'self-ko');
    }
    if(timeLimit > 0 && elapsed >= timeLimit){
      return baseResult(alive.length === 1 ? alive[0].idx : null, 'timeout');
    }
    return null;
  }

  function scheduleNext(){
    if(!running) return;
    rafHandle = null; timeoutHandle = null;
    if(document.hidden){
      timeoutHandle = setTimeout(() => tick(performance.now()), 33);
    } else {
      rafHandle = requestAnimationFrame(tick);
    }
  }

  function onVisibilityChange(){
    if(!running) return;
    if(!document.hidden && !rafHandle){
      if(timeoutHandle){ clearTimeout(timeoutHandle); timeoutHandle = null; }
      rafHandle = requestAnimationFrame(tick);
    }
  }

  return {
    field,
    players,
    bombs,
    explosions,
    pickups,
    presetId,
    timeLimit,
    get elapsed(){ return elapsed; },
    start(){
      running = true;
      lastTime = 0;
      document.addEventListener('visibilitychange', onVisibilityChange);
      scheduleNext();
    },
    stop(){
      running = false;
      if(rafHandle){ cancelAnimationFrame(rafHandle); rafHandle = null; }
      if(timeoutHandle){ clearTimeout(timeoutHandle); timeoutHandle = null; }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      input.teardown();
    },
  };
}

export { TILE, CONTROL_SCHEMES };
