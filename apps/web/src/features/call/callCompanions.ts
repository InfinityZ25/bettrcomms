export type CallCompanionSnapshot = {
  peerUserIds: Record<string, string>;
  companionArrivals: Record<string, string>;
  companionArrivalTimes: Record<string, number>;
};

export const EMPTY_CALL_COMPANIONS: CallCompanionSnapshot = {
  peerUserIds: {},
  companionArrivals: {},
  companionArrivalTimes: {},
};

const ARRIVAL_WINDOW_MS = 1500;
const MAX_ARRIVALS = 2;

/** Account identity survives transport repair; only live membership events greet. */
export class CallCompanions {
  private peers = new Set<string>();
  private arrivalTimes: number[] = [];
  private sequence = 0;
  private confirmed = false;
  private current: CallCompanionSnapshot = EMPTY_CALL_COMPANIONS;

  constructor(private sessionId: string, private localUserId: string) {}

  snapshotPeers(
    peerIds: string[],
    identities: Record<string, { userId: string }>,
  ): CallCompanionSnapshot {
    for (const peerId of peerIds) {
      this.peers.add(peerId);
      this.identify(peerId, identities[peerId]?.userId);
    }
    return this.current;
  }

  joinPeer(peerId: string, userId?: string, now = Date.now()): CallCompanionSnapshot {
    const knownPeer = this.peers.has(peerId);
    const represented = userId === this.localUserId ||
      Object.values(this.current.peerUserIds).includes(userId ?? '');
    this.peers.add(peerId);
    this.identify(peerId, userId);
    if (!knownPeer && userId && !represented) this.arrive(userId, now);
    return this.current;
  }

  leavePeer(peerId: string): CallCompanionSnapshot {
    this.peers.delete(peerId);
    const userId = this.current.peerUserIds[peerId];
    if (!userId) return this.current;
    const peerUserIds = { ...this.current.peerUserIds };
    delete peerUserIds[peerId];
    const companionArrivals = { ...this.current.companionArrivals };
    const companionArrivalTimes = { ...this.current.companionArrivalTimes };
    if (userId !== this.localUserId && !Object.values(peerUserIds).includes(userId)) {
      delete companionArrivals[userId];
      delete companionArrivalTimes[userId];
    }
    this.current = { peerUserIds, companionArrivals, companionArrivalTimes };
    return this.current;
  }

  confirmLocalJoin(now = Date.now()): CallCompanionSnapshot {
    if (!this.confirmed) {
      this.confirmed = true;
      this.arrive(this.localUserId, now);
    }
    return this.current;
  }

  private identify(peerId: string, userId?: string) {
    if (!userId || this.current.peerUserIds[peerId] === userId) return;
    this.current = {
      ...this.current,
      peerUserIds: { ...this.current.peerUserIds, [peerId]: userId },
    };
  }

  private arrive(userId: string, now: number) {
    this.arrivalTimes = this.arrivalTimes.filter((time) => now - time < ARRIVAL_WINDOW_MS);
    if (this.arrivalTimes.length >= MAX_ARRIVALS) return;
    this.arrivalTimes.push(now);
    this.sequence += 1;
    this.current = {
      ...this.current,
      companionArrivals: {
        ...this.current.companionArrivals,
        [userId]: `call:${this.sessionId}:${userId}:${this.sequence}`,
      },
      companionArrivalTimes: {
        ...this.current.companionArrivalTimes,
        [userId]: now,
      },
    };
  }
}
