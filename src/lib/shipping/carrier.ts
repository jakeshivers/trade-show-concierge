/**
 * Which carrier issued this number, read off the number itself.
 *
 * Carriers encode their identity in the format: UPS owns the `1Z` prefix
 * outright, USPS numbers are Intelligent Mail package barcodes beginning 92–95,
 * FedEx Express is a bare twelve digits. So asking somebody to pick a carrier
 * from a dropdown *and* paste a number that already says which one is asking
 * them to enter the same fact twice, which is a fact that can now disagree with
 * itself.
 *
 * Three rules about what this is allowed to do, and they are the whole design.
 *
 * **It suggests; it never records.** `shipments.carrier` decides which carrier
 * account `easypost/client.ts` is asked about, and that file already says a
 * guessed carrier is worse than none — a wrong one gets `NoRecord` back and the
 * board reports a crate nobody has heard of, which reads exactly like freight
 * that has gone missing. So this fills a control a person is looking at and can
 * override, and nothing on the write path calls it.
 *
 * **It never rejects a number.** A pattern that does not match means *we* do not
 * recognise the format — carriers add services, regional partners issue their
 * own, and a number this file has never seen is far likelier than a number that
 * is wrong. Refusing to save it would be our incomplete table overruling
 * somebody holding the label. Unrecognised is `null` with a reason, and the
 * carrier control simply stays where the person left it.
 *
 * **It says when it is guessing, and what it cannot tell apart.** A 22-digit
 * IMpb really is a USPS number *and* is what FedEx Ground Economy and UPS Mail
 * Innovations issue when they hand the last mile to USPS. USPS is the right
 * answer for the tracking column — they are who can be asked — and it is not the
 * right answer to "who did we ship with". That distinction is carried in `note`
 * rather than dropped.
 */

export type CarrierCode = 'ups' | 'usps' | 'fedex' | 'dhl';

export type CarrierGuess =
  | {
      carrier: CarrierCode;
      /**
       * `certain` is only for a prefix a carrier owns and nobody else issues.
       * Everything keyed on length alone is `likely`, because a bare run of
       * digits is a format rather than a signature.
       */
      confidence: 'certain' | 'likely';
      /** Why, in the words the screen shows. */
      why: string;
      /** What this answer still cannot tell you. */
      note?: string;
      /**
       * The check digit disagrees with the rest of the number.
       *
       * Only ever set for UPS, whose algorithm is the one implemented here and
       * verified against a published example. It is a **typo hint and nothing
       * else**: the carrier is still reported, the number is still saved, and
       * the sentence says one character is probably wrong rather than that the
       * number is invalid. A check digit we got subtly wrong would otherwise
       * accuse people of typos they did not make.
       */
      checkDigitDisagrees?: boolean;
    }
  | {
      carrier: null;
      reason: 'blank' | 'too_short' | 'unrecognised';
      why: string;
    };

