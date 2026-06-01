// ============================================================================
//  STEEL YARD — simulation core (engine-agnostic, testable headless)
//  Networking abstracted behind NetAdapter. LocalAdapter today; FirebaseAdapter
//  later implements the same interface and game logic never changes.
// ============================================================================

// === SIMULATION RATE ===
// The server simulates at 30 Hz (Render Free = 0.1 CPU can't sustain 60 Hz; the
// catch-up loop caused multi-step bursts -> double shots, stutter, freezes).
// All per-step distances are doubled and all frame-based durations are halved so
// the game plays at the SAME real-world speed/timing it did at 60 Hz. Clients
// still render at 60 fps via interpolation, so motion stays smooth.
const SIM_HZ = 30;
const CFG = {
  arenaW: 760, arenaH: 560, tile: 40,
  baseSpeed: 7.0,          // 3.5 px/step @60 -> 7.0 px/step @30 (same px/sec)
  speedMult: 1.357,        // multiplier, rate-independent
  baseAccel: 1.2, baseFric: 0.74,
  tank: { radius: 14, accel: 1.2, maxSpd: 7.0, friction: 0.74 }, // maxSpd mirrors baseSpeed
  bot: {
    accel: 1.2, maxSpd: 7.0, friction: 0.74,  // SAME physics as human (fairness); only the brain differs
    aimError: 0.15, reactRange: 1000,
    fireCooldown: 22, avoidLookahead: 28,      // 44 frames @60 -> 22 @30
  },
  bullet: { radius: 4, speed: 12.0, life: 55, dmg: 1 },     // speed x2, life /2
  breacherBullet: { radius: 9, speed: 10.0, life: 75 },     // speed x2, life /2
  rapidSpread: 0.087,      // ~5 degrees cone for rapid auto-fire
  fireCooldown: 18, startLives: 3, respawnInvuln: 40,       // 36->18, 80->40 frames
  netInputTTL: 30,         // remote input is reused for up to ~1s (30 frames @30Hz) if no fresh packet
  // per-power-up durations (frames @30fps): rapid 5s, breacher 6s, speed 7s, shield 8s, tiny 7s
  dur: { rapid:150, breacher:180, speed:210, shield:240, tiny:210 },  // all /2
  maxActivePowerups: 3,    // only 3 timed power-ups active at once; 4th drops the oldest
  matchSeconds: 60, brickHP: 2,
  beaconSeconds: 9,        // countdown per beacon (9->0 = 10s)
  pickup: { max: 4 },      // one item per beacon
  itemWeights: { steel:1, rapid:1, speed:1, breacher:1, hull:0.5, tiny:1 }, // hull rarer (boring)
  spawnBlast: { radius: 58, dmg: 1 }, // anti-spawncamp explosion on respawn / item destruction
  startShield: 60,         // 2s shield on spawn @30 (was 120 @60)
  respawnDelay: 60,        // 2s before a killed tank respawns @30 (was 120 @60)
  tinyScale: 0.5,          // TinyTank: half size / half collision
};

const PALETTE = [
  { id:'red',    hex:'#ff4d3b', name:'BLAZE' },
  { id:'blue',   hex:'#4d9fff', name:'FROST' },
  { id:'green',  hex:'#6fdc5a', name:'VIPER' },
  { id:'yellow', hex:'#ffcf3f', name:'SPARK' },
  { id:'orange', hex:'#a0633a', name:'RUST'  },
  { id:'purple', hex:'#b27bff', name:'HEX'   },
  { id:'pink',   hex:'#ff79c6', name:'NOVA'  },
  { id:'cyan',   hex:'#3fe0d8', name:'TIDE'  },
];

const NAME_POOL = ['RUST','VIPER','BOXER','NOMAD','HAVOC','TREAD','GROM','IRONSIDE',
  'BADGER','COBALT','SCRAP','HOWL','DIESEL','MAW','PIVOT','GHOST','BRUNO','TANKA',
  'OXIDE','KRAKEN','RIVET','SLEDGE','DUST','VANDAL','HOVER','NICO','BOLT','FANG'];

const COLS = Math.floor(CFG.arenaW / CFG.tile);
const ROWS = Math.floor(CFG.arenaH / CFG.tile);

// 4 spawn corners (tile coords + pixel center)
const SPAWN_TILES = [
  { c:1, r:ROWS-2 },        // bottom-left
  { c:COLS-2, r:1 },        // top-right
  { c:COLS-2, r:ROWS-2 },   // bottom-right
  { c:1, r:1 },             // top-left
];
function spawnPx(s){ return { x:s.c*CFG.tile+CFG.tile/2, y:s.r*CFG.tile+CFG.tile/2 }; }

function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function shuffleLocal(a){ const b=a.slice(); for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];} return b; }

