import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

import { REGIONS } from "../data/bodyRegions.js";
import { THERAPY_PRESETS } from "../data/therapyPresets.js";
import { BODY_FACTS } from "../data/bodyFacts.js";
import { getConditionGuidance } from "../data/bodyTherapyGuidance.js";

import {
  CLINIC_MODEL_URL,
  RUG_NAME,
  FRONT_DIRECTION,
  SKIN_HEX,
  HIGHLIGHT_HEX
} from "../config/modelConfig.js";

import {
  CLINIC_ANIMATION,
  HIGHLIGHT_ANIMATION
} from "../config/animationConfig.js";

import {
  CLINIC_SHADOW
} from "../config/lightingConfig.js";

// File paths
const WALK_FILE = new URL("../assets/walking.fbx", import.meta.url).href;
const IDLE_FILE = new URL("../assets/breathing.fbx", import.meta.url).href;
const MAIN_PAGE_URL = "../index.html";
// Resolve GLB relative to this module, not the page URL or config module.
const CLINIC_URL = new URL("../assets/model.glb", import.meta.url).href;
const CAMERA_REVEAL_SECONDS = 3.4;
const MOBILE_CAMERA_REVEAL_SECONDS = 2.0;
const CAMERA_CLOSE_DISTANCE_FACTOR = 2.15; // Increase for a safer, wider opening shot
const CAMERA_HEAD_HEIGHT_FACTOR = 0.84; // Adjust if the head is too high/low
let cinematicActive = false;
let cinematicElapsed = 0;
let cinematicStart = null;
let cinematicEnd = null;
let exitNavigating = false;
function smoothstep(t) { return t * t * (3 - 2 * t); }
function finishCinematic() {
  cinematicActive = false;
  document.body.classList.remove("intro-playing");
  document.body.classList.add("intro-complete");
}
// The FBX is normalized to ground level in setupHuman(). Use that known
// coordinate system rather than a bounding box recalculated from animated bones:
// animated FBX bounds can include outlying transforms and misidentify the legs
// as the head. The camera's end pose is preserved from updateCamera().
let cinematicStartTarget = null;
let cinematicEndTarget = null;
function startCinematic() {
  cinematicEnd = camera.position.clone();
  const height = Math.max(bodyHeight, 0.1);
  const headY = height * CAMERA_HEAD_HEIGHT_FACTOR + bodyRoot.position.y;
  const faceZ = bodyRoot.position.z;
  const closeDistance = Math.max(height * CAMERA_CLOSE_DISTANCE_FACTOR, 2.8);

  cinematicStart = new THREE.Vector3(
    bodyRoot.position.x, headY, faceZ + closeDistance
  );
  cinematicStartTarget = new THREE.Vector3(
    bodyRoot.position.x, headY, faceZ
  );
  cinematicEndTarget = new THREE.Vector3(
    cinematicEnd.x, cinematicEnd.y, faceZ
  );

  cinematicElapsed = 0;
  cinematicActive = !reducedMotion.matches;
  bodyRoot.position.x = 0;
  bodyRoot.rotation.y = 0;
  targetBodyRotationY = 0;
  // Settle the skeleton and floor alignment before the loader fades away.
  // Do not crossfade from a walking clip that has never started.
  if (walkAction) walkAction.stop();
  if (idleAction) {
    idleAction.reset();
    idleAction.enabled = true;
    idleAction.setEffectiveWeight(1);
    idleAction.play();
  }
  if (characterMixer) {
    characterMixer.update(1 / 60);
    groundAnimatedCharacter(1 / 60);
    characterMixer.update(1 / 60);
    groundAnimatedCharacter(1 / 60);
  }

  if (cinematicActive) {
    camera.position.copy(cinematicStart);
    camera.lookAt(cinematicStartTarget);
  } else {
    camera.position.copy(cinematicEnd);
    camera.lookAt(cinematicEndTarget);
    finishCinematic();
  }
  camera.near = Math.max(0.001, closeDistance / 1000);
  camera.updateProjectionMatrix();
  markShadowDirty();
}
function advanceCinematic(dt) {
  if (!cinematicActive) return;
  cinematicElapsed += dt;
  const t = Math.min(1, cinematicElapsed / (mobileQuery.matches ? MOBILE_CAMERA_REVEAL_SECONDS : CAMERA_REVEAL_SECONDS));
  const eased = smoothstep(t);
  camera.position.lerpVectors(cinematicStart, cinematicEnd, eased);
  const target = cinematicStartTarget.clone().lerp(cinematicEndTarget, eased);
  camera.lookAt(target);
  markShadowDirty();
  if (t >= 1) finishCinematic();
}
function navigateWithLoading() {
  if (exitNavigating) return;
  exitNavigating = true;
  loading.classList.remove("hidden", "failed");
  loading.setAttribute("aria-label", "Returning to dashboard");
  // Show the existing animated loading screen before changing pages.
  setTimeout(() => window.location.assign(MAIN_PAGE_URL), 650);
}

// Animation settings
const ENTRANCE_DURATION = 3.2;
const EXIT_DURATION = 2.7;
const ROTATION_SPEED = 8;
const MODEL_HEIGHT = 1.7;
const MOBILE_FRAME_MS = 33; // ~30 FPS on phones; fewer expensive GLB draws
const MOBILE_PIXEL_RATIO = 1.5; // Stable, sharper mobile render target (no adaptive pixelation)
const MOBILE_SHADOW_INTERVAL_MS = 120; // Reuse shadows between updates on mobile
const FOOT_GROUND_CLEARANCE = 0; // 0 = sole reaches rug; negative lowers character
const SHADOW_RECEIVER_LIFT = 0.0015; // Fraction of body height above rug surface

// Colors
const SKIN_COLOR = new THREE.Color(SKIN_HEX);
const HIGHLIGHT_COLOR = new THREE.Color(0x7187D9); // Selected body regions: neutral blue-violet

// DOM elements
const viewer = document.getElementById("viewer");
const loading = document.getElementById("loading");
const loadMessage = document.getElementById("fcLoadMessage");

const bodyPanel = document.getElementById("bodyPanel");
const bodyPartsContainer = document.getElementById("bodyParts");
const menuToggle = document.getElementById("menuToggle");

const presetPanel = document.getElementById("presetPanel");
const presetTitle = document.getElementById("presetBodyTitle");
const presetFact = document.getElementById("presetBodyFact");
const presetCount = document.getElementById("presetCount");
const presetList = document.getElementById("presetList");
const presetScroll = presetPanel.querySelector(".preset-scroll");

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const mobileQuery = matchMedia("(max-width: 767px)");

