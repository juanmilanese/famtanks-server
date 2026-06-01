// ============================================================
// FAM Tanks — authoritative WebSocket game server
// The server runs the real simulation (core.js). Clients send
// input and receive full-frame snapshots. Low latency vs Firebase.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const sim = require('./core.js');
const { CFG, PALETTE, LocalAdapter } = sim;

// Bump this by hand whenever you change the server. Lets you confirm at a glance
// (in the boot logs AND at /health) that Render is running your latest push.
const SERVER_VERSION = 'v9 — 30Hz + net diag (ping)';
const BOOT_TIME = new Date().toISOString();

const PORT = process.env.PORT || 8080;

// the game client lives next to this file in the repo
const CLIENT_FILE = path.join(__dirname, 'FAMTanks.html');

// ---- HTTP server: serves the game at / and a health probe at /health ----
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('FAM Tanks server OK\nversion: ' + SERVER_VERSION + '\nbooted: ' + BOOT_TIME + '\nrooms: ' + rooms.size);
    return;
  }
  if (url === '/' || url === '/index.html' || url === '/FAMTanks.html') {
    fs.readFile(CLIENT_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Client not found on server. Did you push FAMTanks.html to the repo?');
        return;
      }
      // no-cache so players always get the freshest build after a deploy
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server });

// ============================================================
// ROOMS
// ============================================================
const rooms = new Map();   // code -> Room
const WORDS = ['RUST','IRON','DUNE','NOVA','ECHO','VOLT','ASH','FROST','EMBER','HAVOC','ONYX','JADE'];
function makeCode(){
  let c; do { c = WORDS[(Math.random()*WORDS.length)|0] + '-' + (10 + (Math.random()*89|0)); } while(rooms.has(c));
  return c;
}

const SIM_DT = 1000/30;          // 30 simulation steps per second (sustainable on Free 0.1 CPU)
const SNAP_EVERY = 1;            // publish a snapshot every step -> 30/sec

class Room {
  constructor(code){
    this.code = code;
    this.players = new Map();    // ws -> { id, name, colorId, ready, kind:'human' }
    this.host = null;            // ws of the host (first to create)
    this.phase = 'lobby';        // 'lobby' | 'playing' | 'ended'
    this.adapter = null;         // LocalAdapter while playing
    this.loop = null;
    this.snapAcc = 0;
    this.idMap = null;           // roster slot id -> final player id
  }

  broadcast(obj){
    const msg = JSON.stringify(obj);
    for (const ws of this.players.keys()){ if (ws.readyState===1) ws.send(msg); }
  }

  rosterArray(){
    // 4 slots: assigned humans first (in join order), rest 'open'
    const arr = [];
    let idx = 0;
    for (const [ws,p] of this.players){ arr.push({ id:'P'+idx, name:p.name, colorId:p.colorId, kind:'human', ready:p.ready, isHost: ws===this.host }); idx++; }
    while (arr.length < 4) arr.push({ id:'P'+arr.length, name:'', colorId:null, kind:'open' });
    return arr;
  }

  sendLobby(){
    this.broadcast({ type:'lobby', code:this.code, roster:this.rosterArray(), phase:this.phase });
  }

  // resolve a colour clash: existing players keep theirs, the new one cedes
  resolveColor(want, exceptWs){
    const used = new Set();
    for (const [ws,p] of this.players){ if (ws!==exceptWs && p.colorId) used.add(p.colorId); }
    if (want && !used.has(want)) return want;
    const free = PALETTE.map(c=>c.id).filter(id=>!used.has(id));
    return free.length ? free[(Math.random()*free.length)|0] : (want||'green');
  }

