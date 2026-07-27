export const healthCollectionState: {
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastFailedAt: Date | null;
  running: boolean;
} = {
  lastStartedAt: null,
  lastCompletedAt: null,
  lastFailedAt: null,
  running: false,
};
