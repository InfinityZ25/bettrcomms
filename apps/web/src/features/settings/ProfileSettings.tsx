import { useRef, useState, type FormEvent } from 'react';
import { Camera, RotateCcw } from 'lucide-react';
import { api, type User } from '@/api';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMountEffect } from '@/hooks/useMountEffect';
import { normalizeProfile, prepareProfileAvatar, profileValidation, uploadProfileAvatar, type ProfileDraft } from './profile';
import { profileRevision, reconcileProfile } from './profileStore';
import AccountPresenceSelector from './AccountPresenceSelector';
import { SettingsSection } from './SettingsSection';

const draftFor = (user: User): ProfileDraft => ({ name: user.name, username: user.username ?? '', bio: user.bio ?? '' });

export default function ProfileSettings({ user }: { user: User }) {
  const [draft, setDraft] = useState(() => draftFor(user));
  const [baseline, setBaseline] = useState(() => draftFor(user));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error?: string; success?: string }>({});
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useMountEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current?.abort(); };
  });
  const normalized = normalizeProfile(draft);
  const dirty = JSON.stringify(normalized) !== JSON.stringify(normalizeProfile(baseline));
  const changedElsewhere = JSON.stringify(draftFor(user)) !== JSON.stringify(baseline);
  const validation = profileValidation(normalized);
  const edit = (field: keyof ProfileDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setFeedback({});
  };
  const reset = () => { const next = draftFor(user); setDraft(next); setBaseline(next); setFeedback({}); };
  async function perform(operation: (signal: AbortSignal) => Promise<User>, success: string, resetDraft = false) {
    if (busy || request.current) return;
    setBusy(true);
    setFeedback({});
    const controller = new AbortController();
    request.current = controller;
    const revision = profileRevision(user.id);
    try {
      const updated = await operation(controller.signal);
      if (!active.current || controller.signal.aborted) return;
      const current = reconcileProfile(updated, revision);
      if (resetDraft) { const next = draftFor(current); setDraft(next); setBaseline(next); }
      setFeedback({ success });
    } catch (error) {
      if (active.current && !controller.signal.aborted) setFeedback({ error: error instanceof Error ? error.message : 'Could not update your profile.' });
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current) setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty || validation) return;
    void perform((signal) => api<{ user: User }>('/me', normalized, 'PATCH', signal).then((result) => result.user), 'Profile saved.', true);
  }
  return (
    <div className="space-y-5">
      <SettingsSection id="settings-profile" title="Your profile">
        <div className="flex flex-wrap items-center gap-4 border-b pb-5">
          <Avatar name={user.name} id={user.id} src={user.avatar_url} size="lg" className="size-20" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}><Camera size={15} /> Change photo</Button>
              {user.avatar_url && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void perform((signal) => api<{ user: User }>('/me/avatar', undefined, 'DELETE', signal).then((result) => result.user), 'Profile photo removed.'); }}>Remove photo</Button>}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">PNG or JPEG, up to 2 MB and 4 million pixels. Resized to 256 pixels before upload.</p>
          </div>
          <input ref={fileInput} type="file" className="sr-only" tabIndex={-1} aria-label="Choose profile photo" accept="image/png,image/jpeg" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            void perform(async (signal) => {
              const resized = await prepareProfileAvatar(file, signal);
              signal.throwIfAborted();
              return uploadProfileAvatar(resized, signal);
            }, 'Profile photo updated.');
          }} />
        </div>
        <form onSubmit={save} className="space-y-4 pt-5">
          <div className="space-y-1.5">
            <label htmlFor="profile-display-name" className="text-sm font-medium">Display name</label>
            <Input id="profile-display-name" autoComplete="nickname" value={draft.name} maxLength={80} required disabled={busy} onChange={(event) => edit('name', event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="profile-username" className="text-sm font-medium">Username</label>
            <Input id="profile-username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={draft.username} maxLength={32} minLength={3} required disabled={busy} aria-describedby="profile-username-help" onChange={(event) => edit('username', event.target.value.toLowerCase())} />
            <p id="profile-username-help" className="text-xs leading-5 text-muted-foreground">A unique name people can search. Use lowercase letters, numbers and underscores.</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="profile-bio" className="text-sm font-medium">About you</label>
            <textarea id="profile-bio" value={draft.bio} maxLength={160} disabled={busy} onChange={(event) => edit('bio', event.target.value)} className="min-h-24 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            <p className="text-right text-xs text-muted-foreground">{[...draft.bio].length}/160</p>
          </div>
          {changedElsewhere && <div className="rounded-lg border p-3 text-xs leading-5">Your profile was updated. <button type="button" className="font-medium underline" disabled={busy} onClick={reset}>Load the current profile</button> before saving to avoid replacing another device's edits.</div>}
          {dirty && validation && <p className="text-xs text-destructive">{validation}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || !dirty || Boolean(validation)}>{busy ? 'Saving…' : 'Save profile'}</Button>
            {dirty && <Button type="button" variant="ghost" disabled={busy} onClick={reset}><RotateCcw size={14} /> Discard changes</Button>}
            {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          </div>
        </form>
        {feedback.error && <p className="mt-3 text-sm text-destructive" role="alert">{feedback.error}</p>}
        {feedback.success && <p className="mt-3 text-sm text-muted-foreground" role="status">{feedback.success}</p>}
      </SettingsSection>
      <SettingsSection id="settings-presence" title="Availability"><AccountPresenceSelector user={user} /></SettingsSection>
    </div>
  );
}
