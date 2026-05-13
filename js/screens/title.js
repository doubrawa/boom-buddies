import { charSvg, bombSvg, sparkSvg, heartSvg, cloudSvg, flowerSvg, starSvg, icoSvg } from '../sprites.js';

export function render(ctx){
  const { app, navigate } = ctx;
  const section = document.createElement('section');
  section.className = 'screen active';
  section.innerHTML = `
    <div class="title">
      <div class="corner-bunting">
        <span class="flag"></span><span class="flag"></span><span class="flag"></span><span class="flag"></span>
        <span class="flag"></span><span class="flag"></span><span class="flag"></span><span class="flag"></span>
      </div>

      <div class="titlebadge"><span class="dot"></span>v0.3 · cozy build</div>

      <div class="stars">
        <span class="star" style="left:8%;top:14%" data-spr="star" data-size="22"></span>
        <span class="star" style="left:18%;top:6%;animation-delay:.4s" data-spr="star" data-size="16"></span>
        <span class="star" style="left:84%;top:8%;animation-delay:.7s" data-spr="star" data-size="22"></span>
        <span class="star" style="left:92%;top:24%;animation-delay:1.1s" data-spr="star" data-size="14"></span>
        <span class="star" style="left:6%;top:38%;animation-delay:.2s" data-spr="star" data-size="14"></span>
        <span class="star" style="left:88%;top:42%;animation-delay:1.3s" data-spr="star" data-size="20"></span>
      </div>
      <div class="clouds">
        <span class="cloud" style="left:6%;top:10%" data-spr="cloud" data-size="60"></span>
        <span class="cloud" style="right:6%;top:18%;animation-delay:1.5s" data-spr="cloud" data-size="80"></span>
        <span class="cloud" style="left:30%;top:48%;animation-delay:.7s" data-spr="cloud" data-size="50"></span>
      </div>

      <div class="logo-wrap">
        <h1 class="bigtitle">Mochi Mayhem</h1>
        <span class="subtitle">a cozy chaos game · 2-8 friends</span>
        <span class="logo-deco bomb" data-spr="bomb" data-size="100"></span>
        <span class="logo-deco spark" data-spr="spark" data-size="40"></span>
        <span class="logo-deco heart" data-spr="heart" data-size="50"></span>
      </div>

      <div class="menu">
        <button class="pillbtn primary" data-action="play">
          <span class="ic" data-spr="ico-play" data-size="18"></span>
          PLAY
          <span class="arr">›</span>
        </button>
        <button class="pillbtn" data-action="online-mp">
          <span class="ic" data-spr="ico-net" data-size="18"></span>
          ONLINE MULTIPLAYER
          <span class="arr">›</span>
        </button>
        <button class="pillbtn" data-action="highscores">
          <span class="ic" data-spr="ico-cup" data-size="18"></span>
          HIGHSCORES
          <span class="arr">›</span>
        </button>
      </div>

      <div class="title-mascots">
        <span class="mascot m1" data-spr="char" data-id="mochi"></span>
        <span class="mascot m2" data-spr="char" data-id="biscuit"></span>
        <span class="mascot m3" data-spr="char" data-id="bubble"></span>
        <span class="mascot m4" data-spr="char" data-id="plum"></span>
      </div>

      <div class="ground">
        <div class="grass">
          ${'<span></span>'.repeat(24)}
        </div>
        <span class="flower" style="left:8%" data-spr="flower" data-size="30"></span>
        <span class="flower" style="left:34%" data-spr="flower" data-size="30"></span>
        <span class="flower" style="left:62%" data-spr="flower" data-size="30"></span>
        <span class="flower" style="left:88%" data-spr="flower" data-size="30"></span>
      </div>
      <div class="credits">made with <span class="heart">♥</span> for cozy game nights</div>
    </div>
  `;
  app.appendChild(section);

  /* Fill sprite slots. */
  section.querySelectorAll('[data-spr]').forEach(el => {
    const k = el.getAttribute('data-spr');
    const sz = parseInt(el.getAttribute('data-size'), 10);
    if(k === 'star') el.appendChild(starSvg(sz));
    else if(k === 'cloud') el.appendChild(cloudSvg(sz));
    else if(k === 'bomb') el.appendChild(bombSvg(false, sz));
    else if(k === 'spark') el.appendChild(sparkSvg(sz));
    else if(k === 'heart') el.appendChild(heartSvg(sz));
    else if(k === 'flower') el.appendChild(flowerSvg(sz));
    else if(k === 'char') el.appendChild(charSvg(el.getAttribute('data-id'), { w: 140, h: 140 }));
    else if(k === 'ico-play') el.appendChild(icoSvg('play', sz));
    else if(k === 'ico-mp') el.appendChild(icoSvg('mp', sz));
    else if(k === 'ico-cog') el.appendChild(icoSvg('cog', sz));
    else if(k === 'ico-cup') el.appendChild(icoSvg('cup', sz));
    else if(k === 'ico-net') el.appendChild(icoSvg('net', sz));
  });

  section.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = btn.getAttribute('data-action');
      if(a === 'play') navigate('lobby');
      else if(a === 'online-mp') navigate('online-lobby');
      else if(a === 'highscores') alert('Highscores — coming soon');
    });
  });
}
