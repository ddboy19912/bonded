import { useEffect, useRef } from "react";

/**
 * The landing hero's picture: the Bonded mark drawn in characters, lit from the top left so it
 * reads as a raised relief, with attack payloads (hex strings, the red team's material) flying in
 * from the left and stopping dead at its edge. Each hit sends a short ring of light across the
 * characters, which is the "held" in Bonded's own terms.
 *
 * It is a canvas on purpose: the pixels are read once, the glyphs are prebuilt in an atlas and
 * only a few cells change per step, at about 12 steps a second, and it pauses off screen. Under
 * reduced motion it draws one still frame.
 */

/** The two shapes of the brand mark, in its own 200 by 212 units (public/brand/bonded-symbol-blue.svg). */
const MARK = [
  "M7 0H130C159 0 182 23 182 51C182 75 170 90 149 101L112 121Q101 127 101 114V75Q101 49 73 61L7 90Q0 94 0 86V7Q0 0 7 0Z",
  "M0 130Q0 122 8 118L58 92Q77 82 77 101V137Q77 159 97 149L169 113Q175 110 180 117C193 129 200 143 200 158C200 190 172 212 136 212H6Q0 212 0 206Z",
];
const MARK_W = 200;
const MARK_H = 212;

const GRID = 52;
const BASE = ".:+*#";
const HEX = "0123456789abcdef";
const CHARS = BASE + HEX;
/** Blue for the mark, dim to bright; orange for the attack, dim to bright. */
const BLUES = ["#1a3485", "#2548b8", "#3a6bff", "#6f94ff", "#a9c0ff", "#eef3ff"];
const ORANGES = ["#7d3013", "#ff7a45", "#ffd2bd"];
const TINTS = [...BLUES, ...ORANGES];
const ORANGE_AT = BLUES.length;
const STEP_MS = 85;

interface Field {
  light: Float32Array;
  /** First column of the mark on each row, or -1 where the row has none. */
  edge: Int16Array;
}

function drawMark(ctx: CanvasRenderingContext2D, size: number) {
  const scale = (size * 0.8) / MARK_H;
  ctx.setTransform(scale, 0, 0, scale, (size - MARK_W * scale) / 2, (size - MARK_H * scale) / 2);
  ctx.fillStyle = "#fff";
  for (const d of MARK) ctx.fill(new Path2D(d));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Three passes of a box blur, close to a gaussian, on a square grid. */
function blur(src: Float32Array, n: number, radius: number): Float32Array {
  let a = src;
  for (let pass = 0; pass < 3; pass++) {
    for (const horizontal of [true, false]) {
      const out = new Float32Array(n * n);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          let sum = 0;
          for (let k = -radius; k <= radius; k++) {
            const xx = horizontal ? Math.min(n - 1, Math.max(0, x + k)) : x;
            const yy = horizontal ? y : Math.min(n - 1, Math.max(0, y + k));
            sum += a[yy * n + xx]!;
          }
          out[y * n + x] = sum / (radius * 2 + 1);
        }
      }
      a = out;
    }
  }
  return a;
}

/** Read the mark once into a lit height map: raised in the middle, bright where it faces the light. */
function buildField(): Field {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = GRID;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  drawMark(ctx, GRID);
  const px = ctx.getImageData(0, 0, GRID, GRID).data;
  const mask = new Float32Array(GRID * GRID);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3]! / 255;
  const height = blur(mask, GRID, 2);
  const halo = blur(mask, GRID, 4);
  const light = new Float32Array(GRID * GRID);
  const edge = new Int16Array(GRID).fill(-1);
  const at = (a: Float32Array, x: number, y: number) =>
    a[Math.min(GRID - 1, Math.max(0, y)) * GRID + Math.min(GRID - 1, Math.max(0, x))]!;
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const i = y * GRID + x;
      if (mask[i]! > 0.5 && edge[y] === -1) edge[y] = x;
      if (mask[i]! > 0.08) {
        const gx = at(height, x + 1, y) - at(height, x - 1, y);
        const gy = at(height, x, y + 1) - at(height, x, y - 1);
        const facing = -(gx * -0.6 + gy * -0.8);
        light[i] = Math.min(1, Math.max(0.34, 0.5 + 0.3 * height[i]! + 2.2 * facing));
      } else {
        light[i] = Math.min(0.16, halo[i]! * 0.3);
      }
    }
  }
  return { light, edge };
}

/** One glyph per character and tint, so a frame is only drawImage calls. */
function buildAtlas(cell: number): HTMLCanvasElement {
  const atlas = document.createElement("canvas");
  atlas.width = cell * CHARS.length;
  atlas.height = cell * TINTS.length;
  const pen = atlas.getContext("2d")!;
  pen.font = `500 ${Math.round(cell * 0.92)}px "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace`;
  pen.textAlign = "center";
  pen.textBaseline = "middle";
  TINTS.forEach((tint, row) => {
    pen.fillStyle = tint;
    [...CHARS].forEach((ch, col) => pen.fillText(ch, col * cell + cell / 2, row * cell + cell / 2));
  });
  return atlas;
}

