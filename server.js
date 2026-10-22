const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
 
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const GRACE_MS = 2 * 60 * 1000; // how long a disconnected player can come back
const TURN_MS = Number(process.env.TURN_MS) || 10000; // time per move in timed mode
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
 
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
 
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const rooms = new Map();
 
const other = (m) => (m === 'X' ? 'O' : 'X');
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';
 
/* ----- timed mode: the server owns the clock ----- */
const clearTurnTimer = (r) => { clearTimeout(r.tt); r.tt = null; r.deadline = null; };
function startTurnTimer(r) {
  clearTurnTimer(r);
  if (!r.timed || r.winner || !(r.p.X && r.p.O && r.p.X.ws && r.p.O.ws)) return;
  r.deadline = Date.now() + TURN_MS;
  r.tt = setTimeout(() => autoMove(r), TURN_MS + 150);
}
// time ran out: a random free square is played for the player (change this to skip the turn if you prefer)
function autoMove(r) {
  r.tt = null;
  if (r.winner || !r.p.X || !r.p.O) return;
  const empty = r.board.map((v, k) => (v ? -1 : k)).filter((k) => k >= 0);
  if (!empty.length) return;
  const mark = r.turn;
  addChat(r, { sys: true, text: r.p[mark].name + ' ran out of time, so a random move was played.' });
  applyMove(r, mark, empty[Math.floor(Math.random() * empty.length)]);
}
function applyMove(r, mark, i) {
  r.board[i] = mark;
  const res = result(r.board);
  r.winner = res.winner; r.line = res.line;
  if (res.winner === 'X' || res.winner === 'O') r.scores[res.winner]++;
  else r.turn = other(mark);
  if (r.winner) clearTurnTimer(r); else startTurnTimer(r);
  broadcast(r);
}
 
/* ----- chat ----- */
function addChat(r, entry) {
  r.chat.push(entry);
  if (r.chat.length > 50) r.chat.shift();
  for (const m of ['X', 'O']) if (r.p[m]) send(r.p[m].ws, { type: 'chat', msg: entry });
}
 
function newCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s;
  do { s = Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join(''); }
  while (rooms.has(s));
  return s;
}
function result(b) {
  for (const [a, c, d] of LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return { winner: b[a], line: [a, c, d] };
  return b.every(Boolean) ? { winner: 'draw', line: null } : { winner: null, line: null };
}
 
function broadcast(room) {
  const names = { X: room.p.X ? room.p.X.name : null, O: room.p.O ? room.p.O.name : null };
  const online = { X: !!(room.p.X && room.p.X.ws), O: !!(room.p.O && room.p.O.ws) };
  for (const m of ['X', 'O']) {
    const pl = room.p[m];
    if (pl && pl.ws) send(pl.ws, {
      type: 'state', code: room.code, you: m, names, online, full: !!(room.p.X && room.p.O),
      board: room.board, turn: room.turn, winner: room.winner, line: room.line,
      scores: room.scores, rematch: room.rematch,
      timed: room.timed, deadline: room.deadline, turnMs: TURN_MS, now: Date.now()
    });
  }
}
 
function closeRoom(room, notifyMark) {
  for (const m of ['X', 'O']) {
    const pl = room.p[m];
    if (!pl) continue;
    clearTimeout(pl.timer);
    clearTurnTimer(room);
    if (pl.ws) {
      if (m === notifyMark) send(pl.ws, { type: 'left' });
      pl.ws.room = null; pl.ws.mark = null;
    }
  }
  rooms.delete(room.code);
}
 
function attach(room, mark, ws) {
  const pl = room.p[mark];
  clearTimeout(pl.timer); pl.timer = null;
  if (pl.ws && pl.ws !== ws) { const old = pl.ws; old.room = null; old.mark = null; old.close(); }
  pl.ws = ws; ws.room = room; ws.mark = mark;
  if (room.timed && !room.deadline) startTurnTimer(room);
  broadcast(room);
  send(ws, { type: 'chatlog', log: room.chat });
}
 
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.room = null; ws.mark = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
 
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const pid = String(msg.pid || '').slice(0, 64);
 
    if (msg.type === 'create') {
      if (ws.room || !pid) return;
      const room = {
        code: newCode(), p: { X: { ws: null, pid, name: cleanName(msg.name), timer: null }, O: null },
        board: Array(9).fill(''), turn: 'X', winner: null, line: null,
        scores: { X: 0, O: 0 }, round: 0, rematch: { X: false, O: false },
        timed: !!msg.timed, chat: [], tt: null, deadline: null
      };
      rooms.set(room.code, room);
      attach(room, 'X', ws);
 
    } else if (msg.type === 'join' || msg.type === 'rejoin') {
      if (ws.room || !pid) return;
      const room = rooms.get(String(msg.code || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', gone: true, message: msg.type === 'rejoin' ? 'Your previous game has ended.' : 'No game found with that code.' });
      const mine = ['X', 'O'].find((m) => room.p[m] && room.p[m].pid === pid);
      if (mine) return attach(room, mine, ws);
      if (msg.type === 'rejoin') return send(ws, { type: 'error', gone: true, message: 'Your previous game has ended.' });
      if (room.p.O) return send(ws, { type: 'error', message: 'That game already has two players.' });
      room.p.O = { ws: null, pid, name: cleanName(msg.name), timer: null };
      attach(room, 'O', ws);
 
    } else if (msg.type === 'move' && ws.room) {
      const r = ws.room, i = msg.index;
      if (!r.p.X || !r.p.O || r.winner || r.turn !== ws.mark || !Number.isInteger(i) || i < 0 || i > 8 || r.board[i]) return;
      applyMove(r, ws.mark, i);
 
    } else if (msg.type === 'again' && ws.room && ws.room.winner) {
      const r = ws.room;
      r.rematch[ws.mark] = true;
      if (r.rematch.X && r.rematch.O) {
        r.round++; r.board = Array(9).fill(''); r.winner = null; r.line = null;
        r.turn = r.round % 2 ? 'O' : 'X';
        r.rematch = { X: false, O: false };
        startTurnTimer(r);
      }
      broadcast(r);
 
    } else if (msg.type === 'chat' && ws.room) {
      const now = Date.now();
      if (now - (ws.lastChat || 0) < 400) return;
      const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) return;
      ws.lastChat = now;
      addChat(ws.room, { mark: ws.mark, name: ws.room.p[ws.mark].name, text });
 
    } else if (msg.type === 'leave' && ws.room) {
      closeRoom(ws.room, other(ws.mark));
    }
  });
 
  ws.on('close', () => {
    const room = ws.room, mark = ws.mark;
    if (!room) return;
    const pl = room.p[mark];
    if (!pl || pl.ws !== ws) return;
    pl.ws = null;
    clearTurnTimer(room); // pause the clock while someone is offline
    pl.timer = setTimeout(() => closeRoom(room, other(mark)), GRACE_MS);
    broadcast(room); // tells the other player their friend went offline
  });
});
 
setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);
 
server.listen(PORT, () => console.log('XO Online running on port ' + PORT));
