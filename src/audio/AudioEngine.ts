import type { AudioFrame } from './types';
import { TempoTracker, type TempoState } from './TempoTracker';

const FFT_SIZE = 2048;
const BIN_COUNT = FFT_SIZE / 2;
const SMOOTHING = 0.75;

/** Rolling history length for the beat detector (~43 frames ≈ 0.7 s at 60 fps). */
const BEAT_HISTORY = 43;
/** Energy must exceed this multiple of the running average to count as a beat. */
const BEAT_THRESHOLD = 1.35;
/** Absolute floor so silence/noise never triggers beats. */
const BEAT_FLOOR = 0.02;
/** Minimum gap between beats, in milliseconds. */
const BEAT_REFRACTORY_MS = 150;
/** Per-frame multiplicative decay of the beat envelope. */
const BEAT_DECAY = 0.92;

/** Frequency band edges in Hz. */
const BASS_RANGE: [number, number] = [20, 250];
const MID_RANGE: [number, number] = [250, 2000];
const TREBLE_RANGE: [number, number] = [2000, 16000];

/**
 * Cache window for {@link AudioEngine.getFrame}. Within this many ms of the
 * last compute, the cached frame is returned instead of recomputing — so the
 * 60 fps Renderer is the effective single writer of smoothing/tempo state and
 * the ControlPanel's lower-rate polling can't double-run it.
 */
const FRAME_CACHE_MS = 5;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Framework-free audio capture + analysis.
 *
 * Captures a microphone / line-in / loopback device and exposes a per-frame
 * {@link AudioFrame} via {@link getFrame}. Never connects to the audio
 * destination, so it produces no feedback.
 */
export class AudioEngine {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;

  private readonly freq: Uint8Array<ArrayBuffer> = new Uint8Array(BIN_COUNT);
  private readonly wave: Uint8Array<ArrayBuffer> = new Uint8Array(FFT_SIZE);

  /** Bin index ranges for each band, computed once the context exists. */
  private bassBins: [number, number] = [0, 0];
  private midBins: [number, number] = [0, 0];
  private trebleBins: [number, number] = [0, 0];

  /** Smoothed band/level values for visual stability. */
  private smoothLevel = 0;
  private smoothBass = 0;
  private smoothMid = 0;
  private smoothTreble = 0;

  private bassHistory: number[] = [];
  private beatIntensity = 0;
  private lastBeatTime = 0;

  /** Previous raw bass energy, for the tempo onset (half-wave rectified diff). */
  private prevRawBass = 0;

  /** Tempo detection + freewheeling beat grid (single instance, fed each frame). */
  private readonly tempo = new TempoTracker();
  /** Reusable scratch for the tracker's per-frame output (no allocation). */
  private readonly tempoState: TempoState = {
    bpm: 0,
    beatPhase: 0,
    barPhase: 0,
    beatInBar: 0,
    barCount: 0,
    gridBeat: false,
    gridBar: false,
    gridPulse: 0,
    barPulse: 0,
    tempoConfidence: 0,
    tempoLocked: false,
    tempoMode: 'auto',
  };

  /** Cached frame returned by {@link getFrame}/{@link peekFrame}. */
  private readonly frame: AudioFrame = AudioEngine.makeSilentFrame(this.freq, this.wave);
  /** Wall-clock time of the last actual compute (cache invalidation). */
  private lastComputeMs = -Infinity;
  /** Whether {@link frame} has ever been computed (vs. the initial silent state). */
  private frameValid = false;

  private _running = false;
  private _error: string | null = null;

  get running(): boolean {
    return this._running;
  }

  get error(): string | null {
    return this._error;
  }

