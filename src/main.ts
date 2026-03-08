import './style.css';
import L from 'leaflet';
import { GameEngine } from './game/engine';

// --- State and Constants ---
let map: L.Map;
let streetLayer: L.TileLayer;
let satelliteLayer: L.TileLayer;
let currentTheme: 'street' | 'pacman' | 'satellite' = 'street';
let userPos: [number, number] = [51.505, -0.09];
let currentRotation = 0;
let activeKey: 'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight' | null = null;
let bufferedKey: 'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight' | null = null;
let pacCurrentNodeId: string | null = null;
let pacTargetNodeId: string | null = null;
let pacProgress = 0;
let lastFrameTime = 0;
let isGameOver = false;
let isRespawning = false;
let respawnBlinkOn = true;
let respawnTimer = 0;
const pacSpeed = 80; // m/s

const engine = new GameEngine();

// Canvas + context
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

// Pac-Man position in lat/lng (interpolated)
let pacLatLng: L.LatLng | null = null;

// Cached street edges
let streetEdges: Array<{ aLat: number; aLon: number; bLat: number; bLon: number }> = [];

interface GhostState {
  id: string;
  color: string;
  currentNodeId: string;
  targetNodeId: string;
  prevNodeId: string | null;
  progress: number;
  lat: number;
  lon: number;
  blinkTimer: number;
  blinkDuration: number;
  isBlinking: boolean;
  shape: number;
}
const ghosts: GhostState[] = [];

// Mouth animation state
let mouthAngle = 0;
let mouthOpening = true;

const HUD = {
  score: document.getElementById('score') as HTMLElement,
  lives: document.getElementById('lives') as HTMLElement,
  viewToggle: document.getElementById('view-toggle') as HTMLButtonElement,
  loading: document.getElementById('loading-screen') as HTMLElement,
  gameOverScreen: document.getElementById('game-over-screen') as HTMLElement,
  finalScore: document.getElementById('final-score') as HTMLElement,
  btnRestart: document.getElementById('btn-restart') as HTMLButtonElement,
  startScreen: document.getElementById('start-screen') as HTMLElement,
  btnStart: document.getElementById('btn-start') as HTMLButtonElement,
  citySelect: document.getElementById('city-select') as HTMLSelectElement,
  hudCitySelect: document.getElementById('hud-city-select') as HTMLSelectElement,
};

// --- Theme colors ---
function getThemeColors() {
  if (currentTheme === 'pacman') {
    return {
      streetGlow: '#1919A6',
      streetGlowWidth: 18,
      streetGlowShadow: 4,
      streetInner: '#000000',
      streetInnerWidth: 12,
      streetInnerAlpha: 1,
      dotCircle: '#ffde00',
      dotText: '#0a0a5c',
    };
  } else if (currentTheme === 'satellite') {
    return {
      streetGlow: '#00d2ff',
      streetGlowWidth: 18,
      streetGlowShadow: 12,
      streetInner: '#0b0c10',
      streetInnerWidth: 14,
      streetInnerAlpha: 0.75,
      dotCircle: '#ffde00',
      dotText: '#0a0a5c',
    };
  } else {
    return {
      streetGlow: '#ffffff',
      streetGlowWidth: 14,
      streetGlowShadow: 0,
      streetInner: '#00d2ff',
      streetInnerWidth: 8,
      streetInnerAlpha: 0.8,
      dotCircle: '#ffde00',
      dotText: '#000000',
    };
  }
}

// --- Map Initialization ---
function initMap(lat: number, lon: number) {
  userPos = [lat, lon];

  map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    keyboard: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
  }).setView(userPos, 19);

  streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
  satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');

  document.getElementById('map')?.classList.add('theme-street');

  // Setup canvas overlay
  canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  ctx = canvas.getContext('2d')!;
  resizeCanvas();
  window.addEventListener('resize', () => { resizeCanvas(); drawFrame(); });
  map.on('move zoom moveend zoomend resize zoomanim', () => { resizeCanvas(); drawFrame(); });

  setupInput();
  fetchNearbyStreets(lat, lon);
}

function resizeCanvas() {
  const mapEl = document.getElementById('map')!;
  const w = mapEl.clientWidth;
  const h = mapEl.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

// --- Geolocation ---
function getLocation() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        initMap(position.coords.latitude, position.coords.longitude);
      },
      (error) => {
        console.error("Error getting location:", error);
        initMap(51.505, -0.09);
      }
    );
  } else {
    initMap(51.505, -0.09);
  }
}

