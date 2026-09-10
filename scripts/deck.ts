import { writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import * as s from '@/db/schema';
import type { Actor } from '@/lib/auth/actor';
import { buildDeck } from '@/lib/deck/build';
import { planShowDeck } from '@/lib/deck/store';

/**
 * `pnpm deck <show id> [--out file.pptx]` — the executive brief, as a file.
 *
 * Prints the slide plan before writing anything, because the plan is the part
 * worth reading: every refusal this deck makes ("no prior year is linked", "at
 * least $41,300 — booth space missing") is visible in the outline, and the
 * .pptx is only that outline with fonts on it. Reading the CLI's output is how
 * six real defects were found on this project.
 */

/**
 * An admin, the way every other CLI here picks one — the deck is gated per actor
 * and this is the widest view, so what the file shows is everything the show has.
 * `DEV_ACTOR_EMAIL` is the app's seam, not a script's.
 */
async function anyAdmin(db: ReturnType<typeof getDb>): Promise<Actor> {
  const [user] = await db.select().from(s.users).where(eq(s.users.role, 'admin')).limit(1);
  if (!user) throw new Error('No admin user. Run `pnpm db:reset` first.');
  return {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    costCenterId: user.costCenterId,
  };
}

async function main() {
  const [showId] = process.argv.slice(2).filter((a) => a !== '--out');
  const outFlag = process.argv.indexOf('--out');
  const out = outFlag > -1 ? process.argv[outFlag + 1] : null;

  const db = getDb();
  const actor = await anyAdmin(db);

  if (!showId) {
    const shows = await db
      .select({ id: s.shows.id, name: s.shows.name, status: s.shows.status })
      .from(s.shows)
      .where(eq(s.shows.orgId, actor.orgId));
    console.log('Usage: pnpm deck <show id> [--out file.pptx]\n\nShows in this workspace:');
    for (const show of shows) console.log(`  ${show.id}  ${show.name} (${show.status})`);
    return;
  }

  const deck = await planShowDeck(actor, showId);
  console.log(`\n${deck.title}\n${'='.repeat(deck.title.length)}\n`);
  for (const slide of deck.slides) {
    console.log(`— ${'title' in slide ? slide.title : ''}`);
    if (slide.kind === 'title') console.log(`   ${slide.subtitle}\n   ${slide.stamp}`);
    if ('note' in slide && slide.note) console.log(`   (${slide.note})`);
    if (slide.kind === 'stats')
      for (const st of slide.stats)
        console.log(`   ${st.label}: ${st.value}${st.note ? ` — ${st.note}` : ''}`);
    if (slide.kind === 'bullets')
      for (const b of slide.bullets) console.log(`   • ${b.text}${b.sub ? `\n     ${b.sub}` : ''}`);
    if (slide.kind === 'table')
      for (const row of slide.rows) console.log(`   ${row.join('  |  ')}`);
    console.log();
  }

  const file = out ?? deck.fileName;
  await writeFile(file, await buildDeck(deck));
  console.log(`Wrote ${file}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