// Three.js setup
const scene = new THREE.Scene();
scene.background = new THREE.Color("#f3e8d5");

const camera = new THREE.PerspectiveCamera(32, 1, .01, 1000);

const renderer = new THREE.WebGLRenderer({
  antialias: !mobileQuery.matches,
  powerPreference: "high-performance"
});

renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true; // Preserve clinic and character shadows on mobile, too
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;

viewer.appendChild(renderer.domElement);

const gltfLoader = new GLTFLoader();
renderer.domElement.addEventListener("webglcontextlost", event => {
  event.preventDefault();
  console.error("FahrenCool: WebGL context lost; the mobile GPU may be out of memory.");
});
renderer.domElement.addEventListener("webglcontextrestored", () => {
  console.info("FahrenCool: WebGL context restored. Reload if the clinic remains invisible.");
});
const fbxLoader = new FBXLoader();
const clock = new THREE.Clock();
let lastMobileShadowUpdate = 0;

const clinicGroup = new THREE.Group();
const bodyRoot = new THREE.Group();

scene.add(clinicGroup);
scene.add(bodyRoot);

// State
let bodyHeight = MODEL_HEIGHT;
let modelReady = false;

let characterMixer = null;
let walkAction = null;
let idleAction = null;
let footBones = [];

let characterGroundInitialized = false;

let rugObject = null;
let rugAnchorLocal = null;
let rugShadowCatcher = null;
let floorShadowCatcher = null;

let targetBodyRotationY = 0;
let humanTargetX = 0;
let activeRegionId = null;

let entranceActive = false;
let entranceElapsed = 0;
let entranceStartX = 0;

let exitActive = false;
let exitElapsed = 0;
let exitStartX = 0;

let dragging = false;
let activePointer = null;
let lastPointerX = 0;

let clinicTime = 0;
let mouseX = 0;
let highlightTime = 0;

let shadowDirty = true;
let disposed = false;
let lastFrameTime = 0;
let rafId = 0;

const tempVector = new THREE.Vector3();
const tempVector2 = new THREE.Vector3();

function markShadowDirty() {
  shadowDirty = true;
}

// Lighting
scene.add(new THREE.HemisphereLight(
  0xf4ffff,
  0x899d9b,
  1.45
));

const clinicKeyLight = new THREE.DirectionalLight(
  0xfff3e4,
  CLINIC_SHADOW.lightIntensity
);

clinicKeyLight.castShadow = true;
clinicKeyLight.shadow.mapSize.set(
  mobileQuery.matches
    ? Math.min(CLINIC_SHADOW.mobileResolution, 512)
    : CLINIC_SHADOW.desktopResolution,
  mobileQuery.matches
    ? Math.min(CLINIC_SHADOW.mobileResolution, 512)
    : CLINIC_SHADOW.desktopResolution
);

clinicKeyLight.shadow.bias = CLINIC_SHADOW.bias;
clinicKeyLight.shadow.normalBias = CLINIC_SHADOW.normalBias;

scene.add(clinicKeyLight);

const fillLight = new THREE.DirectionalLight(0xd5f6ff, .72);
fillLight.position.set(-4, 3, -3);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xb4caff, .35);
rimLight.position.set(-3, 3, -4);
scene.add(rimLight);

// Highlight shader
const SURFACE_CODES = {
  both: 0,
  front: 1,
  back: 2,
  frontSide: 3
};

const highlightSlots = [
  { regionId: null, strength: 0, target: 0 },
  { regionId: null, strength: 0, target: 0 }
];

const highlightUniforms = {
  uHighlightColor: { value: HIGHLIGHT_COLOR },
  uRegionShape: {
    value: [
      new THREE.Vector4(0, 0, 1, 1),
      new THREE.Vector4(0, 0, 1, 1)
    ]
  },
  uRegionMode: {
    value: [
      new THREE.Vector2(0, -1),
      new THREE.Vector2(0, -1)
    ]
  },
  uRegionStrength: { value: [0, 0] },
  uPulse: { value: 1 }
};

function writeSlotUniforms(index, region) {
  const shape = highlightUniforms.uRegionShape.value[index];
  const mode = highlightUniforms.uRegionMode.value[index];

  if (region) {
    shape.set(region.x, region.y, region.rx, region.ry);
    mode.set(
      region.both ? 1 : 0,
      SURFACE_CODES[region.surface] ?? -1
    );
  } else {
    shape.set(0, 0, 1, 1);
    mode.set(0, -1);
  }
}

function createBodyMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: SKIN_COLOR,
    roughness: .86,
    metalness: 0,
    side: THREE.DoubleSide
  });

  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, highlightUniforms);

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `
#include <common>
attribute vec4 bodyCoord;
varying vec4 vBodyCoord;
`)
      .replace("#include <begin_vertex>", `
#include <begin_vertex>
vBodyCoord = bodyCoord;
`);

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `
#include <common>

uniform vec3 uHighlightColor;
uniform vec4 uRegionShape[2];
uniform vec2 uRegionMode[2];
uniform float uRegionStrength[2];
uniform float uPulse;

varying vec4 vBodyCoord;

float fcSurfaceMask(float nx, float nz, float code) {
  if (code < -0.5) return 0.0;
  if (code < 0.5) return 1.0;
  if (code < 1.5) return smoothstep(0.10, 0.45, nz);
  if (code < 2.5) return smoothstep(0.10, 0.45, -nz);

  float front = smoothstep(-0.05, 0.35, nz);
  float side = smoothstep(0.20, 0.75, abs(nx));
  float notBack = smoothstep(-0.20, 0.05, nz);

  return max(front, side * notBack * 0.9);
}

float fcRegionIntensity(
  vec4 shape,
  vec2 mode,
  float strength
) {
  if (strength < 0.0005) return 0.0;

  float xDist = mode.x > 0.5
    ? abs(vBodyCoord.x) - shape.x
    : vBodyCoord.x - shape.x;

  float dist = length(vec2(
    xDist / shape.z,
    (vBodyCoord.y - shape.y) / shape.w
  ));

  float shapeMask = 1.0 - smoothstep(0.58, 1.02, dist);

  return shapeMask *
    fcSurfaceMask(
      vBodyCoord.z,
      vBodyCoord.w,
      mode.y
    ) * strength;
}
`)
      .replace("#include <color_fragment>", `
#include <color_fragment>

float fcHighlight =
  fcRegionIntensity(
    uRegionShape[0],
    uRegionMode[0],
    uRegionStrength[0]
  ) +
  fcRegionIntensity(
    uRegionShape[1],
    uRegionMode[1],
    uRegionStrength[1]
  );

fcHighlight = clamp(
  fcHighlight * uPulse * 0.98,
  0.0,
  1.0
);

diffuseColor.rgb = mix(
  diffuseColor.rgb,
  uHighlightColor,
  fcHighlight
);
`);
  };

  material.customProgramCacheKey = () => "fahrencool-animated-highlight";
  return material;
}

