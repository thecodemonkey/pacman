import './style.css';
import L from 'leaflet';
import { GameEngine } from './game/engine';
import { Renderer2D } from './render/Renderer2D';
import { Renderer3D } from './render/Renderer3D';
import type { IRenderer } from './render/IRenderer';

// --- State and Constants ---
let map: L.Map;
let streetLayer: L.TileLayer;
let satelliteLayer: L.TileLayer;
let currentTheme: 'street' | 'pacman' | 'satellite' | '3d' = 'street';
let last2DTheme: 'street' | 'pacman' | 'satellite' = 'street';
let userPos: [number, number] = [51.505, -0.09];
let currentRotation = 0;
let activeKey: 'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight' | null = null;
let bufferedKey: 'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight' | null = null;
const keysDown = new Set<string>();
let joyKnobX = 0;
let joyKnobY = 0;
let joyMaxTravel = 1;
let camJoyX = 0;
let camJoyY = 0;
let pacCurrentNodeId: string | null = null;
let pacTargetNodeId: string | null = null;
let pacProgress = 0;
let lastFrameTime = 0;
let isGameOver = false;
let isRespawning = false;
const pacSpeed = 80; // m/s

const engine = new GameEngine();

// Canvas + context
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

// Pac-Man position in lat/lng (interpolated)
let pacLatLng: L.LatLng | null = null;

// Cached street edges
let streetEdges: Array<{ aLat: number; aLon: number; bLat: number; bLon: number }> = [];

export interface GhostState {
  lat: number;
  lon: number;
  currentNodeId: string;
  targetNodeId: string;
  prevNodeId: string | null;
  progress: number;
  color: string;
  shape: number;
  isBlinking: boolean;
  spawnTime: number;
}
export const ghosts: GhostState[] = [];

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

export interface Rocket {
  currentNodeId: string;
  targetNodeId: string;
  prevNodeId: string | null;
  progress: number;
  lat: number;
  lon: number;
  lifeTime: number; // ms
  speed: number;
}
export const rockets: Rocket[] = [];

// Removed mouth state (moved to Renderer2D)

