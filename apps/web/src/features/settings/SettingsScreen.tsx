import { useSyncExternalStore } from 'react';
import { ModeToggle } from '@/components/mode-toggle';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SettingsSlider } from './SettingsControls';
import MediaSettings from './MediaSettings';
import TrayPreference from './TrayPreference';
import { SettingBlock, SettingRow } from './SettingRow';
import { SettingsSection } from './SettingsSection';
import { setOwnFace, useOwnFace } from './blobatarIdentity';
import {
  previewSound,
  setSoundEnabled,
  setSoundVolume,
  setSoundsEnabled,
  soundSettingsSnapshot,
  subscribeSoundSettings,
  soundLabels,
  soundNames,
} from '@/media/sounds';
import type { User } from '@/api';
import { notificationSnapshot, setSystemNotifications, setDoNotDisturb, subscribeNotifications } from '@/features/chat/notificationSettings';
import './SettingsScreen.css';
import { getDesktopRuntime } from '@/desktop/runtime';
import AccountSettings from './AccountSettings';
import DesktopSettings from './DesktopSettings';
import ProfileSettings from './ProfileSettings';
import PreferenceSyncSettings from './PreferenceSyncSettings';

export type SettingsPage = 'profile' | 'audio' | 'voice' | 'recording' | 'stream' | 'connection' | 'appearance' | 'account' | 'desktop';

export default function SettingsScreen({ page, user, noise, onNoiseChange, balanced, onBalancedChange, layout, onLayoutChange }: {
  page: SettingsPage;
  user: User | null;
  noise: boolean;
  onNoiseChange: (value: boolean) => void;
  balanced: boolean;
  onBalancedChange: (value: boolean) => void;
  layout: string;
  onLayoutChange: (value: string) => void;
}) {
  const face = useOwnFace();
  const messageNotifications = useSyncExternalStore(subscribeNotifications, notificationSnapshot);
  const { enabled: sounds, volume, each } = useSyncExternalStore(subscribeSoundSettings, soundSettingsSnapshot);
  const desktop = getDesktopRuntime() === 'wails';
  if (page === 'account') return user ? <AccountSettings key={user.id} user={user} /> : <p className="text-sm text-muted-foreground">Sign in to manage your account.</p>;
  if (page === 'desktop') return desktop ? <DesktopSettings /> : null;
  if (page === 'profile') return user ? <ProfileSettings key={user.id} user={user} /> : <p className="text-sm text-muted-foreground">Sign in to edit your profile.</p>;
  if (page === 'audio') return (
    <SettingsSection id="settings-audio" title="Call audio">
      <SettingRow as="div" title="Noise suppression" description="Keep background sounds out of the conversation." control={<Switch aria-label="Noise suppression" checked={noise} onCheckedChange={onNoiseChange} />} />
      <SettingRow as="div" title="Balance voices" description="Keep everyone at a comfortable volume." control={<Switch aria-label="Balance voices" checked={balanced} onCheckedChange={onBalancedChange} />} />
      <SettingRow
        as="div"
        title="Sounds"
        description="Everything the app plays at you, under one switch."
        control={<Switch aria-label="Sounds" checked={sounds} onCheckedChange={setSoundsEnabled} />}
      />
      <SettingBlock
        title="Sound volume"
        value={`${Math.round(volume * 100)}%`}
        description="How loud those are. It does not touch anybody's voice."
      >
        <SettingsSlider
          ariaLabel="Sound volume"
          value={volume}
          min={0}
          max={1}
          step={0.05}
          onValueChange={(value) => {
            setSoundVolume(value);
          }}
        />
      </SettingBlock>
      {soundNames.map((name) => (
        <SettingRow
          as="div"
          key={name}
          title={soundLabels[name].title}
          description={soundLabels[name].description}
          control={
            <Switch
              aria-label={soundLabels[name].title}
              disabled={!sounds}
              checked={each[name]}
              onCheckedChange={(value) => {
                setSoundEnabled(name, value);
                // Turning one on is also the only sensible way to hear it.
                if (value) previewSound(name);
              }}
            />
          }
        />
      ))}
    </SettingsSection>
  );

  if (page === 'appearance') return (
    <SettingsSection id="settings-appearance" title="Look & feel">
      <SettingRow as="div" title="Theme" description="Light, dark, or match your system." control={<ModeToggle />} />
      {user && <PreferenceSyncSettings userId={user.id} />}
      {user && (
        <>
          <SettingRow as="div" title="Quiet notifications on this device" description={messageNotifications.accountDnd ? 'Your account is also set to Do not disturb. Change your account status in Profile to resume alerts.' : 'Pause message sounds and notifications on this device. Account availability is configured in Profile.'} control={<Switch aria-label="Do not disturb" checked={messageNotifications.localDnd} onCheckedChange={setDoNotDisturb} />} />
          <SettingRow
            as="div"
            title={desktop ? 'Desktop notifications' : 'Browser notifications'}
            description={messageNotifications.error || (desktop
              ? 'Show message and call alerts while BetterComms is running. Keep it in the tray to receive alerts after closing the window.'
              : messageNotifications.background
                ? 'Alerts also arrive after you close this browser tab.'
                : 'Show message alerts while away. With Web Push configured, they also arrive after the tab closes.')}
            control={<Switch
              aria-label={desktop ? 'Desktop notifications' : 'Browser notifications'}
              checked={messageNotifications.alerts}
              disabled={!desktop && (typeof window === 'undefined' || !('Notification' in window))}
              onCheckedChange={(enabled) => { void setSystemNotifications(enabled); }}
            />}
          />
        </>
      )}
      {getDesktopRuntime() === 'wails' && <TrayPreference />}
      {user && (
        <SettingRow
          as="div"
          title="Lead with your blobatar"
          description="Off, your photo is the big one and your blobatar sits in its corner. On, they swap."
          control={
            <Switch
              aria-label="Lead with my blobatar"
              checked={face === 'face'}
              onCheckedChange={(value) => setOwnFace(value ? 'face' : 'photo')}
            />
          }
        />
      )}
      <SettingRow
        as="div"
        title="Camera placement"
        description="Where the camera row sits when somebody is sharing a screen."
        control={
          <Select value={layout} onValueChange={(value) => { if (value) onLayoutChange(value); }}>
            <SelectTrigger aria-label="Camera placement" className="w-full"><SelectValue>{layout === 'top' ? 'Above the conversation' : layout === 'side' ? 'Beside the conversation' : 'On the right'}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="top">Above the conversation</SelectItem>
              <SelectItem value="side">Beside the conversation</SelectItem>
              <SelectItem value="right">On the right</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SettingsSection>
  );

  return <MediaSettings section={page} />;
}
