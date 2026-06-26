import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioEngine } from './audio/AudioEngine';
import { Renderer } from './render/Renderer';
import { scenes, sceneByIndex, sceneIndexById } from './scenes';
import { ControlPanel } from './ui/ControlPanel';
import { useSettings } from './ui/useSettings';
import type { Settings } from './ui/useSettings';
import { generateVariation, randomSeed } from './variation/generate';

/** Milliseconds of mouse inactivity before the panel + cursor fade out. */
const IDLE_TIMEOUT_MS = 3000;

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // Fullscreen may be blocked; ignore.
  }
}

export function App(): React.ReactElement {
  const { settings, update, initialUiHidden } = useSettings();

  // Deterministic visual variation derived from the seed; recomputed only when
  // the seed string changes.
  const variation = useMemo(() => generateVariation(settings.seed), [settings.seed]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<AudioEngine | null>(null);
  const rendererRef = useRef<Renderer | null>(null);

  // Whether WebGL2 is usable; gates the GL scenes in the UI.
  const [glAvailable, setGlAvailable] = useState(true);

  // Latest settings, readable from the rAF/engine callbacks without re-binding.
  const settingsRef = useRef<Settings>(settings);
  settingsRef.current = settings;

  // Latest variation, readable at Renderer-construction time.
  const variationRef = useRef(variation);
  variationRef.current = variation;

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  // Panel lock-hidden (H key / ui=hide) vs. transient idle fade.
  const [panelHidden, setPanelHidden] = useState(initialUiHidden);
  const [idle, setIdle] = useState(false);

  // ---- Engine + Renderer lifecycle (once) ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const glCanvas = glCanvasRef.current;
    if (!canvas || !glCanvas) return;

    const engine = new AudioEngine();
    const renderer = new Renderer({
      canvas,
      glCanvas,
      engine,
      getGain: () => settingsRef.current.gain,
      getFixedHue: () =>
        settingsRef.current.hueMode === 'fixed' ? settingsRef.current.fixedHue : null,
      variation: variationRef.current,
    });
    renderer.setScenes(scenes);
    renderer.setScene(settingsRef.current.sceneId);
    renderer.start();

    engineRef.current = engine;
    rendererRef.current = renderer;
    setGlAvailable(renderer.glAvailable);

    return () => {
      renderer.dispose();
      engine.stop();
      engineRef.current = null;
      rendererRef.current = null;
    };
  }, []);

  // ---- Audio control ----
  const refreshDevices = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const list = await engine.listDevices();
    setDevices(list);
  }, []);

  const startAudio = useCallback(
    async (deviceId?: string) => {
      const engine = engineRef.current;
      if (!engine) return;
      const id = deviceId !== undefined ? deviceId : settingsRef.current.deviceId;
      const ok = await engine.start(id || undefined);
      setRunning(ok);
      setError(ok ? null : engine.error);
      if (ok) await refreshDevices();
    },
    [refreshDevices],
  );

  const stopAudio = useCallback(() => {
    engineRef.current?.stop();
    setRunning(false);
  }, []);

  const toggleAudio = useCallback(() => {
    if (running) stopAudio();
    else void startAudio();
  }, [running, startAudio, stopAudio]);

  // Select an input device; hot-swap the capture if it is currently live.
  // The explicit deviceId argument matters: settingsRef only reflects the
  // update() on the next render, which would be too late for this start().
  const selectDevice = useCallback(
    (deviceId: string) => {
      update({ deviceId });
      if (engineRef.current?.running) void startAudio(deviceId);
    },
    [update, startAudio],
  );

  // Populate the device list immediately (labels stay generic until permission
  // is granted) and track OS-level plug/unplug events.
  useEffect(() => {
    void refreshDevices();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = (): void => void refreshDevices();
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

  // Attempt one auto-start on load (browsers usually block until a gesture).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const engine = engineRef.current;
      if (!engine) return;
      const ok = await engine.start(settingsRef.current.deviceId || undefined);
      if (cancelled) return;
      setRunning(ok);
      if (ok) {
        setError(null);
        await refreshDevices();
      } else {
        // Don't surface a scary error for the expected autoplay block; the
        // panel will show the "Click to start audio" state via `running`.
        setError(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshDevices]);

  // ---- Scene selection ----
  const setScene = useCallback(
    (id: string) => {
      rendererRef.current?.setScene(id);
      update({ sceneId: id });
    },
    [update],
  );

  const shiftScene = useCallback(
    (delta: number) => {
      const cur = sceneIndexById(settingsRef.current.sceneId);
      setScene(sceneByIndex(cur + delta).id);
    },
    [setScene],
  );

  // ---- Look gacha: reroll the seed ----
  const reroll = useCallback(() => {
    update({ seed: randomSeed() });
  }, [update]);

  // ---- Tempo controls (delegate to the engine's TempoTracker) ----
  const onTap = useCallback(() => {
    engineRef.current?.tapTempo();
  }, []);
  const onTempoMultiply = useCallback((f: 2 | 0.5) => {
    engineRef.current?.tempoMultiply(f);
  }, []);
  const onTempoAuto = useCallback(() => {
    engineRef.current?.tempoAuto();
  }, []);

  // Push variation changes (seed reroll / edit) to the renderer, which re-inits
  // the active scene so element-count arrays re-allocate against the new look.
  useEffect(() => {
    rendererRef.current?.setVariation(variation);
  }, [variation]);

  // ---- Background class on <html> ----
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('bg-black', settings.background === 'black');
    root.classList.toggle('bg-transparent', settings.background === 'transparent');
  }, [settings.background]);

  // ---- Auto-cycle (seconds) ----
  useEffect(() => {
    if (!settings.autoCycle || settings.cycleMode !== 'seconds') return;
    const ms = Math.max(2, settings.cycleSeconds) * 1000;
    const id = window.setInterval(() => shiftScene(1), ms);
    return () => window.clearInterval(id);
  }, [settings.autoCycle, settings.cycleMode, settings.cycleSeconds, shiftScene]);

  // ---- Auto-cycle (bars): advance every N bars off the tempo grid ----
  const lastSwitchedBarRef = useRef(0);
  useEffect(() => {
    if (!settings.autoCycle || settings.cycleMode !== 'bars') return;
    const peek = engineRef.current?.peekFrame();
    lastSwitchedBarRef.current = peek?.barCount ?? 0;
    const id = window.setInterval(() => {
      const f = engineRef.current?.peekFrame();
      if (!f || f.bpm <= 0) return;
      if (f.barCount - lastSwitchedBarRef.current >= settings.cycleBars) {
        lastSwitchedBarRef.current = f.barCount;
        shiftScene(1);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [settings.autoCycle, settings.cycleMode, settings.cycleBars, shiftScene]);

  // ---- Auto-gacha: reroll the look every N bars off the tempo grid ----
  const lastGachaBarRef = useRef(0);
  useEffect(() => {
    if (!settings.autoGacha) return;
    const peek = engineRef.current?.peekFrame();
    lastGachaBarRef.current = peek?.barCount ?? 0;
    const id = window.setInterval(() => {
      const f = engineRef.current?.peekFrame();
      if (!f || f.bpm <= 0) return;
      if (f.barCount - lastGachaBarRef.current >= settings.gachaBars) {
        lastGachaBarRef.current = f.barCount;
        reroll();
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [settings.autoGacha, settings.gachaBars, reroll]);

  // ---- Idle / cursor auto-hide ----
  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_TIMEOUT_MS);
    };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('mousedown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('mousedown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('cursor-hidden', idle);
  }, [idle]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      // Digits 1–9 select scenes 1–9; 0 selects the 10th. Bounds-checked.
      if (key >= '0' && key <= '9') {
        const idx = key === '0' ? 9 : Number(key) - 1;
        if (idx < scenes.length) {
          e.preventDefault();
          setScene(scenes[idx].id);
        }
        return;
      }
      switch (key) {
        case 'ArrowRight':
          e.preventDefault();
          shiftScene(1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          shiftScene(-1);
          break;
        case 'h':
        case 'H':
          setPanelHidden((v) => !v);
          break;
        case 'f':
        case 'F':
          void toggleFullscreen();
          break;
        case 'a':
        case 'A':
          update({ autoCycle: !settingsRef.current.autoCycle });
          break;
        case 'b':
        case 'B':
          update({
            background:
              settingsRef.current.background === 'black' ? 'transparent' : 'black',
          });
          break;
        case 'r':
        case 'R':
          reroll();
          break;
        case 't':
        case 'T':
          onTap();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setScene, shiftScene, update, reroll, onTap]);

  return (
    <>
      <canvas id="vj-canvas-gl" ref={glCanvasRef} />
      <canvas id="vj-canvas" ref={canvasRef} />
      <ControlPanel
        hidden={panelHidden}
        faded={idle && !panelHidden}
        settings={settings}
        update={update}
        glAvailable={glAvailable}
        running={running}
        error={error}
        devices={devices}
        engine={engineRef.current}
        onToggleAudio={toggleAudio}
        onRefreshDevices={refreshDevices}
        onSelectDevice={selectDevice}
        onSetScene={setScene}
        onShiftScene={shiftScene}
        onToggleFullscreen={() => void toggleFullscreen()}
        onReroll={reroll}
        onTap={onTap}
        onTempoMultiply={onTempoMultiply}
        onTempoAuto={onTempoAuto}
      />
    </>
  );
}
