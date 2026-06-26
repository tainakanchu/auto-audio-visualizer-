import { useEffect, useRef, useState } from 'react';
import type { AudioEngine } from '../audio/AudioEngine';
import { scenes } from '../scenes';
import type { Settings } from './useSettings';

interface ControlPanelProps {
  hidden: boolean;
  faded: boolean;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Whether WebGL2 is usable; GL scenes are disabled in the picker when false. */
  glAvailable: boolean;
  running: boolean;
  error: string | null;
  devices: MediaDeviceInfo[];
  engine: AudioEngine | null;
  onToggleAudio: () => void;
  onRefreshDevices: () => void;
  /** Select an input device; live capture is restarted on it automatically. */
  onSelectDevice: (deviceId: string) => void;
  onSetScene: (id: string) => void;
  onShiftScene: (delta: number) => void;
  onToggleFullscreen: () => void;
  /** Reroll the look-gacha seed to a fresh random value. */
  onReroll: () => void;
  /** Tap tempo (manual BPM). */
  onTap: () => void;
  /** Multiply the tempo grid by 2 or 0.5. */
  onTempoMultiply: (f: 2 | 0.5) => void;
  /** Return tempo handling to automatic detection. */
  onTempoAuto: () => void;
}

/** Polling rate for the level meter / beat dot / tempo readout (Hz). */
const METER_HZ = 30;

type TempoStatus = 'tap' | 'lock' | 'search';

/** Coarse UI snapshot refreshed by the meter interval (one React state). */
interface MeterState {
  level: number;
  beat: boolean;
  bpm: number;
  beatInBar: number;
  status: TempoStatus;
}

const INITIAL_METER: MeterState = {
  level: 0,
  beat: false,
  bpm: 0,
  beatInBar: 0,
  status: 'search',
};