// Therapy data
function normalizeBodyPart(value) {
  const name = String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/lower\s*back|lumbar/.test(name)) return "lower back";
  if (/upper\s*back|thoracic/.test(name)) return "upper back";
  if (/hip|gluteal|glute|buttock/.test(name)) return "hip/gluteal";
  if (/neck|cervical/.test(name)) return "neck";
  if (/shoulder/.test(name)) return "shoulder";
  if (/elbow/.test(name)) return "elbow";
  if (/thigh|quadriceps|hamstring/.test(name)) return "thigh";
  if (/knee/.test(name)) return "knee";
  if (/calf|calves/.test(name)) return "calf";
  if (/ankle/.test(name)) return "ankle";

  return name;
}

const PRESETS_BY_PART = new Map();

for (const preset of THERAPY_PRESETS) {
  const key = normalizeBodyPart(preset.bodyPart);

  if (!PRESETS_BY_PART.has(key)) {
    PRESETS_BY_PART.set(key, []);
  }

  PRESETS_BY_PART.get(key).push(preset);
}

function getMatchingPresets(regionId, region) {
  const keys = new Set([
    normalizeBodyPart(region.name || regionId),
    normalizeBodyPart(regionId)
  ]);

  const matches = new Set();

  for (const key of keys) {
    for (const preset of PRESETS_BY_PART.get(key) || []) {
      matches.add(preset);
    }
  }

  return [...matches];
}

function addPresetDetail(parent, label, value, colorClass = "") {
  const item = document.createElement("div");
  item.className = "preset-detail";

  const caption = document.createElement("span");
  caption.className = "preset-detail-label";
  caption.textContent = label;

  const number = document.createElement("div");
  number.className = "preset-detail-value " + colorClass;
  number.textContent = value;

  item.append(caption, number);
  parent.appendChild(item);
}

function createPresetCard(preset) {
  const type = String(preset.mode || "").toLowerCase();
  const card = document.createElement("article");
  card.className = "preset-card " + type;

  const top = document.createElement("div");
  top.className = "preset-card-top";

  const name = document.createElement("div");
  name.className = "preset-name";
  name.textContent = preset.name;

  const badge = document.createElement("span");
  badge.className = "preset-badge " + type;
  badge.textContent =
    type === "cool" ? "COOLING" :
    type === "heat" ? "HEATING" : "CONTRAST";

  top.append(name, badge);

  const condition = document.createElement("div");
  condition.className =
    "preset-condition " +
    String(preset.condition || "").toLowerCase();
  condition.textContent = preset.condition + " Condition";

  const details = document.createElement("div");
  details.className = "preset-details";

  addPresetDetail(
    details,
    "Temperature Range",
    preset.temperature,
    type === "cool" ? "cool-value" :
    type === "heat" ? "heat-value" : ""
  );

  addPresetDetail(
    details,
    "Session Duration",
    preset.duration
  );

  card.append(top, condition, details);

  if (preset.phases) {
    const phase = document.createElement("div");
    phase.className = "preset-phase";

    const heading = document.createElement("div");
    heading.className = "preset-phase-title";
    heading.textContent = "CONTRAST THERAPY CYCLE";

    const description = document.createElement("div");
    description.className = "preset-phase-text";
    description.textContent = preset.phases;

    phase.append(heading, description);
    card.appendChild(phase);
  }

  const guidance = getConditionGuidance(preset) || {};

  const why = document.createElement("section");
  why.className = "preset-why";

  const whyHeading = document.createElement("strong");
  whyHeading.textContent = "WHY THIS THERAPY?";

  const whyText = document.createElement("p");
  whyText.textContent = guidance.why ||
    "This configuration is associated with the selected condition.";

  why.append(whyHeading, whyText);
  card.appendChild(why);

  const safety = document.createElement("details");
  safety.className = "preset-safety";

  const summary = document.createElement("summary");
  summary.textContent = "Safety Information";

  const content = document.createElement("div");
  content.className = "preset-safety-content";

  const safetyText = document.createElement("p");
  safetyText.textContent = guidance.safety ||
    "Use the therapy according to professional guidance.";

  content.appendChild(safetyText);
  safety.append(summary, content);
  card.appendChild(safety);

  return card;
}

function openPresetPanel(regionId) {
  const region = REGIONS[regionId];
  if (!region) return;

  const name = normalizeBodyPart(region.name || regionId);

  presetTitle.textContent = region.name || regionId;

  presetFact.textContent =
    BODY_FACTS[name] ||
    BODY_FACTS[normalizeBodyPart(regionId)] ||
    "This anatomical region contributes to movement and stability.";

  const matches = getMatchingPresets(regionId, region);

  presetList.replaceChildren();

  presetCount.textContent = matches.length
    ? `${matches.length} ASSOCIATED ${matches.length === 1 ? "PRESET" : "PRESETS"}`
    : "NO DIRECT PRESET MATCH";

  if (matches.length) {
    matches.forEach(preset => {
      presetList.appendChild(createPresetCard(preset));
    });
  } else {
    const empty = document.createElement("div");
    empty.className = "preset-empty";
    empty.textContent = "No preset configured for this region.";
    presetList.appendChild(empty);
  }

  presetScroll.scrollTop = 0;
  presetPanel.inert = false;
  presetPanel.setAttribute("aria-hidden", "false");
  presetPanel.classList.add("open");

  updateHumanTargetX();

  if (mobileQuery.matches) {
    setMobileMenu(false);
  }
}

function closePresetPanel() {
  const wasFocused = presetPanel.contains(document.activeElement);

  presetPanel.classList.remove("open");
  presetPanel.setAttribute("aria-hidden", "true");
  presetPanel.inert = true;

  updateHumanTargetX();

  if (wasFocused) {
    document.querySelector(".part.active")?.focus();
  }
}

document.getElementById("closePresetPanel")
  .addEventListener("click", closePresetPanel);

