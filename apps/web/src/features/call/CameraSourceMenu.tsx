import { useCallback, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { readStored } from '@/lib/storage';

type Camera = { id: string; label: string };

/** A call-local source picker for phone cameras and browser-visible accessories. */
export default function CameraSourceMenu({
  busy,
  onSelect,
}: {
  busy: boolean;
  onSelect: (deviceId: string) => Promise<void>;
}) {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selected, setSelected] = useState(() => readStored('bc-camera') ?? '');
  const [status, setStatus] = useState('');
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setStatus('Camera selection is unavailable in this browser.');
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const seen = new Set<string>();
      setCameras(devices
        .filter((device) => device.kind === 'videoinput' && device.deviceId)
        .filter((device) => {
          if (seen.has(device.deviceId)) return false;
          seen.add(device.deviceId);
          return true;
        })
        .map((device, index) => ({
          id: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        })));
      setStatus('');
    } catch {
      setStatus('Could not list cameras. Check camera access and try again.');
    }
  }, []);

  useEffect(() => {
    const changed = () => void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', changed);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', changed);
  }, [refresh]);

  const select = async (deviceId: string) => {
    setOpen(false);
    setSwitching(true);
    try {
      await onSelect(deviceId);
      setSelected(readStored('bc-camera') ?? '');
      await refresh();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) {
        setSelected(readStored('bc-camera') ?? '');
        void refresh();
      }
    }}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="secondary"
            size="icon"
            className="size-8 rounded-full md:hidden"
            aria-label="Choose camera"
            title="Choose camera"
            disabled={busy || switching}
          />
        }
      >
        <ChevronDown size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Camera source</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={selected} onValueChange={(value) => void select(value)}>
          <DropdownMenuRadioItem value="" disabled={switching}>System default</DropdownMenuRadioItem>
          {cameras.map((camera) => (
            <DropdownMenuRadioItem key={camera.id} value={camera.id} disabled={switching}>
              {camera.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {status && <p className="px-3 py-2 text-xs text-muted-foreground" role="status">{status}</p>}
        {!status && cameras.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Turn on your camera to show available sources.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
