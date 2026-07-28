export const healthCollectionState: {
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastFailedAt: Date | null;
  lastSkippedAt: Date | null;
  lastDurationMs: number | null;
  lastErrorCategory: string | null;
  lastSkipReason: string | null;
  collectionVersion: string;
  instanceId: string | null;
  processRole: string | null;
  running: boolean;
} = {
  lastStartedAt: null,
  lastCompletedAt: null,
  lastFailedAt: null,
  lastSkippedAt: null,
  lastDurationMs: null,
  lastErrorCategory: null,
  lastSkipReason: null,
  collectionVersion: 'health-v2',
  instanceId: null,
  processRole: null,
  running: false,
};
