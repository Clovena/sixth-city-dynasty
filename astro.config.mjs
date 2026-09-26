// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import netlify from '@astrojs/netlify';
import { loadEnv } from 'vite';
import { remarkTeamHeaders } from './src/lib/remark-team-headers';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = loadEnv('', process.cwd(), '');

// https://astro.build/config
export default defineConfig({
  // Site-wide default stays static; individual routes opt into on-demand
  // rendering with `export const prerender = false` (see src/pages/players/[id].astro, src/pages/games/[year]/[slug].astro).
  output: 'static',
  adapter: netlify(),
  vite: {
    plugins: [tailwindcss()]
  },
  markdown: {
    remarkPlugins: [[remarkTeamHeaders, { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_SERVICE_KEY }]],
  }
});