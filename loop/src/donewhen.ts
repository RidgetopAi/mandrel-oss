import type { Punch } from './board.js';

/**
 * The ONE renderer for a punch's doneWhen clauses; the worker brief and the critic both use it,
 * so what the worker is told is word-for-word what the critic checks.
 */
export function renderDoneWhen(doneWhen: Punch['doneWhen']): string {
  if (typeof doneWhen === 'string') return doneWhen.trim();
  if (!Array.isArray(doneWhen)) return '';
  return doneWhen
    .map((c, i) => `(${i + 1}) ${c.text}${c.proof ? ` — proof: "${c.proof}"` : ''}`)
    .join('\n');
}
