/* Keyboard input system.
   - Tracks pressed keys globally while the game is active.
   - Maps named control schemes to logical actions (up/down/left/right/bomb).
   - Only one input system is mounted at a time; teardown removes listeners. */

export const CONTROL_SCHEMES = {
  wasd:   { up:'KeyW',     down:'KeyS',      left:'KeyA',      right:'KeyD',      bomb:'Space'      },
  arrows: { up:'ArrowUp',  down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight', bomb:'ShiftRight' },
  ijkl:   { up:'KeyI',     down:'KeyK',      left:'KeyJ',      right:'KeyL',      bomb:'KeyN'       },
  numpad: { up:'Numpad8',  down:'Numpad5',   left:'Numpad4',   right:'Numpad6',   bomb:'Numpad0'    },
};

/* Pretty labels for the lobby — keep in sync with CONTROL_SCHEMES keys. */
export const SCHEME_LABEL = {
  wasd:   'WASD + SPACE',
  arrows: 'ARROWS + RSHIFT',
  ijkl:   'IJKL + N',
  numpad: 'NUMPAD 8456 + 0',
};

export function createInput(){
  const pressed = new Set();
  const keydown = (e) => {
    pressed.add(e.code);
    /* Stop arrow keys from scrolling the page during play. */
    if(e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  };
  const keyup = (e) => { pressed.delete(e.code); };
  const blur = () => { pressed.clear(); };

  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);
  window.addEventListener('blur', blur);

  return {
    /* Returns axis vector for the given control source plus bomb-edge flag.
       The source can be either a preset name in CONTROL_SCHEMES (string)
       or a bindings object {up, down, left, right, bomb} directly — the
       lobby uses the latter when a player has rebound their keys. */
    read(source, prevBomb){
      const c = (typeof source === 'string') ? CONTROL_SCHEMES[source] : source;
      if(!c) return { dx:0, dy:0, bomb:false, bombEdge:false };
      const dx = (pressed.has(c.left) ? -1 : 0) + (pressed.has(c.right) ? 1 : 0);
      const dy = (pressed.has(c.up)   ? -1 : 0) + (pressed.has(c.down)  ? 1 : 0);
      const bomb = pressed.has(c.bomb);
      return { dx, dy, bomb, bombEdge: bomb && !prevBomb };
    },
    isDown(code){ return pressed.has(code); },
    teardown(){
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
      pressed.clear();
    },
  };
}
