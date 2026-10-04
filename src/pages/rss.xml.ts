import type { APIRoute } from 'astro';
import { allPosts, dateText, excerpt, postUrl } from '../lib/posts';

const escapeXml = (value: string) => value.replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch] || ch);

export const GET: APIRoute = async () => {
  const posts = (await allPosts()).slice(0, 30);
  const items = posts.map((post) => {
    const url = `https://windy664.github.io${postUrl(post)}`;
    return `<item><title>${escapeXml(post.data.title)}</title><link>${url}</link><guid>${url}</guid><pubDate>${new Date(`${dateText(post)}T12:00:00+08:00`).toUTCString()}</pubDate><description>${escapeXml(excerpt(post, 220))}</description></item>`;
  }).join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Torine 的博客</title><link>https://windy664.github.io/</link><description>记下实践中的问题、判断的变化，以及尚未走完的路。</description><language>zh-CN</language>${items}</channel></rss>`, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
};
