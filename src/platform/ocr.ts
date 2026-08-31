import { createWorker } from 'tesseract.js';
import type { BeanProcess } from '../domain/types.ts';

/**
 * Reading a bag label, on-device.
 *
 * This is Tesseract.js — general-purpose OCR, not a model that understands packaging layout.
 * It's good at recognising printed characters and bad at knowing which line is the roaster,
 * which is the coffee name, and which date is the roast date rather than a best-by date. So
 * this module does two honest things and nothing more: return the raw recognised text always,
 * and layer a handful of conservative regex heuristics on top that only fill a field when
 * there's a real anchor to work from (a "Roast" label, a "Notes" label). When a heuristic finds
 * nothing, it returns nothing rather than a guess dressed up as a fact — `BeanForm` always shows
 * these as ordinary editable fields, never as an unreviewable auto-save.
 *
 * `tesseract.js` is a real dependency but is never imported from anywhere reachable at startup —
 * only `scanBagPhoto` touches it, and every caller reaches this module through a dynamic
 * `import()`, so its JS and the ~10 MB of worker/language data it fetches from its CDN at
 * runtime never enter the service worker's precache or slow down the app's normal load.
 */

export interface BagScanGuess {
  name?: string;
  process?: BeanProcess[];
  /** ISO calendar date (yyyy-mm-dd), matching `Bean.roastDate`. */
  roastDate?: string;
  tastingNotes?: string[];
}

export interface BagScanResult {
  /** What Tesseract actually read, line by line — the fallback when a guess below is wrong
   *  or missing entirely. Always shown to the user, never discarded. */
  rawText: string;
  guess: BagScanGuess;
}

export async function scanBagPhoto(file: File | Blob): Promise<BagScanResult> {
  const worker = await createWorker('eng');
  try {
    const {
      data: { text },
    } = await worker.recognize(file);
    const rawText = text ?? '';
    const name = guessName(rawText);
    const process = parseProcesses(rawText);
    const roastDate = parseRoastDate(rawText);
    const tastingNotes = parseTastingNotes(rawText);

    return {
      rawText,
      guess: {
        ...(name ? { name } : {}),
        ...(process.length > 0 ? { process } : {}),
        ...(roastDate ? { roastDate } : {}),
        ...(tastingNotes.length > 0 ? { tastingNotes } : {}),
      },
    };
  } finally {
    // Not `await`ed into the try above — a slow/failed terminate should never mask a real
    // recognition result or turn a successful scan into a rejected promise.
    void worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Heuristics — pure functions, unit-tested directly, deliberately conservative.
// ---------------------------------------------------------------------------

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The first printable line is very often the roaster or the coffee's own name on a bag. */
export function guessName(text: string): string | undefined {
  return lines(text).find((l) => l.length >= 2 && l.length <= 40 && /[a-zA-Z]/.test(l));
}

const KNOWN_PROCESSES: BeanProcess[] = ['natural', 'washed', 'honey', 'anaerobic'];

/** Whole-word, case-insensitive matches against the known process vocabulary. */
export function parseProcesses(text: string): BeanProcess[] {
  return KNOWN_PROCESSES.filter((p) => new RegExp(`\\b${p}\\b`, 'i').test(text));
}

const ROAST_LABEL = /\broast(?:ed)?\b/i;
// "Best by"/"best before"/"use by"/"expires" dates are printed on plenty of bags too, and are
// not the roast date — a line carrying one of these must never be read as the roast date,
// label or no label.
const NOT_ROAST_LABEL = /\b(best\s*(by|before)|use\s*by|expir|sell\s*by)\b/i;

type DateExtractor = {
  pattern: RegExp;
  toParts: (m: RegExpMatchArray) => { year: number; month: number; day: number };
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DATE_EXTRACTORS: DateExtractor[] = [
  {
    // 2026-01-15 / 2026/01/15 / 2026.01.15
    pattern: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/,
    toParts: (m) => ({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }),
  },
  {
    // 15 Jan 2026 / 15 January 26
    pattern: /\b(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{2,4})\b/i,
    toParts: (m) => ({
      year: Number(m[3]),
      month: MONTHS[(m[2] ?? '').slice(0, 3).toLowerCase()] ?? Number.NaN,
      day: Number(m[1]),
    }),
  },
  {
    // Jan 15, 2026 / Jan 15 26
    pattern: /\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})\b/i,
    toParts: (m) => ({
      year: Number(m[3]),
      month: MONTHS[(m[1] ?? '').slice(0, 3).toLowerCase()] ?? Number.NaN,
      day: Number(m[2]),
    }),
  },
  {
    // 01/15/2026 or 01-15-26 — US month/day order, the most ambiguous pattern, tried last.
    pattern: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/,
    toParts: (m) => ({ year: Number(m[3]), month: Number(m[1]), day: Number(m[2]) }),
  },
];

function toIsoDate(year: number, month: number, day: number): string | undefined {
  const y = year < 100 ? year + 2000 : year;
  if (!Number.isInteger(month) || month < 1 || month > 12) return undefined;
  if (!Number.isInteger(day) || day < 1 || day > 31) return undefined;
  if (y < 2000 || y > 2100) return undefined;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractDate(fragment: string): string | undefined {
  for (const { pattern, toParts } of DATE_EXTRACTORS) {
    const m = fragment.match(pattern);
    if (!m) continue;
    const { year, month, day } = toParts(m);
    const iso = toIsoDate(year, month, day);
    if (iso) return iso;
  }
  return undefined;
}

/**
 * Only reads a date off a line that says "Roast"/"Roasted" — never off an unlabelled date
 * anywhere in the text, and never off a "best by" line even if it happens to also mention
 * roasting. Bags commonly print the label and the date as two separate lines ("ROAST DATE:"
 * then the date beneath it), so a labelled line with no date of its own checks the next line
 * too.
 */
export function parseRoastDate(text: string): string | undefined {
  const ls = lines(text);
  for (const [i, line] of ls.entries()) {
    if (NOT_ROAST_LABEL.test(line) || !ROAST_LABEL.test(line)) continue;

    const onThisLine = extractDate(line);
    if (onThisLine) return onThisLine;

    const next = ls[i + 1];
    if (next && !NOT_ROAST_LABEL.test(next)) {
      const onNextLine = extractDate(next);
      if (onNextLine) return onNextLine;
    }
  }
  return undefined;
}

const NOTES_LABEL = /\b(tasting\s*notes?|flavou?r\s*notes?|flavou?rs?|notes?)\s*[:-]?\s*/i;

/**
 * Tasting notes off a "Notes"/"Flavor"/"Tasting notes" line (or the line beneath it, same
 * label/value layout as the roast date). Splits the remainder on commas, slashes and "and",
 * so "Black cherry, chocolate & brown sugar" becomes three notes rather than one long string.
 */
export function parseTastingNotes(text: string): string[] {
  const ls = lines(text);
  for (const [i, line] of ls.entries()) {
    const match = line.match(NOTES_LABEL);
    if (!match || match.index === undefined) continue;

    let remainder = line.slice(match.index + match[0].length).trim();
    if (!remainder) remainder = ls[i + 1] ?? '';
    if (!remainder) continue;

    const notes = Array.from(
      new Set(
        remainder
          .split(/,|\/|&|\band\b/i)
          .map((n) => n.trim().replace(/[.\-–—]+$/, ''))
          .filter((n) => n.length >= 2 && n.length <= 30),
      ),
    ).slice(0, 5);
    if (notes.length > 0) return notes;
  }
  return [];
}
