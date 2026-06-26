import type { Scene2D, SceneContext } from './types';
import { clamp, clamp01, lerp, hsla, idlePulse, spreadHue, beatTrigger } from './util';

interface Particle {
  x: number;
  y: number;
  px: number;       // previous x for streak drawing
  py: number;       // previous y for streak drawing
  vx: number;
  vy: number;
  life: number;     // 0..1, decreases over time
  maxLife: number;  // seconds
  size: number;
  seedFrac: number; // stable per-particle random fraction from va.rand
  // Orbital variant fields
  orbitR: number;
  orbitAngle: number;
  orbitSpeed: number;
}

let pool: Particle[] = [];
let smoothBass = 0;
let lastVariant = -1;
let lastTargetCount = 0;
// Module-level warp boost for starfield variant
let warpTime = 0;

function makeBaseParticle(): Particle {
  return {
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    vx: 0,
    vy: 0,
    life: 1,
    maxLife: 2,
    size: 2,
    seedFrac: 0,
    orbitR: 0,
    orbitAngle: 0,
    orbitSpeed: 0,
  };
}

function spawnRising(p: Particle, w: number, h: number, index: number, va: { rand: (i: number) => number }): void {
  const seedFrac = va.rand(index);
  p.seedFrac = seedFrac;
  p.x = Math.random() * w;
  p.y = h + 10;
  p.px = p.x;
  p.py = p.y;
  p.vx = (Math.random() - 0.5) * 0.4;
  p.vy = -(0.3 + Math.random() * 0.5);
  p.life = Math.random();
  p.maxLife = 1.5 + Math.random() * 2.5;
  p.size = (1.5 + Math.random() * 3) * 1;
  p.orbitR = 0;
  p.orbitAngle = 0;
  p.orbitSpeed = 0;
}

function spawnRisingRadial(p: Particle, cx: number, cy: number, index: number, va: { rand: (i: number) => number }): void {
  const seedFrac = va.rand(index);
  p.seedFrac = seedFrac;
  const angle = Math.random() * Math.PI * 2;
  const speed = 1.5 + Math.random() * 3;
  p.x = cx;
  p.y = cy;
  p.px = p.x;
  p.py = p.y;
  p.vx = Math.cos(angle) * speed;
  p.vy = Math.sin(angle) * speed;
  p.life = 1;
  p.maxLife = 1.5 + Math.random() * 2.5;
  p.size = 1.5 + Math.random() * 3;
  p.orbitR = 0;
  p.orbitAngle = 0;
  p.orbitSpeed = 0;
}

function spawnOrbital(p: Particle, cx: number, cy: number, index: number, va: { rand: (i: number) => number; scale: number }): void {
  const r0 = va.rand(index * 3);
  const r1 = va.rand(index * 3 + 1);
  const r2 = va.rand(index * 3 + 2);
  p.seedFrac = r0;
  const minR = Math.min(cx, cy) * 0.1;
  const maxR = Math.min(cx, cy) * 0.85;
  p.orbitR = (minR + r0 * (maxR - minR)) * va.scale;
  p.orbitAngle = r1 * Math.PI * 2;
  p.orbitSpeed = (0.3 + r2 * 0.7) * (Math.PI / 4); // rad/s
  p.x = cx + Math.cos(p.orbitAngle) * p.orbitR;
  p.y = cy + Math.sin(p.orbitAngle) * p.orbitR;
  p.px = p.x;
  p.py = p.y;
  p.vx = 0;
  p.vy = 0;
  p.life = 1;
  p.maxLife = 999; // effectively immortal; reset by pool re-init
  p.size = 1.5 + Math.random() * 3;
}

function spawnRain(p: Particle, w: number, index: number, va: { rand: (i: number) => number; scale: number; speed: number }): void {
  const seedFrac = va.rand(index);
  p.seedFrac = seedFrac;
  p.x = Math.random() * w;
  p.y = -(10 + Math.random() * 50);
  p.px = p.x;
  p.py = p.y;
  p.vx = (Math.random() - 0.5) * 0.5;
  p.vy = (2 + Math.random() * 3) * va.speed;
  p.life = 1;
  p.maxLife = 2 + Math.random() * 2;
  p.size = (1 + Math.random() * 2) * va.scale;
  p.orbitR = 0;
  p.orbitAngle = 0;
  p.orbitSpeed = 0;
}

