import { allPosts, dateText, type Post } from './posts';

export type TopicTrack = {
  id: string;
  tag: string;
  number: string;
  label: string;
  title: string;
  subtitle: string;
  intro: string;
  posts: Post[];
};

// 专题标签：只要文章打了这些标签，就自动聚合成对应专题
const topicTags = ['逆向工程', 'WindyAgent', '工程化', '折腾'];

// 可选：为某些标签提供更可读的大标题、副标题和介绍
const topicMeta = new Map<string, { label?: string; title: string; subtitle?: string; intro?: string }>([
  ['逆向工程', { label: 'REVERSE', title: '逆向校园软件', subtitle: '从抓包到插件，把平台一个个啃下来', intro: '点餐、校园卡、学习通、图书馆、教务、智慧树，外加一次小米 BootLoader 的碰壁。每篇都从抓包讲起，到请求伪造、协议还原为止。' }],
  ['WindyAgent', { label: 'LONG RUNNING', title: 'WindyAgent', subtitle: '从功能生长，到追问边界', intro: '沿着这些文章，可以看到工具、记忆和护栏如何逐渐成形，也看到关于通用运行时的新疑问。' }],
  ['工程化', { label: 'BUILDING', title: '工程与服务端', subtitle: '让系统经得起真实运行', intro: '构建、类加载、跨服通信和线程约束。问题总在系统真正运行时浮现，这里记下它们的来龙去脉。' }],
  ['折腾', { label: 'EXPLORING', title: '折腾与复盘', subtitle: '桌面、容器和一次黑客松', intro: '换系统、算容器账、复盘比赛。这些事和写代码一样，动手之前都先想清楚要什么。' }],
]);

export function topicTracks(posts: Awaited<ReturnType<typeof allPosts>>): TopicTrack[] {
  return topicTags
    .map((tag, i) => {
      const meta = topicMeta.get(tag);
      const trackPosts = posts
        .filter((post) => post.data.tags.includes(tag))
        .sort((a, b) => dateText(a).localeCompare(dateText(b)));
      return {
        id: tag.trim(),
        tag,
        number: String(i + 1).padStart(2, '0'),
        label: meta?.label || 'READING',
        title: meta?.title || tag,
        subtitle: meta?.subtitle || '',
        intro: meta?.intro || '',
        posts: trackPosts,
      };
    })
    .filter((t) => t.posts.length > 0);
}
