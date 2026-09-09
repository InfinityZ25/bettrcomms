import { LayoutPanelTop, LogOut, Mic, SunMoon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ModeToggle } from '@/components/mode-toggle';
import MediaSettings from './MediaSettings';
import { SettingRow } from './SettingRow';
import { cn } from '@/lib/utils';

const heading = 'mb-4 flex items-center gap-2.5 text-base font-semibold';

/** The settings page: audio, appearance, layout, and signing out. */
export default function SettingsScreen({
  noise,
  onNoiseChange,
  balanced,
  onBalancedChange,
  layout,
  onLayoutChange,
  signedIn,
  onSignOut,
}: {
  noise: boolean;
  onNoiseChange: (value: boolean) => void;
  balanced: boolean;
  onBalancedChange: (value: boolean) => void;
  layout: string;
  onLayoutChange: (value: string) => void;
  signedIn: boolean;
  onSignOut: () => void;
}) {
  return (
    <div className="mt-6 max-w-[920px]">
      <h3 className={heading}>
        <Mic size={17} /> Audio
      </h3>
      <SettingRow
        title="Noise suppression"
        description="Reduce background noise from your microphone."
        control={
          <Switch
            checked={noise}
            onChange={(event) => onNoiseChange(event.target.checked)}
          />
        }
      />
      <SettingRow
        title="Balance voices"
        description="Gently even out the people you hear."
        control={
          <Switch
            checked={balanced}
            onChange={(event) => onBalancedChange(event.target.checked)}
          />
        }
      />
      <MediaSettings />
      <h3 className={cn(heading, 'mt-7')}>
        <SunMoon size={17} /> Appearance
      </h3>
      <SettingRow
        as="div"
        title="Theme"
        description="Light, dark, or match your system."
        control={<ModeToggle />}
      />
      <h3 className={cn(heading, 'mt-7')}>
        <LayoutPanelTop size={17} /> Layout
      </h3>
      <label className="my-4 block text-xs font-medium leading-7 text-foreground/80">
        Camera placement
        <select
          className="mt-2"
          value={layout}
          onChange={(event) => onLayoutChange(event.target.value)}
        >
          <option value="top">Cameras on top</option>
          <option value="side">Cameras on the side</option>
          <option value="right">Cameras on the right</option>
        </select>
      </label>
      {signedIn && (
        <Button variant="ghost" className="mt-6" onClick={onSignOut}>
          <LogOut size={16} /> Sign out
        </Button>
      )}
    </div>
  );
}
