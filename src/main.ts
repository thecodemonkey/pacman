import './style.css';
import L from 'leaflet';
import { GameEngine } from './game/engine';

// --- State and Constants ---
let map: L.Map;
let streetLayer: L.TileLayer;
let satelliteLayer: L.TileLayer;
let currentTheme: 'street' | 'pacman' | 'satellite' = 'pacman';
let pacmanMarker: L.Marker;
let userPos: [number, number] = [51.505, -0.09]; // Default London
let currentRotation = 0;
let activeKey: 'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight' | null = null;
let pacCurrentNodeId: string | null = null;
let pacTargetNodeId: string | null = null;
let pacProgress = 0;
let lastFrameTime = 0;
let isGameOver = false;
let isRespawning = false;
const pacSpeed = 80; // m/s

const engine = new GameEngine();
const dotMarkers: Map<string, L.CircleMarker> = new Map();

interface GhostState {
  id: string;
  marker: L.Marker;
  currentNodeId: string;
  targetNodeId: string;
  prevNodeId: string | null;
  progress: number;
}
const ghosts: GhostState[] = [];

const HUD = {
  score: document.getElementById('score') as HTMLElement,
  lives: document.getElementById('lives') as HTMLElement,
  viewToggle: document.getElementById('view-toggle') as HTMLButtonElement,
  loading: document.getElementById('loading-screen') as HTMLElement,
  gameOverScreen: document.getElementById('game-over-screen') as HTMLElement,
  finalScore: document.getElementById('final-score') as HTMLElement,
  btnRestart: document.getElementById('btn-restart') as HTMLButtonElement,
};

// --- Custom Icons ---
const pacmanIcon = L.divIcon({
  className: 'pacman-container',
  html: '<div class="pacman"><div class="pacman-eye"></div></div>',
  iconSize: [60, 60],
  iconAnchor: [30, 30],
});

function createGhostIcon(color: string) {
  const blinkDelay = (Math.random() * 5).toFixed(2);
  return L.divIcon({
    className: 'ghost-container',
    html: `
      <div class="ghost" style="background: ${color}">
        <div class="ghost-eyes" style="animation: blink 4s infinite ${blinkDelay}s; transform-origin: center;">
          <div class="eye"></div>
          <div class="eye"></div>
        </div>
      </div>
    `,
    iconSize: [44, 50],
    iconAnchor: [22, 25],
  });
}

// --- Map Initialization ---
function initMap(lat: number, lon: number) {
  userPos = [lat, lon];

  map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
  }).setView(userPos, 19);

  streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
  satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');

  document.getElementById('map')?.classList.add('theme-pacman');

  pacmanMarker = L.marker(userPos, {
    icon: pacmanIcon,
    zIndexOffset: 1000,
  }).addTo(map);

  setupInput();
  fetchNearbyStreets(lat, lon);
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

// --- View Toggle ---
HUD.viewToggle.innerText = 'Pac-Man View';
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
    HUD.viewToggle.innerText = 'Pac-Man View';
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
  const nearestNode = engine.findNearestNode(userPos[0], userPos[1]);
  engine.setInitialPacmanPosition(nearestNode);

  const pacNode = engine.getPacmanNode();
  if (pacNode) {
    pacmanMarker.setLatLng([pacNode.lat, pacNode.lon]);
    map.setView([pacNode.lat, pacNode.lon], 19);
  }

  renderStreets();
  renderDots();
  spawnGhosts();

  HUD.loading.classList.add('hidden');
  HUD.loading.style.display = 'none';
}