  start(cpuFill){
    if (this.phase==='playing') return;
    // build participants from the connected humans, in join order
    const participants = [];
    const order = [];
    let i = 0;
    for (const [ws,p] of this.players){
      const id = 'P'+i;
      participants.push({ kind:'remote', name:p.name, colorId:p.colorId, isHost: ws===this.host, _ws: ws, _id:id });
      order.push({ ws, id });
      i++;
    }
    // fill empty slots with CPUs if requested
    if (cpuFill){
      const used = new Set(participants.map(pp=>pp.colorId));
      while (participants.length < 4){
        const free = PALETTE.map(c=>c.id).filter(id=>!used.has(id));
        const col = free.length ? free[0] : 'green';
        used.add(col);
        const cname = (PALETTE.find(c=>c.id===col)?.name || 'CPU') + '-CPU';
        participants.push({ kind:'cpu', name:cname, colorId:col, isHost:false });
      }
    }
    if (participants.length < 2){ this.broadcast({ type:'error', msg:'Need at least 2 tanks.' }); return; }

    // map each ws to its final player id (index in participants)
    this.wsToId = new Map();
    participants.forEach((pp,idx)=>{ if (pp._ws){ this.wsToId.set(pp._ws, 'P'+idx); } });

    // strip helper fields before handing to the sim
    const clean = participants.map(pp=>({ kind:pp.kind, name:pp.name, colorId:pp.colorId, isHost:pp.isHost }));
    this.adapter = new LocalAdapter(clean);
    // assign stable ids P0..Pn to the sim players (sim already does this in order)
    this.adapter.players.forEach((pl,idx)=>{ pl.id = 'P'+idx; });

    this.phase = 'playing';
    // tell every client the game is starting + which player id is theirs
    for (const [ws,p] of this.players){
      const myId = this.wsToId.get(ws);
      if (ws.readyState===1) ws.send(JSON.stringify({ type:'start', code:this.code, yourId: myId }));
    }
    this.startLoop();
  }

  startLoop(){
    this.stopLoop();
    let last = Date.now(), acc = 0;
    this.loop = setInterval(()=>{
      const now = Date.now(); let dt = now - last; last = now;
      if (dt > 250) dt = 250;
      acc += dt;
      let steps = 0;
      while (acc >= SIM_DT && steps < 8){
        this.adapter.step();
        acc -= SIM_DT; steps++;
        if (!this.adapter._running) break;
      }
      // publish snapshot at ~30/sec
      if ((this.snapAcc += steps) >= SNAP_EVERY){
        this.snapAcc = 0;
        this.publish();
      }
      if (!this.adapter._running){ this.endMatch(); }
    }, SIM_DT);
  }
  stopLoop(){ if (this.loop){ clearInterval(this.loop); this.loop = null; } }

  publish(){
    const s = this.adapter;
    const snap = {
      type:'snap', st:Date.now(), sv:SERVER_VERSION,
      live:s.live, timeLeft:s.timeLeft, running:s._running, startCountdown:s.startCountdown,
      players: s.players.map(p=>({ id:p.id, n:p.name, c:p.color, ci:p.colorId, k:p.kills,
        x:Math.round(p.x), y:Math.round(p.y), vx:+p.vx.toFixed(2), vy:+p.vy.toFixed(2),
        ba:+p.bodyAng.toFixed(2), ax:+p.aimX.toFixed(2), ay:+p.aimY.toFixed(2),
        sx:Math.round(p.spawnX), sy:Math.round(p.spawnY),
        lv:p.lives, al:p.alive?1:0, iv:p.invuln,
        sh:p.shield, rf:p.rapidFire, sp:p.speedster, br:p.breacher, ty:p.tiny, hf:p.hitFlash, da:+(p.deathAng||0).toFixed(2),
        as:(p._ackSeq||0) })),
      bullets: s.bullets.map(b=>({ x:Math.round(b.x), y:Math.round(b.y), vx:+b.vx.toFixed(2), vy:+b.vy.toFixed(2), c:b.color, br:b.breach?1:0, r:b.radius||3 })),
      pickups: s.pickups.map(k=>({ x:Math.round(k.x), y:Math.round(k.y), tp:k.type, sq:k._seq, bob:+(k.bob||0).toFixed(2) })),
      beacons: s.beacons.map(b=>({ i:b.idx, x:Math.round(b.x), y:Math.round(b.y), ct:b.count, st:b.state })),
      grid: this.gridStr(s.grid),
      hp: this.hpStr(s.hp, s.grid),
      ev: s.events.slice(),
    };
    s.events.length = 0;   // events consumed
    this.broadcast(snap);
  }
  gridStr(grid){ let str=''; for(let r=0;r<grid.length;r++) for(let c=0;c<grid[r].length;c++) str+=grid[r][c]; return str; }
  hpStr(hp,grid){ let str=''; for(let r=0;r<grid.length;r++) for(let c=0;c<grid[r].length;c++) str+=(grid[r][c]===1?(hp[r][c]||0):0); return str; }

