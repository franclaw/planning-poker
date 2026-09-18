#!/usr/bin/env node
// Planning Poker — Business Wife edition
// Zero-dependency Node: rooms + static UI + in-memory state + SSE.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 6969;
const INDEX = path.join(__dirname, 'index.html');
const PUBLIC = path.join(__dirname, 'public');
const ROOM_RE = /^[a-z0-9]{6}$/;
const ID_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';

const rooms = new Map(); // id -> room

function newRoomId() {
  for (let n = 0; n < 20; n++) {
    let id = '';
    const buf = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) id += ID_CHARS[buf[i] % ID_CHARS.length];
    if (!rooms.has(id)) return id;
  }
  return crypto.randomBytes(4).toString('hex').slice(0, 6);
}

function makeRoom(id) {
  return {
    id,
    round: 1,
    phase: 'lobby',
    question: '',
    players: {},
    sse: new Set(),
  };
}

function publicState(room) {
  const players = Object.values(room.players).map(p => ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    vote: p.revealed ? p.vote : (p.vote ? '🔒' : null),
    revealed: p.revealed,
    hasVoted: !!p.vote,
  }));
  return {
    roomId: room.id,
    round: room.round,
    phase: room.phase,
    question: room.question,
    players: players.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

function broadcast(room) {
  const data = `data: ${JSON.stringify(publicState(room))}\n\n`;
  for (const res of room.sse) {
    try { res.write(data); } catch { room.sse.delete(res); }
  }
}

setInterval(() => {
  for (const room of rooms.values()) {
    for (const res of room.sse) {
      try { res.write(': ping\n\n'); } catch { room.sse.delete(res); }
    }
  }
}, 25000);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function serveIndex(res) {
  fs.readFile(INDEX, (err, buf) => {
    if (err) { res.writeHead(500); return res.end('index.html missing'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
}

function roomFromPath(pathname, prefix) {
  const rest = pathname.slice(prefix.length);
  const id = rest.split('/')[0];
  return ROOM_RE.test(id) ? id : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || /^\/r\/[a-z0-9]{6}\/?$/.test(url.pathname))) {
    return serveIndex(res);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
    const rel = path.normalize(url.pathname.slice(1));
    if (!/^img(\/thumb)?\/[a-z0-9-]+\.(png|jpe?g)$/.test(rel)) { res.writeHead(403); return res.end(); }
    const full = path.join(PUBLIC, rel);
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const type = rel.endsWith('.jpg') || rel.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    });
    return;
  }

  try {
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const id = newRoomId();
      rooms.set(id, makeRoom(id));
      return json(res, 200, { id });
    }

    const roomId = url.pathname.startsWith('/api/rooms/') ? roomFromPath(url.pathname, '/api/rooms/') : null;
    const room = roomId ? rooms.get(roomId) : null;

    if (req.method === 'GET' && url.pathname.match(/^\/api\/rooms\/[a-z0-9]{6}$/)) {
      if (!room) return json(res, 404, { error: 'room not found' });
      return json(res, 200, { id: room.id, exists: true });
    }

    if (req.method === 'GET' && url.pathname.match(/^\/api\/rooms\/[a-z0-9]{6}\/state$/)) {
      if (!room) return json(res, 404, { error: 'room not found' });
      return json(res, 200, publicState(room));
    }

    if (req.method === 'GET' && url.pathname.match(/^\/api\/rooms\/[a-z0-9]{6}\/events$/)) {
      if (!room) return json(res, 404, { error: 'room not found' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      room.sse.add(res);
      res.write(`data: ${JSON.stringify(publicState(room))}\n\n`);
      req.on('close', () => room.sse.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/rooms\/[a-z0-9]{6}\/join$/)) {
      if (!room) return json(res, 404, { error: 'room not found' });
      const { name, icon } = await readBody(req);
      if (!name || !icon) return json(res, 400, { error: 'name and icon required' });
      const taken = Object.values(room.players).find(
        x => x.name.toLowerCase() === String(name).toLowerCase()
      );
      if (taken) return json(res, 409, { error: 'taken' });
      const p = { id: crypto.randomUUID(), name: String(name).slice(0, 24), icon, vote: null, revealed: room.phase === 'revealed' };
      room.players[p.id] = p;
      broadcast(room);
      return json(res, 200, { id: p.id, roomId: room.id });
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/rooms\/[a-z0-9]{6}\/vote$/)) {
      if (!room) return json(res, 404, { error: 'room not found' });
      const { id, value } = await readBody(req);
      const p = room.players[id];
      if (!p) return json(res, 404, { error: 'unknown player' });
      if (room.phase === 'revealed') return json(res, 409, { error: 'round already revealed' });
      if (!/^[0-9?☕∞]+$/.test(String(value))) return json(res, 400, { error: 'bad vote' });
      p.vote = String(value).slice(0, 4);
      if (room.phase === 'lobby') room.phase = 'voting';
      broadcast(room);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/rooms\/[a-z0-9]{6}\/reveal$/)) {
      if (!room) return json(res, 404, { error: 'room not found' });
      if (room.phase !== 'voting' && room.phase !== 'lobby') return json(res, 409, { error: 'nothing to reveal' });
      room.phase = 'revealed';
      for (const p of Object.values(room.players)) p.revealed = true;
      broadcast(room);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/rooms\/[a-z0-9]{6}\/next$/)) {
      if (!room) return json(res, 404, { error: 'room not found' });
      room.round += 1;
      room.phase = 'voting';
      for (const p of Object.values(room.players)) { p.vote = null; p.revealed = false; }
      broadcast(room);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname.match(/^\/api\/rooms\/[a-z0-9]{6}\/question$/)) {
      if (!room) return json(res, 404, { error: 'room not found' });
      const { question } = await readBody(req);
      room.question = String(question || '').slice(0, 200);
      broadcast(room);
      return json(res, 200, { ok: true });
    }

    const leaveM = url.pathname.match(/^\/api\/rooms\/([a-z0-9]{6})\/leave\/([^/]+)$/);
    if (req.method === 'DELETE' && leaveM) {
      const r = rooms.get(leaveM[1]);
      if (r && r.players[leaveM[2]]) delete r.players[leaveM[2]];
      if (r) broadcast(r);
      return json(res, 200, { ok: true });
    }
  } catch {
    return json(res, 400, { error: 'bad request' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => console.log(`planning poker (business wife edition) on :${PORT}`));
