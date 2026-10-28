// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// GitHub Pages project site: https://lthero-big.github.io/dropit/
export default defineConfig({
  site: 'https://lthero-big.github.io',
  base: '/dropit',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'dropit',
      description: '跨设备实时传递文本和文件的自托管云剪贴板',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      // 中文为根语言（URL 无前缀）。以后加英文：在 locales 里加
      // en: { label: 'English', lang: 'en' }，并在 src/content/docs/en/ 下放同名页面。
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/lthero-big/dropit' },
      ],
      editLink: {
        baseUrl: 'https://github.com/lthero-big/dropit/edit/main/site/',
      },
      lastUpdated: true,
      sidebar: [
        {
          label: '入门',
          items: [
            { slug: 'start/getting-started' },
            { slug: 'start/user-guide' },
            { slug: 'start/cli' },
          ],
        },
        {
          label: '部署',
          items: [
            { slug: 'deploy/deployment' },
            { slug: 'deploy/administration' },
            { slug: 'deploy/security' },
          ],
        },
        {
          label: '配置',
          items: [
            { slug: 'config/configuration' },
            { slug: 'config/backend-config' },
          ],
        },
        {
          label: 'API',
          items: [
            { slug: 'api/overview' },
            { slug: 'api/reference' },
          ],
        },
        {
          label: '开发',
          items: [
            { slug: 'dev/architecture' },
            { slug: 'dev/development' },
          ],
        },
        { slug: 'faq' },
      ],
    }),
  ],
});