interface Stream {
  y: number;
  x: number;
  speed: number;
  len: number;
}
interface Hit {
  x: number;
  y: number;
  t: number;
}

export function MarkField({ className = "" }: { className?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = wrap.current;
    const el = canvas.current;
    if (!host || !el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let cancelled = false;
    let stop = () => {};

    void document.fonts.load('500 12px "JetBrains Mono Variable"').finally(() => {
      if (cancelled) return;
      const field = buildField();
      const rows: number[] = [];
      for (let y = 0; y < GRID; y++) if (field.edge[y]! >= 0) rows.push(y);
      let atlas: HTMLCanvasElement;
      let cell = 8;
      let device = 8;
      const resize = () => {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const size = Math.max(240, Math.round(host.clientWidth * dpr));
        el.width = el.height = size;
        device = size / GRID;
        cell = Math.max(4, Math.ceil(device));
        atlas = buildAtlas(cell);
      };
      resize();
      const observer = new ResizeObserver(() => {
        resize();
        draw();
      });
      observer.observe(host);

      const streams: Stream[] = [];
      const hits: Hit[] = [];
      let step = 0;

      const put = (x: number, y: number, ch: number, tint: number) => {
        ctx.drawImage(
          atlas,
          ch * cell,
          tint * cell,
          cell,
          cell,
          x * device,
          y * device,
          device,
          device,
        );
      };

      function draw() {
        ctx!.clearRect(0, 0, el!.width, el!.height);
        for (let y = 0; y < GRID; y++) {
          for (let x = 0; x < GRID; x++) {
            const l = field.light[y * GRID + x]!;
            if (l < 0.08) continue;
            const shimmer = (step * 7919 + (y * GRID + x) * 104729) % 61 === 0 ? 1 : 0;
            const ch = Math.min(BASE.length - 1, Math.floor(l * BASE.length) + shimmer);
            put(x, y, ch, Math.min(BLUES.length - 1, Math.floor(l ** 1.8 * (BLUES.length + 0.8))));
          }
        }
        for (const s of streams) {
          const head = Math.floor(s.x);
          for (let k = 0; k < s.len; k++) {
            const x = head - k;
            if (x < 0 || x >= GRID) continue;
            const ch = BASE.length + ((x * 5 + s.y * 3 + step * (k + 1)) % HEX.length);
            put(x, s.y, ch, ORANGE_AT + (k === 0 ? 2 : k < s.len / 2 ? 1 : 0));
          }
        }
        for (const h of hits) {
          const r = h.t * 1.1;
          const tint = Math.max(2, BLUES.length - 1 - Math.floor(h.t / 2));
          for (let dy = -Math.ceil(r) - 1; dy <= Math.ceil(r) + 1; dy++) {
            for (let dx = -Math.ceil(r) - 1; dx <= Math.ceil(r) + 1; dx++) {
              const d = Math.hypot(dx, dy);
              if (d < r - 1.2 || d > r) continue;
              const x = h.x + dx;
              const y = h.y + dy;
              if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue;
              put(x, y, 2, tint);
            }
          }
        }
      }

      const advance = () => {
        step++;
        if (streams.length < 9 && Math.random() < 0.55) {
          const len = 5 + Math.floor(Math.random() * 6);
          streams.push({
            y: rows[Math.floor(Math.random() * rows.length)]!,
            x: -len,
            speed: 1 + Math.random() * 1.5,
            len,
          });
        }
        for (let i = streams.length - 1; i >= 0; i--) {
          const s = streams[i]!;
          s.x += s.speed;
          const wall = field.edge[s.y]! - 1;
          if (Math.floor(s.x) >= wall) {
            hits.push({ x: wall + 1, y: s.y, t: 0 });
            streams.splice(i, 1);
          }
        }
        for (let i = hits.length - 1; i >= 0; i--) {
          hits[i]!.t++;
          if (hits[i]!.t > 9) hits.splice(i, 1);
        }
      };

      draw();
      if (reduced) {
        stop = () => observer.disconnect();
        return;
      }
      let visible = true;
      const io = new IntersectionObserver(([entry]) => (visible = !!entry?.isIntersecting));
      io.observe(el);
      let frame = 0;
      let last = 0;
      const loop = (now: number) => {
        frame = requestAnimationFrame(loop);
        if (!visible || now - last < STEP_MS) return;
        last = now;
        advance();
        draw();
      };
      frame = requestAnimationFrame(loop);
      stop = () => {
        cancelAnimationFrame(frame);
        io.disconnect();
        observer.disconnect();
      };
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  return (
    <div
      ref={wrap}
      role="img"
      aria-label="The Bonded mark drawn in characters, with attack strings flying in from the left and stopping at its edge."
      className={`relative aspect-square w-full [mask-image:radial-gradient(closest-side,#000_88%,transparent)] ${className}`}
    >
      <canvas ref={canvas} className="size-full" aria-hidden />
    </div>
  );
}
