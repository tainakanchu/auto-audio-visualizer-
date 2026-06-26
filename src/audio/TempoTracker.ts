/**
 * Tempo (BPM) detection and a freewheeling beat grid.
 *
 * Fed one onset/level sample per computed audio frame; resamples onsets into a
 * fixed-rate (100 Hz) envelope, runs a cheap autocorrelation roughly twice a
 * second to estimate BPM, aligns the grid phase to the music, and exposes a
 * monotonic beat grid that keeps ticking through silence (so it freewheels
 * through breaks and works in manual tap-tempo mode with no audio at all).
 *
 * Framework-free; allocates only at construction and inside the ~2 Hz analysis
 * pass (scratch copies), never per `update()`.
 */

/** Output snapshot merged into every {@link import('./types').AudioFrame}. */
export interface TempoState {
  /** Effective BPM, 0 until first lock (auto) / first tap (manual). */
  bpm: number;
  /** Position within the current beat, 0..1. */
  beatPhase: number;
  /** Position within the current bar (4 beats), 0..1. */
  barPhase: number;
  /** Beat index within the current bar, 0..3. */
  beatInBar: number;
  /** Completed bar count since page load. */
  barCount: number;
  /** True only on the single frame a grid beat fires. */
  gridBeat: boolean;
  /** True only on the single frame a grid downbeat (bar start) fires. */
  gridBar: boolean;
  /** Beat pulse envelope, 0..1: jumps to 1 on a grid beat, decays between. */
  gridPulse: number;
  /** Bar pulse envelope, 0..1: jumps to 1 on a downbeat, decays between. */
  barPulse: number;
  /** Detection confidence, 0..1. */
  tempoConfidence: number;
  /** Whether the grid is considered reliably locked to the music. */
  tempoLocked: boolean;
  /** Active tempo mode. */
  tempoMode: 'auto' | 'manual';
}

/** Envelope sample rate (Hz) and bin width (ms). */
const ENV_HZ = 100;
const ENV_BIN_MS = 1000 / ENV_HZ;
/** Ring-buffer length: 600 bins = 6 s of onset envelope. */
const ENV_BINS = 600;

/** Run a BPM/phase analysis at most this often. */
const ANALYSIS_INTERVAL_MS = 500;
/** Need at least this much envelope history before analysing. */
const MIN_ANALYSIS_MS = 3000;
/** Below this rolling-average level, treat input as near-silence. */
const SILENCE_LEVEL = 0.015;

/** Autocorrelation lag range (in 100 Hz bins) → 60..200 BPM. */
const LAG_MIN = 30; // 6000 / 30  = 200 BPM
const LAG_MAX = 100; // 6000 / 100 =  60 BPM

/** BPM fold target range (candidates doubled/halved into this window). */
const FOLD_LO = 70;
const FOLD_HI = 180;

/** Number of phase offsets tested per phase-alignment pass. */
const PHASE_STEPS = 24;
/** Periods of envelope summed when scoring a phase offset. */
const PHASE_LOOKBACK_PERIODS = 4;

/** Tap chain breaks if the gap exceeds this. */
const TAP_TIMEOUT_MS = 2000;
/** Tap intervals kept for the median estimate. */
const TAP_MAX_INTERVALS = 6;

/** Lock threshold on confidence (auto mode). */
const LOCK_CONFIDENCE = 0.35;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Fold a BPM by doubling/halving until it lands inside [lo, hi]. */
function foldBpm(bpm: number, lo: number, hi: number): number {
  let b = bpm;
  while (b < lo) b *= 2;
  while (b > hi) b /= 2;
  return b;
}

export class TempoTracker {
  /** Onset envelope ring buffer (100 Hz). */
  private readonly env = new Float32Array(ENV_BINS);
  /** Write head into {@link env}. */
  private envHead = 0;
  /** Total bins written (saturates conceptually; used for "have enough data"). */
  private envFilled = 0;

  /** Scratch arrays for the analysis pass (allocated once, reused). */
  private readonly scratchEnv = new Float32Array(ENV_BINS);
  private readonly scratchAc = new Float32Array(LAG_MAX + 1);

  /** Accumulator for the current (in-progress) envelope bin. */
  private binAccum = 0;
  /** Wall-clock time the current bin started. */
  private binStartMs = 0;
  private binInitialized = false;

  /** Last update() timestamp, for dt derivation. */
  private lastUpdateMs = 0;
  private updateInitialized = false;

  /** Wall-clock time of the last analysis pass. */
  private lastAnalysisMs = 0;

  /** Short rolling average of input level (silence gate). */
  private avgLevel = 0;

