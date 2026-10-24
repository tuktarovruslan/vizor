import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// Строит карту архитектуры проекта по исходникам: узлы (файлы, маршруты API, таблицы БД) и связи между ними.
// Без сборки и без LLM: только регулярные выражения по тексту файлов.

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'graphify-out', '.vite', '.idea', '.vscode']);
const SOURCE_EXT = new Set(['.vue', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss']);
const RESOLVE_EXT = ['', '.js', '.mjs', '.ts', '.vue', '.jsx', '.tsx', '.json', '/index.js', '/index.ts'];
const MAX_FILES = 2000;
const MAX_NODES = 400;

export function layerOf(type = '') {
  const t = type.toLowerCase();
  if (/front|web|ui|client|spa|site/.test(t)) return 'frontend';
  if (/db|database|sql|postgres|mysql|mongo|redis|cache|storage|queue/.test(t)) return 'db';
  return 'backend';
}

const posix = (p) => p.split(path.sep).join('/');

async function walk(root, rel = '', out = []) {
  if (out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, r, out);
    } else if (e.isFile()) {
      out.push(r);
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// '/a/./b/../c' → 'a/c' относительно корня проекта
function normalize(p) {
  return path.posix.normalize(p).replace(/^\/+/, '');
}

function kindOf(file, layer) {
  const base = path.posix.basename(file);
  const ext = path.posix.extname(file);
  if (ext === '.css' || ext === '.scss') return 'style';
  if (ext === '.json') return 'data';
  if (/config\.|\.config$|^vite|^webpack|^dev\.mjs$/.test(base)) return 'config';
  if (layer === 'frontend') {
    if (ext === '.html') return 'page';
    if (/Page\.(vue|jsx|tsx)$/.test(base) || /\/(pages|views)\//.test(`/${file}`)) return 'page';
    if (/^App\.(vue|jsx|tsx)$/.test(base)) return 'page';
    if (/store|state/i.test(base)) return 'store';
    if (ext === '.vue' || ext === '.jsx' || ext === '.tsx') return 'component';
    return 'module';
  }
  if (/server|app|index|main/.test(base)) return 'entry';
  return 'module';
}

const ROUTE_RES = [
  /\b(?:pathname|url|path|req\.url)\s*===?\s*['"`](\/[^'"`\s]*)['"`]/g,
  /\.(?:get|post|put|patch|delete|all|route)\(\s*['"`](\/[^'"`\s]*)['"`]/g,
  /\bcase\s+['"`](\/[^'"`\s]*)['"`]\s*:/g,
];
const API_CALL_RE = /['"`](\/api(?:\/[\w\-.:]*)*)/g;

function routeMatches(route, call) {
  if (route === call) return true;
  if (!route.includes(':')) return false;
  const re = new RegExp('^' + route.replace(/:[^/]+/g, '[^/]+') + '$');
  return re.test(call);
}

function importSpecs(text, ext) {
  const specs = [];
  const push = (re, kind = 'import') => { for (const m of text.matchAll(re)) specs.push({ spec: m[1], kind }); };
  if (ext === '.css' || ext === '.scss') {
    push(/@(?:use|import|forward)\s+['"]([^'"]+)['"]/g);
    return specs;
  }
  push(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g);
  push(/\bimport\s*['"]([^'"]+)['"]/g);
  push(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g);
  push(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g);
  push(/import\.meta\.glob\(\s*['"]([^'"]+)['"]/g, 'glob');
  if (ext === '.html') {
    push(/<script[^>]*\bsrc=["']([^"']+)["']/g);
    push(/<link[^>]*\bhref=["']([^"']+\.css)["']/g);
  }
  return specs;
}

// Swagger UI с deepLinking открывает адрес по ссылке #/<тег>/<operationId>; пробелы в имени заменяются на «_»
const deepLink = (s) => encodeURIComponent(String(s).trim().replace(/\s/g, '_'));

// Схема из openapi.json в упрощённом виде для панели связи: тип, ограничения и поля, $ref раскрыты
const refTarget = (spec, ref) => ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], spec);

function constraintsOf(s) {
  const c = [];
  if (s.minLength != null || s.maxLength != null) c.push(`длина ${s.minLength ?? 0}–${s.maxLength ?? '∞'}`);
  if (s.minimum != null) c.push(`≥ ${s.minimum}`);
  if (s.maximum != null) c.push(`≤ ${s.maximum}`);
  if (s.minItems != null || s.maxItems != null) c.push(`элементов ${s.minItems ?? 0}–${s.maxItems ?? '∞'}`);
  if (s.pattern) c.push(`шаблон ${s.pattern}`);
  if (s.nullable) c.push('может быть null');
  return c.join(', ') || null;
}

function simplifySchema(spec, s, seen = new Set()) {
  if (!s || typeof s !== 'object') return null;
  if (s.$ref) {
    const name = s.$ref.split('/').pop();
    if (seen.has(s.$ref) || seen.size > 8) return { type: 'object', ref: name, recursive: true };
    const r = simplifySchema(spec, refTarget(spec, s.$ref), new Set([...seen, s.$ref]));
    return r && { ...r, ref: r.ref || name };
  }
  if (s.allOf) {
    const parts = s.allOf.map((x) => simplifySchema(spec, x, seen)).filter(Boolean);
    const props = parts.flatMap((p) => p.properties || []);
    return { type: 'object', description: s.description || null, properties: props };
  }
  const variants = s.oneOf || s.anyOf;
  if (variants) return { type: 'variants', description: s.description || null, variants: variants.map((x) => simplifySchema(spec, x, seen)).filter(Boolean) };
  const required = new Set(s.required || []);
  const type = s.type || (s.properties ? 'object' : s.items ? 'array' : null);
  return {
    type,
    format: s.format || null,
    description: s.description || null,
    enum: s.enum || null,
    constraints: constraintsOf(s),
    items: type === 'array' ? simplifySchema(spec, s.items, seen) : null,
    properties: s.properties
      ? Object.entries(s.properties).map(([name, p]) => ({ name, required: required.has(name), ...simplifySchema(spec, p, seen) }))
      : null,
  };
}

// тело запроса или ответа: JSON, если есть, иначе первый тип содержимого; пример — из example, examples или схемы
function bodyOf(spec, content) {
  if (!content) return null;
  const type = content['application/json'] ? 'application/json' : Object.keys(content)[0];
  if (!type) return null;
  const media = content[type];
  const firstExample = media.examples && Object.values(media.examples)[0];
  const example = media.example ?? (firstExample?.$ref ? refTarget(spec, firstExample.$ref)?.value : firstExample?.value) ?? media.schema?.example;
  return { contentType: type, schema: simplifySchema(spec, media.schema), example: example ?? null };
}

function contractOf(spec, op, shared = []) {
  const deref = (x) => (x?.$ref ? refTarget(spec, x.$ref) : x);
  const params = [...shared, ...(op.parameters || [])].map(deref).filter(Boolean).map((p) => ({
    name: p.name, in: p.in, required: !!p.required, description: p.description || null, ...simplifySchema(spec, p.schema),
  }));
  const reqBody = deref(op.requestBody);
  return {
    request: {
      params,
      body: reqBody ? { required: !!reqBody.required, description: reqBody.description || null, ...bodyOf(spec, reqBody.content) } : null,
    },
    responses: Object.entries(op.responses || {}).map(([code, r]) => {
      const res = deref(r) || {};
      return { status: code, description: res.description || null, body: bodyOf(spec, res.content) };
    }),
  };
}

// Описание адресов из openapi.json сервиса: метод, краткое описание, структура запроса и ответов, ссылка в Swagger
async function attachOpenApi(root, services, routes) {
  for (const svc of services) {
    if (!svc.openapi) continue;
    let spec;
    try {
      spec = JSON.parse(await readFile(path.join(root, svc.dir, svc.openapi.spec), 'utf8'));
    } catch {
      continue; // нет файла или битый JSON — схема строится без описаний
    }
    const ui = svc.openapi.ui && svc.url ? svc.url.replace(/\/$/, '') + svc.openapi.ui : null;
    for (const [specPath, ops] of Object.entries(spec.paths || {})) {
      const asRoute = specPath.replace(/\{([^}]+)\}/g, ':$1');
      const r = routes.find((x) => x.service === svc.id && (x.path === specPath || routeMatches(asRoute, x.path) || routeMatches(x.path, specPath)));
      if (!r) continue;
      r.node.api = Object.entries(ops)
        .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map(([method, op]) => ({
          method: method.toUpperCase(),
          summary: op.summary || null,
          operationId: op.operationId || null,
          docs: ui && op.operationId ? `${ui}#/${deepLink(op.tags?.[0] || 'default')}/${deepLink(op.operationId)}` : ui,
          ...contractOf(spec, op, ops.parameters),
        }));
    }
  }
}

export async function buildArchitecture(project) {
  const root = project.dir;
  const allFiles = await walk(root);
  const fileSet = new Set(allFiles);
  const services = project.services.map((s) => ({
    id: s.id,
    type: s.type || 'service',
    stack: s.stack || null,
    url: s.url || null,
    command: s.command || null,
    health: s.health || null,
    layer: layerOf(s.type),
    dir: normalize(s.dir || '.').replace(/^\.$/, ''),
    units: (s.architecture?.units || []).map(globToRegex),
    // architecture.layers: слой по подпапке сервиса, например { "web": "frontend", "api": "backend" } у монолита
    // openapi: { "spec": путь к openapi.json внутри dir, "ui": путь Swagger UI у url сервиса }
    openapi: s.openapi?.spec ? s.openapi : null,
    layers: Object.entries(s.architecture?.layers || {})
      .map(([dir, type]) => [normalize(dir).replace(/\/$/, ''), layerOf(type)])
      .sort((a, b) => b[0].length - a[0].length),
  }));
  const layerIn = (svc, local) => svc.layers.find(([dir]) => local === dir || local.startsWith(dir + '/'))?.[1] || svc.layer;
  const codeServices = services.filter((s) => s.layer !== 'db').sort((a, b) => b.dir.length - a.dir.length);

  // Файл принадлежит сервису с самой длинной подходящей папкой
  const serviceOfFile = (f) => codeServices.find((s) => !s.dir || f === s.dir || f.startsWith(s.dir + '/'));

  // Узел для файла: либо сам файл, либо «единица» (папка компонента), если сервис задал architecture.units
  const unitCache = new Map();
  function unitOf(file) {
    if (unitCache.has(file)) return unitCache.get(file);
    const svc = serviceOfFile(file);
    let id = null;
    if (svc) {
      const local = svc.dir ? file.slice(svc.dir.length + 1) : file;
      const parts = local.split('/');
      for (let i = parts.length - 1; i >= 1 && !id; i--) {
        const dir = parts.slice(0, i).join('/');
        if (svc.units.some((re) => re.test(dir))) id = (svc.dir ? svc.dir + '/' : '') + dir;
      }
      if (!id && SOURCE_EXT.has(path.posix.extname(file))) id = file;
    }
    const res = id ? { id, svc } : null;
    unitCache.set(file, res);
    return res;
  }

  const nodes = new Map();
  const edges = new Map();
  function ensureNode(file, forceFile = false) {
    const u = forceFile ? { id: file, svc: serviceOfFile(file) } : unitOf(file);
    if (!u || !u.svc) return null;
    let n = nodes.get(u.id);
    if (!n) {
      const isUnit = u.id !== file;
      const local = u.svc.dir ? u.id.slice(u.svc.dir.length + 1) : u.id;
      const layer = layerIn(u.svc, local);
      n = {
        id: u.id,
        service: u.svc.id,
        layer,
        label: path.posix.basename(u.id),
        kind: isUnit ? 'unit' : kindOf(u.id, layer),
        path: u.id,
        cluster: path.posix.dirname(local) === '.' ? '' : path.posix.dirname(local),
        files: [],
        mtime: 0,
      };
      if (nodes.size >= MAX_NODES) return null;
      nodes.set(u.id, n);
    }
    if (!n.files.includes(file)) n.files.push(file);
    return n;
  }
  function addEdge(from, to, kind, label) {
    if (!from || !to || from.id === to.id) return;
    const key = `${from.id}>${to.id}`;
    const e = edges.get(key);
    if (e) { e.count++; return e; }
    const created = { from: from.id, to: to.id, kind, label: label || null, count: 1 };
    edges.set(key, created);
    return created;
  }

  function resolve(fromFile, spec) {
    const clean = spec.split('?')[0];
    if (!clean.startsWith('.') && !clean.startsWith('/')) return null;
    const baseDir = path.posix.dirname(fromFile);
    const svc = serviceOfFile(fromFile);
    const bases = clean.startsWith('/')
      ? [normalize(path.posix.join(baseDir, clean)), normalize(path.posix.join(svc?.dir || '', clean))]
      : [normalize(path.posix.join(baseDir, clean))];
    for (const b of bases) {
      for (const ext of RESOLVE_EXT) if (fileSet.has(b + ext)) return b + ext;
      // scss-партиалы: '../styles/sphere' → styles/sphere/_index.scss, '_tokens' → _tokens.scss
      const dir = path.posix.dirname(b), name = path.posix.basename(b);
      for (const cand of [`${b}.scss`, `${dir}/_${name}.scss`, `${b}/_index.scss`, `${b}/index.scss`]) {
        if (fileSet.has(cand)) return cand;
      }
    }
    return null;
  }

  const sources = allFiles.filter((f) => SOURCE_EXT.has(path.posix.extname(f)) && serviceOfFile(f));
  const read = await Promise.all(
    sources.map(async (f) => {
      try {
        const [text, st] = await Promise.all([readFile(path.join(root, f), 'utf8'), stat(path.join(root, f))]);
        return [f, { text, mtime: st.mtimeMs }];
      } catch {
        return null; // файл исчез между обходом и чтением
      }
    }),
  );
  // порядок файлов — как при обходе, а не как завершилось чтение: иначе узлы приходят каждый раз в разном порядке
  const texts = new Map(read.filter(Boolean));

  // 1. Узлы и импорты
  for (const [f, { text }] of texts) {
    const from = ensureNode(f);
    if (!from) continue;
    const ext = path.posix.extname(f);
    for (const { spec, kind } of importSpecs(text, ext)) {
      if (kind === 'glob') {
        const re = globToRegex(normalize(path.posix.join(path.posix.dirname(f), spec.split('?')[0])));
        for (const target of allFiles) if (re.test(target)) addEdge(from, ensureNode(target, !unitOf(target)), 'import');
      } else {
        const target = resolve(f, spec);
        if (target) addEdge(from, ensureNode(target, !unitOf(target)), 'import');
      }
    }
  }

  // время последнего изменения узла — по самому свежему его файлу
  await Promise.all(
    [...nodes.values()].map(async (n) => {
      for (const f of n.files) {
        let m = texts.get(f)?.mtime;
        if (m == null) { try { m = (await stat(path.join(root, f))).mtimeMs; } catch { m = 0; } }
        n.mtime = Math.max(n.mtime, m);
      }
    }),
  );

  // Документация элемента — одноимённый .md рядом с файлом: logic/analyze.js → logic/analyze.md
  for (const n of nodes.values()) {
    if (n.files.length !== 1) continue;
    const md = n.files[0].replace(/\.[^./]+$/, '.md');
    if (md !== n.files[0] && fileSet.has(md)) n.doc = md;
  }

  // 2. Маршруты API бэкенда и вызовы их с фронтенда
  const routes = [];
  for (const [f, { text }] of texts) {
    const n = nodes.get(unitOf(f)?.id);
    if (!n || n.layer !== 'backend') continue;
    for (const re of ROUTE_RES) {
      for (const m of text.matchAll(re)) {
        const p = m[1].length > 1 ? m[1].replace(/\/$/, '') : m[1]; // '/docs/' и '/docs' — один адрес
        if (p === '/' || routes.some((r) => r.path === p && r.service === n.service)) continue;
        const id = `${n.service}:route:${p}`;
        const svc = services.find((s) => s.id === n.service);
        const rn = { id, service: n.service, layer: 'backend', label: p, kind: 'route', path: f, cluster: 'API', files: [f], mtime: n.mtime };
        nodes.set(id, rn);
        routes.push({ path: p, service: svc.id, node: rn });
        addEdge(rn, n, 'route'); // запрос приходит на адрес и обрабатывается в файле
      }
    }
  }
  await attachOpenApi(root, services, routes);
  for (const [f, { text }] of texts) {
    const n = nodes.get(unitOf(f)?.id);
    if (!n || n.layer !== 'frontend') continue;
    for (const m of text.matchAll(API_CALL_RE)) {
      const call = m[1].replace(/\/$/, '');
      const r = routes.find((r) => routeMatches(r.path, call));
      if (!r) continue;
      const e = addEdge(n, r.node, 'api', call);
      // метод вызова — из `method: 'POST'` рядом с адресом (до следующего вызова), иначе GET
      let near = text.slice(m.index, m.index + 400);
      const next = near.slice(1).search(/fetch\(|axios|['"`]\/api/);
      if (next >= 0) near = near.slice(0, next + 1);
      // axios.post('/api/…') — метод стоит прямо перед адресом
      const before = text.slice(Math.max(0, m.index - 20), m.index).match(/\.(get|post|put|patch|delete)\(\s*$/i)?.[1];
      const method = (before || near.match(/\bmethod\s*:\s*['"`](\w+)['"`]/)?.[1] || 'GET').toUpperCase();
      if (e && !(e.methods ||= []).includes(method)) e.methods.push(method);
    }
  }

  // 3. Таблицы БД: CREATE TABLE в .sql/.js/.ts, модели prisma; обращения к ним из бэкенда
  const dbServices = services.filter((s) => s.layer === 'db');
  if (dbServices.length) {
    const db = dbServices[0];
    const tables = new Map();
    const schemaFiles = allFiles.filter((f) => /\.(sql|prisma|js|mjs|ts)$/.test(f));
    for (const f of schemaFiles) {
      let text = texts.get(f)?.text;
      if (text == null) { try { text = await readFile(path.join(root, f), 'utf8'); } catch { continue; } }
      for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(?:\w+["`\]]?\.)?["`[]?(\w+)/gi)) tables.set(m[1].toLowerCase(), f);
      if (f.endsWith('.prisma')) for (const m of text.matchAll(/^model\s+(\w+)/gm)) tables.set(m[1].toLowerCase(), f);
    }
    for (const [t, f] of tables) {
      nodes.set(`${db.id}:table:${t}`, { id: `${db.id}:table:${t}`, service: db.id, layer: 'db', label: t, kind: 'table', path: f, cluster: '', files: [f], mtime: 0 });
    }
    for (const [f, { text }] of texts) {
      const n = nodes.get(unitOf(f)?.id);
      if (!n || n.layer !== 'backend') continue;
      for (const t of tables.keys()) {
        const re = new RegExp(`\\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\\s+["\`]?${t}\\b|\\bprisma\\.${t}\\b`, 'i');
        if (re.test(text)) addEdge(n, nodes.get(`${db.id}:table:${t}`), 'db');
      }
    }
  }

  // Узлы с кодом вне файлов сервиса (импорт из чужой папки) отбрасываются ensureNode, рёбра к ним — тоже
  const edgeList = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));

  return {
    name: project.name,
    services: services.map(({ units, layers, openapi, dir, ...s }) => ({
      ...s,
      dir: dir || '.',
      swagger: openapi?.ui && s.url ? s.url.replace(/\/$/, '') + openapi.ui : null,
    })),
    links: project.links.map((l) => ({ from: l.from, to: l.to, label: l.label || null })),
    nodes: [...nodes.values()],
    edges: edgeList,
  };
}
