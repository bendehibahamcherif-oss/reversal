export class SnapshotEngine {
  constructor() {
    this.snapshots = [];
  }

  capture(state) {
    const snapshot = {
      timestamp: Date.now(),
      state,
    };

    this.snapshots.push(snapshot);

    return snapshot;
  }

  latest() {
    return (
      this.snapshots[
        this.snapshots.length - 1
      ] || null
    );
  }
}

export const snapshotEngine =
  new SnapshotEngine();
