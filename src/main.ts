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

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}
const sparks: Spark[] = [];

interface FireParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}
const fireParticles: FireParticle[] = [];

interface Rocket {
  currentNodeId: string;
  targetNodeId: string;
  prevNodeId: string | null;
  progress: number;
  lat: number;
  lon: number;
  lifeTime: number; // ms
  speed: number;
}
const rockets: Rocket[] = [];

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
  powerTimer: document.getElementById('power-timer') as HTMLElement,
  powerTimerContainer: document.getElementById('power-timer-container') as HTMLElement,
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

  document.getElementById('app')?.classList.add('theme-street');

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
  rockets.length = 0;
  fireParticles.length = 0;
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
  const appEl = document.getElementById('app');
  if (!appEl) return;

  if (currentTheme === 'pacman') {
    currentTheme = 'satellite';
    HUD.viewToggle.innerText = 'Satellite View';
    appEl.classList.remove('theme-pacman');
    appEl.classList.add('theme-satellite');
    map.removeLayer(streetLayer);
    satelliteLayer.addTo(map);
  } else if (currentTheme === 'satellite') {
    currentTheme = 'street';
    HUD.viewToggle.innerText = 'Street View';
    appEl.classList.remove('theme-satellite');
    appEl.classList.add('theme-street');
    map.removeLayer(satelliteLayer);
    streetLayer.addTo(map);
  } else {
    currentTheme = 'pacman';
    HUD.viewToggle.innerText = 'Vibe-Man View';
    appEl.classList.remove('theme-street');
    appEl.classList.add('theme-pacman');
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
  rockets.length = 0;
  fireParticles.length = 0;

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
    if (!dot) continue;
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

function drawPowerItems() {
  const items = engine.getPowerItems();
  const radius = 16;
  
  ctx.save();
  for (const item of items) {
    if (!item) continue;
    const p = toPoint(item.lat, item.lon);
    
    // Circle base
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1a1a';
    ctx.strokeStyle = '#00ffcc';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    // Icon </>
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#00ffcc';
    ctx.fillText('</>', p.x, p.y);
    
    // Pulse glow
    const pulse = Math.sin(performance.now() / 200) * 5 + 5;
    ctx.shadowColor = '#00ffcc';
    ctx.shadowBlur = pulse;
    ctx.stroke();
  }
  ctx.restore();
}

function drawSparks() {
  ctx.save();
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx;
    s.y += s.vy;
    s.life -= 0.02;
    if (s.life <= 0) {
      sparks.splice(i, 1);
      continue;
    }
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2 * s.life, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.globalAlpha = s.life;
    ctx.fill();
  }
  ctx.restore();
}

function createSparks(x: number, y: number, color1: string, color2: string) {
  for (let i = 0; i < 5; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 3;
    sparks.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      color: Math.random() > 0.5 ? color1 : color2
    });
  }
}

function drawRocketItems() {
  const items = engine.getRocketItems();
  const radius = 16;
  
  ctx.save();
  for (const item of items) {
    if (!item) continue;
    const p = toPoint(item.lat, item.lon);
    
    // Circle base
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1a1a';
    ctx.strokeStyle = '#ff3300';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    // Rocket Icon
    ctx.font = '18px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🚀', p.x, p.y);
    
    // Pulse glow
    const pulse = Math.sin(performance.now() / 200) * 5 + 5;
    ctx.shadowColor = '#ff3300';
    ctx.shadowBlur = pulse;
    ctx.stroke();
  }
  ctx.restore();
}

