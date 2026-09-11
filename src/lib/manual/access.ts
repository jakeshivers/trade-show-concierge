import type { Actor } from '@/lib/auth/actor';
import { canEditDeadlines } from '@/lib/deadlines/access';

/**
 * Who may read a manual into the register.
 *
 * This one does **not** get the split that `canConfirmReceipt` and `captureLead`
 * get. Confirming a crate at the booth and scanning a badge belong to anybody
 * because the person who is standing there is whoever is standing there, and a
 * permission that stops those acts happening produces a worse record rather than
 * a safer one. Extraction is the opposite shape twice over:
 *
 * 1. **It writes rows into the register.** Every accepted candidate becomes a
 *    `show_deadlines` row, which is what the alert engine fires against and what
 *    `summarizeExposure` computes a dollar figure from. `deadlines/access.ts`
 *    already decided that adding one belongs to whoever runs the show, and an
 *    upload that adds thirty at once cannot be a lesser act than typing one.
 * 2. **It carries a document out of the building.** The page text goes to a model
 *    provider, which is the risk step 21 named about a transport — the first five
 *    integrations ask a supplier a question, this one *sends* something. A
 *    service manual is the organizer's document rather than ours, and §5j's
 *    principle is exactly that a document does not travel somewhere it was never
 *    meant to go. That is a decision about the company, not a task.
 *
 * So it is deliberately the same gate as adding a deadline by hand, rather than a
 * new one — a second, quietly different permission beside the first is the
 * `SOURCE_LABEL` trap in another costume.
 *
 * **Confirming an extracted row is not here.** It stays `canConfirmDeadline`,
 * unchanged, because the act is identical whether the date was typed or proposed:
 * asserting that this date was read off this year's manual. That the two gates
 * happen to resolve to the same roles today is a coincidence of the role table
 * and not something either file should assume about the other.
 */
export function canExtractManual(actor: Actor): boolean {
  return canEditDeadlines(actor);
}