// ---------------------------------------------------------------------------
//  PROCEDURAL MAP — symmetric (4-fold mirror), validated so no spawn is sealed.
//  grid value: 0 open, 1 brick (destructible), 2 steel (solid)
// ---------------------------------------------------------------------------
function generateMap() {
  for (let attempt=0; attempt<80; attempt++) {
    const grid = Array.from({length:ROWS}, ()=>new Array(COLS).fill(0));
    const halfC = Math.ceil(COLS/2), halfR = Math.ceil(ROWS/2);
    const mc=Math.floor(COLS/2), mr=Math.floor(ROWS/2);

    // generate one quadrant, then mirror into the other three for fairness
    for (let r=0;r<halfR;r++){
      for (let c=0;c<halfC;c++){
        const nearSpawn = (c<=2 && r<=2);
        if (nearSpawn) continue;
        // never steel on the mid lines OR the quadrant-edge columns/rows
        // (those are what visually "divide the arena", so keep them light)
        const onMidCol = (c>=mc-1 && c<=mc+1) || (c>=COLS-2-mc && c<=COLS-mc);
        const onMidRow = (r>=mr-1 && r<=mr+1) || (r>=ROWS-2-mr && r<=ROWS-mr);
        const rnd = Math.random();
        let v = 0;
        if (rnd < 0.07 && !onMidCol && !onMidRow) v = 2;  // steel: rarer, never near mid
        else if (rnd < 0.30) v = 1;                        // brick
        if (v) {
          grid[r][c] = v;
          grid[r][COLS-1-c] = v;
          grid[ROWS-1-r][c] = v;
          grid[ROWS-1-r][COLS-1-c] = v;
        }
      }
    }

    // central steel anchor (small, symmetric)
    [[0,0],[-1,0],[1,0],[0,-1],[0,1]].forEach(([dc,dr])=>{
      const c=mc+dc, r=mr+dr; if(c>=0&&c<COLS&&r>=0&&r<ROWS) grid[r][c]=2;
    });

    // force-clear a 3x3 around every tank spawn
    for (const s of SPAWN_TILES){
      for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
        const c=s.c+dc, r=s.r+dr;
        if(c>=0&&c<COLS&&r>=0&&r<ROWS) grid[r][c]=0;
      }
    }

    // BEACONS: pick one position inside the top-left quadrant, then MIRROR it to
    // all four quadrants. Keep it in the OUTER part of the quadrant (away from the
    // mid-lines) so mirrored beacons are always far apart, never two adjacent at center.
    const bcMax = Math.min(halfC-1, mc-3);   // stay >=3 tiles from the vertical mid-line
    const brMax = Math.min(halfR-1, mr-3);   // stay >=3 tiles from the horizontal mid-line
    const bc = 3 + Math.floor(Math.random()*Math.max(1,(bcMax-3)));
    const br = 3 + Math.floor(Math.random()*Math.max(1,(brMax-3)));
    const itemTiles = [
      { c: bc,            r: ROWS-1-br },  // bottom-left
      { c: COLS-1-bc,     r: br },         // top-right
      { c: COLS-1-bc,     r: ROWS-1-br },  // bottom-right
      { c: bc,            r: br },         // top-left
    ];
    // de-steel a ring around each beacon so it's reachable & not walled
    for(const it of itemTiles){
      for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
        const c=it.c+dc, r=it.r+dr;
        if(c<0||c>=COLS||r<0||r>=ROWS)continue;
        if(grid[r][c]===2) grid[r][c]=0;
      }
    }

    if (validateReachability(grid, itemTiles)) {
      const hp = Array.from({length:ROWS}, (_,r)=>
        Array.from({length:COLS}, (_,c)=> grid[r][c]===1 ? CFG.brickHP : 0));
      return { grid, hp, itemTiles };
    }
  }
  // fallback safe map
  const grid = Array.from({length:ROWS}, ()=>new Array(COLS).fill(0));
  const hp = Array.from({length:ROWS}, ()=>new Array(COLS).fill(0));
  return { grid, hp, itemTiles: computeItemTiles() };
}

// fallback beacon positions (symmetric)
function computeItemTiles(){
  const bc=4, br=4;
  return [
    { c: bc,        r: ROWS-1-br },
    { c: COLS-1-bc, r: br },
    { c: COLS-1-bc, r: ROWS-1-br },
    { c: bc,        r: br },
  ];
}
function _unused_computeItemTiles(rng){
  const rand = rng || Math.random;
  const zones=[
    { cMin:3, cMax:6,        rMin:ROWS-7, rMax:ROWS-4 },
    { cMin:COLS-7, cMax:COLS-4, rMin:3, rMax:6 },
    { cMin:COLS-7, cMax:COLS-4, rMin:ROWS-7, rMax:ROWS-4 },
    { cMin:3, cMax:6,        rMin:3, rMax:6 },
  ];
  return zones.map(z=>({
    c: z.cMin + Math.floor(rand()*(z.cMax-z.cMin+1)),
    r: z.rMin + Math.floor(rand()*(z.rMax-z.rMin+1)),
  }));
}

function validateReachability(grid, itemTiles) {
  // Flood-fill #1: connectivity through OPEN tiles only (real driving paths,
  // no need to shoot through brick). All 4 spawns must share one open region.
  function floodOpen(){
    const passable=(c,r)=> c>=0&&c<COLS&&r>=0&&r<ROWS && grid[r][c]===0;
    const start=SPAWN_TILES[0];
    const seen=Array.from({length:ROWS},()=>new Array(COLS).fill(false));
    const stack=[[start.c,start.r]]; seen[start.r][start.c]=true;
    while(stack.length){
      const [c,r]=stack.pop();
      for(const [dc,dr] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nc=c+dc,nr=r+dr;
        if(passable(nc,nr)&&!seen[nr][nc]){seen[nr][nc]=true;stack.push([nc,nr]);}
      }
    }
    return seen;
  }
  const seen=floodOpen();
  // every spawn reachable purely by open tiles from spawn 0
  for(const s of SPAWN_TILES){ if(!seen[s.r][s.c]) return false; }
  // every beacon tile reachable too
  if(itemTiles){ for(const it of itemTiles){ if(!seen[it.r][it.c]) return false; } }
  // each spawn must have at least one open neighbor (escape exists)
  for(const s of SPAWN_TILES){
    let openN=0;
    for(const [dc,dr] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nc=s.c+dc,nr=s.r+dr;
      if(nc>=0&&nc<COLS&&nr>=0&&nr<ROWS&&grid[nr][nc]===0) openN++;
    }
    if(openN===0) return false;
  }
  return true;
}

