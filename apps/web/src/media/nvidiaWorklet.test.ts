import { describe, expect, it } from 'vitest';
import workletSource from './nvidiaDenoise.worklet.js?raw';

type WorkletMessage =
  | { type: 'frame'; id: number; samples: ArrayBuffer }
  | { type: 'failure'; reason: string }
  | {
      type: 'playout';
      underruns: number;
      droppedFrames: number;
      bufferMs: number;
    };

type Processor = {
  port: { onmessage: (event: { data: unknown }) => void };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

const sampleRate = 48_000;
const quantumSamples = 128;

function createHarness(frameSamples: 480 | 512 | 960 = 480) {
  let ProcessorClass: new (options: unknown) => Processor;
  let processor!: Processor;
  let nativePaused = false;
  let inputSample = 0;
  let renderedSamples = 0;
  let outstanding = 0;
  let peakOutstanding = 0;
  const pending: Array<{ id: number; samples: ArrayBuffer }> = [];
  const submitted: Array<{ id: number; samples: Float32Array }> = [];
  const messages: WorkletMessage[] = [];
  const output: number[] = [];

  const reply = (frame: { id: number; samples: ArrayBuffer }) => {
    outstanding--;
    processor.port.onmessage({
      data: { type: 'processed', id: frame.id, samples: frame.samples },
    });
  };

  class MockAudioWorkletProcessor {
    port = {
      onmessage: (_event: { data: unknown }) => {},
      postMessage: (message: WorkletMessage) => {
        messages.push(message);
        if (message.type !== 'frame') return;
        const samples = message.samples.slice(0);
        submitted.push({
          id: message.id,
          samples: new Float32Array(samples.slice(0)),
        });
        outstanding++;
        peakOutstanding = Math.max(peakOutstanding, outstanding);
        const frame = { id: message.id, samples };
        if (nativePaused) pending.push(frame);
        else reply(frame);
      },
    };
  }

  new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    workletSource,
  )(
    MockAudioWorkletProcessor,
    (_name: string, implementation: new (options: unknown) => Processor) => {
      ProcessorClass = implementation;
    },
    sampleRate,
  );
  processor = new ProcessorClass!({ processorOptions: { frameSamples } });

  function renderQuanta(count: number) {
    for (let quantum = 0; quantum < count; quantum++) {
      const input = new Float32Array(quantumSamples);
      for (let i = 0; i < input.length; i++) {
        input[i] = (Math.floor(inputSample++ / frameSamples) + 1) / 100;
      }
      const result = new Float32Array(quantumSamples);
      expect(processor.process([[input]], [[result]])).toBe(true);
      output.push(...result);
      renderedSamples += quantumSamples;
    }
  }

  function renderMs(milliseconds: number) {
    renderQuanta(
      Math.ceil((milliseconds * sampleRate) / 1000 / quantumSamples),
    );
  }

  return {
    frameSamples,
    messages,
    output,
    pending,
    processor,
    submitted,
    get elapsedMs() {
      return (renderedSamples * 1000) / sampleRate;
    },
    get peakOutstanding() {
      return peakOutstanding;
    },
    pauseNative() {
      nativePaused = true;
    },
    resumeNative() {
      nativePaused = false;
      while (pending.length) reply(pending.shift()!);
    },
    renderMs,
    renderUntil(predicate: () => boolean, maximumMs: number) {
      const deadline = renderedSamples + (maximumMs * sampleRate) / 1000;
      while (!predicate() && renderedSamples < deadline) renderQuanta(1);
      return predicate();
    },
    failures() {
      return messages.filter((message) => message.type === 'failure');
    },
    reports() {
      return messages.filter((message) => message.type === 'playout');
    },
  };
}

describe.each([480, 512, 960] as const)(
  'NVIDIA worklet with %i-sample native frames',
  (frameSamples) => {
    it('streams processed frames in order with their amplitudes intact', () => {
      const harness = createHarness(frameSamples);
      harness.renderMs(300);

      expect(harness.failures()).toEqual([]);
      expect(harness.submitted.length).toBeGreaterThan(10);
      expect(harness.submitted.map((frame) => frame.id)).toEqual(
        harness.submitted.map((_, id) => id),
      );
      harness.submitted.forEach((frame, id) => {
        expect(frame.samples[0]).toBeCloseTo((id + 1) / 100);
        expect(frame.samples.at(-1)).toBeCloseTo((id + 1) / 100);
      });

      const played = harness.output.filter((value) => value !== 0);
      expect(played.length).toBeGreaterThan(frameSamples * 8);
      played.forEach((value, index) => {
        expect(value).toBeCloseTo((Math.floor(index / frameSamples) + 1) / 100);
      });
    });
  },
);

