#!/usr/bin/env node
// Translate Chinese posts to English via the local `kimi` CLI (stream-json mode).
// Usage: node scripts/translate.mjs --all [--force] | node scripts/translate.mjs <slug> [<slug>...]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const SRC_DIR = 'source/_posts';
const OUT_DIR = 'source/_posts-en';
const CACHE_FILE = join(OUT_DIR, '.cache.json');

const CATEGORY_MAP = [
  ['AI 应用', 'AI Applications'],
  ['工程化', 'Engineering'],
  ['架构', 'Architecture'],
  ['思考', 'Thoughts'],
  ['踩坑', 'Postmortems'],
  ['后端基础', 'Backend Basics'],
  ['技术分享', 'Tech Notes'],
];

const args = process.argv.slice(2);
const force = args.includes('--force');
const all = args.includes('--all');
const requested = args.filter((a) => !a.startsWith('--')).map((a) => a.replace(/\.md$/, ''));

const sourceFiles = readdirSync(SRC_DIR).filter((f) => f.endsWith('.md'));
let targets = sourceFiles.map((f) => f.replace(/\.md$/, ''));
if (!all) targets = targets.filter((slug) => requested.includes(slug));
if (targets.length === 0) {
  console.error('No matching posts. Usage: node scripts/translate.mjs --all | <slug>...');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};

function buildPrompt(markdown) {
  return `You are translating a Chinese technical blog post to English for a personal engineering blog.

Rules:
- Output ONLY the translated markdown file content. No commentary, no wrapping code fences.
- Preserve the markdown structure, headings, lists, tables, links, image references, and all frontmatter keys.
- Do not translate code, commands, file paths, URLs, or proper nouns; translate natural-language comments inside code blocks only when it reads naturally.
- Translate the frontmatter values for title, tags, and description. Translate categories using exactly this mapping:
${CATEGORY_MAP.map(([zh, en]) => `  ${zh} -> ${en}`).join('\n')}
- Keep the frontmatter date value unchanged.
- Write natural, fluent technical English in the author's first-person voice. Keep it direct; do not add marketing tone.
- If a Chinese cultural reference would confuse an English reader, add a brief inline gloss.

Here is the source markdown file:

${markdown}`;
}

function sanitizeFrontmatter(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(title|description): (.+)$/);
    if (!match) continue;
    const value = match[2];
    const quoted = value.startsWith('"') || value.startsWith("'");
    const risky = value.includes('"') || value.includes("'") || value.includes(': ') || value.includes(' #');
    if (!quoted && risky) lines[i] = `${match[1]}: ${JSON.stringify(value)}`;
  }
  const text2 = lines.join('\n');
  const frontmatter = text2.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) throw new Error('Translation is missing the frontmatter block');
  const parsed = yaml.load(frontmatter[1]);
  for (const key of ['title', 'date', 'categories']) {
    if (!parsed?.[key]) throw new Error(`Translated frontmatter is missing "${key}"`);
  }
  return text2;
}

function runTranslation(markdown) {
  const result = spawnSync('kimi', ['--output-format', 'stream-json', '-p', buildPrompt(markdown)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 900000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`kimi exited with ${result.status}: ${(result.stderr || '').slice(-500)}`);
  let text = '';
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.role === 'assistant' && typeof event.content === 'string') text = event.content;
    } catch {}
  }
  if (!text.trim().startsWith('---')) {
    throw new Error(`Unexpected translator output (first 200 chars): ${text.slice(0, 200)}`);
  }
  return sanitizeFrontmatter(text.trim()) + '\n';
}

let done = 0;
let skipped = 0;
for (const slug of targets) {
  const sourcePath = join(SRC_DIR, `${slug}.md`);
  const outPath = join(OUT_DIR, `${slug}.md`);
  const markdown = readFileSync(sourcePath, 'utf8');
  const hash = createHash('sha256').update(markdown).digest('hex');
  if (!force && cache[slug]?.hash === hash && existsSync(outPath)) {
    skipped++;
    continue;
  }
  process.stdout.write(`[translate] ${slug} ... `);
  const started = Date.now();
  try {
    const translated = runTranslation(markdown);
    writeFileSync(outPath, translated);
    cache[slug] = { hash, translatedAt: new Date().toISOString() };
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
    console.log(`ok (${Math.round((Date.now() - started) / 1000)}s)`);
    done++;
  } catch (error) {
    console.log(`FAILED: ${error.message}`);
  }
}
console.log(`Done: ${done} translated, ${skipped} up-to-date, ${targets.length - done - skipped} failed.`);
if (done < targets.length - skipped) process.exit(1);