function drawRockets() {
  rockets.forEach((rocket) => {
    const p = toPoint(rocket.lat, rocket.lon);
    
    // Fire trail
    if (Math.random() > 0.3) {
      fireParticles.push({
        x: p.x, y: p.y,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        life: 1.0
      });
    }

    ctx.save();
    ctx.translate(p.x, p.y);
    
    // Find direction for rotation
    const cNode = engine.getNodes().get(rocket.currentNodeId);
    const tNode = engine.getNodes().get(rocket.targetNodeId);
    if (cNode && tNode) {
      const p1 = map.project([cNode.lat, cNode.lon], map.getMaxZoom());
      const p2 = map.project([tNode.lat, tNode.lon], map.getMaxZoom());
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      ctx.rotate(angle);
    }

    // Torpedo Body - Black with yellow border
    ctx.beginPath();
    ctx.moveTo(-22, -11); // Back top
    ctx.lineTo(-22, 11);  // Flat back
    ctx.quadraticCurveTo(8, 14, 32, 0); // Pointy front (head)
    ctx.quadraticCurveTo(8, -14, -22, -11); 
    ctx.closePath();
    
    ctx.fillStyle = 'black';
    ctx.shadowColor = '#ffd22f'; // Yellow glow matching border
    ctx.shadowBlur = 15;
    ctx.fill();
    
    ctx.strokeStyle = '#ffd22f'; // Pacman yellow
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Gloss effect (simple highlight on top)
    ctx.beginPath();
    ctx.ellipse(-4, -5, 15, 4, -0.1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fill();
    
    ctx.shadowBlur = 0;
    
    ctx.restore();
  });
}

function drawFireTrail() {
  ctx.save();
  for (let i = fireParticles.length - 1; i >= 0; i--) {
    const f = fireParticles[i];
    f.x += f.vx;
    f.y += f.vy;
    f.life -= 0.03;
    if (f.life <= 0) {
      fireParticles.splice(i, 1);
      continue;
    }
    
    const size = 3 + f.life * 8;
    ctx.fillStyle = `rgba(255, ${Math.floor(50 + 150 * f.life)}, 0, ${f.life})`;
    ctx.beginPath();
    ctx.arc(f.x, f.y, size, 0, Math.PI * 2);
    ctx.fill();
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

  const state = engine.getState();
  const p = toPoint(pacLatLng.lat, pacLatLng.lng);
  const radius = 22;
  const rot = (currentRotation * Math.PI) / 180;

  // Power-up flashing effect
  let primaryColor = '#ffd22f'; // default yellow
  let secondaryColor = '#141c28';
  let eyeColor = '#ffd22f';
  let glowColor = 'rgba(255, 210, 47, 0.3)';

  if (state.powerUpActive) {
    primaryColor = '#ff00ff'; // Konstantes Neon-Pink für die Kontur
    
    // Smooth transition between yellow (#ffff00) and black (#000000)
    const t = (Math.sin(performance.now() / 120) + 1) / 2; 
    const colorVal = Math.floor(t * 255);
    secondaryColor = `rgb(${colorVal}, ${colorVal}, 0)`;

    glowColor = 'rgba(0, 255, 255, 0.8)'; // Konstantes Neon-Cyan für den Glow
    eyeColor = '#ffffff';
    
    // Create sparks around pacman
    if (Math.random() > 0.5) {
      createSparks(p.x, p.y, '#ff00ff', '#00ffff');
    }
  }

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
  ctx.fillStyle = secondaryColor;
  ctx.fill();
  ctx.strokeStyle = primaryColor;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Hood accent
  ctx.beginPath();
  ctx.arc(0, 0, radius - 4, -2.6, -0.5);
  ctx.strokeStyle = primaryColor;
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
  ctx.fillStyle = secondaryColor;
  ctx.fill();
  ctx.strokeStyle = primaryColor;
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
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = state.powerUpActive ? 15 : 8;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.strokeStyle = state.powerUpActive ? primaryColor : 'rgba(255, 210, 47, 0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // --- X-eye: always stays on top regardless of rotation ---
  // Draw in screen space — fixed position above head center
  ctx.save();
  ctx.rotate(-rot); // undo body rotation to get screen-aligned coords
  ctx.strokeStyle = eyeColor;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.shadowColor = eyeColor;
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
    const state = engine.getState();
    let color = ghost.color;
    
    if (state.powerUpActive) {
      const remaining = state.powerUpEndTime - performance.now();
      if (remaining < 3000 && Math.floor(performance.now() / 200) % 2 === 0) {
        color = '#ffffff'; // flashing white
      } else {
        color = '#0000ff'; // scared blue
      }
    }

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
      drawBotEyes(-7, 7, 2, 6, engine.getState().powerUpActive ? false : ghost.isBlinking);

    } else if (ghost.shape === 1) {
      // --- Square bot: antenna + boxy head + side ears ---
      ctx.beginPath();
      ctx.moveTo(0, -18); ctx.lineTo(0, -26);
      ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -28, 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.roundRect(s * 16, -6, 5, 12, 2); ctx.fillStyle = color; ctx.fill(); }
      ctx.beginPath(); ctx.roundRect(-16, -18, 32, 34, 6); ctx.fillStyle = color; ctx.fill();
      ctx.shadowBlur = 0;
      drawBotEyes(-6, 6, -2, 5, engine.getState().powerUpActive ? false : ghost.isBlinking);

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
      drawBotEyes(-7, 7, -2, 6, engine.getState().powerUpActive ? false : ghost.isBlinking);

    } else {
      // --- TV bot: rabbit-ear antenna + wide rectangle head ---
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(s * 4, -16); ctx.lineTo(s * 10, -30);
        ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.stroke();
        ctx.beginPath(); ctx.arc(s * 10, -31, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      }
      ctx.beginPath(); ctx.roundRect(-18, -16, 36, 28, 5); ctx.fillStyle = color; ctx.fill();
      ctx.shadowBlur = 0;
      drawBotEyes(-6, 6, -4, 5, engine.getState().powerUpActive ? false : ghost.isBlinking);
    }

    ctx.restore();
  }
}