// ============================================================================
//  LOCAL ADAPTER
//  participants: array of {kind:'human'|'cpu', name, colorId, isHost, betOn?}
//  localId is the human/host player id; in spectator mode it's the bet target.
// ============================================================================
class LocalAdapter {
  constructor(participants) {
    const map = generateMap();
    this.grid = map.grid; this.hp = map.hp; this.itemTiles = map.itemTiles;
    this.bullets = []; this.pickups = []; this.events = []; this.floaters = [];
    this.frame = 0; this._running = true;
    this._pickupSeq = 0;          // FIFO ordering id
    this.timeLeft = CFG.matchSeconds;
    this._tickAcc = 0;
    this.startCountdown = 3;      // 3..2..1..GO! gate before input is live
    this._startAcc = 0;
    this.live = false;            // becomes true after GO!

    // BEACONS: one per quadrant node. Each counts down from beaconSeconds.
    // state: 'counting' (ticking) | 'occupied' (frozen at 9, holds an item)
    this.beacons = this.itemTiles.map((it,idx)=>({
      idx, c:it.c, r:it.r,
      x: it.c*CFG.tile+CFG.tile/2, y: it.r*CFG.tile+CFG.tile/2,
      count: CFG.beaconSeconds, state:'counting',
    }));
    this._beaconAcc = 0;

    // shuffle-bag for item types (true-ish variety, no long repeats)
    this._typeBag = [];

    const personalities = ['hunter','ambusher','forager','wanderer'];
    const spawns = shuffle([0,1,2,3]);
    this.players = participants.map((p, i)=>{
      const st = SPAWN_TILES[spawns[i]];
      const px = spawnPx(st);
      const hex = PALETTE.find(c=>c.id===p.colorId)?.hex || '#fff';
      let pers = p.personality && p.personality!=='random' ? p.personality : null;
      return {
        id: 'P'+i, name: p.name, color: hex, colorId: p.colorId,
        kind: p.kind, isHost: !!p.isHost,
        personality: pers,
        x: px.x, y: px.y, vx:0, vy:0, spawnX:px.x, spawnY:px.y,
        bodyAng: Math.random()*6.28, aimX:1, aimY:0,
        lives: CFG.startLives, kills:0, alive:true,
        cooldown:0, invuln: CFG.respawnInvuln,
        botCd: Math.random()*60, wanderX:Math.random()*2-1, wanderY:Math.random()*2-1,
        retargetCd:0, currentTarget:null,
        shield:CFG.startShield, rapidFire:0, speedster:0, breacher:0, tiny:0, hitFlash:0, // 2s spawn shield
        puOrder:[],     // FIFO order of active TIMED power-ups for the 3-max cap
        deathAng:0,     // random rotation for the death stamp
        breakIntent:0, // frames the bot wants to shoot a wall to pass
      };
    });
    const taken = this.players.filter(p=>p.personality).map(p=>p.personality);
    let remaining = shuffle(personalities.filter(x=>!taken.includes(x)));
    for(const p of this.players){
      if(p.kind==='cpu' && !p.personality){
        if(remaining.length) p.personality = remaining.shift();
        else p.personality = personalities[Math.floor(Math.random()*personalities.length)];
      }
    }

    const human = participants.findIndex(p=>p.kind==='human');
    this.localId = human>=0 ? 'P'+human : null;
    const betIdx = participants.findIndex(p=>p.betOn);
    this.betId = betIdx>=0 ? 'P'+betIdx : null;

    this.input = { mx:0, my:0, aimX:1, aimY:0, shoot:false };
    this.winner = null;
  }

  _refillBag(){
    // weighted shuffle bag honoring fractional weights (scale up so 0.5 stays rarer than 1)
    const bag=[];
    for(const [type,w] of Object.entries(CFG.itemWeights)){
      const n=Math.max(1, Math.round(w*2)); // x2 scale: weight 1 -> 2 copies, 0.5 -> 1 copy
      for(let i=0;i<n;i++) bag.push(type);
    }
    this._typeBag = shuffle(bag);
  }
  _nextType(){
    if(!this._typeBag || this._typeBag.length===0) this._refillBag();
    return this._typeBag.pop();
  }

  getPlayers(){ return this.players; }
  sendInput(i){ this.input = i; }

