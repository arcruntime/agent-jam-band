/**
 * Multi-stage generation pipeline: for example drums -> bass -> keys -> melody.
 *
 * A block (4 bars) passes through the stages in order, and each stage sees every earlier stage's output for that block. Stages overlap across blocks: while the bassist works on block N, the drummer is already on block N+1, and so on. Each stage handles one block at a time, in order, because a musician also needs its own previous block for continuity.
 *
 * The pipeline keeps `bufferBlocks` blocks queued ahead of the one that is playing (2 blocks = 8 bars). Finished blocks and blocks still being written both count toward that target, so new work starts the moment the player takes a block.
 *
 * This file has no DOM or audio code on purpose, so the scheduling can be tested on its own.
 */

export interface Stage<P> {
  name: keyof P & string;
  /** Write this stage's part for block `n`. `upstream` holds the parts the earlier stages already wrote for the same block. */
  write: (n: number, upstream: Partial<P>) => Promise<P[keyof P]>;
}

export interface Block<P> {
  n: number;
  parts: P;
}

export interface PipelineStatus {
  /** Finished blocks waiting to be played */
  ready: number;
  /** Stages that are writing right now, with the block number each one is on (latest stage first) */
  working: { stage: string; n: number }[];
}

export interface PipelineOptions<P> {
  bufferBlocks: number;
  stages: Stage<P>[];
  onBlockReady?: (block: Block<P>) => void;
  onError?: (stage: string, n: number, err: unknown, willRetry: boolean) => void;
  onChange?: () => void;
  retryDelayMs?: number;
  /** After this many failures in a row the pipeline pauses until the next take() */
  maxFailures?: number;
}

interface Job<P> {
  n: number;
  parts: Partial<P>;
}

export class Pipeline<P> {
  private readonly ready: Block<P>[] = [];
  /** queues[k] = jobs waiting for stage k (queues[0] is unused: stage 0 creates its own jobs) */
  private readonly queues: Job<P>[][];
  private readonly working: (Job<P> | null)[];
  private nextN = 1;
  private failures = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly retryDelayMs: number;
  private readonly maxFailures: number;

  constructor(private readonly opts: PipelineOptions<P>) {
    this.queues = opts.stages.map(() => []);
    this.working = opts.stages.map(() => null);
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
  take(): Block<P> | undefined {
    this.failures = 0;
    const block = this.ready.shift();
    this.pump();
    return block;
  }

  status(): PipelineStatus {
    const working: PipelineStatus['working'] = [];
    for (let k = this.working.length - 1; k >= 0; k--) {
      const job = this.working[k];
      if (job) working.push({ stage: this.opts.stages[k].name, n: job.n });
    }
    return { ready: this.ready.length, working };
  }

  /** Blocks that are finished or somewhere in the pipeline */
  private projected(): number {
    let count = this.ready.length;
    for (let k = 1; k < this.queues.length; k++) count += this.queues[k].length;
    for (const job of this.working) if (job) count += 1;
    return count;
  }

  private pump() {
    if (this.stopped) return;
    if (this.failures < this.maxFailures) {
      // Later stages first, so finished upstream work moves on before new work is started.
      for (let k = this.opts.stages.length - 1; k >= 1; k--) {
        if (!this.working[k] && this.queues[k].length > 0) void this.run(k, this.queues[k].shift()!);
      }
      if (!this.working[0] && this.projected() < this.opts.bufferBlocks) {
        void this.run(0, { n: this.nextN, parts: {} });
      }
    }
    this.opts.onChange?.();
  }

  private async run(k: number, job: Job<P>) {
    const stage = this.opts.stages[k];
    this.working[k] = job;
    let ok = false;
    try {
      const part = await stage.write(job.n, { ...job.parts });
      if (this.stopped) return;
      job.parts[stage.name] = part as P[keyof P & string];
      if (k === 0) this.nextN = job.n + 1;
      if (k === this.opts.stages.length - 1) {
        const block: Block<P> = { n: job.n, parts: job.parts as P };
        this.ready.push(block);
        this.failures = 0;
        ok = true;
        this.opts.onBlockReady?.(block);
      } else {
        this.queues[k + 1].push(job);
        this.failures = 0;
        ok = true;
      }
    } catch (err) {
      if (this.stopped) return;
      if (k > 0) this.queues[k].unshift(job); // keep the earlier parts and retry this stage
      this.fail(stage.name, job.n, err);
    } finally {
      this.working[k] = null;
    }
    if (ok) this.pump();
    else this.opts.onChange?.();
  }

  private fail(stage: string, n: number, err: unknown) {
    this.failures += 1;
    const willRetry = this.failures < this.maxFailures;
    this.opts.onError?.(stage, n, err, willRetry);
    if (willRetry) this.retryTimer = setTimeout(() => this.pump(), this.retryDelayMs);
  }
}
