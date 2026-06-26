import type { Scene2D, SceneContext } from './types';
import { clamp, clamp01, lerp, hsla, spreadHue, beatPulse } from './util';

let smoothLevel = 0;

interface WavePoint {
  x: number;
  y: number;
}

function buildPoints(
  wave: Uint8Array<ArrayBuffer>,
  w: number,
  cy: number,
  amplitude: number,
  running: boolean,
  t: number,
  wobbleAmt: (i: number) => number,
): WavePoint[] {
  const pts: WavePoint[] = [];
  const count = 256;

  if (!running) {
    for (let i = 0; i < count; i++) {
      const nx = i / (count - 1);
      const y = cy + Math.sin(nx * Math.PI * 4 + t * 0.8) * amplitude * 0.18 +
                     Math.sin(nx * Math.PI * 7 + t * 0.5) * amplitude * 0.06;
      pts.push({ x: nx * w, y });
    }
    return pts;
  }

  const step = Math.max(1, Math.floor(wave.length / count));
  for (let i = 0; i < count; i++) {
    const idx = Math.min(i * step, wave.length - 1);
    const v = ((wave[idx] ?? 128) - 128) / 128;
    const wb = wobbleAmt(i);
    pts.push({ x: (i / (count - 1)) * w, y: cy + (v + wb) * amplitude });
  }
  return pts;
}

function drawGlowLine(
  ctx: CanvasRenderingContext2D,
  pts: WavePoint[],
  color: string,
  width: number,
  alpha: number,
): void {
  if (pts.length < 2) return;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i]!.x, pts[i]!.y);
  }
  ctx.stroke();
}

function drawVariant0(
  ctx: CanvasRenderingContext2D,
  pts: WavePoint[],
  ghostPts: WavePoint[],
  hue: number,
  baseAlpha: number,
  brightness: number,
): void {
  const ghostColor = hsla(hue + 40, 85, 65, 1);
  drawGlowLine(ctx, ghostPts, ghostColor, 5, baseAlpha * 0.35);
  drawGlowLine(ctx, ghostPts, ghostColor, 2, baseAlpha * 0.6);

  const mainColor = hsla(hue, 90, brightness, 1);
  const midColor  = hsla(hue + 10, 95, brightness + 8, 1);
  const coreColor = hsla(hue + 5, 100, 96, 1);

  drawGlowLine(ctx, pts, mainColor, 12, baseAlpha * 0.18);
  drawGlowLine(ctx, pts, mainColor, 6,  baseAlpha * 0.45);
  drawGlowLine(ctx, pts, midColor,  3,  baseAlpha * 0.75);
  drawGlowLine(ctx, pts, coreColor, 1.2, Math.min(1, baseAlpha * 1.2));
}

function drawVariant1Stacked(
  ctx: CanvasRenderingContext2D,
  s: SceneContext,
  smoothedLevel: number,
  baseAlpha: number,
  brightness: number,
  wobbleAmtFn: (i: number) => number,
): void {
  const { w, h, t, va, audio } = s;
  const { wave, running } = audio;
  const symmetry = Math.max(1, Math.round(va.symmetry));

  for (let li = 0; li < symmetry; li++) {
    const frac = symmetry > 1 ? li / (symmetry - 1) : 0;
    const cy_i = (li + 0.5) / symmetry * h;
    const lineHue = spreadHue(va, s.hue, frac, li);
    const amplitude = clamp01(0.2 + smoothedLevel * 0.7) * (h / symmetry) * 0.38 * va.scale;
    const pts = buildPoints(wave, w, cy_i, amplitude, running, t, wobbleAmtFn);

    drawGlowLine(ctx, pts, hsla(lineHue, va.saturation, brightness, 1), 12, baseAlpha * 0.18);
    drawGlowLine(ctx, pts, hsla(lineHue, va.saturation, brightness, 1), 6, baseAlpha * 0.45);
    drawGlowLine(ctx, pts, hsla(lineHue + 10, va.saturation, brightness + 8, 1), 3, baseAlpha * 0.75);
    drawGlowLine(ctx, pts, hsla(lineHue + 5, 100, 96, 1), 1.2, Math.min(1, baseAlpha * 1.2));
  }
}