// Body region selection
function writeHighlightRegion(regionId) {
  const region = regionId ? REGIONS[regionId] : null;
  const current = highlightSlots[0];
  const previous = highlightSlots[1];

  if (current.regionId !== regionId) {
    if (current.strength > .01) {
      previous.regionId = current.regionId;
      previous.strength = current.strength;
      previous.target = 0;

      highlightUniforms.uRegionShape.value[1].copy(
        highlightUniforms.uRegionShape.value[0]
      );

      highlightUniforms.uRegionMode.value[1].copy(
        highlightUniforms.uRegionMode.value[0]
      );
    }

    current.regionId = regionId;
    current.strength = 0;
    current.target = region ? 1 : 0;

    writeSlotUniforms(0, region);
  }
}

function highlightBodyPart(regionId) {
  if (!modelReady || exitActive || cinematicActive) return;

  if (entranceActive) {
    entranceActive = false;
    entranceElapsed = ENTRANCE_DURATION;
    bodyRoot.position.x = 0;
    bodyRoot.rotation.y = 0;
    targetBodyRotationY = 0;
    enterIdleState();
    characterGroundInitialized = false;
    markShadowDirty();
  }

  const region = regionId ? REGIONS[regionId] : null;

  writeHighlightRegion(regionId);

  activeRegionId = regionId;
  highlightTime = 0;

  document.querySelectorAll(".part").forEach(button => {
    const active = button.dataset.region === regionId;

    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if (region) {
    setBodyView(region.view || "front", true);
    openPresetPanel(regionId);
  } else {
    closePresetPanel();
  }

  updateRugFollowing();
  markShadowDirty();
}

function clearSelection() {
  highlightBodyPart(null);
  setBodyView("front", true);
  setMobileMenu(false);
}

document.getElementById("clear")
  .addEventListener("click", clearSelection);

// Body parts buttons
Object.entries(REGIONS)
  .sort((a, b) => b[1].y - a[1].y)
  .forEach(([id, region]) => {
    const button = document.createElement("button");

    button.className = "part";
    button.type = "button";
    button.dataset.region = id;
    button.textContent = region.name || id;
    button.setAttribute("aria-pressed", "false");

    button.addEventListener("click", () => {
      highlightBodyPart(id);
    });

    bodyPartsContainer.appendChild(button);
  });

// Mobile menu
function setMobileMenu(open) {
  bodyPanel.classList.toggle("open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
}

menuToggle.addEventListener("click", () => {
  setMobileMenu(!bodyPanel.classList.contains("open"));
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;

  if (presetPanel.classList.contains("open")) {
    closePresetPanel();
  } else if (bodyPanel.classList.contains("open")) {
    setMobileMenu(false);
  }
});

// Clinic geometry
function clinicMaterial(color, roughness = .9) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    side: THREE.DoubleSide
  });
}

function buildClinicShell(H) {
  const width = H * 10;
  const roomHeight = H * 3;
  const wallZ = -H * 2.6;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(width, H * 8),
    clinicMaterial("#eadcc5")
  );

  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -H * .055;
  clinicGroup.add(floor);

  floorShadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(width, H * 8),
    new THREE.ShadowMaterial({
      color: 0x233b3d,
      opacity: .5
    })
  );

  floorShadowCatcher.rotation.x = -Math.PI / 2;
  floorShadowCatcher.position.y = H * .006;
  floorShadowCatcher.receiveShadow = true;
  clinicGroup.add(floorShadowCatcher);

  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(width, roomHeight),
    clinicMaterial("#f5ead9")
  );

  wall.position.set(
    0,
    roomHeight / 2 - H * .05,
    wallZ
  );

  clinicGroup.add(wall);

  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(width, H * .03, H * .03),
    clinicMaterial("#d7c5a9")
  );

  trim.position.set(0, H * .12, wallZ + H * .02);
  clinicGroup.add(trim);

  const topBand = new THREE.Mesh(
    new THREE.BoxGeometry(width, H * .06, H * .05),
    clinicMaterial("#fffcf7")
  );

  topBand.position.set(0, H * 2.8, wallZ + H * .03);
  clinicGroup.add(topBand);

  const windowFrame = new THREE.Mesh(
    new THREE.BoxGeometry(H * 1.2, H * .82, H * .05),
    clinicMaterial("#ffffff")
  );

  windowFrame.position.set(
    -H * 2.4,
    H * 1.5,
    wallZ + H * .06
  );

  clinicGroup.add(windowFrame);

  const windowPane = new THREE.Mesh(
    new THREE.PlaneGeometry(H * 1.08, H * .70),
    clinicMaterial("#dce8fc", .4)
  );

  windowPane.position.set(
    -H * 2.4,
    H * 1.5,
    wallZ + H * .091
  );

  clinicGroup.add(windowPane);

  const artFrame = new THREE.Mesh(
    new THREE.BoxGeometry(H * .82, H * .92, H * .05),
    clinicMaterial("#c9ad8e")
  );

  artFrame.position.set(
    H * 2.4,
    H * 1.52,
    wallZ + H * .06
  );

  clinicGroup.add(artFrame);

  const artPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(H * .72, H * .82),
    clinicMaterial("#fffcf7")
  );

  artPanel.position.set(
    H * 2.4,
    H * 1.52,
    wallZ + H * .091
  );

  clinicGroup.add(artPanel);
}

function configureClinicShadowCamera(H) {
  const cam = clinicKeyLight.shadow.camera;
  const extent = H * (CLINIC_SHADOW.frustumScale ?? 5);

  cam.left = -extent;
  cam.right = extent;
  cam.top = extent;
  cam.bottom = -extent;
  cam.near = Math.max(.01, H * .1);
  cam.far = H * 30;
  cam.updateProjectionMatrix();

  const position = CLINIC_SHADOW.lightPosition ?? [-2.8, 7, 4];
  const target = CLINIC_SHADOW.lightTarget ?? [0, .8, -.4];

  clinicKeyLight.position.set(
    H * position[0],
    H * position[1],
    H * position[2]
  );

  clinicKeyLight.target.position.set(
    H * target[0],
    H * target[1],
    H * target[2]
  );

  scene.add(clinicKeyLight.target);
}

// Rug alignment
function updateRugShadowCatcher() {
  if (!rugObject) return;

  rugObject.updateWorldMatrix(true, true);

  const bounds = new THREE.Box3().setFromObject(rugObject);
  if (bounds.isEmpty()) return;

  if (!rugShadowCatcher) {
    rugShadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({
        color: 0x233b3d,
        opacity: .5
      })
    );

    rugShadowCatcher.rotation.x = -Math.PI / 2;
    rugShadowCatcher.receiveShadow = true;

    scene.add(rugShadowCatcher);
  }

  const size = bounds.getSize(tempVector);
  const center = bounds.getCenter(tempVector2);

  rugShadowCatcher.position.set(
    center.x,
    bounds.max.y + bodyHeight * SHADOW_RECEIVER_LIFT,
    center.z
  );

  rugShadowCatcher.scale.set(
    Math.max(.01, size.x),
    Math.max(.01, size.z),
    1
  );
}

