/**
 * Counts minutes of genuine listening from `timeupdate` positions. Pausing, seeking and scrubbing never
 * count: a position jump larger than `maxStep` seconds is treated as a seek, not as listening.
 */
export class StreamMeter {
  private accumulated = 0;
  private last: number | undefined;

  constructor(
    private secondsPerUnit = 60,
    private maxStep = 3,
  ) {}

  /** Report the playback position; returns how many whole units (minutes) of listening just completed. */
  tick(position: number, playing: boolean): number {
    const prev = this.last;
    this.last = position;
    if (!playing || prev === undefined) return 0;
    const delta = position - prev;
    if (delta <= 0 || delta > this.maxStep) return 0;
    this.accumulated += delta;
    const units = Math.floor(this.accumulated / this.secondsPerUnit);
    this.accumulated -= units * this.secondsPerUnit;
    return units;
  }

  /** Start fresh (new episode). */
  reset(): void {
    this.accumulated = 0;
    this.last = undefined;
  }

  get pendingSeconds(): number {
    return this.accumulated;
  }
}