// --- Start Screen ---
function setupStartScreen() {
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="loc-mode"]');
  const labels = document.querySelectorAll<HTMLLabelElement>('.start-radio');

  radios.forEach(radio => {
    radio.addEventListener('change', () => {
      labels.forEach(l => l.classList.remove('selected'));
      const parent = radio.closest('.start-radio');
      if (parent) parent.classList.add('selected');
      HUD.citySelect.disabled = radio.value !== 'city';
    });
  });

  HUD.btnStart.addEventListener('click', () => {
    const mode = document.querySelector<HTMLInputElement>('input[name="loc-mode"]:checked')!.value;
    HUD.startScreen.classList.add('hidden');
    HUD.loading.classList.remove('hidden');
    HUD.loading.style.display = '';

    if (mode === 'city' && HUD.citySelect.value) {
      const [lat, lon] = HUD.citySelect.value.split(',').map(Number);
      HUD.hudCitySelect.value = HUD.citySelect.value;
      initMap(lat, lon);
    } else {
      HUD.hudCitySelect.value = '';
      getLocation();
    }
  });
}

// --- Switch City (HUD) ---
function switchCity(lat: number, lon: number) {
  HUD.loading.classList.remove('hidden');
  HUD.loading.style.display = '';

  engine.resetGame();
  isGameOver = false;
  isRespawning = false;
  activeKey = null;
  bufferedKey = null;
  pacCurrentNodeId = null;
  pacTargetNodeId = null;
  pacProgress = 0;
  lastFrameTime = 0;
  ghosts.length = 0;
  streetEdges = [];
  pacLatLng = null;
  HUD.gameOverScreen.classList.add('hidden');
  updateHUD();

  userPos = [lat, lon];
  map.setView(userPos, 19);
  fetchNearbyStreets(lat, lon);
}

// --- View Toggle ---
HUD.viewToggle.innerText = 'Street View';
HUD.viewToggle.addEventListener('click', () => {
  const mapEl = document.getElementById('map');
  if (!mapEl) return;

  if (currentTheme === 'pacman') {
    currentTheme = 'satellite';
    HUD.viewToggle.innerText = 'Satellite View';
    mapEl.classList.remove('theme-pacman');
    mapEl.classList.add('theme-satellite');
    map.removeLayer(streetLayer);
    satelliteLayer.addTo(map);
  } else if (currentTheme === 'satellite') {
    currentTheme = 'street';
    HUD.viewToggle.innerText = 'Street View';
    mapEl.classList.remove('theme-satellite');
    mapEl.classList.add('theme-street');
    map.removeLayer(satelliteLayer);
    streetLayer.addTo(map);
  } else {
    currentTheme = 'pacman';
    HUD.viewToggle.innerText = 'Tech-Man View';
    mapEl.classList.remove('theme-street');
    mapEl.classList.add('theme-pacman');
    if (!map.hasLayer(streetLayer)) {
      map.removeLayer(satelliteLayer);
      streetLayer.addTo(map);
    }
  }
});

// --- Overpass API ---
async function fetchNearbyStreets(lat: number, lon: number, retries = 3) {
  const radius = 300;
  const query = `
    [out:json];
    (
      way["highway"~"^(primary|secondary|tertiary|residential|service|footway)$"](around:${radius},${lat},${lon});
    );
    out body;
    >;
    out skel qt;
  `;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    processOSMData(data);
  } catch (error) {
    console.error("Error fetching OSM data:", error);
    if (retries > 0) {
      console.log(`Retrying OSM fetch... (${retries} attempts left)`);
      setTimeout(() => fetchNearbyStreets(lat, lon, retries - 1), 2000);
    } else {
      HUD.loading.innerHTML = `<p style="color: #ff4d4d">Failed to load streets after several attempts. Please refresh.</p>`;
    }
  }
}

function processOSMData(data: any) {
  engine.buildGraph(data);
  const spawnNode = engine.findBestSpawnNode(userPos[0], userPos[1]);
  engine.setInitialPacmanPosition(spawnNode);

  const pacNode = engine.getPacmanNode();
  if (pacNode) {
    pacLatLng = L.latLng(pacNode.lat, pacNode.lon);
    map.setView([pacNode.lat, pacNode.lon], 19);
  }

  cacheStreetEdges();
  spawnGhosts();

  HUD.loading.classList.add('hidden');
  HUD.loading.style.display = 'none';
}

function cacheStreetEdges() {
  streetEdges = [];
  const drawnEdges = new Set<string>();
  const nodes = engine.getNodes();

  nodes.forEach(node => {
    node.neighbors.forEach(neighborId => {
      const edgeId = [node.id, neighborId].sort().join('-');
      if (!drawnEdges.has(edgeId)) {
        drawnEdges.add(edgeId);
        const nb = nodes.get(neighborId);
        if (nb) {
          streetEdges.push({ aLat: node.lat, aLon: node.lon, bLat: nb.lat, bLon: nb.lon });
        }
      }
    });
  });
}

