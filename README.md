# Sixth City Dynasty Fantasy Football League

Official website for the Sixth City Dynasty Fantasy Football League (SCDFL) — a 14-team dynasty fantasy football league founded in 2021, hosted on Sleeper. Est. 2021. Commissioner: Zac.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

Open [http://localhost:4321](http://localhost:4321) in your browser.

## Build

```bash
npm run build
```

Output goes to `dist/`.

## Preview production build

```bash
npm run preview
```

## Deployment

The site deploys automatically to Netlify on push to the main branch. Build config is in `netlify.toml`.

## Stack

- [Astro](https://astro.build/) — static site generator
- [Tailwind CSS](https://tailwindcss.com/) — styling
- [Netlify](https://netlify.com/) — hosting

## Content

- Franchise data: `src/data/franchises.json`
- Season history: `src/data/seasons.json`
- Bowl games: `src/data/bowl_games.json`
- Rivalries: `src/data/rivalries.json`
- Per-franchise notes: `src/content/franchises/[abbr].md`
