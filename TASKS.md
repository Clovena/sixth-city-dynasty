# SCDFL Site — Task Board

## TODO
- Hall of Fame - Player awards, HOF awards, trophies
- Historical matchups of spotlight games
- Blurbs for Bowl Games in Content page
- Rookie drafts on season recap pages
- Color refactoring to surface and glow
- More data from Sleeper API
  - Drafts
  - Transactions
- Cleanup
  - Align order of top and bottom nav bars
  - home/index.html still says Bowl Games on <a> block
  - Rivalry game slugs say Bowl Game
  - Align accolade symbols on franchises/index
  - Indent owner name to align with franchsie name on franchises/index
  - Season recap brackets on mobile
  - Franchises arranged as 2-3-2 on desktop, not 3-3-1

## Dev

## QA
- Single game matchups API query
- Season recap pages
  - Playoff brackets and transformation of matchups.json

## Polishing

*From a Claude Desktop review 2026-03-17:*

Navigation — minor inconsistency
The top nav includes "Spotlight Games" but the footer nav says "Bowl Games." These link to the same page but use different labels. Pick one and use it everywhere — "Spotlight Games" is more distinctive and matches the URL, but "Bowl Games & Rivalry Week" is more descriptive. Either works, just needs to be consistent.

Home page — one missing connection
The three section cards at the bottom link to History, Franchises, and Bowl Games — but Scores and Content are nav items with no homepage representation at all. For a visitor hitting the site cold, those sections are invisible unless they notice the nav. Even a small "Latest Content" or "Recent Scores" block would surface them.

Franchise pages — 2026 row in the season table
Every franchise shows a 2026 row with 0 | 0 | 0.00 | 0.00 and a blank result. This is a pre-season placeholder, which makes sense in your head, but to a visitor it looks like missing or broken data. Either hide rows where all values are zero, or add a subtle "Season not yet played" label to that row.

Content page — lorem ipsum is live
The Bowl Games Preview piece has real introductory copy but every individual Bowl Game section is lorem ipsum placeholder text. That's fine in development, but it's public-facing now. Either populate the real content or pull those sections until they're written. The mock draft content below it is fully written and genuinely good — the contrast makes the lorem ipsum more noticeable.

Spotlight Games — small typo
"Blowers vs Mustangs" rivalry description: "desparate" should be "desperate."

## Completed
- Content page
- 8.5x14 (legal) print layout
- Combine Bowl Games and Rivalry Games
- Rebranded & orphaned logo implementation
- Total row in franchise Season Records
- Game recaps for select matchups
- History page 
- Player headshot call - ESPN CDN & implementation in game recaps
- Bugfix Netlify deployment
- Mobile display optimization
