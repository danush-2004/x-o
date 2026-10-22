// kalakal.in server: lobby + game selection + XO + Ludo, all over WebSockets
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const GRACE_MS = 2 * 60 * 1000;                        // how long a disconnected player can come back
const TURN_MS = Number(process.env.TURN_MS) || 10000;  // XO timed mode: time per move
const LD = Number(process.env.LUDO_DELAY) || 1;       // multiplier for Ludo auto-play pauses (tests use a small value)
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

const rooms = new Map();
const GAMES = { xo: { min: 2, max: 2 }, ludo: { min: 2, max: 4 } };

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';
const online = (p) => !!(p && p.ws && !p.left);
const mkPlayer = (pid, name) => ({ pid, name: cleanName(name), ws: null, timer: null, left: false });

function newCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s;
  do { s = Array.from({ length: 4 }, () => c[crypto.randomInt(c.length)]).join(''); } while (rooms.has(s));
  return s;
}

/* ================= sending state ================= */
function snapshot(r, idx) {
  const s = {
    type: 'state', code: r.code, you: idx, host: r.host, game: r.game, started: r.started, timed: r.timed,
    players: r.players.map((p) => ({ name: p.name, online: online(p), left: p.left })), now: Date.now()
  };
  if (r.started && r.game === 'xo' && r.xo) {
    const x = r.xo, pl = (m) => r.players[x.slots[m === 'X' ? 0 : 1]];
    s.xo = {
      mark: x.slots[0] === idx ? 'X' : x.slots[1] === idx ? 'O' : null,
      names: { X: pl('X').name, O: pl('O').name }, online: { X: online(pl('X')), O: online(pl('O')) },
      board: x.board, turn: x.turn, winner: x.winner, line: x.line, scores: x.scores, rematch: x.rematch,
      deadline: r.deadline, turnMs: TURN_MS
    };
  }
  if (r.started && r.game === 'ludo' && r.ludo) {
    const g = r.ludo;
    s.ludo = { seats: g.seats, pieces: g.pieces, turn: g.turn, dice: g.dice, rolls: g.rolls, phase: g.phase,
      legal: g.legal, winner: g.winner, msg: g.msg, mySeat: g.seats.indexOf(idx) };
  }
  return s;
}
function broadcast(r) { r.players.forEach((p, i) => send(p.ws, snapshot(r, i))); }
function addChat(r, entry) {
  r.chat.push(entry);
  if (r.chat.length > 50) r.chat.shift();
  r.players.forEach((p) => send(p.ws, { type: 'chat', msg: entry }));
}
function reindex(r) { r.players.forEach((p, i) => { if (p.ws) p.ws.idx = i; }); }