function renderStreets() {
  const drawnEdges = new Set<string>();
  const nodes = engine.getNodes();
  const multiCoords: L.LatLngExpression[][] = [];

  nodes.forEach(node => {
    node.neighbors.forEach(neighborId => {
      const edgeId = [node.id, neighborId].sort().join('-');
      if (!drawnEdges.has(edgeId)) {
        drawnEdges.add(edgeId);
        const nb = nodes.get(neighborId);
        if (nb) {
          multiCoords.push([[node.lat, node.lon], [nb.lat, nb.lon]]);
        }
      }
    });
  });

  // Background Glow + Border
  L.polyline(multiCoords, {
    className: 'street-glow',
    lineCap: 'round',
    lineJoin: 'round'
  }).addTo(map);

  // Inner Semi-Transparent Core
  L.polyline(multiCoords, {
    className: 'street-inner',
    lineCap: 'round',
    lineJoin: 'round'
  }).addTo(map);
}

function renderDots() {
  dotMarkers.forEach(m => map.removeLayer(m));
  dotMarkers.clear();

  engine.getDots().forEach(dot => {
    const marker = L.circleMarker([dot.lat, dot.lon], {
      radius: 4,
      className: 'pacman-dot'
    }).addTo(map);
    dotMarkers.set(dot.id, marker);
  });
}

