import { describe, expect, it } from 'vitest';
import { guessName, parseProcesses, parseRoastDate, parseTastingNotes } from './ocr.ts';

/**
 * `scanBagPhoto` itself isn't tested here — it needs a real image and Tesseract's CDN-hosted
 * worker/model, which is exactly the kind of thing that makes CI slow and flaky rather than
 * confident. What's tested is the part that's actually deterministic: the regex heuristics that
 * turn raw recognised text into field guesses. Real accuracy on an actual bag is a manual,
 * on-device check, the same as the timer's staged pre-infusion or the coach's suggestions.
 */

describe('guessName', () => {
  it('picks the first printable line', () => {
    expect(guessName('Prodigal Coffee\nKenya Kiamabara\nWashed · Light roast')).toBe(
      'Prodigal Coffee',
    );
  });

  it('returns undefined for text with nothing usable', () => {
    expect(guessName('')).toBeUndefined();
    expect(guessName('   \n\n  ')).toBeUndefined();
  });
});

describe('parseProcesses', () => {
  it('finds every mentioned process, case-insensitively', () => {
    expect(parseProcesses('A co-ferment: Washed + Natural')).toEqual(['natural', 'washed']);
  });

  it('does not match a process word embedded in a longer word', () => {
    // "unwashed" mentions the substring "washed" but is not the process washed.
    expect(parseProcesses('This lot is natural, not unwashed')).toEqual(['natural']);
  });

  it('returns an empty array when no process is mentioned', () => {
    expect(parseProcesses('Ethiopia Sidama')).toEqual([]);
  });
});

describe('parseRoastDate', () => {
  it('reads a labelled date on the same line, numeric format', () => {
    expect(parseRoastDate('ROAST DATE: 01/15/2026')).toBe('2026-01-15');
  });

  it('reads a labelled date on the same line, ISO format', () => {
    expect(parseRoastDate('Roasted on 2026-01-15')).toBe('2026-01-15');
  });

  it('reads a labelled date on the same line, month-name format', () => {
    expect(parseRoastDate('Roast Date: Jan 15, 2026')).toBe('2026-01-15');
    expect(parseRoastDate('ROASTED 15 JAN 2026')).toBe('2026-01-15');
  });

  it('reads the date from the next line when the label line has none', () => {
    expect(parseRoastDate('Joe Van Gogh\nROAST DATE\n01/15/26\nEthiopia Sidama')).toBe(
      '2026-01-15',
    );
  });

  it('never reads a best-by/use-by date as the roast date', () => {
    expect(parseRoastDate('Best By: 06/15/2026')).toBeUndefined();
    expect(parseRoastDate('Use by 2026-09-01')).toBeUndefined();
    // Even a line that mentions roasting alongside a disqualifying word is skipped.
    expect(parseRoastDate('Best before end of roast season 06/15/2026')).toBeUndefined();
  });

  it('returns undefined when nothing looks like a roast date at all', () => {
    expect(parseRoastDate('Ethiopia Sidama\nJoe Van Gogh\nWashed')).toBeUndefined();
  });
});

describe('parseTastingNotes', () => {
  it('splits a comma-separated notes line', () => {
    expect(parseTastingNotes('Notes: Black cherry, chocolate, brown sugar')).toEqual([
      'Black cherry',
      'chocolate',
      'brown sugar',
    ]);
  });

  it('reads notes from the line beneath a bare "Tasting Notes" label', () => {
    expect(parseTastingNotes('Roaster Co\nTasting Notes\nCherry / Almond / Honey')).toEqual([
      'Cherry',
      'Almond',
      'Honey',
    ]);
  });

  it('splits on "and" as well as punctuation', () => {
    expect(parseTastingNotes('Flavor: citrus and caramel')).toEqual(['citrus', 'caramel']);
  });

  it('returns an empty array when there is no notes line', () => {
    expect(parseTastingNotes('Ethiopia Sidama\nJoe Van Gogh\nWashed')).toEqual([]);
  });
});
