import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageAttachment } from '@/api';
import MessageAttachmentPreview from './MessageAttachmentPreview';
import VoiceNoteComposer from './VoiceNoteComposer';

vi.mock('@/api', () => ({ api: vi.fn() }));

describe('voice note preview privacy', () => {
  it('shows the duration without rendering a remote audio source or autoplay', () => {
    const attachment = { id: 'attachment', filename: 'voice-note.webm', content_type: 'audio/webm', size_bytes: 1024, voice_note: true, duration_ms: 12_500 } as MessageAttachment;
    const html = renderToStaticMarkup(<MessageAttachmentPreview roomId="room" attachment={attachment} onError={() => {}} onDownload={() => {}} />);
    expect(html).toContain('Voice note · 0:12');
    expect(html).toContain('Listen to voice note');
    expect(html).not.toContain('<audio');
    expect(html).not.toContain('autoplay');
    expect(html).not.toContain('src=');
  });

  it('requires an explicit recording action and explains the review and independent microphone', () => {
    const html = renderToStaticMarkup(<VoiceNoteComposer onAttach={() => {}} onClose={() => {}} />);
    expect(html).toContain('Start recording');
    expect(html).toContain('Nothing is sent until you send your message');
    expect(html).toContain('Call mute and push-to-talk do not affect this recording');
    expect(html).not.toContain('<audio');
  });
});
