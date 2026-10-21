// Поднимает vizor и все сервисы всех проектов из vizor.json: node dev.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadProjects, warehouseRoot } from './vizor/src/manifests.js';

const COLORS = [36, 35, 32, 34, 31, 37];

const projects = await loadProjects();
const services = [
  { label: 'vizor', cwd: path.join(warehouseRoot, 'vizor'), command: 'npm run dev' },
  ...projects.flatMap((p) =>
    p.services
      .filter((s) => s.command)
      .map((s) => ({
        label: `${p.name}/${s.id}`,
        cwd: path.join(p.dir, s.dir || '.'),
        command: s.command,
      })),
  ),
];

const children = services.map(({ label, cwd, command }, i) => {
  const child = spawn(command, { cwd, shell: true });
  const prefix = `\x1b[${COLORS[i % COLORS.length]}m[${label}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) out.write(prefix + line + '\n');
      }
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => console.log(`${prefix}завершился с кодом ${code}`));
  return child;
});

function shutdown() {
  for (const child of children) {
    // npm на Windows запускает дерево процессов, поэтому убиваем его целиком
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
