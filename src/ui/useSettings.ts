import { useCallback, useEffect, useRef, useState } from 'react';

export type HueMode = 'cycle' | 'fixed';
export type Background = 'black' | 'transparent';
export type CycleMode = 'seconds' | 'bars';

export interface Settings {
  sceneId: string;
  /** Audio gain multiplier, 0.5..4. */
  gain: number;
  hueMode: HueMode;
  /** Fixed hue 0..360 (used when hueMode === 'fixed'). */
  fixedHue: number;
  background: Background;
  autoCycle: boolean;
  /** Seconds between scene changes when auto-cycling. */
  cycleSeconds: number;
  /** Whether auto-cycle advances by seconds or by musical bars. */
  cycleMode: CycleMode;
  /** Bars between scene changes when cycleMode === 'bars' (1..256). */
  cycleBars: number;
  /** Auto-reroll the look-gacha every {@link gachaBars} bars. */
  autoGacha: boolean;
  /** Bars between automatic look rerolls (1..512). */
  gachaBars: number;
  /** Selected audio input device id, or '' for default. */
  deviceId: string;
  /** "Look gacha" seed: drives the deterministic visual variation. */
  seed: string;
}

const STORAGE_KEY = 'vj-overlay-settings';

/** Maximum length a seed string is kept to (sanitized). */
const SEED_MAX_LEN = 64;

const DEFAULT_SETTINGS: Settings = {
  sceneId: 'bars',
  gain: 1.5,
  hueMode: 'cycle',
  fixedHue: 200,
  background: 'black',
  autoCycle: false,
  cycleSeconds: 30,
  cycleMode: 'seconds',
  cycleBars: 16,
  autoGacha: false,
  gachaBars: 32,
  deviceId: '',
  seed: 'neon-prism-001',
};

/** Trim, cap length, and fall back to the default for empty/invalid seeds. */
function sanitizeSeed(v: unknown): string {
  if (typeof v !== 'string') return DEFAULT_SETTINGS.seed;
  const trimmed = v.trim().slice(0, SEED_MAX_LEN);
  return trimmed.length > 0 ? trimmed : DEFAULT_SETTINGS.seed;
}

function clampNum(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/** Like {@link clampNum} but rounds to an integer. */
function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
}

function loadStored(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Partial<Settings>;
  } catch {
    // Ignore malformed storage.
  }
  return {};
}

/** Result of reading URL params: setting overrides plus the `ui=hide` flag. */
interface UrlConfig {
  overrides: Partial<Settings>;
  uiHidden: boolean;
}

function readUrl(): UrlConfig {
  const overrides: Partial<Settings> = {};
  let uiHidden = false;
  try {
    const p = new URLSearchParams(window.location.search);

    const scene = p.get('scene');
    if (scene) overrides.sceneId = scene;

    const bg = p.get('bg');
    if (bg === 'transparent' || bg === 'black') overrides.background = bg;

    const gain = p.get('gain');
    if (gain != null) overrides.gain = clampNum(parseFloat(gain), 0.5, 4, 1.5);

    const cycle = p.get('cycle');
    if (cycle != null)
      overrides.cycleSeconds = clampNum(parseFloat(cycle), 2, 600, 30);

    const hue = p.get('hue');
    if (hue != null) {
      overrides.hueMode = 'fixed';
      overrides.fixedHue = clampNum(parseFloat(hue), 0, 360, 200);
    }

    const autocycle = p.get('autocycle');
    if (autocycle != null) overrides.autoCycle = autocycle === '1' || autocycle === 'true';

    const cyclemode = p.get('cyclemode');
    if (cyclemode === 'bars' || cyclemode === 'seconds') overrides.cycleMode = cyclemode;

    const cyclebars = p.get('cyclebars');
    if (cyclebars != null) overrides.cycleBars = clampInt(parseFloat(cyclebars), 1, 256, 16);

    const autogacha = p.get('autogacha');
    if (autogacha != null) overrides.autoGacha = autogacha === '1' || autogacha === 'true';

    const gachabars = p.get('gachabars');
    if (gachabars != null) overrides.gachaBars = clampInt(parseFloat(gachabars), 1, 512, 32);

    const device = p.get('device');
    if (device) overrides.deviceId = device;

    const seed = p.get('seed');
    if (seed) overrides.seed = sanitizeSeed(seed);

    uiHidden = p.get('ui') === 'hide';
  } catch {
    // Ignore malformed URL.
  }
  return { overrides, uiHidden };
}

function sanitize(s: Settings): Settings {
  return {
    sceneId: typeof s.sceneId === 'string' && s.sceneId ? s.sceneId : DEFAULT_SETTINGS.sceneId,
    gain: clampNum(s.gain, 0.5, 4, DEFAULT_SETTINGS.gain),
    hueMode: s.hueMode === 'fixed' ? 'fixed' : 'cycle',
    fixedHue: clampNum(s.fixedHue, 0, 360, DEFAULT_SETTINGS.fixedHue),
    background: s.background === 'transparent' ? 'transparent' : 'black',
    autoCycle: Boolean(s.autoCycle),
    cycleSeconds: clampNum(s.cycleSeconds, 2, 600, DEFAULT_SETTINGS.cycleSeconds),
    cycleMode: s.cycleMode === 'bars' ? 'bars' : 'seconds',
    cycleBars: clampInt(s.cycleBars, 1, 256, DEFAULT_SETTINGS.cycleBars),
    autoGacha: Boolean(s.autoGacha),
    gachaBars: clampInt(s.gachaBars, 1, 512, DEFAULT_SETTINGS.gachaBars),
    deviceId: typeof s.deviceId === 'string' ? s.deviceId : '',
    seed: sanitizeSeed(s.seed),
  };
}

export interface UseSettingsResult {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Whether the URL requested the UI start hidden (ui=hide). */
  initialUiHidden: boolean;
}

/**
 * Settings state with localStorage persistence and URL-param overrides.
 * Precedence: defaults < localStorage < URL params.
 */
export function useSettings(): UseSettingsResult {
  const urlRef = useRef<UrlConfig | null>(null);
  if (urlRef.current === null) urlRef.current = readUrl();
  const url = urlRef.current;

  const [settings, setSettings] = useState<Settings>(() =>
    sanitize({ ...DEFAULT_SETTINGS, ...loadStored(), ...url.overrides }),
  );

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage may be unavailable (private mode); non-fatal.
    }
  }, [settings]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => sanitize({ ...prev, ...patch }));
  }, []);

  return { settings, update, initialUiHidden: url.uiHidden };
}
