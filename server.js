const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
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
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room) {
  const state = {
    type: 'state', code: room.code, board: room.board, turn: room.turn,
    winner: room.winner, line: room.line, scores: room.scores,
    full: !!(room.players.X && room.players.O)
  };
  for (const m of ['X', 'O']) send(room.players[m], { ...state, you: m });
}

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.room = null; ws.mark = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'create' && !ws.room) {
      const room = { code: newCode(), players: { X: ws, O: null }, board: Array(9).fill(''), turn: 'X',
        winner: null, line: null, scores: { X: 0, O: 0 }, round: 0 };
      rooms.set(room.code, room); ws.room = room; ws.mark = 'X';
      broadcast(room);
    } else if (msg.type === 'join' && !ws.room) {
      const room = rooms.get(String(msg.code || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', message: 'No game found with that code.' });
      if (room.players.O) return send(ws, { type: 'error', message: 'That game already has two players.' });
      room.players.O = ws; ws.room = room; ws.mark = 'O';
      broadcast(room);
    } else if (msg.type === 'move' && ws.room) {
      const r = ws.room, i = msg.index;
      if (!r.players.O || r.winner || r.turn !== ws.mark || !Number.isInteger(i) || i < 0 || i > 8 || r.board[i]) return;
      r.board[i] = ws.mark;
      const res = result(r.board);
      r.winner = res.winner; r.line = res.line;
      if (res.winner === 'X' || res.winner === 'O') r.scores[res.winner]++;
      else r.turn = ws.mark === 'X' ? 'O' : 'X';
      broadcast(r);
    } else if (msg.type === 'again' && ws.room && ws.room.winner) {
      const r = ws.room;
      r.round++; r.board = Array(9).fill(''); r.winner = null; r.line = null; r.turn = r.round % 2 ? 'O' : 'X';
      broadcast(r);
    }
  });

  ws.on('close', () => {
    const r = ws.room; if (!r) return;
    r.players[ws.mark] = null;
    const other = ws.mark === 'X' ? 'O' : 'X';
    if (r.players[other]) send(r.players[other], { type: 'left' });
    else rooms.delete(r.code);
  });
});

// drop dead connections (keeps free hosts tidy)
setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);

server.listen(PORT, () => console.log('XO Online running on port ' + PORT));