function updateRugFollowing() {
  if (!rugObject || !rugAnchorLocal || !modelReady) {
    return;
  }

  const parent = rugObject.parent;
  if (!parent) return;

  scene.updateMatrixWorld(true);

  const currentCenter = rugObject.localToWorld(
    rugAnchorLocal.clone()
  );

  // Keep the rug centered during walking; follow the resting human.
  const targetX = entranceActive || exitActive
    ? 0
    : bodyRoot.position.x;

  const targetWorld = new THREE.Vector3(
    targetX,
    currentCenter.y,
    0
  );

  const currentLocal = parent.worldToLocal(
    currentCenter.clone()
  );

  const targetLocal = parent.worldToLocal(
    targetWorld.clone()
  );

  const dx = targetLocal.x - currentLocal.x;
  const dz = targetLocal.z - currentLocal.z;

  if (Math.abs(dx) > .00001 || Math.abs(dz) > .00001) {
    rugObject.position.x += dx;
    rugObject.position.z += dz;

    rugObject.updateWorldMatrix(true, true);
    markShadowDirty();
  }

  updateRugShadowCatcher();
}

// Recolor teal clinic furniture while preserving the imported GLB geometry,
// texture maps, metalness, roughness, and unrelated room materials.
// Adjust these values to customize the furniture palette.
const CLINIC_BLUE = {
  upholstery: 0x315F9C,
  cushions: 0x89B5E8,
  supports: 0x668DBD
};

function recolorClinicFurniture(clinicModel) {
  const recolored = new Map();
  const tealHue = color => {
    if (!color || color.getHex() === 0xffffff) return false;
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    return hsl.h >= 0.43 && hsl.h <= 0.57 && hsl.s > 0.10;
  };

  clinicModel.traverse(object => {
    if (!object.isMesh || !object.material) return;
    let path = '';
    for (let node = object; node && node !== clinicModel; node = node.parent) {
      path += ' ' + (node.name || '').toLowerCase();
    }
    // Never recolor walls, windows, rugs, floor, or other architecture.
    if (/floor|ground|wall|ceiling|window|glass|rug|carpet|screen|monitor/.test(path)) return;

    const recolorMaterial = material => {
      if (!material?.color) return material;
      const key = material.uuid;
      if (recolored.has(key)) return recolored.get(key);
      const label = `${path} ${(material.name || '').toLowerCase()}`;
      const furniture = /chair|stool|seat|cushion|pillow|bench|bed|table|upholster|padding|backrest|support|column|pole/.test(label);
      // Only recolor surfaces that are actually teal, to avoid blue-washing
      // furniture frames, skin, neutral surfaces, and other scene objects.
      if (!furniture || !tealHue(material.color)) return material;
      const copy = material.clone();
      const cushion = /cushion|pillow|padding/.test(label);
      const support = /support|column|pole/.test(label);
      copy.color.setHex(cushion ? CLINIC_BLUE.cushions : support ? CLINIC_BLUE.supports : CLINIC_BLUE.upholstery);
      recolored.set(key, copy);
      return copy;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(recolorMaterial)
      : recolorMaterial(object.material);
  });
}

function setupClinicModel(gltf, H) {
  const clinicModel = gltf.scene;

  clinicGroup.add(clinicModel);
  // Recoloring is cosmetic: a material issue must never prevent clinic display.
  try {
    recolorClinicFurniture(clinicModel);
  } catch (error) {
    console.warn("Clinic furniture recoloring skipped:", error);
  }
  clinicModel.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(clinicModel);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());

  const scale = Math.min(
    H * 2.45 / Math.max(size.y, .001),
    H * 3.9 / Math.max(size.x, .001),
    H * 2.8 / Math.max(size.z, .001)
  );

  clinicModel.scale.setScalar(scale);

  clinicModel.position.set(
    -center.x * scale,
    -bounds.min.y * scale,
    -center.z * scale - H * .78
  );

  clinicModel.updateMatrixWorld(true);

  rugObject = clinicModel.getObjectByName(RUG_NAME);

  if (rugObject) {
    const rugBounds = new THREE.Box3().setFromObject(rugObject);
    const rugCenter = rugBounds.getCenter(new THREE.Vector3());

    rugAnchorLocal = rugObject.worldToLocal(
      rugCenter.clone()
    );
  } else {
    console.warn("Rug not found:", RUG_NAME);
  }

  clinicModel.traverse(object => {
    if (!object.isMesh) return;

    let hierarchy = "";
    let node = object;

    while (node && node !== clinicModel) {
      hierarchy += " " + (node.name || "").toLowerCase();
      node = node.parent;
    }

    const structural =
      /floor|ground|wall|ceiling|window|glass|rug|carpet|floor.mat/.test(
        hierarchy
      );

    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material];

    const transparent = materials.some(
      material => material?.transparent && material.opacity < .5
    );

    object.castShadow = !structural && !transparent;
    object.receiveShadow = false;
  });

  if (rugObject) {
    updateRugFollowing();
  }

  markShadowDirty();
}