  _solidAt(px,py){
    const c=Math.floor(px/CFG.tile), r=Math.floor(py/CFG.tile);
    if(c<0||c>=COLS||r<0||r>=ROWS) return false;
    return this.grid[r][c]!==0;
  }
  _collideTank(px,py,r){
    const pts=[[px-r,py],[px+r,py],[px,py-r],[px,py+r],[px-r*0.7,py-r*0.7],[px+r*0.7,py+r*0.7],[px-r*0.7,py+r*0.7],[px+r*0.7,py-r*0.7]];
    for(const [x,y] of pts) if(this._solidAt(x,y)) return true;
    return false;
  }
  _move(p,dx,dy,maxSpd,fric){
    // SHMUP movement: velocity = direction * speed, instantly. No accel, no friction.
    const boosting = p.speedster>0;
    const spd = boosting ? CFG.baseSpeed*CFG.speedMult : maxSpd;
    const rad = CFG.tank.radius*(p.tiny>0?CFG.tinyScale:1);
    const mag = Math.hypot(dx,dy);
    if(mag>0.001){
      p.vx = dx/mag*spd; p.vy = dy/mag*spd;   // full speed in input direction
      p.bodyAng = Math.atan2(p.vy,p.vx);
    } else {
      p.vx = 0; p.vy = 0;                      // release -> instant stop
    }
    let nx=p.x+p.vx, ny=p.y+p.vy;
    if(this._collideTank(nx,p.y,rad)){nx=p.x;p.vx=0;}
    if(this._collideTank(p.x,ny,rad)){ny=p.y;p.vy=0;}
    p.x=Math.max(rad,Math.min(CFG.arenaW-rad,nx));
    p.y=Math.max(rad,Math.min(CFG.arenaH-rad,ny));
  }
  _fire(p){
    if(p.cooldown>0||!p.alive) return;
    const rapid = p.rapidFire>0;
    let a=Math.atan2(p.aimY,p.aimX);
    if(rapid) a += (Math.random()*2-1)*CFG.rapidSpread; // ~5° cone
    const breach = p.breacher>0;
    const bdef = breach ? CFG.breacherBullet : CFG.bullet;
    this.bullets.push({
      x:p.x+Math.cos(a)*(CFG.tank.radius+8), y:p.y+Math.sin(a)*(CFG.tank.radius+8),
      vx:Math.cos(a)*bdef.speed, vy:Math.sin(a)*bdef.speed,
      life:bdef.life, owner:p.id, color:p.color,
      breach,                       // breacher: one-hit-kill + breaks metal
      breaksBrick: rapid || breach, // rapid also smashes brick (the "downside")
      radius:bdef.radius });
    // cooldown by combo @30Hz (halved from the 60Hz values): normal=18, breacher=24,
    // rapid=6 (gatling), rapid+breacher=12 (penalized vs plain gatling).
    let cd;
    if(rapid && breach) cd = 12;
    else if(rapid)      cd = 6;
    else if(breach)     cd = 24;
    else                cd = CFG.fireCooldown;  // 18
    p.cooldown = cd;
    this.events.push({t:'shot',x:p.x+Math.cos(a)*18,y:p.y+Math.sin(a)*18,ang:a,breach});
  }
  _damageBrick(c,r,instant){
    if(this.grid[r][c]!==1) return;
    const cx=c*CFG.tile+CFG.tile/2, cy=r*CFG.tile+CFG.tile/2;
    if(instant){ this.hp[r][c]=0; this.grid[r][c]=0; this.events.push({t:'brickbreak',x:cx,y:cy}); return; }
    this.hp[r][c]-=1;
    if(this.hp[r][c]<=0){ this.grid[r][c]=0; this.events.push({t:'brickbreak',x:cx,y:cy}); }
    else this.events.push({t:'brickhit',x:cx,y:cy});
  }
  _breakSteel(c,r){
    if(this.grid[r][c]!==2) return;
    this.grid[r][c]=0;
    const cx=c*CFG.tile+CFG.tile/2, cy=r*CFG.tile+CFG.tile/2;
    this.events.push({t:'steelshatter',x:cx,y:cy});
  }