const HUD = {
  score: document.getElementById('score') as HTMLElement,
  lives: document.getElementById('lives') as HTMLElement,
  viewToggle: document.getElementById('view-toggle') as HTMLButtonElement,
  mode3DToggle: document.getElementById('mode-3d-toggle') as HTMLButtonElement,
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

// Removed internal theme colors (moved to Renderer2D)

const bgMusic = new Audio('/vibeman.m4a');
bgMusic.loop = true;
bgMusic.volume = 0.4;

// --- Rendering Abstraction ---
let renderer: IRenderer;

// --- Map Initialization ---
function initMap(lat: number, lon: number) {
  userPos = [lat, lon];
  
  renderer = new Renderer2D(engine);

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

  // Setup canvas overlay for 2D mode
  canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  ctx = canvas.getContext('2d')!;
  
  renderer.bindMap(map, canvas, ctx);

  resizeCanvas();
  window.addEventListener('resize', () => { resizeCanvas(); drawFrame(); });
  map.on('move zoom moveend zoomend resize zoomanim', () => { resizeCanvas(); drawFrame(); });

  setupInput();
  fetchNearbyStreets(lat, lon);
}

function resizeCanvas() {
  if (renderer) renderer.resize();
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
    bgMusic.play().catch(e => console.warn("Audio autoplay blocked", e));

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

  const mainState = {
    pacLatLng: null as L.LatLng | null,
    ghosts: ghosts,
    rockets: rockets,
    sparks: sparks,
    fireParticles: fireParticles,
    currentTheme: currentTheme as 'street' | 'pacman' | 'satellite'
  };

  if (renderer) {
    renderer.setStateReferences(mainState);
  }
  HUD.gameOverScreen.classList.add('hidden');
  updateHUD();

  userPos = [lat, lon];
  map.setView(userPos, 19);
  fetchNearbyStreets(lat, lon);
}

// --- View Toggle Logic Refactored ---
function applyTheme(targetTheme: 'street' | 'pacman' | 'satellite' | '3d') {
  const mapEl = document.getElementById('app');
  mapEl?.classList.remove('theme-street', 'theme-pacman', 'theme-satellite', 'theme-3d');
  
  const isTarget3D = targetTheme === '3d';
  const isCurrent3D = currentTheme === '3d';

  if (isTarget3D && !isCurrent3D) {
      if(renderer) renderer.destroy();
      renderer = new Renderer3D(engine);
      renderer.init(document.getElementById('map')!);
      renderer.bindMap(map, canvas, ctx);
  } else if (!isTarget3D && isCurrent3D) {
      if(renderer) renderer.destroy();
      renderer = new Renderer2D(engine);
      renderer.init(document.getElementById('map')!);
      renderer.bindMap(map, canvas, ctx);
      // Immediately center the map on Pac-Man so we don't look at the homebase
      if (pacLatLng) {
        map.setView(pacLatLng, map.getZoom(), { animate: false });
      }
  }

  currentTheme = targetTheme;
  if (currentTheme !== '3d') {
    last2DTheme = currentTheme;
    canvas.style.display = 'block';
    
    // Update Leaflet layers
    if (currentTheme === 'satellite') {
      map.addLayer(satelliteLayer);
      map.removeLayer(streetLayer);
    } else {
      map.addLayer(streetLayer);
      map.removeLayer(satelliteLayer);
    }
  } else {
    map.removeLayer(satelliteLayer);
    map.removeLayer(streetLayer);
    canvas.style.display = 'none';
  }

  mapEl?.classList.add('theme-' + currentTheme);
  
  // Update Button Texts
  if (currentTheme === '3d') {
    HUD.mode3DToggle.innerText = 'Exit 3D';
    HUD.mode3DToggle.classList.add('active');
  } else {
    HUD.mode3DToggle.innerText = '3D View';
    HUD.mode3DToggle.classList.remove('active');
  }

  if (last2DTheme === 'street') HUD.viewToggle.innerText = 'Street View';
  else if (last2DTheme === 'satellite') HUD.viewToggle.innerText = 'Satellite View';
  else HUD.viewToggle.innerText = 'Vibe-Man View';

  drawFrame(); 
}

// Initial state label
HUD.viewToggle.innerText = 'Street View';
HUD.mode3DToggle.innerText = '3D View';

HUD.viewToggle.addEventListener('click', () => {
  // Cycle only 2D themes
  let next2D: 'street' | 'pacman' | 'satellite';
  if (last2DTheme === 'street') next2D = 'satellite';
  else if (last2DTheme === 'satellite') next2D = 'pacman';
  else next2D = 'street';

  applyTheme(next2D);
});

HUD.mode3DToggle.addEventListener('click', () => {
  if (currentTheme === '3d') {
    applyTheme(last2DTheme);
  } else {
    applyTheme('3d');
  }
});

// --- Overpass API ---
async function fetchNearbyStreets(lat: number, lon: number, retries = 3) {
  try {
    // 1. Attempt to load from static JSON cache first (for preset cities)
    const cacheUrl = `/cities/${lat}_${lon}.json`;
    const cachedResponse = await fetch(cacheUrl);
    if (cachedResponse.ok) {
      console.log(`Loaded cached city data: ${cacheUrl}`);
      const jsonData = await cachedResponse.json();
      
      if (jsonData.data && jsonData.gastroData !== undefined) {
          // It's the new combined static format
          processOSMData(jsonData.data);
          handleGastroBackground(lat, lon, jsonData.gastroData);
      } else {
          // Legacy static format - fetch gastronomy and hope
          processOSMData(jsonData);
          handleGastroBackground(lat, lon); // Will fetch live if not in jsonData
      }
      return;
    }
  } catch (e) {
    console.log(`No static cache found for ${lat}, ${lon}.`);
  }

  // 2. Attempt to load from dynamic local storage cache (for GPS / user location)
  try {
    const localCacheStr = localStorage.getItem('osm_local_cache');
    if (localCacheStr) {
      const localCache = JSON.parse(localCacheStr);
      if (localCache.lat && localCache.lon && localCache.data) {
        // Calculate distance between required position and cached position
        const dist = map.distance([lat, lon], [localCache.lat, localCache.lon]);
        if (dist <= 5000) { // Tolerate up to ~5km difference
          console.log(`Loaded OSM data from localStorage cache (dist: ${Math.round(dist)}m)`);
          
          let gastroData = localCache.gastroData;
          if (!gastroData) {
              console.log("Local cache missing gastronomy, fetching it live...");
              gastroData = await fetchGastronomy(lat, lon);
              if (gastroData) {
                  localCache.gastroData = gastroData;
                  try {
                      localStorage.setItem('osm_local_cache', JSON.stringify(localCache));
                  } catch(e) {}
              }
          }
          
          processOSMData(localCache.data);
          // Gastro is background now
          handleGastroBackground(lat, lon, localCache.gastroData);
          return;
        } else {
          console.log(`localStorage cache out of bounds (${Math.round(dist)}m > 5000m). Ignoring.`);
        }
      }
    }
  } catch(e) {
    console.warn("Error reading localStorage cache", e);
  }

  console.log(`Querying live Overpass API for ${lat}, ${lon}...`);

  // 3. Last fallback: live Overpass API
  const radius = 300;
  const query = `
    [out:json];
    (
      way["highway"~"^(primary|secondary|tertiary|residential|service|footway)$"](around:${radius},${lat},${lon});
      way["building"](around:${radius},${lat},${lon});
      node["natural"="tree"](around:${radius},${lat},${lon});
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

    // Cache successful fetch to local storage (initially without gastroData)
    try {
      localStorage.setItem('osm_local_cache', JSON.stringify({
        lat, lon, data
      }));
    } catch (e) {
      console.warn("Could not write to localStorage cache (data might be too large)", e);
    }

    processOSMData(data);
    // Fetch gastro in background - no await
    handleGastroBackground(lat, lon);
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

async function fetchGastronomy(lat: number, lon: number): Promise<any> {
  const radius = 500;
  const query = `[out:json][timeout:25];
    (
      node["amenity"~"^(restaurant|fast_food|cafe)$"](around:${radius},${lat},${lon});
      node["shop"="kiosk"](around:${radius},${lat},${lon});
      node["cuisine"~"^(pizza|doner|kebab|asian|chinese|vietnamese|thai|japanese|sushi|noodle|burger)$"](around:${radius},${lat},${lon});
      way["amenity"~"^(restaurant|fast_food|cafe)$"](around:${radius},${lat},${lon});
      way["shop"="kiosk"](around:${radius},${lat},${lon});
      way["cuisine"~"^(pizza|doner|kebab|asian|chinese|vietnamese|thai|japanese|sushi|noodle|burger)$"](around:${radius},${lat},${lon});
      relation["amenity"~"^(restaurant|fast_food|cafe)$"](around:${radius},${lat},${lon});
      relation["shop"="kiosk"](around:${radius},${lat},${lon});
      relation["cuisine"~"^(pizza|doner|kebab|asian|chinese|vietnamese|thai|japanese|sushi|noodle|burger)$"](around:${radius},${lat},${lon});
    );
    out center;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("Gastronomy fetch failed", e);
    return null;
  }
}

