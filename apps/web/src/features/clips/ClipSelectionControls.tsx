import { memo } from 'react';
import { Input } from '@/components/ui/input';

export interface ClipSourceOption {
  key: string;
  label: string;
}

interface ClipSelectionControlsProps {
  duration: number;
  start: number;
  end: number;
  video: string;
  audio: readonly string[];
  videoOptions: readonly ClipSourceOption[];
  audioOptions: readonly ClipSourceOption[];
  disabled: boolean;
  onStartChange: (value: number) => void;
  onEndChange: (value: number) => void;
  onVideoChange: (key: string) => void;
  onAudioChange: (key: string, enabled: boolean) => void;
}

export const ClipSelectionControls = memo(function ClipSelectionControls({
  duration,
  start,
  end,
  video,
  audio,
  videoOptions,
  audioOptions,
  disabled,
  onStartChange,
  onEndChange,
  onVideoChange,
  onAudioChange,
}: ClipSelectionControlsProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <label className="space-y-1 text-sm">
          Start · {start.toFixed(1)}s
          <Input
            type="range"
            aria-label="Clip start"
            min={0}
            max={Math.max(0, end - 1)}
            step={0.1}
            value={start}
            disabled={disabled}
            onChange={(event) => onStartChange(Number(event.target.value))}
          />
        </label>
        <label className="space-y-1 text-sm">
          End · {end.toFixed(1)}s
          <Input
            type="range"
            aria-label="Clip end"
            min={Math.min(duration, start + 1)}
            max={Math.min(duration, start + 60)}
            step={0.1}
            value={end}
            disabled={disabled}
            onChange={(event) => onEndChange(Number(event.target.value))}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        {(end - start).toFixed(1)} second clip · maximum 60 seconds ·{' '}
        {duration.toFixed(1)} seconds available
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          Video source
          <select
            aria-label="Clip video source"
            className="h-9 w-full rounded-md border bg-background px-2"
            value={video}
            disabled={disabled}
            onChange={(event) => onVideoChange(event.target.value)}
          >
            <option value="">Audio only</option>
            {videoOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset disabled={disabled} className="space-y-1 text-sm">
          <legend>Audio sources</legend>
          {audioOptions.map((option) => (
            <label key={option.key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={audio.includes(option.key)}
                onChange={(event) =>
                  onAudioChange(option.key, event.target.checked)
                }
              />
              {option.label}
            </label>
          ))}
          {!audioOptions.length && (
            <p className="text-muted-foreground">No audio was captured</p>
          )}
        </fieldset>
      </div>
    </>
  );
});