it('keeps 512-sample native frames ordered across prolonged 128-sample worklet quanta', () => {
  const harness = createHarness(512);
  harness.renderMs(2_000);

  expect(harness.failures()).toEqual([]);
  expect(harness.submitted.length).toBeGreaterThan(180);
  expect(harness.submitted.map(({ id }) => id)).toEqual(
    harness.submitted.map((_, id) => id),
  );
  expect(harness.peakOutstanding).toBeLessThanOrEqual(1);
});

describe('NVIDIA worklet bounded jitter recovery', () => {
  it('recovers from a temporary 100 ms native response stall', () => {
    const harness = createHarness();
    harness.renderMs(150);
    harness.pauseNative();
    harness.renderMs(100);

    expect(harness.reports().at(-1)).toMatchObject({
      type: 'playout',
      underruns: 1,
    });
    expect(harness.failures()).toEqual([]);
    harness.resumeNative();
    const outputBeforeRecovery = harness.output.length;
    expect(
      harness.renderUntil(
        () =>
          harness.output
            .slice(outputBeforeRecovery)
            .some((sample) => sample !== 0),
        150,
      ),
    ).toBe(true);
    expect(harness.failures()).toEqual([]);
    expect(harness.peakOutstanding).toBeLessThanOrEqual(24);
  });

  it('fails a permanent stall within 300 ms and bounds submitted work', () => {
    const harness = createHarness();
    harness.renderMs(150);
    harness.pauseNative();
    const stalledAt = harness.elapsedMs;
    const submittedAtStall = harness.submitted.length;

    expect(harness.renderUntil(() => harness.failures().length > 0, 320)).toBe(
      true,
    );
    expect(harness.elapsedMs - stalledAt).toBeLessThanOrEqual(300);
    expect(harness.failures()).toEqual([
      {
        type: 'failure',
        reason: 'NVIDIA audio input queue exceeded its 240 ms limit',
      },
    ]);
    expect(harness.submitted.length - submittedAtStall).toBeLessThanOrEqual(24);
    const stoppedAt = harness.submitted.length;
    harness.renderMs(500);
    expect(harness.submitted).toHaveLength(stoppedAt);
  });

  it('fails on the fourth recovery within ten seconds', () => {
    const harness = createHarness();
    harness.renderMs(150);

    for (let recovery = 1; recovery <= 4; recovery++) {
      harness.pauseNative();
      expect(
        harness.renderUntil(
          () =>
            harness
              .reports()
              .some(
                (report) =>
                  report.type === 'playout' && report.underruns === recovery,
              ),
          150,
        ),
      ).toBe(true);
      harness.resumeNative();
      if (recovery < 4) {
        const outputAtResume = harness.output.length;
        expect(
          harness.renderUntil(
            () =>
              harness.output
                .slice(outputAtResume)
                .some((sample) => sample !== 0),
            150,
          ),
        ).toBe(true);
      }
    }

    expect(harness.failures()).toEqual([
      {
        type: 'failure',
        reason:
          'NVIDIA audio repeatedly stalled (4 buffer recoveries within 10 seconds)',
      },
    ]);
    expect(harness.elapsedMs).toBeLessThan(10_000);
  });

  it.each([
    [
      'out-of-order id',
      (frame: { id: number; samples: ArrayBuffer }) => ({ ...frame, id: 1 }),
    ],
    [
      'wrong frame length',
      (frame: { id: number; samples: ArrayBuffer }) => ({
        ...frame,
        samples: new Float32Array(479).buffer,
      }),
    ],
    [
      'non-finite samples',
      (frame: { id: number; samples: ArrayBuffer }) => ({
        ...frame,
        samples: new Float32Array(480).fill(Number.NaN).buffer,
      }),
    ],
  ])('rejects %s from native processing', (_name, corrupt) => {
    const harness = createHarness();
    harness.pauseNative();
    harness.renderMs(10);
    const frame = harness.pending.shift()!;
    harness.processor.port.onmessage({
      data: { type: 'processed', ...corrupt(frame) },
    });

    expect(harness.failures()).toEqual([
      {
        type: 'failure',
        reason: 'NVIDIA returned an invalid or out-of-order audio frame',
      },
    ]);
  });

  it('trims late output backlog and reports the dropped frames', () => {
    const harness = createHarness();
    harness.pauseNative();
    harness.renderMs(100);
    harness.resumeNative();

    expect(harness.failures()).toEqual([]);
    expect(harness.reports().at(-1)).toMatchObject({
      type: 'playout',
      droppedFrames: 6,
      bufferMs: 40,
    });
  });
});