  // ---- Tempo estimate ----
  /** Smoothed auto-detected BPM (0 until first lock). */
  private baseBpm = 0;
  /** Manual (tap) BPM (0 until first tap chain). */
  private manualBpm = 0;
  private mode: 'auto' | 'manual' = 'auto';
  private userMultiplier = 1;
  private confidence = 0;
  /** Outlier candidate awaiting a second confirming analysis. */
  private pendingCandidate = 0;

  // ---- Live grid ----
  /** Monotonic beat counter for the page lifetime (never decreases). */
  private beatIndex = 0;
  /** Wall-clock time the next grid beat is due. */
  private nextBeatMs = 0;
  private gridInitialized = false;
  private gridPulse = 0;
  private barPulse = 0;
  /** Whether phase alignment has ever locked (drives full-snap on first lock). */
  private phaseLocked = false;

  // ---- Tap state ----
  private taps: number[] = [];

  // ---- Per-frame outputs (overwritten each update, never reallocated) ----
  private outGridBeat = false;
  private outGridBar = false;

  /** Effective BPM given mode + user multiplier (0 if no estimate yet). */
  private effectiveBpm(): number {
    const base = this.mode === 'manual' ? this.manualBpm : this.baseBpm;
    return base > 0 ? base * this.userMultiplier : 0;
  }

  /**
   * Feed one analysed frame.
   *
   * @param onset Half-wave-rectified bass-energy increase (>= 0).
   * @param level Overall loudness 0..1 (silence gate input).
   * @param nowMs Wall-clock timestamp (performance.now()).
   */
  update(onset: number, level: number, nowMs: number): void {
    // dt from successive timestamps, clamped so a stalled tab can't blow up.
    let dt = this.updateInitialized ? (nowMs - this.lastUpdateMs) / 1000 : 0;
    if (dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this.lastUpdateMs = nowMs;
    this.updateInitialized = true;

    // Rolling level average for the silence gate (~1 s time constant).
    this.avgLevel += (level - this.avgLevel) * 0.05;

    this.accumulateEnvelope(onset, nowMs);

    if (nowMs - this.lastAnalysisMs >= ANALYSIS_INTERVAL_MS) {
      this.lastAnalysisMs = nowMs;
      this.analyze(nowMs);
    }

    this.tickGrid(nowMs, dt);
  }

  /** Resample onsets into the 100 Hz envelope ring buffer. */
  private accumulateEnvelope(onset: number, nowMs: number): void {
    if (!this.binInitialized) {
      this.binStartMs = nowMs;
      this.binInitialized = true;
    }
    // Accumulate the max onset within the current 10 ms bin.
    if (onset > this.binAccum) this.binAccum = onset;

    // Close out any elapsed bins (handles multiple frames per bin and gaps).
    while (nowMs - this.binStartMs >= ENV_BIN_MS) {
      this.env[this.envHead] = this.binAccum;
      this.envHead = (this.envHead + 1) % ENV_BINS;
      if (this.envFilled < ENV_BINS) this.envFilled++;
      this.binAccum = 0;
      this.binStartMs += ENV_BIN_MS;
      // After a long stall, don't spin emitting hundreds of empty bins.
      if (nowMs - this.binStartMs > ENV_BINS * ENV_BIN_MS) {
        this.binStartMs = nowMs;
        break;
      }
    }
  }

  /** Run BPM estimation + phase alignment (called ~2 Hz). */
  private analyze(nowMs: number): void {
    const haveMs = this.envFilled * ENV_BIN_MS;
    if (haveMs < MIN_ANALYSIS_MS) return;

    // Silence gate: decay confidence instead of locking onto room noise.
    if (this.avgLevel < SILENCE_LEVEL) {
      this.confidence *= 0.95;
      return;
    }

    const n = this.envFilled;
    const buf = this.scratchEnv;
    // Copy time-ordered (oldest → newest) out of the ring buffer.
    const start = (this.envHead - n + ENV_BINS * 2) % ENV_BINS;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const v = this.env[(start + i) % ENV_BINS]!;
      buf[i] = v;
      mean += v;
    }
    mean /= n;
    for (let i = 0; i < n; i++) buf[i]! -= mean;

    // Autocorrelation across the BPM lag range, with an octave-up bonus.
    // Two passes: the bonus reads ac[2*lag], which the scoring loop would
    // otherwise see stale (from the previous analysis) or zeroed (first run).
    const ac = this.scratchAc;
    const maxLag = Math.min(LAG_MAX, n - 1);
    let acSum = 0;
    let acCount = 0;
    for (let lag = LAG_MIN; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = lag; i < n; i++) sum += buf[i]! * buf[i - lag]!;
      ac[lag] = sum;
      acSum += Math.abs(sum);
      acCount++;
    }
    let bestLag = 0;
    let bestScore = -Infinity;
    for (let lag = LAG_MIN; lag <= maxLag; lag++) {
      let score = ac[lag]!;
      const harmonic = lag * 2;
      if (harmonic <= maxLag) score += 0.5 * ac[harmonic]!;
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }

