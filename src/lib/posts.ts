import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'>;

export function dateText(post: Post): string {
  const value = post.data.date;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function postUrl(post: Post): string {
  const [year, month, day] = dateText(post).split('-');
  const slug = post.id.replace(/\.md$/, '').split('/').pop();
  return `/${year}/${month}/${day}/${slug}/`;
}

export function termSlug(term: string): string {
  return term.trim().replace(/\s+/g, '-');
}

export function categoryUrl(category: string): string {
  return `/categories/${encodeURIComponent(termSlug(category))}/`;
}

export function tagUrl(tag: string): string {
  return `/tags/${encodeURIComponent(termSlug(tag))}/`;
}

export function excerpt(post: Post, length = 140): string {
  return (post.body || '')
    .split('<!-- more -->')[0]
    .replace(/^---[\s\S]*?---/m, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*`_>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, length);
}

export function readingMinutes(post: Post): number {
  return Math.max(1, Math.round((post.body || '').length / 450));
}

export async function allPosts(): Promise<Post[]> {
  return (await getCollection('posts', ({ data }) => !data.draft)).sort((a, b) =>
    (b.data.date instanceof Date ? b.data.date.toISOString() : String(b.data.date))
      .localeCompare(a.data.date instanceof Date ? a.data.date.toISOString() : String(a.data.date)) || a.id.localeCompare(b.id)
  );
}

export function categories(posts: Post[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const category of post.data.categories) counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

export function tags(posts: Post[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
