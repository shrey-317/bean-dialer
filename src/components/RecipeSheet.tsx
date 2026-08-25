import { useState } from 'react';
import type { Session } from '../domain/types.ts';
import { updateRecipe } from '../hooks/actions.ts';
import { BigButton, Button, Field, Sheet, Stepper } from './ui.tsx';

/**
 * Change dose and target yield for the rest of a session.
 *
 * Deliberately not tied to a single shot: a recipe change ("I'm pulling ristrettos today, 18
 * in 25 out instead of 18 in 40") is a decision about what to aim for going forward, the same
 * kind of decision as moving the dial, so it lives in the same place — right before pulling.
 */
export function RecipeSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const [doseG, setDoseG] = useState(session.targets.doseG);
  const [yieldG, setYieldG] = useState(session.targets.yieldG);
  const [saving, setSaving] = useState(false);

  return (
    <Sheet label="Edit recipe" onClose={onClose}>
      <div className="text-center text-xs font-semibold uppercase tracking-widest text-crust-400">
        Recipe
      </div>

      <Field label="Dose">
        <Stepper label="Dose" value={doseG} onChange={setDoseG} step={0.1} min={0} unit="g" />
      </Field>
      <Field label="Target yield">
        <Stepper label="Target yield" value={yieldG} onChange={setYieldG} step={0.1} min={0} unit="g" />
      </Field>

      <div className="flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <BigButton
          className="flex-1"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await updateRecipe(session, { doseG, yieldG });
              onClose();
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </BigButton>
      </div>
    </Sheet>
  );
}