/** Whitespace and the hyphens carriers print for readability are not part of it. */
export function normalizeTrackingNumber(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

type Rule = {
  test: RegExp;
  carrier: CarrierCode;
  confidence: 'certain' | 'likely';
  why: string;
  note?: string;
};

/**
 * Ordered, and the order carries one real decision: a twenty-digit number
 * beginning `96` is FedEx Ground and one beginning `92`–`95` is USPS. They are
 * the same length and differ only in the first two digits, so the prefixes are
 * matched before anything that keys on length alone.
 */
const RULES: Rule[] = [
  {
    test: /^1Z[0-9A-Z]{16}$/,
    carrier: 'ups',
    confidence: 'certain',
    why: 'starts 1Z, which is UPS’s own prefix',
  },
  {
    test: /^JD\d{18}$/,
    carrier: 'dhl',
    confidence: 'certain',
    why: 'starts JD, which DHL eCommerce issues',
  },
  {
    test: /^(92|93|94|95)\d{20}$/,
    carrier: 'usps',
    confidence: 'likely',
    why: '22 digits beginning 92–95 — a USPS Intelligent Mail package barcode',
    note:
      'FedEx Ground Economy and UPS Mail Innovations hand the last mile to USPS and issue ' +
      'numbers in exactly this format, so USPS is who can be asked about it and may not be ' +
      'who you shipped with.',
  },
  {
    test: /^(92|93|94|95)\d{18}$/,
    carrier: 'usps',
    confidence: 'likely',
    why: '20 digits beginning 92–95 — a USPS Intelligent Mail package barcode',
  },
  {
    test: /^96\d{18}$/,
    carrier: 'fedex',
    confidence: 'likely',
    why: '20 digits beginning 96 — the FedEx Ground format',
  },
  {
    test: /^[A-Z]{2}\d{9}US$/,
    carrier: 'usps',
    confidence: 'certain',
    why: 'a UPU international number ending US, so USPS is the posting operator',
  },
  {
    test: /^\d{12}$/,
    carrier: 'fedex',
    confidence: 'likely',
    why: '12 digits, which is FedEx Express',
  },
  {
    test: /^\d{15}$/,
    carrier: 'fedex',
    confidence: 'likely',
    why: '15 digits, which is FedEx Ground',
  },
  {
    test: /^0\d{19}$/,
    carrier: 'usps',
    confidence: 'likely',
    why: '20 digits beginning 0 — an older USPS delivery confirmation number',
  },
  {
    test: /^\d{10}$/,
    carrier: 'dhl',
    confidence: 'likely',
    why: '10 digits, which is a DHL Express air waybill',
    note:
      'Ten digits is the least distinctive format here — plenty of things are ten digits. ' +
      'Worth a glance at the label.',
  },
];

export function identifyCarrier(raw: string | null | undefined): CarrierGuess {
  const n = normalizeTrackingNumber(raw ?? '');
  if (!n) return { carrier: null, reason: 'blank', why: 'No tracking number yet.' };
  if (n.length < 10) {
    // Not a verdict about the number — somebody is still typing it, and a
    // control that flickered through three carriers on the way to the tenth
    // character would be worse than one that waits.
    return {
      carrier: null,
      reason: 'too_short',
      why: 'Too short to tell yet — no carrier here issues a number under ten characters.',
    };
  }

  for (const rule of RULES) {
    if (!rule.test.test(n)) continue;
    const guess: CarrierGuess = {
      carrier: rule.carrier,
      confidence: rule.confidence,
      why: rule.why,
      ...(rule.note ? { note: rule.note } : {}),
    };
    if (rule.carrier === 'ups' && !upsCheckDigitAgrees(n)) {
      return { ...guess, checkDigitDisagrees: true };
    }
    return guess;
  }

  return {
    carrier: null,
    reason: 'unrecognised',
    why:
      'Not a format this app recognises. That is more often our table being short than the ' +
      'number being wrong — pick the carrier off the label.',
  };
}

/**
 * The UPS 1Z check digit, and the only check digit implemented here.
 *
 * Verified against UPS's own published example, `1Z999AA10123456784`. The
 * others are deliberately absent: FedEx and USPS both use check digits too, and
 * an implementation of one that is subtly wrong tells people they have made a
 * typo when they have not — which trains them to ignore the one time it is
 * right. One algorithm that has been checked beats four that have not.
 *
 * Letters carry a numeric value of `(code − 63) mod 10`, digits their own value.
 * Odd positions count once and even positions twice, and the check digit is what
 * takes the total to a multiple of ten.
 */
export function upsCheckDigitAgrees(normalized: string): boolean {
  if (!/^1Z[0-9A-Z]{16}$/.test(normalized)) return false;
  const body = normalized.slice(2, 17);
  const stated = Number(normalized[17]);
  if (!Number.isInteger(stated)) return false;

  let total = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    const value = ch >= '0' && ch <= '9' ? Number(ch) : (ch.charCodeAt(0) - 63) % 10;
    total += i % 2 === 0 ? value : value * 2;
  }
  return (10 - (total % 10)) % 10 === stated;
}
