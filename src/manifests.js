import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const warehouseRoot = fileURLToPath(new URL('../../', import.meta.url));

const SKIP = new Set(['node_modules', 'vizor']);

// Каждый проект кладёт в свой корень vizor.json: сервисы, команды запуска и связи между ними.
export async function loadProjects() {
  const entries = await readdir(warehouseRoot, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const dir = path.join(warehouseRoot, entry.name);
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'vizor.json'), 'utf8'));
      projects.push({ links: [], ...manifest, name: manifest.name || entry.name, dir });
    } catch {
      // папка без vizor.json или с битым манифестом — не проект
    }
  }
  return projects;
}
