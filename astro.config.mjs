import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://windy664.github.io',
  output: 'static',
  outDir: './dist',
  publicDir: './static',
  redirects: {
    '/2026/11/04/2026-11-04-包发出去了却没有回音一次校园网多拨下的流量黑洞排查/':
      '/2026/11/04/2026-11-04-包走了没有回音-多拨环境里的三种黑洞/',
    '/2026/11/04/2026-11-04-鼠标绑定时灵时不灵-我在hyprlandluafork里抓到了release幽灵/':
      '/2026/11/06/2026-11-04-鼠标绑定时灵时不灵-我在hyprlandluafork里抓到了release幽灵/',
    '/2026/11/05/2026-11-05-上游歌词插件坏了没人修-我用rust重写了omarchy顶栏卡拉ok/':
      '/2026/11/08/2026-11-05-上游歌词插件坏了没人修-我用rust重写了omarchy顶栏卡拉ok/',
    '/2026/11/05/2026-11-05-三个校园网账号挤两条外线/':
      '/2026/11/10/2026-11-05-三个校园网账号挤两条外线/',
    '/2026/11/05/2026-11-05-一段对话三天搬了8次/':
      '/2026/11/12/2026-11-05-一段对话三天搬了8次/',
  },
  integrations: [sitemap({
    filter: (page) => {
      const path = new URL(page).pathname;
      return !path.startsWith('/archives/2026/') && path !== '/archives/2026/'
        && !/\/page\/\d+\/$/.test(path)
        && !['/search/', '/links/', '/404.html'].includes(path);
    },
  })],
});
