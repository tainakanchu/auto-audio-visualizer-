import type { Scene2D, SceneContext } from './types';
import type { Variation } from '../variation/types';
import { clamp, clamp01, lerp, hsla, idlePulse, spreadHue, beatPulse, beatTrigger } from './util';

interface Ring {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
  hue: number;
  lineWidth: number;
  speed: number;
  sides: number;
  segmentCount: number;
  spawnAngleOffset: number;
  rotationRate: number;
}

let rings: Ring[] = [];
let smoothBass = 0;
let idleTimer = 0;
let spawnCounter = 0;
const IDLE_INTERVAL = 1.4;

function spawnRing(
  cx: number,
  cy: number,
  w: number,
  h: number,
  baseHue: number,
  beatIntensity: number,
  bass: number,
  fromBeat: boolean,
  va: Variation,
): void {
  const bi = fromBeat ? clamp01(beatIntensity) : 0.25;
  const sides = clamp(3 + Math.round(va.shape * 5), 3, 8);
  const segmentCount = va.symmetry;
  const spawnAngleOffset = Math.random() * Math.PI * 2;
  const rotationRate = (0.3 + Math.random() * 0.5) * va.speed * (Math.random() < 0.5 ? 1 : -1);

  const variant = va.variant;

  let spawnX: number;
  let spawnY: number;
  if (variant === 3) {
    spawnX = va.rand(spawnCounter) * w;
    spawnY = va.rand(spawnCounter + 37) * h;
  } else {
    spawnX = cx;
    spawnY = cy;
  }

  spawnCounter++;

  const maxR =
    variant === 3
      ? Math.max(Math.max(spawnX, w - spawnX), Math.max(spawnY, h - spawnY)) *
        (1.1 + Math.random() * 0.4)
      : Math.max(cx, cy) * (1.1 + Math.random() * 0.4);

  const ringHue = spreadHue(va, baseHue, Math.random(), undefined);

  rings.push({
    x: spawnX,
    y: spawnY,
    radius: 4 + bi * 30,
    maxRadius: maxR,
    alpha: 0.7 + bi * 0.3,
    hue: ringHue,
    lineWidth: 1 + bi * 5 + bass * 3,
    speed: (120 + bass * 180 + bi * 80 + Math.random() * 40) * va.speed,
    sides,
    segmentCount,
    spawnAngleOffset,
    rotationRate,
  });
}

