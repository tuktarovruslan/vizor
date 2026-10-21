import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadProjects } from './manifests.js';

const port = Number(process.env.PORT) || 4000;
const TIMEOUT = 3000;

const indexPath = fileURLToPath(new URL('../public/index.html', import.meta.url));

async function probe(url) {
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
      const r = await probe(s.url + (s.health || '/'));
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

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(await getStatus()));
  } else if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(indexPath));
  } else {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(port, async () => {
  console.log(`Vizor запущен: http://localhost:${port}`);
  const projects = await loadProjects();
  console.log(`  проекты: ${projects.map((p) => p.name).join(', ') || 'не найдены'}`);
});
