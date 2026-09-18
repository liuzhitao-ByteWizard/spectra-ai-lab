"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  Aperture, ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, CircleAlert,
  Crosshair, Download, Eye, Focus, Gauge, Layers3,
  Maximize2, Move3D, Rotate3D, RotateCcw, Target, Telescope,
} from "lucide-react";
import { toast } from "sonner";
import { SPECTRAL_LIBRARY, type SpectrumLine } from "@/lib/spectrometer";
import type { ExperimentJourney } from "@/lib/experiment-journey";

type ModuleId = "home" | "simulator" | "assistant" | "analysis" | "records";
type MouseTool = "view" | "telescope" | "stage";
type CameraView = "orbit" | "top" | "side";
type LightSourceId = "mercury" | "sodium" | "hydrogen" | "white";
type DiffractionOrder = -1 | 1;

type SpectrometerLine = SpectrumLine & { label: string; weak?: boolean };
type LightSource = {
  id: LightSourceId;
  name: string;
  shortName: string;
  beamColor: string;
  lines: SpectrometerLine[];
  continuous?: boolean;
};
type VernierReading = { a: number; b: number; mean: number };
type ZeroReference = VernierReading & { phiDeg: number; aligned: boolean };
type Reading = {
  id: string;
  source: LightSourceId;
  order: DiffractionOrder;
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
  mainDial: THREE.Group;
  stageGroup: THREE.Group;
  telescopeGroup: THREE.Group;
  beams: THREE.Group;
  slitJaws: THREE.Mesh[];
  lamp: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  lampHalo: THREE.PointLight;
  animationFrame: number;
};

type ScopeLineStyle = CSSProperties & {
  "--scope-line-width": string;
  "--scope-line-blur": string;
};

const MERCURY_LINES: SpectrometerLine[] = [
  { ...SPECTRAL_LIBRARY.mercury[0], label: "紫线" },
  { ...SPECTRAL_LIBRARY.mercury[1], label: "蓝线" },
  { wavelengthNm: 491.6, color: "#2cd8d1", family: "blue", intensity: .22, label: "青色弱线", weak: true },
  { ...SPECTRAL_LIBRARY.mercury[2], label: "绿线" },
  { ...SPECTRAL_LIBRARY.mercury[3], label: "黄线 1" },
  { ...SPECTRAL_LIBRARY.mercury[4], label: "黄线 2" },
];

const SODIUM_LINES: SpectrometerLine[] = SPECTRAL_LIBRARY.sodium.map((line, index) => ({
  ...line,
  label: index === 0 ? "钠黄线 D₂" : "钠黄线 D₁",
}));

const HYDROGEN_LINES: SpectrometerLine[] = SPECTRAL_LIBRARY.hydrogen.map((line, index) => ({
  ...line,
  label: ["Hδ", "Hγ", "Hβ", "Hα"][index] ?? "巴耳末线",
}));

function spectrumFamily(wavelengthNm: number): SpectrumLine["family"] {
  if (wavelengthNm < 440) return "violet";
  if (wavelengthNm < 500) return "blue";
  if (wavelengthNm < 570) return "green";
  if (wavelengthNm < 610) return "yellow";
  return "red";
}

function spectrumColor(wavelengthNm: number) {
  if (wavelengthNm < 430) return "#7c5ce2";
  if (wavelengthNm < 455) return "#5275ef";
  if (wavelengthNm < 490) return "#2da9eb";
  if (wavelengthNm < 520) return "#32d5d1";
  if (wavelengthNm < 555) return "#39d67c";
  if (wavelengthNm < 585) return "#b8e23f";
  if (wavelengthNm < 610) return "#f6ce32";
  if (wavelengthNm < 650) return "#ff8d37";
  return "#f24f50";
}

const WHITE_LIGHT_LINES: SpectrometerLine[] = Array.from({ length: 25 }, (_, index) => {
  const wavelengthNm = 400 + index * 12;
  return {
    wavelengthNm,
    color: spectrumColor(wavelengthNm),
    family: spectrumFamily(wavelengthNm),
    intensity: .48,
    label: `${wavelengthNm} nm 连续谱`,
  };
});

