import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://mikkelwestermann.github.io/falck',
  base: '/falck',
  output: 'static',
  integrations: [tailwind()],
});
