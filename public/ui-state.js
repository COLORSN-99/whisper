// A snapshot may arrive after newer events, or after a newer snapshot request.
// Preserve fields changed by live events while that request was in flight.
export function createStateSyncGuard() {
  let eventRevision = 0;
  let nextRequest = 0;
  let lastAppliedRequest = 0;
  const fieldRevisions = new Map();
  return {
    noteEvent(keys) {
      eventRevision += 1;
      for (const key of keys) fieldRevisions.set(key, eventRevision);
    },
    beginSnapshot() {
      return {eventRevision, request: ++nextRequest};
    },
    acceptSnapshot(data, token) {
      if (token.request < lastAppliedRequest) return null;
      lastAppliedRequest = token.request;
      return Object.fromEntries(Object.entries(data).filter(([key]) =>
        (fieldRevisions.get(key) || 0) <= token.eventRevision));
    },
  };
}
