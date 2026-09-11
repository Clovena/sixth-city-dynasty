import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const franchises = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/franchises' }),
});

// Only matches files directly in /writeups/ — archive/ subdirectory is excluded automatically
const writeups = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/writeups' }),
});

const recaps = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/recaps' }),
  schema: z.object({
    year: z.number(),
    week: z.number(),
    team_a: z.string(),
    team_b: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    author: z.string().default('Zac'),
    date: z.string(),
    featured: z.boolean().default(false),
  }),
});

// Front-page editorial copy. One file per slot; `lede-blurb` is the centre lede.
// `status` gates result formatting on the scorebug — the winner is only marked
// once the game is actually final, so a live or scheduled game reads as neutral.
const homepage = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/homepage' }),
  schema: z.object({
    title: z.string(),
    subtitle: z.string(),
    status: z.enum(['scheduled', 'active', 'final']).default('scheduled'),
  }),
});

const seasons = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/seasons' }),
});

export const collections = { franchises, writeups, recaps, seasons, homepage };