// Character setup
function setupHuman(character) {
  bodyRoot.add(character);

  character.updateMatrixWorld(true);

  const initialBounds = new THREE.Box3().setFromObject(character);
  const height = initialBounds.getSize(new THREE.Vector3()).y;

  if (height > 0) {
    character.scale.multiplyScalar(MODEL_HEIGHT / height);
  }

  character.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(character);
  const center = bounds.getCenter(new THREE.Vector3());

  character.position.x -= center.x;
  character.position.y -= bounds.min.y;
  character.position.z -= center.z;

  character.updateMatrixWorld(true);

  const normalizedBounds = new THREE.Box3().setFromObject(character);
  const size = normalizedBounds.getSize(new THREE.Vector3());

  bodyHeight = size.y;

  const halfWidth = Math.max(size.x / 2, .001);
  const centerX = normalizedBounds.getCenter(new THREE.Vector3()).x;

  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  character.traverse(object => {
    if (!object.isMesh) return;

    object.geometry = object.geometry.clone();

    const geometry = object.geometry;
    const positions = geometry.getAttribute("position");

    if (!geometry.getAttribute("normal")) {
      geometry.computeVertexNormals();
    }

    const normals = geometry.getAttribute("normal");
    const coordinates = new Float32Array(positions.count * 4);

    object.updateWorldMatrix(true, false);
    normalMatrix.getNormalMatrix(object.matrixWorld);

    for (let i = 0; i < positions.count; i++) {
      object.getVertexPosition(i, point);
      point.applyMatrix4(object.matrixWorld);

      normal.fromBufferAttribute(normals, i)
        .applyMatrix3(normalMatrix)
        .normalize();

      coordinates[i * 4] = (point.x - centerX) / halfWidth;
      coordinates[i * 4 + 1] =
        (point.y - normalizedBounds.min.y) / bodyHeight;
      coordinates[i * 4 + 2] = normal.x;
      coordinates[i * 4 + 3] = normal.z * FRONT_DIRECTION;
    }

    geometry.setAttribute(
      "bodyCoord",
      new THREE.BufferAttribute(coordinates, 4)
    );

    object.material = createBodyMaterial();
    object.castShadow = true;
    object.receiveShadow = false;

  });

  buildClinicShell(bodyHeight);
  configureClinicShadowCamera(bodyHeight);

  modelReady = true;

  resize();
  setBodyView("front", false);
}

// Animation setup
function removeHorizontalRootMotion(clip, anchor = null) {
  const normalized = clip.clone();

  normalized.tracks.forEach(track => {
    if (!/hips.*\.position$/i.test(track.name)) return;

    const values = track.values;
    const x = anchor ? anchor[0] : values[0];
    const z = anchor ? anchor[1] : values[2];

    for (let i = 0; i < values.length; i += 3) {
      values[i] = x;
      values[i + 2] = z;
    }
  });

  return normalized;
}

function setupCharacterAnimations(walking, breathing) {
  const walkClip = walking.animations[0];
  const idleClip = breathing.animations[0];

  if (!walkClip || !idleClip) {
    throw new Error("Walking and breathing files need animation clips.");
  }

  characterMixer = new THREE.AnimationMixer(walking);

  const toes = [];
  const feet = [];

  walking.traverse(object => {
    if (!object.isBone) return;

    if (/lefttoebase|righttoebase|lefttoe|righttoe/i.test(object.name)) {
      toes.push(object);
    } else if (/leftfoot|rightfoot/i.test(object.name)) {
      feet.push(object);
    }
  });

  footBones = toes.length >= 2 ? toes : feet;

  const hipsTrack = walkClip.tracks.find(
    track => /hips.*\.position$/i.test(track.name)
  );

  const anchor = hipsTrack
    ? [hipsTrack.values[0], hipsTrack.values[2]]
    : null;

  walkAction = characterMixer.clipAction(
    removeHorizontalRootMotion(walkClip)
  );

  idleAction = characterMixer.clipAction(
    removeHorizontalRootMotion(idleClip, anchor)
  );

  walkAction.setLoop(THREE.LoopRepeat);
  idleAction.setLoop(THREE.LoopRepeat);

  idleAction.play();
  characterGroundInitialized = false;
}

function enterWalkingState() {
  if (!walkAction || !idleAction) return;

  walkAction.reset().play();
  walkAction.setEffectiveWeight(1);

  if (idleAction.isRunning()) {
    idleAction.crossFadeTo(walkAction, .35, true);
  }
}

function enterIdleState() {
  if (!walkAction || !idleAction) return;

  idleAction.reset().play();
  idleAction.setEffectiveWeight(1);

  walkAction.crossFadeTo(idleAction, .55, true);
}

// Character ground positioning
const footWorldPosition = new THREE.Vector3();
const characterBounds = new THREE.Box3();
const rugGroundBounds = new THREE.Box3();

function groundAnimatedCharacter(dt) {
  if (!characterMixer || !modelReady) return;

  const groundY = rugObject
    ? rugGroundBounds.setFromObject(rugObject).max.y
    : 0;

  bodyRoot.updateMatrixWorld(true);

  let lowestY = Infinity;

  for (const foot of footBones) {
    foot.getWorldPosition(footWorldPosition);
    lowestY = Math.min(lowestY, footWorldPosition.y);
  }

  if (!Number.isFinite(lowestY)) {
    characterBounds.makeEmpty();

    bodyRoot.traverse(object => {
      if (!object.isSkinnedMesh) return;

      object.computeBoundingBox();

      const bounds = object.boundingBox.clone()
        .applyMatrix4(object.matrixWorld);

      characterBounds.union(bounds);
    });

    if (!characterBounds.isEmpty()) {
      lowestY = characterBounds.min.y;
    }
  }

  if (!Number.isFinite(lowestY)) return;

  const soleOffset = bodyHeight * FOOT_GROUND_CLEARANCE;

  const correction = groundY + soleOffset - lowestY;

  const blend = characterGroundInitialized
    ? 1 - Math.exp(-16 * dt)
    : 1;

  bodyRoot.position.y += correction * blend;
  characterGroundInitialized = true;

  bodyRoot.updateMatrixWorld(true);
}

// Camera
function updateCamera() {
  if (!modelReady) return;

  const savedRotation = bodyRoot.rotation.y;
  const savedX = bodyRoot.position.x;
  const savedY = bodyRoot.position.y;

  bodyRoot.rotation.y = 0;
  bodyRoot.position.x = 0;
  bodyRoot.position.y = 0;
  bodyRoot.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(bodyRoot);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());

  bodyRoot.rotation.y = savedRotation;
  bodyRoot.position.x = savedX;
  bodyRoot.position.y = savedY;
  bodyRoot.updateMatrixWorld(true);

  const aspect = Math.max(
    viewer.clientWidth / Math.max(viewer.clientHeight, 1),
    .1
  );

  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);

  const distanceY = (size.y / 2) / Math.tan(vfov / 2);
  const distanceX = (size.x / 2) / Math.tan(hfov / 2);

  const distance = Math.max(distanceY, distanceX) *
    1.25 + size.z / 2;

  const aimY = center.y + bodyHeight * .025;

  camera.position.set(center.x, aimY, center.z + distance);
  camera.lookAt(center.x, aimY, center.z);

  camera.near = Math.max(.001, distance / 1000);
  camera.far = distance * 25;
  camera.updateProjectionMatrix();
}

function setBodyView(side, animate = true) {
  const destination = side === "back" ? Math.PI : 0;
  const current = bodyRoot.rotation.y;

  const difference = Math.atan2(
    Math.sin(destination - current),
    Math.cos(destination - current)
  );

  targetBodyRotationY = current + difference;

  if (!animate) {
    bodyRoot.rotation.y = targetBodyRotationY;
  }
}

