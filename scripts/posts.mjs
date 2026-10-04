import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const postDir = new URL('../source/_posts/', import.meta.url);
const categories = ['AI 应用', '工程化', '架构', '思考', '踩坑', '后端基础', '技术分享'];
const [action, ...args] = process.argv.slice(2);

function now() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function posts() {
  return readdirSync(postDir).filter((name) => name.endsWith('.md')).map((name) => {
    const path = new URL(name, postDir);
    const body = readFileSync(path, 'utf8');
    const frontmatter = body.match(/^---\s*\n([\s\S]*?)\n---/);
    const field = (key) => frontmatter?.[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim();
    const rawTitle = field('title') || '';
    let title = rawTitle;
    if (rawTitle.startsWith('"')) {
      try { title = JSON.parse(rawTitle); } catch { /* Keep the raw title for lookup. */ }
    }
    return { name, path, body, title, date: field('date') || '', draft: field('draft') === 'true' };
  });
}

function choose(query) {
  if (!query) throw new Error('请提供文章标题、标题关键词或文件编号。');
  const all = posts();
  const exact = all.filter((post) => post.title === query || post.name === query || post.name === `${query}.md`);
  const matches = exact.length ? exact : all.filter((post) => post.title.includes(query) || post.name.includes(query));
  if (matches.length !== 1) {
    const detail = matches.length ? `匹配到多篇：\n${matches.map((post) => `  ${post.name}  ${post.title}`).join('\n')}` : '没有找到文章。可用 npm run post:list -- "关键词" 查询。';
    throw new Error(detail);
  }
  return matches[0];
}

function urlFor(post) {
  const date = post.date.slice(0, 10).replaceAll('-', '/');
  return `https://windy664.github.io/${date}/${post.name.slice(0, -3)}/`;
}

try {
  if (action === 'new') {
    const title = args[0]?.trim();
    if (!title) throw new Error('用法：npm run post:new -- "中文标题" [--category 工程化] [--tags "Minecraft,Velocity"]');
    const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
    const category = option('--category') || '思考';
    if (!categories.includes(category)) throw new Error(`分类必须是：${categories.join('、')}`);
    const tags = (option('--tags') || '').split(',').map((tag) => tag.trim()).filter(Boolean);
    if (tags.length > 8 || tags.some((tag) => /[\[\]\n]/.test(tag))) throw new Error('标签最多 8 个，不能包含方括号或换行。');
    let path;
    do { path = new URL(`p-${randomBytes(6).toString('hex')}.md`, postDir); } while (existsSync(path));
    const content = `---\ntitle: ${JSON.stringify(title)}\ndate: ${now()}\ndraft: true\ncategories: [${category}]\ntags: [${tags.map((tag) => JSON.stringify(tag)).join(', ')}]\n---\n\n在这里写正文。\n`;
    writeFileSync(path, content, { flag: 'wx' });
    console.log(`已创建草稿：${join('source/_posts', path.pathname.split('/').pop())}\n发表前请修改正文，完成后运行 npm run post:publish -- "${title}"。`);
  } else if (action === 'list') {
    const query = args.join(' ').trim();
    const matches = posts().filter((post) => !query || post.title.includes(query) || post.name.includes(query)).sort((a, b) => b.date.localeCompare(a.date));
    if (!matches.length) console.log('没有匹配的文章。');
    else for (const post of matches) console.log(`${post.draft ? '草稿' : '已发表'}  ${post.date.slice(0, 10)}  ${post.title}\n       source/_posts/${post.name}${post.draft ? '' : `\n       ${urlFor(post)}`}`);
  } else if (action === 'publish') {
    const post = choose(args.join(' ').trim());
    if (!post.draft) throw new Error(`这篇文章已经发表：source/_posts/${post.name}`);
    const content = post.body.replace(/^draft:\s*true\s*$/m, 'draft: false').replace(/^date:.*$/m, `date: ${now()}`);
    const article = content.replace(/^---\s*\n[\s\S]*?\n---/, '').trim();
    if (!article || article === '在这里写正文。') throw new Error('请先写完正文，再发表。');
    writeFileSync(post.path, content);
    console.log(`已设为公开：source/_posts/${post.name}\n请运行 npm run check && npm run build，检查通过后提交并推送 master。发表后保持文件名和 date 不变，修改标题或正文不会改变网址。`);
  } else {
    throw new Error('命令：npm run post:new -- "标题"、npm run post:list -- "关键词"、npm run post:publish -- "标题或编号"');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
