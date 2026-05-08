/* Game engine — owns state, runs the rAF loop, mediates between
   field/players/input/bombs and the rendering DOM in screens/game.js.

   The engine is rendering-agnostic: it tells the renderer what changed and
   the renderer decides how to draw. */

import { createField, FIELD_PRESETS, TILE } from './field.js';
import { createInput, CONTROL_SCHEMES } from './input.js';
import { createPlayer, stepPlayer, tilesUnderPlayer } from './players.js';
import { createBomb, computeExplosionSegments, playerOnTile, EXPLOSION_TTL } from './bombs.js';

/* The first 4 humans get keyboards, in declaration order. */
const HUMAN_SCHEMES = ['wasd', 'arrows', 'ijkl', 'numpad'];

export function createEngine(lobby, hooks){
  const presetId = lobby.fieldSize in FIELD_PRESETS ? lobby.fieldSize : 'medium';
  const activePlayers = lobby.players.filter(p => p.mode !== 'off');
  const field = createField(presetId, activePlayers.length);
  const input = createInput();

  /* Build players: pull spawn positions from the field, hand keyboards to humans. */
  const players = [];
  let humanCount = 0;
  activePlayers.forEach((cfg, i) => {
    const spawn = field.spawns[i] || field.spawns[0];
    const slot = { idx: i, x: spawn[0], y: spawn[1] };
    let scheme = null;
    if(cfg.mode === 'human'){
      scheme = HUMAN_SCHEMES[humanCount] || null;
      humanCount++;
    }
    players.push(createPlayer(slot, scheme, cfg.id, cfg.mode, cfg.name));
  });

  const bombs = [];           // active bombs ticking down
  const explosions = [];      // visible flashes; damage is applied at detonation
  /* Reverse index (`x,y` → bomb id) so we can answer "is there a bomb here?" in O(1). */
  const bombByTile = new Map();
  /* Outgoing events for renderer to consume between ticks. */
  let pendingEvents = [];

  /* Track previous bomb-key state per player for edge detection. */
  const prevBomb = new Map();

  let rafHandle = null;
  let timeoutHandle = null;
  let lastTime = 0;
  let running = false;

  function tick(now){
    if(!running) return;
    if(!lastTime) lastTime = now;
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    /* 1. Apply input: move humans + maybe place bombs. */
    for(const p of players){
      if(!p.alive){ continue; }
      if(p.type !== 'human' || !p.scheme){ continue; }

      const wasBomb = prevBomb.get(p.idx) || false;
      const r = input.read(p.scheme, wasBomb);
      prevBomb.set(p.idx, r.bomb);

      /* Solid-bomb tiles for this player = every bomb NOT in their passthrough set. */
      const solid = new Set();
      for(const b of bombs){
        if(!p.passthrough.has(b.id)) solid.add(b.x + ',' + b.y);
      }
      stepPlayer(p, r.dx, r.dy, dt, field, solid);

      /* Refresh passthrough: drop bombs whose tile we no longer touch. */
      if(p.passthrough.size > 0){
        const overlap = new Set(tilesUnderPlayer(p).map(([x,y]) => x+','+y));
        for(const id of [...p.passthrough]){
          const b = bombs.find(x => x.id === id);
          if(!b || !overlap.has(b.x+','+b.y)) p.passthrough.delete(id);
        }
      }

      /* Bomb placement on the rising edge of the bomb key. */
      if(r.bombEdge && p.bombsLive < p.bombMax){
        const tx = Math.floor(p.x);
        const ty = Math.floor(p.y);
        if(field.at(tx, ty) === TILE.FLOOR && !bombByTile.has(tx+','+ty)){
          const bomb = createBomb({ ownerIdx: p.idx, x: tx, y: ty, range: p.range });
          bombs.push(bomb);
          bombByTile.set(tx+','+ty, bomb.id);
          p.bombsLive++;
          /* The owner can stand on the bomb until they leave its tile. */
          p.passthrough.add(bomb.id);
          pendingEvents.push({ type: 'bombPlaced', bomb });
        }
      }
    }

    /* 2. Tick fuses; mark expired bombs for detonation. */
    for(const b of bombs){
      if(b.detonating) continue;
      b.fuse -= dt;
      if(b.fuse <= 0) b.detonating = true;
    }

    /* 3. Resolve detonations (with chain reactions). */
    const queue = bombs.filter(b => b.detonating);
    while(queue.length){
      const b = queue.shift();
      /* Remove the bomb from active lists. */
      const idx = bombs.indexOf(b);
      if(idx >= 0) bombs.splice(idx, 1);
      bombByTile.delete(b.x+','+b.y);
      const owner = players.find(p => p.idx === b.ownerIdx);
      if(owner) owner.bombsLive = Math.max(0, owner.bombsLive - 1);

      const segs = computeExplosionSegments(field, b.x, b.y, b.range);
      explosions.push({ segments: segs, ttl: EXPLOSION_TTL });
      pendingEvents.push({ type: 'bombDetonated', bomb: b, segments: segs });

      /* Apply destruction + damage in one pass. */
      for(const s of segs){
        /* Boxes turn into floor (Etappe 4 will optionally drop a power-up). */
        if(field.at(s.x, s.y) === TILE.BOX){
          field.set(s.x, s.y, TILE.FLOOR);
          pendingEvents.push({ type: 'boxBroken', x: s.x, y: s.y });
        }
        /* Chain: any other bomb sitting on this tile detonates this same frame. */
        const chainId = bombByTile.get(s.x+','+s.y);
        if(chainId){
          const chained = bombs.find(x => x.id === chainId);
          if(chained && !chained.detonating){
            chained.detonating = true;
            queue.push(chained);
          }
        }
        /* Players on this tile die. */
        for(const p of players){
          if(!p.alive) continue;
          if(playerOnTile(p, s.x, s.y)){
            p.alive = false;
            pendingEvents.push({ type: 'playerKilled', idx: p.idx, by: b.ownerIdx });
          }
        }
      }
    }

    /* 4. Decay visible explosions. */
    for(const e of explosions) e.ttl -= dt;
    for(let i = explosions.length - 1; i >= 0; i--){
      if(explosions[i].ttl <= 0) explosions.splice(i, 1);
    }

    /* 5. Hand control to renderer. */
    if(hooks.onTick) hooks.onTick(dt);
    if(hooks.onEvents && pendingEvents.length){
      hooks.onEvents(pendingEvents);
      pendingEvents = [];
    }
    if(hooks.onRender) hooks.onRender();

    scheduleNext();
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
    presetId,
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