  // ---- bot brain with 4 personalities ----
  //  hunter:   chases NEAREST enemy, aggressive, fires a lot
  //  ambusher: targets FARTHEST enemy / cuts angles, medium aggression
  //  forager:  prioritizes items, only fights when cornered
  //  wanderer: erratic, swaps targets often, roams
  _botThink(p){
    const enemies=this.players.filter(o=>o.id!==p.id && o.alive);
    let ax=0,ay=0, desiredX=0, desiredY=0;
    const pers=p.personality||'hunter';

    // pick target according to personality (with retarget cadence)
    if(p.retargetCd>0) p.retargetCd--;
    let target=null;
    if(enemies.length){
      if(pers==='hunter'){
        let best=1e9; for(const o of enemies){const d=Math.hypot(o.x-p.x,o.y-p.y);if(d<best){best=d;target=o;}}
      } else if(pers==='ambusher'){
        let far=-1; for(const o of enemies){const d=Math.hypot(o.x-p.x,o.y-p.y);if(d>far){far=d;target=o;}}
      } else if(pers==='wanderer'){
        if(!p.currentTarget || p.retargetCd<=0 || !enemies.includes(p.currentTarget)){
          p.currentTarget=enemies[Math.floor(Math.random()*enemies.length)]; p.retargetCd=120+Math.random()*120;
        }
        target=p.currentTarget;
      } else { // forager: nearest only as fallback
        let best=1e9; for(const o of enemies){const d=Math.hypot(o.x-p.x,o.y-p.y);if(d<best){best=d;target=o;}}
      }
    }

    // find nearest pickup
    let pk=null,pb=1e9;
    for(const k of this.pickups){const d=Math.hypot(k.x-p.x,k.y-p.y);if(d<pb){pb=d;pk=k;}}

    // ---- forager: go for items first ----
    if(pers==='forager' && pk){
      const kdx=pk.x-p.x,kdy=pk.y-p.y,kd=Math.hypot(kdx,kdy)||1;
      desiredX=kdx/kd; desiredY=kdy/kd;
      // aim at and shoot nearby threats opportunistically
      if(target){const tdx=target.x-p.x,tdy=target.y-p.y,td=Math.hypot(tdx,tdy)||1;
        p.aimX=tdx/td;p.aimY=tdy/td;
        if(p.botCd<=0 && td<320){this._fire(p);p.botCd=CFG.bot.fireCooldown+Math.random()*30;}}
    }
    else if(target){
      const dx=target.x-p.x, dy=target.y-p.y, d=Math.hypot(dx,dy)||1;
      const aimA=Math.atan2(dy,dx)+(Math.random()*2-1)*CFG.bot.aimError;
      p.aimX=Math.cos(aimA); p.aimY=Math.sin(aimA);

      // engagement distance + aggression vary by personality
      let want=200, fireRange=560, aggr=1;
      if(pers==='hunter'){ want=120; fireRange=650; aggr=1.2; }      // gets in your face
      else if(pers==='ambusher'){ want=340; fireRange=520; aggr=0.8; } // snipes from afar
      else if(pers==='wanderer'){ want=230; fireRange=480; aggr=0.7; }

      const dir = d>want?1:(d<want*0.7?-0.7:0.15);
      desiredX = dx/d*dir; desiredY = dy/d*dir;
      // strafe
      desiredX += -dy/d*0.5*p.wanderX; desiredY += dx/d*0.5*p.wanderX;
      // light pickup magnet if very close on the way
      if(pk && pb<120){const kdx=pk.x-p.x,kdy=pk.y-p.y,kd=Math.hypot(kdx,kdy)||1;desiredX+=kdx/kd*0.5;desiredY+=kdy/kd*0.5;}
      // fire
      const cd = pers==='hunter'? CFG.bot.fireCooldown : CFG.bot.fireCooldown/aggr;
      if(p.botCd<=0 && d<fireRange){ this._fire(p); p.botCd=cd+Math.random()*20; }
    } else {
      // no target: roam
      p.wanderX+=(Math.random()*2-1)*0.06;
      desiredX=p.wanderX; desiredY=p.wanderY;
      const aa=Math.atan2(desiredY||0.01,desiredX||0.01); p.aimX=Math.cos(aa); p.aimY=Math.sin(aa);
    }

    // ---- WALL-BREAKING AGGRESSION (hacky, no A*) ----
    // If a wall sits between the bot and its target/desired direction, shoot it
    // open instead of only steering around. Once broken, normal nav+combat resumes.
    if(target){
      const tdx=target.x-p.x, tdy=target.y-p.y, td=Math.hypot(tdx,tdy)||1;
      const dirx=tdx/td, diry=tdy/td;
      // sample a couple tiles ahead toward target for a wall
      let wallAhead=null;
      for(let step=CFG.tile*0.8; step<=CFG.tile*2.2; step+=CFG.tile*0.7){
        const sx=p.x+dirx*step, sy=p.y+diry*step;
        const c=Math.floor(sx/CFG.tile), r=Math.floor(sy/CFG.tile);
        if(c>=0&&c<COLS&&r>=0&&r<ROWS&&this.grid[r][c]!==0){ wallAhead={c,r,sx,sy}; break; }
      }
      // line-of-sight clear? (no wall between us and target within range)
      const losBlocked = wallAhead && td < 360;
      if(losBlocked){
        p.breakIntent = 30;
      }
      if(p.breakIntent>0 && wallAhead){
        // aim at the blocking wall and fire to clear a path
        const wa=Math.atan2(wallAhead.sy-p.y, wallAhead.sx-p.x);
        p.aimX=Math.cos(wa); p.aimY=Math.sin(wa);
        if(p.botCd<=0){ this._fire(p); p.botCd=CFG.bot.fireCooldown*0.8; }
        p.breakIntent--;
      }
    }

    // ---- WALL AVOIDANCE + STUCK ESCAPE ----
    const dm=Math.hypot(desiredX,desiredY)||1; desiredX/=dm; desiredY/=dm;
    const look=CFG.bot.avoidLookahead;

    // if currently in an escape maneuver, follow it
    if(p.escapeCd>0){
      desiredX=p.escapeX; desiredY=p.escapeY; p.escapeCd--;
    } else {
      // probe ahead; if blocked, steer to whichever perpendicular side is open
      if(this._solidAt(p.x+desiredX*look, p.y+desiredY*look)){
        const perpX=-desiredY, perpY=desiredX;
        const leftOpen = !this._solidAt(p.x+perpX*look, p.y+perpY*look);
        const rightOpen= !this._solidAt(p.x-perpX*look, p.y-perpY*look);
        if(leftOpen && !rightOpen){ desiredX=perpX; desiredY=perpY; }
        else if(rightOpen && !leftOpen){ desiredX=-perpX; desiredY=-perpY; }
        else if(leftOpen && rightOpen){ const s=p.wanderX>0?1:-1; desiredX=perpX*s; desiredY=perpY*s; }
        else { desiredX=-desiredX; desiredY=-desiredY; } // both blocked: back out
      }
    }

    // STUCK DETECTION: barely moved over last frames despite wanting to → escape
    const moved = Math.hypot(p.x-(p._lastX??p.x), p.y-(p._lastY??p.y));
    p._lastX=p.x; p._lastY=p.y;
    p._stuckAcc = moved < 0.4 ? (p._stuckAcc||0)+1 : 0;
    if(p._stuckAcc > 12 && p.escapeCd<=0){
      // pick a random open cardinal direction to break free
      const dirs=shuffleLocal([[1,0],[-1,0],[0,1],[0,-1]]);
      for(const [ex,ey] of dirs){
        if(!this._solidAt(p.x+ex*look*1.5, p.y+ey*look*1.5)){
          p.escapeX=ex; p.escapeY=ey; p.escapeCd=30; break;
        }
      }
      p._stuckAcc=0;
    }

    // border push toward center (gentle, only very close to edge)
    const margin=CFG.tile*0.8;
    if(p.x<margin) desiredX=Math.abs(desiredX)+0.5;
    if(p.x>CFG.arenaW-margin) desiredX=-Math.abs(desiredX)-0.5;
    if(p.y<margin) desiredY=Math.abs(desiredY)+0.5;
    if(p.y>CFG.arenaH-margin) desiredY=-Math.abs(desiredY)-0.5;

    ax=desiredX; ay=desiredY;

    if(p.botCd>0)p.botCd--;
    if(Math.random()<0.015) p.wanderX=Math.random()*2-1;
    this._move(p,ax,ay,CFG.bot.maxSpd,CFG.bot.friction);
  }

