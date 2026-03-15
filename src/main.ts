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
  isRespawning = true; // Set to true to trigger animation and stop game logic
  lastFrameTime = 0;
  activeKey = null;
  bufferedKey = null;

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
         isRespawning = false; // Respawn finished
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
  });

  renderer.drawFrame(performance.now());
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
    }
  }

  // Always keep pacLatLng up to date for the renderer
  if (pacCurrentNodeId) {
    const cNodeFinal = engine.getNodes().get(pacCurrentNodeId)!;
    const tNodeFinal = engine.getNodes().get(pacTargetNodeId || pacCurrentNodeId)!;

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

    while (rocket.progress >= 1) {
      rocket.progress -= 1;
      const prev = rocket.currentNodeId;
      rocket.currentNodeId = rocket.targetNodeId;
      rocket.prevNodeId = prev;

      const node = engine.getNodes().get(rocket.currentNodeId);
      if (!node || node.neighbors.length === 0) {
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

  function drawArrow3D(ax: number, ay: number, angle: number, size: number, alpha: number) {
    jCtx.save();
    jCtx.translate(ax, ay);
    jCtx.rotate(angle);
    jCtx.beginPath();
    jCtx.moveTo(0, -size);
    jCtx.lineTo(-size * 0.6, size * 0.3);
    jCtx.lineTo(0, size * 0.1);
    jCtx.lineTo(size * 0.6, size * 0.3);
    jCtx.closePath();
    jCtx.fillStyle = `rgba(0, 210, 255, ${alpha})`;
    jCtx.shadowColor = `rgba(0, 210, 255, ${alpha * 0.8})`;
    jCtx.shadowBlur = 6;
    jCtx.fill();
    jCtx.restore();
  }

  function drawIsometricHex(cx: number, cy: number, r: number) {
    // Draw isometric "platform" using a squashed hexagon with 3 faces
    const skewY = 0.5; // isometric compression

    // Top face (lighter)
    jCtx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 - Math.PI / 6;
      const px = cx + r * Math.cos(a);
      const py = cy + r * Math.sin(a) * skewY;
      i === 0 ? jCtx.moveTo(px, py) : jCtx.lineTo(px, py);
    }
    jCtx.closePath();
    const faceGrad = jCtx.createRadialGradient(cx, cy - 4, 0, cx, cy, r);
    faceGrad.addColorStop(0, 'rgba(0, 60, 80, 0.9)');
    faceGrad.addColorStop(1, 'rgba(0, 20, 30, 0.85)');
    jCtx.fillStyle = faceGrad;
    jCtx.fill();

    // Edge glow
    jCtx.strokeStyle = 'rgba(0, 210, 255, 0.5)';
    jCtx.lineWidth = 1.5;
    jCtx.stroke();

    // Inner ring glow
    jCtx.beginPath();
    jCtx.ellipse(cx, cy, r * 0.65, r * 0.65 * skewY, 0, 0, Math.PI * 2);
    jCtx.strokeStyle = 'rgba(0, 255, 200, 0.15)';
    jCtx.lineWidth = 1;
    jCtx.stroke();
  }

  function drawJoystick() {
    const rect = joyCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const { cx, cy, baseR, knobR } = getJoySize();

    jCtx.clearRect(0, 0, w, h);

    const is3DMode = currentTheme === '3d';

    if (is3DMode) {
      // === 3D Isometric Joystick ===
      drawIsometricHex(cx, cy, baseR);

      // Cardinal 3D arrows
      const arrowDist = baseR * 0.7;
      const mainSize = baseR * 0.13;
      const diagSize = baseR * 0.08;
      const mainAlpha = 0.45;
      const diagAlpha = 0.2;
      drawArrow3D(cx, cy - arrowDist, 0, mainSize, mainAlpha);
      drawArrow3D(cx + arrowDist, cy, Math.PI / 2, mainSize, mainAlpha);
      drawArrow3D(cx, cy + arrowDist, Math.PI, mainSize, mainAlpha);
      drawArrow3D(cx - arrowDist, cy, -Math.PI / 2, mainSize, mainAlpha);
      const d3 = arrowDist * 0.65;
      drawArrow3D(cx + d3, cy - d3, Math.PI / 4, diagSize, diagAlpha);
      drawArrow3D(cx + d3, cy + d3, Math.PI * 3 / 4, diagSize, diagAlpha);
      drawArrow3D(cx - d3, cy + d3, -Math.PI * 3 / 4, diagSize, diagAlpha);
      drawArrow3D(cx - d3, cy - d3, -Math.PI / 4, diagSize, diagAlpha);

      // 3D Knob
      const kx = cx + knobX;
      const ky = cy + knobY;

      // Shadow below knob
      jCtx.beginPath();
      jCtx.ellipse(kx, ky + knobR * 0.4, knobR * 0.9, knobR * 0.3, 0, 0, Math.PI * 2);
      jCtx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      jCtx.fill();

      // Outer glow
      jCtx.beginPath();
      jCtx.arc(kx, ky, knobR + 5, 0, Math.PI * 2);
      jCtx.fillStyle = joystickActive
        ? 'rgba(0, 210, 255, 0.2)'
        : 'rgba(0, 210, 255, 0.06)';
      jCtx.fill();

      // Knob sphere gradient (3D look)
      const knobGrad3 = jCtx.createRadialGradient(kx - knobR * 0.3, ky - knobR * 0.35, knobR * 0.05, kx, ky, knobR);
      knobGrad3.addColorStop(0, 'rgba(180, 240, 255, 0.95)');
      knobGrad3.addColorStop(0.4, 'rgba(0, 180, 220, 0.85)');
      knobGrad3.addColorStop(1, 'rgba(0, 80, 120, 0.9)');
      jCtx.beginPath();
      jCtx.arc(kx, ky, knobR, 0, Math.PI * 2);
      jCtx.fillStyle = knobGrad3;
      jCtx.shadowColor = 'rgba(0, 210, 255, 0.7)';
      jCtx.shadowBlur = joystickActive ? 12 : 6;
      jCtx.fill();
      jCtx.shadowBlur = 0;
      jCtx.strokeStyle = 'rgba(0, 230, 255, 0.9)';
      jCtx.lineWidth = 1.5;
      jCtx.stroke();

      // Specular highlight
      jCtx.beginPath();
      jCtx.arc(kx - knobR * 0.25, ky - knobR * 0.3, knobR * 0.3, 0, Math.PI * 2);
      jCtx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      jCtx.fill();

    } else {
      // === Standard 2D Joystick ===
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
      drawArrow(cx, cy - arrowDist, 0, mainSize, 0.3);
      drawArrow(cx + arrowDist, cy, Math.PI / 2, mainSize, 0.3);
      drawArrow(cx, cy + arrowDist, Math.PI, mainSize, 0.3);
      drawArrow(cx - arrowDist, cy, -Math.PI / 2, mainSize, 0.3);
      const diagDist = arrowDist * 0.9;
      const d = diagDist * 0.707;
      drawArrow(cx + d, cy - d, Math.PI / 4, diagSize, 0.15);
      drawArrow(cx + d, cy + d, Math.PI * 3 / 4, diagSize, 0.15);
      drawArrow(cx - d, cy + d, -Math.PI * 3 / 4, diagSize, 0.15);
      drawArrow(cx - d, cy - d, -Math.PI / 4, diagSize, 0.15);

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
