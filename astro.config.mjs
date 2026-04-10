// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';
import { remarkTeamHeaders } from './src/lib/remark-team-headers';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = loadEnv('', process.cwd(), '');

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()]
  },
  markdown: {
    remarkPlugins: [[remarkTeamHeaders, { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_SERVICE_KEY }]],
  }
});