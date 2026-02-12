import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://your-site.com',
  output: 'static',
  integrations: [tailwind()],
});
