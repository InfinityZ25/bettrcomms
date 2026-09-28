import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopCapabilityName } from './types';

const NATIVE: DesktopCapabilityName[] = [
  'nativeGameVideo',
  'nativeProcessAudio',
  'nativeMicrophoneDsp',
  'localTrackRecording',
  'mediaPermissions',
  'globalInput',
  'nativeOverlays',
];

function capability(state: string) {
  return { state, detail: 'detail', fallback: 'browser path' };
}

function wailsBoot() {
  return {
    schemaVersion: 1,
    runtime: 'wails',
    hostVersion: '0.0.1-wails',
    platform: 'windows',
    architecture: 'amd64',
    apiOrigin: '',
    authReturn: capability('unavailable'),
    windowControls: {
      platform: 'windows',
      mode: 'client-side',
      height: 32,
      insetStart: 0,
      insetEnd: 0,
      buttons: ['minimize', 'maximize', 'close'],
      buttonSide: 'end',
    },
    capabilities: {
      schemaVersion: 1,
      platform: 'windows',
      architecture: 'amd64',
      browserMedia: capability('implemented'),
      ...Object.fromEntries(
        NATIVE.map((name) => [
          name,
          {
            state: 'unavailable',
            detail: 'not ported to the Wails host',
            fallback: 'browser path',
          },
        ]),
      ),
      notes: ['this host contains no media code'],
    },
  };
}

async function load(boot?: unknown) {
  vi.resetModules();
  vi.stubGlobal(
    'window',
    boot === undefined ? {} : { __BETTERCOMMS_DESKTOP__: boot },
  );
  return import('./capabilities');
}

describe('capability reporting', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the Wails host capability report', async () => {
    const capabilities = await load(wailsBoot());
    const report = capabilities.getDesktopCapabilities();

    for (const name of NATIVE) {
      expect(report[name].state).toBe('unavailable');
      expect(capabilities.hasDesktopCapability(name)).toBe(false);
      expect(capabilities.describeCapabilityFallback(name)).not.toBe('');
    }
    expect(report.browserMedia.state).toBe('implemented');
    expect(capabilities.hasDesktopCapability('browserMedia')).toBe(true);
    expect(capabilities.describeCapabilityFallback('browserMedia')).toBe('');
  });

  it('reports every native capability unavailable in a browser', async () => {
    const capabilities = await load();
    const report = capabilities.getDesktopCapabilities();

    for (const name of NATIVE) {
      expect(report[name].state).toBe('unavailable');
      expect(report[name].fallback).toBeTruthy();
    }
  });

  it('summarises the runtime for diagnostics without identifiers', async () => {
    const capabilities = await load(wailsBoot());

    const summary = capabilities.describeDesktopRuntime();

    expect(summary).toMatchObject({
      runtime: 'wails',
      hostVersion: '0.0.1-wails',
      platform: 'windows',
      architecture: 'amd64',
    });
    expect(summary.capabilities.nativeGameVideo).toBe('unavailable');
    expect(JSON.stringify(summary)).not.toContain('token');
  });
});