function drawVignette() {
  const state = engine.getState();
  if (!state.powerUpActive) return;

  const w = canvas.width;
  const h = canvas.height;
  const vSizeW = w * 0.10; // 10% of width
  const vSizeH = h * 0.10; // 10% of height

  ctx.save();
  
  // Top
  const gradTop = ctx.createLinearGradient(0, 0, 0, vSizeH);
  gradTop.addColorStop(0, 'rgba(0, 0, 0, 0.85)');
  gradTop.addColorStop(0.6, 'rgba(0, 0, 0, 0.3)');
  gradTop.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradTop;
  ctx.fillRect(0, 0, w, vSizeH);

  // Bottom
  const gradBot = ctx.createLinearGradient(0, h - vSizeH, 0, h);
  gradBot.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradBot.addColorStop(0.4, 'rgba(0, 0, 0, 0.3)');
  gradBot.addColorStop(1, 'rgba(0, 0, 0, 0.85)');
  ctx.fillStyle = gradBot;
  ctx.fillRect(0, h - vSizeH, w, vSizeH);

  // Left
  const gradLeft = ctx.createLinearGradient(0, 0, vSizeW, 0);
  gradLeft.addColorStop(0, 'rgba(0, 0, 0, 0.85)');
  gradLeft.addColorStop(0.6, 'rgba(0, 0, 0, 0.3)');
  gradLeft.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradLeft;
  ctx.fillRect(0, 0, vSizeW, h);

  // Right
  const gradRight = ctx.createLinearGradient(w - vSizeW, 0, w, 0);
  gradRight.addColorStop(0, 'rgba(0, 0, 0, 0)');
  gradRight.addColorStop(0.4, 'rgba(0, 0, 0, 0.3)');
  gradRight.addColorStop(1, 'rgba(0, 0, 0, 0.85)');
  ctx.fillStyle = gradRight;
  ctx.fillRect(w - vSizeW, 0, vSizeW, h);

  ctx.restore();
}

