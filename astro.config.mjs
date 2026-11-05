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