function spawnGhosts() {
  ghosts.length = 0;
  const colors = ['#ff0000', '#ffb8ff', '#00ffff', '#ffb852', '#ff6600', '#66ff33', '#ff33cc', '#33ccff'];
  const nodes = Array.from(engine.getNodes().values()).filter(n => n.neighbors.length > 0);
  if (nodes.length === 0) return;

  colors.forEach((color, i) => {
    const randNode = nodes[Math.floor(Math.random() * nodes.length)];
    const nextId = randNode.neighbors[Math.floor(Math.random() * randNode.neighbors.length)];

    ghosts.push({
      id: `ghost_${i}`,
      color,
      currentNodeId: randNode.id,
      targetNodeId: nextId,
      prevNodeId: null,
      progress: 0,
      lat: randNode.lat,
      lon: randNode.lon,
      blinkTimer: Math.random() * 3000 + 1500,
      blinkDuration: 0,
      isBlinking: false,
      shape: i % 4,
    });
  });
}

function showGameOver() {
  if (isGameOver) return;
  isGameOver = true;
  HUD.finalScore.innerText = engine.getState().score.toString();
  HUD.gameOverScreen.classList.remove('hidden');
}

function resetGameParams() {
  engine.resetGame();
  isGameOver = false;
  isRespawning = false;
  activeKey = null;
  bufferedKey = null;
  pacCurrentNodeId = null;
  pacTargetNodeId = null;
  pacProgress = 0;

  HUD.gameOverScreen.classList.add('hidden');

  ghosts.length = 0;

  const nearestNode = engine.findBestSpawnNode(userPos[0], userPos[1]);
  engine.setInitialPacmanPosition(nearestNode);
  const pacNode = engine.getPacmanNode();
  if (pacNode) {
    pacLatLng = L.latLng(pacNode.lat, pacNode.lon);
    map.setView([pacNode.lat, pacNode.lon], 19);
  }

  updateHUD();
  spawnGhosts();
  lastFrameTime = 0;
}

HUD.btnRestart.addEventListener('click', () => {
  resetGameParams();
});

HUD.hudCitySelect.addEventListener('change', () => {
  const val = HUD.hudCitySelect.value;
  if (val) {
    const [lat, lon] = val.split(',').map(Number);
    switchCity(lat, lon);
  } else {
    // "GPS" selected — re-geolocate
    if (navigator.geolocation) {
      HUD.loading.classList.remove('hidden');
      HUD.loading.style.display = '';
      navigator.geolocation.getCurrentPosition(
        (pos) => switchCity(pos.coords.latitude, pos.coords.longitude),
        () => switchCity(51.505, -0.09)
      );
    }
  }
});

function triggerRespawn() {
  isRespawning = true;
  lastFrameTime = 0;
  activeKey = null;
  bufferedKey = null;
  respawnTimer = 0;
  respawnBlinkOn = true;

  ghosts.length = 0;
  updateHUD();

  setTimeout(() => {
    pacCurrentNodeId = engine.getInitialPacmanNodeId();
    pacTargetNodeId = null;
    pacProgress = 0;

    const initNode = engine.getNodes().get(pacCurrentNodeId)!;
    engine.setPacmanPosition(pacCurrentNodeId);
    pacLatLng = L.latLng(initNode.lat, initNode.lon);

    map.panTo([initNode.lat, initNode.lon], { animate: true, duration: 0.5 });

    setTimeout(() => {
       if (!isGameOver) {
         spawnGhosts();
         isRespawning = false;
         lastFrameTime = performance.now();
       }
    }, 600);
  }, 2000);
}

function updateHUD() {
  const state = engine.getState();
  HUD.score.innerText = state.score.toString().padStart(4, '0');
  HUD.lives.innerText = '\u2764'.repeat(state.lives);
}

function updatePacmanRotation(cId: string, tId: string) {
  const cNode = engine.getNodes().get(cId)!;
  const tNode = engine.getNodes().get(tId)!;
  const p1 = map.project([cNode.lat, cNode.lon], map.getMaxZoom());
  const p2 = map.project([tNode.lat, tNode.lon], map.getMaxZoom());
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  if (dx === 0 && dy === 0) return;

  const targetRotation = Math.atan2(dy, dx) * 180 / Math.PI;
  let diff = targetRotation - currentRotation;
  diff = ((diff % 360) + 540) % 360 - 180;
  currentRotation += diff;
}

// =============================================
//  CANVAS DRAWING
// =============================================

function toPoint(lat: number, lon: number): L.Point {
  return map.latLngToContainerPoint([lat, lon]);
}