async function handleGastroBackground(lat: number, lon: number, existingGastroData?: any) {
    let gastroData = existingGastroData;
    if (!gastroData) {
        console.log("Fetching gastronomy in background...");
        gastroData = await fetchGastronomy(lat, lon);
        
        // Update cache with gastroData
        try {
          const cachedString = localStorage.getItem('osm_local_cache');
          if (cachedString) {
              const cachedObj = JSON.parse(cachedString);
              cachedObj.gastroData = gastroData;
              localStorage.setItem('osm_local_cache', JSON.stringify(cachedObj));
          }
        } catch(e) {}
    }
    
    if (gastroData) {
        processGastroData(gastroData);
        // If renderer has onGastronomyLoaded, notify it
        if (renderer && renderer.onGastronomyLoaded) {
            renderer.onGastronomyLoaded();
        } else if (renderer && renderer.onMapLoaded) {
            // Fallback: full rebuild if it's 3D and hasn't loaded yet
            renderer.onMapLoaded();
        }
    }
}

function processGastroData(gastroData: any) {
  const gastronomes: import('./game/engine').Gastronomy[] = [];
  if (gastroData && gastroData.elements) {
      console.log(`Async parsing gastro data, found ${gastroData.elements.length} items`);
      gastroData.elements.forEach((e: any) => {
          const lat = (e.type === 'way' || e.type === 'relation') ? e.center?.lat : e.lat;
          const lon = (e.type === 'way' || e.type === 'relation') ? e.center?.lon : e.lon;
          if (lat && lon) {
              let cuisine = e.tags?.cuisine || "";
              let amenity = e.tags?.amenity || "";
              let shop = e.tags?.shop || "";
              let type = "unknown";
              
              if (cuisine.includes('doner') || cuisine.includes('kebab')) {
                  type = 'doner';
              } else if (cuisine.includes('pizza')) {
                  type = 'pizza';
              } else if (cuisine.match(/burger/i) || amenity === 'fast_food') {
                  type = 'burger';
              } else if (cuisine.match(/asian|chinese|vietnamese|thai|japanese|sushi|noodle/i)) {
                  type = 'asia';
              } else if (amenity) {
                  type = amenity;
              } else if (shop) {
                  type = shop;
              }
              
              let name = e.tags?.name || type;
              gastronomes.push({
                  id: e.id.toString(), lat, lon, type, name
              });
          }
      });
  }
  engine.setGastronomes(gastronomes);
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

  if (renderer && renderer.onMapLoaded) {
    renderer.onMapLoaded();
  }
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
      color,
      currentNodeId: randNode.id,
      targetNodeId: nextId,
      prevNodeId: null,
      progress: 0,
      lat: randNode.lat,
      lon: randNode.lon,
      isBlinking: false,
      shape: i % 4,
      spawnTime: performance.now(),
    });
  });
}

function showGameOver() {
  if (isGameOver) return;
  bgMusic.pause();
  bgMusic.currentTime = 0;
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
    initPacmanRotation(pacNode.id);
  }

  updateHUD();
  spawnGhosts();
  lastFrameTime = 0;
}

