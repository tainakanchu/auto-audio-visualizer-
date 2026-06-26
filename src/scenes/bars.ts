import type { Scene2D, SceneContext } from './types';
import { clamp, clamp01, lerp, hsla, idlePulse, spreadHue } from './util';

// Module-level state for inter-frame continuity
let smoothed: Float32Array = new Float32Array(0);
let peaks: Float32Array = new Float32Array(0);
let cachedCount = 0;

function logBin(i: number, total: number, freqLen: number): number {
  const minBin = 1;
  const maxBin = freqLen * 0.6;
  const t = i / (total - 1);
  return Math.floor(minBin * Math.pow(maxBin / minBin, t));
}

function ensureArrays(count: number): void {
  if (count !== cachedCount) {
    smoothed = new Float32Array(count);
    peaks = new Float32Array(count);
    cachedCount = count;
  }
}

export const barsScene: Scene2D = {
  kind: '2d',
  id: 'bars',
  name: 'Bars',
  trail: 0,

  init() {
    smoothed = new Float32Array(0);
    peaks = new Float32Array(0);
    cachedCount = 0;
  },

  draw(s: SceneContext) {
    const { ctx, w, h, t, audio, va } = s;
    const { freq, level, running } = audio;

    const count = clamp(Math.round(80 * va.density), 32, 128);
    ensureArrays(count);

    const gapFrac = 0.05 + va.shape * 0.35;
    const barW = w / count;
    const gap = barW * gapFrac;
    const bw = barW - gap;
    const maxH = clamp(h * 0.72 * va.scale, 10, h * 0.98);

    // Discrete layout switch (va.variant is already an int 0..3).
    const variant = va.variant;

    for (let i = 0; i < count; i++) {
      let raw: number;
      if (running && freq.length > 0) {
        const bin = logBin(i, count, freq.length);
        const v = (freq[bin] ?? 0) / 255;
        raw = v * (0.5 + level * 1.5);
      } else {
        const idlePhase = (i / count) * Math.PI * 2;
        raw = idlePulse(t, 0.5, idlePhase) * 0.08 + 0.02;
      }
      raw = clamp01(raw);

      smoothed[i] = lerp(smoothed[i] ?? 0, raw, 0.25);

      // wobble: small per-bar height jitter
      const wobbleJitter = va.rand(i) * 0.04 * va.wobble * Math.sin(t * 2 + i);
      const smoothedVal = clamp01((smoothed[i] ?? 0) + wobbleJitter);
      const barH = smoothedVal * maxH;

      peaks[i] = Math.max(smoothedVal, (peaks[i] ?? 0) - 0.004);

      const frac = count > 1 ? i / (count - 1) : 0;
      const barHue = spreadHue(va, s.hue, frac, i);
      const sat = va.saturation;
      const lit = va.lightness;
      const alpha = running ? 0.85 : 0.4;

      const x = i * barW + gap * 0.5;

      ctx.save();

      if (variant === 3) {
        // Vertical bars: bars run along vertical axis, lengths extend inward from left+right edges
        const yPos = i * barW + gap * 0.5;
        const maxBarLen = w * 0.5 * va.scale;
        const barLen = clamp(smoothedVal * maxBarLen, 0, w * 0.5);
        const peakLen = clamp((peaks[i] ?? 0) * maxBarLen, 0, w * 0.5);
        const rV = Math.min(bw * 0.5, 4);

        if (barLen > 0) {
          // Left side
          const gradL = ctx.createLinearGradient(0, yPos, barLen, yPos);
          gradL.addColorStop(0, hsla(barHue, sat, lit, alpha));
          gradL.addColorStop(1, hsla(barHue + 20, sat * 0.88, lit * 0.78, alpha * 0.7));
          ctx.fillStyle = gradL;
          ctx.beginPath();
          ctx.roundRect(0, yPos, barLen, bw, [0, 0, rV, rV]);
          ctx.fill();

          // Right side (mirror)
          const gradR = ctx.createLinearGradient(w, yPos, w - barLen, yPos);
          gradR.addColorStop(0, hsla(barHue, sat, lit, alpha));
          gradR.addColorStop(1, hsla(barHue + 20, sat * 0.88, lit * 0.78, alpha * 0.7));
          ctx.fillStyle = gradR;
          ctx.beginPath();
          ctx.roundRect(w - barLen, yPos, barLen, bw, [rV, rV, 0, 0]);
          ctx.fill();
        }

        if (peaks[i] > 0.01) {
          ctx.strokeStyle = hsla(barHue + 30, 100, 90, alpha);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(peakLen, yPos);
          ctx.lineTo(peakLen, yPos + bw);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(w - peakLen, yPos);
          ctx.lineTo(w - peakLen, yPos + bw);
          ctx.stroke();
        }
      } else if (variant === 0) {
        // Classic bottom bars: grow upward from bottom
        const y = h - barH;
        const peakY = h - (peaks[i] ?? 0) * maxH;

        const grad = ctx.createLinearGradient(x, h, x, y);
        grad.addColorStop(0, hsla(barHue, sat, lit, alpha));
        grad.addColorStop(1, hsla(barHue + 20, sat * 0.88, lit * 0.78, alpha * 0.7));
        ctx.fillStyle = grad;

        const radius = Math.min(bw * 0.5, 4);
        ctx.beginPath();
        ctx.roundRect(x, y, bw, barH, [radius, radius, 0, 0]);
        ctx.fill();

        if (barH > 2) {
          const reflGrad = ctx.createLinearGradient(x, h, x, h + barH * 0.35);
          reflGrad.addColorStop(0, hsla(barHue, sat * 0.88, lit * 0.85, alpha * 0.25));
          reflGrad.addColorStop(1, hsla(barHue, sat * 0.88, lit * 0.85, 0));
          ctx.fillStyle = reflGrad;
          ctx.beginPath();
          ctx.roundRect(x, h, bw, barH * 0.35, [0, 0, radius, radius]);
          ctx.fill();
        }

        if (peaks[i] > 0.01) {
          ctx.strokeStyle = hsla(barHue + 30, 100, 90, alpha);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, peakY);
          ctx.lineTo(x + bw, peakY);
          ctx.stroke();
        }
      } else if (variant === 1) {
        // Center-mirror: bars grow symmetrically UP and DOWN from horizontal centerline
        const cy = h * 0.5;
        const halfH = barH * 0.5;
        const peakHalf = (peaks[i] ?? 0) * maxH * 0.5;

        const grad = ctx.createLinearGradient(x, cy - halfH, x, cy + halfH);
        grad.addColorStop(0, hsla(barHue + 20, sat * 0.88, lit * 0.78, alpha * 0.7));
        grad.addColorStop(0.5, hsla(barHue, sat, lit, alpha));
        grad.addColorStop(1, hsla(barHue + 20, sat * 0.88, lit * 0.78, alpha * 0.7));
        ctx.fillStyle = grad;

        const radius = Math.min(bw * 0.5, 4);
        ctx.beginPath();
        ctx.roundRect(x, cy - halfH, bw, barH, [radius, radius, radius, radius]);
        ctx.fill();

        if (peaks[i] > 0.01) {
          ctx.strokeStyle = hsla(barHue + 30, 100, 90, alpha);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, cy - peakHalf);
          ctx.lineTo(x + bw, cy - peakHalf);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x, cy + peakHalf);
          ctx.lineTo(x + bw, cy + peakHalf);
          ctx.stroke();
        }
      } else {
        // variant === 2: top+bottom opposing — bars from top edge growing down AND from bottom growing up
        const topBarH = barH * 0.5;
        const botBarH = barH * 0.5;
        const peakTopY = (peaks[i] ?? 0) * maxH * 0.5;
        const peakBotY = h - (peaks[i] ?? 0) * maxH * 0.5;

        const radius = Math.min(bw * 0.5, 4);

        // Top bar (from top, growing down)
        const gradTop = ctx.createLinearGradient(x, 0, x, topBarH);
        gradTop.addColorStop(0, hsla(barHue, sat, lit, alpha));
        gradTop.addColorStop(1, hsla(barHue + 20, sat * 0.88, lit * 0.78, alpha * 0.7));
        ctx.fillStyle = gradTop;
        ctx.beginPath();
        ctx.roundRect(x, 0, bw, topBarH, [0, 0, radius, radius]);
        ctx.fill();

        // Bottom bar (from bottom, growing up)
        const gradBot = ctx.createLinearGradient(x, h, x, h - botBarH);
        gradBot.addColorStop(0, hsla(barHue, sat, lit, alpha));
        gradBot.addColorStop(1, hsla(barHue + 20, sat * 0.88, lit * 0.78, alpha * 0.7));
        ctx.fillStyle = gradBot;
        ctx.beginPath();
        ctx.roundRect(x, h - botBarH, bw, botBarH, [radius, radius, 0, 0]);
        ctx.fill();

        if (peaks[i] > 0.01) {
          ctx.strokeStyle = hsla(barHue + 30, 100, 90, alpha);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, peakTopY);
          ctx.lineTo(x + bw, peakTopY);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x, peakBotY);
          ctx.lineTo(x + bw, peakBotY);
          ctx.stroke();
        }
      }

      ctx.restore();
    }
  },
};
