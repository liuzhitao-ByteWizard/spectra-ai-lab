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
  lamp: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
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
  const [cameraView, setCameraView] = useState<CameraView>("side");
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

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setClearColor("#08090e", 1);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog("#08090e", 13, 25);
    const camera = new THREE.PerspectiveCamera(27, 1, .1, 100);
    camera.position.set(0, 2.75, 13.4);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = .075;
    controls.enablePan = false;
    controls.minDistance = 7.4;
    controls.maxDistance = 16;
    controls.maxPolarAngle = Math.PI * .48;
    controls.target.set(0, .45, 0);

    scene.add(new THREE.HemisphereLight("#d3d6dc", "#111319", 1.7));
    const keyLight = new THREE.DirectionalLight("#f7f8fb", 3.5);
    keyLight.position.set(-4, 7, 6);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -7;
    keyLight.shadow.camera.right = 7;
    keyLight.shadow.camera.top = 7;
    keyLight.shadow.camera.bottom = -7;
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight("#8d9ba9", 1.45);
    fillLight.position.set(5, 3, -4);
    scene.add(fillLight);

    const material = (color: string, metalness = .55, roughness = .35) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
    const matteBlack = material("#15161a", .34, .54);
    const sootBlack = material("#090a0c", .2, .68);
    const carbon = material("#202226", .64, .31);
    const darkGray = material("#3b3d42", .72, .3);
    const baseGray = material("#74777c", .68, .34);
    const aluminum = material("#b6b9bd", .84, .2);
    const brightMetal = material("#d1d3d6", .9, .16);
    const railMetal = material("#9da0a4", .72, .31);
    const groundMaterial = material("#e5e6e9", .1, .77);
    const groundEdgeMaterial = material("#9ca0a8", .3, .56);
    const gratingMaterial = new THREE.MeshStandardMaterial({ color: "#272a30", metalness: .72, roughness: .2, emissive: "#08090e" });
    const rulerMaterial = material("#b4b6ba", .84, .18);
    const lampMaterial = new THREE.MeshStandardMaterial({ color: "#37df69", emissive: "#17d94e", emissiveIntensity: 2.8, metalness: .08, roughness: .3 });

    const addBox = (parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], meshMaterial: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), meshMaterial);
      mesh.position.set(...position);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const addHorizontalTube = (
      parent: THREE.Object3D,
      startRadius: number,
      endRadius: number,
      length: number,
      position: [number, number, number],
      meshMaterial: THREE.Material,
      segments = 32,
    ) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(startRadius, endRadius, length, segments), meshMaterial);
      mesh.rotation.z = Math.PI / 2;
      mesh.position.set(...position);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const addVerticalTube = (
      parent: THREE.Object3D,
      topRadius: number,
      bottomRadius: number,
      height: number,
      position: [number, number, number],
      meshMaterial: THREE.Material,
      segments = 32,
    ) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(topRadius, bottomRadius, height, segments), meshMaterial);
      mesh.position.set(...position);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const addRing = (parent: THREE.Object3D, position: [number, number, number], radius: number, thickness: number, meshMaterial: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, thickness, 10, 36), meshMaterial);
      mesh.rotation.y = Math.PI / 2;
      mesh.position.set(...position);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const addKnurledSleeve = (
      parent: THREE.Object3D,
      radius: number,
      length: number,
      position: [number, number, number],
      meshMaterial: THREE.Material,
    ) => {
      addHorizontalTube(parent, radius, radius, length, position, meshMaterial);
      for (let index = -4; index <= 4; index++) addRing(parent, [position[0] + index * length / 10, position[1], position[2]], radius + .01, .013, sootBlack);
    };
    const addCastTripodBase = (parent: THREE.Object3D) => {
      // A single continuous three-lobed casting. The varying polar radius produces
      // the broad rounded nose and smooth valleys of the physical spectrometer base.
      const outline = new THREE.Shape();
      const points = 144;
      const tripodPhase = Math.PI / 6;
      for (let index = 0; index <= points; index++) {
        const angle = tripodPhase + index / points * Math.PI * 2;
        const lobe = (1 + Math.cos(3 * (angle - tripodPhase))) / 2;
        const radius = .9 + 1.15 * Math.pow(lobe, .54);
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        if (index === 0) outline.moveTo(x, z);
        else outline.lineTo(x, z);
      }
      outline.closePath();
      const geometry = new THREE.ExtrudeGeometry(outline, {
        depth: .42,
        bevelEnabled: true,
        bevelSegments: 7,
        bevelSize: .14,
        bevelThickness: .12,
        curveSegments: 24,
      });
      geometry.translate(0, 0, -.21);
      const base = new THREE.Mesh(geometry, baseGray);
      base.rotation.x = Math.PI / 2;
      base.position.set(0, -.56, .03);
      base.castShadow = true;
      base.receiveShadow = true;
      parent.add(base);
      return base;
    };

    const whiteBase = addBox(scene, [12.4, .14, 5.8], [0, -.98, 0], groundMaterial);
    whiteBase.receiveShadow = true;
    addBox(scene, [12.55, .055, 5.95], [0, -1.075, 0], groundEdgeMaterial);

    const instrument = new THREE.Group();
    scene.add(instrument);

    // The dial is deliberately independent from the telescope: the main scale is fixed
    // to the base while the two verniers travel with the telescope assembly below.
    const dialY = .84;
    const mainDial = new THREE.Group();
    instrument.add(mainDial);
    addVerticalTube(mainDial, 1.82, 1.82, .07, [0, dialY, .03], railMetal, 96);
    addVerticalTube(mainDial, 1.69, 1.69, .024, [0, dialY + .046, .03], brightMetal, 96);
    addVerticalTube(mainDial, 1.28, 1.28, .08, [0, dialY + .006, .03], darkGray, 96);
    const scaleRing = new THREE.Mesh(
      new THREE.RingGeometry(1.3, 1.71, 128),
      new THREE.MeshStandardMaterial({ color: "#e5e1d1", metalness: .18, roughness: .6, side: THREE.DoubleSide }),
    );
    scaleRing.rotation.x = -Math.PI / 2;
    scaleRing.position.set(0, dialY + .065, .03);
    scaleRing.receiveShadow = true;
    mainDial.add(scaleRing);

    const scaleTickMaterial = new THREE.MeshBasicMaterial({ color: "#1a1b1f" });
    for (let degree = 0; degree < 360; degree++) {
      const rad = toRadians(degree);
      const length = degree % 10 === 0 ? .18 : degree % 5 === 0 ? .125 : .07;
      const radius = 1.685 - length / 2;
      const tick = new THREE.Mesh(new THREE.BoxGeometry(.014, .022, length), scaleTickMaterial);
      tick.position.set(Math.cos(rad) * radius, dialY + .085, .03 + Math.sin(rad) * radius);
      tick.rotation.y = Math.PI / 2 - rad;
      mainDial.add(tick);
    }

    const addScaleNumber = (degree: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 80;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#222328";
      context.font = "500 34px Arial, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(degree), canvas.width / 2, canvas.height / 2 + 1);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(.28, .14),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      );
      const rad = toRadians(degree);
      label.rotation.x = -Math.PI / 2;
      label.position.set(Math.cos(rad) * 1.43, dialY + .102, .03 + Math.sin(rad) * 1.43);
      mainDial.add(label);
    };
    for (let degree = 0; degree < 360; degree += 10) addScaleNumber(degree);

    // One-piece cast-aluminium tripod base, matching the physical instrument.
    // It remains below the fixed main scale, so angle and ray geometry is unchanged.
    // Two broad feet face the user, with the third behind the instrument, matching
    // the characteristic U-shaped silhouette in the side reference photograph.
    const baseLegAngles = [Math.PI / 6, Math.PI * 5 / 6, Math.PI * 3 / 2];
    addCastTripodBase(instrument);
    addVerticalTube(instrument, .58, .7, .24, [0, -.4, .03], baseGray, 48);
    addVerticalTube(instrument, .53, .59, .1, [0, -.23, .03], railMetal, 48);
    addVerticalTube(instrument, .5, .56, .16, [0, -.05, .03], darkGray, 40);
    addVerticalTube(instrument, .31, .38, .72, [0, .34, .03], baseGray, 36);
    addVerticalTube(instrument, .58, .61, .13, [0, .76, .03], darkGray, 48);
    addVerticalTube(instrument, .5, .5, .06, [0, .855, .03], aluminum, 48);
    for (const angle of baseLegAngles) {
      const x = Math.cos(angle) * 1.78;
      const z = .03 + Math.sin(angle) * 1.78;
      addVerticalTube(instrument, .055, .07, .09, [x, -.89, z], carbon, 18);
      addVerticalTube(instrument, .16, .14, .055, [x, -.952, z], matteBlack, 24);
    }

    const bench = new THREE.Group();
    instrument.add(bench);
    addBox(bench, [6.2, .16, .32], [.05, 1.13, .32], railMetal);
    addBox(bench, [4.9, .09, .42], [.1, 1.01, .28], baseGray);
    addBox(bench, [.26, .84, .3], [-2.15, .67, .32], baseGray);
    addBox(bench, [.26, .78, .3], [2.07, .69, .32], baseGray);
    addBox(bench, [1.25, .19, .5], [-1.65, .66, .32], baseGray);
    addBox(bench, [1.06, .19, .5], [1.55, .68, .32], baseGray);

    const stageGroup = new THREE.Group();
    instrument.add(stageGroup);
    addVerticalTube(stageGroup, .46, .5, .13, [0, .93, .03], aluminum, 40);
    addVerticalTube(stageGroup, .41, .44, .09, [0, 1.025, .03], sootBlack, 36);
    const gratingFrame = addBox(stageGroup, [.11, .74, .7], [0, 1.38, .03], gratingMaterial);
    gratingFrame.castShadow = true;
    const grating = new THREE.Mesh(new THREE.PlaneGeometry(.51, .56), new THREE.MeshStandardMaterial({ color: "#aab1b6", metalness: .86, roughness: .13 }));
    grating.position.set(.061, 1.38, .03);
    grating.rotation.y = Math.PI / 2;
    stageGroup.add(grating);
    for (let index = -8; index <= 8; index++) {
      const ruling = addBox(stageGroup, [.014, .51, .008], [.071, 1.38, .03 + index * .0315], rulerMaterial);
      ruling.castShadow = false;
    }
    addBox(stageGroup, [.65, .11, .13], [0, 1.04, .03], aluminum);
    addVerticalTube(stageGroup, .075, .075, .58, [-.22, 1.34, .03], carbon, 18);
    addRing(stageGroup, [-.22, 1.52, .03], .095, .022, brightMetal);

    const lampHousing = new THREE.Group();
    instrument.add(lampHousing);
    addBox(lampHousing, [1.05, .34, .88], [-4.18, -.68, .05], matteBlack);
    addBox(lampHousing, [.78, 2.0, .64], [-4.18, .27, .05], sootBlack);
    addBox(lampHousing, [.88, .1, .72], [-4.18, 1.32, .05], carbon);
    addBox(lampHousing, [.72, .09, .58], [-4.18, 1.55, .05], sootBlack);
    addBox(lampHousing, [.06, .74, .18], [-3.78, 1.2, .05], lampMaterial);
    addBox(lampHousing, [.13, .96, .31], [-3.69, 1.2, .05], matteBlack);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(.022, .72, .13), lampMaterial);
    lamp.position.set(-3.616, 1.2, .05);
    lampHousing.add(lamp);
    const lampHalo = new THREE.PointLight("#39ef68", 2.7, 2.4, 2);
    lampHalo.position.set(-3.56, 1.2, .05);
    lampHousing.add(lampHalo);

    const collimator = new THREE.Group();
    instrument.add(collimator);
    const opticalAxisY = 1.47;
    addHorizontalTube(collimator, .33, .33, .42, [-3.32, opticalAxisY, .03], sootBlack);
    addRing(collimator, [-3.07, opticalAxisY, .03], .36, .035, carbon);
    addHorizontalTube(collimator, .29, .29, .48, [-2.86, opticalAxisY, .03], carbon);
    addHorizontalTube(collimator, .22, .22, .62, [-2.33, opticalAxisY, .03], brightMetal);
    addRing(collimator, [-2.58, opticalAxisY, .03], .25, .028, aluminum);
    addKnurledSleeve(collimator, .31, .3, [-1.91, opticalAxisY, .03], sootBlack);
    addHorizontalTube(collimator, .28, .28, .58, [-1.52, opticalAxisY, .03], aluminum);
    addRing(collimator, [-1.22, opticalAxisY, .03], .31, .03, brightMetal);
    addKnurledSleeve(collimator, .29, .26, [-1.02, opticalAxisY, .03], carbon);
    addHorizontalTube(collimator, .25, .22, .74, [-.58, opticalAxisY, .03], aluminum);
    addRing(collimator, [-.22, opticalAxisY, .03], .25, .025, darkGray);
    addBox(collimator, [.3, .76, .35], [-2.48, .83, .03], darkGray);
    addBox(collimator, [.62, .12, .46], [-2.48, .48, .03], baseGray);

    const telescopeGroup = new THREE.Group();
    instrument.add(telescopeGroup);
    addBox(telescopeGroup, [3.55, .09, .17], [2.02, 1.17, .03], carbon);
    addBox(telescopeGroup, [.29, .72, .34], [1.15, .91, .03], baseGray);
    addBox(telescopeGroup, [1.08, .13, .48], [1.15, .6, .03], baseGray);
    addHorizontalTube(telescopeGroup, .32, .3, .58, [.56, opticalAxisY, .03], sootBlack);
    addRing(telescopeGroup, [.85, opticalAxisY, .03], .35, .035, darkGray);
    addHorizontalTube(telescopeGroup, .26, .24, .66, [1.18, opticalAxisY, .03], carbon);
    addKnurledSleeve(telescopeGroup, .32, .26, [1.55, opticalAxisY, .03], sootBlack);
    addHorizontalTube(telescopeGroup, .22, .22, 1.62, [2.5, opticalAxisY, .03], aluminum);
    addHorizontalTube(telescopeGroup, .12, .12, 1.55, [2.63, opticalAxisY + .2, .03], brightMetal, 24);
    addRing(telescopeGroup, [1.82, opticalAxisY, .03], .25, .025, brightMetal);
    addRing(telescopeGroup, [3.18, opticalAxisY, .03], .25, .026, railMetal);
    addHorizontalTube(telescopeGroup, .23, .3, .42, [3.53, opticalAxisY, .03], carbon);
    addKnurledSleeve(telescopeGroup, .34, .32, [3.88, opticalAxisY, .03], sootBlack);
    addHorizontalTube(telescopeGroup, .24, .38, .2, [4.13, opticalAxisY, .03], matteBlack);
    addVerticalTube(telescopeGroup, .095, .12, .64, [3.76, 1.12, .03], sootBlack, 18);
    addRing(telescopeGroup, [3.76, 1.4, .03], .115, .02, carbon);

    const vernierPlateMaterial = new THREE.MeshStandardMaterial({
      color: "#efead8", metalness: .16, roughness: .55, transparent: true, opacity: .88, side: THREE.DoubleSide,
    });
    const vernierTickMaterial = new THREE.MeshBasicMaterial({ color: "#111216" });
    const makeVernier = (opposite: boolean) => {
      const vernier = new THREE.Group();
      vernier.rotation.y = opposite ? Math.PI : 0;
      telescopeGroup.add(vernier);
      const sector = new THREE.Mesh(
        new THREE.RingGeometry(1.31, 1.72, 32, 1, -.18, .36),
        vernierPlateMaterial,
      );
      sector.rotation.x = -Math.PI / 2;
      sector.position.set(0, dialY + .117, .03);
      vernier.add(sector);
      for (let index = 0; index <= 10; index++) {
        const rad = -.165 + index * .033;
        const length = index === 5 ? .16 : index % 2 === 0 ? .11 : .075;
        const radius = 1.69 - length / 2;
        const tick = new THREE.Mesh(new THREE.BoxGeometry(.013, .024, length), vernierTickMaterial);
        tick.position.set(Math.cos(rad) * radius, dialY + .136, .03 + Math.sin(rad) * radius);
        tick.rotation.y = Math.PI / 2 - rad;
        vernier.add(tick);
      }
      const indexLine = new THREE.Mesh(new THREE.BoxGeometry(.43, .028, .025), vernierTickMaterial);
      indexLine.position.set(1.505, dialY + .142, .03);
      vernier.add(indexLine);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(.055, .055, .035, 20), brightMetal);
      hub.position.set(1.28, dialY + .13, .03);
      vernier.add(hub);
    };
    makeVernier(false);
    makeVernier(true);

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
    addCylinderBetween(runtime.beams, new THREE.Vector3(-3.56, 1.47, .03), new THREE.Vector3(-.06, 1.47, .03), .018, incidentMaterial);
    const zeroMaterial = new THREE.MeshBasicMaterial({ color: "#eff8ff", transparent: true, opacity: .22 });
    addCylinderBetween(runtime.beams, new THREE.Vector3(.06, 1.47, .03), new THREE.Vector3(4.18, 1.47, .03), .013, zeroMaterial);
    const intensityFactor = clamp(.45 + focus * .4 + (slitWidth <= .56 ? .15 : 0) + Math.log2(Math.max(slitCount, 2)) * .02, .28, 1);
    displayedLines.forEach((line) => {
      const angle = calculateDiffractionAngle(line.wavelengthNm, linesPerMm, stageAngle);
      if (angle === null) return;
      const rad = toRadians(angle);
      const end = new THREE.Vector3(Math.cos(rad) * 4.18, 1.47, Math.sin(rad) * 4.18 + .03);
      const material = new THREE.MeshBasicMaterial({ color: line.color, transparent: true, opacity: line.intensity * intensityFactor * (line.weak ? .48 : 1) });
      addCylinderBetween(runtime.beams, new THREE.Vector3(.06, 1.47, .03), end, .011 + singleRatio * .01, material);
    });
  }, [stageAngle, telescopeAngle, lampOn, showRays, displayedLines, linesPerMm, focus, slitWidth, slitCount, singleRatio]);

  const setSceneView = useCallback((view: CameraView) => {
    const runtime = runtimeRef.current;
    setCameraView(view);
    if (!runtime) return;
    runtime.controls.target.set(0, .45, 0);
    if (view === "top") runtime.camera.position.set(.05, 11.6, .08);
    else if (view === "side") runtime.camera.position.set(0, 2.75, 13.4);
    else runtime.camera.position.set(5.9, 3.7, 10.2);
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
            <div ref={hostRef} className="three-host" aria-label="可交互的高保真分光计三维模型" />
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
            {showLabels && <div className="scene-part-labels" aria-hidden="true"><span className="label-lamp">汞灯光源</span><span className="label-collimator">平行光管</span><span className="label-stage">载物台光栅</span><span className="label-telescope">望远镜</span></div>}
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
