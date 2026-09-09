import type { CSSProperties, ReactNode } from 'react';

export type DeviceOption = { id: string; label: string };

/** A labelled device chooser; the empty value means "whatever the system picks". */
export function DeviceSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: DeviceOption[];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">System default</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A 0–200% gain slider with its value shown alongside. */
export function VolumeSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const percent = Math.round(value * 100);
  return (
    <label className="device-volume">
      <span>
        {label} <output>{percent}%</output>
      </span>
      <input
        aria-label={label}
        aria-valuetext={`${percent} percent`}
        type="range"
        min="0"
        max="2"
        step="0.01"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function DeviceCard({ children }: { children: ReactNode }) {
  return <div className="device-settings__card">{children}</div>;
}

export function DeviceActions({ children }: { children: ReactNode }) {
  return <div className="device-settings__actions">{children}</div>;
}

/** A status line; `error` styles the failures the person may need to act on. */
export function DeviceStatus({ status, error }: { status: string; error?: boolean }) {
  if (!status) return null;
  return (
    <p className="device-settings__status" data-error={error} role="status">
      {status}
    </p>
  );
}

export function LevelMeter({ level }: { level: number }) {
  return (
    <div
      className="device-settings__meter"
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level)}
    >
      <span style={{ '--level': `${level}%` } as CSSProperties} />
    </div>
  );
}
