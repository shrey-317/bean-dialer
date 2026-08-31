import { useRef, useState } from 'react';
import type { BagScanGuess } from '../platform/ocr.ts';
import type { Bean } from '../domain/types.ts';
import { BeanForm } from './BeanForm.tsx';
import { BigButton, Button, Card, SectionTitle } from './ui.tsx';

type ScanState =
  | { phase: 'idle' }
  | { phase: 'scanning' }
  | { phase: 'done'; guess: BagScanGuess; rawText: string }
  | { phase: 'error'; message: string };

/**
 * "Scan a bag" — photograph a label, get a prefilled Add-bag form back.
 *
 * On-device OCR (Tesseract.js), not a model that understands packaging layout: it reads
 * characters reasonably well and guesses field boundaries with conservative regex heuristics
 * (see `platform/ocr.ts` — it only fills a field when there's a real anchor like a "Roast" or
 * "Notes" label to work from). Real accuracy varies a lot by bag, so every guessed field lands
 * in the same editable `BeanForm` a manual "Add bag" would use, and the raw recognised text
 * stays visible underneath — a wrong or missing field is one glance at the actual label text
 * away from being fixed, rather than a re-read of the physical bag.
 */
export function BeanScanner({ onDone }: { onDone: (bean: Bean) => void }) {
  const [state, setState] = useState<ScanState>({ phase: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setState({ phase: 'scanning' });
    try {
      // Dynamic: this is the only path that ever touches tesseract.js, so its code and the
      // ~10 MB of worker/model files it fetches at runtime never load until a scan is actually
      // requested — the rest of the app pays nothing for this feature existing.
      const { scanBagPhoto } = await import('../platform/ocr.ts');
      const { guess, rawText } = await scanBagPhoto(file);
      setState({ phase: 'done', guess, rawText });
    } catch {
      setState({
        phase: 'error',
        message: "Couldn't read that photo — add the bag by hand below instead.",
      });
    }
  }

  if (state.phase === 'idle') {
    return (
      <Card className="mb-4">
        <SectionTitle>Scan a bag</SectionTitle>
        <p className="mb-3 text-xs text-crust-400">
          Photograph the label, square-on and in good light. It reads printed characters, not the
          label's design, so check what comes back before saving.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            // Otherwise choosing the same file twice in a row (e.g. after "Try another photo")
            // wouldn't fire another change event.
            e.target.value = '';
          }}
        />
        <BigButton onClick={() => inputRef.current?.click()}>Take a photo</BigButton>
      </Card>
    );
  }

  if (state.phase === 'scanning') {
    return (
      <Card className="mb-4 text-center">
        <p className="text-sm text-crust-300">Reading the bag…</p>
        <p className="mt-1 text-xs text-crust-500">
          The first scan also downloads the OCR model — a few seconds longer than the ones after.
        </p>
      </Card>
    );
  }

  if (state.phase === 'error') {
    return (
      <>
        <Card className="mb-4 border-bad">
          <p className="text-sm text-crust-200">{state.message}</p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setState({ phase: 'idle' })}
          >
            Try another photo
          </Button>
        </Card>
        <BeanForm onDone={onDone} />
      </>
    );
  }

  return (
    <>
      <BeanForm initial={state.guess} submitLabel="Save bag" onDone={onDone} />
      {state.rawText.trim() ? (
        <details className="mb-4 rounded-xl border border-crust-800 bg-crust-900 p-3 text-xs text-crust-400">
          <summary className="cursor-pointer select-none font-medium text-crust-300">
            What the scan actually read
          </summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans">{state.rawText}</pre>
        </details>
      ) : null}
    </>
  );
}