function updateHumanTargetX() {
  if (
    !modelReady ||
    mobileQuery.matches ||
    !presetPanel.classList.contains("open")
  ) {
    humanTargetX = 0;
    return;
  }

  const viewerRect = viewer.getBoundingClientRect();
  const leftRect = bodyPanel.getBoundingClientRect();

  const rightPanelLeft = viewerRect.right -
    parseFloat(getComputedStyle(presetPanel).right || "24") -
    presetPanel.offsetWidth;

  const availableCenter =
    (leftRect.right + rightPanelLeft) / 2;

  const screenCenter =
    viewerRect.left + viewerRect.width / 2;

  const pixelShift = availableCenter - screenCenter;

  const distance = Math.abs(
    camera.position.z - bodyRoot.position.z
  );

  const visibleWorldWidth =
    2 * distance *
    Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) *
    camera.aspect;

  humanTargetX =
    pixelShift * visibleWorldWidth / viewerRect.width;
}

// Entrance and exit
function startEntrance() {
  if (!modelReady) return;

  if (reducedMotion.matches) {
    entranceActive = false;
    bodyRoot.position.x = 0;
    enterIdleState();
    return;
  }

  const distance = Math.abs(
    camera.position.z - bodyRoot.position.z
  );

  const halfVisibleWidth =
    distance *
    Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) *
    camera.aspect;

  entranceStartX =
    halfVisibleWidth + bodyHeight * .6;

  entranceElapsed = 0;
  entranceActive = true;

  bodyRoot.position.x = entranceStartX;
  bodyRoot.rotation.y = -Math.PI / 2;
  targetBodyRotationY = -Math.PI / 2;

  enterWalkingState();
  markShadowDirty();
}

function advanceEntrance(dt) {
  if (!entranceActive) return null;

  entranceElapsed = Math.min(
    ENTRANCE_DURATION,
    entranceElapsed + dt
  );

  const t = entranceElapsed / ENTRANCE_DURATION;
  const eased = t * t * (3 - 2 * t);

  const x = THREE.MathUtils.lerp(
    entranceStartX,
    0,
    eased
  );

  if (t > .86) {
    targetBodyRotationY = 0;
  }

  if (t >= 1) {
    entranceActive = false;
    targetBodyRotationY = 0;
    enterIdleState();
  }

  return x;
}

function startExit() {
  if (!modelReady || entranceActive || exitActive || cinematicActive) return;

  // Clear the selected region immediately, including any fading shader highlight.
  activeRegionId = null;
  highlightTime = 0;
  highlightSlots.forEach((slot, index) => {
    slot.regionId = null;
    slot.strength = 0;
    slot.target = 0;
    writeSlotUniforms(index, null);
  });
  highlightUniforms.uRegionStrength.value = [0, 0];
  document.querySelectorAll(".part.active").forEach(button => {
    button.classList.remove("active");
    button.setAttribute("aria-pressed", "false");
  });
  closePresetPanel();
  setMobileMenu(false);
  document.body.classList.add("exit-playing");

  exitActive = true;
  exitElapsed = 0;
  exitStartX = bodyRoot.position.x;

  targetBodyRotationY = Math.PI / 2;

  enterWalkingState();
}

function advanceExit(dt) {
  if (!exitActive) return null;

  exitElapsed += dt;

  const distance = Math.abs(
    camera.position.z - bodyRoot.position.z
  );

  const halfVisibleWidth =
    distance *
    Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) *
    camera.aspect;

  const t = Math.min(1, exitElapsed / EXIT_DURATION);
  const eased = t * t * (3 - 2 * t);

  const x = THREE.MathUtils.lerp(
    exitStartX,
    halfVisibleWidth + bodyHeight,
    eased
  );

  if (t >= 1) {
    navigateWithLoading();
  }

  return x;
}

document.getElementById("backButton")
  .addEventListener("click", startExit);

// Body regions are selected exclusively through the left-side buttons.

// Pointer controls
viewer.addEventListener("pointerdown", event => {
  if (!modelReady || cinematicActive) return;

  dragging = true;
  activePointer = event.pointerId;
  lastPointerX = event.clientX;

  viewer.classList.add("dragging");
  viewer.setPointerCapture(activePointer);
});

viewer.addEventListener("pointermove", event => {
  mouseX = THREE.MathUtils.clamp(
    (event.clientX / Math.max(viewer.clientWidth, 1)) * 2 - 1,
    -1,
    1
  );

  if (!dragging || activePointer !== event.pointerId) {
    return;
  }

  if (!entranceActive && !exitActive) {
    const dx = event.clientX - lastPointerX;
    targetBodyRotationY += dx * .01;
  }

  lastPointerX = event.clientX;
});

viewer.addEventListener("pointerup", event => {
  if (event.pointerId !== activePointer) return;

  dragging = false;
  activePointer = null;
  viewer.classList.remove("dragging");

  if (viewer.hasPointerCapture(event.pointerId)) {
    viewer.releasePointerCapture(event.pointerId);
  }
});

viewer.addEventListener("pointercancel", () => {
  dragging = false;
  activePointer = null;
  viewer.classList.remove("dragging");
});

// Highlights
function animateHighlights(dt) {
  const smooth = reducedMotion.matches
    ? 1
    : 1 - Math.exp(
        -(HIGHLIGHT_ANIMATION.fadeSpeed || 8) * dt
      );

  highlightSlots.forEach((slot, index) => {
    slot.strength +=
      (slot.target - slot.strength) * smooth;

    highlightUniforms.uRegionStrength.value[index] =
      slot.strength;
  });

  highlightTime += dt;

  const pulsing =
    Boolean(activeRegionId) && !reducedMotion.matches;

  const speed = HIGHLIGHT_ANIMATION.pulseSpeed || 2;
  const strength = HIGHLIGHT_ANIMATION.pulseStrength || .08;

  highlightUniforms.uPulse.value = pulsing
    ? 1 - strength / 2 +
      Math.sin(highlightTime * speed) * strength / 2
    : 1;
}