function spawnStarfield(p: Particle, cx: number, cy: number, index: number, va: { rand: (i: number) => number }): void {
  const seedFrac = va.rand(index);
  p.seedFrac = seedFrac;
  // Start near center with a direction angle
  const angle = Math.random() * Math.PI * 2;
  const startDist = 5 + Math.random() * 20;
  p.x = cx + Math.cos(angle) * startDist;
  p.y = cy + Math.sin(angle) * startDist;
  p.px = p.x;
  p.py = p.y;
  p.vx = Math.cos(angle) * (0.5 + Math.random() * 1.5);
  p.vy = Math.sin(angle) * (0.5 + Math.random() * 1.5);
  p.life = 1;
  p.maxLife = 2 + Math.random() * 2;
  p.size = 1 + Math.random() * 2;
  p.orbitR = 0;
  p.orbitAngle = 0;
  p.orbitSpeed = 0;
}

function initPool(
  count: number,
  w: number,
  h: number,
  variant: number,
  va: { rand: (i: number) => number; scale: number; speed: number },
): void {
  pool = [];
  const cx = w * 0.5;
  const cy = h * 0.5;

  for (let i = 0; i < count; i++) {
    const p = makeBaseParticle();
    if (variant === 0) {
      spawnRising(p, w, h, i, va);
      p.x = Math.random() * w;
      p.y = Math.random() * h;
      p.life = Math.random();
    } else if (variant === 1) {
      spawnOrbital(p, cx, cy, i, va);
      p.orbitAngle = Math.random() * Math.PI * 2; // scatter initial angles
    } else if (variant === 2) {
      spawnRain(p, w, i, va);
      // Scatter initial positions
      p.y = Math.random() * h;
    } else {
      spawnStarfield(p, cx, cy, i, va);
      // Scatter: start at random distance from center
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * Math.min(cx, cy);
      p.x = cx + Math.cos(angle) * dist;
      p.y = cy + Math.sin(angle) * dist;
      p.px = p.x;
      p.py = p.y;
      p.life = Math.random();
    }
    pool.push(p);
  }
}

