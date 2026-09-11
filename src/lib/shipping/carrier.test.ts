import { describe, it, expect } from 'vitest';
import { identifyCarrier, normalizeTrackingNumber, upsCheckDigitAgrees } from './carrier';

/**
 * What these guard is not "does the regex match". It is the three ways a
 * convenience like this turns into a wrong fact on a screen: guessing where it
 * should abstain, refusing a real number because our table is short, and
 * flattening the one case where the carrier who can be asked is not the carrier
 * we shipped with.
 */

describe('reading the carrier off the number', () => {
  it('knows the prefixes their owners actually own', () => {
    expect(identifyCarrier('1Z999AA10123456784')).toMatchObject({
      carrier: 'ups',
      confidence: 'certain',
    });
    expect(identifyCarrier('JD014600003922222222')).toMatchObject({ carrier: 'dhl' });
    expect(identifyCarrier('LZ123456789US')).toMatchObject({
      carrier: 'usps',
      confidence: 'certain',
    });
  });

  it('reads the formats that are only a length as likely, never certain', () => {
    expect(identifyCarrier('123456789012')).toMatchObject({
      carrier: 'fedex',
      confidence: 'likely',
    });
    expect(identifyCarrier('9405511899223197428490')).toMatchObject({
      carrier: 'usps',
      confidence: 'likely',
    });
  });

  // Twenty digits either way, and the first two decide it. Matching on length
  // before prefix would hand every FedEx Ground number to USPS.
  it('separates FedEx Ground from a USPS barcode on the prefix, not the length', () => {
    expect(identifyCarrier('96' + '1'.repeat(18))).toMatchObject({ carrier: 'fedex' });
    expect(identifyCarrier('94' + '1'.repeat(18))).toMatchObject({ carrier: 'usps' });
  });

  it('normalizes the spaces and hyphens carriers print for readability', () => {
    expect(normalizeTrackingNumber('1Z 999AA1 0123 4567 84')).toBe('1Z999AA10123456784');
    expect(identifyCarrier('1Z 999AA1 0123 4567 84')).toMatchObject({ carrier: 'ups' });
  });

  /**
   * The one that matters most, and the reason `note` exists at all. FedEx Ground
   * Economy and UPS Mail Innovations both hand the last mile to USPS and issue
   * numbers in the USPS format. USPS is the right answer for the *tracking*
   * column — they are who can be asked — and it is the wrong answer to "who did
   * we ship with", so the answer has to carry both.
   */
  it('says what a 22-digit barcode still cannot tell you', () => {
    const g = identifyCarrier('9405511899223197428490');
    expect(g.carrier).toBe('usps');
    expect('note' in g && g.note).toMatch(/Ground Economy|Mail Innovations/);
  });

  it('abstains rather than guessing, and abstaining is not a rejection', () => {
    expect(identifyCarrier('')).toMatchObject({ carrier: null, reason: 'blank' });
    expect(identifyCarrier('1Z99')).toMatchObject({ carrier: null, reason: 'too_short' });
    // A real format this table has never seen. The number is fine; we are short.
    expect(identifyCarrier('XKCD-777-ALPHA-2211')).toMatchObject({
      carrier: null,
      reason: 'unrecognised',
    });
  });
});

describe('the UPS check digit', () => {
  // UPS's own published example. If this ever fails the algorithm is wrong, and
  // an algorithm that is wrong here accuses people of typos they did not make.
  it('agrees with the number UPS publishes', () => {
    expect(upsCheckDigitAgrees('1Z999AA10123456784')).toBe(true);
  });

  it('notices a single transposed character', () => {
    expect(upsCheckDigitAgrees('1Z999AA10123456785')).toBe(false);
  });

  /**
   * A disagreeing check digit is a hint and never a verdict. The carrier is
   * still reported, because `1Z` is UPS's prefix whatever the last digit says,
   * and the number is still saveable — our arithmetic does not get to overrule
   * somebody holding the label.
   */
  it('still reports UPS when the check digit disagrees, and flags it', () => {
    expect(identifyCarrier('1Z999AA10123456785')).toMatchObject({
      carrier: 'ups',
      confidence: 'certain',
      checkDigitDisagrees: true,
    });
  });
});
