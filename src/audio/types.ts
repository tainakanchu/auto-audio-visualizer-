/** A single snapshot of analysed audio, produced once per render frame. */
export interface AudioFrame {
  /** Frequency-bin magnitudes, 0..255. */
  freq: Uint8Array<ArrayBuffer>;
  /** Time-domain samples, 0..255 (128 = silence). */
  wave: Uint8Array<ArrayBuffer>;
  /** Smoothed overall loudness, 0..1 (RMS * gain, clamped). */
  level: number;
  /**
   * Pre-gain smoothed RMS, 0..1 (same smoothing as {@link level} but before
   * the gain multiply / clamp). Meant for calibration UI — unaffected by the
   * gain slider so it reflects the actual input signal.
   */
  levelRaw: number;
  /**
   * Pre-gain sample peak for the current analysis window, 0..1
   * (`max(|sample|)`, not smoothed). Used for dBFS metering and clip
   * detection, which need the true instantaneous peak rather than an
   * averaged/gained value.
   */
  peak: number;
  /** Low-band energy, 0..1 (* gain, clamped). */
  bass: number;
  /** Mid-band energy, 0..1 (* gain, clamped). */
  mid: number;
  /** High-band energy, 0..1 (* gain, clamped). */
  treble: number;
  /** True only on the single frame a beat is detected. */
  beat: boolean;
  /** Beat envelope, 0..1, jumps on a beat then decays exponentially. */
  beatIntensity: number;
  /** Whether the engine is actively analysing live audio. */
  running: boolean;

  // ---- Tempo grid (BPM detection / tap tempo) ----
  /** Effective BPM, 0 until first lock (auto) / first tap (manual). */
  bpm: number;
  /** Position within the current beat, 0..1. */
  beatPhase: number;
  /** Position within the current bar (4 beats), 0..1. */
  barPhase: number;
  /** Beat index within the current bar, 0..3. */
  beatInBar: number;
  /** Completed bar count since page load (monotonic). */
  barCount: number;
  /** True only on the single frame a tempo-grid beat fires. */
  gridBeat: boolean;
  /** True only on the single frame a tempo-grid downbeat (bar start) fires. */
  gridBar: boolean;
  /** Beat pulse envelope, 0..1: jumps to 1 on a grid beat, decays between. */
  gridPulse: number;
  /** Bar pulse envelope, 0..1: jumps to 1 on a grid downbeat, decays between. */
  barPulse: number;
  /** Tempo-detection confidence, 0..1. */
  tempoConfidence: number;
  /** Whether the grid is reliably locked to the music. */
  tempoLocked: boolean;
  /** Active tempo mode ('auto' detection, 'manual' tap, or 'link' Pro DJ Link beats). */
  tempoMode: TempoMode;
}

/** Tempo source: audio detection, tap tempo, or external (Pro DJ Link) beats. */
export type TempoMode = 'auto' | 'manual' | 'link';
