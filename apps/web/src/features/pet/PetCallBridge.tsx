import { useRef, type RefObject } from 'react';
import { useActiveCall } from '@/features/call/CallSessionContext';
import { useMountEffect } from '@/hooks/useMountEffect';
import { emitPetSignal } from './signals';

type CallActivity = { joined: boolean; selfSpeaking: boolean; remoteSpeaking: boolean; people: number };

function CallActivityReporter({ activity, previous }: { activity: CallActivity; previous: RefObject<CallActivity> }) {
  useMountEffect(() => {
    const { joined, selfSpeaking, remoteSpeaking, people } = activity;
    const last = previous.current;
    previous.current = activity;
    if (joined !== last.joined) emitPetSignal({ type: 'call', joined });
    if (selfSpeaking !== last.selfSpeaking) emitPetSignal({ type: 'speaking', self: true, active: selfSpeaking });
    if (remoteSpeaking !== last.remoteSpeaking) emitPetSignal({ type: 'speaking', self: false, active: remoteSpeaking });
    if (joined && last.joined && people > last.people) emitPetSignal({ type: 'call-peer', joined: true });
  });
  return null;
}

/**
 * Tells the companion about the call using state the call already computes:
 * joined, the speaking set the voice indicator uses, and the account
 * identities of the people present. No audio is analysed here and nothing is
 * polled; it only notices when one of those values changes.
 */
export default function PetCallBridge() {
  const call = useActiveCall();
  const joined = call.joined;
  const selfSpeaking = joined && call.speaking.has('self');
  let remoteSpeaking = false;
  if (joined) for (const id of call.speaking) if (id !== 'self') remoteSpeaking = true;
  const people = joined ? new Set(Object.values(call.peerUserIds)).size : 0;
  const previous = useRef<CallActivity>({ joined: false, selfSpeaking: false, remoteSpeaking: false, people: 0 });
  return <CallActivityReporter
    key={`${joined}:${selfSpeaking}:${remoteSpeaking}:${people}`}
    activity={{ joined, selfSpeaking, remoteSpeaking, people }}
    previous={previous}
  />;
}
