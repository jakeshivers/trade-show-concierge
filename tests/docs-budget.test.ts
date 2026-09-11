import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `CLAUDE.md` has to stay loadable, and twice now it has not.
 *
 * Past roughly 150,000 characters the file stops being loaded in full, which is
 * the exact failure it exists to prevent: a fresh session reading nothing is
 * worse than one reading a shorter version. It has been trimmed twice — 214k →
 * 150k, then 177k → 145k — and both times the regrowth came from the same
 * place, which is why this is a test rather than a third paragraph asking
 * nicely. **A rule nothing enforces is a rule that lasted one trim.**
 *
 * The failure mode is not one bad commit. It is that every session writes its
 * step retrospective at full length without reading what is already there, and
 * six of those is 27k. So this fails *before* the limit, with the budget in the
 * message, while there is still room to land the step being written.
 *
 * **If this fails, do not raise the number.** The fix is in the working
 * agreement: a step section is inventory and pointers, every rule is stated
 * once in Ground rules, and the story of how it was found belongs in the commit
 * message. Compress the section you were about to add to, or the one above it.
 */

const HARD_LIMIT = 150_000;
/** Fails here, so there is room to finish the step that tripped it. */
const BUDGET = 148_000;

function chars(name: string): number {
  return readFileSync(resolve(__dirname, '..', name), 'utf8').length;
}

describe('CLAUDE.md stays loadable', () => {
  it(`is under the ${BUDGET.toLocaleString()} character budget`, () => {
    const size = chars('CLAUDE.md');
    expect(
      size,
      `CLAUDE.md is ${size.toLocaleString()} chars, over the ${BUDGET.toLocaleString()} budget ` +
        `(hard limit ${HARD_LIMIT.toLocaleString()}, past which it is not loaded at all).\n\n` +
        'Do not raise the budget. Compress instead — the growth is always the same thing:\n' +
        '  · a step section restating a correction that is already a ground rule\n' +
        '  · a rule argued in two places instead of stated once next to the rule\n' +
        '  · the story of how something was found, which belongs in the commit message\n\n' +
        'See the Working agreement, item 3.',
    ).toBeLessThan(BUDGET);
  });

  it('keeps the ground rules, which are the part that must not be traded away', () => {
    // The trims are allowed to touch the narratives and never this section. If a
    // compression pass ever takes rules out to buy room, that is the one outcome
    // worth failing over — the budget exists to protect these, not to compete
    // with them.
    const rules = readFileSync(resolve(__dirname, '..', 'CLAUDE.md'), 'utf8')
      .split('## Ground rules')[1]
      .split('## Commands')[0]
      .match(/^- \*\*/gm);
    expect(rules?.length ?? 0).toBeGreaterThanOrEqual(150);
  });
});
