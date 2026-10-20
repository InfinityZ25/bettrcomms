import { describe, expect, it } from 'vitest';
import { CallCompanions } from './callCompanions';

describe('call companion account identities and arrivals', () => {
  it('seeds initial and resumed peers silently while preserving known account identities', () => {
    const companions = new CallCompanions('local-device', 'me');
    const initial = companions.snapshotPeers(['peer-a'], { 'peer-a': { userId: 'alice' } });
    expect(initial).toEqual({ peerUserIds: { 'peer-a': 'alice' }, companionArrivals: {}, companionArrivalTimes: {} });
    expect(companions.snapshotPeers(['peer-a'], {})).toBe(initial);
    expect(companions.joinPeer('peer-a', 'alice', 100)).toBe(initial);
    expect(companions.snapshotPeers(['peer-b'], { 'peer-b': { userId: 'bob' } }).companionArrivals).toEqual({});
  });

  it('greets confirmed joins once and suppresses additional devices of a represented account', () => {
    const companions = new CallCompanions('local-device', 'me');
    const own = companions.confirmLocalJoin(0);
    expect(own.companionArrivals.me).toBe('call:local-device:me:1');
    expect(own.companionArrivalTimes.me).toBe(0);
    expect(companions.confirmLocalJoin(1)).toBe(own);
    expect(companions.joinPeer('my-other-device', 'me', 10).companionArrivals).toEqual(own.companionArrivals);
    const alice = companions.joinPeer('alice-first', 'alice', 20);
    expect(alice.companionArrivals.alice).toBe('call:local-device:alice:2');
    expect(alice.companionArrivalTimes.alice).toBe(20);
    expect(companions.joinPeer('alice-second', 'alice', 30).companionArrivals).toEqual(alice.companionArrivals);
    companions.leavePeer('alice-first');
    expect(companions.joinPeer('alice-third', 'alice', 2000).companionArrivals.alice).toBe(alice.companionArrivals.alice);
    expect(companions.joinPeer('alice-fourth', 'alice', 3000).companionArrivalTimes.alice).toBe(20);
  });

  it('releases transport mappings and permits a real later return with the same account appearance', () => {
    const companions = new CallCompanions('local-device', 'me');
    const first = companions.joinPeer('alice-old-device', 'alice', 0);
    const left = companions.leavePeer('alice-old-device');
    expect(left.peerUserIds).toEqual({});
    expect(left.companionArrivals).toEqual({});
    expect(left.companionArrivalTimes).toEqual({});
    const returned = companions.joinPeer('alice-new-device', 'alice', 2000);
    expect(returned.peerUserIds).toEqual({ 'alice-new-device': 'alice' });
    expect(returned.companionArrivals.alice).not.toBe(first.companionArrivals.alice);
    expect(returned.companionArrivalTimes.alice).toBe(2000);
  });

  it('bounds arrival bursts without timers or delayed greetings', () => {
    const companions = new CallCompanions('local-device', 'me');
    companions.confirmLocalJoin(0);
    companions.joinPeer('peer-a', 'alice', 100);
    const suppressed = companions.joinPeer('peer-b', 'bob', 200);
    expect(Object.keys(suppressed.companionArrivals)).toEqual(['me', 'alice']);
    expect(suppressed.peerUserIds['peer-b']).toBe('bob');
    expect(companions.joinPeer('peer-b', 'bob', 2000).companionArrivals.bob).toBeUndefined();
    expect(suppressed.companionArrivalTimes.bob).toBeUndefined();
    expect(companions.joinPeer('peer-c', 'carol', 2000).companionArrivals.carol).toBeDefined();
  });

  it('does not treat a late identity for an existing transport as a new arrival', () => {
    const companions = new CallCompanions('local-device', 'me');
    companions.snapshotPeers(['unknown'], {});
    expect(companions.joinPeer('unknown', 'alice', 0)).toEqual({
      peerUserIds: { unknown: 'alice' }, companionArrivals: {}, companionArrivalTimes: {},
    });
  });

  it('preserves the event time across silent resume so a newly visible tile can reject an old greeting', () => {
    const companions = new CallCompanions('local-device', 'me');
    const joined = companions.joinPeer('alice-device', 'alice', 1000);
    const resumed = companions.snapshotPeers(['alice-device'], { 'alice-device': { userId: 'alice' } });
    expect(resumed).toBe(joined);
    expect(resumed.companionArrivalTimes.alice).toBe(1000);
    const duplicate = companions.joinPeer('alice-device', 'alice', 60_000);
    expect(duplicate).toBe(joined);
    expect(duplicate.companionArrivalTimes.alice).toBe(1000);
    const recoveredPeer = companions.snapshotPeers(['bob-device'], { 'bob-device': { userId: 'bob' } });
    expect(recoveredPeer.companionArrivals.bob).toBeUndefined();
    expect(recoveredPeer.companionArrivalTimes.bob).toBeUndefined();
  });
});