export const particlesScene: Scene2D = {
  kind: '2d',
  id: 'particles',
  name: 'Particles',
  trail: 0.65,

  init() {
    pool = [];
    smoothBass = 0;
    lastVariant = -1;
    lastTargetCount = 0;
    warpTime = 0;
  },

  draw(s: SceneContext) {
    const { ctx, w, h, t, audio, va } = s;
    const { bass, level, running } = audio;
    const beat = beatTrigger(audio);

    const cx = w * 0.5;
    const cy = h * 0.5;

    const targetCount = clamp(Math.round(250 * va.density), 120, 450);
    const variant = va.variant;

    if (pool.length === 0 || variant !== lastVariant || targetCount !== lastTargetCount) {
      initPool(targetCount, w, h, variant, va);
      lastVariant = variant;
      lastTargetCount = targetCount;
    }

    smoothBass = lerp(smoothBass, running ? bass : 0, 0.15);

    const speedMul = (1 + smoothBass * 2.2) * va.speed;
    const idleAmt = running ? 0 : idlePulse(t, 0.3);

    // Draw streak or dot based on va.shape
    const useStreak = va.shape >= 0.5;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Variant-specific beat handling
    if (beat && running) {
      if (variant === 0) {
        // Rising: burst radial particles
        const burstCount = Math.min(20, targetCount - pool.length);
        for (let bi = 0; bi < burstCount; bi++) {
          const p = makeBaseParticle();
          spawnRisingRadial(p, cx, cy, pool.length + bi, va);
          pool.push(p);
        }
        for (const p of pool) {
          const dx = p.x - cx;
          const dy = p.y - cy;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          p.vx += (dx / d) * 1.5;
          p.vy += (dy / d) * 1.5;
        }
      } else if (variant === 1) {
        // Orbital: add 20px impulse to orbit radius
        for (const p of pool) {
          p.orbitR += 20;
        }
      } else if (variant === 2) {
        // Rain: upward burst for some particles
        for (const p of pool) {
          if (Math.random() < 0.3) {
            p.vy = -(5 + Math.random() * 5);
          }
        }
      } else {
        // Starfield: warp boost
        warpTime = 2.0;
      }
    }

    // Decay warp
    if (variant === 3 && warpTime > 0) {
      warpTime = Math.max(0, warpTime - s.dt);
    }

    for (let i = pool.length - 1; i >= 0; i--) {
      const p = pool[i]!;
      p.px = p.x;
      p.py = p.y;

      if (variant === 0) {
        // Rising drift
        const turbX = running ? (Math.random() - 0.5) * 0.3 * smoothBass : 0;
        const turbY = running ? (Math.random() - 0.5) * 0.3 * smoothBass : 0;
        p.vx = lerp(p.vx, turbX, 0.05);
        p.vy += turbY * s.dt * 60;
        p.x += p.vx * speedMul;
        p.y += p.vy * speedMul - (0.25 + idleAmt * 0.2);
        p.life -= s.dt / p.maxLife;

        if (p.life <= 0 || p.x < -20 || p.x > w + 20 || p.y < -40) {
          spawnRising(p, w, h, i, va);
        }
      } else if (variant === 1) {
        // Orbital
        const dir = va.direction;
        p.orbitAngle += p.orbitSpeed * s.dt * dir;
        // Decay impulse back to base radius (soft spring)
        const baseR = (va.rand(i * 3) * (Math.min(cx, cy) * 0.75)) * va.scale;
        p.orbitR = lerp(p.orbitR, baseR, 0.02);
        p.x = cx + Math.cos(p.orbitAngle) * p.orbitR;
        p.y = cy + Math.sin(p.orbitAngle) * p.orbitR;
        // Orbital particles don't die; life just used for alpha fading
        p.life = 1;
      } else if (variant === 2) {
        // Rain: falling streaks
        p.vy = lerp(p.vy, (2 + va.rand(i) * 3) * va.speed, 0.05);
        p.y += p.vy * speedMul * s.dt * 60;
        p.x += p.vx * speedMul;
        p.life -= s.dt / p.maxLife;

        if (p.life <= 0 || p.y > h + 20) {
          spawnRain(p, w, i, va);
        }
      } else {
        // Starfield: stream outward from center with acceleration
        const warpMul = warpTime > 0 ? 1 + warpTime * 3 : 1;
        const accel = 1.02 * warpMul;
        p.vx *= accel;
        p.vy *= accel;
        p.x += p.vx * speedMul * va.direction;
        p.y += p.vy * speedMul * va.direction;
        p.life -= s.dt / p.maxLife;

        if (p.life <= 0 || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) {
          spawnStarfield(p, cx, cy, i, va);
        }
      }

      const alpha = clamp01(p.life * (running ? (0.5 + level * 0.6) : 0.3));
      const pHue = spreadHue(va, s.hue, p.seedFrac, Math.round(p.seedFrac * 100));
      const sz = clamp(p.size * va.scale * clamp01(p.life * 2), 0.5, 30);

      if (useStreak) {
        // Motion streak: line from prev position to current
        const dx = p.x - p.px;
        const dy = p.y - p.py;
        const streakLen = Math.sqrt(dx * dx + dy * dy);
        if (streakLen > 0.5) {
          ctx.globalAlpha = alpha * 0.7;
          ctx.strokeStyle = hsla(pHue, va.saturation, va.lightness, 1);
          ctx.lineWidth = sz * 0.8;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p.px, p.py);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          // Core bright streak
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = hsla(pHue + 20, 100, 92, 1);
          ctx.lineWidth = sz * 0.25;
          ctx.beginPath();
          ctx.moveTo(p.px, p.py);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
      } else {
        // Dot glow
        ctx.globalAlpha = alpha * 0.18;
        ctx.fillStyle = hsla(pHue, va.saturation, va.lightness, 1);
        ctx.beginPath();
        ctx.arc(p.x, p.y, sz * 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = alpha * 0.55;
        ctx.fillStyle = hsla(pHue + 15, va.saturation, va.lightness + 10, 1);
        ctx.beginPath();
        ctx.arc(p.x, p.y, sz * 1.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = alpha;
        ctx.fillStyle = hsla(pHue + 25, 100, 95, 1);
        ctx.beginPath();
        ctx.arc(p.x, p.y, sz * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Trim excess or top up pool
    while (pool.length > targetCount) {
      pool.pop();
    }
    while (pool.length < targetCount) {
      const p = makeBaseParticle();
      const idx = pool.length;
      if (variant === 0) {
        spawnRising(p, w, h, idx, va);
        p.x = Math.random() * w;
        p.y = Math.random() * h;
        p.life = Math.random();
      } else if (variant === 1) {
        spawnOrbital(p, cx, cy, idx, va);
      } else if (variant === 2) {
        spawnRain(p, w, idx, va);
        p.y = Math.random() * h;
      } else {
        spawnStarfield(p, cx, cy, idx, va);
      }
      pool.push(p);
    }

    ctx.restore();
  },
};
