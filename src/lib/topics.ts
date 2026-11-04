import { allPosts, dateText, tags, termSlug, type Post } from './posts';

export type TopicTrack = {
  id: string;
  tag: string;
  label: string;
  title: string;
  subtitle: string;
  intro: string;
  posts: Post[];
};

// 专题完全由标签频率长出来：一个标签下的文章数达到门槛，就自动聚合为专题。
// 新方向写得多了会自己浮上来，冷下来的会自己沉下去，不需要维护名单。
const TOPIC_MIN_POSTS = 5;

// 可选的展示润色：给个别标签配更可读的标题、副标题和导语。
// 不配置的标签照样成专题，标题直接用标签名。
const topicMeta = new Map<string, { label?: string; title: string; subtitle?: string; intro?: string }>([
  ['逆向工程', { label: 'REVERSE', title: '逆向校园软件', subtitle: '从抓包到插件，把平台一个个啃下来', intro: '点餐、校园卡、学习通、图书馆、教务、智慧树，外加一次小米 BootLoader 的碰壁。每篇都从抓包讲起，到请求伪造、协议还原为止。' }],
  ['WindyAgent', { label: 'LONG RUNNING', title: 'WindyAgent', subtitle: '从功能生长，到追问边界', intro: '沿着这些文章，可以看到工具、记忆和护栏如何逐渐成形，也看到关于通用运行时的新疑问。' }],
  ['工程化', { label: 'BUILDING', title: '工程与服务端', subtitle: '让系统经得起真实运行', intro: '构建、类加载、跨服通信和线程约束。问题总在系统真正运行时浮现，这里记下它们的来龙去脉。' }],
  ['折腾', { label: 'EXPLORING', title: '折腾与复盘', subtitle: '桌面、容器和一次黑客松', intro: '换系统、算容器账、复盘比赛。这些事和写代码一样，动手之前都先想清楚要什么。' }],
]);

export function topicTracks(posts: Awaited<ReturnType<typeof allPosts>>): TopicTrack[] {
  return tags(posts)
    .filter(({ count }) => count >= TOPIC_MIN_POSTS)
    .map(({ name, count }) => {
      const meta = topicMeta.get(name);
      const trackPosts = posts
        .filter((post) => post.data.tags.includes(name))
        .sort((a, b) => dateText(a).localeCompare(dateText(b)));
      return {
        id: termSlug(name),
        tag: name,
        label: meta?.label || 'READING',
        title: meta?.title || name,
        subtitle: meta?.subtitle || `${count} 篇，按时间线读`,
        intro: meta?.intro || '',
        posts: trackPosts,
      };
    });
}