function drawStreets() {
  const colors = getThemeColors();

  // Glow pass
  ctx.save();
  ctx.strokeStyle = colors.streetGlow;
  ctx.lineWidth = colors.streetGlowWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (colors.streetGlowShadow > 0) {
    ctx.shadowColor = colors.streetGlow;
    ctx.shadowBlur = colors.streetGlowShadow;
  }
  ctx.beginPath();
  for (const edge of streetEdges) {
    const a = toPoint(edge.aLat, edge.aLon);
    const b = toPoint(edge.bLat, edge.bLon);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();

  // Inner pass
  ctx.save();
  ctx.strokeStyle = colors.streetInner;
  ctx.lineWidth = colors.streetInnerWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = colors.streetInnerAlpha;
  ctx.beginPath();
  for (const edge of streetEdges) {
    const a = toPoint(edge.aLat, edge.aLon);
    const b = toPoint(edge.bLat, edge.bLon);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawDots() {
  const colors = getThemeColors();
  const dots = engine.getDots();
  const dotRadius = 9;
  const minDist = dotRadius * 2.5; // minimum distance between dots to avoid overlap
  const minDistSq = minDist * minDist;
  const placed: Array<{ x: number; y: number }> = [];

  ctx.save();
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const dot of dots) {
    const p = toPoint(dot.lat, dot.lon);
    const px = Math.round(p.x);
    const py = Math.round(p.y);

    // Skip dots that overlap with already-placed ones
    let tooClose = false;
    for (let k = 0; k < placed.length; k++) {
      const dx = px - placed[k].x;
      const dy = py - placed[k].y;
      if (dx * dx + dy * dy < minDistSq) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    placed.push({ x: px, y: py });

    // Stable 0/1 from node id
    let hash = 0;
    for (let j = 0; j < dot.id.length; j++) hash += dot.id.charCodeAt(j);

    // Circle
    ctx.beginPath();
    ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = colors.dotCircle;
    ctx.globalAlpha = 0.9;
    ctx.fill();

    // Number
    ctx.fillStyle = colors.dotText;
    ctx.globalAlpha = 1;
    ctx.fillText(hash % 2 === 0 ? '0' : '1', px, py + 1);
  }
  ctx.restore();
}

function drawPacman() {
  if (!pacLatLng) return;

  // Respawn blink
  if (isRespawning) {
    respawnTimer++;
    if (respawnTimer % 10 === 0) respawnBlinkOn = !respawnBlinkOn;
    if (!respawnBlinkOn) return;
  }

  const p = toPoint(pacLatLng.lat, pacLatLng.lng);
  const radius = 22;
  const rot = (currentRotation * Math.PI) / 180;

  // Animate mouth
  if (activeKey) {
    if (mouthOpening) {
      mouthAngle += 0.08;
      if (mouthAngle >= 0.85) mouthOpening = false;
    } else {
      mouthAngle -= 0.08;
      if (mouthAngle <= 0.05) mouthOpening = true;
    }
  } else {
    mouthAngle += (0.15 - mouthAngle) * 0.1;
  }

  // Teeth geometry
  const teethCount = 7;
  const teethStart = -radius + 2;
  const teethEnd = radius - 2;
  const teethStep = (teethEnd - teethStart) / teethCount;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(rot);

  // --- Upper jaw ---
  ctx.save();
  ctx.rotate(-mouthAngle);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, radius, -Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = '#141c28';
  ctx.fill();
  ctx.strokeStyle = '#ffd22f';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Hood accent
  ctx.beginPath();
  ctx.arc(0, 0, radius - 4, -2.6, -0.5);
  ctx.strokeStyle = '#ffdd66';
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.75;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Upper teeth
  ctx.beginPath();
  ctx.moveTo(teethStart, 0);
  for (let i = 0; i < teethCount; i++) {
    const x1 = teethStart + i * teethStep + teethStep * 0.5;
    const x2 = teethStart + (i + 1) * teethStep;
    ctx.lineTo(x1, 5);
    ctx.lineTo(x2, 0);
  }
  ctx.fillStyle = 'white';
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();

  // --- Lower jaw ---
  ctx.save();
  ctx.rotate(mouthAngle);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, radius, 0, Math.PI);
  ctx.closePath();
  ctx.fillStyle = '#141c28';
  ctx.fill();
  ctx.strokeStyle = '#ffd22f';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Lower teeth
  ctx.beginPath();
  ctx.moveTo(teethStart, 0);
  for (let i = 0; i < teethCount; i++) {
    const x1 = teethStart + i * teethStep + teethStep * 0.5;
    const x2 = teethStart + (i + 1) * teethStep;
    ctx.lineTo(x1, -5);
    ctx.lineTo(x2, 0);
  }
  ctx.fillStyle = 'white';
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();

  // Subtle glow
  ctx.shadowColor = 'rgba(255, 210, 47, 0.3)';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 210, 47, 0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // --- X-eye: always stays on top regardless of rotation ---
  // Draw in screen space — fixed position above head center
  ctx.save();
  ctx.rotate(-rot); // undo body rotation to get screen-aligned coords
  ctx.strokeStyle = '#ffd22f';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255, 210, 47, 0.85)';
  ctx.shadowBlur = 4;
  const eyeScreenX = 3;
  const eyeScreenY = -10;
  ctx.beginPath();
  ctx.moveTo(eyeScreenX - 4, eyeScreenY - 4);
  ctx.lineTo(eyeScreenX + 4, eyeScreenY + 4);
  ctx.moveTo(eyeScreenX + 4, eyeScreenY - 4);
  ctx.lineTo(eyeScreenX - 4, eyeScreenY + 4);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.restore();

  ctx.restore();
}

// Simple bot eyes with random blink
function drawBotEyes(eyeX1: number, eyeX2: number, eyeY: number, r: number, blinking: boolean) {
  for (const ex of [eyeX1, eyeX2]) {
    if (blinking) {
      // Closed eye — horizontal line
      ctx.beginPath();
      ctx.moveTo(ex - r, eyeY);
      ctx.lineTo(ex + r, eyeY);
      ctx.strokeStyle = '#1a1a2e';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.stroke();
    } else {
      // White sclera
      ctx.beginPath();
      ctx.arc(ex, eyeY, r, 0, Math.PI * 2);
      ctx.fillStyle = 'white';
      ctx.fill();
      // Pupil
      ctx.beginPath();
      ctx.arc(ex, eyeY, r * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a2e';
      ctx.fill();
      // Highlight
      ctx.beginPath();
      ctx.arc(ex - r * 0.25, eyeY - r * 0.3, r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fill();
    }
  }
}

function drawGhosts() {
  for (const ghost of ghosts) {
    const p = toPoint(ghost.lat, ghost.lon);
    const color = ghost.color;

    ctx.save();
    ctx.translate(p.x, p.y);

    // Drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 2;

    if (ghost.shape === 0) {
      // --- Dome bot: antenna ball + dome + side ears ---
      ctx.beginPath();
      ctx.moveTo(0, -20); ctx.lineTo(0, -28);
      ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -31, 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.roundRect(s * 17, -6, 5, 14, 3); ctx.fillStyle = color; ctx.fill(); }
      ctx.beginPath();
      ctx.arc(0, 0, 18, Math.PI, 0);
      ctx.lineTo(18, 10); ctx.quadraticCurveTo(18, 16, 12, 16);
      ctx.lineTo(-12, 16); ctx.quadraticCurveTo(-18, 16, -18, 10);
      ctx.closePath(); ctx.fillStyle = color; ctx.fill();
      ctx.shadowBlur = 0;
      drawBotEyes(-7, 7, 2, 6, ghost.isBlinking);

    } else if (ghost.shape === 1) {
      // --- Square bot: antenna + boxy head + side ears ---
      ctx.beginPath();
      ctx.moveTo(0, -18); ctx.lineTo(0, -26);
      ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -28, 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.roundRect(s * 16, -6, 5, 12, 2); ctx.fillStyle = color; ctx.fill(); }
      ctx.beginPath(); ctx.roundRect(-16, -18, 32, 34, 6); ctx.fillStyle = color; ctx.fill();
      ctx.shadowBlur = 0;
      drawBotEyes(-6, 6, -2, 5, ghost.isBlinking);

    } else if (ghost.shape === 2) {
      // --- Round bot: V-antenna + circle head + ear bumps ---
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(s * 4, -16); ctx.lineTo(s * 10, -28);
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.stroke();
        ctx.beginPath(); ctx.arc(s * 10, -30, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(s * 18, 0, 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
      ctx.shadowBlur = 0;
      drawBotEyes(-7, 7, -2, 6, ghost.isBlinking);

    } else {
      // --- TV bot: rabbit-ear antenna + wide rectangle head ---
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(s * 4, -16); ctx.lineTo(s * 10, -30);
        ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.stroke();
        ctx.beginPath(); ctx.arc(s * 10, -31, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      }
      ctx.beginPath(); ctx.roundRect(-18, -16, 36, 28, 5); ctx.fillStyle = color; ctx.fill();
      ctx.shadowBlur = 0;
      drawBotEyes(-6, 6, -4, 5, ghost.isBlinking);
    }

    ctx.restore();
  }
}

function drawFrame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawStreets();
  drawDots();
  drawGhosts();
  drawPacman();
}

// =============================================
//  GAME LOOP
// =============================================

function gameLoop(time: number) {
  requestAnimationFrame(gameLoop);

  drawFrame();

  if (isGameOver || isRespawning) { lastFrameTime = 0; return; }

  if (!lastFrameTime) { lastFrameTime = time; return; }
  const dt = time - lastFrameTime;
  lastFrameTime = time;

  if (!pacCurrentNodeId) {
    const node = engine.getPacmanNode();
    if (node) pacCurrentNodeId = node.id;
    else return;
  }

  // 1. Start moving
  if (!pacTargetNodeId && activeKey) {
    pacTargetNodeId = engine.getNextNode(pacCurrentNodeId, activeKey);
    if (pacTargetNodeId) {
       pacProgress = 0;
       bufferedKey = null;
       updatePacmanRotation(pacCurrentNodeId, pacTargetNodeId);
    }
  }

  // 2. Interpolate movement
  if (pacTargetNodeId) {
    // Check for reversal (immediate U-turn)
    if (activeKey) {
      const idealNextFromTarget = engine.getNextNode(pacTargetNodeId, activeKey);
      if (idealNextFromTarget === pacCurrentNodeId) {
         const temp = pacTargetNodeId;
         pacTargetNodeId = pacCurrentNodeId;
         pacCurrentNodeId = temp;
         pacProgress = 1 - pacProgress;
         bufferedKey = null;
         updatePacmanRotation(pacCurrentNodeId, pacTargetNodeId);
      } else if (activeKey !== bufferedKey) {
         // Buffer a different direction for the next intersection
         bufferedKey = activeKey;
      }
    }

    if (activeKey || bufferedKey) {
       const cNode = engine.getNodes().get(pacCurrentNodeId)!;
       const tNode = engine.getNodes().get(pacTargetNodeId)!;
       const dist = map.distance([cNode.lat, cNode.lon], [tNode.lat, tNode.lon]);
       const durationMs = (dist / pacSpeed) * 1000;

       pacProgress += dt / durationMs;

       if (pacProgress >= 1) {
          pacProgress = 1;
          pacCurrentNodeId = pacTargetNodeId;
          engine.setPacmanPosition(pacCurrentNodeId);
          updateHUD();

          // Try buffered direction first, then active key
          const turnKey = bufferedKey || activeKey;
          let nextNode: string | null = null;
          if (turnKey) {
            nextNode = engine.getNextNode(pacCurrentNodeId, turnKey);
            if (nextNode) {
              activeKey = turnKey;
              bufferedKey = null;
            }
          }
          // If buffered key didn't work, try active key
          if (!nextNode && bufferedKey && activeKey) {
            nextNode = engine.getNextNode(pacCurrentNodeId, activeKey);
            bufferedKey = null;
          }

          pacTargetNodeId = nextNode;
          if (pacTargetNodeId) {
             pacProgress = 0;
             updatePacmanRotation(pacCurrentNodeId, pacTargetNodeId);
          }
       }

       const cNodeFinal = engine.getNodes().get(pacCurrentNodeId)!;
       const tNodeFinal = engine.getNodes().get(pacTargetNodeId || pacCurrentNodeId)!;

       const p1 = map.project([cNodeFinal.lat, cNodeFinal.lon], map.getMaxZoom());
       const p2 = map.project([tNodeFinal.lat, tNodeFinal.lon], map.getMaxZoom());
       const pxX = p1.x + (p2.x - p1.x) * pacProgress;
       const pxY = p1.y + (p2.y - p1.y) * pacProgress;

       pacLatLng = map.unproject([pxX, pxY], map.getMaxZoom());
       map.panInside(pacLatLng, { padding: [250, 250], animate: false });
    }
  }

  // 3. Ghost movement
  ghosts.forEach(ghost => {
     // Blink timer
     ghost.blinkTimer -= dt;
     if (ghost.blinkTimer <= 0) {
       if (ghost.isBlinking) {
         ghost.isBlinking = false;
         ghost.blinkTimer = Math.random() * 3000 + 2000;
       } else {
         ghost.isBlinking = true;
         ghost.blinkTimer = 120 + Math.random() * 80;
       }
     }

     const cNodeStart = engine.getNodes().get(ghost.currentNodeId);
     const tNodeStart = engine.getNodes().get(ghost.targetNodeId);
     if (!cNodeStart || !tNodeStart) return;

     const dist = map.distance([cNodeStart.lat, cNodeStart.lon], [tNodeStart.lat, tNodeStart.lon]);
     const durationMs = dist > 0 ? (dist / 15) * 1000 : 500;

     ghost.progress += dt / durationMs;

     while (ghost.progress >= 1) {
         ghost.progress -= 1;
         const prev = ghost.currentNodeId;
         ghost.currentNodeId = ghost.targetNodeId;
         ghost.prevNodeId = prev;

         const node = engine.getNodes().get(ghost.currentNodeId);
         if (!node || node.neighbors.length === 0) { ghost.progress = 0; break; }

         let validNeighbors = node.neighbors;
         if (ghost.prevNodeId) {
           const filtered = validNeighbors.filter(n => n !== ghost.prevNodeId);
           if (filtered.length > 0) validNeighbors = filtered;
         }
         ghost.targetNodeId = validNeighbors[Math.floor(Math.random() * validNeighbors.length)];
     }

     const renderProgress = Math.min(Math.max(ghost.progress, 0), 1);
     const cNode = engine.getNodes().get(ghost.currentNodeId);
     const tNode = engine.getNodes().get(ghost.targetNodeId);
     if (!cNode || !tNode) return;

     const gp1 = map.project([cNode.lat, cNode.lon], map.getMaxZoom());
     const gp2 = map.project([tNode.lat, tNode.lon], map.getMaxZoom());
     const gpxX = gp1.x + (gp2.x - gp1.x) * renderProgress;
     const gpxY = gp1.y + (gp2.y - gp1.y) * renderProgress;
     const ghostLatLng = map.unproject([gpxX, gpxY], map.getMaxZoom());
     ghost.lat = ghostLatLng.lat;
     ghost.lon = ghostLatLng.lng;
  });

  // 4. Collision detection
  if (isRespawning || isGameOver || !pacLatLng) return;

  const pxPac = toPoint(pacLatLng.lat, pacLatLng.lng);
  const COLLISION_SQ = 35 * 35;

  let collisionThisFrame = false;
  ghosts.forEach((ghost) => {
     if (collisionThisFrame) return;
     const pxGhost = toPoint(ghost.lat, ghost.lon);
     const distSq = (pxPac.x - pxGhost.x) ** 2 + (pxPac.y - pxGhost.y) ** 2;
     if (distSq < COLLISION_SQ) {
        collisionThisFrame = true;
        if (engine.loseLife()) {
           showGameOver();
        } else {
           triggerRespawn();
        }
     }
  });
}

function setupInput() {
  // --- Keyboard (desktop only) ---
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      activeKey = e.key as any;
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === activeKey) {
      activeKey = null;
      bufferedKey = null;
    }
  });

  // --- Canvas Joystick ---
  const joyCanvas = document.getElementById('joystick-canvas') as HTMLCanvasElement;
  const jCtx = joyCanvas.getContext('2d')!;
  let joystickActive = false;
  const deadzone = 0.15; // fraction of baseRadius

  // Target knob position (where input points)
  let knobTargetX = 0;
  let knobTargetY = 0;
  // Current smooth knob position
  let knobX = 0;
  let knobY = 0;

  function sizeJoystickCanvas() {
    const rect = joyCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    joyCanvas.width = rect.width * dpr;
    joyCanvas.height = rect.height * dpr;
    jCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeJoystickCanvas();
  window.addEventListener('resize', sizeJoystickCanvas);

  function getJoySize() {
    const rect = joyCanvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const baseR = cx - 4;
    const knobR = baseR * 0.35;
    const maxTravel = baseR - knobR - 2;
    return { cx, cy, baseR, knobR, maxTravel };
  }

  function drawArrow(ax: number, ay: number, angle: number, size: number, alpha: number) {
    jCtx.save();
    jCtx.translate(ax, ay);
    jCtx.rotate(angle);
    jCtx.beginPath();
    jCtx.moveTo(0, -size);
    jCtx.lineTo(-size * 0.6, size * 0.3);
    jCtx.lineTo(size * 0.6, size * 0.3);
    jCtx.closePath();
    jCtx.fillStyle = `rgba(255, 210, 47, ${alpha})`;
    jCtx.fill();
    jCtx.restore();
  }

  function drawJoystick() {
    const rect = joyCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const { cx, cy, baseR, knobR } = getJoySize();

    jCtx.clearRect(0, 0, w, h);

    // Base ring — more visible
    jCtx.beginPath();
    jCtx.arc(cx, cy, baseR, 0, Math.PI * 2);
    jCtx.fillStyle = 'rgba(20, 20, 30, 0.85)';
    jCtx.fill();
    jCtx.strokeStyle = 'rgba(255, 210, 47, 0.35)';
    jCtx.lineWidth = 2;
    jCtx.stroke();

    // Directional arrows
    const arrowDist = baseR * 0.72;
    const mainSize = baseR * 0.14;
    const diagSize = baseR * 0.09;
    const mainAlpha = 0.3;
    const diagAlpha = 0.15;

    // Cardinal arrows (up, right, down, left)
    drawArrow(cx, cy - arrowDist, 0, mainSize, mainAlpha);               // up
    drawArrow(cx + arrowDist, cy, Math.PI / 2, mainSize, mainAlpha);     // right
    drawArrow(cx, cy + arrowDist, Math.PI, mainSize, mainAlpha);         // down
    drawArrow(cx - arrowDist, cy, -Math.PI / 2, mainSize, mainAlpha);    // left

    // Diagonal arrows (smaller, dimmer)
    const diagDist = arrowDist * 0.9;
    const d = diagDist * 0.707; // cos(45°)
    drawArrow(cx + d, cy - d, Math.PI / 4, diagSize, diagAlpha);        // up-right
    drawArrow(cx + d, cy + d, Math.PI * 3 / 4, diagSize, diagAlpha);    // down-right
    drawArrow(cx - d, cy + d, -Math.PI * 3 / 4, diagSize, diagAlpha);   // down-left
    drawArrow(cx - d, cy - d, -Math.PI / 4, diagSize, diagAlpha);       // up-left

    // Knob
    const kx = cx + knobX;
    const ky = cy + knobY;

    // Knob glow
    jCtx.beginPath();
    jCtx.arc(kx, ky, knobR + 4, 0, Math.PI * 2);
    jCtx.fillStyle = joystickActive
      ? 'rgba(255, 210, 47, 0.15)'
      : 'rgba(255, 210, 47, 0.05)';
    jCtx.fill();

    // Knob body
    const knobGrad = jCtx.createRadialGradient(kx - knobR * 0.25, ky - knobR * 0.25, 0, kx, ky, knobR);
    knobGrad.addColorStop(0, 'rgba(255, 225, 80, 0.85)');
    knobGrad.addColorStop(1, 'rgba(255, 190, 30, 0.65)');
    jCtx.beginPath();
    jCtx.arc(kx, ky, knobR, 0, Math.PI * 2);
    jCtx.fillStyle = knobGrad;
    jCtx.fill();
    jCtx.strokeStyle = 'rgba(255, 210, 47, 0.8)';
    jCtx.lineWidth = 2;
    jCtx.stroke();

    // Knob highlight
    jCtx.beginPath();
    jCtx.arc(kx - knobR * 0.2, ky - knobR * 0.2, knobR * 0.35, 0, Math.PI * 2);
    jCtx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    jCtx.fill();
  }

  // Smooth animation loop for joystick
  function joystickLoop() {
    requestAnimationFrame(joystickLoop);

    // Smooth lerp towards target
    const lerp = joystickActive ? 0.3 : 0.15;
    knobX += (knobTargetX - knobX) * lerp;
    knobY += (knobTargetY - knobY) * lerp;

    // Snap to zero when close enough
    if (!joystickActive && Math.abs(knobX) < 0.5 && Math.abs(knobY) < 0.5) {
      knobX = 0;
      knobY = 0;
    }

    drawJoystick();
  }
  requestAnimationFrame(joystickLoop);

  function handleInput(clientX: number, clientY: number) {
    const rect = joyCanvas.getBoundingClientRect();
    const { cx, cy, maxTravel, baseR } = getJoySize();
    let dx = (clientX - rect.left) - cx;
    let dy = (clientY - rect.top) - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > maxTravel) {
      dx = (dx / dist) * maxTravel;
      dy = (dy / dist) * maxTravel;
    }

    knobTargetX = dx;
    knobTargetY = dy;

    // Direction from deadzone
    const normalizedDist = dist / baseR;
    if (normalizedDist > deadzone) {
      if (Math.abs(dx) > Math.abs(dy)) {
        activeKey = dx > 0 ? 'ArrowRight' : 'ArrowLeft';
      } else {
        activeKey = dy > 0 ? 'ArrowDown' : 'ArrowUp';
      }
    } else {
      activeKey = null;
      bufferedKey = null;
    }
  }

  function resetJoystick() {
    joystickActive = false;
    knobTargetX = 0;
    knobTargetY = 0;
    activeKey = null;
    bufferedKey = null;
  }

  // Mouse events
  joyCanvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    joystickActive = true;
    handleInput(e.clientX, e.clientY);
  });

  window.addEventListener('mousemove', (e) => {
    if (!joystickActive) return;
    e.preventDefault();
    handleInput(e.clientX, e.clientY);
  });

  window.addEventListener('mouseup', () => {
    if (joystickActive) resetJoystick();
  });

  // Touch events
  joyCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    joystickActive = true;
    handleInput(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  joyCanvas.addEventListener('touchmove', (e) => {
    if (!joystickActive) return;
    e.preventDefault();
    handleInput(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  joyCanvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    resetJoystick();
  }, { passive: false });

  joyCanvas.addEventListener('touchcancel', () => {
    resetJoystick();
  });

  requestAnimationFrame(gameLoop);
}

// Initialize
setupStartScreen();
