import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import { astroGrab } from "astro-grab";

export default defineConfig({
  site: "https://mikkelwestermann.github.io/falck",
  base: "/",
  output: "static",
  integrations: [
    tailwind(),
    astroGrab({
      enabled: true,
      holdDuration: 1000,
      contextLines: 4,
      // set the hue to the same green color used for the theme
      hue: 163.1,
      toolbar: true,
      template: `[site_context] Source: {{file}}:{{targetLine}}

\`\`\`{{language}}
{{snippet}}
\`\`\``,
    }),
  ],
});
