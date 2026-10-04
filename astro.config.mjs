import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://windy664.github.io',
  output: 'static',
  outDir: './dist',
  publicDir: './static',
  integrations: [sitemap({
    filter: (page) => {
      const path = new URL(page).pathname;
      return !path.startsWith('/archives/2026/') && path !== '/archives/2026/'
        && !/\/page\/\d+\/$/.test(path)
        && !['/search/', '/links/', '/404.html'].includes(path);
    },
  })],
});