  endMatch(){
    this.stopLoop();
    this.phase = 'ended';
    this.publish();   // final frame
    this.broadcast({ type:'ended' });
  }

  applyInput(ws, input){
    if (this.phase!=='playing' || !this.adapter) return;
    const id = this.wsToId && this.wsToId.get(ws);
    if (!id) return;
    const pl = this.adapter.players.find(p=>p.id===id);
    if (pl){
      pl._netInput = input;             // sim consumes this for remote players
      pl._netInputFrame = this.adapter.frame;  // stamp arrival frame (for stale-input TTL)
      if (typeof input.seq === 'number') pl._ackSeq = input.seq;  // last input we'll apply
    }
  }
}

// ============================================================
// CONNECTION HANDLING
// ============================================================
wss.on('connection', (ws) => {
  ws.room = null;
  ws.isAlive = true;
  ws.on('pong', ()=>{ ws.isAlive = true; });

  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch(e){ return; }
    switch (m.type){
      case 'host': {
        const code = makeCode();
        const room = new Room(code);
        rooms.set(code, room);
        room.host = ws;
        room.players.set(ws, { id:'P0', name:(m.name||'PLAYER').slice(0,14), colorId: m.colorId||'green', ready:true, kind:'human' });
        ws.room = code;
        ws.send(JSON.stringify({ type:'hosted', code }));
        room.sendLobby();
        break;
      }
      case 'join': {
        const code = (m.code||'').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room){ ws.send(JSON.stringify({ type:'error', msg:'Room "'+code+'" not found' })); return; }
        if (room.phase!=='lobby'){ ws.send(JSON.stringify({ type:'error', msg:'Game already started' })); return; }
        if (room.players.size>=4){ ws.send(JSON.stringify({ type:'error', msg:'Room is full' })); return; }
        const color = room.resolveColor(m.colorId, ws);
        room.players.set(ws, { name:(m.name||'PLAYER').slice(0,14), colorId:color, ready:true, kind:'human' });
        ws.room = code;
        ws.send(JSON.stringify({ type:'joined', code }));
        room.sendLobby();
        break;
      }
      case 'launch': {
        const room = rooms.get(ws.room);
        if (room && ws===room.host) room.start(!!m.cpuFill);
        break;
      }
      case 'input': {
        const room = rooms.get(ws.room);
        if (room) room.applyInput(ws, m.input);
        break;
      }
      case 'ping': {
        // echo straight back so the client can measure round-trip time
        if (ws.readyState===1) ws.send(JSON.stringify({ type:'pong', t:m.t }));
        break;
      }
      case 'leave': {
        dropFromRoom(ws);
        break;
      }
    }
  });

  ws.on('close', ()=>{ dropFromRoom(ws); });
});

function dropFromRoom(ws){
  const code = ws.room; if (!code) return;
  const room = rooms.get(code); if (!room) return;
  const wasHost = ws===room.host;
  room.players.delete(ws);
  ws.room = null;

  if (wasHost || room.players.size===0){
    // host left or room empty -> tear down the whole room
    room.stopLoop();
    room.broadcast({ type:'roomclosed' });
    rooms.delete(code);
    return;
  }
  // a client left
  if (room.phase==='lobby'){
    room.sendLobby();
  } else if (room.phase==='playing'){
    // mark that player's tank dead & non-respawning; game continues
    const id = room.wsToId && room.wsToId.get(ws);
    if (id && room.adapter){
      const pl = room.adapter.players.find(p=>p.id===id);
      if (pl){ pl.alive=false; pl.lives=0; pl._netInput=null; pl._left=true; }
    }
  }
}

// heartbeat: drop dead connections
setInterval(()=>{
  for (const ws of wss.clients){
    if (ws.isAlive===false){ try{ ws.terminate(); }catch(e){} continue; }
    ws.isAlive = false; try{ ws.ping(); }catch(e){}
  }
}, 30000);

server.listen(PORT, ()=>{
  console.log('==================================================');
  console.log('FAM Tanks server listening on :'+PORT);
  console.log('VERSION:', SERVER_VERSION);
  console.log('BOOTED :', BOOT_TIME);
  console.log('==================================================');
});
