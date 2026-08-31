/**
 * Turning a store result into something a model can read.
 *
 * Two rules, both about honesty rather than formatting.
 *
 * **Dates go out as ISO instants, never as a formatted local string.** Every
 * date in this app means something in a specific zone — a deadline at 4:00pm at
 * the warehouse, a dock that opens at move-in — and a pre-formatted local string
 * would strip the offset and invite the model to do zone arithmetic in prose.
 * An instant is unambiguous, and the screen renders the local reading beside the
 * prose from the same row.
 *
 * **Truncation is announced.** A silently clipped board is how a model concludes
 * there are three shipments when there are thirty, and then says so confidently.
 * When the cap bites, what comes back says how much was dropped so the model can
 * narrow instead of guessing.
 */

/** Generous enough for a full board, small enough that a transcript stays cheap. */
export const MAX_RESULT_CHARS = 24_000;

export type Serialized = { text: string; truncated: boolean };

export function serializeResult(value: unknown): Serialized {
  const json = JSON.stringify(value, replacer, 1) ?? 'null';
  if (json.length <= MAX_RESULT_CHARS) return { text: json, truncated: false };

  const kept = json.slice(0, MAX_RESULT_CHARS);
  return {
    text:
      `${kept}\n\n[truncated: this result was ${json.length} characters and ` +
      `${json.length - MAX_RESULT_CHARS} were dropped. Do not summarise it as complete — ` +
      'narrow the question (one show, one board) and ask again.]',
    truncated: true,
  };
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}
