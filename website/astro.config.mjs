import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://mikkelwestermann.github.io/falck',
  base: process.env.NODE_ENV === 'production' ? '/falck' : '/',
  output: 'static',
  integrations: [tailwind()],
});