// Clinic animation
function animateClinic(dt) {
  if (
    !CLINIC_ANIMATION.enabled ||
    reducedMotion.matches
  ) {
    clinicGroup.rotation.y = 0;
    clinicGroup.position.x = 0;
    return;
  }

  if (!(dragging && CLINIC_ANIMATION.pauseWhileDragging)) {
    clinicTime += dt;
  }

  const rotation =
    Math.sin(clinicTime * CLINIC_ANIMATION.rotationSpeed) *
    THREE.MathUtils.degToRad(
      CLINIC_ANIMATION.rotationAmount
    );

  const interactive =
    mouseX *
    THREE.MathUtils.degToRad(
      CLINIC_ANIMATION.mouseRotation
    );

  const targetRotation = rotation + interactive;

  const targetX =
    -Math.sin(clinicTime * CLINIC_ANIMATION.rotationSpeed) *
    bodyHeight *
    CLINIC_ANIMATION.horizontalMovement;

  const smooth =
    1 - Math.pow(
      1 - CLINIC_ANIMATION.smoothness,
      dt * 60
    );

  clinicGroup.rotation.y = THREE.MathUtils.lerp(
    clinicGroup.rotation.y,
    targetRotation,
    smooth
  );

  clinicGroup.position.x = THREE.MathUtils.lerp(
    clinicGroup.position.x,
    targetX,
    smooth
  );
}

// Resize
function resize() {
  const width = viewer.clientWidth;
  const height = viewer.clientHeight;

  if (!width || !height) return;

  renderer.setPixelRatio(
    Math.min(
      devicePixelRatio,
      mobileQuery.matches ? MOBILE_PIXEL_RATIO : 2
    )
  );

  renderer.setSize(width, height, false);

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  if (modelReady) {
    if (!cinematicActive) updateCamera();
    if (!cinematicActive) updateHumanTargetX();
    markShadowDirty();
  }
}

const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(viewer);

mobileQuery.addEventListener("change", resize);

// Load models
async function initScene() {
  try {
    console.info("FahrenCool: loading clinic GLB", CLINIC_URL);
    const clinicPromise = gltfLoader.loadAsync(CLINIC_URL).then(gltf => {
      let meshes = 0;
      gltf.scene.traverse(node => { if (node.isMesh) meshes++; });
      console.info("FahrenCool: clinic parsed", { meshes, visible: gltf.scene.visible });
      return gltf;
    }).catch(error => {
      console.error("FahrenCool: clinic GLB download/parse failed:", error);
      return null;
    });

    const [walking, breathing, clinic] = await Promise.all([
      fbxLoader.loadAsync(WALK_FILE),
      fbxLoader.loadAsync(IDLE_FILE),
      clinicPromise
    ]);

    setupHuman(walking);
    setupCharacterAnimations(walking, breathing);

    if (clinic) {
      try {
        setupClinicModel(clinic, bodyHeight);
        const clinicBounds = new THREE.Box3().setFromObject(clinic.scene);
        console.info("FahrenCool: clinic placed", {
          boundsMin: clinicBounds.min.toArray(),
          boundsMax: clinicBounds.max.toArray(),
          scale: clinic.scene.scale.x
        });
      } catch (error) {
        console.error("FahrenCool: clinic placement failed:", error);
        clinicGroup.remove(clinic.scene);
        rugObject = null;
      }
    } else {
      console.warn("FahrenCool: continuing with the human model only; clinic GLB unavailable.");
    }

    updateRugFollowing();

    startCinematic();
    clock.getDelta(); // Discard time spent loading assets

    markShadowDirty();
    renderer.shadowMap.needsUpdate = true;
    // Keep the lightweight CSS/SVG loader responsive during asset parsing.
    // Only begin the expensive continuous 3D render loop once everything is ready.
    renderer.render(scene, camera);
    startLoop();
    requestAnimationFrame(() => loading.classList.add("hidden"));

  } catch (error) {
    console.error(error);

    loading.classList.add("failed");
    loadMessage.textContent =
      "Could not load the 3D models. Check the assets folder and file names.";
  }
}

// Render loop
function frame(now) {
  rafId = requestAnimationFrame(frame);

  if (
    mobileQuery.matches &&
    now - lastFrameTime < MOBILE_FRAME_MS
  ) {
    return;
  }

  lastFrameTime = now;

  const dt = Math.min(clock.getDelta(), .05);
  if (!modelReady) return;

  const previousX = bodyRoot.position.x;
  const previousRotation = bodyRoot.rotation.y;

  advanceCinematic(dt);
  const entranceX = advanceEntrance(dt);
  const exitX = advanceExit(dt);

  const slideSmooth = reducedMotion.matches
    ? 1
    : 1 - Math.exp(-5 * dt);

  let nextX =
    cinematicActive ? 0 :
    exitX ??
    entranceX ??
    THREE.MathUtils.lerp(
      previousX,
      humanTargetX,
      slideSmooth
    );

  if (
    !entranceActive &&
    !exitActive &&
    Math.abs(nextX - humanTargetX) < bodyHeight * .0001
  ) {
    nextX = humanTargetX;
  }

  const rotationSmooth =
    1 - Math.exp(-ROTATION_SPEED * dt);

  let nextRotation = cinematicActive ? 0 : THREE.MathUtils.lerp(
    previousRotation,
    targetBodyRotationY,
    rotationSmooth
  );

  if (
    Math.abs(nextRotation - targetBodyRotationY) < .0001
  ) {
    nextRotation = targetBodyRotationY;
  }

  bodyRoot.position.x = nextX;
  bodyRoot.rotation.y = nextRotation;

  if (characterMixer) {
    characterMixer.update(dt);
  }

  animateClinic(dt);

  // Keep the animated character aligned with the rug.
  updateRugFollowing();
  groundAnimatedCharacter(dt);

  animateHighlights(dt);

  if (characterMixer) {
    markShadowDirty();
  }

  if (
    nextX !== previousX ||
    nextRotation !== previousRotation
  ) {
    markShadowDirty();
  }

  if (shadowDirty && (!mobileQuery.matches || now - lastMobileShadowUpdate >= MOBILE_SHADOW_INTERVAL_MS)) {
    renderer.shadowMap.needsUpdate = true;
    shadowDirty = false;
    lastMobileShadowUpdate = now;
  }

  renderer.render(scene, camera);
}

function startLoop() {
  if (rafId || disposed) return;

  clock.getDelta();
  lastFrameTime = 0;
  lastMobileShadowUpdate = 0;
  rafId = requestAnimationFrame(frame);
}

function stopLoop() {
  if (!rafId) return;

  cancelAnimationFrame(rafId);
  rafId = 0;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopLoop();
  } else {
    startLoop();
  }
});

// Cleanup
function disposeApp() {
  if (disposed) return;

  disposed = true;
  stopLoop();
  resizeObserver.disconnect();

  renderer.dispose();
}

window.addEventListener("pagehide", event => {
  if (!event.persisted) {
    disposeApp();
  }
});

resize();
initScene();