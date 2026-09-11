import { LayoutPanelTop, Mic, SunMoon } from 'lucide-react';
import { ModeToggle } from '@/components/mode-toggle';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import MediaSettings from './MediaSettings';
import { SettingRow } from './SettingRow';
import { SettingsSection } from './SettingsSection';
import './SettingsScreen.css';

export type SettingsPage = 'audio' | 'voice' | 'recording' | 'stream' | 'connection' | 'appearance';

export default function SettingsScreen({ page, noise, onNoiseChange, balanced, onBalancedChange, layout, onLayoutChange }: {
  page: SettingsPage;
  noise: boolean;
  onNoiseChange: (value: boolean) => void;
  balanced: boolean;
  onBalancedChange: (value: boolean) => void;
  layout: string;
  onLayoutChange: (value: string) => void;
}) {
  if (page === 'audio') return (
    <SettingsSection id="settings-audio" icon={<Mic size={18} />} title="Call audio" description="Your everyday sound controls.">
      <SettingRow as="div" title="Noise suppression" description="Keep background sounds out of the conversation." control={<Switch aria-label="Noise suppression" checked={noise} onCheckedChange={onNoiseChange} />} />
      <SettingRow as="div" title="Balance voices" description="Keep everyone at a comfortable volume." control={<Switch aria-label="Balance voices" checked={balanced} onCheckedChange={onBalancedChange} />} />
    </SettingsSection>
  );

  if (page === 'appearance') return (
    <SettingsSection id="settings-appearance" icon={<SunMoon size={18} />} title="Look & feel" description="Make the app feel at home on your desktop.">
      <SettingRow as="div" title="Theme" description="Light, dark, or match your system." control={<ModeToggle />} />
      <div className="my-3 h-px bg-border/60" />
      <div className="grid gap-2">
        <span className="flex items-center gap-2 text-sm font-medium"><LayoutPanelTop size={16} /> Camera placement</span>
        <Select value={layout} onValueChange={(value) => { if (value) onLayoutChange(value); }}>
          <SelectTrigger className="w-full"><SelectValue>{layout === 'top' ? 'Above the conversation' : layout === 'side' ? 'Beside the conversation' : 'On the right'}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value="top">Above the conversation</SelectItem>
            <SelectItem value="side">Beside the conversation</SelectItem>
            <SelectItem value="right">On the right</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </SettingsSection>
  );

  return <MediaSettings section={page} />;
}
