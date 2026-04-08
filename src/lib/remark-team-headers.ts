/**
 * Remark plugin: transforms consecutive bold+italic paragraph pairs into styled
 * team entry blocks in writeup markdown files.
 *
 * Matching:
 *   - 1 franchise name found → single-team header (left border + logo + text)
 *   - 2 franchise names found → matchup header (logos on both sides, text centered)
 *
 * Team ordering in matchup blocks follows the order names appear in the combined text.
 *
 * NOTE: Uses direct index iteration over tree.children rather than unist-util-visit,
 * to avoid index-drift bugs that occur when splicing nodes during visit traversal.
 */

import type { Root, Paragraph, Node } from 'mdast';
import { createClient } from '@supabase/supabase-js';

function extractText(node: Node): string {
  if ('value' in node) return (node as { value: string }).value;
  if ('children' in node) return (node as { children: Node[] }).children.map(extractText).join('');
  return '';
}

function isStrongParagraph(node: Node): node is Paragraph {
  return (
    node.type === 'paragraph' &&
    (node as Paragraph).children.length === 1 &&
    (node as Paragraph).children[0].type === 'strong'
  );
}

function isEmParagraph(node: Node): node is Paragraph {
  return (
    node.type === 'paragraph' &&
    (node as Paragraph).children.length === 1 &&
    (node as Paragraph).children[0].type === 'emphasis'
  );
}

type Franchise = { abbr: string; name: string; colors: string[] };

/** Find all franchise matches in the combined text, sorted by position of appearance. */
function findMatches(combined: string, franchiseByName: Map<string, Franchise>) {
  const found: { position: number; franchise: Franchise }[] = [];
  for (const [name, f] of franchiseByName) {
    const pos = combined.indexOf(name);
    if (pos !== -1) found.push({ position: pos, franchise: f });
  }
  found.sort((a, b) => a.position - b.position);
  return found.map(m => m.franchise);
}

export function remarkTeamHeaders() {
  return async (tree: Root) => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!
    );

    const { data: franchises, error } = await supabase
      .schema('scdfl')
      .from('franchises')
      .select('abbr, name, colors')
      .is('to', null);

    if (error || !franchises) throw new Error(`Franchises query failed: ${error?.message || 'No data returned'}`);

    const franchiseByName = new Map<string, Franchise>(franchises.map((f: Franchise) => [f.name, f]));
    const children = tree.children as Node[];
    let i = 0;

    while (i < children.length) {
      const node = children[i];

      if (!isStrongParagraph(node)) { i++; continue; }

      const strongText = extractText(node.children[0]);

      const next = children[i + 1];
      const hasNextEm = !!next && isEmParagraph(next);
      const emText = hasNextEm ? extractText((next as Paragraph).children[0]) : '';

      const combined = `${strongText} ${emText}`;
      const matches = findMatches(combined, franchiseByName);

      if (matches.length === 0) { i++; continue; }

      let html: string;

      if (matches.length >= 2) {
        // ── Matchup header: two teams ──────────────────────────────────
        const teamA = matches[0];
        const teamB = matches[1];
        const colorA = teamA.colors[0];
        const colorB = teamB.colors[0];

        html = [
          `<div class="team-entry team-entry--matchup" style="`,
          `border-left: 3px solid ${colorA};`,
          `border-right: 3px solid ${colorB};`,
          `padding: 0.65rem 1.25rem;`,
          `margin: 2.25rem 0 0.25rem;`,
          `display: flex; align-items: center; gap: 0.75rem;`,
          `">`,
          `<img src="/images/logos/${teamA.abbr}.png" alt="" width="48" height="48"`,
          ` style="object-fit: contain; flex-shrink: 0;" onerror="this.style.display='none'" />`,
          `<div style="flex: 1; text-align: center;">`,
          `<span style="font-family: var(--font-display); font-size: 1.1rem; font-weight: 600;`,
          ` color: var(--color-text-primary); line-height: 1.2; display: block;">${strongText}</span>`,
          hasNextEm
            ? `<span style="display: block; font-size: 0.8rem; color: var(--color-text-muted); font-style: italic;` +
              ` margin: 0.3rem 0 0;">${emText}</span>`
            : '',
          `</div>`,
          `<img src="/images/logos/${teamB.abbr}.png" alt="" width="48" height="48"`,
          ` style="object-fit: contain; flex-shrink: 0;" onerror="this.style.display='none'" />`,
          `</div>`,
        ].join('');

      } else {
        // ── Single-team header ────────────────────────────────────────
        const { abbr, colors } = matches[0];
        const color = colors[0];
        const emIndent = '60px';

        html = [
          `<div class="team-entry" style="border-left: 3px solid ${color}; padding: 0.65rem 0 0.65rem 1.25rem; margin: 2.25rem 0 0.25rem;">`,
          `<div style="display: flex; align-items: center; gap: 0.75rem;">`,
          `<img src="/images/logos/${abbr}.png" alt="" width="48" height="48"`,
          ` style="object-fit: contain; flex-shrink: 0;" onerror="this.style.display='none'" />`,
          `<span style="font-family: var(--font-display); font-size: 1.1rem; font-weight: 600;`,
          ` color: var(--color-text-primary); line-height: 1.2;">${strongText}</span>`,
          `</div>`,
          hasNextEm
            ? `<p style="font-size: 0.8rem; color: var(--color-text-muted); font-style: italic;` +
              ` margin: 0.3rem 0 0; padding-left: ${emIndent};">${emText}</p>`
            : '',
          `</div>`,
        ].join('');
      }

      children.splice(i, hasNextEm ? 2 : 1, { type: 'html', value: html } as any);
      i++; // advance past the newly inserted html node
    }
  };
}
