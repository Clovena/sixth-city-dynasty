import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';

const franchises = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/franchises' }),
});

export const collections = { franchises };