function drawVariant2Circular(
  ctx: CanvasRenderingContext2D,
  s: SceneContext,
  smoothedLevel: number,
  baseAlpha: number,
  wobbleAmtFn: (i: number) => number,
): void {
  const { w, h, t, va, audio } = s;
  const { wave, running, bass } = audio;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const count = 256;

  const baseR = clamp(Math.min(w, h) * 0.25 * va.scale, 30, Math.min(w, h) * 0.45);
  const bassBoost = bass * 30;
  const radius = baseR + bassBoost;
  const amplitude = clamp01(0.2 + smoothedLevel * 0.7) * radius * 0.5;

  interface PolarPoint { x: number; y: number; }
  const circlePts: PolarPoint[] = [];

  if (!running) {
    for (let i = 0; i <= count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const nx = i / count;
      const v = Math.sin(nx * Math.PI * 4 + t * 0.8) * 0.18 +
                Math.sin(nx * Math.PI * 7 + t * 0.5) * 0.06;
      const r = radius + v * amplitude;
      circlePts.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
  } else {
    const step = Math.max(1, Math.floor(wave.length / count));
    for (let i = 0; i <= count; i++) {
      const idx = Math.min(i * step, wave.length - 1);
      const v = ((wave[idx] ?? 128) - 128) / 128;
      const wb = wobbleAmtFn(i % 64);
      const r = radius + (v + wb) * amplitude;
      const angle = (i / count) * Math.PI * 2;
      circlePts.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
  }

  // Draw per-segment with color from spreadHue
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = 0; i < circlePts.length - 1; i++) {
    const frac = i / (circlePts.length - 2);
    const segHue = spreadHue(va, s.hue, frac, i);
    ctx.globalAlpha = baseAlpha * 0.75;
    ctx.strokeStyle = hsla(segHue, va.saturation, va.lightness, 1);
    ctx.beginPath();
    ctx.moveTo(circlePts[i]!.x, circlePts[i]!.y);
    ctx.lineTo(circlePts[i + 1]!.x, circlePts[i + 1]!.y);
    ctx.stroke();
  }
  // Core bright pass
  ctx.lineWidth = 1.2;
  for (let i = 0; i < circlePts.length - 1; i++) {
    const frac = i / (circlePts.length - 2);
    const segHue = spreadHue(va, s.hue, frac, i);
    ctx.globalAlpha = Math.min(1, baseAlpha * 1.2);
    ctx.strokeStyle = hsla(segHue + 5, 100, 96, 1);
    ctx.beginPath();
    ctx.moveTo(circlePts[i]!.x, circlePts[i]!.y);
    ctx.lineTo(circlePts[i + 1]!.x, circlePts[i + 1]!.y);
    ctx.stroke();
  }
}

function drawVariant3VerticalMirrored(
  ctx: CanvasRenderingContext2D,
  s: SceneContext,
  smoothedLevel: number,
  baseAlpha: number,
  brightness: number,
  wobbleAmtFn: (i: number) => number,
): void {
  const { w, h, t, va, audio } = s;
  const { wave, running } = audio;
  const count = 256;
  const cx = w * 0.5;
  const amplitude = clamp01(0.2 + smoothedLevel * 0.7) * cx * 0.6 * va.scale;

  // Build points along vertical axis: y goes top to bottom, x is the amplitude offset
  interface VP { lx: number; rx: number; y: number; }
  const vPts: VP[] = [];

  if (!running) {
    for (let i = 0; i < count; i++) {
      const ny = i / (count - 1);
      const v = Math.sin(ny * Math.PI * 4 + t * 0.8) * 0.18 +
                Math.sin(ny * Math.PI * 7 + t * 0.5) * 0.06;
      const xOffset = v * amplitude;
      const y = ny * h;
      vPts.push({ lx: cx - xOffset, rx: cx + xOffset, y });
    }
  } else {
    const step = Math.max(1, Math.floor(wave.length / count));
    for (let i = 0; i < count; i++) {
      const idx = Math.min(i * step, wave.length - 1);
      const v = ((wave[idx] ?? 128) - 128) / 128;
      const wb = wobbleAmtFn(i % 64);
      const xOffset = (v + wb) * amplitude;
      const y = (i / (count - 1)) * h;
      vPts.push({ lx: cx - Math.abs(xOffset), rx: cx + Math.abs(xOffset), y });
    }
  }

  // Draw left line
  const leftPts: WavePoint[] = vPts.map(p => ({ x: p.lx, y: p.y }));
  // Draw right line
  const rightPts: WavePoint[] = vPts.map(p => ({ x: p.rx, y: p.y }));

  const hueL = spreadHue(va, s.hue, 0, 0);
  const hueR = spreadHue(va, s.hue, 1, 1);

  drawGlowLine(ctx, leftPts, hsla(hueL, va.saturation, brightness, 1), 12, baseAlpha * 0.18);
  drawGlowLine(ctx, leftPts, hsla(hueL, va.saturation, brightness, 1), 6, baseAlpha * 0.45);
  drawGlowLine(ctx, leftPts, hsla(hueL + 10, va.saturation, brightness + 8, 1), 3, baseAlpha * 0.75);
  drawGlowLine(ctx, leftPts, hsla(hueL + 5, 100, 96, 1), 1.2, Math.min(1, baseAlpha * 1.2));

  drawGlowLine(ctx, rightPts, hsla(hueR, va.saturation, brightness, 1), 12, baseAlpha * 0.18);
  drawGlowLine(ctx, rightPts, hsla(hueR, va.saturation, brightness, 1), 6, baseAlpha * 0.45);
  drawGlowLine(ctx, rightPts, hsla(hueR + 10, va.saturation, brightness + 8, 1), 3, baseAlpha * 0.75);
  drawGlowLine(ctx, rightPts, hsla(hueR + 5, 100, 96, 1), 1.2, Math.min(1, baseAlpha * 1.2));
}

export const waveformScene: Scene2D = {
  kind: '2d',
  id: 'waveform',
  name: 'Waveform',
  trail: 0.5,

  init() {
    smoothLevel = 0;
  },

  draw(s: SceneContext) {
    const { ctx, w, h, t, va } = s;
    const { wave, level, running } = s.audio;
    const pulse = beatPulse(s.audio);

    smoothLevel = lerp(smoothLevel, running ? level : 0, 0.15);

    const cy = h * 0.5;
    const amplitude = clamp01(0.2 + smoothLevel * 0.7) * h * 0.38 * va.scale;
    const brightness = lerp(55, 90, clamp01(pulse * 1.5));
    const baseAlpha = running ? clamp01(0.25 + smoothLevel * 0.55 + pulse * 0.2) : 0.18;

    // wobble per-sample
    const wobbleAmtFn = (i: number): number =>
      va.rand(i % 64) * 0.08 * va.wobble * Math.sin(t * 1.5 + i * 0.2);

    const variant = va.variant;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (variant === 0) {
      const pts = buildPoints(wave, w, cy, amplitude, running, t, wobbleAmtFn);
      const ghostCy = cy + h * 0.06;
      const ghostPts = buildPoints(wave, w, ghostCy, amplitude * 0.6, running, t + 0.3, wobbleAmtFn);
      drawVariant0(ctx, pts, ghostPts, s.hue, baseAlpha, brightness);
    } else if (variant === 1) {
      drawVariant1Stacked(ctx, s, smoothLevel, baseAlpha, brightness, wobbleAmtFn);
    } else if (variant === 2) {
      drawVariant2Circular(ctx, s, smoothLevel, baseAlpha, wobbleAmtFn);
    } else {
      drawVariant3VerticalMirrored(ctx, s, smoothLevel, baseAlpha, brightness, wobbleAmtFn);
    }

    ctx.restore();
  },
};
