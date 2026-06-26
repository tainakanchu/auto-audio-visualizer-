import type { Scene2D, SceneContext } from './types';
import type { Variation } from '../variation/types';
import { clamp, clamp01, lerp, hsla, idlePulse, spreadHue, beatPulse } from './util';

let smoothLevel = 0;
let beatPhase = 0;

interface Point {
  x: number;
  y: number;
}

function buildLissajousFromWave(
  wave: Uint8Array<ArrayBuffer>,
  w: number,
  h: number,
  scale: number,
): Point[] {
  const count = 256;
  const quarterLen = Math.floor(wave.length / 4);
  const pts: Point[] = [];
  const stepX = Math.max(1, Math.floor(wave.length / count));
  const stepY = stepX;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const sx = w * 0.44 * scale;
  const sy = h * 0.44 * scale;

  for (let i = 0; i < count; i++) {
    const iX = Math.min(i * stepX, wave.length - 1);
    const iY = Math.min(i * stepY + quarterLen, wave.length - 1);
    const vx = ((wave[iX] ?? 128) - 128) / 128;
    const vy = ((wave[iY] ?? 128) - 128) / 128;
    pts.push({ x: cx + vx * sx, y: cy + vy * sy });
  }
  return pts;
}

function buildIdleLissajous(
  t: number,
  w: number,
  h: number,
  scale: number,
): Point[] {
  const count = 256;
  const pts: Point[] = [];
  const cx = w * 0.5;
  const cy = h * 0.5;
  const sx = w * 0.38 * scale;
  const sy = h * 0.38 * scale;

  const fx = 2.0;
  const fy = 3.0;
  const phase = t * 0.18;

  for (let i = 0; i < count; i++) {
    const tVal = (i / count) * Math.PI * 2;
    const vx = Math.sin(fx * tVal + phase);
    const vy = Math.sin(fy * tVal);
    pts.push({ x: cx + vx * sx, y: cy + vy * sy });
  }
  return pts;
}

function buildHarmonicFigure(
  w: number,
  h: number,
  scale: number,
  va: Variation,
  beatPhaseArg: number,
): Point[] {
  const ratios: [number, number][] = [[1, 2], [2, 3], [3, 4], [3, 5]];
  const idx = Math.floor(va.rand(0) * 4);
  const [a, b] = ratios[idx]!;
  const count = 512;
  const amplitude = 0.38 * scale;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2;
    const x = cx + Math.sin(a * theta + beatPhaseArg) * w * amplitude;
    const y = cy + Math.sin(b * theta) * h * amplitude;
    pts.push({ x, y });
  }
  return pts;
}

function buildRibbon(
  wave: Uint8Array<ArrayBuffer>,
  w: number,
  h: number,
  scale: number,
  thickness: number,
): { top: Point[]; bot: Point[] } {
  const count = 256;
  const cy = h * 0.5;
  const top: Point[] = [];
  const bot: Point[] = [];
  for (let i = 0; i < count; i++) {
    const iX = Math.min(i * Math.max(1, Math.floor(wave.length / count)), wave.length - 1);
    const vx = (i / (count - 1)) * w;
    const vy = ((wave[iX] ?? 128) - 128) / 128;
    const py = cy + vy * h * 0.44 * scale;
    top.push({ x: vx, y: py - thickness * 0.5 });
    bot.push({ x: vx, y: py + thickness * 0.5 });
  }
  return { top, bot };
}

function buildRotationalCopies(basePts: Point[], va: Variation, w: number, h: number): Point[][] {
  const cx = w * 0.5;
  const cy = h * 0.5;
  const copies: Point[][] = [];
  for (let k = 0; k < va.symmetry; k++) {
    const angle = (2 * Math.PI * k) / va.symmetry;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const copy: Point[] = basePts.map(p => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      return {
        x: cx + dx * cosA - dy * sinA,
        y: cy + dx * sinA + dy * cosA,
      };
    });
    copies.push(copy);
  }
  return copies;
}

