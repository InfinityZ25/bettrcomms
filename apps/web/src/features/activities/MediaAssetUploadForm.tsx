import type { RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Props = {
  kind: 'sticker' | 'sound';
  name: string;
  file: File | null;
  progress: number | null;
  busy: boolean;
  picker: RefObject<HTMLInputElement | null>;
  onName: (name: string) => void;
  onFile: (file: File | null) => void;
  onCancel: () => void;
  onCreate: () => Promise<void>;
};

export function MediaAssetUploadForm({
  kind,
  name,
  file,
  progress,
  busy,
  picker,
  onName,
  onFile,
  onCancel,
  onCreate,
}: Props) {
  const uploading = progress !== null;
  return (
    <form
      className="space-y-3 rounded-xl border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onCreate();
      }}
    >
      <label className="block text-sm font-medium">
        Name
        <Input
          className="mt-2"
          required
          maxLength={60}
          value={name}
          onChange={(event) => onName(event.target.value)}
          disabled={uploading}
          placeholder={kind === 'sticker' ? 'Victory dance' : 'Round won'}
        />
      </label>
      <label className="block text-sm">
        {kind === 'sticker'
          ? 'Image · up to 5 MB'
          : 'Audio · up to 30 seconds and 2 MB'}
        <input
          ref={picker}
          type="file"
          required
          accept={
            kind === 'sticker'
              ? 'image/png,image/jpeg,image/gif,image/webp,image/avif'
              : 'audio/*'
          }
          className="mt-2 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-2"
          disabled={uploading}
          onChange={(event) => onFile(event.target.files?.[0] ?? null)}
        />
      </label>
      {uploading && (
        <div role="status" className="text-xs text-muted-foreground">
          Uploading {Math.round(progress!)}%
          <progress className="mt-2 block w-full" max={100} value={progress!} />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={uploading}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={uploading || busy || !file || !name.trim()}
        >
          {uploading ? 'Adding…' : 'Add to channel'}
        </Button>
      </div>
    </form>
  );
}