function drawFrame() {
  if (engine.getNodes().size === 0) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawStreets();
  drawDots();
  drawPowerItems();
  drawRocketItems();
  drawFireTrail();
  drawRockets();
  drawGhosts();
  drawPacman();
  drawSparks();
  drawVignette();
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
  const now = performance.now();
  engine.updatePowerUp(now);
  
  const state = engine.getState();
  if (state.powerUpActive) {
    HUD.powerTimerContainer.classList.remove('hidden');
    const remaining = Math.max(0, Math.ceil((state.powerUpEndTime - now) / 1000));
    HUD.powerTimer.innerText = `${remaining}s`;
    HUD.powerTimer.style.color = (state.powerUpEndTime - now < 3000 && Math.floor(now / 200) % 2 === 0) ? '#ffffff' : '#ff00ff';
  } else {
    HUD.powerTimerContainer.classList.add('hidden');
  }

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

  // 4. Rocket movement
  for (let i = rockets.length - 1; i >= 0; i--) {
    const rocket = rockets[i];
    rocket.lifeTime -= dt;
    if (rocket.lifeTime <= 0) {
      createSparks(toPoint(rocket.lat, rocket.lon).x, toPoint(rocket.lat, rocket.lon).y, '#ff3300', '#ffff00');
      rockets.splice(i, 1);
      continue;
    }

    const cNode = engine.getNodes().get(rocket.currentNodeId);
    const tNode = engine.getNodes().get(rocket.targetNodeId);
    if (!cNode || !tNode) { rockets.splice(i, 1); continue; }

    const dist = map.distance([cNode.lat, cNode.lon], [tNode.lat, tNode.lon]);
    const durationMs = dist > 0 ? (dist / rocket.speed) * 1000 : 200;
    rocket.progress += dt / durationMs;

    while (rocket.progress >= 1) {
      rocket.progress -= 1;
      const prev = rocket.currentNodeId;
      rocket.currentNodeId = rocket.targetNodeId;
      rocket.prevNodeId = prev;

      const node = engine.getNodes().get(rocket.currentNodeId);
      if (!node || node.neighbors.length === 0) {
        createSparks(toPoint(rocket.lat, rocket.lon).x, toPoint(rocket.lat, rocket.lon).y, '#ff3300', '#ffff00');
        rockets.splice(i, 1);
        break;
      }

      // Tracking logic
      let targetGhost: GhostState | null = null;
      let minGhostDist = Infinity;
      ghosts.forEach(g => {
        const d = (g.lat - node.lat)**2 + (g.lon - node.lon)**2;
        if (d < minGhostDist) {
          minGhostDist = d;
          targetGhost = g;
        }
      });

      let nextNodeId = "";
      if (targetGhost) {
        let bestDist = Infinity;
        node.neighbors.forEach(nbId => {
          if (nbId === rocket.prevNodeId && node.neighbors.length > 1) return;
          const nb = engine.getNodes().get(nbId)!;
          const d = (nb.lat - targetGhost!.lat)**2 + (nb.lon - targetGhost!.lon)**2;
          if (d < bestDist) {
            bestDist = d;
            nextNodeId = nbId;
          }
        });
      } else {
        const valid = node.neighbors.filter(n => n !== rocket.prevNodeId);
        nextNodeId = valid.length > 0 ? valid[Math.floor(Math.random() * valid.length)] : node.neighbors[0];
      }
      
      if (!nextNodeId) {
         createSparks(toPoint(rocket.lat, rocket.lon).x, toPoint(rocket.lat, rocket.lon).y, '#ff3300', '#ffff00');
         rockets.splice(i, 1);
         break;
      }
      rocket.targetNodeId = nextNodeId;
    }

    if (rockets[i]) {
       const rcNode = engine.getNodes().get(rocket.currentNodeId);
       const rtNode = engine.getNodes().get(rocket.targetNodeId);
       if (rcNode && rtNode) {
         const rp1 = map.project([rcNode.lat, rcNode.lon], map.getMaxZoom());
         const rp2 = map.project([rtNode.lat, rtNode.lon], map.getMaxZoom());
         const rpxX = rp1.x + (rp2.x - rp1.x) * Math.min(Math.max(rocket.progress, 0), 1);
         const rpxY = rp1.y + (rp2.y - rp1.y) * Math.min(Math.max(rocket.progress, 0), 1);
         const rocketLatLng = map.unproject([rpxX, rpxY], map.getMaxZoom());
         rocket.lat = rocketLatLng.lat;
         rocket.lon = rocketLatLng.lng;
       }
    }
  }

  // 5. Collision detection
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
       if (engine.getState().powerUpActive) {
         engine.eatGhost();
         updateHUD();
         
         // Create explosion sparks
         for(let i=0; i<3; i++) createSparks(pxGhost.x, pxGhost.y, '#ff00ff', '#00ffff');

         // Remove ghost instead of respawning
         const idx = ghosts.indexOf(ghost);
         if (idx > -1) ghosts.splice(idx, 1);
         
         collisionThisFrame = false; // allow eating multiple ghosts
       } else {
         if (engine.loseLife()) {
            showGameOver();
         } else {
            triggerRespawn();
         }
       }
    }
  });

  // Rocket vs Ghost
  for (let rIdx = rockets.length - 1; rIdx >= 0; rIdx--) {
    const rocket = rockets[rIdx];
    const pxRocket = toPoint(rocket.lat, rocket.lon);
    for (let gIdx = ghosts.length - 1; gIdx >= 0; gIdx--) {
      const ghost = ghosts[gIdx];
      const pxGhost = toPoint(ghost.lat, ghost.lon);
      const dSq = (pxRocket.x - pxGhost.x)**2 + (pxRocket.y - pxGhost.y)**2;
      if (dSq < 40 * 40) {
        for(let i=0; i<8; i++) createSparks(pxGhost.x, pxGhost.y, '#ff3300', '#ffff00');
        ghosts.splice(gIdx, 1);
        rockets.splice(rIdx, 1);
        engine.eatGhost();
        updateHUD();
        break;
      }
    }
  }
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

// Event system for rocket launch
(window as any).dispatchGameEvent = (name: string) => {
  if (name === 'launch-rocket') {
    if (!pacCurrentNodeId || !pacTargetNodeId) return;
    rockets.push({
      currentNodeId: pacCurrentNodeId,
      targetNodeId: pacTargetNodeId,
      prevNodeId: null,
      progress: pacProgress,
      lat: pacLatLng!.lat,
      lon: pacLatLng!.lng,
      lifeTime: 10000,
      speed: 90 // slightly faster than pacman (80)
    });
  }
};

// Initialize
setupStartScreen();
