/* ======================================================
   BOOM BUDDIES — sprite library (v3 cozy / SVG)
   Symbols are defined once in index.html as <svg><defs>.
   This module exposes helpers that return SVG <use>
   elements wrapped in a sized <svg>. ====================================================== */

/* ----- the 8 buddies ----- */
export const CHARS = {
  mochi:   { name:'Mochi',   sym:'#ch-mochi',   color:'#ff9dbf', dark:'#c8567f' },
  bubble:  { name:'Bubble',  sym:'#ch-bubble',  color:'#a9d8ff', dark:'#5fa8d9' },
  biscuit: { name:'Biscuit', sym:'#ch-biscuit', color:'#ffd76b', dark:'#d9a740' },
  pickle:  { name:'Pickle',  sym:'#ch-pickle',  color:'#7fd4b3', dark:'#4ea484' },
  plum:    { name:'Plum',    sym:'#ch-plum',    color:'#c5a8ed', dark:'#9580c4' },
  sage:    { name:'Sage',    sym:'#ch-sage',    color:'#b8ead6', dark:'#7fb8a0' },
  daisy:   { name:'Daisy',   sym:'#ch-daisy',   color:'#ffc8a8', dark:'#d49377' },
  cocoa:   { name:'Cocoa',   sym:'#ch-cocoa',   color:'#a87a55', dark:'#7a5236' },
};

export const CHAR_IDS = Object.keys(CHARS);

/* ----- power-ups ----- */
/* Display metadata used everywhere a power-up is shown.
   `sym` is the SVG symbol id, `bg` is the background tint for the icon chip. */
export const PUPS = {
  bomb:   { nm:'Extra Bomb',  ds:'+1 carry slot',          sym:'#pu-bomb',   bg:'#b8ead6' },
  fire:   { nm:'Bigger Boom', ds:'+1 blast tile',          sym:'#pu-flame',  bg:'#ffc8a8' },
  remote: { nm:'Remote',      ds:'detonate on tap',        sym:'#pu-remote', bg:'#b8ead6' },
  shield: { nm:'Shield',      ds:'tank one hit',           sym:'#pu-shield', bg:'#cfe9ff' },
  ghost:  { nm:'Ghost',       ds:'phase through crates',   sym:'#pu-ghost',  bg:'#e0cef7' },
  slow:   { nm:'Slow-mo',     ds:'slows other buddies',    sym:'#pu-clock',  bg:'#ffe9a8' },
  kick:   { nm:'Kick',        ds:'push bombs you bump',    sym:'#pu-kick',   bg:'#ffd0e0' },
  magnet: { nm:'Magnet',      ds:'pulls power-ups',        sym:'#pu-magnet', bg:'#ffd0d6' },
  curse:  { nm:'Curse',       ds:'rotten · 5s debuff',     sym:'#pu-skull',  bg:'#fff'    },
  hook:       { nm:'Hook',       ds:'grapple to a wall',     sym:'#pu-hook',       bg:'#cfe9ff' },
  dash:       { nm:'Dash',       ds:'sprint 2 tiles forward',sym:'#pu-dash',       bg:'#e0cef7' },
  earthquake: { nm:'Earthquake', ds:'bombs jiggle 3s',       sym:'#pu-earthquake', bg:'#ffd0d6' },
};

/* All powerup IDs in display order for the reference panel. */
export const ALL_PUP_IDS = ['fire','bomb','kick','shield','ghost','slow','magnet','remote','curse','hook','dash','earthquake'];

/* ====================================================
   Helpers — every function returns a real SVG element
   you can append to the DOM.
   ==================================================== */

/* Generic: make an <svg> referencing a <symbol> by id.
   `size` accepts a number (square) or a {w,h} object. */
export function svgRef(symbolId, size){
  const w = typeof size === 'number' ? size : (size?.w ?? 24);
  const h = typeof size === 'number' ? size : (size?.h ?? 24);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  if(typeof symbolId === 'string' && symbolId.startsWith('#')){
    svg.setAttribute('viewBox', '0 0 24 24');   // overridden by symbol's viewBox
  }
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', symbolId);
  svg.appendChild(use);
  return svg;
}

/* Specific helpers (more readable at call sites). */
export function charSvg(id, size){
  const c = CHARS[id]; if(!c) return svgRef('#ch-mochi', size);
  return svgRef(c.sym, size);
}
export function bombSvg(hot, size){
  return svgRef(hot ? '#bomb-hot' : '#bomb', size);
}
export function pupSvg(id, size){
  const p = PUPS[id]; if(!p) return svgRef('#pu-bomb', size);
  return svgRef(p.sym, size);
}
export function icoSvg(kind, size){
  return svgRef('#ic-' + kind, size);
}
export function crownSvg(size){
  if(typeof size === 'number') size = { w: size * 1.6, h: size };
  return svgRef('#crown', size);
}
export function heartSvg(size){
  return svgRef('#heart', size);
}
export function sparkSvg(size){
  return svgRef('#spark', size);
}
export function cloudSvg(size){
  if(typeof size === 'number') size = { w: size * 2, h: size };
  return svgRef('#cloud', size);
}
export function flowerSvg(size){
  if(typeof size === 'number') size = { w: size * 0.75, h: size };
  return svgRef('#flower', size);
}
export function starSvg(size){
  return svgRef('#dstar', size);
}
export function blastCenterSvg(size){
  return svgRef('#blast', size);
}
export function blastArmSvg(size, vertical){
  const svg = svgRef('#blast-arm', size);
  if(vertical) svg.style.transform = 'rotate(90deg)';
  return svg;
}