function spawnGhosts() {
  const colors = ['#ff0000', '#ffb8ff', '#00ffff', '#ffb852'];
  const nodes = Array.from(engine.getNodes().values());

  colors.forEach((color, i) => {
    const randNode = nodes[Math.floor(Math.random() * nodes.length)];
    const marker = L.marker([randNode.lat, randNode.lon], {
      icon: createGhostIcon(color),
      zIndexOffset: 900,
    }).addTo(map);

    let nextId = randNode.neighbors[Math.floor(Math.random() * randNode.neighbors.length)];
    if (!nextId) nextId = randNode.id;

    ghosts.push({
      id: `ghost_${i}`,
      marker,
      currentNodeId: randNode.id,
      targetNodeId: nextId,
      prevNodeId: null,
      progress: 0
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
  pacCurrentNodeId = null;
  pacTargetNodeId = null;
  pacProgress = 0;
  
  HUD.gameOverScreen.classList.add('hidden');
  
  // Clear all ghosts
  ghosts.forEach(g => map.removeLayer(g.marker));
  ghosts.length = 0;

  // Reset Pac-Man visually
  const nearestNode = engine.findNearestNode(userPos[0], userPos[1]);
  engine.setInitialPacmanPosition(nearestNode);
  const pacNode = engine.getPacmanNode();
  if (pacNode) {
    pacmanMarker.setLatLng([pacNode.lat, pacNode.lon]);
    map.setView([pacNode.lat, pacNode.lon], 19);
  }

  renderDots();
  updateHUD();
  spawnGhosts();
  lastFrameTime = 0;
}

HUD.btnRestart.addEventListener('click', () => {
  resetGameParams();
});

function triggerRespawn() {
  isRespawning = true;
  lastFrameTime = 0;
  activeKey = null;

  // Clear ghosts immediately so they don't keep moving/colliding during the animation
  ghosts.forEach(g => map.removeLayer(g.marker));
  ghosts.length = 0;
  
  updateHUD();

  const el = pacmanMarker.getElement();
  if (el) {
    el.style.transition = 'none';
    el.classList.add('pacman-blink'); // 1. Blink at collision spot
  }

  // 2. Wait 2 seconds while blinking at the death location
  setTimeout(() => {
    if (el) {
      el.classList.remove('pacman-blink');
    }

    // 3. Teleport back to spawn safely and quickly
    pacCurrentNodeId = engine.getInitialPacmanNodeId();
    pacTargetNodeId = null;
    pacProgress = 0;
    
    const initNode = engine.getNodes().get(pacCurrentNodeId)!;
    engine.setPacmanPosition(pacCurrentNodeId);
    pacmanMarker.setLatLng([initNode.lat, initNode.lon]);
    
    // Pan the camera quickly to the spawn point
    map.panTo([initNode.lat, initNode.lon], { animate: true, duration: 0.5 });

    // 4. Wait for the quick pan to finish, then resume game
    setTimeout(() => {
       if (!isGameOver) {
         spawnGhosts();
         isRespawning = false;
         lastFrameTime = performance.now();
       }
    }, 600);

  }, 2000);
}

// removed moveGhostLoop

function updateHUD() {
  const state = engine.getState();
  HUD.score.innerText = state.score.toString().padStart(4, '0');
  HUD.lives.innerText = '❤'.repeat(state.lives);
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

  const isFlipped = Math.abs(currentRotation % 360) > 90 && Math.abs(currentRotation % 360) < 270;

  const el = pacmanMarker.getElement();
  if (el) {
    const inner = el.querySelector('.pacman') as HTMLElement;
    if (inner) {
      inner.style.transform = `rotate(${currentRotation}deg)`;
    }
    const eye = el.querySelector('.pacman-eye') as HTMLElement;
    if (eye) {
      eye.style.top = isFlipped ? '40px' : '12px';
    }
  }
}

function pacmanLoop(time: number) {
  requestAnimationFrame(pacmanLoop);
  if (isGameOver || isRespawning) { lastFrameTime = 0; return; }
  
  if (!lastFrameTime) { lastFrameTime = time; return; }
  const dt = time - lastFrameTime;
  lastFrameTime = time;

  if (!pacCurrentNodeId) {
    const node = engine.getPacmanNode();
    if (node) pacCurrentNodeId = node.id;
    else return;
  }

  // 1. If not moving, try to start moving
  if (!pacTargetNodeId && activeKey) {
    pacTargetNodeId = engine.getNextNode(pacCurrentNodeId, activeKey);
    if (pacTargetNodeId) {
       pacProgress = 0;
       updatePacmanRotation(pacCurrentNodeId, pacTargetNodeId);
    }
  }

  // 2. If moving, interpolate
  if (pacTargetNodeId) {
    // Check if user is actively reversing direction
    if (activeKey) {
      const idealNextFromTarget = engine.getNextNode(pacTargetNodeId, activeKey);
      if (idealNextFromTarget === pacCurrentNodeId) {
         // Swap direction mid-edge!
         const temp = pacTargetNodeId;
         pacTargetNodeId = pacCurrentNodeId;
         pacCurrentNodeId = temp;
         pacProgress = 1 - pacProgress;
         updatePacmanRotation(pacCurrentNodeId, pacTargetNodeId);
      }
    }

    if (activeKey) {
       const cNode = engine.getNodes().get(pacCurrentNodeId)!;
       const tNode = engine.getNodes().get(pacTargetNodeId)!;
       const dist = map.distance([cNode.lat, cNode.lon], [tNode.lat, tNode.lon]);
       const durationMs = (dist / pacSpeed) * 1000;
       
       pacProgress += dt / durationMs;
       
       if (pacProgress >= 1) {
          pacProgress = 1;
          pacCurrentNodeId = pacTargetNodeId;
          engine.setPacmanPosition(pacCurrentNodeId);
          
          const dot = dotMarkers.get(pacCurrentNodeId);
          if (dot) {
            map.removeLayer(dot);
            dotMarkers.delete(pacCurrentNodeId);
          }
          updateHUD();

          pacTargetNodeId = engine.getNextNode(pacCurrentNodeId, activeKey);
          if (pacTargetNodeId) {
             pacProgress = 0;
             updatePacmanRotation(pacCurrentNodeId, pacTargetNodeId);
          }
       }

       // Render interpolation on the projected Cartesian plane to exactly match straight map lines
       const cNodeFinal = engine.getNodes().get(pacCurrentNodeId)!;
       const tNodeFinal = engine.getNodes().get(pacTargetNodeId || pacCurrentNodeId)!;
       
       const p1 = map.project([cNodeFinal.lat, cNodeFinal.lon], map.getMaxZoom());
       const p2 = map.project([tNodeFinal.lat, tNodeFinal.lon], map.getMaxZoom());
       const pxX = p1.x + (p2.x - p1.x) * pacProgress;
       const pxY = p1.y + (p2.y - p1.y) * pacProgress;
       
       const pacLatLng = map.unproject([pxX, pxY], map.getMaxZoom());
       
       const pacEl = pacmanMarker.getElement();
       if (pacEl) pacEl.style.transition = 'none';

       pacmanMarker.setLatLng(pacLatLng);
       map.panInside(pacLatLng, { padding: [250, 250], animate: false });
    }
  }

  // Process Ghost Movements
  ghosts.forEach(ghost => {
     // Speed of ghosts: 15m/s
     const cNodeFinal = engine.getNodes().get(ghost.currentNodeId)!;
     const tNodeFinal = engine.getNodes().get(ghost.targetNodeId)!;
     const dist = map.distance([cNodeFinal.lat, cNodeFinal.lon], [tNodeFinal.lat, tNodeFinal.lon]);
     const durationMs = (dist / 15) * 1000;

     ghost.progress += dt / durationMs;

     if (ghost.progress >= 1) {
         ghost.progress -= 1; // Keep remainder for smooth overflow
         const prev = ghost.currentNodeId;
         ghost.currentNodeId = ghost.targetNodeId;
         ghost.prevNodeId = prev;
         
         const node = engine.getNodes().get(ghost.currentNodeId)!;
         let validNeighbors = node.neighbors;
         // Prevent backtracking if possible
         if (validNeighbors.length > 1 && ghost.prevNodeId) {
           validNeighbors = validNeighbors.filter(n => n !== ghost.prevNodeId);
         }
         ghost.targetNodeId = validNeighbors[Math.floor(Math.random() * validNeighbors.length)] || node.id;
     }

     const cNode = engine.getNodes().get(ghost.currentNodeId)!;
     const tNode = engine.getNodes().get(ghost.targetNodeId)!;
     
     const p1 = map.project([cNode.lat, cNode.lon], map.getMaxZoom());
     const p2 = map.project([tNode.lat, tNode.lon], map.getMaxZoom());
     const pxX = p1.x + (p2.x - p1.x) * ghost.progress;
     const pxY = p1.y + (p2.y - p1.y) * ghost.progress;
     
     const ghostLatLng = map.unproject([pxX, pxY], map.getMaxZoom());
     ghost.marker.setLatLng(ghostLatLng);
  });

  // 3. Check Real-Time Collisions
  if (isRespawning || isGameOver) return; 
  
  const pacPos = pacmanMarker.getLatLng();
  if (!pacPos) return;
  const pxPac = map.project(pacPos, map.getMaxZoom());

  ghosts.forEach((ghost) => {
     const ghostPos = ghost.marker.getLatLng();
     if (ghostPos) {
       const pxGhost = map.project(ghostPos, map.getMaxZoom());
       
       // Calculate true pixel distance on the maximum zoom mapped screen projection
       const distSq = Math.pow(pxPac.x - pxGhost.x, 2) + Math.pow(pxPac.y - pxGhost.y, 2);
       
       // 20 pixels overlap threshold. Let's use 20^2 = 400 pixels distance on max zoom (19).
       if (distSq < 420) { 
          if (engine.loseLife()) {
             showGameOver();
          } else {
             triggerRespawn();
          }
       }
     }
  });
}

function setupInput() {
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      activeKey = e.key as any;
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === activeKey) {
      activeKey = null;
    }
  });

  let touchStartX = 0;
  let touchStartY = 0;

  window.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  });

  window.addEventListener('touchmove', (e) => {
    const touchX = e.touches[0].clientX;
    const touchY = e.touches[0].clientY;
    const dx = touchX - touchStartX;
    const dy = touchY - touchStartY;
    
    if (Math.abs(dx) > 20 || Math.abs(dy) > 20) {
      if (Math.abs(dx) > Math.abs(dy)) {
        activeKey = dx > 0 ? 'ArrowRight' : 'ArrowLeft';
      } else {
        activeKey = dy > 0 ? 'ArrowDown' : 'ArrowUp';
      }
    }
  });

  window.addEventListener('touchend', () => {
    activeKey = null;
  });

  requestAnimationFrame(pacmanLoop);
}

// Initialize
getLocation();
