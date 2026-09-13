"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  Aperture, ArrowRight, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert,
  Crosshair, Download, Eye, Focus, Gauge, GraduationCap, Layers3, Lightbulb,
  Maximize2, Move3D, Rotate3D, RotateCcw, SlidersHorizontal, Target, Telescope,
} from "lucide-react";
import { toast } from "sonner";
import { measureGrating, SPECTRAL_LIBRARY, type MeasurementLine, type SpectrumLine } from "@/lib/spectrometer";
import type { ExperimentJourney } from "@/lib/experiment-journey";

type ModuleId = "home" | "simulator" | "assistant" | "analysis" | "guide" | "records";
type LabMode = "guided" | "free";
type MouseTool = "view" | "telescope" | "stage";
type CameraView = "orbit" | "top" | "side";

type MercuryLine = SpectrumLine & { label: string; weak?: boolean };
type VernierReading = { a: number; b: number; mean: number };
type ZeroReference = VernierReading & { phiDeg: number; aligned: boolean };
type Reading = {
  id: string;
  wavelengthNm: number;
  label: string;
  raw: VernierReading;
  thetaDeg: number;
  calculatedNm: number;
  errorPercent: number;
  aligned: boolean;
};

type Props = {
  journey: ExperimentJourney;
  navigate: (id: ModuleId) => void;
  updateJourney: (patch: Partial<ExperimentJourney>) => void;
};

type SceneRuntime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  stageGroup: THREE.Group;
  telescopeGroup: THREE.Group;
  beams: THREE.Group;
  lamp: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  animationFrame: number;
};

const MERCURY_LINES: MercuryLine[] = [
  { ...SPECTRAL_LIBRARY.mercury[0], label: "紫线" },
  { ...SPECTRAL_LIBRARY.mercury[1], label: "蓝线" },
  { wavelengthNm: 491.6, color: "#2cd8d1", family: "blue", intensity: .22, label: "青色弱线", weak: true },
  { ...SPECTRAL_LIBRARY.mercury[2], label: "绿线" },
  { ...SPECTRAL_LIBRARY.mercury[3], label: "黄线 1" },
  { ...SPECTRAL_LIBRARY.mercury[4], label: "黄线 2" },
];

const SYSTEM_ZERO_OFFSET = .38;
const ECCENTRICITY = .018;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const toRadians = (value: number) => value * Math.PI / 180;
const toDegrees = (value: number) => value * 180 / Math.PI;
const normalize360 = (value: number) => ((value % 360) + 360) % 360;
const signedAngleDelta = (to: number, from: number) => ((to - from + 540) % 360) - 180;
const quantizeArcminute = (value: number) => Math.round(value * 60) / 60;

function formatDms(value: number) {
  const normalized = normalize360(value);
  const degrees = Math.floor(normalized);
  const minutes = Math.round((normalized - degrees) * 60);
  return `${degrees}° ${String(minutes === 60 ? 0 : minutes).padStart(2, "0")}′`;
}

function formatSignedDms(value: number) {
  const sign = value < 0 ? "−" : "+";
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutes = Math.round((absolute - degrees) * 60);
  return `${sign}${degrees}° ${String(minutes === 60 ? 0 : minutes).padStart(2, "0")}′`;
}

function makeVernierReadings(phiDeg: number): VernierReading {
  const eccentric = ECCENTRICITY * Math.sin(toRadians(phiDeg * 3.1 + 27));
  const a = quantizeArcminute(normalize360(phiDeg + SYSTEM_ZERO_OFFSET + eccentric));
  const b = quantizeArcminute(normalize360(phiDeg + 180 + SYSTEM_ZERO_OFFSET - eccentric));
  const bResolved = b >= 180 ? b - 180 : b + 180;
  const mean = quantizeArcminute((a + bResolved) / 2);
  return { a, b, mean };
}

function calculateDiffractionAngle(wavelengthNm: number, linesPerMm: number, stageDeg: number, order = 1) {
  const spacingNm = 1_000_000 / linesPerMm;
  const stage = toRadians(stageDeg);
  const argument = order * wavelengthNm / spacingNm - Math.sin(stage);
  if (Math.abs(argument) > 1) return null;
  return toDegrees(stage + Math.asin(argument));
}

function addCylinderBetween(group: THREE.Group, start: THREE.Vector3, end: THREE.Vector3, radius: number, material: THREE.Material) {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 12), material);
  mesh.position.copy(start).add(end).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  group.add(mesh);
  return mesh;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose?.();
  });
}

function drawDialTicks(group: THREE.Group) {
  const tickMaterial = new THREE.MeshStandardMaterial({ color: "#91b7d9", metalness: .62, roughness: .32 });
  for (let degree = 0; degree < 360; degree += 10) {
    const rad = toRadians(degree);
    const length = degree % 30 === 0 ? .18 : .09;
    const start = new THREE.Vector3(Math.cos(rad) * 1.56, .25, Math.sin(rad) * 1.56);
    const end = new THREE.Vector3(Math.cos(rad) * (1.56 - length), .25, Math.sin(rad) * (1.56 - length));
    addCylinderBetween(group, start, end, .008, tickMaterial);
  }
}