export const ringsScene: Scene2D = {
  kind: '2d',
  id: 'rings',
  name: 'Rings',
  trail: 0.45,

  init() {
    rings = [];
    smoothBass = 0;
    idleTimer = 0;
    spawnCounter = 0;
  },

  draw(s: SceneContext) {
    const { ctx, w, h, t, dt, audio, hue, va } = s;
    const { bass, running } = audio;
    const beat = beatTrigger(audio);
    const pulse = beatPulse(audio);

    const cx = w * 0.5;
    const cy = h * 0.5;

    smoothBass = lerp(smoothBass, running ? bass : 0, 0.12);

    if (beat && running) {
      spawnRing(cx, cy, w, h, hue, pulse, smoothBass, true, va);
    }

    idleTimer += dt;
    if (idleTimer >= IDLE_INTERVAL) {
      idleTimer -= IDLE_INTERVAL;
      if (!beat) {
        spawnRing(cx, cy, w, h, hue, 0, smoothBass, false, va);
      }
    }

    const variant = va.variant;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (let i = rings.length - 1; i >= 0; i--) {
      const ring = rings[i]!;

      ring.spawnAngleOffset += ring.rotationRate * dt;
      ring.radius += ring.speed * dt * (1 + smoothBass * 0.8);

      const progress = ring.radius / ring.maxRadius;
      ring.alpha = clamp01((1 - progress) * (1 - progress));

      if (ring.alpha < 0.005 || ring.radius > ring.maxRadius) {
        rings.splice(i, 1);
        continue;
      }

      const effectiveAlpha = ring.alpha * (running ? 1 : 0.55);
      const lw = ring.lineWidth * (0.3 + ring.alpha * 0.7);

      if (variant === 0 || variant === 3) {
        // Circles (variant 0 = centered, variant 3 = off-center using ring.x/ring.y)
        ctx.strokeStyle = hsla(ring.hue, va.saturation, va.lightness, 1);
        ctx.lineWidth = lw + 8;
        ctx.globalAlpha = effectiveAlpha * 0.12;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = hsla(ring.hue + 20, va.saturation, clamp(va.lightness + 10, 45, 95), 1);
        ctx.lineWidth = lw + 3;
        ctx.globalAlpha = effectiveAlpha * 0.35;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = hsla(ring.hue + 40, va.saturation, clamp(va.lightness + 25, 45, 95), 1);
        ctx.lineWidth = Math.max(0.8, lw * 0.5);
        ctx.globalAlpha = effectiveAlpha * 0.9;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
        ctx.stroke();
      } else if (variant === 1) {
        // Polygons
        ctx.save();
        ctx.translate(ring.x, ring.y);
        ctx.rotate(ring.spawnAngleOffset);

        // Layer 1: outer glow
        ctx.strokeStyle = hsla(ring.hue, va.saturation, va.lightness, 1);
        ctx.lineWidth = lw + 8;
        ctx.globalAlpha = effectiveAlpha * 0.12;
        ctx.beginPath();
        for (let k = 0; k < ring.sides; k++) {
          const angle = (k / ring.sides) * Math.PI * 2;
          if (k === 0) {
            ctx.moveTo(Math.cos(angle) * ring.radius, Math.sin(angle) * ring.radius);
          } else {
            ctx.lineTo(Math.cos(angle) * ring.radius, Math.sin(angle) * ring.radius);
          }
        }
        ctx.closePath();
        ctx.stroke();

        // Layer 2: mid
        ctx.strokeStyle = hsla(ring.hue + 20, va.saturation, clamp(va.lightness + 10, 45, 95), 1);
        ctx.lineWidth = lw + 3;
        ctx.globalAlpha = effectiveAlpha * 0.35;
        ctx.beginPath();
        for (let k = 0; k < ring.sides; k++) {
          const angle = (k / ring.sides) * Math.PI * 2;
          if (k === 0) {
            ctx.moveTo(Math.cos(angle) * ring.radius, Math.sin(angle) * ring.radius);
          } else {
            ctx.lineTo(Math.cos(angle) * ring.radius, Math.sin(angle) * ring.radius);
          }
        }
        ctx.closePath();
        ctx.stroke();

        // Layer 3: bright core
        ctx.strokeStyle = hsla(ring.hue + 40, va.saturation, clamp(va.lightness + 25, 45, 95), 1);
        ctx.lineWidth = Math.max(0.8, lw * 0.5);
        ctx.globalAlpha = effectiveAlpha * 0.9;
        ctx.beginPath();
        for (let k = 0; k < ring.sides; k++) {
          const angle = (k / ring.sides) * Math.PI * 2;
          if (k === 0) {
            ctx.moveTo(Math.cos(angle) * ring.radius, Math.sin(angle) * ring.radius);
          } else {
            ctx.lineTo(Math.cos(angle) * ring.radius, Math.sin(angle) * ring.radius);
          }
        }
        ctx.closePath();
        ctx.stroke();

        ctx.restore();
      } else {
        // variant === 2: arc segments
        const segSpan = (Math.PI * 2 / ring.segmentCount) * 0.6;

        // Layer 1: glow
        ctx.strokeStyle = hsla(ring.hue, va.saturation, va.lightness, 1);
        ctx.lineWidth = lw + 8;
        ctx.globalAlpha = effectiveAlpha * 0.12;
        for (let k = 0; k < ring.segmentCount; k++) {
          const startAngle = ring.spawnAngleOffset + k * (Math.PI * 2 / ring.segmentCount);
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, ring.radius, startAngle, startAngle + segSpan);
          ctx.stroke();
        }

        // Layer 2: bright core
        ctx.strokeStyle = hsla(ring.hue + 40, va.saturation, clamp(va.lightness + 25, 45, 95), 1);
        ctx.lineWidth = Math.max(0.8, lw * 0.5);
        ctx.globalAlpha = effectiveAlpha * 0.9;
        for (let k = 0; k < ring.segmentCount; k++) {
          const startAngle = ring.spawnAngleOffset + k * (Math.PI * 2 / ring.segmentCount);
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, ring.radius, startAngle, startAngle + segSpan);
          ctx.stroke();
        }
      }
    }

    // Idle breathing ring when !running and no rings
    if (!running && rings.length === 0) {
      const idleAmt = idlePulse(t, 0.35);
      const pr = Math.min(cx, cy) * (0.1 + idleAmt * 0.12);
      const idleHue = spreadHue(va, hue, 0.5);
      ctx.strokeStyle = hsla(idleHue, va.saturation, va.lightness, 1);
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.2 + idleAmt * 0.15;
      ctx.beginPath();
      ctx.arc(cx, cy, pr, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  },
};