HUD.btnRestart.addEventListener('click', () => {
  resetGameParams();
  bgMusic.play().catch(e => console.warn("Audio autoplay blocked", e));
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
  ghosts.length = 0;
  rockets.length = 0;
  updateHUD();

  setTimeout(() => {
    if (isGameOver) return;

    // Full reset — runs right before gameplay resumes
    pacCurrentNodeId = engine.getInitialPacmanNodeId();
    pacTargetNodeId = null;
    pacProgress = 0;
    activeKey = null;
    bufferedKey = null;
    keysDown.clear();

    const initNode = engine.getNodes().get(pacCurrentNodeId)!;
    engine.setPacmanPosition(pacCurrentNodeId);
    pacLatLng = L.latLng(initNode.lat, initNode.lon);
    initPacmanRotation(pacCurrentNodeId); // sets currentRotation to face first neighbor

    map.panTo([initNode.lat, initNode.lon], { animate: false });

    spawnGhosts();
    isRespawning = false;
    lastFrameTime = performance.now();
  }, 2000);
}

function updateHUD() {
  const state = engine.getState();
  HUD.score.innerText = state.score.toString().padStart(4, '0');
  HUD.lives.innerText = '\u2764'.repeat(state.lives);
}

function initPacmanRotation(nodeId: string) {
  const node = engine.getNodes().get(nodeId);
  if (!node || node.neighbors.length === 0) { currentRotation = 0; return; }
  const nb = engine.getNodes().get(node.neighbors[0]);
  if (!nb) { currentRotation = 0; return; }

  // Use lat/lon directly — never NaN, no map.project() dependency.
  // bestNeighborForHeading uses: geoAngleRad = (-headingDeg) * PI/180
  // So screenAngle (currentRotation) = -geoAngle_in_degrees
  const dLat = nb.lat - node.lat;
  const dLon = nb.lon - node.lon;
  const geoAngleDeg = Math.atan2(dLat, dLon) * 180 / Math.PI;
  currentRotation = -geoAngleDeg; // screen-pixel convention: 0=East, -90=North, 90=South
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

// (getEffectiveKey removed — 3D movement now uses bestNeighborForHeading directly)


function drawFrame() {
  if (!renderer) return;

  renderer.setStateReferences({
     pacLatLng,
     ghosts,
     rockets,
     sparks,
     fireParticles,
     currentTheme: currentTheme === '3d' ? 'pacman' : currentTheme as 'street' | 'pacman' | 'satellite',
     streetEdges,
     currentRotation,
     isRespawning,
     camJoyX,
     camJoyY
  });

  renderer.drawFrame(performance.now());
}
// =============================================
//  MOVEMENT — 2D (absolute map directions)
// =============================================

function updatePacman2D(dt: number) {
  // 1. Start moving
  if (!pacTargetNodeId && activeKey) {
    pacTargetNodeId = engine.getNextNode(pacCurrentNodeId!, activeKey);
    if (pacTargetNodeId) {
      pacProgress = 0;
      bufferedKey = null;
      updatePacmanRotation(pacCurrentNodeId!, pacTargetNodeId);
    }
  }

  // 2. Interpolate movement
  if (pacTargetNodeId) {
    // Reversal check
    if (activeKey) {
      const reverseTarget = engine.getNextNode(pacTargetNodeId, activeKey);
      if (reverseTarget === pacCurrentNodeId) {
        const temp = pacTargetNodeId;
        pacTargetNodeId = pacCurrentNodeId!;
        pacCurrentNodeId = temp;
        pacProgress = 1 - pacProgress;
        bufferedKey = null;
        updatePacmanRotation(pacCurrentNodeId!, pacTargetNodeId);
      } else if (activeKey !== bufferedKey) {
        bufferedKey = activeKey;
      }
    }

    if (activeKey || bufferedKey) {
      const cNode = engine.getNodes().get(pacCurrentNodeId!)!;
      const tNode = engine.getNodes().get(pacTargetNodeId)!;
      const dist = map.distance([cNode.lat, cNode.lon], [tNode.lat, tNode.lon]);
      pacProgress += dt / ((dist / pacSpeed) * 1000);

      if (pacProgress >= 1) {
        pacCurrentNodeId = pacTargetNodeId;
        pacProgress = 1;
        engine.setPacmanPosition(pacCurrentNodeId);
        updateHUD();

        const turnKey = bufferedKey || activeKey;
        let nextNode: string | null = null;
        if (turnKey) {
          nextNode = engine.getNextNode(pacCurrentNodeId, turnKey);
          if (nextNode) { activeKey = turnKey; bufferedKey = null; }
        }
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
    }
  }
}

// Returns the neighbor node ID whose geographic direction best matches the given
// screen-space heading angle (0=East, -90=North, 90=South, 180=West).
// Excludes `excludeId` to prevent reversals. Returns null if none within 90°.
function bestNeighborForHeading(nodeId: string, headingDeg: number, excludeId: string | null): string | null {
  const node = engine.getNodes().get(nodeId);
  if (!node) return null;

  // Convert screen-pixel heading to geographic angle:
  // screen 0°=East,  90°=South (y↓) → geo 0°=East, -90°=South (lat↓)
  // Flip sign of heading to go from screen-y to lat-y: geoAngle = -headingDeg
  const geoAngleRad = (-headingDeg) * Math.PI / 180;

  let bestId: string | null = null;
  let bestDiff = Infinity;

  node.neighbors.forEach(nbId => {
    if (nbId === excludeId) return;
    const nb = engine.getNodes().get(nbId);
    if (!nb) return;
    const dLat = nb.lat - node.lat;
    const dLon = nb.lon - node.lon;
    if (dLat === 0 && dLon === 0) return;

    const nbAngleRad = Math.atan2(dLat, dLon); // geographic angle (atan2(lat, lon))
    let diff = Math.abs(nbAngleRad - geoAngleRad);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;

    if (diff < Math.PI / 2 && diff < bestDiff) { // within 90° cone
      bestDiff = diff;
      bestId = nbId;
    }
  });

  return bestId;
}

// =============================================
//  MOVEMENT — 3D (tank / ego-shooter steering)
// =============================================

function updatePacman3D(dt: number) {
  const driveKey = activeKey; // 'ArrowUp', 'ArrowDown', or null

  // heading: the current facing angle in screen-pixel-space degrees
  // ArrowUp = drive forward (same heading), ArrowDown = drive backward (heading + 180°)
  const forwardHeading = driveKey === 'ArrowDown'
    ? ((currentRotation + 180) % 360)
    : currentRotation;

  // ── 1. Start a new segment ─────────────────────────────────────────────────
  if (!pacTargetNodeId && driveKey && pacCurrentNodeId) {
    const candidate = bestNeighborForHeading(pacCurrentNodeId, forwardHeading, null);
    if (candidate) {
      pacTargetNodeId = candidate;
      pacProgress = 0;
    }
  }

  // ── 2. Travel along current segment ──────────────────────────────────────
  if (pacTargetNodeId) {
    const cNode = engine.getNodes().get(pacCurrentNodeId!)!;
    const tNode = engine.getNodes().get(pacTargetNodeId)!;
    if (!cNode || !tNode) { pacTargetNodeId = null; return; }

    const dist = map.distance([cNode.lat, cNode.lon], [tNode.lat, tNode.lon]);
    const durationMs = (dist / pacSpeed) * 1000;
    pacProgress += dt / durationMs;

    if (pacProgress >= 1) {
      const prevNodeId = pacCurrentNodeId!;
      pacCurrentNodeId = pacTargetNodeId;
      pacProgress = 0;
      engine.setPacmanPosition(pacCurrentNodeId);
      updateHUD();

      if (driveKey) {
        // Find the next neighbor in the current heading, but don't reverse
        let nextNode = bestNeighborForHeading(pacCurrentNodeId, forwardHeading, prevNodeId);
        // If nothing found without exclusion, allow any direction
        if (!nextNode) nextNode = bestNeighborForHeading(pacCurrentNodeId, forwardHeading, null);
        // Still don't reverse unless it's truly the only option
        if (nextNode === prevNodeId) nextNode = null;
        pacTargetNodeId = nextNode;
      } else {
        pacTargetNodeId = null;
      }
    }
  }
}

// =============================================
//  GAME LOOP
// =============================================

function gameLoop(time: number) {
  requestAnimationFrame(gameLoop);

  if (isGameOver || isRespawning) { drawFrame(); lastFrameTime = 0; return; }
  if (!lastFrameTime) { lastFrameTime = time; drawFrame(); return; }

  const dt = time - lastFrameTime;
  lastFrameTime = time;


  // ── 3D Tank Rotation ─────────────────────────────────────────────────────
  // Must run BEFORE drawFrame so pacMesh sees the updated heading immediately.
  if (currentTheme === '3d') {
    const turnSpeed = 150 * (dt / 1000);

    if (keysDown.has('ArrowLeft'))  currentRotation -= turnSpeed;
    if (keysDown.has('ArrowRight')) currentRotation += turnSpeed;
    if (Math.abs(joyKnobX) > 0.1 && joyMaxTravel > 0) currentRotation += (joyKnobX / joyMaxTravel) * turnSpeed;

    if (isNaN(currentRotation)) currentRotation = 0; // NaN guard — prevents perpetual steering failure
    currentRotation = ((currentRotation % 360) + 540) % 360 - 180;

    // activeKey in 3D = gas pedal only
    activeKey = null;
    if (keysDown.has('ArrowUp')   || (joyMaxTravel > 0 && joyKnobY / joyMaxTravel < -0.3)) activeKey = 'ArrowUp';
    if (keysDown.has('ArrowDown') || (joyMaxTravel > 0 && joyKnobY / joyMaxTravel > 0.3))  activeKey = 'ArrowDown';

  }

  drawFrame(); // render with latest rotation

  // ── Shared bookkeeping ────────────────────────────────────────────────────
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

  // ── Branch movement by mode ───────────────────────────────────────────────
  if (currentTheme === '3d') {
    updatePacman3D(dt);
  } else {
    updatePacman2D(dt);
  }

  // ── Update pacLatLng for renderer ─────────────────────────────────────────
  if (pacCurrentNodeId) {
    const cNodeFinal = engine.getNodes().get(pacCurrentNodeId);
    const tNodeFinal = engine.getNodes().get(pacTargetNodeId || pacCurrentNodeId);
    if (cNodeFinal && tNodeFinal) {
      const refZoom = 20;
      const p1 = map.project([cNodeFinal.lat, cNodeFinal.lon], refZoom);
      const p2 = map.project([tNodeFinal.lat, tNodeFinal.lon], refZoom);
      const pxX = p1.x + (p2.x - p1.x) * pacProgress;
      const pxY = p1.y + (p2.y - p1.y) * pacProgress;
      if (!isNaN(pxX) && !isNaN(pxY)) {
        pacLatLng = map.unproject([pxX, pxY], refZoom);
        if (currentTheme !== '3d' && pacTargetNodeId) {
          map.panInside(pacLatLng, { padding: [250, 250], animate: false });
        }
      }
    }
  }

  // 3. Ghost movement
  ghosts.forEach(ghost => {
     // Removed blink timer logic
     // ghost.blinkTimer -= dt;
     // if (ghost.blinkTimer <= 0) {
     //   if (ghost.isBlinking) {
     //     ghost.isBlinking = false;
     //     ghost.blinkTimer = Math.random() * 3000 + 2000;
     //   } else {
     //     ghost.isBlinking = true;
     //     ghost.blinkTimer = 120 + Math.random() * 80;
     //   }
     // }

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

      const refZoom = 20;
      const gp1 = map.project([cNode.lat, cNode.lon], refZoom);
      const gp2 = map.project([tNode.lat, tNode.lon], refZoom);
      const gpxX = gp1.x + (gp2.x - gp1.x) * renderProgress;
      const gpxY = gp1.y + (gp2.y - gp1.y) * renderProgress;
      
      if (!isNaN(gpxX) && !isNaN(gpxY)) {
        const ghostLatLng = map.unproject([gpxX, gpxY], refZoom);
        ghost.lat = ghostLatLng.lat;
        ghost.lon = ghostLatLng.lng;
      }
  });

  // 4. Rocket movement
  for (let i = rockets.length - 1; i >= 0; i--) {
    const rocket = rockets[i];
    rocket.lifeTime -= dt;
    if (rocket.lifeTime <= 0) { 
      rockets.splice(i, 1);
      continue;
    }

    const cNode = engine.getNodes().get(rocket.currentNodeId);
    const tNode = engine.getNodes().get(rocket.targetNodeId);
    if (!cNode || !tNode) { rockets.splice(i, 1); continue; }

    const dist = map.distance([cNode.lat, cNode.lon], [tNode.lat, tNode.lon]);
    const durationMs = dist > 0 ? (dist / rocket.speed) * 1000 : 200;
    rocket.progress += dt / durationMs;

    let spliced = false;
    while (rocket.progress >= 1) {
      rocket.progress -= 1;
      const prev = rocket.currentNodeId;
      rocket.currentNodeId = rocket.targetNodeId;
      rocket.prevNodeId = prev;

      const node = engine.getNodes().get(rocket.currentNodeId);
      if (!node || node.neighbors.length === 0) {
        rockets.splice(i, 1);
        spliced = true;
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
      
      rocket.targetNodeId = nextNodeId;
    }

    if (spliced) continue;

    if (rockets[i]) {
       const rcNode = engine.getNodes().get(rocket.currentNodeId);
       const rtNode = engine.getNodes().get(rocket.targetNodeId);
       if (rcNode && rtNode) {
         const refZoom = 20; // use same stable reference zoom for all entity physical movement projection interpolation to prevent jitter and maintain consistent math
         const rp1 = map.project([rcNode.lat, rcNode.lon], refZoom);
         const rp2 = map.project([rtNode.lat, rtNode.lon], refZoom);
         let rProgress = rocket.progress;
         if (isNaN(rProgress) || !isFinite(rProgress)) rProgress = 0; // Failsafe
         
         const rpxX = rp1.x + (rp2.x - rp1.x) * Math.min(Math.max(rProgress, 0), 1);
         const rpxY = rp1.y + (rp2.y - rp1.y) * Math.min(Math.max(rProgress, 0), 1);
         
         if (!isNaN(rpxX) && !isNaN(rpxY)) {
           const rocketLatLng = map.unproject([rpxX, rpxY], refZoom);
           rocket.lat = rocketLatLng.lat;
           rocket.lon = rocketLatLng.lng;
         }
       }
    }
  }

  // 5. Collision detection
  if (isRespawning || isGameOver || !pacLatLng) return;

  const PACMAN_RADIUS_DEG_SQ = 0.000000005;
  const pLat = pacLatLng.lat;
  const pLng = pacLatLng.lng;

  let collisionThisFrame = false;
  ghosts.forEach((ghost) => {
     if (collisionThisFrame) return;
     const dLat = pLat - ghost.lat;
     const dLon = pLng - ghost.lon;
     const distSq = dLat*dLat + dLon*dLon;
    if (distSq < PACMAN_RADIUS_DEG_SQ) {
       collisionThisFrame = true;
       if (engine.getState().powerUpActive) {
         engine.eatGhost();
         updateHUD();
         
         // Create rocket explosion sparks
         // createSparks(...) removed

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
    // Use a fixed rough distance instead of screen pixels (~4.5 meters approximation)
    for (let gIdx = ghosts.length - 1; gIdx >= 0; gIdx--) {
      const ghost = ghosts[gIdx];
      const dLat = rocket.lat - ghost.lat;
      const dLon = rocket.lon - ghost.lon;
      const dSq = dLat*dLat + dLon*dLon;
      if (dSq < 0.000000002) { // very rough 4.5m^2 approximation
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
      keysDown.add(e.key);
      activeKey = e.key as any;
    }
  });

  window.addEventListener('keyup', (e) => {
    keysDown.delete(e.key);
    if (e.key === activeKey) {
      activeKey = Array.from(keysDown).pop() as any || null;
      bufferedKey = null;
    }
  });

  // --- Canvas Joysticks ---
  const joyCanvas = document.getElementById('joystick-canvas') as HTMLCanvasElement;
  const jCtx = joyCanvas.getContext('2d')!;
  let joystickActive = false;

  const camJoyCanvas = document.getElementById('cam-joystick-canvas') as HTMLCanvasElement;
  const cCtx = camJoyCanvas.getContext('2d')!;
  let camJoystickActive = false;

  const deadzone = 0.15;

  let knobTargetX = 0; let knobTargetY = 0;
  let camKnobTargetX = 0; let camKnobTargetY = 0;
  
  let knobX = 0; let knobY = 0;
  let localCamKnobX = 0; let localCamKnobY = 0;

  function sizeJoystickCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = joyCanvas.getBoundingClientRect();
    if (rect.width > 0) {
      joyCanvas.width = rect.width * dpr;
      joyCanvas.height = rect.height * dpr;
      jCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      
      camJoyCanvas.width = rect.width * dpr;
      camJoyCanvas.height = rect.height * dpr;
      cCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  sizeJoystickCanvas();
  window.addEventListener('resize', sizeJoystickCanvas);

  function getJoySize(canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const baseR = cx - 4;
    const knobR = baseR * 0.35;
    const maxTravel = baseR - knobR - 2;
    if (canvas === joyCanvas) joyMaxTravel = maxTravel;
    return { cx, cy, baseR, knobR, maxTravel };
  }

  function drawArrow(ctx: CanvasRenderingContext2D, ax: number, ay: number, angle: number, size: number, alpha: number, colorRGB: string) {
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(-size * 0.6, size * 0.3);
    ctx.lineTo(size * 0.6, size * 0.3);
    ctx.closePath();
    ctx.fillStyle = `rgba(${colorRGB}, ${alpha})`;
    ctx.fill();
    ctx.restore();
  }

  function drawJoystick() {
    const rect = joyCanvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const w = rect.width;
    const h = rect.height;
    const { cx, cy, baseR, knobR } = getJoySize(joyCanvas);

    jCtx.clearRect(0, 0, w, h);

    jCtx.beginPath();
    jCtx.arc(cx, cy, baseR, 0, Math.PI * 2);
    jCtx.fillStyle = 'rgba(20, 20, 30, 0.85)';
    jCtx.fill();
    jCtx.strokeStyle = 'rgba(255, 210, 47, 0.35)';
    jCtx.lineWidth = 2;
    jCtx.stroke();

    const arrowDist = baseR * 0.72;
    const mainSize = baseR * 0.14;
    const diagSize = baseR * 0.09;
    const arrowColor = '255, 210, 47';
    drawArrow(jCtx, cx, cy - arrowDist, 0, mainSize, 0.3, arrowColor);
    drawArrow(jCtx, cx + arrowDist, cy, Math.PI / 2, mainSize, 0.3, arrowColor);
    drawArrow(jCtx, cx, cy + arrowDist, Math.PI, mainSize, 0.3, arrowColor);
    drawArrow(jCtx, cx - arrowDist, cy, -Math.PI / 2, mainSize, 0.3, arrowColor);
    const diagDist = arrowDist * 0.9;
    const d = diagDist * 0.707;
    drawArrow(jCtx, cx + d, cy - d, Math.PI / 4, diagSize, 0.15, arrowColor);
    drawArrow(jCtx, cx + d, cy + d, Math.PI * 3 / 4, diagSize, 0.15, arrowColor);
    drawArrow(jCtx, cx - d, cy + d, -Math.PI * 3 / 4, diagSize, 0.15, arrowColor);
    drawArrow(jCtx, cx - d, cy - d, -Math.PI / 4, diagSize, 0.15, arrowColor);

    const kx = cx + knobX;
    const ky = cy + knobY;
    jCtx.beginPath();
    jCtx.arc(kx, ky, knobR + 4, 0, Math.PI * 2);
    jCtx.fillStyle = joystickActive
      ? 'rgba(255, 210, 47, 0.15)'
      : 'rgba(255, 210, 47, 0.05)';
    jCtx.fill();

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

    jCtx.beginPath();
    jCtx.arc(kx - knobR * 0.2, ky - knobR * 0.2, knobR * 0.35, 0, Math.PI * 2);
    jCtx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    jCtx.fill();
  }

  function drawCamJoystick() {
    if (currentTheme !== '3d') return;
    // Always use joyCanvas for dimensions to avoid display:none zero-width issues!
    const rect = joyCanvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const w = rect.width;
    const h = rect.height;
    const { cx, cy, baseR } = getJoySize(joyCanvas);

    cCtx.clearRect(0, 0, w, h);

    const maxT = baseR - (baseR * 0.35) - 2;
    const nx = maxT ? localCamKnobX / maxT : 0;
    const ny = maxT ? localCamKnobY / maxT : 0;

    cCtx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    cCtx.lineWidth = 1.5;
    if (camJoystickActive) {
       cCtx.strokeStyle = 'rgba(0, 210, 255, 0.9)';
       cCtx.shadowColor = 'rgba(0, 210, 255, 0.6)';
       cCtx.shadowBlur = 8;
    } else {
       cCtx.shadowBlur = 0;
    }

    // Outer globe circle
    cCtx.beginPath();
    cCtx.arc(cx, cy, baseR, 0, Math.PI * 2);
    cCtx.fillStyle = 'rgba(20, 20, 30, 0.6)';
    cCtx.fill();
    cCtx.stroke();
    
    // Latitude/Longitude dynamic ellipses (Globe wireframe)
    const tiltY = (ny - 0.15) * baseR; 
    cCtx.beginPath();
    cCtx.ellipse(cx, cy, baseR, Math.max(0.1, Math.abs(tiltY)), 0, 0, Math.PI*2);
    cCtx.stroke();
    
    const panX = nx * baseR;
    cCtx.beginPath();
    cCtx.ellipse(cx, cy, Math.max(0.1, Math.abs(panX)), baseR, 0, 0, Math.PI*2);
    cCtx.stroke();

    // 360 text
    cCtx.shadowBlur = 0;
    cCtx.font = 'bold 16px sans-serif';
    cCtx.textAlign = 'center';
    cCtx.textBaseline = 'middle';
    cCtx.fillStyle = camJoystickActive ? 'rgba(0, 210, 255, 1)' : 'rgba(255, 255, 255, 0.8)';
    cCtx.fillText('360°', cx + localCamKnobX, cy + localCamKnobY);
    
    // Draw directional arrows only when moving
    const arrowDist = baseR * 0.75;
    const mainSize = baseR * 0.11; // smaller arrows

    const movingLeft = localCamKnobX < -4;
    const movingRight = localCamKnobX > 4;
    const movingUp = localCamKnobY < -4;
    const movingDown = localCamKnobY > 4;
    
    const camArrowCol = '0, 210, 255';
    if (movingUp) drawArrow(cCtx, cx, cy - arrowDist, 0, mainSize, 0.8, camArrowCol);
    if (movingRight) drawArrow(cCtx, cx + arrowDist, cy, Math.PI / 2, mainSize, 0.8, camArrowCol);
    if (movingDown) drawArrow(cCtx, cx, cy + arrowDist, Math.PI, mainSize, 0.8, camArrowCol);
    if (movingLeft) drawArrow(cCtx, cx - arrowDist, cy, -Math.PI / 2, mainSize, 0.8, camArrowCol);
  }

  function joystickLoop() {
    requestAnimationFrame(joystickLoop);

    const lerp = joystickActive ? 0.3 : 0.15;
    knobX += (knobTargetX - knobX) * lerp;
    knobY += (knobTargetY - knobY) * lerp;

    if (!joystickActive && Math.abs(knobX) < 0.5 && Math.abs(knobY) < 0.5) {
      knobX = 0;
      knobY = 0;
    }
    joyKnobX = knobX;
    joyKnobY = knobY;

    const camLerp = camJoystickActive ? 0.3 : 0.15;
    localCamKnobX += (camKnobTargetX - localCamKnobX) * camLerp;
    localCamKnobY += (camKnobTargetY - localCamKnobY) * camLerp;

    if (!camJoystickActive && Math.abs(localCamKnobX) < 0.5 && Math.abs(localCamKnobY) < 0.5) {
      localCamKnobX = 0; localCamKnobY = 0;
    }
    
    const { maxTravel: camMaxTravel } = getJoySize(camJoyCanvas);
    camJoyX = camMaxTravel ? localCamKnobX / camMaxTravel : 0;
    camJoyY = camMaxTravel ? localCamKnobY / camMaxTravel : 0;

    drawJoystick();
    drawCamJoystick();
  }
  requestAnimationFrame(joystickLoop);

  function handleInput(clientX: number, clientY: number, canvas: HTMLCanvasElement, setTarget: (dx:number, dy:number)=>void) {
    const rect = canvas.getBoundingClientRect();
    const { cx, cy, maxTravel, baseR } = getJoySize(canvas);
    let dx = (clientX - rect.left) - cx;
    let dy = (clientY - rect.top) - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > maxTravel) {
      dx = (dx / dist) * maxTravel;
      dy = (dy / dist) * maxTravel;
    }

    setTarget(dx, dy);

    if (canvas === joyCanvas) {
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
  }

  // --- Mouse Events ---
  joyCanvas.addEventListener('mousedown', (e) => {
    e.preventDefault(); joystickActive = true;
    handleInput(e.clientX, e.clientY, joyCanvas, (dx, dy) => { knobTargetX = dx; knobTargetY = dy; });
  });

  camJoyCanvas.addEventListener('mousedown', (e) => {
    e.preventDefault(); camJoystickActive = true;
    handleInput(e.clientX, e.clientY, camJoyCanvas, (dx, dy) => { camKnobTargetX = dx; camKnobTargetY = dy; });
  });

  window.addEventListener('mousemove', (e) => {
    if (joystickActive) {
      handleInput(e.clientX, e.clientY, joyCanvas, (dx, dy) => { knobTargetX = dx; knobTargetY = dy; });
    }
    if (camJoystickActive) {
      handleInput(e.clientX, e.clientY, camJoyCanvas, (dx, dy) => { camKnobTargetX = dx; camKnobTargetY = dy; });
    }
  });

  window.addEventListener('mouseup', () => {
    if (joystickActive) {
      joystickActive = false; knobTargetX = 0; knobTargetY = 0; activeKey = null; bufferedKey = null;
    }
    if (camJoystickActive) {
      camJoystickActive = false; camKnobTargetX = 0; camKnobTargetY = 0;
    }
  });

  // --- Touch Events ---
  function setupTouchEvents(canvas: HTMLCanvasElement, getActive: ()=>boolean, setActive: (a:boolean)=>void, setTarget: (dx:number, dy:number)=>void) {
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault(); setActive(true);
      const touch = Array.from(e.touches).find(t => t.target === canvas) || e.touches[0];
      handleInput(touch.clientX, touch.clientY, canvas, setTarget);
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (!getActive()) return;
      e.preventDefault();
      const touch = Array.from(e.touches).find(t => t.target === canvas) || e.touches[0];
      handleInput(touch.clientX, touch.clientY, canvas, setTarget);
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault(); setActive(false); setTarget(0, 0);
      if (canvas === joyCanvas) { activeKey = null; bufferedKey = null; }
    }, { passive: false });

    canvas.addEventListener('touchcancel', () => {
      setActive(false); setTarget(0, 0);
      if (canvas === joyCanvas) { activeKey = null; bufferedKey = null; }
    });
  }

  setupTouchEvents(joyCanvas, () => joystickActive, (a) => joystickActive = a, (dx, dy) => { knobTargetX = dx; knobTargetY = dy; });
  setupTouchEvents(camJoyCanvas, () => camJoystickActive, (a) => camJoystickActive = a, (dx, dy) => { camKnobTargetX = dx; camKnobTargetY = dy; });

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