export function ControlPanel(props: ControlPanelProps): React.ReactElement {
  const {
    hidden,
    faded,
    settings,
    update,
    glAvailable,
    running,
    error,
    devices,
    engine,
    onToggleAudio,
    onRefreshDevices,
    onSelectDevice,
    onSetScene,
    onShiftScene,
    onToggleFullscreen,
    onReroll,
    onTap,
    onTempoMultiply,
    onTempoAuto,
  } = props;

  const [meter, setMeter] = useState<MeterState>(INITIAL_METER);
  // Used to retrigger the beat-dot flash even on back-to-back beats.
  const beatClearRef = useRef(0);

  // Local seed draft so we apply on Enter/blur, not on every keystroke.
  const [seedDraft, setSeedDraft] = useState(settings.seed);
  // Keep the draft in sync when the seed changes externally (e.g. R / 🎲).
  useEffect(() => {
    setSeedDraft(settings.seed);
  }, [settings.seed]);

  const commitSeed = (): void => {
    const next = seedDraft.trim();
    if (next && next !== settings.seed) {
      update({ seed: next });
    } else {
      // Reset draft to the canonical (sanitized) value if unchanged/empty.
      setSeedDraft(settings.seed);
    }
  };

  // Drive the meters + tempo readout from a single low-rate interval reading
  // the engine's cached frame (peekFrame — never recomputes), NOT a per-frame
  // React render. The Renderer is the sole writer of the analysis state.
  useEffect(() => {
    if (!engine) return;
    // Beat-dot flash latch, decoupled from the polling tick so brief grid
    // beats still register.
    let beatLatched = false;
    const id = window.setInterval(() => {
      const f = engine.peekFrame();
      const fired =
        (f.tempoLocked ? f.gridBeat : f.beat) || f.beatIntensity > 0.35;
      if (fired && !beatLatched) {
        beatLatched = true;
        window.clearTimeout(beatClearRef.current);
        beatClearRef.current = window.setTimeout(() => {
          beatLatched = false;
        }, 110);
      }
      const status: TempoStatus =
        f.tempoMode === 'manual' ? 'tap' : f.tempoLocked ? 'lock' : 'search';
      setMeter((prev) => {
        const next: MeterState = {
          level: f.level,
          beat: beatLatched,
          bpm: f.bpm,
          beatInBar: f.beatInBar,
          status,
        };
        // Avoid a re-render when nothing visible changed.
        if (
          prev.beat === next.beat &&
          prev.beatInBar === next.beatInBar &&
          prev.status === next.status &&
          Math.abs(prev.level - next.level) < 0.005 &&
          Math.abs(prev.bpm - next.bpm) < 0.05
        ) {
          return prev;
        }
        return next;
      });
    }, 1000 / METER_HZ);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(beatClearRef.current);
    };
  }, [engine]);

  const className = `panel${hidden ? ' hidden' : ''}${faded ? ' faded' : ''}`;

  return (
    <div className={className}>
      <div className="panel-header">
        <span className="panel-title">VJ OVERLAY</span>
        <span className="panel-sub">{running ? 'live' : 'idle'}</span>
      </div>

      {error && <div className="error">{error}</div>}

      <button
        type="button"
        className={`btn primary${running ? ' stop' : ''}`}
        style={{ width: '100%' }}
        onClick={onToggleAudio}
      >
        {running ? '■ Stop audio' : '▶ Click to start audio'}
      </button>

      <div className="meters">
        <div className="level-track">
          <div
            className="level-fill"
            style={{ transform: `scaleX(${Math.min(1, meter.level)})` }}
          />
        </div>
        <div className={`beat-dot${meter.beat ? ' on' : ''}`} aria-label="beat" />
      </div>

      <div className="row tempo">
        <div className="row-label">
          <span>Tempo</span>
        </div>
        <div className="tempo-readout">
          <span className="bpm-value">
            {meter.bpm > 0 ? meter.bpm.toFixed(1) : '—'}
            <span className="bpm-unit">BPM</span>
          </span>
          <span className={`tempo-chip ${meter.status}`}>
            {meter.status === 'tap'
              ? 'TAP'
              : meter.status === 'lock'
                ? 'LOCK'
                : 'SEARCH…'}
          </span>
        </div>
        <div className="beat-dots" aria-label="beat position">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={`beat-pip${i === 0 ? ' downbeat' : ''}${
                meter.bpm > 0 && meter.beatInBar === i ? ' active' : ''
              }`}
            />
          ))}
        </div>
        <div className="btn-row tempo-buttons">
          <button
            type="button"
            className="btn tap"
            onClick={onTap}
            title="Tap tempo (T)"
          >
            TAP
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => onTempoMultiply(2)}
            title="Double tempo"
          >
            ×2
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => onTempoMultiply(0.5)}
            title="Halve tempo"
          >
            ÷2
          </button>
          <button
            type="button"
            className="btn"
            onClick={onTempoAuto}
            title="Auto-detect tempo"
          >
            AUTO
          </button>
        </div>
      </div>

      <div className="row look">
        <div className="row-label">
          <span>Look</span>
          <span className="row-value seed-value">{settings.seed}</span>
        </div>
        <div className="btn-row tight">
          <input
            type="text"
            className="seed-input"
            value={seedDraft}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            maxLength={64}
            placeholder="seed"
            aria-label="Look seed"
            onChange={(e) => setSeedDraft(e.target.value)}
            onBlur={commitSeed}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitSeed();
                e.currentTarget.blur();
              }
            }}
          />
          <button
            type="button"
            className="btn gacha"
            onClick={onReroll}
            aria-label="Reroll look (gacha)"
            title="Reroll look (R)"
          >
            🎲
          </button>
        </div>
      </div>

      <div className="row">
        <div className="row-label">
          <span>Input device</span>
        </div>
        <select
          value={settings.deviceId}
          onChange={(e) => onSelectDevice(e.target.value)}
          onFocus={onRefreshDevices}
        >
          <option value="">System default</option>
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Audio input ${i + 1}`}
            </option>
          ))}
        </select>
      </div>

      <div className="row">
        <div className="row-label">
          <span>Scene</span>
          <span className="row-value">
            {scenes.findIndex((s) => s.id === settings.sceneId) + 1}/{scenes.length}
          </span>
        </div>
        <div className="btn-row tight">
          <button
            type="button"
            className="btn icon"
            onClick={() => onShiftScene(-1)}
            aria-label="Previous scene"
          >
            ‹
          </button>
          <select
            value={settings.sceneId}
            onChange={(e) => onSetScene(e.target.value)}
          >
            {scenes.map((s) => {
              const disabled = s.kind === 'gl' && !glAvailable;
              return (
                <option key={s.id} value={s.id} disabled={disabled}>
                  {s.name}
                  {disabled ? '（WebGL2なし）' : ''}
                </option>
              );
            })}
          </select>
          <button
            type="button"
            className="btn icon"
            onClick={() => onShiftScene(1)}
            aria-label="Next scene"
          >
            ›
          </button>
        </div>
      </div>

      <div className="row">
        <div className="row-label">
          <span>Gain</span>
          <span className="row-value">{settings.gain.toFixed(2)}×</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={4}
          step={0.05}
          value={settings.gain}
          onChange={(e) => update({ gain: Number(e.target.value) })}
        />
      </div>

      <div className="row">
        <div className="row-label">
          <span>Hue</span>
          <span className="row-value">
            {settings.hueMode === 'fixed' ? `${Math.round(settings.fixedHue)}°` : 'cycle'}
          </span>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className={`btn toggle${settings.hueMode === 'cycle' ? ' on' : ''}`}
            onClick={() => update({ hueMode: 'cycle' })}
          >
            Cycle
          </button>
          <button
            type="button"
            className={`btn toggle${settings.hueMode === 'fixed' ? ' on' : ''}`}
            onClick={() => update({ hueMode: 'fixed' })}
          >
            Fixed
          </button>
        </div>
        {settings.hueMode === 'fixed' && (
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={settings.fixedHue}
            onChange={(e) => update({ fixedHue: Number(e.target.value) })}
            style={{ marginTop: 8 }}
          />
        )}
      </div>

      <div className="row">
        <div className="row-label">
          <span>Background</span>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className={`btn toggle${settings.background === 'black' ? ' on' : ''}`}
            onClick={() => update({ background: 'black' })}
          >
            Black
          </button>
          <button
            type="button"
            className={`btn toggle${settings.background === 'transparent' ? ' on' : ''}`}
            onClick={() => update({ background: 'transparent' })}
          >
            Transparent
          </button>
        </div>
      </div>

      <div className="row">
        <div className="row-label">
          <span>Auto-cycle</span>
          <span className="row-value">
            {settings.cycleMode === 'bars'
              ? `${settings.cycleBars} bars`
              : `${settings.cycleSeconds}s`}
          </span>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className={`btn toggle${settings.autoCycle ? ' on' : ''}`}
            onClick={() => update({ autoCycle: !settings.autoCycle })}
          >
            {settings.autoCycle ? 'On' : 'Off'}
          </button>
          {settings.cycleMode === 'bars' ? (
            <input
              type="number"
              min={1}
              max={256}
              step={1}
              value={settings.cycleBars}
              onChange={(e) => update({ cycleBars: Number(e.target.value) })}
              aria-label="Cycle bars"
            />
          ) : (
            <input
              type="number"
              min={2}
              max={600}
              step={1}
              value={settings.cycleSeconds}
              onChange={(e) => update({ cycleSeconds: Number(e.target.value) })}
              aria-label="Cycle seconds"
            />
          )}
        </div>
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button
            type="button"
            className={`btn toggle${settings.cycleMode === 'seconds' ? ' on' : ''}`}
            onClick={() => update({ cycleMode: 'seconds' })}
          >
            Sec
          </button>
          <button
            type="button"
            className={`btn toggle${settings.cycleMode === 'bars' ? ' on' : ''}`}
            onClick={() => update({ cycleMode: 'bars' })}
          >
            Bars
          </button>
        </div>
      </div>

      <div className="row">
        <div className="row-label">
          <span>🎲 Auto-gacha</span>
          <span className="row-value">every {settings.gachaBars} bars</span>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className={`btn toggle${settings.autoGacha ? ' on' : ''}`}
            onClick={() => update({ autoGacha: !settings.autoGacha })}
          >
            {settings.autoGacha ? 'On' : 'Off'}
          </button>
          <input
            type="number"
            min={1}
            max={512}
            step={1}
            value={settings.gachaBars}
            onChange={(e) => update({ gachaBars: Number(e.target.value) })}
            aria-label="Gacha bars"
          />
        </div>
      </div>

      <div className="row">
        <button type="button" className="btn" style={{ width: '100%' }} onClick={onToggleFullscreen}>
          ⛶ Fullscreen
        </button>
      </div>

      <div className="cheats">
        <kbd>1</kbd>–<kbd>9</kbd>,<kbd>0</kbd> scene · <kbd>←</kbd>
        <kbd>→</kbd> prev/next · <kbd>H</kbd> panel · <kbd>F</kbd> fullscreen ·{' '}
        <kbd>A</kbd> auto-cycle · <kbd>B</kbd> background · <kbd>R</kbd> reroll ·{' '}
        <kbd>T</kbd> tap
      </div>
    </div>
  );
}
