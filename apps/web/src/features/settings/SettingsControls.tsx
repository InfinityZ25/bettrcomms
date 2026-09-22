import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function SettingsSelect({ value, onValueChange, options, ariaLabel, disabled, className }: {
  value: string | number;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string | number; label: string; disabled?: boolean }>;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const selected = options.find((option) => String(option.value) === String(value));
  const normalize = (optionValue: string | number) => optionValue === '' ? '__system_default__' : String(optionValue);
  return (
    <Select value={normalize(value)} onValueChange={(next) => onValueChange(next === '__system_default__' ? '' : String(next))} disabled={disabled}>
      {/*
        A real device name is "Communications - Altavoces (Realtek(R) Audio)".
        The trigger cannot wrap it and the value is a flex box, where an
        ellipsis has nothing to apply to — so the label is its own element,
        allowed to shrink, and the whole name is on the title.
      */}
      <SelectTrigger
        aria-label={ariaLabel}
        title={selected?.label}
        className={className ?? 'w-full'}
      >
        <SelectValue>
          <span className="min-w-0 truncate">{selected?.label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => <SelectItem key={normalize(option.value)} value={normalize(option.value)} disabled={option.disabled}>{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function SettingsSlider({ value, onValueChange, min, max, step, ariaLabel }: {
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
}) {
  return <Slider aria-label={ariaLabel} value={[value]} min={min} max={max} step={step} onValueChange={(values) => onValueChange(Array.isArray(values) ? values[0] : values)} />;
}

export function InfoTip({ label, children }: { label: string; children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} />}>
        <Info className="text-muted-foreground" />
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}