  _respawn(p){
    p.x=p.spawnX;p.y=p.spawnY;p.vx=0;p.vy=0;p.alive=true;
    p.lives=CFG.startLives;          // RESET lives on respawn (was the grey-pellet / 1-life bug)
    p.invuln=CFG.respawnInvuln;      // brief blink, kept as visual
    p.shield=CFG.startShield; // 2s shield (unified start+respawn)
    p.rapidFire=0;p.speedster=0;p.breacher=0;p.tiny=0;p.puOrder=[];
    this.events.push({t:'spawnscore',x:p.x,y:p.y,color:p.color,score:p.kills}); // current score on respawn
    // anti-spawncamp blast: damages others nearby (not self); breaks brick around
    this.events.push({t:'spawnblast',x:p.x,y:p.y,color:p.color});
    const pc=Math.floor(p.x/CFG.tile), pr=Math.floor(p.y/CFG.tile);
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
      const c=pc+dc,r=pr+dr;
      if(c>=0&&c<COLS&&r>=0&&r<ROWS&&this.grid[r][c]===1){ this.hp[r][c]=0; this.grid[r][c]=0;
        this.events.push({t:'brickbreak',x:c*CFG.tile+CFG.tile/2,y:r*CFG.tile+CFG.tile/2}); }
    }
    for(const o of this.players){
      if(o.id===p.id||!o.alive||o.invuln>0||o.shield>0)continue;
      if(Math.hypot(o.x-p.x,o.y-p.y) < CFG.spawnBlast.radius){
        o.alive=false;o.lives=0; o.kills=Math.max(0,o.kills-1);
        o.deathAng=Math.random()*Math.PI*2;
        p.kills++;
        this.events.push({t:'killscore',x:p.x,y:p.y,color:p.color,score:p.kills,rank:this._topStatus(p)}); // killer's updated score + top status
        this.events.push({t:'explosion',x:o.x,y:o.y,color:o.color});
        this._clearBullets(o.id);
        o.respawnAt=this.frame+CFG.respawnDelay;
      }
    }
  }

  // beacon-driven item spawn: each free beacon counts 9->0; at 0 it spawns an item
  // (pulling from the global shuffle bag). Occupied beacons stay frozen.
  _beaconTick(){
    for(const b of this.beacons){ if(b.state==='counting' && b.count>0) b.count--; }
    // EVERY beacon that reached 0 spawns its own item
    const ready = this.beacons.filter(b=>b.state==='counting' && b.count<=0);
    for(const b of ready){
      this._spawnAtBeacon(b);
    }
    // any still-counting (non-occupied) beacon that hit 0 but didn't spawn resets
    for(const b of this.beacons){ if(b.state==='counting' && b.count<=0){ b.count=CFG.beaconSeconds; } }
  }

  _spawnAtBeacon(beacon){
    const type=this._nextType();
    // FIFO cap at max: removing oldest frees its beacon
    if(this.pickups.length>=CFG.pickup.max){
      this.pickups.sort((a,b)=>a._seq-b._seq);
      const old=this.pickups.shift();
      this.events.push({t:'itemexpire',x:old.x,y:old.y});
      const ob=this.beacons.find(b=>b.idx===old._node);
      if(ob){ ob.state='counting'; ob.count=CFG.beaconSeconds; }
    }
    beacon.state='occupied'; // frozen until item taken
    this.pickups.push({x:beacon.x,y:beacon.y,type,bob:Math.random()*6.28,_seq:this._pickupSeq++,_node:beacon.idx});
    this.events.push({t:'itemspawn',x:beacon.x,y:beacon.y,kind:type});
  }

  // 3x3 explosion when an item is shot (like the anti-camper blast): breaks brick around it
  _itemBlast(k){
    this.events.push({t:'spawnblast',x:k.x,y:k.y,color:'#fff'});
    this.events.push({t:'itemdestroyed',x:k.x,y:k.y,label:'ITEM DESTROYED'});
    const pc=Math.floor(k.x/CFG.tile), pr=Math.floor(k.y/CFG.tile);
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
      const c=pc+dc,r=pr+dr;
      if(c>=0&&c<COLS&&r>=0&&r<ROWS&&this.grid[r][c]===1){ this.hp[r][c]=0; this.grid[r][c]=0;
        this.events.push({t:'brickbreak',x:c*CFG.tile+CFG.tile/2,y:r*CFG.tile+CFG.tile/2}); }
    }
  }

  // centralized death (normal kill: -1 to victim floored at 0; optional killer +1)
  // is this player currently at the top? 'first' (strictly highest), 'tied' (shares max), or null
  _topStatus(pl){
    const max=Math.max(...this.players.map(x=>x.kills));
    if(pl.kills<max) return null;
    const atMax=this.players.filter(x=>x.kills===max).length;
    return atMax>1 ? 'tied' : 'first';
  }
  // when a tank dies, all of ITS in-flight bullets wink out (no kills from the grave)
  _clearBullets(ownerId){
    for(let i=this.bullets.length-1;i>=0;i--){
      if(this.bullets[i].owner===ownerId){
        this.events.push({t:'bulletfizzle',x:this.bullets[i].x,y:this.bullets[i].y});
        this.bullets.splice(i,1);
      }
    }
  }
  _killTank(victim, killerId){
    victim.alive=false; victim.lives=0;
    if(killerId){ const k=this.players.find(x=>x.id===killerId); if(k && k.id!==victim.id){ k.kills++; this.events.push({t:'killscore',x:k.x,y:k.y,color:k.color,score:k.kills,rank:this._topStatus(k)}); } }
    victim.kills=Math.max(0, victim.kills-1);
    victim.deathAng=Math.random()*Math.PI*2;  // random rotation for the death stamp
    this.events.push({t:'explosion',x:victim.x,y:victim.y,color:victim.color});
    this._clearBullets(victim.id);
    victim.respawnAt=this.frame+CFG.respawnDelay;
  }

  // tank-on-tank contact: both explode (or both lose shield); shield saves you
  _tankTouch(){
    const ps=this.players.filter(p=>p.alive);
    for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){
      const a=ps[i],b=ps[j];
      if(a.invuln>0||b.invuln>0) continue;
      if(Math.hypot(a.x-b.x,a.y-b.y) < CFG.tank.radius*2 - 2){
        const aS=a.shield>0, bS=b.shield>0;
        if(aS||bS){
          // anyone shielded loses the shield (and survives this tick); unshielded dies
          if(aS){ a.shield=0; this.events.push({t:'shieldbreak',x:a.x,y:a.y,color:a.color}); }
          else { this._killTank(a, null); }
          if(bS){ b.shield=0; this.events.push({t:'shieldbreak',x:b.x,y:b.y,color:b.color}); }
          else { this._killTank(b, null); }
        } else {
          // neither shielded -> both explode, normal deaths (-1 each, floored)
          this._killTank(a, null);
          this._killTank(b, null);
        }
      }
    }
  }

  step(){
    if(!this._running) return;
    this.frame++;

    // ---- START COUNTDOWN GATE: 3..2..1..GO! before anything is live ----
    if(!this.live){
      this._startAcc++;
      if(this._startAcc>=25){ // ~0.83s per number @30Hz
        this._startAcc=0;
        this.startCountdown--;
        if(this.startCountdown>0){ this.events.push({t:'countbeep',n:this.startCountdown}); }
        else { this.live=true; this.events.push({t:'go'});
          for(const p of this.players) this.events.push({t:'spawnscore',x:p.x,y:p.y,color:p.color,score:p.kills});
        }
      }
      // freeze: no input, no AI, no timer, no bullets while counting in
      return;
    }

    // timer (assume ~60fps)
    this._tickAcc++;
    if(this._tickAcc>=SIM_HZ){ this._tickAcc=0; this.timeLeft--; if(this.timeLeft<=0){ this._endByTime(); } }

    const me=this.localId? this.players.find(p=>p.id===this.localId):null;
    if(me && me.kind==='human' && me.alive){
      me.aimX=this.input.aimX; me.aimY=this.input.aimY;
      this._move(me,this.input.mx,this.input.my,CFG.tank.maxSpd,CFG.tank.friction);
      if(this.input.shoot) this._fire(me);   // _fire respects cooldown -> held = auto-fire
    }
    // REMOTE humans: drive each from its latest network input. Hold-to-fire works
    // because _fire is gated by cooldown. The input is stamped with the sim frame it
    // arrived; if no fresh input comes for a while we stop reusing a stale one (so a
    // dropped "released" packet can't keep the tank moving/shooting forever).
    for(const p of this.players){
      if(p.kind==='remote' && p.alive && p._netInput){
        const ni=p._netInput;
        const fresh = (p._netInputFrame!=null) && (this.frame - p._netInputFrame) <= CFG.netInputTTL;
        p.aimX=ni.aimX; p.aimY=ni.aimY;
        if(fresh){
          this._move(p,ni.mx,ni.my,CFG.tank.maxSpd,CFG.tank.friction);
          if(ni.shoot) this._fire(p);
        } else {
          this._move(p,0,0,CFG.tank.maxSpd,CFG.tank.friction);  // stale input -> coast to stop, no fire
        }
      }
    }
    for(const p of this.players){
      if(p.kind==='cpu' && p.alive) this._botThink(p);
    }
    for(const p of this.players){
      if(p.cooldown>0)p.cooldown--; if(p.invuln>0)p.invuln--; if(p.hitFlash>0)p.hitFlash--;
      // all power-ups are timed now (shield/speed too). Spawn shield (<1e8) also ticks.
      const expire=(field,announce)=>{
        if(p[field]>0){ p[field]--; if(p[field]===0){
          const idx=p.puOrder.indexOf(field); if(idx>=0)p.puOrder.splice(idx,1);
          if(announce) this.events.push({t:'powerdown',x:p.x,y:p.y});
        } }
      };
      expire('rapidFire',true);
      expire('breacher',true);
      expire('speedster',false);
      expire('tiny',false);
      // shield: spawn shield (small value) ticks silently; pickup shield announces on expiry
      if(p.shield>0){ const wasPickup=p.shield>CFG.startShield; p.shield--; if(p.shield===0){
        const idx=p.puOrder.indexOf('shield'); if(idx>=0)p.puOrder.splice(idx,1);
      } }
      // AUTO-FIRE: rapid makes the tank fire continuously without input
      if(p.alive && p.rapidFire>0 && p.cooldown<=0) this._fire(p);
      if(!p.alive && p.respawnAt && this.frame>=p.respawnAt){ p.respawnAt=0; this._respawn(p); }
    }

    // BEACONS: tick once per second
    this._beaconAcc++;
    if(this._beaconAcc>=SIM_HZ){ this._beaconAcc=0; this._beaconTick(); }

    // pickups: timed power-ups (rapid/breacher/speed/shield/tiny) + instant HULL heal.
    // Max 3 TIMED active at once; grabbing a 4th drops the oldest (FIFO).
    for(let i=this.pickups.length-1;i>=0;i--){
      const k=this.pickups[i];
      for(const p of this.players){
        if(!p.alive)continue;
        const rad = CFG.tank.radius*(p.tiny>0?CFG.tinyScale:1);
        if(Math.hypot(p.x-k.x,p.y-k.y)<rad+13){
          if(k.type==='hull'){
            p.lives=CFG.startLives;            // HULL: full repair, instant (not a timed slot)
          } else {
            // map type -> player field + duration
            const field={steel:'shield',speed:'speedster',rapid:'rapidFire',breacher:'breacher',tiny:'tiny'}[k.type];
            const dur ={steel:CFG.dur.shield,speed:CFG.dur.speed,rapid:CFG.dur.rapid,breacher:CFG.dur.breacher,tiny:CFG.dur.tiny}[k.type];
            // FIFO cap: if not already active and 3 are active, drop the oldest
            if(!(p[field]>0)){
              if(p.puOrder.length>=CFG.maxActivePowerups){
                const oldest=p.puOrder.shift();
                p[oldest]=0;
                this.events.push({t:'powerdown',x:p.x,y:p.y});
              }
              p.puOrder.push(field);
            }
            p[field]=dur;
          }
          const label={steel:'SHIELD!',rapid:'RAPID!',speed:'SPEED!',breacher:'BREACHER!',hull:'HULL!',tiny:'TINY!'}[k.type];
          this.events.push({t:'pickup',x:k.x,y:k.y,kind:k.type,playerId:p.id,label});
          const b=this.beacons.find(bb=>bb.idx===k._node);
          if(b){ b.state='counting'; b.count=CFG.beaconSeconds; }
          this.pickups.splice(i,1); break;
        }
      }
    }

    // bullets
    for(let i=this.bullets.length-1;i>=0;i--){
      const b=this.bullets[i]; if(!b) continue;   // guard: _clearBullets may have spliced concurrently
      b.x+=b.vx;b.y+=b.vy;b.life--;
      const br=b.radius||CFG.bullet.radius;
      let dead=b.life<=0||b.x<0||b.x>CFG.arenaW||b.y<0||b.y>CFG.arenaH;
      // a bullet that hits an ITEM destroys it with a 3x3 blast (items are now breakable)
      if(!dead){
        for(let pi=this.pickups.length-1;pi>=0;pi--){
          const k=this.pickups[pi];
          if(Math.hypot(k.x-b.x,k.y-b.y) < CFG.tank.radius+br){
            dead=true;
            this._itemBlast(k);
            const fb=this.beacons.find(bb=>bb.idx===k._node);
            if(fb){ fb.state='counting'; fb.count=CFG.beaconSeconds; }
            this.pickups.splice(pi,1);
            break;
          }
        }
      }
      if(!dead){
        const c=Math.floor(b.x/CFG.tile),r=Math.floor(b.y/CFG.tile);
        if(c>=0&&c<COLS&&r>=0&&r<ROWS&&this.grid[r][c]!==0){
          if(this.grid[r][c]===1){
            if(b.breaksBrick) this._damageBrick(c,r,b.breach); // breach=instant, rapid=normal dmg
            else { this._damageBrick(c,r,false); } // plain bullets still chip brick
            dead=true;
          }
          else { // steel — only the breacher breaks it
            if(b.breach){ this._breakSteel(c,r); dead=true; }
            else { dead=true; this.events.push({t:'spark',x:b.x,y:b.y}); }
          }
        }
      }
      if(!dead){
        for(const p of this.players){
          if(!p.alive||p.id===b.owner||p.invuln>0)continue;
          const prad=CFG.tank.radius*(p.tiny>0?CFG.tinyScale:1);
          if(Math.hypot(p.x-b.x,p.y-b.y)<prad+br){
            dead=true;
            if(p.shield>0){
              // shield absorbs ANY hit (incl. breacher one-shot) and breaks
              p.shield=0; this.events.push({t:'shieldbreak',x:p.x,y:p.y,color:p.color});
            } else {
              // breacher = instant kill; normal = 1 life
              const lethal = b.breach || (p.lives-CFG.bullet.dmg)<=0;
              if(!b.breach) p.lives-=CFG.bullet.dmg;
              this.events.push({t:'hit',x:p.x,y:p.y,color:p.color});
              if(lethal){
                p.alive=false;p.lives=0;
                const killer=this.players.find(k=>k.id===b.owner);
                if(killer && killer.id!==p.id){ killer.kills++; this.events.push({t:'killscore',x:killer.x,y:killer.y,color:killer.color,score:killer.kills,rank:this._topStatus(killer)}); }
                p.kills=Math.max(0, p.kills-1);
                p.deathAng=Math.random()*Math.PI*2;  // random rotation for the death stamp
                this.events.push({t:'explosion',x:p.x,y:p.y,color:p.color});
                (this._deferredClear||(this._deferredClear=[])).push(p.id);
                p.respawnAt=this.frame+CFG.respawnDelay;
              } else {
                p.hitFlash=4; // brief white flash on surviving a hit
              }
            }
            break;
          }
        }
      }
      if(dead){ this.events.push({t:'boom',x:b.x,y:b.y,breach:b.breach}); this.bullets.splice(i,1); }
    }
    // flush deferred bullet-clears (deaths that happened during the bullet loop)
    if(this._deferredClear && this._deferredClear.length){
      for(const id of this._deferredClear) this._clearBullets(id);
      this._deferredClear.length=0;
    }

    // tank-on-tank contact (mutual explosion / shield logic)
    this._tankTouch();
  }

  _endByTime(){
    this._running=false;
    const ranked=[...this.players].sort((a,b)=>b.kills-a.kills);
    this.winner=ranked[0];
    this.ranking=ranked;
    this.events.push({t:'matchend'});
  }
}

// export for headless test
if (typeof module!=='undefined') module.exports={CFG,PALETTE,NAME_POOL,COLS,ROWS,SPAWN_TILES,SIM_HZ,generateMap,validateReachability,LocalAdapter,shuffle,spawnPx,computeItemTiles};