const LIGHT_SOURCES: Record<LightSourceId, LightSource> = {
  mercury: { id: "mercury", name: "低压汞灯", shortName: "汞灯", beamColor: "#c8e9ff", lines: MERCURY_LINES },
  sodium: { id: "sodium", name: "钠灯", shortName: "钠灯", beamColor: "#ffd65d", lines: SODIUM_LINES },
  hydrogen: { id: "hydrogen", name: "氢气放电管", shortName: "氢灯", beamColor: "#e1b5ff", lines: HYDROGEN_LINES },
  white: { id: "white", name: "白光（连续谱）", shortName: "白光", beamColor: "#fff4d1", lines: WHITE_LIGHT_LINES, continuous: true },
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const toRadians = (value: number) => value * Math.PI / 180;
const toDegrees = (value: number) => value * 180 / Math.PI;
const normalize360 = (value: number) => ((value % 360) + 360) % 360;
const signedAngleDelta = (to: number, from: number) => ((to - from + 540) % 360) - 180;
const quantizeArcminute = (value: number) => Math.round(value * 60) / 60;

// These shared coordinates connect the physical model, ray tracing and eyepiece.
// φ = 0° points along the collimator-to-grating axis; positive φ follows the
// right-hand +1 order in the scene and on the main vernier.
// Keep both tube mouths and the independent grating carrier on one mechanical
// optical axis. The carrier center is at y=1.52 in the scene model.
const OPTICAL_AXIS_Y = 1.52;
const OPTICAL_AXIS_Z = .03;
const COLLIMATOR_MOUTH_X = -1.30;
const TELESCOPE_MOUTH_X = 1.30;
const RAY_DRAW_RADIUS = 5.25;
const SCOPE_FIELD_HALF_ANGLE = 5.35;
const SCOPE_FIELD_HALF_PERCENT = 34;
const SCOPE_DIRECTION_DEADBAND = .05;

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
  // Ideal spectrometer: opposed verniers use one shared reference.
  const a = normalize360(quantizeArcminute(phiDeg));
  const b = normalize360(quantizeArcminute(phiDeg + 180));
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

function mechanicalAngleToSceneRotation(angle: number) {
  return -toRadians(angle);
}

function getOpticalOffset(rayAngle: number, telescopeAxisAngle: number) {
  return signedAngleDelta(rayAngle, telescopeAxisAngle);
}

function getRayEnd(angle: number, radius = RAY_DRAW_RADIUS) {
  const radians = toRadians(angle);
  return new THREE.Vector3(Math.cos(radians) * radius, OPTICAL_AXIS_Y, Math.sin(radians) * radius + OPTICAL_AXIS_Z);
}

function getSlitOptics(slitWidth: number) {
  const openness = clamp((slitWidth - .12) / .7, 0, 1);
  const broadening = clamp((slitWidth - .36) / .46, 0, 1);
  const description = slitWidth < .22
    ? "窄而清晰：通光量较低，谱线更细。"
    : slitWidth > .56
      ? "宽而明亮：通光量增加，谱线展宽、分辨率下降。"
      : "推荐范围：亮度与分辨率保持平衡。";
  return {
    openness,
    broadening,
    jawGap: .04 + openness * .17,
    incidentRadius: .0035 + openness * .011,
    outputRadius: .004 + openness * .011,
    incidentOpacity: .12 + openness * .36,
    throughput: .22 + openness * .78,
    scopeLineWidth: 1.3 + openness * 4.4,
    scopeLineBlur: broadening * 1.7,
    description,
  };
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
  const [mouseTool, setMouseTool] = useState<MouseTool>("view");
  const [cameraView, setCameraView] = useState<CameraView>("side");
  const [lampOn, setLampOn] = useState(true);
  const [lightSource, setLightSource] = useState<LightSourceId>("mercury");
  const [linesPerMm, setLinesPerMm] = useState(300);
  const [slitWidth, setSlitWidth] = useState(.36);
  const [collimatorFocus, setCollimatorFocus] = useState(.86);
  const [focus, setFocus] = useState(.86);
  const [stageAngle, setStageAngle] = useState(0);
  const [telescopeAngle, setTelescopeAngle] = useState(0);
  const [showWeak, setShowWeak] = useState(false);
  const [showRays, setShowRays] = useState(true);
  const [observationOrder, setObservationOrder] = useState<DiffractionOrder>(1);
  const [selectedWavelength, setSelectedWavelength] = useState(435.84);
  const [zeroReference, setZeroReference] = useState<ZeroReference | null>(null);
  const [records, setRecords] = useState<Reading[]>([]);
  const [lastMessage, setLastMessage] = useState("先检查狭缝与调焦，再让光栅法线回到 0°。");

  const sourceProfile = LIGHT_SOURCES[lightSource];
  const slitOptics = useMemo(() => getSlitOptics(slitWidth), [slitWidth]);
  const telescopeAxisAngle = telescopeAngle;
  const directedObservationOrder: DiffractionOrder | null = telescopeAngle > SCOPE_DIRECTION_DEADBAND
    ? 1
    : telescopeAngle < -SCOPE_DIRECTION_DEADBAND
      ? -1
      : null;
  // The active order follows the one physical telescope axis. At zero, retain
  // the last side only as the next measurement target; the eyepiece itself
  // shows the shared zero-order reference.
  const activeObservationOrder = directedObservationOrder ?? observationOrder;
  const displayedLines = useMemo(
    () => sourceProfile.lines.filter((line) => lightSource !== "mercury" || showWeak || !line.weak),
    [lightSource, showWeak, sourceProfile],
  );
  const selectedLine = displayedLines.find((line) => line.wavelengthNm === selectedWavelength) ?? displayedLines[0];
  const targetAngle = selectedLine ? calculateDiffractionAngle(selectedLine.wavelengthNm, linesPerMm, stageAngle, activeObservationOrder) : null;
  const observationLabel = activeObservationOrder === 1 ? "右侧 +1 级" : "左侧 −1 级";
  const rawReadings = useMemo(() => makeVernierReadings(telescopeAngle), [telescopeAngle]);
  const alignmentTolerance = clamp(.035 + (1 - focus) * .26 + (1 - collimatorFocus) * .24 + slitOptics.broadening * .2, .045, .28);
  const zeroAligned = Math.abs(getOpticalOffset(0, telescopeAxisAngle)) <= alignmentTolerance;
  const targetAligned = targetAngle !== null && Math.abs(getOpticalOffset(targetAngle, telescopeAxisAngle)) <= alignmentTolerance;
  const focusReady = focus >= .72 && collimatorFocus >= .72;
  const slitReady = slitWidth >= .22 && slitWidth <= .56;
  const stageReady = Math.abs(stageAngle) <= .15;
  const zeroInScope = Math.abs(getOpticalOffset(0, telescopeAxisAngle)) <= SCOPE_FIELD_HALF_ANGLE;
  const zeroReadyToCalibrate = lampOn && focusReady && slitReady && stageReady && zeroAligned;
  const zeroCalibrationStatus = zeroReference ? "已标定" : zeroReadyToCalibrate ? "已对准 · 待标定" : "未标定";
  const zeroCalibrationHint = !lampOn
    ? `请先开启${sourceProfile.shortName}。`
    : !zeroInScope
      ? "零级在视场外，请回到 φ=0° 标定。"
      : !focusReady || !slitReady
        ? "请先调好狭缝与焦距。"
        : !stageReady
          ? "请先将光栅法线归零。"
          : !zeroAligned
            ? "转动望远镜，使零级线与叉丝重合。"
            : zeroReference
              ? `零级基准：${formatDms(zeroReference.mean)}；可重新标定。`
              : "零级线已在叉丝中心，可记录基准。";
  const usableReadings = records.filter((record) => record.thetaDeg > .01);
  const wavelengthResult = useMemo(() => {
    if (!usableReadings.length) return null;
    const meanNm = usableReadings.reduce((sum, record) => sum + record.calculatedNm, 0) / usableReadings.length;
    const rmseNm = Math.sqrt(usableReadings.reduce((sum, record) => sum + (record.calculatedNm - record.wavelengthNm) ** 2, 0) / usableReadings.length);
    return { meanNm, rmseNm };
  }, [usableReadings]);
  const errorText = useMemo(() => {
    if (!records.length) return "尚无谱线读数";
    const mean = records.reduce((sum, record) => sum + Math.abs(record.errorPercent), 0) / records.length;
    if (mean < .7) return "读数与光栅方程一致";
    if (!zeroReference?.aligned) return "零级参考可能未对准，误差呈整体偏移";
    if (!stageReady) return "光栅法线未校正，一级读数含入射角误差";
    if (!focusReady || !slitReady) return "谱线成像条件不佳，叉丝定位误差增大";
    return "当前数据存在可复核的测量偏差";
  }, [records, zeroReference?.aligned, stageReady, focusReady, slitReady]);
  useEffect(() => {
    updateJourney({
      prelab: {
        source: "mercury",
        capturedLines: lightSource === "mercury" ? records.length : 0,
        dUm: lightSource === "mercury" && records.length >= 2 ? 1_000 / linesPerMm : null,
        rmseNm: lightSource === "mercury" ? wavelengthResult?.rmseNm ?? null : null,
      },
    });
  }, [lightSource, records.length, linesPerMm, wavelengthResult?.rmseNm, updateJourney]);

  useEffect(() => {
    if (directedObservationOrder !== null && observationOrder !== directedObservationOrder) {
      const timer = window.setTimeout(() => setObservationOrder(directedObservationOrder), 0);
      return () => window.clearTimeout(timer);
    }
  }, [directedObservationOrder, observationOrder]);

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
    camera.position.set(0, 2.95, 12.5);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = .075;
    controls.enablePan = false;
    controls.minDistance = 6.5;
    controls.maxDistance = 18;
    controls.maxPolarAngle = Math.PI * .48;
    controls.target.set(0, .70, 0);

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
    const castAluminum = material("#777a7e", .5, .48);
    const aluminum = material("#b6b9bd", .84, .2);
    const brightMetal = material("#d1d3d6", .9, .16);
    const railMetal = material("#9da0a4", .72, .31);
    const groundMaterial = material("#e5e6e9", .1, .77);
    const groundEdgeMaterial = material("#9ca0a8", .3, .56);
    const gratingMaterial = new THREE.MeshStandardMaterial({ color: "#272a30", metalness: .72, roughness: .2, emissive: "#08090e" });
    const rulerMaterial = material("#b4b6ba", .84, .18);
    const lampMaterial = new THREE.MeshStandardMaterial({
      color: LIGHT_SOURCES.mercury.beamColor,
      emissive: LIGHT_SOURCES.mercury.beamColor,
      emissiveIntensity: 2.2,
      metalness: .08,
      roughness: .3,
    });

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
    const addCastBaseArm = (parent: THREE.Object3D, angle: number) => {
      // Each leg is an individual cast arm: narrow beside the centre hub, then
      // broadening into the rounded foot seen in the three reference photos.
      const outline = new THREE.Shape();
      outline.moveTo(.34, -.3);
      outline.bezierCurveTo(.76, -.38, 1.08, -.34, 1.48, -.39);
      outline.bezierCurveTo(1.82, -.48, 2.13, -.29, 2.17, 0);
      outline.bezierCurveTo(2.13, .29, 1.82, .48, 1.48, .39);
      outline.bezierCurveTo(1.08, .34, .76, .38, .34, .3);
      outline.closePath();
      const geometry = new THREE.ExtrudeGeometry(outline, {
        depth: .32,
        bevelEnabled: true,
        bevelSegments: 5,
        bevelSize: .09,
        bevelThickness: .075,
        curveSegments: 20,
      });
      geometry.translate(0, 0, -.16);
      const pivot = new THREE.Group();
      pivot.rotation.y = angle;
      parent.add(pivot);
      const arm = new THREE.Mesh(geometry, castAluminum);
      arm.rotation.x = Math.PI / 2;
      arm.position.set(0, -.65, .03);
      arm.castShadow = true;
      arm.receiveShadow = true;
      pivot.add(arm);
      return arm;
    };

    const whiteBase = addBox(scene, [15.8, .14, 6.5], [0, -.98, 0], groundMaterial);
    whiteBase.receiveShadow = true;
    addBox(scene, [15.95, .055, 6.65], [0, -1.075, 0], groundEdgeMaterial);

    const instrument = new THREE.Group();
    scene.add(instrument);

    // The two verniers are fixed to the base. The graduated dial moves under them
    // with the telescope, matching the actual mechanical layout.
    const dialY = .70;
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

    // Three separate radial cast arms: one forward arm and two rear arms, matching
    // the actual instrument rather than a continuous U-shaped pedestal.
    const baseLegAngles = [-Math.PI / 2, Math.PI / 6, Math.PI * 5 / 6];
    baseLegAngles.forEach((angle) => addCastBaseArm(instrument, angle));
    addVerticalTube(instrument, .4, .42, .16, [0, -.38, .03], baseGray, 48);
    addVerticalTube(instrument, .35, .37, .09, [0, -.255, .03], railMetal, 48);
    addVerticalTube(instrument, .32, .34, .12, [0, -.15, .03], darkGray, 40);
    addVerticalTube(instrument, .22, .28, .5, [0, .16, .03], baseGray, 36);
    addVerticalTube(instrument, .36, .4, .13, [0, .475, .03], darkGray, 48);
    addVerticalTube(instrument, .28, .32, .13, [0, .605, .03], aluminum, 48);
    for (const angle of baseLegAngles) {
      const x = Math.cos(angle) * 1.9;
      const z = .03 - Math.sin(angle) * 1.9;
      addVerticalTube(instrument, .16, .14, .06, [x, -.92, z], matteBlack, 24);
    }

    const bench = new THREE.Group();
    instrument.add(bench);
    addBox(bench, [8.75, .16, .32], [.05, 1.13, .32], railMetal);
    addBox(bench, [7.45, .09, .42], [.1, 1.01, .28], baseGray);
    addBox(bench, [.26, .84, .3], [-3.48, .67, .32], baseGray);
    addBox(bench, [.26, .78, .3], [3.38, .69, .32], baseGray);
    addBox(bench, [1.25, .19, .5], [-3.02, .66, .32], baseGray);
    addBox(bench, [1.06, .19, .5], [2.86, .68, .32], baseGray);
    // Raise the shared parallel-tube support directly beneath the two barrels
    // and the independent grating, without changing their optical axis.
    bench.position.y = .02;

    const stageGroup = new THREE.Group();
    instrument.add(stageGroup);
    // A self-contained, raised grating carriage: the photo reference shows this
    // as a separate circular stage with a thin upright grating and clamp screws.
    addVerticalTube(stageGroup, .5, .54, .13, [0, .79, .03], aluminum, 48);
    addVerticalTube(stageGroup, .44, .47, .09, [0, .89, .03], sootBlack, 40);
    addVerticalTube(stageGroup, .37, .4, .08, [0, .975, .03], baseGray, 36);
    const gratingCarrier = new THREE.Group();
    stageGroup.add(gratingCarrier);
    addVerticalTube(gratingCarrier, .34, .36, .08, [0, 1.05, .03], darkGray, 32);
    addBox(gratingCarrier, [.78, .07, .16], [0, 1.105, .03], aluminum);
    addBox(gratingCarrier, [.13, .08, .86], [0, 1.105, .03], railMetal);
    addBox(gratingCarrier, [.15, .075, .84], [0, 1.69, .03], aluminum);
    addBox(gratingCarrier, [.15, .68, .075], [0, 1.38, -.38], carbon);
    addBox(gratingCarrier, [.15, .68, .075], [0, 1.38, .44], carbon);
    const gratingFrame = addBox(gratingCarrier, [.075, .7, .68], [0, 1.38, .03], gratingMaterial);
    gratingFrame.castShadow = true;
    const grating = new THREE.Mesh(new THREE.PlaneGeometry(.51, .56), new THREE.MeshStandardMaterial({ color: "#aab1b6", metalness: .86, roughness: .13 }));
    grating.position.set(.045, 1.38, .03);
    grating.rotation.y = Math.PI / 2;
    gratingCarrier.add(grating);
    for (let index = -8; index <= 8; index++) {
      const ruling = addBox(gratingCarrier, [.012, .51, .008], [.053, 1.38, .03 + index * .0315], rulerMaterial);
      ruling.castShadow = false;
    }
    for (const z of [-.24, .24]) {
      addBox(gratingCarrier, [.15, .09, .12], [-.11, 1.58, z + .03], brightMetal);
      addVerticalTube(gratingCarrier, .05, .05, .11, [-.22, 1.58, z + .03], brightMetal, 20);
      addRing(gratingCarrier, [-.28, 1.58, z + .03], .065, .014, carbon);
    }
    addBox(gratingCarrier, [.11, .055, .62], [-.16, 1.175, .03], aluminum);
    addVerticalTube(gratingCarrier, .055, .055, .42, [-.27, 1.31, .03], carbon, 18);
    addRing(gratingCarrier, [-.27, 1.48, .03], .08, .018, brightMetal);

    const lampHousing = new THREE.Group();
    instrument.add(lampHousing);
    lampHousing.position.set(-1.15, OPTICAL_AXIS_Y - 1.2, 0);
    addBox(lampHousing, [1.05, .34, .88], [-4.18, -.68, .05], matteBlack);
    addBox(lampHousing, [.78, 2.0, .64], [-4.18, .27, .05], sootBlack);
    addBox(lampHousing, [.88, .1, .72], [-4.18, 1.32, .05], carbon);
    addBox(lampHousing, [.72, .09, .58], [-4.18, 1.55, .05], sootBlack);
    addBox(lampHousing, [.06, .74, .18], [-3.78, 1.2, .05], lampMaterial);
    addBox(lampHousing, [.13, .96, .31], [-3.69, 1.2, .05], matteBlack);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(.022, .72, .13), lampMaterial);
    lamp.position.set(-3.616, 1.2, .05);
    lampHousing.add(lamp);
    const lampHalo = new THREE.PointLight(LIGHT_SOURCES.mercury.beamColor, 2.7, 2.4, 2);
    lampHalo.position.set(-3.56, 1.2, .05);
    lampHousing.add(lampHalo);

    const collimator = new THREE.Group();
    instrument.add(collimator);
    // The mouth is kept outside the independent stage, leaving the same visible
    // free-space light path as the real instrument.
    collimator.position.x = COLLIMATOR_MOUTH_X + .22;
    const opticalAxisY = OPTICAL_AXIS_Y;
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
    // Horizontal arm linking the collimator tube to the central stage-base column
    // instead of a free-standing pedestal. The arm runs at a height just below
    // the optical axis and meets the column that supports the graduated dial.
    const armY = 1.05;
    const armEndX = -2.48;          // local x where the tube sits
    const worldArmX = collimator.position.x + armEndX;   // ≈ -3.56
    // horizontal beam from column centre out to under the collimator
    addBox(instrument, [Math.abs(worldArmX), .12, .38], [worldArmX / 2, armY, .03], baseGray);
    // vertical riser on the column side, joining the beam to the dial pedestal
    addBox(instrument, [.3, armY + .3, .34], [0, armY / 2 - .15, .03], darkGray);
    // short vertical bracket from beam up to the collimator tube underside
    addBox(collimator, [.26, .5, .32], [armEndX, opticalAxisY - .35, .03], darkGray);
    const slitAssembly = new THREE.Group();
    slitAssembly.position.set(-.17, opticalAxisY, .03);
    collimator.add(slitAssembly);
    const upperSlitJaw = addBox(slitAssembly, [.07, .18, .42], [0, .14, 0], matteBlack);
    const lowerSlitJaw = addBox(slitAssembly, [.07, .18, .42], [0, -.14, 0], matteBlack);
    addBox(slitAssembly, [.088, .035, .5], [-.02, .27, 0], carbon);
    addBox(slitAssembly, [.088, .035, .5], [-.02, -.27, 0], carbon);

    const telescopeGroup = new THREE.Group();
    instrument.add(telescopeGroup);
    const telescopeBody = new THREE.Group();
    telescopeBody.position.x = TELESCOPE_MOUTH_X - .27;
    telescopeGroup.add(telescopeBody);
    addBox(telescopeBody, [.29, .72, .34], [1.15, .91, .03], baseGray);
    addBox(telescopeBody, [1.08, .13, .48], [1.15, .6, .03], baseGray);
    addHorizontalTube(telescopeBody, .32, .3, .58, [.56, opticalAxisY, .03], sootBlack);
    addRing(telescopeBody, [.85, opticalAxisY, .03], .35, .035, darkGray);
    addHorizontalTube(telescopeBody, .26, .24, .66, [1.18, opticalAxisY, .03], carbon);
    addKnurledSleeve(telescopeBody, .32, .26, [1.55, opticalAxisY, .03], sootBlack);
    addHorizontalTube(telescopeBody, .22, .22, 1.62, [2.5, opticalAxisY, .03], aluminum);
    // Inner focusing tube stays coaxial with the outer telescope barrel.
    addHorizontalTube(telescopeBody, .12, .12, 1.55, [2.63, opticalAxisY, .03], brightMetal, 24);
    addRing(telescopeBody, [1.82, opticalAxisY, .03], .25, .025, brightMetal);
    addRing(telescopeBody, [3.18, opticalAxisY, .03], .25, .026, railMetal);
    addHorizontalTube(telescopeBody, .23, .3, .42, [3.53, opticalAxisY, .03], carbon);
    addKnurledSleeve(telescopeBody, .34, .32, [3.88, opticalAxisY, .03], sootBlack);
    addHorizontalTube(telescopeBody, .24, .38, .2, [4.13, opticalAxisY, .03], matteBlack);
    addVerticalTube(telescopeBody, .095, .12, .64, [3.76, 1.12, .03], sootBlack, 18);
    addRing(telescopeBody, [3.76, 1.4, .03], .115, .02, carbon);

    const fixedVerniers = new THREE.Group();
    instrument.add(fixedVerniers);
    const vernierPlateMaterial = new THREE.MeshStandardMaterial({
      color: "#f0eee6", emissive: "#1a1a1a", emissiveIntensity: .04, metalness: .12, roughness: .55,
      transparent: true, opacity: .98, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    });
    const vernierTickMaterial = new THREE.MeshBasicMaterial({ color: "#111111", depthTest: false, depthWrite: false });
    const makeVernier = (centerAngle: number) => {
      const vernier = new THREE.Group();
      fixedVerniers.add(vernier);
      const sector = new THREE.Mesh(
        new THREE.RingGeometry(1.31, 1.72, 32, 1, centerAngle - .18, .36),
        vernierPlateMaterial,
      );
      sector.rotation.x = -Math.PI / 2;
      sector.position.set(0, dialY + .117, .03);
      sector.renderOrder = 3;
      vernier.add(sector);
      for (let index = 0; index <= 20; index++) {
        const rad = centerAngle - .17 + index * .017;
        const length = index === 10 ? .18 : index % 5 === 0 ? .13 : index % 2 === 0 ? .1 : .07;
        const radius = 1.7 - length / 2;
        const tick = new THREE.Mesh(new THREE.BoxGeometry(.016, .028, length), vernierTickMaterial);
        tick.position.set(Math.cos(rad) * radius, dialY + .138, .03 + Math.sin(rad) * radius);
        tick.rotation.y = Math.PI / 2 - rad;
        tick.renderOrder = 5;
        vernier.add(tick);
      }
      const indexLine = new THREE.Mesh(new THREE.BoxGeometry(.43, .032, .032), new THREE.MeshBasicMaterial({ color: "#c41e1e", depthTest: false, depthWrite: false }));
      indexLine.position.set(Math.cos(centerAngle) * 1.505, dialY + .146, .03 + Math.sin(centerAngle) * 1.505);
      indexLine.rotation.y = -centerAngle;
      indexLine.renderOrder = 6;
      vernier.add(indexLine);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(.055, .055, .035, 20), brightMetal);
      hub.position.set(Math.cos(centerAngle) * 1.28, dialY + .13, .03 + Math.sin(centerAngle) * 1.28);
      vernier.add(hub);
    };
    makeVernier(-Math.PI / 2);
    makeVernier(Math.PI / 2);

    const beams = new THREE.Group();
    instrument.add(beams);
    const runtime: SceneRuntime = {
      renderer,
      scene,
      camera,
      controls,
      mainDial,
      stageGroup,
      telescopeGroup,
      beams,
      slitJaws: [upperSlitJaw, lowerSlitJaw],
      lamp,
      lampHalo,
      animationFrame: 0,
    };
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
    const telescopeSceneRotation = mechanicalAngleToSceneRotation(telescopeAxisAngle);
    runtime.stageGroup.rotation.y = mechanicalAngleToSceneRotation(stageAngle);
    // The telescope tube, its mount and the graduated dial use this single
    // transform. Nothing in the physical telescope rotates independently.
    runtime.mainDial.rotation.y = telescopeSceneRotation;
    runtime.telescopeGroup.rotation.y = telescopeSceneRotation;
    const jawCenter = .09 + slitOptics.jawGap / 2;
    runtime.slitJaws[0].position.y = jawCenter;
    runtime.slitJaws[1].position.y = -jawCenter;
    const sourceColor = sourceProfile.beamColor;
    runtime.lamp.material.emissiveIntensity = lampOn ? 2.2 : 0;
    runtime.lamp.material.color.set(lampOn ? sourceColor : "#293845");
    runtime.lamp.material.emissive.set(lampOn ? sourceColor : "#08090e");
    runtime.lampHalo.color.set(sourceColor);
    runtime.lampHalo.intensity = lampOn ? 2.7 : 0;
    while (runtime.beams.children.length) {
      const child = runtime.beams.children.pop();
      if (child) disposeObject(child);
    }
    if (!lampOn || !showRays) return;
    const gratingCenter = new THREE.Vector3(0, OPTICAL_AXIS_Y, OPTICAL_AXIS_Z);
    const collimatorMouth = new THREE.Vector3(COLLIMATOR_MOUTH_X, OPTICAL_AXIS_Y, OPTICAL_AXIS_Z);
    {
      const incidentMaterial = new THREE.MeshBasicMaterial({ color: sourceProfile.beamColor, transparent: true, opacity: slitOptics.incidentOpacity });
      addCylinderBetween(runtime.beams, collimatorMouth, gratingCenter, slitOptics.incidentRadius, incidentMaterial);
    }
    {
      const zeroMaterial = new THREE.MeshBasicMaterial({ color: sourceProfile.beamColor, transparent: true, opacity: .14 + slitOptics.throughput * .24 });
      addCylinderBetween(runtime.beams, gratingCenter, getRayEnd(0), slitOptics.outputRadius, zeroMaterial);
    }
    const focusTransmission = .25 + focus * .35 + collimatorFocus * .3;
    const intensityFactor = clamp(focusTransmission * slitOptics.throughput, .08, 1);
    const visibleOrders: DiffractionOrder[] = [-1, 1];
    visibleOrders.forEach((order) => {
      displayedLines.forEach((line) => {
        const angle = calculateDiffractionAngle(line.wavelengthNm, linesPerMm, stageAngle, order);
        if (angle === null) return;
        const end = getRayEnd(angle);
        const opacity = line.intensity * intensityFactor * (line.weak ? .48 : 1) * (sourceProfile.continuous ? .54 : 1);
        const material = new THREE.MeshBasicMaterial({ color: line.color, transparent: true, opacity });
        const rayRadius = slitOptics.outputRadius + (sourceProfile.continuous ? .0025 : .0015);
        addCylinderBetween(runtime.beams, gratingCenter, end, rayRadius, material);
      });
    });
  }, [stageAngle, telescopeAxisAngle, lampOn, showRays, displayedLines, linesPerMm, collimatorFocus, focus, sourceProfile, slitOptics]);

  const setSceneView = useCallback((view: CameraView) => {
    const runtime = runtimeRef.current;
    setCameraView(view);
    if (!runtime) return;
    runtime.controls.target.set(0, .70, 0);
    if (view === "top") runtime.camera.position.set(.05, 15.6, .08);
    else if (view === "side") runtime.camera.position.set(0, 2.95, 12.5);
    else runtime.camera.position.set(5.9, 4.2, 10.5);
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
        const delta = event.key === "ArrowLeft" ? stepSize : -stepSize;
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
    if (mouseTool === "telescope") nudgeTelescope(-delta);
    else nudgeStage(delta * .32);
  };
  const endCanvasDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const runtime = runtimeRef.current;
    if (runtime) runtime.controls.enabled = true;
  };

  const resetMeasurement = (message: string) => {
    setZeroReference(null);
    setRecords([]);
    setLastMessage(message);
  };

  const selectLightSource = (next: LightSourceId) => {
    if (next === lightSource) return;
    const profile = LIGHT_SOURCES[next];
    setLightSource(next);
    setSelectedWavelength(profile.lines.find((line) => !line.weak)?.wavelengthNm ?? profile.lines[0]?.wavelengthNm ?? 0);
    setObservationOrder(1);
    setShowWeak(false);
    resetMeasurement(next === "white"
      ? "已切换为白光连续谱：可观察双侧色散带，连续谱不作为特征线记录。"
      : `已切换为${profile.name}，原有读数已清空以避免混合不同光源。`);
    toast.info(`已启用${profile.name}`);
  };

  const reset = () => {
    setLinesPerMm(300); setSlitWidth(.36); setCollimatorFocus(.86); setFocus(.86); setStageAngle(0); setTelescopeAngle(0);
    setLightSource("mercury"); setObservationOrder(1); setShowWeak(false); setLampOn(true); setShowRays(true); setSelectedWavelength(435.84);
    resetMeasurement("本轮预习已重置。请从调节狭缝与调焦开始。");
    setSceneView("orbit");
    toast.success("虚拟分光计已复位");
  };

  const enforce = (condition: boolean, message: string) => {
    if (condition) return true;
    setLastMessage(message);
    toast.warning(message);
    return false;
  };

  const captureZero = () => {
    if (!enforce(lampOn && focusReady && slitReady && stageReady && zeroAligned, "请先调好狭缝和焦距，让光栅法线与望远镜都回到零级。")) return;
    const reading = makeVernierReadings(telescopeAngle);
    const isRecalibration = Boolean(zeroReference);
    setZeroReference({ ...reading, phiDeg: telescopeAngle, aligned: zeroAligned && stageReady });
    const message = zeroAligned && stageReady
      ? `${isRecalibration ? "零级参考已重新标定" : "零级参考已记录"}。现在选择一条${sourceProfile.shortName}谱线并让叉丝与谱线重合。`
      : "零级参考已记录，但未对准；后续数据会保留该系统误差。";
    setLastMessage(message);
    toast.success(message);
  };

  const captureLine = () => {
    if (sourceProfile.continuous) return toast.info("白光是连续谱，只用于观察双侧色散带；请切换到线光谱光源后再记录。");
    if (!selectedLine || targetAngle === null) return toast.warning("该光栅参数下此谱线不可见，请更换刻线密度或目标谱线。");
    if (!enforce(Boolean(zeroReference) && focusReady && slitReady && stageReady && targetAligned, "请先完成零级参考，并把目标谱线调到叉丝中心。")) return;
    if (!zeroReference) return toast.warning("请先记录零级参考；一级观测必须使用零级读数消除零位误差。");
    if (records.some((record) => record.source === lightSource && record.order === activeObservationOrder && record.wavelengthNm === selectedLine.wavelengthNm)) return toast.info("该侧的这条谱线已经记录；请转向另一侧或选择另一条谱线。");
    const raw = makeVernierReadings(telescopeAngle);
    const thetaDeg = Math.abs(signedAngleDelta(raw.mean, zeroReference.mean));
    const dNm = 1_000_000 / linesPerMm;
    const calculatedNm = dNm * Math.sin(toRadians(thetaDeg));
    const errorPercent = (calculatedNm - selectedLine.wavelengthNm) / selectedLine.wavelengthNm * 100;
    const reading: Reading = {
      id: `${lightSource}-${activeObservationOrder}-${selectedLine.wavelengthNm}-${Date.now()}`,
      source: lightSource,
      order: activeObservationOrder,
      wavelengthNm: selectedLine.wavelengthNm,
      label: selectedLine.label,
      raw,
      thetaDeg,
      calculatedNm,
      errorPercent,
      aligned: targetAligned,
    };
    setRecords((items) => [...items, reading]);
    const message = targetAligned ? `已记录${observationLabel}的 ${selectedLine.wavelengthNm.toFixed(2)} nm；可选择下一条谱线。` : `已记录偏离叉丝的读数，计算误差 ${errorPercent >= 0 ? "+" : ""}${errorPercent.toFixed(2)}%。`;
    setLastMessage(message);
    toast.success(message);
  };

  const exportCsv = () => {
    if (!records.length) return toast.warning("暂无可导出的测量记录");
    const rows = [
      ["光源", "观测侧/级次", "标准波长/nm", "谱线", "游标A", "游标B", "单侧校正衍射角/deg", "计算波长/nm", "相对误差/%"],
      ...records.map((record) => [
        LIGHT_SOURCES[record.source].name, record.order === 1 ? "右侧 +1" : "左侧 −1", record.wavelengthNm.toFixed(2), record.label, formatDms(record.raw.a), formatDms(record.raw.b),
        record.thetaDeg.toFixed(4), record.calculatedNm.toFixed(3), record.errorPercent.toFixed(3),
      ]),
    ];
    const blob = new Blob([`\uFEFF${rows.map((row) => row.join(",")).join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "分光计双侧读数实验记录.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const adjustSelectedTarget = (direction: -1 | 1) => {
    const current = displayedLines.findIndex((line) => line.wavelengthNm === selectedLine?.wavelengthNm);
    const next = displayedLines[(current + direction + displayedLines.length) % displayedLines.length];
    setSelectedWavelength(next.wavelengthNm);
    setLastMessage(`已选择 ${next.wavelengthNm.toFixed(2)} nm ${next.label}（${observationLabel}）。`);
  };

  const scopeLinePosition = (angle: number, axisAngle: number) => 50 - getOpticalOffset(angle, axisAngle) * SCOPE_FIELD_HALF_PERCENT / SCOPE_FIELD_HALF_ANGLE;
  const isRayInScope = (angle: number, axisAngle: number) => Math.abs(getOpticalOffset(angle, axisAngle)) <= SCOPE_FIELD_HALF_ANGLE;
  const makeScopeLineStyle = (angle: number, axisAngle: number, color: string, opacity: number, target = false): ScopeLineStyle => ({
    left: `${scopeLinePosition(angle, axisAngle)}%`,
    background: color,
    color,
    opacity,
    "--scope-line-width": `${slitOptics.scopeLineWidth + (target ? .9 : 0)}px`,
    "--scope-line-blur": `${slitOptics.scopeLineBlur}px`,
  });
  return (
    <div className="virtual-lab-page">
      <div className="virtual-lab-head">
        <div>
          <p className="eyebrow">预习 · 原生 Web 3D 分光计</p>
          <h1>在真实操作逻辑中完成一次光栅衍射实验。</h1>
          <p>三维视图同步呈现入射光、零级光和左右两侧一级光谱；单个目镜始终与真实镜筒朝向同步。</p>
        </div>
      </div>

      {/* Top row: 3D scene + eyepiece side by side */}
      <section className="lab-top-row">
        <div className="lab-scene-column">
          <div className="scene-meta-bar">
            <div className="scene-badges">
              <span className={lampOn ? "is-on" : ""}><i />{sourceProfile.shortName} {lampOn ? "已开启" : "已关闭"}</span>
              <span><Gauge size={14} />d = {(1_000 / linesPerMm).toFixed(3)} μm</span>
              <span><Rotate3D size={14} />φ = {telescopeAngle.toFixed(2)}°</span>
              <span><Aperture size={14} />双侧 ±1 级</span>
            </div>
          </div>
          <div className={`webgl-stage mouse-${mouseTool} view-${cameraView}`}>
            <div
              ref={hostRef}
              className="three-host"
              aria-label="可交互的高保真分光计三维模型"
              onPointerDown={beginCanvasDrag}
              onPointerMove={moveCanvasDrag}
              onPointerUp={endCanvasDrag}
              onPointerCancel={endCanvasDrag}
            />
            <div className="scene-grid" aria-hidden="true" />
            <div className="scene-status-overlay lab-status-bar" aria-label="快捷操作">
              <button onClick={() => setLampOn((value) => !value)} className={lampOn ? "is-active" : ""}><i />{lampOn ? `关闭${sourceProfile.shortName}` : `开启${sourceProfile.shortName}`}</button>
              <button onClick={() => setStageAngle(0)}><Target size={15} />法线归零</button>
              <button onClick={() => setTelescopeAngle(0)}><Crosshair size={15} />瞄准零级</button>
              <button onClick={() => setShowRays((value) => !value)} className={showRays ? "is-active" : ""}>光路 {showRays ? "显示" : "隐藏"}</button>
              <button onClick={reset}><RotateCcw size={15} />标准复位</button>
            </div>
          </div>
          <div className="scene-control-bar" aria-label="三维操作工具栏">
            <div className="scene-actions" aria-label="三维操作工具栏">
              <div className="scene-action-group">
                <span>视图预设</span>
                <div className="scene-view-buttons" aria-label="三维视角">
                  <button className={cameraView === "orbit" ? "active" : ""} onClick={() => setSceneView("orbit")} title="自由三维视角" aria-label="自由三维视角"><Rotate3D size={16} /></button>
                  <button className={cameraView === "top" ? "active" : ""} onClick={() => setSceneView("top")} title="俯视刻度盘" aria-label="俯视刻度盘"><Layers3 size={16} /></button>
                  <button className={cameraView === "side" ? "active" : ""} onClick={() => setSceneView("side")} title="侧视光路" aria-label="侧视光路"><Eye size={16} /></button>
                </div>
              </div>
              <div className="scene-action-group">
                <span>拖拽对象</span>
                <div className="scene-tool-buttons" aria-label="鼠标操作对象">
                  <button className={mouseTool === "view" ? "active" : ""} onClick={() => setMouseTool("view")}><Move3D size={15} />视角</button>
                  <button className={mouseTool === "telescope" ? "active" : ""} onClick={() => setMouseTool("telescope")}><Telescope size={15} />望远镜</button>
                  <button className={mouseTool === "stage" ? "active" : ""} onClick={() => setMouseTool("stage")}><Rotate3D size={15} />载物台</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <section className="scope-card scope-side">
          <div className="scope-card-head"><span><Eye size={17} />望远镜目镜</span><b>{directedObservationOrder === null ? "φ=0° · 零级参考" : `镜筒朝向 · ${observationLabel}`}</b></div>
          <div className={`scope-screen scope-screen-single ${!focusReady ? "is-unfocused" : ""} ${!lampOn ? "is-dark" : ""}`}>
            <div className="scope-optical-field">
              <span className="scope-circle" />
              <span className="scope-crosshair horizontal" /><span className="scope-crosshair vertical" />
              {lampOn && zeroInScope && <i className="scope-zero" style={makeScopeLineStyle(0, telescopeAxisAngle, "#d9edff", .16 + slitOptics.throughput * .28)} />}
              {lampOn && directedObservationOrder !== null && displayedLines.map((line) => {
                const angle = calculateDiffractionAngle(line.wavelengthNm, linesPerMm, stageAngle, activeObservationOrder);
                if (angle === null || !isRayInScope(angle, telescopeAxisAngle)) return null;
                const isTarget = line.wavelengthNm === selectedLine?.wavelengthNm;
                const opacity = line.intensity * (line.weak ? .55 : 1) * (.28 + slitOptics.throughput * .72) * (sourceProfile.continuous ? .76 : 1);
                return <i key={line.wavelengthNm} className={`scope-spectrum-line ${isTarget ? "is-target" : ""} ${sourceProfile.continuous ? "is-continuous" : ""}`} style={makeScopeLineStyle(angle, telescopeAxisAngle, line.color, opacity, isTarget)} />;
              })}
              {!lampOn && <span className="scope-empty">{sourceProfile.name}未开启</span>}
              {lampOn && !zeroInScope && <span className="scope-zero-outside">零级在视场外 · 回到 φ=0° 可标定</span>}
              {lampOn && !focusReady && <span className="scope-quality-note">焦距未调准</span>}
            </div>
          </div>
          <div className="scope-calibration-row" aria-live="polite">
            <div>
              <span>零级标定</span>
              <strong className={zeroReference || zeroReadyToCalibrate ? "is-ready" : ""}>{zeroCalibrationStatus}</strong>
              <small>{zeroCalibrationHint}</small>
            </div>
            <button onClick={captureZero} disabled={!zeroReadyToCalibrate}><Crosshair size={15} />{zeroReference ? "重新标定" : "标定零级"}</button>
          </div>
          <div className="scope-target-row">
            <button onClick={() => adjustSelectedTarget(-1)} aria-label="上一条目标谱线"><ChevronLeft size={18} /></button>
            <div><span>{directedObservationOrder === null ? "零级参考" : sourceProfile.continuous ? "当前色带" : `记录侧：${observationLabel}`}</span><strong><i style={{ background: selectedLine?.color }} />{selectedLine?.wavelengthNm.toFixed(2)} nm · {selectedLine?.label}</strong></div>
            <button onClick={() => adjustSelectedTarget(1)} aria-label="下一条目标谱线"><ChevronRight size={18} /></button>
          </div>
        </section>
      </section>

      {/* Three-column controls */}
      <section className="lab-controls-3col">
        <div className="ctrl-col">
          <div className="ctrl-col-head">光源 / 光栅</div>
          <div className="source-picker" aria-label="光源选择">
            <span>光源</span>
            <div>
              {Object.values(LIGHT_SOURCES).map((item) => <button key={item.id} className={lightSource === item.id ? "active" : ""} aria-pressed={lightSource === item.id} onClick={() => selectLightSource(item.id)}>{item.name}</button>)}
            </div>
            <small>{sourceProfile.continuous ? "连续谱仅用于观察双侧色散带，不参与特征线记录。" : `${sourceProfile.name} · 当前观测 ${observationLabel}`}</small>
          </div>
          <div className="grating-picker" aria-label="光栅刻线密度">
            <span>光栅</span>
            <div>{[300, 600, 1200].map((value) => <button key={value} className={linesPerMm === value ? "active" : ""} onClick={() => setLinesPerMm(value)}>{value} 线/mm</button>)}</div>
            <small>改变光栅间距与两侧谱线张角。</small>
          </div>
        </div>
        <div className="ctrl-col">
          <div className="ctrl-col-head">望远镜 / 载物台</div>
          <label className="range-control"><span>望远镜 φ <b>{telescopeAngle.toFixed(2)}°</b></span><input type="range" min="-62" max="62" step=".01" value={-telescopeAngle} onChange={(event) => setTelescopeAngle(-Number(event.target.value))} /></label>
          <div className="fine-adjustment">
            <div><span>望远镜微调</span><b>{formatSignedDms(telescopeAngle)}</b></div>
            <div className="fine-buttons">{[
              { label: "−10′", delta: -10 / 60 }, { label: "−1′", delta: -1 / 60 }, { label: "+1′", delta: 1 / 60 }, { label: "+10′", delta: 10 / 60 },
            ].map((item) => <button key={item.label} onClick={() => nudgeTelescope(item.delta)}>{item.label}</button>)}</div>
          </div>
          <label className="range-control"><span>光栅法线 <b>{stageAngle.toFixed(2)}°</b></span><input type="range" min="-12" max="12" step=".01" value={stageAngle} onChange={(event) => setStageAngle(Number(event.target.value))} /></label>
          <div className="fine-adjustment">
            <div><span>载物台微调</span><b>{formatSignedDms(stageAngle)}</b></div>
            <div className="fine-buttons">{[
              { label: "−10′", delta: -10 / 60 }, { label: "−1′", delta: -1 / 60 }, { label: "+1′", delta: 1 / 60 }, { label: "+10′", delta: 10 / 60 },
            ].map((item) => <button key={item.label} onClick={() => nudgeStage(item.delta)}>{item.label}</button>)}</div>
          </div>
        </div>
        <div className="ctrl-col">
          <div className="ctrl-col-head">狭缝 / 调焦</div>
          <label className="range-control"><span>狭缝宽度 <b>{slitWidth.toFixed(2)} mm</b></span><input type="range" min=".12" max=".82" step=".01" value={slitWidth} onChange={(event) => setSlitWidth(Number(event.target.value))} /></label>
          <p className="slit-optics-note"><Aperture size={15} /><span><b>狭缝反馈：</b>{slitOptics.description}</span></p>
          <label className="range-control"><span>目镜调焦 <b>{Math.round(focus * 100)}%</b></span><input type="range" min=".3" max="1" step=".01" value={focus} onChange={(event) => setFocus(Number(event.target.value))} /></label>
          <label className="range-control"><span>平行光管调焦 <b>{Math.round(collimatorFocus * 100)}%</b></span><input type="range" min=".3" max="1" step=".01" value={collimatorFocus} onChange={(event) => setCollimatorFocus(Number(event.target.value))} /></label>
        </div>
      </section>

      {/* Evidence cards */}
      <section className="evidence-prelude">
        <section className="vernier-card">
          <div className="side-card-heading"><span><Gauge size={17} />双游标读数</span><small>分辨率 1′</small></div>
          <div className="vernier-values"><div><span>游标 A</span><strong>{formatDms(rawReadings.a)}</strong></div><div><span>游标 B</span><strong>{formatDms(rawReadings.b)}</strong></div></div>
          <p>平均读数：<b>{formatDms(rawReadings.mean)}</b> · {zeroReference ? `零级参考：${formatDms(zeroReference.mean)}` : "尚未建立零级参考"}</p>
        </section>

        <section className="vernier-card">
          <div className="side-card-heading"><span><Target size={17} />谱线读数</span><small>对准叉丝后记录</small></div>
          <p>使用零级参考消除零位误差；仅线光谱可记录特征谱线。</p>
          <button className="record-line-button" onClick={captureLine}><Target size={17} />记录当前目标谱线</button>
          <small className="lab-message">{lastMessage}</small>
        </section>
      </section>

      {/* Measurement */}
      <section className="measurement-area">
        <div className="measurement-heading"><div><p className="eyebrow">测量证据</p><h2>双侧一级谱线读数与零级校正</h2></div><div className="measurement-actions"><button onClick={exportCsv}><Download size={16} />导出 CSV</button><button onClick={reset}><RotateCcw size={16} />重新实验</button></div></div>
        <div className="measurement-grid">
          <div className="reading-table-wrap">
            {records.length ? <table className="virtual-reading-table"><thead><tr><th>光源</th><th>侧 / 级次</th><th>谱线</th><th>游标 A</th><th>游标 B</th><th>校正 θ</th><th>反算 λ</th><th>相对误差</th></tr></thead><tbody>{records.map((record) => <tr key={record.id} className={record.aligned ? "" : "has-warning"}><td>{LIGHT_SOURCES[record.source].shortName}</td><td>{record.order === 1 ? "右 +1" : "左 −1"}</td><td><i style={{ background: LIGHT_SOURCES[record.source].lines.find((line) => line.wavelengthNm === record.wavelengthNm)?.color }} />{record.wavelengthNm.toFixed(2)} nm · {record.label}</td><td>{formatDms(record.raw.a)}</td><td>{formatDms(record.raw.b)}</td><td>{record.thetaDeg.toFixed(3)}°</td><td>{record.calculatedNm.toFixed(2)} nm</td><td>{record.errorPercent >= 0 ? "+" : ""}{record.errorPercent.toFixed(2)}%</td></tr>)}</tbody></table> : <div className="measurement-empty"><Telescope size={27} /><strong>尚未记录谱线</strong><p>对准零级并记录参考后，可测量左右任一侧的一级特征线。</p></div>}
          </div>
          <div className={`fit-summary ${wavelengthResult ? "has-fit" : ""}`}>
            {wavelengthResult ? <><small>由 {records.length} 条一级读数求平均</small><strong>λ̄ = {wavelengthResult.meanNm.toFixed(2)} nm</strong><span>已知光栅 {linesPerMm} 线/mm · RMSE {wavelengthResult.rmseNm.toFixed(2)} nm</span><p><CheckCircle2 size={16} />{errorText}</p><button onClick={() => navigate("analysis")}>打开图像分析 <ArrowRight size={15} /></button></> : <><Aperture size={28} /><strong>等待波长读数</strong><p>零级差值与已知光栅间距会自动计算 λ = d sin θ。</p></>}
          </div>
        </div>
        <p className={`error-explainer ${records.length ? "has-data" : ""}`}><CircleAlert size={17} /><span><b>当前诊断：</b>{errorText}。系统会保留真实读数与偏差，便于复核零级、法线与像质条件。</span></p>
      </section>
    </div>
  );
}
