import type { Scene2D, SceneContext } from './types';
import { clamp, clamp01, lerp, hsla, idlePulse, spreadHue, beatPulse } from './util';

// Module-level state for inter-frame continuity
let smoothBass = 0;
let smoothBeat = 0;
let rotation = 0;
let rotationInner = 0;
let smoothedSpikes: Float32Array = new Float32Array(0);

function spikeCount(density: number): number {
  return clamp(Math.round(96 * density), 48, 160);
}

function logBin(i: number, total: number, freqLen: number): number {
  const minBin = 1;
  const maxBin = Math.floor(freqLen * 0.55);
  const tVal = i / (total - 1);
  return Math.floor(minBin * Math.pow(maxBin / minBin, tVal));
}

export const radialScene: Scene2D = {
  kind: '2d',
  id: 'radial',
  name: 'Radial',
  trail: 0.3,

  init() {
    smoothBass = 0;
    smoothBeat = 0;
    rotation = 0;
    rotationInner = 0;
    smoothedSpikes = new Float32Array(0);
  },

  draw(s: SceneContext) {
    const { ctx, w, h, t, dt, audio, hue, va } = s;
    const { freq, bass, running } = audio;
    const pulse = beatPulse(audio);

    const NUM_SPIKES = spikeCount(va.density);
    const cx = w * 0.5;
    const cy = h * 0.5;

    smoothBass = lerp(smoothBass, running ? bass : 0, 0.15);
    smoothBeat = lerp(smoothBeat, pulse, 0.2);

    if (smoothedSpikes.length !== NUM_SPIKES) {
      smoothedSpikes = new Float32Array(NUM_SPIKES);
    }

    rotation += dt * (0.12 + smoothBass * 0.08) * va.speed * va.direction;
    rotationInner += -dt * (0.12 + smoothBass * 0.08) * va.speed * va.direction * 1.3;

    const baseRadius = Math.min(w, h) * (0.18 + smoothBass * 0.06 + smoothBeat * 0.04) * va.scale;
    const maxSpike = Math.min(w, h) * 0.32 * va.scale;

    // Sample & smooth spikes
    for (let i = 0; i < NUM_SPIKES; i++) {
      let raw: number;
      if (running && freq.length > 0) {
        raw = (freq[logBin(i, NUM_SPIKES, freq.length)] ?? 0) / 255;
      } else {
        const idlePhase = (i / NUM_SPIKES) * Math.PI * 4;
        raw = idlePulse(t, 0.4, idlePhase) * 0.06 + 0.01;
      }
      smoothedSpikes[i] = lerp(smoothedSpikes[i] ?? 0, raw, 0.2);
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);

    const variant = va.variant;

    if (variant === 0) {
      // Symmetry sectors
      const sym = va.symmetry;
      const sectorAngle = (Math.PI * 2) / sym;
      const spikesPerSector = Math.ceil(NUM_SPIKES / sym);
      for (let sec = 0; sec < sym; sec++) {
        const sectorStart = sec * sectorAngle;
        for (let i = 0; i < spikesPerSector; i++) {
          const spikeIdx = (sec * spikesPerSector + i) % NUM_SPIKES;
          const angle = sectorStart + (i / spikesPerSector) * sectorAngle;
          const spike = smoothedSpikes[spikeIdx] ?? 0;
          const spikeLen = spike * maxSpike;
          const wobble = Math.sin(i * 2.7 + t * 2) * va.wobble * 0.08;
          const r0 = baseRadius * (1 + wobble);
          const r1 = r0 + spikeLen;
          const alpha = running ? clamp01(0.4 + spike * 1.2) : 0.25;
          const spikeHue = spreadHue(va, hue, spikeIdx / NUM_SPIKES, spikeIdx);
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);

          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.lineCap = 'round';

          // Layer 1: wide dim glow
          ctx.strokeStyle = hsla(spikeHue, va.saturation, va.lightness, 1);
          ctx.lineWidth = 4;
          ctx.globalAlpha = alpha * 0.3;
          ctx.beginPath();
          ctx.moveTo(cosA * r0, sinA * r0);
          ctx.lineTo(cosA * r1, sinA * r1);
          ctx.stroke();

          // Layer 2: thin bright core
          ctx.strokeStyle = hsla(spikeHue + 15, va.saturation, clamp(va.lightness + 15, 45, 95), 1);
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = alpha * 0.85;
          ctx.beginPath();
          ctx.moveTo(cosA * r0, sinA * r0);
          ctx.lineTo(cosA * r1, sinA * r1);
          ctx.stroke();

          ctx.restore();
        }
      }
    } else if (variant === 1) {
      // Smooth blob
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < NUM_SPIKES; i++) {
        const angle = (i / NUM_SPIKES) * Math.PI * 2;
        const spike = smoothedSpikes[i] ?? 0;
        const wobble = Math.sin(i * 2.7 + t * 2) * va.wobble * 0.08;
        const r = baseRadius * (1 + wobble) + spike * maxSpike;
        pts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
      }

      const blobHue = spreadHue(va, hue, 0.5);
      const last = pts[NUM_SPIKES - 1]!;
      const first = pts[0]!;
      const startMidX = (last.x + first.x) * 0.5;
      const startMidY = (last.y + first.y) * 0.5;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // Fill
      ctx.beginPath();
      ctx.moveTo(startMidX, startMidY);
      for (let i = 0; i < NUM_SPIKES; i++) {
        const pt = pts[i]!;
        const nextPt = pts[(i + 1) % NUM_SPIKES]!;
        const midX = (pt.x + nextPt.x) * 0.5;
        const midY = (pt.y + nextPt.y) * 0.5;
        ctx.quadraticCurveTo(pt.x, pt.y, midX, midY);
      }
      ctx.closePath();
      ctx.fillStyle = hsla(blobHue, va.saturation, va.lightness, 1);
      ctx.globalAlpha = running ? 0.12 : 0.06;
      ctx.fill();

      // Rim stroke
      ctx.beginPath();
      ctx.moveTo(startMidX, startMidY);
      for (let i = 0; i < NUM_SPIKES; i++) {
        const pt = pts[i]!;
        const nextPt = pts[(i + 1) % NUM_SPIKES]!;
        const midX = (pt.x + nextPt.x) * 0.5;
        const midY = (pt.y + nextPt.y) * 0.5;
        ctx.quadraticCurveTo(pt.x, pt.y, midX, midY);
      }
      ctx.closePath();
      ctx.strokeStyle = hsla(blobHue + 20, va.saturation, clamp(va.lightness + 15, 45, 95), 1);
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = running ? clamp01(0.4 + smoothBeat * 0.5) : 0.2;
      ctx.stroke();

      ctx.restore();
    } else if (variant === 2) {
      // Nested polygons
      const NUM_POLYS = 5;
      for (let p = 0; p < NUM_POLYS; p++) {
        const spikeIdx = p * Math.floor(NUM_SPIKES / NUM_POLYS);
        const spike = smoothedSpikes[spikeIdx] ?? 0;
        const r = baseRadius * (0.5 + p * 0.2) + spike * maxSpike * 0.6;
        const sides = va.symmetry;
        const alpha = running ? clamp01(0.35 + spike * 0.8) : 0.2;
        const polyHue = spreadHue(va, hue, p / NUM_POLYS, p);

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Layer 1: outer glow
        ctx.strokeStyle = hsla(polyHue, va.saturation, va.lightness, 1);
        ctx.lineWidth = 4;
        ctx.globalAlpha = alpha * 0.3;
        ctx.beginPath();
        for (let k = 0; k < sides; k++) {
          const angle = (k / sides) * Math.PI * 2;
          if (k === 0) {
            ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
          } else {
            ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
          }
        }
        ctx.closePath();
        ctx.stroke();

        // Layer 2: bright core
        ctx.strokeStyle = hsla(polyHue + 15, va.saturation, clamp(va.lightness + 15, 45, 95), 1);
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = alpha * 0.85;
        ctx.beginPath();
        for (let k = 0; k < sides; k++) {
          const angle = (k / sides) * Math.PI * 2;
          if (k === 0) {
            ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
          } else {
            ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
          }
        }
        ctx.closePath();
        ctx.stroke();

        ctx.restore();
      }
    } else {
      // Variant 3: twin counter-rotating rings
      const halfSpikes = Math.floor(NUM_SPIKES / 2);

      // Outer ring
      for (let i = 0; i < halfSpikes; i++) {
        const angle = (i / halfSpikes) * Math.PI * 2;
        const spikeIdx = halfSpikes + i;
        const spike = smoothedSpikes[spikeIdx % NUM_SPIKES] ?? 0;
        const spikeLen = spike * maxSpike;
        const wobble = Math.sin(i * 2.7 + t * 2) * va.wobble * 0.08;
        const r0 = baseRadius * 1.0 * (1 + wobble);
        const r1 = r0 + spikeLen;
        const alpha = running ? clamp01(0.4 + spike * 1.2) : 0.25;
        const spikeHue = spreadHue(va, hue, i / halfSpikes, i);
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';

        ctx.strokeStyle = hsla(spikeHue, va.saturation, va.lightness, 1);
        ctx.lineWidth = 4;
        ctx.globalAlpha = alpha * 0.3;
        ctx.beginPath();
        ctx.moveTo(cosA * r0, sinA * r0);
        ctx.lineTo(cosA * r1, sinA * r1);
        ctx.stroke();

        ctx.strokeStyle = hsla(spikeHue + 15, va.saturation, clamp(va.lightness + 15, 45, 95), 1);
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = alpha * 0.85;
        ctx.beginPath();
        ctx.moveTo(cosA * r0, sinA * r0);
        ctx.lineTo(cosA * r1, sinA * r1);
        ctx.stroke();

        ctx.restore();
      }

      // Inner ring: counter-rotation applied relative to current transform
      ctx.save();
      ctx.rotate(rotationInner - rotation);
      for (let i = 0; i < halfSpikes; i++) {
        const angle = (i / halfSpikes) * Math.PI * 2;
        const spikeIdx = i;
        const spike = smoothedSpikes[spikeIdx % NUM_SPIKES] ?? 0;
        const spikeLen = spike * maxSpike;
        const wobble = Math.sin(i * 2.7 + t * 2) * va.wobble * 0.08;
        const r0 = baseRadius * 0.6 * (1 + wobble);
        const r1 = r0 + spikeLen;
        const alpha = running ? clamp01(0.4 + spike * 1.2) : 0.25;
        const spikeHue = spreadHue(va, hue, i / halfSpikes, i);
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';

        ctx.strokeStyle = hsla(spikeHue, va.saturation, va.lightness, 1);
        ctx.lineWidth = 4;
        ctx.globalAlpha = alpha * 0.3;
        ctx.beginPath();
        ctx.moveTo(cosA * r0, sinA * r0);
        ctx.lineTo(cosA * r1, sinA * r1);
        ctx.stroke();

        ctx.strokeStyle = hsla(spikeHue + 15, va.saturation, clamp(va.lightness + 15, 45, 95), 1);
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = alpha * 0.85;
        ctx.beginPath();
        ctx.moveTo(cosA * r0, sinA * r0);
        ctx.lineTo(cosA * r1, sinA * r1);
        ctx.stroke();

        ctx.restore();
      }
      ctx.restore();
    }

    // Inner ring — for ALL variants
    const ringAlpha = running ? (0.5 + smoothBeat * 0.5) : (0.25 + idlePulse(t, 0.5) * 0.15);
    const ringWidth = 1.5 + smoothBeat * 4;
    const ringHue = spreadHue(va, hue, 0, 0);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    ctx.strokeStyle = hsla(ringHue, va.saturation, va.lightness, 1);
    ctx.lineWidth = ringWidth + 6;
    ctx.globalAlpha = ringAlpha * 0.2;
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = hsla(ringHue + 30, va.saturation, clamp(va.lightness + 25, 45, 95), 1);
    ctx.lineWidth = ringWidth;
    ctx.globalAlpha = ringAlpha * 0.9;
    ctx.beginPath();
    ctx.arc(0, 0, baseRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();

    ctx.restore(); // main translate/rotate
  },
};
