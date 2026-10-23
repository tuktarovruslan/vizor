import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects } from './manifests.js';
import { buildArchitecture } from './architecture.js';

const port = Number(process.env.PORT) || 4000;
const TIMEOUT = 3000;

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const threeDir = fileURLToPath(new URL('../node_modules/three/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// Отдаёт файл из папки root, не выпуская путь за её пределы
async function sendFile(res, root, rel) {
  const file = path.join(root, rel);
  if (!file.startsWith(root)) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function probeTcp(url) {
  const { hostname, port } = new URL(url);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port), timeout: TIMEOUT });
    const done = (up) => {
      socket.destroy();
      resolve({ up, ms: up ? Math.round(performance.now() - t0) : null, http: null, data: null });
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const SELF_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

async function probe(url) {
  if (url.startsWith('tcp://')) return probeTcp(url);
  // vizor описан в своём же vizor.json: опрос самого себя через /api/status зациклился бы
  const u = new URL(url);
  if (SELF_HOSTS.has(u.hostname) && Number(u.port) === port) return { up: true, ms: 0, http: 200, data: null };
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    const ms = Math.round(performance.now() - t0);
    const isJson = (res.headers.get('content-type') || '').includes('json');
    const data = res.ok && isJson ? await res.json() : null;
    return { up: res.ok && (data?.status === undefined || data.status === 'ok'), ms, http: res.status, data };
  } catch {
    return { up: false, ms: null, http: null, data: null };
  }
}

async function projectStatus(project) {
  const byId = Object.fromEntries(project.services.map((s) => [s.id, s]));

  const services = await Promise.all(
    project.services.map(async (s) => {
      const r = await probe(s.url + (s.health || ''));
      return {
        id: s.id,
        type: s.type || 'service',
        stack: s.stack || null,
        url: s.url,
        up: r.up,
        ms: r.ms,
        uptime: r.data?.uptime ?? null,
      };
    }),
  );

  const links = await Promise.all(
    project.links.map(async (l) => {
      const from = byId[l.from];
      const r = from ? await probe(from.url + (l.via || '/')) : { up: false, ms: null, http: null };
      // field: связь живая, только если в JSON-ответе from указанное поле равно 'ok' (например db у /api/health)
      if (l.field && r.up) r.up = r.data?.[l.field] === 'ok';
      return { from: l.from, to: l.to, label: l.label || `${l.from} → ${l.to}`, up: r.up, ms: r.ms, http: r.http };
    }),
  );

  return { name: project.name, services, links };
}

async function getStatus() {
  const projects = await loadProjects();
  return {
    checkedAt: new Date().toISOString(),
    projects: await Promise.all(projects.map(projectStatus)),
  };
}

const PAGES = { '/': 'index.html', '/status': 'status.html' };

const server = http.createServer((req, res) => {
  // ошибка одного запроса не должна ронять весь vizor
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  });
});

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(await getStatus()));
    return;
  }
  if (pathname === '/api/architecture') {
    const projects = await loadProjects();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ builtAt: new Date().toISOString(), projects: await Promise.all(projects.map(buildArchitecture)) }));
    return;
  }
  if (PAGES[pathname] && (await sendFile(res, publicDir, PAGES[pathname]))) return;
  if (pathname.startsWith('/vendor/three/') && (await sendFile(res, threeDir, decodeURIComponent(pathname.slice(14))))) return;
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

server.listen(port, async () => {
  console.log(`Vizor запущен: http://localhost:${port}`);
  const projects = await loadProjects();
  console.log(`  проекты: ${projects.map((p) => p.name).join(', ') || 'не найдены'}`);
});
