import { useId, useRef, useState, type FormEvent } from 'react';
import { Hand, RotateCcw } from 'lucide-react';
import { api, type CharacterAppearance, type User } from '@/api';
import { Companion } from '@/components/companion';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLegend, FieldSet } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useMountEffect } from '@/hooks/useMountEffect';
import { CHARACTER_COLORS, CHARACTER_VARIANTS, characterSeed, ORIGINAL_CHARACTER, sameCharacter } from './character';
import { personalityFor, SIGNATURE_LABELS } from '@/features/pet/personality';
import { profileRevision, reconcileProfile } from './profileStore';
import { SettingsSection } from './SettingsSection';
import './CharacterSettings.css';

export default function CharacterSettings({ user }: { user: User }) {
  const current = user.character ?? ORIGINAL_CHARACTER;
  const [draft, setDraft] = useState<CharacterAppearance>(current);
  const [baseline, setBaseline] = useState<CharacterAppearance>(current);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error?: string; success?: string }>({});
  const [preview, setPreview] = useState(0);
  const previewSession = useId();
  const active = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const dirty = !sameCharacter(draft, baseline);
  const temperament = personalityFor(characterSeed(user.id, draft.variant));
  const changedElsewhere = !sameCharacter(current, baseline);
  useMountEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current?.abort(); };
  });
  const choose = (next: CharacterAppearance) => { setDraft(next); setFeedback({}); };
  const reset = () => { setDraft(current); setBaseline(current); setFeedback({}); };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty || request.current || changedElsewhere) return;
    const controller = new AbortController();
    request.current = controller;
    const revision = profileRevision(user.id);
    setBusy(true);
    setFeedback({});
    try {
      const result = await api<{ user: User }>('/me/character', draft, 'PATCH', controller.signal);
      if (!active.current || controller.signal.aborted) return;
      const updated = reconcileProfile(result.user, revision);
      const accepted = updated.character ?? ORIGINAL_CHARACTER;
      setDraft(accepted);
      setBaseline(accepted);
      setFeedback({ success: 'Character saved.' });
    } catch (error) {
      if (active.current && !controller.signal.aborted) setFeedback({ error: error instanceof Error ? error.message : 'Could not save your character.' });
    } finally {
      if (request.current === controller) request.current = undefined;
      if (active.current) setBusy(false);
    }
  }
  return (
    <SettingsSection id="settings-character" title="Your character">
      <div className="character-introduction">
        <Companion userId={user.id} name={user.name} character={draft} preview gesture={preview ? { id: `preview:${previewSession}:${preview}`, kind: 'wave' } : undefined} className="size-24" />
        <div className="min-w-0 flex-1">
          <h3 className="font-heading text-lg font-semibold">Your character</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">A familiar face for calls and conversations. Your profile photo stays yours.</p>
          <p className="mt-1 text-sm leading-6" data-testid="character-temperament">
            <span className="font-medium">{temperament.traits.join(' · ')}</span>
            <span className="text-muted-foreground"> — signature move: {SIGNATURE_LABELS[temperament.signature]}</span>
          </p>
          <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setPreview((value) => value + 1)}><Hand data-icon="inline-start" />Preview greeting</Button>
        </div>
      </div>
      <form onSubmit={save} className="flex flex-col gap-5 pb-2">
        <FieldGroup>
          <Field>
            <FieldSet disabled={busy}>
              <FieldLegend variant="label">Choose a character</FieldLegend>
              <ToggleGroup aria-label="Character shape" className="character-choices" value={[String(draft.variant)]} onValueChange={(values) => { if (values[0] !== undefined) choose({ ...draft, variant: Number(values[0]) }); }}>
                {CHARACTER_VARIANTS.map((variant) => (
                  <ToggleGroupItem key={variant} value={String(variant)} aria-label={variant === 0 ? 'Original character' : `Character ${variant + 1}`} className="character-choice">
                    <span aria-hidden="true"><Companion userId={user.id} name={user.name} character={{ ...draft, variant }} preview className="size-14" /></span>
                    <span className="text-[11px]">{variant === 0 ? 'Original' : `Character ${variant + 1}`}</span>
                    <span className="max-w-full truncate text-[10px] text-muted-foreground">{personalityFor(characterSeed(user.id, variant)).traits[0]}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription>Each creature has its own temperament and signature move, which is how it behaves as your screen companion. Keep your original, or choose one that feels like you.</FieldDescription>
            </FieldSet>
          </Field>
          <Field>
            <FieldSet disabled={busy}>
              <FieldLegend variant="label">Color</FieldLegend>
              <ToggleGroup aria-label="Character color" className="flex w-full flex-wrap" value={[draft.hue === null ? 'auto' : String(draft.hue)]} onValueChange={(values) => { if (values[0] !== undefined) choose({ ...draft, hue: values[0] === 'auto' ? null : Number(values[0]) }); }}>
                <ToggleGroupItem value="auto" aria-label="Automatic color" className="min-h-11">Automatic</ToggleGroupItem>
                {CHARACTER_COLORS.map(({ hue, label }) => <ToggleGroupItem key={hue} value={String(hue)} aria-label={label} className="min-h-11 gap-2"><span className="character-swatch" style={{ backgroundColor: `oklch(.72 .13 ${hue})` }} aria-hidden="true" />{label}</ToggleGroupItem>)}
              </ToggleGroup>
            </FieldSet>
          </Field>
        </FieldGroup>
        {changedElsewhere && <p className="text-sm text-muted-foreground" role="status">Your character was updated on another device. <Button type="button" variant="link" size="sm" disabled={busy} onClick={reset}>Load the current character</Button></p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!dirty || busy || changedElsewhere}>{busy ? 'Saving…' : 'Save character'}</Button>
          {dirty && <Button type="button" variant="ghost" disabled={busy} onClick={reset}><RotateCcw data-icon="inline-start" />Discard character changes</Button>}
        </div>
        {feedback.error && <p className="text-sm text-destructive" role="alert">{feedback.error}</p>}
        {feedback.success && <p className="text-sm text-muted-foreground" role="status">{feedback.success}</p>}
      </form>
    </SettingsSection>
  );
}
