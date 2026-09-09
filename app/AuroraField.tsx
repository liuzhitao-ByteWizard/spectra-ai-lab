"use client";

import { useEffect, useRef } from "react";

type AuroraFieldProps = {
  className?: string;
  intensity?: number;
  scrollProgress?: number;
  paused?: boolean;
};

const vertexShaderSource = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision highp float;

uniform vec2 u_resolution;
uniform vec2 u_pointer;
uniform float u_time;
uniform float u_intensity;
uniform float u_scroll;
varying vec2 v_uv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  mat2 rotation = mat2(0.84, 0.54, -0.54, 0.84);
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = rotation * p * 2.02 + 9.7;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 resolution = max(u_resolution, vec2(1.0));
  vec2 p = (2.0 * gl_FragCoord.xy - resolution.xy) / min(resolution.x, resolution.y);
  p.x += (u_pointer.x - 0.5) * 0.13;
  p.y += (u_pointer.y - 0.5) * 0.08;

  float time = u_time * 0.12;
  vec2 q = vec2(
    fbm(p * 0.72 + vec2(time, -time * 0.36)),
    fbm(p * 0.72 + vec2(4.6, 1.9) - vec2(time * 0.42, time * 0.23))
  );
  vec2 warped = p + 1.72 * (q - 0.5);
  float field = fbm(warped * 1.08 + vec2(-time * 0.34, time * 0.22));
  float fine = fbm(warped * 2.65 - vec2(time * 0.54, 0.0));

  float sweep = p.y + 0.36 * sin(p.x * 1.42 + time * 1.9) + 0.52 * (field - 0.5);
  float ribbon = exp(-abs(sweep + 0.03) * 3.35);
  float upperRibbon = exp(-abs(sweep - 0.82 + 0.20 * sin(p.x * 2.1 - time)) * 5.2);
  float sideGlow = exp(-length(p - vec2(-1.02, 0.16)) * 1.16);
  float blueField = smoothstep(0.18, 0.84, field + ribbon * 0.33);
  float highlight = pow(clamp(ribbon * (0.46 + 0.76 * fine), 0.0, 1.0), 2.25);

  vec3 color = vec3(0.006, 0.026, 0.071);
  color = mix(color, vec3(0.018, 0.16, 0.38), blueField * 0.88);
  color += vec3(0.016, 0.26, 0.72) * ribbon * (0.30 + field * 0.42);
  color += vec3(0.12, 0.54, 1.0) * upperRibbon * 0.24;
  color += vec3(0.03, 0.34, 0.82) * sideGlow * 0.18;
  color += vec3(0.62, 0.83, 1.0) * highlight * 0.48;

  vec2 dotCell = fract(gl_FragCoord.xy / 3.25) - 0.5;
  float dotShape = 1.0 - smoothstep(0.08, 0.31, length(dotCell));
  float dotMask = smoothstep(0.58, 0.87, fine + ribbon * 0.24) * (0.30 + 0.70 * ribbon);
  color += vec3(0.38, 0.72, 1.0) * dotShape * dotMask * 0.19;

  float vignette = 1.0 - smoothstep(0.62, 1.64, length(p * vec2(0.73, 1.0)));
  color *= 0.54 + 0.46 * vignette;
  color *= u_intensity;
  color *= 1.0 - u_scroll * 0.36;
  color = pow(color, vec3(0.88));

  gl_FragColor = vec4(color, 1.0);
}
`;

function createShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export default function AuroraField({
  className = "",
  intensity = 1,
  scrollProgress = 0,
  paused = false,
}: AuroraFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intensityRef = useRef(intensity);
  const scrollRef = useRef(scrollProgress);
  const pausedRef = useRef(paused);

  useEffect(() => { intensityRef.current = intensity; }, [intensity]);
  useEffect(() => { scrollRef.current = scrollProgress; }, [scrollProgress]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      canvas.classList.add("aurora-fallback");
      return;
    }

    const vertex = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) {
      canvas.classList.add("aurora-fallback");
      return;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      canvas.classList.add("aurora-fallback");
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    const pointerLocation = gl.getUniformLocation(program, "u_pointer");
    const timeLocation = gl.getUniformLocation(program, "u_time");
    const intensityLocation = gl.getUniformLocation(program, "u_intensity");
    const scrollLocation = gl.getUniformLocation(program, "u_scroll");

    const pointer = { x: 0.58, y: 0.42, targetX: 0.58, targetY: 0.42 };
    let frame = 0;
    let mobile = false;
    let visible = true;
    let documentVisible = !document.hidden;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionQuery.matches;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      mobile = window.matchMedia("(max-width: 780px)").matches;
      const pixelRatio = mobile ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const draw = (timestamp: number) => {
      pointer.x += (pointer.targetX - pointer.x) * 0.035;
      pointer.y += (pointer.targetY - pointer.y) * 0.035;
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform2f(pointerLocation, pointer.x, pointer.y);
      gl.uniform1f(timeLocation, reducedMotion ? 11.0 : timestamp * 0.001 * (mobile ? 0.68 : 1));
      gl.uniform1f(intensityLocation, intensityRef.current);
      gl.uniform1f(scrollLocation, Math.min(1, Math.max(0, scrollRef.current)));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const animate = (timestamp: number) => {
      if (visible && documentVisible && !pausedRef.current && !reducedMotion) draw(timestamp);
      frame = window.requestAnimationFrame(animate);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointer.targetX = event.clientX / Math.max(window.innerWidth, 1);
      pointer.targetY = 1 - event.clientY / Math.max(window.innerHeight, 1);
    };
    const onVisibilityChange = () => { documentVisible = !document.hidden; };
    const onMotionChange = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      if (reducedMotion) draw(0);
    };
    const resizeObserver = new ResizeObserver(resize);
    const intersectionObserver = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { rootMargin: "80px" });

    resizeObserver.observe(canvas);
    intersectionObserver.observe(canvas);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    motionQuery.addEventListener("change", onMotionChange);
    resize();
    draw(0);
    frame = window.requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      motionQuery.removeEventListener("change", onMotionChange);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, []);

  return <canvas ref={canvasRef} className={`aurora-field ${className}`.trim()} aria-hidden="true" />;
}
