#!/usr/bin/env node
// Planning Poker — "(Sexy) Business Wife" edition
// Zero-dependency Node server: static UI + in-memory state + SSE live sync.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 6969;
const INDEX = path.join(__dirname, 'index.html');
const PUBLIC = path.join(__dirname, 'public');

// ---- Game state (in-memory) ----
const state = {
  round: 1,
  phase: 'lobby', // lobby | voting | revealed
  question: '',
  players: {}, // id -> { id, name, icon, vote, revealed }
};

const sseClients = new Map(); // res -> id

function publicState() {
  const players = Object.values(state.players).map(p => ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    vote: p.revealed ? p.vote : (p.vote ? '🔒' : null),
    revealed: p.revealed,
    hasVoted: !!p.vote,
  }));
  return {
    round: state.round,
    phase: state.phase,
    question: state.question,
    players: players.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

function broadcast() {
  const data = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of sseClients.values()) {
    try { res.write(data); } catch {}
  }
}

setInterval(() => {
  for (const [id, res] of sseClients) {
    try { res.write(': ping\n\n'); } catch { sseClients.delete(id); }
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

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
    const rel = path.normalize(url.pathname.slice(1)); // img/x.png or img/thumb/x.jpg
    if (!/^img(\/thumb)?\/[a-z0-9-]+\.(png|jpe?g)$/.test(rel)) { res.writeHead(403); return res.end(); }
    const full = path.join(PUBLIC, rel);
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const id = crypto.randomUUID();
    sseClients.set(res, id);
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, publicState());
  }

  try {
    // Join: { name, icon }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const { name, icon } = await readBody(req);
      if (!name || !icon) return json(res, 400, { error: 'name and icon required' });
      // Rejoin by name+icon keeps same identity (reconnect friendly)
      let p = Object.values(state.players).find(
        x => x.name.toLowerCase() === String(name).toLowerCase() && x.icon === icon
      );
      if (!p) {
        p = { id: crypto.randomUUID(), name: String(name).slice(0, 24), icon, vote: null, revealed: state.phase === 'revealed' };
        state.players[p.id] = p;
      }
      broadcast();
      return json(res, 200, { id: p.id });
    }

    // Vote / change vote: { id, value }
    if (req.method === 'POST' && url.pathname === '/api/vote') {
      const { id, value } = await readBody(req);
      const p = state.players[id];
      if (!p) return json(res, 404, { error: 'unknown player' });
      if (state.phase === 'revealed') return json(res, 409, { error: 'round already revealed' });
      if (!/^[0-9?☕∞]+$/.test(String(value))) return json(res, 400, { error: 'bad vote' });
      p.vote = String(value).slice(0, 4);
      broadcast();
      return json(res, 200, { ok: true });
    }

    // Reveal
    if (req.method === 'POST' && url.pathname === '/api/reveal') {
      if (state.phase !== 'voting' && state.phase !== 'lobby') return json(res, 409, { error: 'nothing to reveal' });
      state.phase = 'revealed';
      for (const p of Object.values(state.players)) p.revealed = true;
      broadcast();
      return json(res, 200, { ok: true });
    }

    // Next round
    if (req.method === 'POST' && url.pathname === '/api/next') {
      state.round += 1;
      state.phase = 'voting';
      for (const p of Object.values(state.players)) { p.vote = null; p.revealed = false; }
      broadcast();
      return json(res, 200, { ok: true });
    }

    // Set question
    if (req.method === 'POST' && url.pathname === '/api/question') {
      const { question } = await readBody(req);
      state.question = String(question || '').slice(0, 200);
      broadcast();
      return json(res, 200, { ok: true });
    }

    // Leave
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/leave/')) {
      const id = url.pathname.split('/').pop();
      if (state.players[id]) delete state.players[id];
      broadcast();
      return json(res, 200, { ok: true });
    }
  } catch {
    return json(res, 400, { error: 'bad request' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => console.log(`planning poker (sexy business wife edition) on :${PORT}`));