    if (bestLag === 0) {
      this.confidence *= 0.95;
      return;
    }

    // 100 Hz envelope: BPM = 6000 / lag. Fold into a sane octave.
    const candidate = foldBpm(6000 / bestLag, FOLD_LO, FOLD_HI);

    // Confidence: prominence of the chosen peak vs mean |autocorrelation|.
    const acMean = acCount > 0 ? acSum / acCount : 0;
    const prominence = acMean > 0 ? ac[bestLag]! / acMean : 0;
    const conf = clamp((prominence - 1) / 3, 0, 1);

    this.updateBaseBpm(candidate, conf);

    // Phase alignment only in auto mode: in manual mode the tap already set
    // both tempo and phase, so auto-nudging must not drift the grid.
    if (this.mode === 'auto') {
      const effBpm = this.effectiveBpm();
      if (effBpm > 0) this.alignPhase(buf, n, effBpm, nowMs);
    }
  }

  /** Smooth/jump the auto BPM estimate with hysteresis. */
  private updateBaseBpm(candidate: number, conf: number): void {
    if (this.baseBpm <= 0) {
      // First lock: take the candidate outright.
      this.baseBpm = candidate;
      this.confidence = conf;
      this.pendingCandidate = 0;
      return;
    }

    const within2pct = Math.abs(candidate - this.baseBpm) / this.baseBpm <= 0.02;
    if (within2pct) {
      // Close enough: gently lerp toward it and clear any pending jump.
      this.baseBpm += (candidate - this.baseBpm) * 0.2;
      this.pendingCandidate = 0;
    } else {
      // Outlier: require the SAME candidate twice before jumping.
      const sameAsPending =
        this.pendingCandidate > 0 &&
        Math.abs(candidate - this.pendingCandidate) / this.pendingCandidate <= 0.02;
      if (sameAsPending) {
        this.baseBpm = candidate;
        this.pendingCandidate = 0;
      } else {
        this.pendingCandidate = candidate;
      }
    }
    // Confidence tracks the latest analysis, smoothed slightly.
    this.confidence += (conf - this.confidence) * 0.5;
  }

  /**
   * Test evenly spaced phase offsets, sum envelope energy at grid positions
   * over the recent past, and nudge {@link nextBeatMs} toward the best one.
   */
  private alignPhase(buf: Float32Array, n: number, bpm: number, nowMs: number): void {
    const periodMs = 60000 / bpm;
    const periodBins = periodMs / ENV_BIN_MS;
    if (periodBins < 1) return;

    // buf[n-1] corresponds to wall time ~nowMs (newest bin).
    let bestOffset = 0;
    let bestEnergy = -Infinity;
    for (let s = 0; s < PHASE_STEPS; s++) {
      const offsetBins = (s / PHASE_STEPS) * periodBins;
      let energy = 0;
      for (let p = 0; p < PHASE_LOOKBACK_PERIODS; p++) {
        const idx = Math.round(n - 1 - offsetBins - p * periodBins);
        // Sum idx±1 too: at 60 fps onsets land in 1-2 of the 10 ms bins with
        // zero-filled gaps between frames, so a single-bin probe misses often.
        for (let j = idx - 1; j <= idx + 1; j++) {
          if (j >= 0 && j < n) energy += buf[j]!;
        }
      }
      if (energy > bestEnergy) {
        bestEnergy = energy;
        bestOffset = offsetBins;
      }
    }

    // The best grid beat near "now" sits offsetBins in the past from newest.
    const beatAtMs = nowMs - bestOffset * ENV_BIN_MS;
    // Project forward to the next beat at/after now.
    let target = beatAtMs;
    while (target < nowMs) target += periodMs;

    if (!this.gridInitialized) {
      this.nextBeatMs = target;
      this.gridInitialized = true;
      this.phaseLocked = true;
      return;
    }

    // Compare against the live grid's next beat, wrapped to nearest target.
    let diff = target - this.nextBeatMs;
    // Wrap diff into [-period/2, +period/2] so we nudge the short way.
    diff -= Math.round(diff / periodMs) * periodMs;
    if (!this.phaseLocked) {
      // First phase lock: snap fully onto the music's grid.
      this.nextBeatMs += diff;
      this.phaseLocked = true;
    } else {
      const maxNudge = periodMs * 0.12;
      this.nextBeatMs += clamp(diff, -maxNudge, maxNudge);
    }
  }

  /** Advance the live beat grid to the current time. */
  private tickGrid(nowMs: number, dt: number): void {
    this.outGridBeat = false;
    this.outGridBar = false;

    const bpm = this.effectiveBpm();

    if (bpm <= 0) {
      // No tempo yet: just decay pulses, keep grid dormant.
      this.gridPulse *= Math.exp(-dt * 4.5);
      this.barPulse *= Math.exp(-dt * 3);
      return;
    }

    const periodMs = 60000 / bpm;

    if (!this.gridInitialized) {
      this.nextBeatMs = nowMs + periodMs;
      this.gridInitialized = true;
    }

    // Re-anchor if we've fallen pathologically far behind (e.g. tab sleep).
    if (nowMs - this.nextBeatMs > periodMs * 8) {
      this.nextBeatMs = nowMs;
    }

    while (nowMs >= this.nextBeatMs) {
      this.beatIndex++;
      this.nextBeatMs += periodMs;
      this.outGridBeat = true;
      this.gridPulse = 1;
      if (this.beatIndex % 4 === 0) {
        this.outGridBar = true;
        this.barPulse = 1;
      }
    }

    this.gridPulse *= Math.exp(-dt * 4.5);
    this.barPulse *= Math.exp(-dt * 3);
  }

  // ---- Public tempo controls ----

  /** Register a tap; ≥2 taps set the manual tempo and anchor the grid. */
  tap(nowMs: number): void {
    if (this.taps.length > 0 && nowMs - this.taps[this.taps.length - 1]! > TAP_TIMEOUT_MS) {
      this.taps.length = 0;
    }
    this.taps.push(nowMs);
    if (this.taps.length > TAP_MAX_INTERVALS + 1) this.taps.shift();

    if (this.taps.length >= 2) {
      // Median of the most recent intervals → robust to one bad tap.
      const intervals: number[] = [];
      for (let i = 1; i < this.taps.length; i++) {
        intervals.push(this.taps[i]! - this.taps[i - 1]!);
      }
      const recent = intervals.slice(-TAP_MAX_INTERVALS).sort((a, b) => a - b);
      const mid = Math.floor(recent.length / 2);
      const median =
        recent.length % 2 === 1
          ? recent[mid]!
          : (recent[mid - 1]! + recent[mid]!) / 2;
      if (median > 0) {
        this.manualBpm = 60000 / median;
        this.mode = 'manual';
        this.confidence = 1;
        this.anchorGridToTap(nowMs);
      }
    }
  }

  /**
   * Anchor the grid so a beat lands exactly on the last tap, preserving
   * monotonic beatIndex (we never step the index backwards).
   */
  private anchorGridToTap(tapMs: number): void {
    const bpm = this.effectiveBpm();
    if (bpm <= 0) return;
    const periodMs = 60000 / bpm;
    // Place the next beat one period after the tap, in the future.
    let target = tapMs + periodMs;
    const now = this.lastUpdateMs || tapMs;
    while (target <= now) target += periodMs;
    this.nextBeatMs = target;
    this.gridInitialized = true;
  }

  /** Scale the user multiplier by 2 or 0.5 (clamped 0.25..4). */
  multiply(f: 2 | 0.5): void {
    this.userMultiplier = clamp(this.userMultiplier * f, 0.25, 4);
  }

  /** Return to automatic detection at 1× multiplier. */
  setAuto(): void {
    this.mode = 'auto';
    this.userMultiplier = 1;
  }

  // ---- Output ----

  /** Snapshot the current tempo/grid state into `out` (no allocation). */
  writeState(out: TempoState): void {
    const bpm = this.effectiveBpm();
    const periodMs = bpm > 0 ? 60000 / bpm : 0;

    let beatPhase = 0;
    if (bpm > 0 && this.gridInitialized && periodMs > 0) {
      const now = this.lastUpdateMs;
      beatPhase = clamp(1 - (this.nextBeatMs - now) / periodMs, 0, 1);
    }

    const beatInBar = ((this.beatIndex % 4) + 4) % 4;

    out.bpm = bpm;
    out.beatPhase = beatPhase;
    out.barPhase = (beatInBar + beatPhase) / 4;
    out.beatInBar = beatInBar;
    out.barCount = Math.floor(this.beatIndex / 4);
    out.gridBeat = this.outGridBeat;
    out.gridBar = this.outGridBar;
    out.gridPulse = this.gridPulse;
    out.barPulse = this.barPulse;
    out.tempoConfidence = clamp(this.confidence, 0, 1);
    out.tempoLocked =
      bpm > 0 && (this.mode === 'manual' || this.confidence > LOCK_CONFIDENCE);
    out.tempoMode = this.mode;
  }
}
