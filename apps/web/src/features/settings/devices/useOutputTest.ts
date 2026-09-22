import { useCallback, useEffect, useRef, useState } from 'react';
import { applyOutputDevice } from '@/media/output';
import { createOutputGain } from '@/media/volumeSettings';
import { closeContext, deviceError } from './deviceHelpers';

/** A short 440 Hz tone through the selected output, to prove where sound lands. */
export function useOutputTest(alive: React.RefObject<boolean>) {
  const [status, setStatus] = useState('');
  const context = useRef<AudioContext | null>(null);

  const release = useCallback(() => {
    closeContext(context.current);
    context.current = null;
  }, []);

  useEffect(() => release, [release]);

  async function play() {
    setStatus('');
    let audio: AudioContext | null = null;
    let master: ReturnType<typeof createOutputGain> | null = null;
    try {
      release();
      audio = new AudioContext();
      context.current = audio;
      await applyOutputDevice(audio);
      if (!alive.current || context.current !== audio) {
        closeContext(audio);
        return;
      }
      await audio.resume();
      if (!alive.current || context.current !== audio) {
        closeContext(audio);
        return;
      }
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      master = createOutputGain(audio);
      oscillator.frequency.value = 440;
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.16, audio.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.55);
      oscillator.connect(gain).connect(master.gain).connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.6);
      const finished = audio;
      oscillator.onended = () => {
        master?.dispose();
        if (context.current === finished) context.current = null;
        closeContext(finished);
      };
      setStatus('Test tone played through the selected output.');
    } catch (error) {
      master?.dispose();
      closeContext(audio);
      if (context.current === audio) context.current = null;
      if (alive.current) setStatus(deviceError(error));
    }
  }

  return { status, setStatus, play, release };
}