/* ================= XO ================= */
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function xoResult(b) {
  for (const [a, c, d] of LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return { winner: b[a], line: [a, c, d] };
  return b.every(Boolean) ? { winner: 'draw', line: null } : { winner: null, line: null };
}
const clearTurnTimer = (r) => { clearTimeout(r.tt); r.tt = null; r.deadline = null; };
function startTurnTimer(r) {
  clearTurnTimer(r);
  const x = r.xo;
  if (!r.started || r.game !== 'xo' || !x || !r.timed || x.winner) return;
  if (!x.slots.every((i) => online(r.players[i]))) return;
  r.deadline = Date.now() + TURN_MS;
  r.tt = setTimeout(() => autoMoveXO(r), TURN_MS + 150);
}
function startXO(r) {
  r.xo = { slots: [0, 1], board: Array(9).fill(''), turn: 'X', winner: null, line: null,
    scores: { X: 0, O: 0 }, round: 0, rematch: { X: false, O: false } };
  startTurnTimer(r);
}
function xoApply(r, mark, i) {
  const x = r.xo;
  x.board[i] = mark;
  const res = xoResult(x.board);
  x.winner = res.winner; x.line = res.line;
  if (res.winner === 'X' || res.winner === 'O') x.scores[res.winner]++;
  else x.turn = mark === 'X' ? 'O' : 'X';
  if (x.winner) clearTurnTimer(r); else startTurnTimer(r);
  broadcast(r);
}
// time ran out: a random free square is played (change to skip the turn if you prefer)
function autoMoveXO(r) {
  r.tt = null;
  const x = r.xo;
  if (!x || x.winner) return;
  const empty = x.board.map((v, k) => (v ? -1 : k)).filter((k) => k >= 0);
  if (!empty.length) return;
  const mark = x.turn;
  addChat(r, { sys: true, text: r.players[x.slots[mark === 'X' ? 0 : 1]].name + ' ran out of time, so a random move was played.' });
  xoApply(r, mark, empty[crypto.randomInt(empty.length)]);
}

/* ================= LUDO =================
   seats 0..3 = red, green, yellow, blue. Piece progress: -1 base, 0..50 main track,
   51..55 home column, 56 home. Track has 52 squares; seat s starts at square s*13. */
const START = [0, 13, 26, 39];
const SAFE = new Set([0, 13, 26, 39, 8, 21, 34, 47]);
const trackIdx = (seat, p) => (START[seat] + p) % 52;
const lname = (r, seat) => r.players[r.ludo.seats[seat]].name;

function startLudo(r) {
  const n = r.players.length;
  const order = n === 2 ? [0, 2] : [0, 1, 2, 3].slice(0, n);   // 2 players sit opposite each other
  const seats = [-1, -1, -1, -1];
  order.forEach((seat, k) => { seats[seat] = k; });
  r.ludo = { seats, pieces: [0, 1, 2, 3].map(() => [-1, -1, -1, -1]), turn: order[0], dice: null, rolls: 0,
    phase: 'roll', sixes: 0, legal: [], winner: null, msg: '' };
}
function ludoLegal(g, seat, dice) {
  const out = [];
  g.pieces[seat].forEach((p, k) => { if (p === -1 ? dice === 6 : p + dice <= 56) out.push(k); });
  return out;
}
function capturesAt(g, seat, np) {
  if (np > 50) return [];
  const idx = trackIdx(seat, np);
  if (SAFE.has(idx)) return [];
  const hits = [];
  for (let s = 0; s < 4; s++) {
    if (s === seat || g.seats[s] < 0) continue;
    g.pieces[s].forEach((q, k) => { if (q >= 0 && q <= 50 && trackIdx(s, q) === idx) hits.push([s, k]); });
  }
  return hits;
}
function nextSeat(g) {
  for (let i = 1; i <= 4; i++) { const s = (g.turn + i) % 4; if (g.seats[s] >= 0) return s; }
  return g.turn;
}
function pickMove(g) {
  const seat = g.turn;
  let best = g.legal[0], bs = -1;
  for (const k of g.legal) {
    const p = g.pieces[seat][k], np = p === -1 ? 0 : p + g.dice;
    let sc = np;
    if (capturesAt(g, seat, np).length) sc += 100;
    if (np === 56) sc += 60;
    if (p === -1) sc += 40;
    if (np <= 50 && SAFE.has(trackIdx(seat, np))) sc += 12;
    if (sc > bs) { bs = sc; best = k; }
  }
  return best;
}
function doRoll(r) {
  const g = r.ludo;
  if (!g || g.winner !== null || g.phase !== 'roll') return;
  const seat = g.turn, name = lname(r, seat);
  g.dice = 1 + crypto.randomInt(6); g.rolls++;
  g.sixes = g.dice === 6 ? g.sixes + 1 : 0;
  if (g.sixes >= 3) { g.legal = []; g.phase = 'pass'; g.msg = name + ' rolled three 6s in a row. Turn lost!'; }
  else {
    g.legal = ludoLegal(g, seat, g.dice);
    g.phase = g.legal.length ? 'move' : 'pass';
    g.msg = name + ' rolled a ' + g.dice + (g.legal.length ? '' : ' (no move)');
  }
  broadcast(r); scheduleLudo(r);
}
function doMove(r, k) {
  const g = r.ludo;
  if (!g || g.phase !== 'move' || !g.legal.includes(k)) return;
  const seat = g.turn, name = lname(r, seat), p = g.pieces[seat][k], np = p === -1 ? 0 : p + g.dice;
  g.pieces[seat][k] = np;
  const hits = capturesAt(g, seat, np);
  hits.forEach(([s, q]) => { g.pieces[s][q] = -1; });
  g.legal = [];
  if (g.pieces[seat].every((v) => v === 56)) {
    g.winner = seat; g.phase = 'over'; g.msg = name + ' got every piece home!';
    broadcast(r); return scheduleLudo(r);
  }
  g.msg = hits.length ? name + ' captured ' + [...new Set(hits.map(([s]) => lname(r, s)))].join(', ') + '!'
    : np === 56 ? name + ' brought a piece home!' : '';
  const bonus = g.dice === 6 || hits.length > 0 || np === 56;   // extra roll
  if (!bonus) { g.turn = nextSeat(g); g.sixes = 0; }
  g.phase = 'roll';
  broadcast(r); scheduleLudo(r);
}
function passTurn(r) {
  const g = r.ludo;
  if (!g || g.phase !== 'pass') return;
  g.turn = nextSeat(g); g.sixes = 0; g.phase = 'roll'; g.legal = [];
  broadcast(r); scheduleLudo(r);
}
// auto-play: single legal move, "no move" passes, and offline/left players are played by a simple bot
function scheduleLudo(r) {
  clearTimeout(r.lt); r.lt = null;
  const g = r.ludo;
  if (!r.started || r.game !== 'ludo' || !g || g.winner !== null) return;
  const p = r.players[g.seats[g.turn]];
  const bot = !p || p.left || !p.ws, delay = (p && p.left ? 900 : 3500) * LD;
  if (g.phase === 'pass') r.lt = setTimeout(() => passTurn(r), 1100 * LD);
  else if (g.phase === 'move') {
    if (g.legal.length === 1) r.lt = setTimeout(() => doMove(r, g.legal[0]), 700 * LD);
    else if (bot) r.lt = setTimeout(() => doMove(r, pickMove(g)), delay);
  } else if (g.phase === 'roll' && bot) r.lt = setTimeout(() => doRoll(r), delay);
}

/* ================= rooms ================= */
function closeRoom(r, except) {
  clearTurnTimer(r); clearTimeout(r.lt);
  r.players.forEach((p, i) => {
    clearTimeout(p.timer);
    if (p.ws) { if (i !== except) send(p.ws, { type: 'left' }); p.ws.room = null; p.ws.idx = null; }
  });
  rooms.delete(r.code);
}
function attach(r, idx, ws) {
  const p = r.players[idx];
  clearTimeout(p.timer); p.timer = null;
  if (p.ws && p.ws !== ws) { const old = p.ws; old.room = null; old.idx = null; old.close(); }
  p.ws = ws; ws.room = r; ws.idx = idx;
  if (r.started && r.game === 'xo' && r.timed && !r.deadline) startTurnTimer(r);
  broadcast(r);
  send(ws, { type: 'chatlog', log: r.chat });
  if (r.started && r.game === 'ludo') scheduleLudo(r);
}
// a player left on purpose, or stayed disconnected past the grace period
function playerGone(r, idx) {
  const p = r.players[idx];
  if (!p) return;
  clearTimeout(p.timer); p.timer = null;
  if (!r.started) {
    if (idx === r.host) return closeRoom(r, idx);
    if (p.ws) { p.ws.room = null; p.ws.idx = null; }
    r.players.splice(idx, 1); reindex(r); broadcast(r);
    return;
  }
  if (r.game === 'xo' && r.xo && r.xo.slots.includes(idx)) return closeRoom(r, idx);
  p.left = true;
  if (p.ws) { p.ws.room = null; p.ws.idx = null; p.ws = null; }
  if (r.players.every((x) => x.left)) return closeRoom(r, -1);
  if (r.host === idx) r.host = r.players.findIndex((x) => !x.left);
  broadcast(r);
  if (r.game === 'ludo') scheduleLudo(r);
}

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.room = null; ws.idx = null; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const t = msg.type, pid = String(msg.pid || '').slice(0, 64);

    if (t === 'create') {
      if (ws.room || !pid) return;
      const r = { code: newCode(), players: [mkPlayer(pid, msg.name)], host: 0, game: 'xo', started: false, timed: false,
        chat: [], xo: null, ludo: null, tt: null, lt: null, deadline: null };
      rooms.set(r.code, r);
      return attach(r, 0, ws);
    }
    if (t === 'join' || t === 'rejoin') {
      if (ws.room || !pid) return;
      const r = rooms.get(String(msg.code || '').toUpperCase());
      const gone = (m) => send(ws, { type: 'error', gone: true, message: m });
      if (!r) return gone(t === 'rejoin' ? 'Your previous game has ended.' : 'No lobby found with that code.');
      const idx = r.players.findIndex((p) => p.pid === pid && !p.left);
      if (idx >= 0) return attach(r, idx, ws);
      if (t === 'rejoin') return gone('Your previous game has ended.');
      if (r.started) return send(ws, { type: 'error', message: 'That match has already started.' });
      if (r.players.length >= 4) return send(ws, { type: 'error', message: 'That lobby is full.' });
      r.players.push(mkPlayer(pid, msg.name));
      return attach(r, r.players.length - 1, ws);
    }

    const r = ws.room, me = ws.idx;
    if (!r) return;
    const isHost = me === r.host;

    if (t === 'selectgame') {
      if (!isHost || r.started || !GAMES[msg.game]) return;
      r.game = msg.game; broadcast(r);
    } else if (t === 'settimed') {
      if (!isHost || r.started) return;
      r.timed = !!msg.timed; broadcast(r);
    } else if (t === 'kick') {
      const i = msg.index, p = r.players[i];
      if (!isHost || r.started || !p || i === r.host) return;
      send(p.ws, { type: 'kicked' });
      if (p.ws) { p.ws.room = null; p.ws.idx = null; }
      clearTimeout(p.timer);
      r.players.splice(i, 1); reindex(r); broadcast(r);
    } else if (t === 'start') {
      const G = GAMES[r.game], n = r.players.length;
      if (!isHost || r.started || n < G.min || n > G.max || !r.players.every(online)) return;
      r.started = true;
      addChat(r, { sys: true, text: 'Match started. Good luck!' });
      if (r.game === 'xo') startXO(r); else startLudo(r);
      broadcast(r);
      if (r.game === 'ludo') scheduleLudo(r);
    } else if (t === 'tolobby') {
      if (!isHost || !r.started) return;
      clearTurnTimer(r); clearTimeout(r.lt);
      const hostPlayer = r.players[r.host];
      r.started = false; r.xo = null; r.ludo = null;
      r.players = r.players.filter((p) => !p.left);
      r.host = Math.max(0, r.players.indexOf(hostPlayer));
      reindex(r);
      addChat(r, { sys: true, text: 'Back in the lobby.' });
      broadcast(r);
    } else if (t === 'leave') {
      playerGone(r, me);
    } else if (t === 'chat') {
      const now = Date.now();
      if (now - (ws.lastChat || 0) < 400) return;
      const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) return;
      ws.lastChat = now;
      addChat(r, { from: me, name: r.players[me].name, text });
    } else if (t === 'voice') {
      if (!msg.data) return;
      r.players.forEach((p, i) => {
        if (i !== me && p.ws && p.ws.readyState === 1) {
          send(p.ws, { type: 'voice', from: me, data: msg.data });
        }
      });
    } else if (r.started && r.game === 'xo' && r.xo) {
      const x = r.xo, mark = x.slots[0] === me ? 'X' : x.slots[1] === me ? 'O' : null;
      if (!mark) return;
      if (t === 'move') {
        const i = msg.index;
        if (x.winner || x.turn !== mark || !Number.isInteger(i) || i < 0 || i > 8 || x.board[i]) return;
        xoApply(r, mark, i);
      } else if (t === 'again' && x.winner) {
        x.rematch[mark] = true;
        if (x.rematch.X && x.rematch.O) {
          x.round++; x.board = Array(9).fill(''); x.winner = null; x.line = null;
          x.turn = x.round % 2 ? 'O' : 'X'; x.rematch = { X: false, O: false };
          startTurnTimer(r);
        }
        broadcast(r);
      }
    } else if (r.started && r.game === 'ludo' && r.ludo) {
      const g = r.ludo;
      if (g.seats[g.turn] !== me || g.winner !== null) return;
      if (t === 'roll') doRoll(r);
      else if (t === 'lmove' && Number.isInteger(msg.piece)) doMove(r, msg.piece);
    }
  });

  ws.on('close', () => {
    const r = ws.room, idx = ws.idx;
    if (!r) return;
    const p = r.players[idx];
    if (!p || p.ws !== ws) return;
    p.ws = null;
    if (r.game === 'xo') clearTurnTimer(r);          // pause the XO clock while someone is offline
    p.timer = setTimeout(() => playerGone(r, r.players.indexOf(p)), GRACE_MS);
    broadcast(r);
    if (r.started && r.game === 'ludo') scheduleLudo(r);
  });
});

setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);

server.listen(PORT, () => console.log('kalakal.in running on port ' + PORT));
