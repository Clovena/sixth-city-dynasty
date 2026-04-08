# SCDFL Site — Task Board

## TODO
1. More content 
    - Game recaps
    - Better rivalry blurbs
1. Hall of Fame - Player awards, HOF awards, trophies
1. Low priority QOL cleanup
    - Color refactoring to surface and glow
    - Season recap brackets on mobile
    - Franchises arranged as 2-3-2 on desktop, not 3-3-1
    - Transaction explorer mobile layout

## Dev
- Consolation bracket
  - Seedings complete for non-playoff teams
  - Brackets generated on season recap pages

## Codebase
- Centralize functions
  - `effectiveAbbr()`
  - `toRoman()`
- Pull data in the same way always
  - `.schema()` first

## QA

## Polishing

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
- Transaction data
- Draft data
- Single game matchups API query
- Season recap pages
  - Playoff brackets and transformation of matchups.json
- Rookie drafts on season recap pages
- Blurbs for Bowl Games in Content page
- Bugfix game recap slugs on rebranded teams
- Exhibition games
  - Manual-ish API call, separate from programmatic matchups call
  - Display on score pages and year recap pages
- Supabase migration
- Remove various locations of hardcoding logic to convert between SAR and MTL
- Player profile pages, a la pro-football-reference