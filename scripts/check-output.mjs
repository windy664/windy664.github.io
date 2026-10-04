import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const root = 'dist';
const htmlFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (extname(file) === '.html') htmlFiles.push(file);
  }
};
walk(root);

const errors = [];
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(/href="(\/(?!\/)[^"]*)"/g)) {
    let path;
    try { path = decodeURIComponent(match[1].split(/[?#]/)[0]); }
    catch { errors.push(`${file}: invalid URL ${match[1]}`); continue; }
    const target = join(root, path);
    if (!existsSync(target) && !existsSync(join(target, 'index.html')) && !existsSync(`${target}.html`)) {
      errors.push(`${file}: missing ${match[1]}`);
    }
  }
}

const postFiles = readdirSync('source/_posts').filter((name) => name.endsWith('.md'));
for (const file of postFiles) {
  const body = readFileSync(join('source/_posts', file), 'utf8');
  const frontmatter = body.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatter && /^draft:\s*true\s*$/m.test(frontmatter[1])) continue;
  const date = body.match(/^date:\s*(\d{4})-(\d{2})-(\d{2})/m);
  if (!date) { errors.push(`${file}: date is missing or invalid`); continue; }
  const expected = join(root, date[1], date[2], date[3], basename(file, '.md'), 'index.html');
  if (!existsSync(expected)) errors.push(`${file}: legacy article URL missing (${expected})`);
}

const oldRoutes = [
  'archives/2026', 'archives/2026/06', 'archives/2026/07', 'archives/2026/09', 'archives/2026/10',
  'archives/page/2', 'archives/page/3', 'archives/page/4',
  'archives/2026/page/2', 'archives/2026/page/3', 'archives/2026/page/4',
  'archives/2026/06/page/2', 'archives/2026/06/page/3',
  'categories/AI-应用/page/2',
  'tags/Agent/page/2', 'tags/Agent/page/3', 'tags/LLM/page/2', 'tags/Minecraft/page/2',
];
for (const route of oldRoutes) {
  if (!existsSync(join(root, route, 'index.html'))) errors.push(`legacy route missing: /${route}/`);
}

if (errors.length) {
  console.error(`\nBuild verification found ${errors.length} issue(s):\n${errors.slice(0, 50).join('\n')}`);
  process.exit(1);
}
console.log(`Verified published article permalinks, ${oldRoutes.length} old routes and ${htmlFiles.length} HTML pages.`);
