import { allPosts, dateText, tags, termSlug, type Post } from './posts';

export type TopicTrack = {
  id: string;
  tag: string;
  title: string;
  subtitle: string;
  posts: Post[];
};

// 专题完全由标签频率长出来：一个标签下的文章数达到门槛，就自动聚合为专题。
// 新方向写得多了会自己浮上来，冷下来的会自己沉下去，不需要维护名单。
const TOPIC_MIN_POSTS = 5;

export function topicTracks(posts: Awaited<ReturnType<typeof allPosts>>): TopicTrack[] {
  return tags(posts)
    .filter(({ count }) => count >= TOPIC_MIN_POSTS)
    .map(({ name, count }) => {
      const trackPosts = posts
        .filter((post) => post.data.tags.includes(name))
        .sort((a, b) => dateText(a).localeCompare(dateText(b)));
      const span = trackPosts.length > 1
        ? ` · ${dateText(trackPosts[0])} ~ ${dateText(trackPosts[trackPosts.length - 1])}`
        : '';
      return {
        id: termSlug(name),
        tag: name,
        title: name,
        subtitle: `${count} 篇${span}`,
        posts: trackPosts,
      };
    });
}
