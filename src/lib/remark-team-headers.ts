/**
 * Remark plugin: transforms consecutive bold+italic paragraph pairs into styled
 * team entry blocks in writeup markdown files.
 *
 * For each paragraph containing a single <strong> child, checks if the next
 * sibling paragraph contains a single <em> child. Combines the text of both
 * and searches for an exact full franchise name match (from franchises.json).
 *
 * When a match is found, both nodes are replaced with a single styled HTML block:
 *   - Left border in the team's primary color
 *   - Team logo + bold line (flex row)
 *   - Italic line indented to align with the bold text
 *
 * NOTE: Uses direct index iteration over tree.children rather than unist-util-visit,
 * to avoid index-drift bugs that occur when splicing nodes during visit traversal.
 */

import type { Root, Paragraph, Node } from 'mdast';
import franchises from '../data/franchises.json';

const franchiseByName = new Map(franchises.map(f => [f.name, f]));

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

export function remarkTeamHeaders() {
  return (tree: Root) => {
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

      let franchise: typeof franchises[0] | undefined;
      for (const [name, f] of franchiseByName) {
        if (combined.includes(name)) { franchise = f; break; }
      }

      if (!franchise) { i++; continue; }

      const { abbr, colors } = franchise;
      const color = colors[0];
      const emIndent = '60px';

      const html = [
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

      children.splice(i, hasNextEm ? 2 : 1, { type: 'html', value: html } as any);
      i++; // advance past the newly inserted html node
    }
  };
}