export default function VirtualSpectrometer3D({ journey, navigate, updateJourney }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const dragRef = useRef<{ active: boolean; x: number }>({ active: false, x: 0 });
  const [mode, setMode] = useState<LabMode>("guided");
  const [mouseTool, setMouseTool] = useState<MouseTool>("view");
  const [cameraView, setCameraView] = useState<CameraView>("orbit");
  const [lampOn, setLampOn] = useState(true);
  const [linesPerMm, setLinesPerMm] = useState(300);
  const [slitWidth, setSlitWidth] = useState(.36);
  const [focus, setFocus] = useState(.86);
  const [stageAngle, setStageAngle] = useState(0);
  const [telescopeAngle, setTelescopeAngle] = useState(0);
  const [showWeak, setShowWeak] = useState(false);
  const [showRays, setShowRays] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [slitCount, setSlitCount] = useState(12);
  const [singleRatio, setSingleRatio] = useState(.5);
  const [selectedWavelength, setSelectedWavelength] = useState(435.84);
  const [zeroReference, setZeroReference] = useState<ZeroReference | null>(null);
  const [records, setRecords] = useState<Reading[]>([]);
  const [lastMessage, setLastMessage] = useState("先检查狭缝与调焦，再让光栅法线回到 0°。");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const displayedLines = useMemo(
    () => MERCURY_LINES.filter((line) => showWeak || !line.weak),
    [showWeak],
  );
  const selectedLine = displayedLines.find((line) => line.wavelengthNm === selectedWavelength) ?? displayedLines[0];
  const targetAngle = selectedLine ? calculateDiffractionAngle(selectedLine.wavelengthNm, linesPerMm, stageAngle) : null;
  const rawReadings = useMemo(() => makeVernierReadings(telescopeAngle), [telescopeAngle]);
  const alignmentTolerance = clamp(.035 + (1 - focus) * .4 + Math.max(0, slitWidth - .46) * .42, .045, .24);
  const zeroAligned = Math.abs(signedAngleDelta(telescopeAngle, 0)) <= alignmentTolerance;
  const targetAligned = targetAngle !== null && Math.abs(signedAngleDelta(telescopeAngle, targetAngle)) <= alignmentTolerance;
  const focusReady = focus >= .72;
  const slitReady = slitWidth >= .22 && slitWidth <= .56;
  const stageReady = Math.abs(stageAngle) <= .15;
  const usableReadings = records.filter((record) => record.thetaDeg > .01);
  const fit = useMemo(() => {
    if (usableReadings.length < 2) return null;
    try {
      return measureGrating(usableReadings.map((record) => ({ wavelengthNm: record.wavelengthNm, thetaDeg: record.thetaDeg })));
    } catch { return null; }
  }, [usableReadings]);
  const errorText = useMemo(() => {
    if (!records.length) return "尚无谱线读数";
    const mean = records.reduce((sum, record) => sum + Math.abs(record.errorPercent), 0) / records.length;
    if (mean < .7) return "读数与光栅方程一致";
    if (!zeroReference?.aligned) return "零级参考可能未对准，误差呈整体偏移";
    if (!stageReady) return "光栅法线未校正，单侧读数含入射角误差";
    if (!focusReady || !slitReady) return "谱线成像条件不佳，叉丝定位误差增大";
    return "当前数据存在可复核的测量偏差";
  }, [records, zeroReference?.aligned, stageReady, focusReady, slitReady]);
  const step = !focusReady || !slitReady ? 0 : !stageReady ? 1 : !zeroReference ? 2 : records.length < 2 ? 3 : 4;
  const timerEnd = finishedAt ?? now;
  const rawElapsedSeconds = startedAt ? Math.max(0, Math.floor((timerEnd - startedAt) / 1000)) : 0;
  const elapsedSeconds = Math.min(120, rawElapsedSeconds);
  const remainingSeconds = Math.max(0, 120 - rawElapsedSeconds);
  const formatClock = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const remainingLabel = formatClock(remainingSeconds);
  const elapsedLabel = formatClock(rawElapsedSeconds);
  const started = startedAt !== null;
  const completedInTime = Boolean(fit && startedAt && rawElapsedSeconds <= 120);

  useEffect(() => {
    if (!startedAt || finishedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [startedAt, finishedAt]);

  useEffect(() => {
    if (records.length >= 2 && startedAt && !finishedAt) setFinishedAt(Date.now());
  }, [records.length, startedAt, finishedAt]);

  useEffect(() => {
    updateJourney({
      prelab: {
        source: "mercury",
        capturedLines: records.length,
        dUm: fit?.dUm ?? null,
        rmseNm: fit?.rmseNm ?? null,
      },
    });
  }, [records.length, fit?.dUm, fit?.rmseNm, updateJourney]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog("#05101e", 8, 20);
    const camera = new THREE.PerspectiveCamera(38, 1, .1, 100);
    camera.position.set(5.8, 4.2, 6.1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = .08;
    controls.minDistance = 3.8;
    controls.maxDistance = 10;
    controls.maxPolarAngle = Math.PI * .48;
    controls.target.set(0, .6, 0);

    scene.add(new THREE.HemisphereLight("#bde0ff", "#0c1b2b", 2.1));
    const keyLight = new THREE.DirectionalLight("#b3dcff", 3.1);
    keyLight.position.set(3.8, 6.2, 3.3);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);
    const rimLight = new THREE.PointLight("#3c90ff", 14, 10, 2);
    rimLight.position.set(-2.8, 2.8, -2.6);
    scene.add(rimLight);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(5.8, 96),
      new THREE.MeshStandardMaterial({ color: "#061526", roughness: .9, metalness: .05 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const instrument = new THREE.Group();
    scene.add(instrument);
    const brass = new THREE.MeshStandardMaterial({ color: "#6d8fac", metalness: .78, roughness: .24 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: "#172a3c", metalness: .86, roughness: .2 });
    const trim = new THREE.MeshStandardMaterial({ color: "#b6d0e2", metalness: .78, roughness: .2 });
    const black = new THREE.MeshStandardMaterial({ color: "#071421", metalness: .35, roughness: .42 });
    const gratingMaterial = new THREE.MeshStandardMaterial({ color: "#87b6d9", metalness: .7, roughness: .22, emissive: "#122238" });

    const legMaterial = new THREE.MeshStandardMaterial({ color: "#24384c", metalness: .68, roughness: .27 });
    for (let index = 0; index < 3; index++) {
      const angle = index * Math.PI * 2 / 3 + .2;
      const x = Math.cos(angle) * 1.2;
      const z = Math.sin(angle) * 1.2;
      addCylinderBetween(instrument, new THREE.Vector3(x * .55, .03, z * .55), new THREE.Vector3(x, -.62, z), .105, legMaterial);
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(.19, .23, .12, 18), legMaterial);
      foot.position.set(x, -.66, z);
      foot.castShadow = true;
      foot.receiveShadow = true;
      instrument.add(foot);
    }

    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.73, 1.9, .26, 72), darkMetal);
    base.position.y = -.05;
    base.castShadow = true;
    base.receiveShadow = true;
    instrument.add(base);
    const dial = new THREE.Mesh(new THREE.CylinderGeometry(1.58, 1.58, .095, 72), brass);
    dial.position.y = .14;
    dial.castShadow = true;
    instrument.add(dial);
    const dialInset = new THREE.Mesh(new THREE.CylinderGeometry(1.32, 1.32, .108, 72), black);
    dialInset.position.y = .21;
    instrument.add(dialInset);
    drawDialTicks(instrument);

    const centerColumn = new THREE.Mesh(new THREE.CylinderGeometry(.47, .55, .44, 36), darkMetal);
    centerColumn.position.y = .43;
    centerColumn.castShadow = true;
    instrument.add(centerColumn);

    const stageGroup = new THREE.Group();
    stageGroup.position.y = .67;
    instrument.add(stageGroup);
    const stage = new THREE.Mesh(new THREE.CylinderGeometry(.67, .73, .15, 40), brass);
    stage.castShadow = true;
    stageGroup.add(stage);
    const gratingFrame = new THREE.Mesh(new THREE.BoxGeometry(.13, .86, .98), darkMetal);
    gratingFrame.position.set(0, .42, 0);
    stageGroup.add(gratingFrame);
    const grating = new THREE.Mesh(new THREE.PlaneGeometry(.7, .72), gratingMaterial);
    grating.position.set(.072, .42, 0);
    grating.rotation.y = Math.PI / 2;
    stageGroup.add(grating);
    for (let index = -7; index <= 7; index++) {
      const ruling = new THREE.Mesh(new THREE.BoxGeometry(.007, .68, .006), trim);
      ruling.position.set(.08, .42, index * .042);
      stageGroup.add(ruling);
    }

    const collimator = new THREE.Group();
    collimator.position.set(-1.5, 1.15, 0);
    instrument.add(collimator);
    const collimatorTube = new THREE.Mesh(new THREE.CylinderGeometry(.22, .27, 2.42, 30), darkMetal);
    collimatorTube.rotation.z = Math.PI / 2;
    collimatorTube.position.x = -1.1;
    collimatorTube.castShadow = true;
    collimator.add(collimatorTube);
    const collimatorRing = new THREE.Mesh(new THREE.TorusGeometry(.275, .042, 12, 32), trim);
    collimatorRing.position.x = -.05;
    collimatorRing.rotation.y = Math.PI / 2;
    collimator.add(collimatorRing);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(.18, 24, 24), new THREE.MeshStandardMaterial({ color: "#c7efff", emissive: "#55b8ff", emissiveIntensity: 2.2, roughness: .2 }));
    lamp.position.x = -2.28;
    lamp.castShadow = true;
    collimator.add(lamp);
    const lampHalo = new THREE.PointLight("#55b8ff", 5.5, 3.2, 2);
    lampHalo.position.x = -2.28;
    collimator.add(lampHalo);

    const telescopeGroup = new THREE.Group();
    telescopeGroup.position.set(.05, 1.15, 0);
    instrument.add(telescopeGroup);
    const telescopeTube = new THREE.Mesh(new THREE.CylinderGeometry(.24, .3, 2.86, 34), darkMetal);
    telescopeTube.rotation.z = Math.PI / 2;
    telescopeTube.position.x = 1.38;
    telescopeTube.castShadow = true;
    telescopeGroup.add(telescopeTube);
    const telescopeRail = new THREE.Mesh(new THREE.CylinderGeometry(.11, .13, 2.42, 24), brass);
    telescopeRail.rotation.z = Math.PI / 2;
    telescopeRail.position.set(1.25, -.25, 0);
    telescopeGroup.add(telescopeRail);
    const objective = new THREE.Mesh(new THREE.CylinderGeometry(.34, .34, .16, 32), trim);
    objective.rotation.z = Math.PI / 2;
    objective.position.x = 2.75;
    telescopeGroup.add(objective);
    const eyepiece = new THREE.Mesh(new THREE.CylinderGeometry(.21, .18, .28, 24), black);
    eyepiece.rotation.z = Math.PI / 2;
    eyepiece.position.x = -.02;
    telescopeGroup.add(eyepiece);
    const focusKnob = new THREE.Mesh(new THREE.TorusGeometry(.12, .04, 12, 22), trim);
    focusKnob.position.set(1.55, .28, 0);
    focusKnob.rotation.y = Math.PI / 2;
    telescopeGroup.add(focusKnob);

    const beams = new THREE.Group();
    instrument.add(beams);
    const runtime: SceneRuntime = { renderer, scene, camera, controls, stageGroup, telescopeGroup, beams, lamp, animationFrame: 0 };
    runtimeRef.current = runtime;

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const render = () => {
      runtime.animationFrame = requestAnimationFrame(render);
      controls.update();
      renderer.render(scene, camera);
    };
    render();

    return () => {
      cancelAnimationFrame(runtime.animationFrame);
      observer.disconnect();
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.stageGroup.rotation.y = -toRadians(stageAngle);
    runtime.telescopeGroup.rotation.y = -toRadians(telescopeAngle);
    runtime.lamp.material.emissiveIntensity = lampOn ? 2.2 : .05;
    runtime.lamp.material.color.set(lampOn ? "#c7efff" : "#293845");
    while (runtime.beams.children.length) {
      const child = runtime.beams.children.pop();
      if (child) disposeObject(child);
    }
    if (!lampOn || !showRays) return;
    const incidentMaterial = new THREE.MeshBasicMaterial({ color: "#c8e9ff", transparent: true, opacity: .28 });
    addCylinderBetween(runtime.beams, new THREE.Vector3(-2.5, 1.15, 0), new THREE.Vector3(-.05, 1.15, 0), .025, incidentMaterial);
    const zeroMaterial = new THREE.MeshBasicMaterial({ color: "#eff8ff", transparent: true, opacity: .22 });
    addCylinderBetween(runtime.beams, new THREE.Vector3(.05, 1.15, 0), new THREE.Vector3(3.2, 1.15, 0), .018, zeroMaterial);
    const intensityFactor = clamp(.45 + focus * .4 + (slitWidth <= .56 ? .15 : 0) + Math.log2(Math.max(slitCount, 2)) * .02, .28, 1);
    displayedLines.forEach((line) => {
      const angle = calculateDiffractionAngle(line.wavelengthNm, linesPerMm, stageAngle);
      if (angle === null) return;
      const rad = toRadians(angle);
      const end = new THREE.Vector3(Math.cos(rad) * 3.25, 1.15, Math.sin(rad) * 3.25);
      const material = new THREE.MeshBasicMaterial({ color: line.color, transparent: true, opacity: line.intensity * intensityFactor * (line.weak ? .48 : 1) });
      addCylinderBetween(runtime.beams, new THREE.Vector3(.05, 1.15, 0), end, .015 + singleRatio * .012, material);
    });
  }, [stageAngle, telescopeAngle, lampOn, showRays, displayedLines, linesPerMm, focus, slitWidth, slitCount, singleRatio]);

  const setSceneView = useCallback((view: CameraView) => {
    const runtime = runtimeRef.current;
    setCameraView(view);
    if (!runtime) return;
    runtime.controls.target.set(0, .55, 0);
    if (view === "top") runtime.camera.position.set(.05, 8.5, .08);
    else if (view === "side") runtime.camera.position.set(0, 2.4, 8.2);
    else runtime.camera.position.set(5.8, 4.2, 6.1);
    runtime.controls.update();
  }, []);

  const nudgeTelescope = useCallback((delta: number) => setTelescopeAngle((value) => clamp(value + delta, -62, 62)), []);
  const nudgeStage = useCallback((delta: number) => setStageAngle((value) => clamp(value + delta, -12, 12)), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.tagName === "INPUT" || element?.tagName === "SELECT" || element?.tagName === "TEXTAREA") return;
      const stepSize = event.altKey ? .01 : .1;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? -stepSize : stepSize;
        if (event.shiftKey) nudgeStage(delta); else nudgeTelescope(delta);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [nudgeStage, nudgeTelescope]);

  const beginCanvasDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (mouseTool === "view") return;
    dragRef.current = { active: true, x: event.clientX };
    event.currentTarget.setPointerCapture(event.pointerId);
    const runtime = runtimeRef.current;
    if (runtime) runtime.controls.enabled = false;
  };
  const moveCanvasDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const delta = (event.clientX - dragRef.current.x) * .12;
    dragRef.current.x = event.clientX;
    if (mouseTool === "telescope") nudgeTelescope(delta);
    else nudgeStage(delta * .32);
  };
  const endCanvasDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const runtime = runtimeRef.current;
    if (runtime) runtime.controls.enabled = true;
  };

  const reset = () => {
    setLinesPerMm(300); setSlitWidth(.36); setFocus(.86); setStageAngle(0); setTelescopeAngle(0);
    setShowWeak(false); setLampOn(true); setZeroReference(null); setRecords([]); setSelectedWavelength(435.84);
    setStartedAt(null); setFinishedAt(null); setNow(Date.now());
    setLastMessage("本轮预习已重置。请从调节狭缝与调焦开始。");
    setSceneView("orbit");
    toast.success("虚拟分光计已复位");
  };

  const enforce = (condition: boolean, message: string) => {
    if (mode === "free" || condition) return true;
    setLastMessage(message);
    toast.warning(message);
    return false;
  };

  const captureZero = () => {
    if (mode === "guided" && started && remainingSeconds === 0) return toast.warning("两分钟任务已超时，请重新实验；或切换到自由模式继续探索。");
    if (!enforce(lampOn && focusReady && slitReady && stageReady && zeroAligned, "引导模式：先调好狭缝和焦距，让光栅法线与望远镜都回到零级。")) return;
    if (mode === "guided" && !started) { const time = Date.now(); setStartedAt(time); setNow(time); }
    const reading = makeVernierReadings(telescopeAngle);
    setZeroReference({ ...reading, phiDeg: telescopeAngle, aligned: zeroAligned && stageReady });
    const message = zeroAligned && stageReady ? "零级参考已记录。现在选择一条汞线并让叉丝与谱线重合。" : "零级参考已记录，但未对准；后续数据会保留该系统误差。";
    setLastMessage(message);
    toast.success(message);
  };

  const captureLine = () => {
    if (!selectedLine || targetAngle === null) return toast.warning("该光栅参数下此谱线不可见，请更换刻线密度或目标谱线。");
    if (mode === "guided" && started && remainingSeconds === 0) return toast.warning("两分钟任务已超时，请重新实验；或切换到自由模式继续探索。");
    if (!enforce(Boolean(zeroReference) && focusReady && slitReady && stageReady && targetAligned, "引导模式：请先完成零级参考，并把目标谱线调到叉丝中心。")) return;
    if (!zeroReference) return toast.warning("请先记录零级参考；单侧观测必须使用零级读数消除零位误差。");
    if (records.some((record) => record.wavelengthNm === selectedLine.wavelengthNm)) return toast.info("该谱线已经记录；可在自由模式重新练习。");
    const raw = makeVernierReadings(telescopeAngle);
    const thetaDeg = Math.abs(signedAngleDelta(raw.mean, zeroReference.mean));
    const dNm = 1_000_000 / linesPerMm;
    const calculatedNm = dNm * Math.sin(toRadians(thetaDeg));
    const errorPercent = (calculatedNm - selectedLine.wavelengthNm) / selectedLine.wavelengthNm * 100;
    const reading: Reading = {
      id: `${selectedLine.wavelengthNm}-${Date.now()}`,
      wavelengthNm: selectedLine.wavelengthNm,
      label: selectedLine.label,
      raw,
      thetaDeg,
      calculatedNm,
      errorPercent,
      aligned: targetAligned,
    };
    setRecords((items) => [...items, reading]);
    const message = targetAligned ? `已记录 ${selectedLine.wavelengthNm.toFixed(2)} nm；可选择下一条谱线。` : `已记录偏离叉丝的读数，计算误差 ${errorPercent >= 0 ? "+" : ""}${errorPercent.toFixed(2)}%。`;
    setLastMessage(message);
    toast.success(message);
  };

  const exportCsv = () => {
    if (!records.length) return toast.warning("暂无可导出的测量记录");
    const rows = [
      ["标准波长/nm", "谱线", "游标A", "游标B", "单侧校正衍射角/deg", "计算波长/nm", "相对误差/%"],
      ...records.map((record) => [
        record.wavelengthNm.toFixed(2), record.label, formatDms(record.raw.a), formatDms(record.raw.b),
        record.thetaDeg.toFixed(4), record.calculatedNm.toFixed(3), record.errorPercent.toFixed(3),
      ]),
    ];
    const blob = new Blob([`\uFEFF${rows.map((row) => row.join(",")).join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "分光计单侧读数实验记录.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const adjustSelectedTarget = (direction: -1 | 1) => {
    const current = displayedLines.findIndex((line) => line.wavelengthNm === selectedLine?.wavelengthNm);
    const next = displayedLines[(current + direction + displayedLines.length) % displayedLines.length];
    setSelectedWavelength(next.wavelengthNm);
    setLastMessage(`已选择 ${next.wavelengthNm.toFixed(2)} nm ${next.label}。`);
  };

  const scopeLinePosition = (angle: number) => 50 + signedAngleDelta(angle, telescopeAngle) * 6.2;
  const currentTargetOffset = targetAngle === null ? null : signedAngleDelta(targetAngle, telescopeAngle);
  const instruction = [
    "调节狭缝宽度和目镜焦距，使谱线既清晰又足够明亮。",
    "将载物台法线调至 0°，准备以法线入射建立测量条件。",
    "让望远镜指向零级中央亮纹，读取双游标并保存零级参考。",
    "只观察右侧一级谱线：对准叉丝、读取双游标，使用零级差值计算衍射角。",
    "至少两条谱线已记录。检查拟合、误差来源和测量证据。",
  ][step];

  return (
    <div className="virtual-lab-page">
      <div className="virtual-lab-head">
        <div>
          <p className="eyebrow">预习 · 原生 Web 3D 分光计</p>
          <h1>在真实操作逻辑中完成一次光栅衍射实验。</h1>
          <p>两分钟任务仅显示一侧一级光谱：先记录零级参考，再用双游标平均后的差值消除零位误差；自由模式会保留错误读数及其后果。</p>
        </div>
        <div className="lab-head-actions">
          <div className={`two-minute-timer ${started ? "is-running" : ""} ${finishedAt ? "is-finished" : ""}`}><span>2 分钟任务</span><strong>{finishedAt ? elapsedLabel : remainingLabel}</strong><small>{finishedAt ? "完成用时" : started ? "剩余时间" : "记录零级后开始"}</small></div>
          <div className="lab-mode-switch" aria-label="实验模式">
            <button className={mode === "guided" ? "active" : ""} onClick={() => setMode("guided")}><GraduationCap size={16} />引导实验</button>
            <button className={mode === "free" ? "active" : ""} onClick={() => setMode("free")}><Aperture size={16} />自由探索</button>
          </div>
        </div>
      </div>

      <section className="virtual-lab-shell">
        <div className="lab-scene-column">
          <div
            className={`webgl-stage mouse-${mouseTool}`}
            onPointerDown={beginCanvasDrag}
            onPointerMove={moveCanvasDrag}
            onPointerUp={endCanvasDrag}
            onPointerCancel={endCanvasDrag}
          >
            <div ref={hostRef} className="three-host" aria-label="可交互的 JJY 型分光计三维模型" />
            <div className="scene-grid" aria-hidden="true" />
            <div className="scene-badges">
              <span className={lampOn ? "is-on" : ""}><i />汞灯 {lampOn ? "已开启" : "已关闭"}</span>
              <span><Gauge size={14} />d = {(1_000 / linesPerMm).toFixed(3)} μm</span>
              <span><Rotate3D size={14} />φ = {telescopeAngle.toFixed(2)}°</span>
            </div>
            <div className="scene-actions">
              <div className="scene-view-buttons" aria-label="三维视角">
                <button className={cameraView === "orbit" ? "active" : ""} onClick={() => setSceneView("orbit")} title="自由三维视角"><Rotate3D size={16} /></button>
                <button className={cameraView === "top" ? "active" : ""} onClick={() => setSceneView("top")} title="俯视刻度盘"><Layers3 size={16} /></button>
                <button className={cameraView === "side" ? "active" : ""} onClick={() => setSceneView("side")} title="侧视光路"><Eye size={16} /></button>
              </div>
              <div className="scene-tool-buttons" aria-label="鼠标操作对象">
                <button className={mouseTool === "view" ? "active" : ""} onClick={() => setMouseTool("view")}><Move3D size={15} />视角</button>
                <button className={mouseTool === "telescope" ? "active" : ""} onClick={() => setMouseTool("telescope")}><Telescope size={15} />望远镜</button>
                <button className={mouseTool === "stage" ? "active" : ""} onClick={() => setMouseTool("stage")}><Rotate3D size={15} />载物台</button>
              </div>
            </div>
            {showLabels && <div className="scene-part-labels" aria-hidden="true"><span className="label-collimator">准直管</span><span className="label-stage">光栅载物台</span><span className="label-telescope">望远镜</span></div>}
          </div>

          <div className="instrument-control-deck">
            <div className="deck-section controls-compact">
              <div className="deck-heading"><span><SlidersHorizontal size={17} />仪器调节</span><small>键盘 ←/→ 微调望远镜；Shift + ←/→ 微调载物台</small></div>
              <div className="control-grid">
                <label className="range-control"><span>狭缝宽度 <b>{slitWidth.toFixed(2)} mm</b></span><input type="range" min=".12" max=".82" step=".01" value={slitWidth} onChange={(event) => setSlitWidth(Number(event.target.value))} /></label>
                <label className="range-control"><span>目镜调焦 <b>{Math.round(focus * 100)}%</b></span><input type="range" min=".3" max="1" step=".01" value={focus} onChange={(event) => setFocus(Number(event.target.value))} /></label>
                <label className="range-control"><span>光栅法线 <b>{stageAngle.toFixed(2)}°</b></span><input type="range" min="-12" max="12" step=".01" value={stageAngle} onChange={(event) => setStageAngle(Number(event.target.value))} /></label>
                <label className="range-control"><span>望远镜 φ <b>{telescopeAngle.toFixed(2)}°</b></span><input type="range" min="-62" max="62" step=".01" value={telescopeAngle} onChange={(event) => setTelescopeAngle(Number(event.target.value))} /></label>
              </div>
              <div className="quick-actions">
                <button onClick={() => setLampOn((value) => !value)} className={lampOn ? "is-active" : ""}><i />{lampOn ? "关闭汞灯" : "开启汞灯"}</button>
                <button onClick={() => setStageAngle(0)}><Target size={15} />法线归零</button>
                <button onClick={() => setTelescopeAngle(0)}><Crosshair size={15} />瞄准零级</button>
                <button onClick={() => setShowRays((value) => !value)} className={showRays ? "is-active" : ""}>光路 {showRays ? "显示" : "隐藏"}</button>
              </div>
            </div>
            <details className="advanced-optics">
              <summary><SlidersHorizontal size={16} />高级演示参数 <span>面向教师/自由探索</span></summary>
              <div className="advanced-content">
                <div className="preset-buttons"><span>光栅刻线密度</span>{[300, 600, 1200].map((value) => <button key={value} className={linesPerMm === value ? "active" : ""} onClick={() => setLinesPerMm(value)}>{value} 线/mm</button>)}</div>
                <label className="range-control"><span>连续微调 N <b>{linesPerMm} 线/mm</b></span><input type="range" min="240" max="1200" step="10" value={linesPerMm} onChange={(event) => setLinesPerMm(Number(event.target.value))} /></label>
                <label className="range-control"><span>参与干涉缝数 <b>{slitCount}</b></span><input type="range" min="2" max="36" step="1" value={slitCount} onChange={(event) => setSlitCount(Number(event.target.value))} /></label>
                <label className="range-control"><span>单缝占比 a/d <b>{singleRatio.toFixed(2)}</b></span><input type="range" min=".18" max=".82" step=".01" value={singleRatio} onChange={(event) => setSingleRatio(Number(event.target.value))} /></label>
                <label className="toggle-control"><input type="checkbox" checked={showWeak} onChange={(event) => setShowWeak(event.target.checked)} />显示 491.6 nm 弱线</label>
                <label className="toggle-control"><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} />显示仪器部件标注</label>
              </div>
            </details>
          </div>
        </div>

        <aside className="virtual-lab-side">
          <section className="scope-card">
            <div className="scope-card-head"><span><Eye size={17} />望远镜目镜 · 右侧一级</span><b className={targetAligned ? "is-aligned" : ""}>{targetAligned ? "目标已对准" : currentTargetOffset === null ? "当前谱线不可见" : `偏差 ${Math.abs(currentTargetOffset).toFixed(2)}°`}</b></div>
            <div className={`scope-screen ${!focusReady ? "is-unfocused" : ""} ${!lampOn ? "is-dark" : ""}`}>
              <span className="scope-circle" />
              <span className="scope-crosshair horizontal" /><span className="scope-crosshair vertical" />
              {lampOn && <i className="scope-zero" style={{ left: `${scopeLinePosition(0)}%` }} />}
              {lampOn && displayedLines.map((line) => {
                const angle = calculateDiffractionAngle(line.wavelengthNm, linesPerMm, stageAngle);
                if (angle === null) return null;
                const position = scopeLinePosition(angle);
                return <i key={line.wavelengthNm} className={`scope-spectrum-line ${line.wavelengthNm === selectedLine?.wavelengthNm ? "is-target" : ""}`} style={{ left: `${position}%`, background: line.color, color: line.color, opacity: line.intensity * (line.weak ? .55 : 1) }} />;
              })}
              {!lampOn && <span className="scope-empty">汞灯未开启</span>}
              {lampOn && !focusReady && <span className="scope-quality-note">焦距未调准：谱线扩展，不能可靠读数</span>}
            </div>
            <div className="scope-target-row">
              <button onClick={() => adjustSelectedTarget(-1)} aria-label="上一条目标谱线"><ChevronLeft size={18} /></button>
              <div><span>当前目标</span><strong><i style={{ background: selectedLine?.color }} />{selectedLine?.wavelengthNm.toFixed(2)} nm · {selectedLine?.label}</strong></div>
              <button onClick={() => adjustSelectedTarget(1)} aria-label="下一条目标谱线"><ChevronRight size={18} /></button>
            </div>
          </section>

          <section className="vernier-card">
            <div className="side-card-heading"><span><Gauge size={17} />双游标读数</span><small>分辨率 1′</small></div>
            <div className="vernier-values"><div><span>游标 A</span><strong>{formatDms(rawReadings.a)}</strong></div><div><span>游标 B</span><strong>{formatDms(rawReadings.b)}</strong></div></div>
            <p>平均读数：<b>{formatDms(rawReadings.mean)}</b> · {zeroReference ? `零级参考：${formatDms(zeroReference.mean)}` : "尚未建立零级参考"}</p>
            <button className="zero-record-button" onClick={captureZero}><Crosshair size={16} />记录零级参考</button>
          </section>

          <section className="guide-card">
            <div className="guide-card-head"><span><span className="guide-step-number">{step + 1}</span>实验引导</span><small>{mode === "guided" ? finishedAt ? `用时 ${elapsedLabel}` : `剩余 ${remainingLabel}` : "自由模式"}</small></div>
            <p><Lightbulb size={17} />{instruction}</p>
            <div className="guide-checks">
              <span className={focusReady && slitReady ? "done" : ""}>{focusReady && slitReady ? <Check size={14} /> : <i />}狭缝与焦距</span>
              <span className={stageReady ? "done" : ""}>{stageReady ? <Check size={14} /> : <i />}光栅法线</span>
              <span className={zeroReference?.aligned ? "done" : ""}>{zeroReference?.aligned ? <Check size={14} /> : <i />}零级参考</span>
              <span className={records.length >= 2 ? "done" : ""}>{records.length >= 2 ? <Check size={14} /> : <i />}两条谱线</span>
            </div>
            <button className="record-line-button" onClick={captureLine}><Target size={17} />记录当前目标谱线</button>
            <small className="lab-message">{lastMessage}</small>
          </section>
        </aside>
      </section>

      <section className="measurement-area">
        <div className="measurement-heading"><div><p className="eyebrow">测量证据</p><h2>单侧谱线读数与零级校正</h2></div><div className="measurement-actions"><button onClick={exportCsv}><Download size={16} />导出 CSV</button><button onClick={reset}><RotateCcw size={16} />重新实验</button></div></div>
        <div className="measurement-grid">
          <div className="reading-table-wrap">
            {records.length ? <table className="virtual-reading-table"><thead><tr><th>谱线</th><th>游标 A</th><th>游标 B</th><th>单侧校正 θ</th><th>反算 λ</th><th>相对误差</th></tr></thead><tbody>{records.map((record) => <tr key={record.id} className={record.aligned ? "" : "has-warning"}><td><i style={{ background: MERCURY_LINES.find((line) => line.wavelengthNm === record.wavelengthNm)?.color }} />{record.wavelengthNm.toFixed(2)} nm</td><td>{formatDms(record.raw.a)}</td><td>{formatDms(record.raw.b)}</td><td>{record.thetaDeg.toFixed(3)}°</td><td>{record.calculatedNm.toFixed(2)} nm</td><td>{record.errorPercent >= 0 ? "+" : ""}{record.errorPercent.toFixed(2)}%</td></tr>)}</tbody></table> : <div className="measurement-empty"><Telescope size={27} /><strong>尚未记录谱线</strong><p>对准零级并记录参考后，依次测量右侧一级汞线。</p></div>}
          </div>
          <div className={`fit-summary ${fit ? "has-fit" : ""}`}>
            {fit ? <><small>由 {records.length} 条单侧读数联合拟合</small><strong>d = {fit.dUm.toFixed(3)} μm</strong><span>{linesPerMm} 线/mm · RMSE {fit.rmseNm.toFixed(2)} nm</span><p><CheckCircle2 size={16} />{completedInTime ? `两分钟内完成 · 用时 ${elapsedSeconds} 秒` : errorText}</p><button onClick={() => navigate("guide")}>继续实验流程 <ArrowRight size={15} /></button></> : <><Aperture size={28} /><strong>等待两条有效谱线</strong><p>零级差值会自动用于每条单侧读数的衍射角计算。</p></>}
          </div>
        </div>
        <p className={`error-explainer ${records.length ? "has-data" : ""}`}><CircleAlert size={17} /><span><b>当前诊断：</b>{errorText}。{mode === "free" ? "自由模式中的错位、未校零或未满足法线入射条件都会进入数据表，不会被系统悄悄修正。" : "引导模式会在关键步骤阻止跳过，但仍可通过调整参数观察像质和可见性的变化。"}</span></p>
      </section>
    </div>
  );
}