export const lissajousScene: Scene2D = {
  kind: '2d',
  id: 'lissajous',
  name: 'Lissajous',
  trail: 0.6,

  init() {
    smoothLevel = 0;
    beatPhase = 0;
  },

  draw(s: SceneContext) {
    const { ctx, w, h, t, dt, audio, hue, va } = s;
    const { wave, level, running } = audio;
    const pulse = beatPulse(audio);

    smoothLevel = lerp(smoothLevel, running ? level : 0, 0.12);
    beatPhase += dt * pulse * 3.0 * va.speed;

    const scale = clamp01(0.3 + smoothLevel * 0.85 + pulse * 0.15) * va.scale;
    const slowRotation = t * 0.06 * va.speed * va.direction;

    // Flat wave detection
    let isFlat = false;
    if (running) {
      let variance = 0;
      for (let i = 0; i < wave.length; i++) {
        const v = (wave[i] ?? 128) - 128;
        variance += v * v;
      }
      variance /= wave.length;
      isFlat = variance < 4;
    }

    ctx.save();
    ctx.translate(w * 0.5, h * 0.5);
    ctx.rotate(slowRotation);
    ctx.translate(-w * 0.5, -h * 0.5);

    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const baseAlpha =
      running && !isFlat
        ? clamp01(0.2 + smoothLevel * 0.55 + pulse * 0.25)
        : 0.18;

    const variant = va.variant;

    if (variant === 0) {
      // Classic XY
      let pts: Point[];
      if (running && !isFlat) {
        pts = buildLissajousFromWave(wave, w, h, scale);
      } else {
        pts = buildIdleLissajous(t, w, h, scale * (running ? 0.5 : 0.45));
      }

      if (pts.length >= 2) {
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i]!;
          const p1 = pts[i + 1]!;
          const frac = i / (pts.length - 1);
          const segHue = spreadHue(va, hue, frac, i);

          // Wide dim glow
          ctx.strokeStyle = hsla(segHue, va.saturation, va.lightness, 1);
          ctx.lineWidth = 6;
          ctx.globalAlpha = baseAlpha * 0.15;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();

          // Mid
          ctx.strokeStyle = hsla(segHue + 20, va.saturation, clamp(va.lightness + 15, 45, 95), 1);
          ctx.lineWidth = 2.5;
          ctx.globalAlpha = baseAlpha * 0.55;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();

          // Core
          ctx.strokeStyle = hsla(segHue + 35, 100, 92, 1);
          ctx.lineWidth = 0.9;
          ctx.globalAlpha = Math.min(1, baseAlpha * 1.1);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
        }
      }

      if (!running || isFlat) {
        const dotA = 0.15 + idlePulse(t, 0.7) * 0.12;
        ctx.globalAlpha = dotA;
        ctx.fillStyle = hsla(hue, va.saturation, va.lightness, 1);
        ctx.beginPath();
        ctx.arc(w * 0.5, h * 0.5, 3 + idlePulse(t, 0.5) * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (variant === 1) {
      // Harmonic figure
      const pts = buildHarmonicFigure(w, h, scale, va, beatPhase);

      if (pts.length >= 2) {
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i]!;
          const p1 = pts[i + 1]!;
          const frac = i / (pts.length - 1);
          const segHue = spreadHue(va, hue, frac, i);

          ctx.strokeStyle = hsla(segHue, va.saturation, va.lightness, 1);
          ctx.lineWidth = 6;
          ctx.globalAlpha = baseAlpha * 0.15;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();

          ctx.strokeStyle = hsla(segHue + 20, va.saturation, clamp(va.lightness + 15, 45, 95), 1);
          ctx.lineWidth = 2.5;
          ctx.globalAlpha = baseAlpha * 0.55;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();

          ctx.strokeStyle = hsla(segHue + 35, 100, 92, 1);
          ctx.lineWidth = 0.9;
          ctx.globalAlpha = Math.min(1, baseAlpha * 1.1);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
        }
      }

      if (!running || isFlat) {
        const dotA = 0.15 + idlePulse(t, 0.7) * 0.12;
        ctx.globalAlpha = dotA;
        ctx.fillStyle = hsla(hue, va.saturation, va.lightness, 1);
        ctx.beginPath();
        ctx.arc(w * 0.5, h * 0.5, 3 + idlePulse(t, 0.5) * 4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (variant === 2) {
      // Ribbon
      const thickness = 20 * scale;
      const { top, bot } = buildRibbon(wave, w, h, scale, thickness);
      const ribbonHue = spreadHue(va, hue, 0.5);

      if (top.length > 0) {
        // Filled polygon: top forward + bot backward
        ctx.beginPath();
        ctx.moveTo(top[0]!.x, top[0]!.y);
        for (let i = 1; i < top.length; i++) {
          ctx.lineTo(top[i]!.x, top[i]!.y);
        }
        for (let i = bot.length - 1; i >= 0; i--) {
          ctx.lineTo(bot[i]!.x, bot[i]!.y);
        }
        ctx.closePath();
        ctx.fillStyle = hsla(ribbonHue, va.saturation, va.lightness, 1);
        ctx.globalAlpha = baseAlpha * 0.2;
        ctx.fill();

        // Top edge stroke
        ctx.beginPath();
        ctx.moveTo(top[0]!.x, top[0]!.y);
        for (let i = 1; i < top.length; i++) {
          ctx.lineTo(top[i]!.x, top[i]!.y);
        }
        ctx.strokeStyle = hsla(ribbonHue + 20, va.saturation, clamp(va.lightness + 15, 45, 95), 1);
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = baseAlpha * 0.8;
        ctx.stroke();

        // Bot edge stroke
        ctx.beginPath();
        ctx.moveTo(bot[0]!.x, bot[0]!.y);
        for (let i = 1; i < bot.length; i++) {
          ctx.lineTo(bot[i]!.x, bot[i]!.y);
        }
        ctx.stroke();
      }
    } else {
      // Variant 3: rotational copies
      let basePts: Point[];
      if (running && !isFlat) {
        basePts = buildLissajousFromWave(wave, w, h, scale);
      } else {
        basePts = buildIdleLissajous(t, w, h, scale * (running ? 0.5 : 0.45));
      }

      const copies = buildRotationalCopies(basePts, va, w, h);
      for (let k = 0; k < copies.length; k++) {
        const copy = copies[k]!;
        if (copy.length < 2) continue;
        const frac = k / va.symmetry;
        for (let i = 0; i < copy.length - 1; i++) {
          const p0 = copy[i]!;
          const p1 = copy[i + 1]!;
          const segHue = spreadHue(va, hue, frac, k);

          // Wide glow
          ctx.strokeStyle = hsla(segHue, va.saturation, va.lightness, 1);
          ctx.lineWidth = 6;
          ctx.globalAlpha = baseAlpha * 0.15;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();

          // Core
          ctx.strokeStyle = hsla(segHue + 20, va.saturation, clamp(va.lightness + 15, 45, 95), 1);
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = baseAlpha * 0.7;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  },
};