  /**
   * Begin capturing from the given device (or the default input).
   * Resolves once analysis is live; sets {@link error} and returns false on failure.
   */
  async start(deviceId?: string): Promise<boolean> {
    this._error = null;
    if (this._running) this.stop();

    if (!navigator.mediaDevices?.getUserMedia) {
      this._error = 'This browser does not support audio capture.';
      return false;
    }

    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      const audioCtx = new AudioContext();
      // A user gesture is usually required; resume just in case it starts suspended.
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      // Intentionally NOT connected to audioCtx.destination — no feedback.

      this.stream = stream;
      this.audioCtx = audioCtx;
      this.analyser = analyser;
      this.source = source;

      this.computeBandBins(audioCtx.sampleRate);
      this.resetAnalysis();
      this._running = true;
      return true;
    } catch (err) {
      this._error = this.describeError(err);
      this.stop();
      return false;
    }
  }

  /** Enumerate available audio-input devices (labels require granted permission). */
  async listDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  /** Stop capture, release the microphone track, and close the context. */
  stop(): void {
    this._running = false;
    this.source?.disconnect();
    this.source = null;
    this.analyser = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
  }

  /**
   * Produce the analysis frame for the current render tick.
   *
   * Cached: if called again within {@link FRAME_CACHE_MS} of the last compute,
   * returns the cached frame untouched so the smoothing / beat / tempo state is
   * advanced exactly once per render tick (the 60 fps Renderer is the effective
   * single writer). Returns a silent frame when not running so scenes can render
   * an idle state — but the tempo grid still ticks so it freewheels.
   */
  getFrame(gain: number): AudioFrame {
    const now = performance.now();
    if (this.frameValid && now - this.lastComputeMs < FRAME_CACHE_MS) {
      return this.frame;
    }
    this.lastComputeMs = now;
    this.frameValid = true;

    const f = this.frame;

    if (!this._running || !this.analyser) {
      this.freq.fill(0);
      this.wave.fill(128);
      this.smoothLevel = 0;
      this.smoothBass = 0;
      this.smoothMid = 0;
      this.smoothTreble = 0;
      this.beatIntensity = 0;
      this.prevRawBass = 0;
      f.level = 0;
      f.bass = 0;
      f.mid = 0;
      f.treble = 0;
      f.beat = false;
      f.beatIntensity = 0;
      f.running = false;
      // Silence still ticks the grid: keeps the beat freewheeling through
      // breaks and lets manual tap-tempo run with audio stopped.
      this.tempo.update(0, 0, now);
      this.mergeTempo(f);
      return f;
    }

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.wave);

    // RMS over the time-domain signal (128 = silence) → 0..1.
    let sumSq = 0;
    for (let i = 0; i < this.wave.length; i++) {
      const s = (this.wave[i] - 128) / 128;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / this.wave.length);

    const rawBass = this.bandAverage(this.bassBins);
    const rawMid = this.bandAverage(this.midBins);
    const rawTreble = this.bandAverage(this.trebleBins);

    // Temporal smoothing for visually stable output.
    this.smoothLevel += (rms - this.smoothLevel) * 0.3;
    this.smoothBass += (rawBass - this.smoothBass) * 0.4;
    this.smoothMid += (rawMid - this.smoothMid) * 0.4;
    this.smoothTreble += (rawTreble - this.smoothTreble) * 0.4;

    f.level = clamp01(this.smoothLevel * gain);
    f.bass = clamp01(this.smoothBass * gain);
    f.mid = clamp01(this.smoothMid * gain);
    f.treble = clamp01(this.smoothTreble * gain);
    f.beat = this.detectBeat(rawBass);
    f.beatIntensity = this.beatIntensity;
    f.running = true;

    // Onset = half-wave-rectified bass-energy increase (raw, pre-gain/smooth).
    const onset = Math.max(0, rawBass - this.prevRawBass);
    this.prevRawBass = rawBass;
    this.tempo.update(onset, rms, now);
    this.mergeTempo(f);

    return f;
  }

  /**
   * Return the most recent frame without computing a new one. Returns the
   * silent frame if nothing has been computed yet. Used by the UI/App polling
   * so only the Renderer drives the analysis state.
   */
  peekFrame(): AudioFrame {
    return this.frame;
  }

  /** Build a fresh silent frame, sharing the engine's freq/wave buffers. */
  private static makeSilentFrame(
    freq: Uint8Array<ArrayBuffer>,
    wave: Uint8Array<ArrayBuffer>,
  ): AudioFrame {
    return {
      freq,
      wave,
      level: 0,
      bass: 0,
      mid: 0,
      treble: 0,
      beat: false,
      beatIntensity: 0,
      running: false,
      bpm: 0,
      beatPhase: 0,
      barPhase: 0,
      beatInBar: 0,
      barCount: 0,
      gridBeat: false,
      gridBar: false,
      gridPulse: 0,
      barPulse: 0,
      tempoConfidence: 0,
      tempoLocked: false,
      tempoMode: 'auto',
    };
  }

  /** Copy the tracker's latest output into the frame (no allocation). */
  private mergeTempo(f: AudioFrame): void {
    const s = this.tempoState;
    this.tempo.writeState(s);
    f.bpm = s.bpm;
    f.beatPhase = s.beatPhase;
    f.barPhase = s.barPhase;
    f.beatInBar = s.beatInBar;
    f.barCount = s.barCount;
    f.gridBeat = s.gridBeat;
    f.gridBar = s.gridBar;
    f.gridPulse = s.gridPulse;
    f.barPulse = s.barPulse;
    f.tempoConfidence = s.tempoConfidence;
    f.tempoLocked = s.tempoLocked;
    f.tempoMode = s.tempoMode;
  }

  /** Register a tap-tempo press (delegates to the tracker). */
  tapTempo(): void {
    this.tempo.tap(performance.now());
  }

  /** Multiply the tempo grid by 2 or 0.5 (delegates to the tracker). */
  tempoMultiply(f: 2 | 0.5): void {
    this.tempo.multiply(f);
  }

  /** Return tempo handling to automatic detection (delegates to the tracker). */
  tempoAuto(): void {
    this.tempo.setAuto();
  }

  /** Average of normalised (0..1) frequency magnitudes across a bin range. */
  private bandAverage([lo, hi]: [number, number]): number {
    let sum = 0;
    let count = 0;
    for (let i = lo; i < hi; i++) {
      sum += this.freq[i] / 255;
      count++;
    }
    return count > 0 ? sum / count : 0;
  }

  /**
   * Energy-history beat detector keyed off raw bass energy.
   * Decays the envelope every frame and triggers when a refractory period has
   * elapsed and energy exceeds the threshold relative to recent history.
   */
  private detectBeat(rawBass: number): boolean {
    this.beatIntensity *= BEAT_DECAY;

    const history = this.bassHistory;
    const avg =
      history.length > 0
        ? history.reduce((a, b) => a + b, 0) / history.length
        : 0;

    history.push(rawBass);
    if (history.length > BEAT_HISTORY) history.shift();

    const now = performance.now();
    const elapsed = now - this.lastBeatTime;

    let beat = false;
    if (
      elapsed >= BEAT_REFRACTORY_MS &&
      rawBass > BEAT_FLOOR &&
      avg > 0 &&
      rawBass > avg * BEAT_THRESHOLD
    ) {
      beat = true;
      this.lastBeatTime = now;
      const ratio = rawBass / (avg || rawBass);
      // Map the over-threshold ratio into a punchy 0..1 envelope value.
      this.beatIntensity = Math.min(1, (ratio - 1) * 1.2 + 0.4);
    }

    return beat;
  }

  /** Translate a Hz value into the matching FFT bin index. */
  private hzToBin(hz: number, sampleRate: number): number {
    const nyquist = sampleRate / 2;
    const bin = Math.round((hz / nyquist) * BIN_COUNT);
    return Math.max(0, Math.min(BIN_COUNT, bin));
  }

  private computeBandBins(sampleRate: number): void {
    this.bassBins = [
      this.hzToBin(BASS_RANGE[0], sampleRate),
      this.hzToBin(BASS_RANGE[1], sampleRate),
    ];
    this.midBins = [
      this.hzToBin(MID_RANGE[0], sampleRate),
      this.hzToBin(MID_RANGE[1], sampleRate),
    ];
    this.trebleBins = [
      this.hzToBin(TREBLE_RANGE[0], sampleRate),
      this.hzToBin(TREBLE_RANGE[1], sampleRate),
    ];
  }

  private resetAnalysis(): void {
    this.smoothLevel = 0;
    this.smoothBass = 0;
    this.smoothMid = 0;
    this.smoothTreble = 0;
    this.bassHistory = [];
    this.beatIntensity = 0;
    this.lastBeatTime = 0;
    this.prevRawBass = 0;
    // Intentionally NOT resetting the TempoTracker: the grid should keep
    // freewheeling (and any manual tap tempo persist) across start/stop.
  }

  private describeError(err: unknown): string {
    if (err instanceof DOMException) {
      switch (err.name) {
        case 'NotAllowedError':
        case 'SecurityError':
          return 'Microphone permission was denied. Allow audio access and try again.';
        case 'NotFoundError':
          return 'No audio input device was found.';
        case 'NotReadableError':
          return 'The selected audio device could not be opened (in use by another app?).';
        case 'OverconstrainedError':
          return 'The selected audio device is unavailable. Pick a different one.';
        default:
          return `Audio capture failed: ${err.name}.`;
      }
    }
    return 'Audio capture failed for an unknown reason.';
  }
}
