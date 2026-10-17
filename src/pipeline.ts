/**
 * Two-stage generation pipeline: drums -> bass.
 *
 * The bassist needs the drummer's bars for the same block and its own previous block, but the drummer only needs its own previous block. So the stages overlap: as soon as bass starts on block N, drums start on block N+1.
 *
 * The pipeline keeps `bufferBlocks` finished blocks queued ahead of the one that is playing (2 blocks = 8 bars). Every finished block, and every block still being written, counts toward that target, so new work starts the moment the player takes a block.
 *
 * This file has no DOM or audio code on purpose, so the scheduling can be tested on its own.
 */

export interface Block<D, B> {
  n: number;
  drums: D;
  bass: B;
}

export interface PipelineStatus {
  /** Finished blocks waiting to be played */
  ready: number;
  /** Block number the drummer is writing right now, or null */
  drumsN: number | null;
  /** Block number the bassist is writing right now, or null */
  bassN: number | null;
}

export interface PipelineOptions<D, B> {
  bufferBlocks: number;
  writeDrums: (n: number) => Promise<D>;
  writeBass: (n: number, drums: D) => Promise<B>;
  onBlockReady?: (block: Block<D, B>) => void;
  onError?: (stage: 'drums' | 'bass', n: number, err: unknown, willRetry: boolean) => void;
  onChange?: () => void;
  retryDelayMs?: number;
  /** After this many failures in a row the pipeline pauses until the next take() */
  maxFailures?: number;
}

export class Pipeline<D, B> {
  private ready: Block<D, B>[] = [];
  private drumsReady: { n: number; drums: D }[] = [];
  private bassWorking: { n: number; drums: D } | null = null;
  private drumsBusy = false;
  private nextDrumsN = 1;
  private failures = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly retryDelayMs: number;
  private readonly maxFailures: number;

  constructor(private readonly opts: PipelineOptions<D, B>) {
    this.retryDelayMs = opts.retryDelayMs ?? 1500;
    this.maxFailures = opts.maxFailures ?? 3;
  }

  start() {
    this.pump();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
  }

  /** Hand the next finished block to the player (undefined if none is ready). Also clears the failure count, so a paused pipeline resumes at each phrase boundary. */
  take(): Block<D, B> | undefined {
    this.failures = 0;
    const block = this.ready.shift();
    this.pump();
    return block;
  }

  status(): PipelineStatus {
    return {
      ready: this.ready.length,
      drumsN: this.drumsBusy ? this.nextDrumsN : null,
      bassN: this.bassWorking?.n ?? null,
    };
  }

  private pump() {
    if (this.stopped) return;
    if (this.failures < this.maxFailures) {
      if (!this.bassWorking && this.drumsReady.length > 0) {
        void this.runBass(this.drumsReady.shift()!);
      }
      const projected = this.ready.length + this.drumsReady.length + (this.bassWorking ? 1 : 0) + (this.drumsBusy ? 1 : 0);
      if (!this.drumsBusy && projected < this.opts.bufferBlocks) {
        void this.runDrums();
      }
    }
    this.opts.onChange?.();
  }

  private async runDrums() {
    const n = this.nextDrumsN;
    this.drumsBusy = true;
    let ok = false;
    try {
      const drums = await this.opts.writeDrums(n);
      if (this.stopped) return;
      this.nextDrumsN = n + 1;
      this.drumsReady.push({ n, drums });
      this.failures = 0;
      ok = true;
    } catch (err) {
      if (this.stopped) return;
      this.fail('drums', n, err);
    } finally {
      this.drumsBusy = false;
    }
    if (ok) this.pump();
    else this.opts.onChange?.();
  }

  private async runBass(job: { n: number; drums: D }) {
    this.bassWorking = job;
    let ok = false;
    try {
      const bass = await this.opts.writeBass(job.n, job.drums);
      if (this.stopped) return;
      const block = { n: job.n, drums: job.drums, bass };
      this.ready.push(block);
      this.failures = 0;
      ok = true;
      this.opts.onBlockReady?.(block);
    } catch (err) {
      if (this.stopped) return;
      this.drumsReady.unshift(job); // keep the drummer's work and retry the bass
      this.fail('bass', job.n, err);
    } finally {
      this.bassWorking = null;
    }
    if (ok) this.pump();
    else this.opts.onChange?.();
  }

  private fail(stage: 'drums' | 'bass', n: number, err: unknown) {
    this.failures += 1;
    const willRetry = this.failures < this.maxFailures;
    this.opts.onError?.(stage, n, err, willRetry);
    if (willRetry) this.retryTimer = setTimeout(() => this.pump(), this.retryDelayMs);
  }
}
