import L from 'leaflet';
import * as THREE from 'three';
import type { GameEngine } from '../game/engine';
import type { IRenderer } from './IRenderer';

export class Renderer3D implements IRenderer {
  private renderer?: THREE.WebGLRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private map?: L.Map;

  // State references
  private pacLatLng: L.LatLng | null = null;
  private ghosts: any[] = [];
  private rockets: any[] = [];
  private smokeTrail: THREE.Mesh[] = [];
  private sparks: any[] = [];
  private fireParticles: any[] = [];
  private currentTheme: 'street' | 'pacman' | 'satellite' = 'street';

  private engine: GameEngine;
  private baseLat = 0;
  private baseLon = 0;
  private isMapBuilt = false;

  // 3D Objects
  private pacMesh?: THREE.Group;
  private ghostGroup = new THREE.Group();
  private streetsGroup = new THREE.Group();
  private dotsGroup = new THREE.Group();
  private itemsGroup = new THREE.Group();
  private buildingsGroup = new THREE.Group();
  private treesGroup = new THREE.Group();
  private rocketsGroup = new THREE.Group();
  private particlesGroup = new THREE.Group();
  private homebaseGroup = new THREE.Group();
  private cloudsGroup = new THREE.Group();
  private sunMesh?: THREE.Mesh;

  private ghostMeshes = new Map<any, THREE.Mesh>();
  private rocketMeshes = new Map<any, THREE.Group>();

  // Particle geometries (instanced ideally, but using simple meshes for now)
  private sparkGeo = new THREE.BoxGeometry(2, 2, 2);
  private sparkMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
  private sparkMeshes: THREE.Mesh[] = [];

  private fireGeo = new THREE.BoxGeometry(4, 4, 4);
  private fireMat = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true });
  private fireMeshes: THREE.Mesh[] = [];

  private currentRotation = 0;
  private isRespawning = false;
  private dirLight?: THREE.DirectionalLight;
  // Cached jaw materials — never recreate per-frame
  private jawMatNormal = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.2, metalness: 0.5 });
  private jawMatPowerUp: THREE.MeshStandardMaterial | null = null;
  private jawPowerUpActive = false;

  // Camera orbital parameters
  private camAngle = 0;      // Horizontal rotation offset (mouse look)
  private camTilt = 55;      // Vertical tilt: 55° = schräg von oben (more oblique)
  private camDistance = 200; // Distance from target (closer for 3rd person view)

  // Interaction state
  private isPointerDown = false;
  private lastPointerPos = { x: 0, y: 0 };
  private camJoyX = 0;
  private camJoyY = 0;

  constructor(engine: GameEngine) {
    this.engine = engine;
  }

  public setStateReferences(state: {
    pacLatLng: L.LatLng | null;
    ghosts: any[];
    rockets: any[];
    sparks: any[];
    fireParticles: any[];
    currentTheme: 'street' | 'pacman' | 'satellite';
    streetEdges: any[];
    currentRotation?: number;
    isRespawning?: boolean;
    camJoyX?: number;
    camJoyY?: number;
  }): void {
    this.pacLatLng = state.pacLatLng;
    this.ghosts = state.ghosts;
    this.rockets = state.rockets;
    this.sparks = state.sparks;
    this.fireParticles = state.fireParticles;
    this.currentTheme = state.currentTheme;
    if (state.currentRotation !== undefined) {
      this.currentRotation = state.currentRotation;
    }
    if (state.isRespawning !== undefined) {
      this.isRespawning = state.isRespawning;
    }
    if (state.camJoyX !== undefined) this.camJoyX = state.camJoyX;
    if (state.camJoyY !== undefined) this.camJoyY = state.camJoyY;
  }

  public bindMap(map: L.Map, _canvas: HTMLCanvasElement, _ctx?: CanvasRenderingContext2D): void {
    this.map = map;
  }

  public onMapLoaded(): void {
    if (!this.map || !this.scene || !this.renderer) return;

    // Reset base origin for new city coordinate projection
    this.baseLat = 0;
    this.baseLon = 0;
    this.isMapBuilt = false;

    // Clear ghost and rocket state mapping
    this.ghostMeshes.clear();
    this.ghostGroup.clear();
    this.rocketMeshes.clear();
    this.rocketsGroup.clear();

    this.buildMap3D();
    this.buildItems3D();

    // After building the map, ensure the camera is looking at the right place
    if (this.pacLatLng && this.pacMesh && this.camera) {
      const pos = this.latLonToWorld(this.pacLatLng.lat, this.pacLatLng.lng);
      this.pacMesh.position.set(pos.x, 15, pos.z);
      this.camera.position.set(pos.x, pos.y + 800, pos.z + 800);
      this.camera.lookAt(pos.x, pos.y + 10, pos.z);
    }

    this.isMapBuilt = true;
  }

  public onGastronomyLoaded(): void {
     if (!this.isMapBuilt) return; // Map not yet built, we can wait for onMapLoaded
     this.buildItems3D();
  }

  public init(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.scene = new THREE.Scene();
    // Synthwave Sunset Atmosphere
    this.scene.background = new THREE.Color('#1a1b4b'); // Deep Indigo fallback
    this.scene.fog = new THREE.Fog('#ff5500', 300, 1800); // Bring fog closer for thick atmospheric haze

    this.camera = new THREE.PerspectiveCamera(45, w / h, 1, 10000);
    // Position for a tilted "isometric-like" perspective
    this.camera.position.set(0, 800, 800);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    // PCFSoft gives smoother, more realistic shadow edges
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    (this.renderer as any).outputColorSpace = THREE.SRGBColorSpace; // Better color accuracy

    // Canvas styling to overlay Leaflet map
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.top = '0';
    this.renderer.domElement.style.left = '0';
    this.renderer.domElement.style.zIndex = '600';
    this.renderer.domElement.style.pointerEvents = 'none';
    container.appendChild(this.renderer.domElement);

    // Lighting config - Balanced Sunset Hues (Lighter atmosphere)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.85); // Increased to make all shadows more transparent
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfff0dd, 0.9); // Slightly softer direct light
    dirLight.position.set(800, 1200, 400);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 4096;
    dirLight.shadow.mapSize.height = 4096;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = 3000;
    dirLight.shadow.bias = 0.001;   // positive bias pins shadow to surface, eliminates float
    dirLight.shadow.normalBias = 0.05;
    dirLight.shadow.radius = 1;     // Harder, crisp shadows for buildings and ground elements
    const ext = 600; // tighter frustum — follows Pac-Man so no need for map-wide coverage
    dirLight.shadow.camera.left = -ext;
    dirLight.shadow.camera.right = ext;
    dirLight.shadow.camera.top = ext;
    dirLight.shadow.camera.bottom = -ext;
    this.dirLight = dirLight;
    this.scene.add(dirLight);
    this.scene.add(dirLight.target); // target must be in scene for it to update

    // Gradient Sky Background (Large Sphere)
    const skyGeo = new THREE.SphereGeometry(4500, 32, 32);
    // Custom shader-like gradient for Sunset (Indigo -> Pink -> Orange)
    const vertexShader = `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
    const fragmentShader = `
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition).y;
        vec3 darkPurple = vec3(0.15, 0.0, 0.35); // Very dark purple
        vec3 pink = vec3(0.85, 0.0, 0.5);    // Pink
        vec3 orange = vec3(1.0, 0.5, 0.0);   // Orange
        
        // Transition very quickly from orange to pink near the horizon (0.0 to 0.08)
        vec3 color = mix(orange, pink, smoothstep(0.0, 0.08, h));
        
        // Transition from pink to dark purple relatively low in the sky (0.08 to 0.25)
        color = mix(color, darkPurple, smoothstep(0.08, 0.25, h));
        
        gl_FragColor = vec4(color, 1.0);
      }
    `;
    const skyMat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.BackSide
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(sky);

    // Crescent Moon (from the image)
    const moonShape = new THREE.Shape();
    moonShape.absarc(0, 0, 10, 0, Math.PI * 2, false);
    const holePath = new THREE.Path();
    holePath.absarc(4, 4, 10, 0, Math.PI * 2, false);
    moonShape.holes.push(holePath);

    const moonGeo = new THREE.ShapeGeometry(moonShape);
    const moonMat = new THREE.MeshBasicMaterial({ color: 0xffffcc, side: THREE.DoubleSide, fog: false });
    const moon = new THREE.Mesh(moonGeo, moonMat);
    moon.position.set(-1000, 2000, -3000); // High in the sky
    moon.scale.set(10, 10, 10);
    moon.rotation.z = Math.PI / 4;
    moon.lookAt(0, 800, 800); // Orient towards camera
    this.scene.add(moon);

    // Ground plane - use block/city colour so roads sit on top cleanly
    // Roads are at Y=0.0; ground at Y=-0.5 → half-unit gap, zero z-fighting possible
    const groundGeo = new THREE.PlaneGeometry(10000, 10000);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x677252, roughness: 0.95 }); // Grass green
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Subtle grid for orientation
    const grid = new THREE.GridHelper(5000, 50, 0xffffff, 0xffffff);
    grid.position.y = -0.4;
    (grid.material as THREE.LineBasicMaterial).opacity = 0.1;
    (grid.material as THREE.LineBasicMaterial).transparent = true;
    this.scene.add(grid);

    this.scene.add(this.streetsGroup);
    this.scene.add(this.dotsGroup);
    this.scene.add(this.ghostGroup);
    this.scene.add(this.itemsGroup);
    this.scene.add(this.buildingsGroup);
    this.scene.add(this.treesGroup);
    this.scene.add(this.rocketsGroup);
    this.scene.add(this.particlesGroup);
    this.scene.add(this.homebaseGroup);
    this.scene.add(this.cloudsGroup);

    // Fluffy clouds (max 3)
    const cloudGeo = new THREE.SphereGeometry(18, 32, 32);
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.15, // Make them a bit brighter
      roughness: 1.0,
      metalness: 0.0,
      transparent: true,
      opacity: 0.95, // Softer and more solid white
      fog: true // allows clouds to blend into the horizon blur
    });

    // Soft fake cloud shadow canvas (Blob Shadow)
    const cShadowCanvas = document.createElement('canvas');
    cShadowCanvas.width = 128;
    cShadowCanvas.height = 128;
    const cCtx = cShadowCanvas.getContext('2d')!;
    const cGrd = cCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
    cGrd.addColorStop(0, 'rgba(0, 0, 0, 0.45)');  // Highly transparent soft center
    cGrd.addColorStop(1, 'rgba(0, 0, 0, 0)');
    cCtx.fillStyle = cGrd;
    cCtx.fillRect(0, 0, 128, 128);
    
    const cloudShadowTex = new THREE.CanvasTexture(cShadowCanvas);
    const cloudShadowMat = new THREE.MeshBasicMaterial({
      map: cloudShadowTex,
      transparent: true,
      depthWrite: false,
      fog: true
    });
    // Extra large shadow plane for extreme softness
    const cloudShadowGeo = new THREE.PlaneGeometry(240, 240);

    for (let c = 0; c < 3; c++) {
      const cloud = new THREE.Group();
      
      // Make a fluffy shape out of 5-7 overlapping spheres
      const puffCount = 6 + Math.floor(Math.random() * 3);
      for (let p = 0; p < puffCount; p++) {
        const puff = new THREE.Mesh(cloudGeo, cloudMat);
        // Position puff randomly within a local cluster to form a nice cloud
        puff.position.set(
          (Math.random() - 0.5) * 40,
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 25
        );
        // Random scale for variety (flatter but wider puffs)
        const scaleX = 0.8 + Math.random() * 0.5;
        const scaleY = 0.6 + Math.random() * 0.4;
        const scaleZ = 0.8 + Math.random() * 0.5;
        puff.scale.set(scaleX, scaleY, scaleZ);
        
        // Disable global shadow for clouds to allow sharp building shadows
        puff.castShadow = false;
        puff.receiveShadow = false;
        cloud.add(puff);
      }

      // Initial positioning over the map space, clearly separated into 3 corners
      const angle = c * ((Math.PI * 2) / 3) + (Math.random() - 0.5) * 0.5; // Spread around perfectly in 3 corners
      const radius = 180 + Math.random() * 80; // ~260 max distance from center
      
      cloud.position.set(
        Math.cos(angle) * radius,
        180 + Math.random() * 40, 
        Math.sin(angle) * radius
      );
      
      // Add fake soft shadow directly to cloudsGroup so it moves with the overall system
      const shadow = new THREE.Mesh(cloudShadowGeo, cloudShadowMat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(cloud.position.x, 0.5, cloud.position.z);
      this.cloudsGroup.add(shadow);
      
      // Set some userData for animation
      cloud.userData = {
        speedX: 0,
        speedZ: 0,
        targetY: cloud.position.y,
        bobPhase: Math.random() * Math.PI * 2,
        shadowMesh: shadow
      };

      this.cloudsGroup.add(cloud);
    }

    // Sunset Horizon
    const sunCanvas = document.createElement('canvas');
    sunCanvas.width = 1024;
    sunCanvas.height = 1024;
    const sCtx = sunCanvas.getContext('2d')!;
    sCtx.translate(512, 512);

    // Glow
    const grd = sCtx.createRadialGradient(0, 0, 50, 0, 0, 350);
    grd.addColorStop(0, 'rgba(255, 230, 150, 1)');
    grd.addColorStop(0.2, 'rgba(255, 120, 0, 1)');
    grd.addColorStop(0.6, 'rgba(200, 40, 0, 0.8)');
    grd.addColorStop(1, 'rgba(200, 40, 0, 0)');

    sCtx.fillStyle = grd;
    sCtx.beginPath();
    sCtx.arc(0, 0, 350, Math.PI, Math.PI * 2);
    sCtx.fill();

    // Rays
    for(let i=0; i<14; i++) {
      sCtx.save();
      sCtx.rotate(Math.PI + (i + 0.5) * (Math.PI / 14));
      
      const rayGrd = sCtx.createLinearGradient(120, 0, 500, 0);
      rayGrd.addColorStop(0, 'rgba(255, 100, 0, 0.6)');
      rayGrd.addColorStop(1, 'rgba(255, 50, 0, 0)');
      sCtx.fillStyle = rayGrd;
      
      sCtx.beginPath();
      sCtx.moveTo(120, -10);
      sCtx.lineTo(120, 10);
      sCtx.lineTo(500, 40);
      sCtx.lineTo(500, -40);
      sCtx.fill();
      sCtx.restore();
    }

    const sunTex = new THREE.CanvasTexture(sunCanvas);
    const sunMat = new THREE.MeshBasicMaterial({ 
      map: sunTex, 
      transparent: true, 
      side: THREE.FrontSide, 
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false // Keep sun bright and crisp against the fog
    });
    
    // Plane size. Center of plane is Y=0, canvas top half matches Plane Y>0.
    const sunGeo = new THREE.PlaneGeometry(800, 800);
    this.sunMesh = new THREE.Mesh(sunGeo, sunMat);
    this.scene.add(this.sunMesh);

    this.setupCameraControls(container);

    // Pacman mesh (Mechanical Look)
    this.pacMesh = new THREE.Group();

    // Dedicated yellow material for the mouth interior (palate + jaw floor + inner hood).
    // Kept separate from sphereMat so the body color can change independently.
    const mouthInteriorMat = new THREE.MeshStandardMaterial({
      color: 0xffd22f,   // Pac-Man yellow
      roughness: 0.3,
      metalness: 0.1,
    });

    const jawMat = new THREE.MeshStandardMaterial({
      color: 0x6677aa,
      roughness: 0.2,
      metalness: 0.5,
    });

    // Upper Jaw
    const upperGroup = new THREE.Group();
    upperGroup.name = 'upperMouth';
    const upperGeo = new THREE.SphereGeometry(12, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2);
    const upperMesh = new THREE.Mesh(upperGeo, jawMat);
    upperMesh.castShadow = true;
    upperMesh.receiveShadow = true;
    upperGroup.add(upperMesh);

    // Hood accent (smaller semi-sphere inside → yellow interior)
    const hoodGeo = new THREE.SphereGeometry(11, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2);
    const hoodMesh = new THREE.Mesh(hoodGeo, mouthInteriorMat);
    hoodMesh.scale.set(0.9, 0.9, 0.9);
    hoodMesh.castShadow = true;
    hoodMesh.receiveShadow = true;
    upperGroup.add(hoodMesh);

    // Gaumen (palate) – yellow disc closing the flat opening of the upper jaw.
    // The SphereGeometry is open at y=0 (equatorial cut), so we cap it with a circle.
    // rotation.x = +PI/2 makes the disc face downward (into the mouth).
    const palateGeo = new THREE.CircleGeometry(11.8, 48);
    const palateMesh = new THREE.Mesh(palateGeo, mouthInteriorMat); // yellow interior
    palateMesh.rotation.x = Math.PI / 2; // face downward
    palateMesh.position.y = 0;
    upperGroup.add(palateMesh);

    // Upper Teeth
    const teethCount = 7;
    const teethGeo = new THREE.ConeGeometry(1.5, 4, 4);
    const teethMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < teethCount; i++) {
      const tooth = new THREE.Mesh(teethGeo, teethMat);
      const angle = (i / (teethCount - 1)) * Math.PI - Math.PI / 2;
      tooth.position.set(11.5 * Math.cos(angle), -1.5, 11.5 * Math.sin(angle));
      tooth.rotation.x = Math.PI;
      tooth.castShadow = true;
      upperGroup.add(tooth);
    }
    this.pacMesh.add(upperGroup);

    // Lower Jaw
    const lowerGroup = new THREE.Group();
    lowerGroup.name = 'lowerMouth';
    const lowerGeo = new THREE.SphereGeometry(12, 32, 32, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    const lowerMesh = new THREE.Mesh(lowerGeo, jawMat);
    lowerMesh.castShadow = true;
    lowerMesh.receiveShadow = true;
    lowerGroup.add(lowerMesh);

    // Unterkieferfläche – yellow disc closing the flat opening of the lower jaw.
    // rotation.x = -PI/2 makes the disc face upward (toward the palate).
    const jawFloorGeo = new THREE.CircleGeometry(11.8, 48);
    const jawFloorMesh = new THREE.Mesh(jawFloorGeo, mouthInteriorMat); // yellow interior
    jawFloorMesh.rotation.x = -Math.PI / 2; // face upward
    jawFloorMesh.position.y = 0;
    lowerGroup.add(jawFloorMesh);

    // Lower Teeth
    for (let i = 0; i < teethCount; i++) {
      const tooth = new THREE.Mesh(teethGeo, teethMat);
      const angle = (i / (teethCount - 1)) * Math.PI - Math.PI / 2;
      tooth.position.set(11.5 * Math.cos(angle), 1.5, 11.5 * Math.sin(angle));
      tooth.castShadow = true;
      lowerGroup.add(tooth);
    }
    this.pacMesh.add(lowerGroup);

    // ── EYES: Two glowing yellow X-shaped eyes on the sides of the head ──────
    // Placed higher up and further back ("oberhalb und hinter dem kiefer an der seite").
    // Sphere radius is 12. Point (2.0, 9.0, ±7.7) lies on the surface.
    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0xffde00,
      emissive: 0xffde00,
      emissiveIntensity: 0.8
    });
    // Each arm is formed flat in the XY plane. thin in Z (depth).
    const armGeo = new THREE.BoxGeometry(4.0, 0.8, 0.4);

    const eyeOffsets = [
      new THREE.Vector3(2.0, 9.0, 7.7),   // Left side
      new THREE.Vector3(2.0, 9.0, -7.7),  // Right side
    ];

    eyeOffsets.forEach((pos, idx) => {
      const eg = new THREE.Group();
      eg.name = idx === 0 ? 'eyeLeft' : 'eyeRight';
      eg.position.copy(pos);

      // Align the group so it points straight outward from the center (normal).
      // The arms (geometry in XY plane) will lay flat against the sphere's surface.
      eg.lookAt(pos.clone().multiplyScalar(2));

      // Cross arms at 45 degree angles to form an X.
      const arm1 = new THREE.Mesh(armGeo, eyeMat);
      arm1.rotation.z = Math.PI / 4;  // +45° 
      const arm2 = new THREE.Mesh(armGeo, eyeMat);
      arm2.rotation.z = -Math.PI / 4;  // -45° 

      eg.add(arm1, arm2);
      if (this.pacMesh) this.pacMesh.add(eg);
    });


    this.scene.add(this.pacMesh);

    console.log("Renderer3D initialized.");
  }

  private latLonToWorld(lat: number, lon: number): THREE.Vector3 {
    if (isNaN(lat) || isNaN(lon)) return new THREE.Vector3(0, 0, 0);

    if (this.baseLat === 0) {
      this.baseLat = lat;
      this.baseLon = lon;
    }
    const R = 6378137;
    const radLat = Math.PI / 180 * this.baseLat;
    const x = R * (lon - this.baseLon) * (Math.PI / 180) * Math.cos(radLat);
    const z = R * -(lat - this.baseLat) * (Math.PI / 180);
    return new THREE.Vector3(x, 0, z);
  }

  private setupCameraControls(container: HTMLElement) {
    container.addEventListener('mousedown', (e) => {
      this.isPointerDown = true;
      this.lastPointerPos = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isPointerDown) return;
      const dx = e.clientX - this.lastPointerPos.x;
      const dy = e.clientY - this.lastPointerPos.y;

      this.camAngle -= dx * 0.01;
      this.camTilt = Math.min(85, Math.max(10, this.camTilt + dy * 0.5));

      this.lastPointerPos = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', () => {
      this.isPointerDown = false;
    });

    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camDistance = Math.min(1500, Math.max(50, this.camDistance + e.deltaY * 0.5));
    }, { passive: false });

    // Simple touch support
    container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.isPointerDown = true;
        this.lastPointerPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    });

    container.addEventListener('touchmove', (e) => {
      if (!this.isPointerDown || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - this.lastPointerPos.x;
      const dy = e.touches[0].clientY - this.lastPointerPos.y;

      this.camAngle -= dx * 0.01;
      this.camTilt = Math.min(85, Math.max(10, this.camTilt + dy * 0.5));

      this.lastPointerPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: false });

    container.addEventListener('touchend', () => {
      this.isPointerDown = false;
    });
  }

  private buildMap3D() {
    this.streetsGroup.clear();
    this.dotsGroup.clear();
    const nodes = this.engine.getNodes();
    if (nodes.size === 0) return;

    // Set base origin to first node found
    const firstNode = nodes.values().next().value;
    if (firstNode && this.baseLat === 0) {
      this.baseLat = firstNode.lat;
      this.baseLon = firstNode.lon;
    }

    // Colors and Materials - road only; ground plane provides block-plot colour below
    const roadColor = 0xa8a8a8; // Clear medium gray road

    // polygonOffset pulls road slightly toward camera at intersections
    // where two crossing road planes share the same Y=0.0, preventing z-fighting
    const roadMat = new THREE.MeshStandardMaterial({
      color: roadColor,
      roughness: 0.8,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    const roadWidth = 14;  // narrower streets to cleanly separate parallel edges
    const Y_ROAD = 0.0;

    // Dash marking material
    const dashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      // polygonOffset pulling to front just in case, but physical Y lift will do most of the work
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      depthWrite: false
    });
    const dashGeo_len = 7;
    const dashGeo = new THREE.PlaneGeometry(dashGeo_len, 1.2);
    // 1. Raw Node Positions mapped to 3D Space
    const visualPositions = new Map<string, THREE.Vector3>();

    nodes.forEach(node => {
      const raw = this.latLonToWorld(node.lat, node.lon);
      visualPositions.set(node.id, raw);
    });

    // Collect all snapped node positions for building exclusion check
    const roadNodePositions: THREE.Vector3[] = [];
    visualPositions.forEach(v => roadNodePositions.push(v));
    (this as any)._roadNodePositions = roadNodePositions;
    (this as any)._roadWidth = roadWidth;
    (this as any)._visualPositions = visualPositions; // needed for road-aligned building placement

    const drawnEdges = new Set<string>();
    const drawnIntersections = new Set<string>();
    const circleGeo = new THREE.CircleGeometry(roadWidth * 0.5, 32);
    const renderedDashes: Array<{midX: number, midZ: number, dirX: number, dirZ: number}> = [];

    nodes.forEach(node => {
      const p1 = visualPositions.get(node.id)!;

      // ── ROUNDED CAP
      const iKey = `${p1.x},${p1.z}`;
      if (!drawnIntersections.has(iKey)) {
        drawnIntersections.add(iKey);
        // Deterministic microscropic Y-offset to perfectly prevent Z-fighting with overlapping parallel nodes
        const yOffset = ((Math.abs(p1.x + p1.z) * 1000) % 10) * 0.001; 
        const cap = new THREE.Mesh(circleGeo, roadMat);
        cap.rotation.x = -Math.PI / 2;
        cap.position.set(p1.x, Y_ROAD + yOffset, p1.z);
        cap.receiveShadow = true;
        cap.castShadow = false; // Prevent shadow rings from the tiny hover
        this.streetsGroup.add(cap);
      }

      node.neighbors.forEach(nId => {
        const target = nodes.get(nId);
        if (!target) return;

        const edgeId = [node.id, nId].sort().join('-');
        if (drawnEdges.has(edgeId)) return;
        drawnEdges.add(edgeId);

        const p2 = visualPositions.get(nId)!;
        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < 0.1) return;

        const angle = Math.atan2(dz, dx);
        const midX = (p1.x + p2.x) / 2;
        const midZ = (p1.z + p2.z) / 2;
        
        // Microscopic deterministic offset to smoothly stack identical overlapping roads without flickering or hashing
        const yOffset = ((Math.abs(midX + midZ) * 1000) % 10) * 0.002; 

        // ── ROAD SEGMENT 
        const road = new THREE.Mesh(new THREE.PlaneGeometry(dist, roadWidth), roadMat);
        road.rotation.x = -Math.PI / 2;
        road.rotation.z = -angle;
        road.position.set(midX, Y_ROAD + yOffset, midZ);
        road.receiveShadow = true;
        road.castShadow = false;
        this.streetsGroup.add(road);

        // ── DASHED MARKING 
        const dirX = dx / dist;
        const dirZ = dz / dist;

        // Skip drawing dashes if another identical or very parallel dashed line already exists 
        let skipDashes = false;
        for (const d of renderedDashes) {
          const distSq = (midX - d.midX) ** 2 + (midZ - d.midZ) ** 2;
          if (distSq < 150) { // approx 12 units
            const dot = Math.abs(dirX * d.dirX + dirZ * d.dirZ);
            if (dot > 0.85) {
              skipDashes = true;
              break;
            }
          }
        }

        const c1 = (node.neighbors.length === 2) ? 0 : 13;
        const c2 = (target.neighbors.length === 2) ? 0 : 13;
        
        const markDist = dist - c1 - c2;
        if (markDist > 0 && !skipDashes) {
          renderedDashes.push({ midX, midZ, dirX, dirZ });
          
          let basisX = dirX;
          let basisZ = dirZ;
          if (basisX < 0 || (basisX === 0 && basisZ < 0)) {
            basisX = -basisX;
            basisZ = -basisZ;
          }
          
          const cycleDist = dashGeo_len + 14;
          const phase_p1 = p1.x * basisX + p1.z * basisZ;
          const phaseRate = dirX * basisX + dirZ * basisZ;
          
          const t_start = c1;
          const t_end = dist - c2;
          
          let min_val, max_val;
          if (phaseRate > 0) {
            min_val = phase_p1 + t_start;
            max_val = phase_p1 + t_end;
          } else {
            min_val = phase_p1 - t_end;
            max_val = phase_p1 - t_start;
          }
          
          const min_N = Math.ceil(min_val / cycleDist);
          const max_N = Math.floor(max_val / cycleDist);
          
          for (let N = min_N; N <= max_N; N++) {
            const phase_target = N * cycleDist;
            const t = (phase_target - phase_p1) / phaseRate;
            
            const dX = p1.x + dirX * t;
            const dZ = p1.z + dirZ * t;
            
            const markMesh = new THREE.Mesh(dashGeo, dashMat);
            markMesh.rotation.x = -Math.PI / 2;
            markMesh.rotation.z = -angle;
            markMesh.position.set(dX, Y_ROAD + 0.1 + yOffset, dZ);
            this.streetsGroup.add(markMesh);
          }
        }
      });
    });

    // 5. Dots - 3D Numbers (0 and 1) with black contours
    this.dotsGroup.clear();
    const dots = this.engine.getDots();

    // Perfectly round 0 (Ellipse)
    const shape0 = new THREE.Shape();
    shape0.absellipse(0, 0, 1.2, 1.8, 0, Math.PI * 2, false, 0);
    const hole0 = new THREE.Path();
    hole0.absellipse(0, 0, 0.4, 1.0, 0, Math.PI * 2, true, 0);
    shape0.holes.push(hole0);

    const geo0 = new THREE.ExtrudeGeometry(shape0, { depth: 0.8, bevelEnabled: false, curveSegments: 24 });
    geo0.translate(0, 0, -0.4);
    const edges0 = new THREE.EdgesGeometry(geo0, 40); // 40 degrees threshold for smooth edge hiding

    // Sleeker 1
    const shape1 = new THREE.Shape();
    shape1.moveTo(-0.2, -1.8);
    shape1.lineTo(0.4, -1.8);
    shape1.lineTo(0.4, 1.8);
    shape1.lineTo(-0.2, 1.8);
    shape1.lineTo(-1.0, 1.0);
    shape1.lineTo(-0.5, 0.6);
    shape1.lineTo(-0.2, 0.9);
    shape1.lineTo(-0.2, -1.8);

    const geo1 = new THREE.ExtrudeGeometry(shape1, { depth: 0.8, bevelEnabled: false });
    geo1.translate(0, 0, -0.4);
    const edges1 = new THREE.EdgesGeometry(geo1, 40);

    const dotMatFront = new THREE.MeshStandardMaterial({ color: 0xffe600, emissive: 0xa89000, emissiveIntensity: 0.4 });
    const dotMatSide = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.8 });
    const outlineMat = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 });

    // ExtrudeGeometry applies index 0 to front/back, and index 1 to the extruded sides
    const dotMats = [dotMatFront, dotMatSide];

    const group0 = new THREE.Group();
    group0.add(new THREE.Mesh(geo0, dotMats));
    group0.add(new THREE.LineSegments(edges0, outlineMat));
    group0.scale.set(1.4, 1.4, 1.4);

    const group1 = new THREE.Group();
    group1.add(new THREE.Mesh(geo1, dotMats));
    group1.add(new THREE.LineSegments(edges1, outlineMat));
    group1.scale.set(1.4, 1.4, 1.4);

    let count = 0;
    const placedPositions: THREE.Vector3[] = [];
    const minDotDistSq = 25 * 25; // Minimum 25 units distance between dots

    dots.forEach(dot => {
      if (!dot) return;
      const pos = visualPositions.get(dot.id) || this.latLonToWorld(dot.lat, dot.lon);

      // Enforce a strict minimum distance so they don't look overcrowded
      let tooClose = false;
      for (let k = 0; k < placedPositions.length; k++) {
        const dx = pos.x - placedPositions[k].x;
        const dz = pos.z - placedPositions[k].z;
        if (dx * dx + dz * dz < minDotDistSq) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) return;
      placedPositions.push(pos);

      const isZero = (count % 2 === 0);
      count++;

      const instance = isZero ? group0.clone() : group1.clone();
      instance.position.set(pos.x, 5.5, pos.z);
      // Give each a unique rotation offset based on count so they spin beautifully
      instance.userData = { id: dot.id, hash: count };
      this.dotsGroup.add(instance);
    });

    this.buildBuildings3D();
    this.buildTrees3D();
    this.buildHomebase3D();
    this.buildItems3D();

    this.isMapBuilt = true;
  }

  private buildHomebase3D() {
    this.homebaseGroup.clear();
    const homeNodeId = this.engine.getInitialPacmanNodeId();
    if (!homeNodeId) return;
    const node = this.engine.getNodes().get(homeNodeId);
    if (!node) return;

    const pos = this.latLonToWorld(node.lat, node.lon);

    // Create a tall cylinder for the glowing pillar
    const radius = 22; // roughly pacman size
    const height = 2000; // reaching high into the sky
    const geometry = new THREE.CylinderGeometry(radius, radius, height, 32, 1, true);

    // Custom Shader setup for edge-fading (Fresnel/Glow effect)
    const vertexShader = `
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewPosition = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      uniform vec3 color;
      uniform float baseOpacity;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        
        // Calculate the dot product between normal and view direction.
        // It's 1.0 when facing the camera, 0.0 at the edges.
        float intensity = max(dot(normal, viewDir), 0.0);
        
        // We want it to be opaque in the center, transparent at the edges.
        // By raising it to a power, we control how sharp the falloff is.
        float alpha = pow(intensity, 2.5) * baseOpacity;
        
        gl_FragColor = vec4(color, alpha);
      }
    `;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(0xff00ff) },
        baseOpacity: { value: 0.25 } // Higher base because edges will fade
      },
      vertexShader: vertexShader,
      fragmentShader: fragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide, // FrontSide is usually better for custom dot-product fresnel
      depthWrite: false
    });

    const pillar = new THREE.Mesh(geometry, material);
    pillar.position.set(pos.x, height / 2, pos.z);
    pillar.name = 'pillar';

    // Replace inner blue core with flag and mast
    const mastHeight = 55;
    const mastRadius = 1.2;
    const mastGeo = new THREE.CylinderGeometry(mastRadius, mastRadius, mastHeight, 16);
    const mastMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.3 });
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(pos.x, mastHeight / 2, pos.z);
    mast.castShadow = true;
    mast.receiveShadow = true;
    mast.name = 'mast';

    // Create flag texture
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 340;
    const ctx = canvas.getContext('2d')!;
    
    // Black background
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, 512, 340);
    
    // Add yellow border
    ctx.strokeStyle = '#ffe600';
    ctx.lineWidth = 15;
    ctx.strokeRect(10, 10, 492, 320);

    // Yellow Text
    ctx.fillStyle = '#ffe600';
    ctx.font = 'bold 80px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('vibe-man', 256, 170);

    const flagTex = new THREE.CanvasTexture(canvas);
    flagTex.anisotropy = 4;
    flagTex.colorSpace = THREE.SRGBColorSpace;

    const flagWidth = 26;
    const flagHeight = 16;
    const flagGeo = new THREE.PlaneGeometry(flagWidth, flagHeight, 15, 5);
    const flagMat = new THREE.MeshStandardMaterial({
      map: flagTex,
      side: THREE.DoubleSide,
      roughness: 0.4,
      metalness: 0.1
    });
    const flag = new THREE.Mesh(flagGeo, flagMat);
    
    // Position flag so its left edge is attached to the mast
    flag.position.set(pos.x + flagWidth / 2 + mastRadius, mastHeight - flagHeight / 2 - 2, pos.z);
    flag.castShadow = true;
    flag.receiveShadow = true;
    flag.name = 'flag';

    // Save initial vertices for animation
    const posAttribute = flag.geometry.attributes.position;
    const userDataPos = [];
    for (let i = 0; i < posAttribute.count; i++) {
      userDataPos.push(new THREE.Vector3().fromBufferAttribute(posAttribute, i));
    }
    flag.userData.initialPositions = userDataPos;
    flag.userData.flagWidth = flagWidth;

    this.homebaseGroup.add(pillar);
    this.homebaseGroup.add(mast);
    this.homebaseGroup.add(flag);

    // Center the clouds above the homebase
    this.cloudsGroup.position.set(pos.x, 0, pos.z);
  }

  private buildBuildings3D() {
    this.buildingsGroup.clear();
    // Buildings are now generated procedurally along roads (not from OSM building data)

    // Stadtvillen color palette — classic European city house colors
    const wallColors = [0xe8d5b0, 0xf0e0a0, 0xd4b896, 0xc9a87c, 0xe2c9a0, 0xdfc080, 0xcbb99a];
    const roofColors = [0x8b3a2a, 0xa0452d, 0x7a3525, 0xb55040, 0x6b3530];

    const roadWidth: number = (this as any)._roadWidth ?? 22;
    const visualPositions: Map<string, THREE.Vector3> = (this as any)._visualPositions;
    if (!visualPositions) return;

    const nodes = this.engine.getNodes();
    const drawnEdges = new Set<string>();

    // Spacing along road: each "slot" is ~30 units, buildings fill ~22 units of that
    const SLOT = 30;   // slot length along road
    const BUILD_W = 22;   // building width along road
    const BUILD_D = 16;   // building depth (into the block)
    const SETBACK = 2;    // gap between road edge and building face
    const FACE_DIST = roadWidth / 2 + SETBACK + BUILD_D / 2; // road center → building center

    const distToSegmentSq = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
      const l2 = (ax - bx) ** 2 + (az - bz) ** 2;
      if (l2 === 0) return (px - ax) ** 2 + (pz - az) ** 2;
      let t = ((px - ax) * (bx - ax) + (pz - az) * (bz - az)) / l2;
      t = Math.max(0, Math.min(1, t));
      return (px - (ax + t * (bx - ax))) ** 2 + (pz - (az + t * (bz - az))) ** 2;
    };

    const segments: Array<{ax: number, az: number, bx: number, bz: number}> = [];
    nodes.forEach(node => {
      node.neighbors.forEach(nId => {
        const edgeId = [node.id, nId].sort().join('-');
        if (!drawnEdges.has(edgeId)) {
          drawnEdges.add(edgeId);
          const p1 = visualPositions.get(node.id);
          const p2 = visualPositions.get(nId);
          if (p1 && p2) segments.push({ ax: p1.x, az: p1.z, bx: p2.x, bz: p2.z });
        }
      });
    });

    drawnEdges.clear();
    const safeDistSq = (FACE_DIST - 1.5) ** 2;

    nodes.forEach(node => {
      node.neighbors.forEach(nId => {
        const edgeId = [node.id, nId].sort().join('-');
        if (drawnEdges.has(edgeId)) return;
        drawnEdges.add(edgeId);

        const p1 = visualPositions.get(node.id);
        const p2 = visualPositions.get(nId);
        if (!p1 || !p2) return;

        const dx = p2.x - p1.x, dz = p2.z - p1.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < SLOT * 2) return; // too short for any buildings

        const angle = Math.atan2(dz, dx);
        const ux = dx / dist, uz = dz / dist;       // unit along road
        const px = -uz, pz = ux;             // unit perpendicular (left side)

        // Number of building slots that fit between the intersection clearances
        const usable = dist - SLOT; // leave one slot gap at each end
        const numSlots = Math.floor(usable / SLOT);
        if (numSlots < 1) return;

        for (let s = 0; s < numSlots; s++) {
          // Center of slot along the road segment
          const t = SLOT / 2 + s * SLOT + (usable - numSlots * SLOT) / 2 + SLOT / 2;
          const cx = p1.x + ux * t;
          const cz = p1.z + uz * t;

          for (const side of [1, -1]) {
            const bx = cx + px * FACE_DIST * side;
            const bz = cz + pz * FACE_DIST * side;

            let overlap = false;
            for (const seg of segments) {
              if (distToSegmentSq(bx, bz, seg.ax, seg.az, seg.bx, seg.bz) < safeDistSq) {
                overlap = true;
                break;
              }
            }
            if (overlap) continue;

            const bHeight = 14 + Math.random() * 8; // 14–22 units (Stadtvillen: 3-4 floors)

            // ── BODY ─────────────────────────────────────────────────────────
            const wallColor = wallColors[Math.floor(Math.random() * wallColors.length)];
            const bodyGeo = new THREE.BoxGeometry(BUILD_W, bHeight, BUILD_D);
            const bodyMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.75, metalness: 0.05 });
            const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
            bodyMesh.rotation.y = angle;
            bodyMesh.position.set(bx, bHeight / 2 - 0.5, bz);
            bodyMesh.castShadow = true;
            bodyMesh.receiveShadow = true;
            this.buildingsGroup.add(bodyMesh);

            // ── FLAT ROOF (parapet edge slightly wider than walls) ────────
            const roofColor = roofColors[Math.floor(Math.random() * roofColors.length)];
            const roofMat = new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.9 });
            const roofGeo = new THREE.BoxGeometry(BUILD_W + 1.5, 1.2, BUILD_D + 1.5);
            const roofMesh = new THREE.Mesh(roofGeo, roofMat);
            roofMesh.rotation.y = angle;
            roofMesh.position.set(bx, bHeight - 0.5 + 0.6, bz);
            roofMesh.castShadow = true;
            this.buildingsGroup.add(roofMesh);
          }
        }
      });
    });
  }

  private buildTrees3D() {
    this.treesGroup.clear();
    const trees = this.engine.getTrees();

    const trunkGeo = new THREE.CylinderGeometry(2, 3, 15, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5d4037 });

    // Satteres Grün für Low-Poly Bäume
    const foliageGeo = new THREE.ConeGeometry(12, 25, 6);
    const foliageMat = new THREE.MeshStandardMaterial({ color: 0x4caf50, roughness: 0.6 });

    trees.forEach(tree => {
      const group = new THREE.Group();
      const p = this.latLonToWorld(tree.lat, tree.lon);

      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.y = 7.5;
      trunk.castShadow = true;

      const foliage = new THREE.Mesh(foliageGeo, foliageMat);
      foliage.position.y = 22;
      foliage.castShadow = true;

      const foliage2 = new THREE.Mesh(new THREE.ConeGeometry(10, 20, 6), foliageMat);
      foliage2.position.y = 30;
      foliage2.castShadow = true;

      group.add(trunk);
      group.add(foliage);
      group.add(foliage2);
      group.position.copy(p);
      this.treesGroup.add(group);
    });
  }

  private buildItems3D() {
    this.itemsGroup.clear();

    const createCoinTex = (text: string, color: string, isEmoji: boolean) => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d')!;
      
      ctx.fillStyle = '#050505'; // nearly black so background doesn't glow too bright
      ctx.beginPath();
      ctx.arc(64, 64, 60, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.strokeStyle = color;
      ctx.lineWidth = 8;
      ctx.stroke();
      
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (isEmoji) {
         ctx.font = '60px serif';
         ctx.fillText(text, 64, 64);
      } else {
         ctx.font = 'bold 50px monospace';
         ctx.fillStyle = color;
         ctx.fillText(text, 64, 64);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = 4;
      return tex;
    };

    if (!(this as any)._powerTex) {
      (this as any)._powerTex = createCoinTex('</>', '#00ffcc', false);
      (this as any)._rocketTex = createCoinTex('🚀', '#ff3300', true);
      (this as any)._gastroCaches = {};
    }

    const coinGeo = new THREE.CylinderGeometry(8, 8, 2, 32);
    const pMatSide = new THREE.MeshStandardMaterial({ color: 0x00ffcc, roughness: 0.4, metalness: 0.8 });
    const pMatFace = new THREE.MeshStandardMaterial({ 
      map: (this as any)._powerTex, 
      emissiveMap: (this as any)._powerTex, 
      emissive: 0xffffff, 
      emissiveIntensity: 2.0, 
      roughness: 0.3 
    });
    const pMats = [pMatSide, pMatFace, pMatFace]; // 0: side, 1: top, 2: bottom

    const rMatSide = new THREE.MeshStandardMaterial({ color: 0xff3300, roughness: 0.4, metalness: 0.8 });
    const rMatFace = new THREE.MeshStandardMaterial({ 
      map: (this as any)._rocketTex, 
      emissiveMap: (this as any)._rocketTex, 
      emissive: 0xffffff, 
      emissiveIntensity: 2.0, 
      roughness: 0.3 
    });
    const rMats = [rMatSide, rMatFace, rMatFace];

    this.engine.getPowerItems().forEach(item => {
      if (!item) return;
      const pos = this.latLonToWorld(item.lat, item.lon);
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(coinGeo, pMats);
      mesh.rotation.x = Math.PI / 2; // Stand coin upright
      mesh.castShadow = true;
      group.add(mesh);
      group.position.copy(pos);
      group.userData = { 
        type: 'power', 
        id: item.id, 
        baseY: 10,
        animOffset: Math.random() * Math.PI * 2
      };
      this.itemsGroup.add(group);
    });

    this.engine.getRocketItems().forEach(item => {
      if (!item) return;
      const pos = this.latLonToWorld(item.lat, item.lon);
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(coinGeo, rMats);
      mesh.rotation.x = Math.PI / 2;
      mesh.castShadow = true;
      group.add(mesh);
      group.position.copy(pos);
      group.userData = { 
        type: 'rocket', 
        id: item.id, 
        baseY: 10,
        animOffset: Math.random() * Math.PI * 2
      };
      this.itemsGroup.add(group);
    });

    const getGastroMat = (type: string) => {
      const caches = (this as any)._gastroCaches;
      if (caches[type]) return caches[type];

      let icon = '🍽️';
      if (type === 'burger') icon = '🍔';
      else if (type === 'pizza') icon = '🍕';
      else if (type === 'cafe') icon = '☕';
      else if (type === 'kiosk') icon = '🏪';
      else if (type === 'doner') icon = '🥙';
      else if (type === 'asia') icon = '🍜';
      else if (type === 'restaurant') icon = '🍝';

      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d')!;
      
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(8, 8, 112, 112);
      ctx.strokeStyle = '#ff9900';
      ctx.lineWidth = 12;
      ctx.strokeRect(8, 8, 112, 112);
      
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '60px serif';
      ctx.fillText(icon, 64, 68);
      
      const tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = 4;
      const faceMat = new THREE.MeshStandardMaterial({
        map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 1.0, roughness: 0.3
      });
      caches[type] = faceMat;
      return faceMat;
    };

    const gastroGeo = new THREE.BoxGeometry(10, 10, 2);
    const gastroSide = new THREE.MeshStandardMaterial({ color: 0xff9900, roughness: 0.4, metalness: 0.8 });
    
    // Doner spit geometries
    const donerStickGeo = new THREE.CylinderGeometry(0.5, 0.5, 24, 8);
    // Adding vertical segments (12) so we can bend the geometry
    const donerMeatGeo = new THREE.CylinderGeometry(4.5, 3.0, 16, 16, 12);
    
    // Deform meat geometry to make it look chunky and irregular
    const posAttribute = donerMeatGeo.attributes.position;
    for (let i = 0; i < posAttribute.count; i++) {
        const y = posAttribute.getY(i);
        const x = posAttribute.getX(i);
        const z = posAttribute.getZ(i);
        // exclude top/bottom center vertices
        if (x !== 0 || z !== 0) {
            const angle = Math.atan2(z, x);
            // Noise based on angle and height
            const noise = Math.sin(angle * 4 + y * 1.5) * 0.4 + Math.cos(angle * 2 - y * 3) * 0.4;
            posAttribute.setX(i, x + Math.cos(angle) * noise);
            posAttribute.setZ(i, z + Math.sin(angle) * noise);
        }
    }
    donerMeatGeo.computeVertexNormals();

    const donerStickMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.2 });
    
    // Dynamic cartoon texture generator for meat
    const getDonerMeatMat = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d')!;

      // Background color: reddish-brown meat base
      ctx.fillStyle = '#a65646';
      ctx.fillRect(0, 0, 256, 256);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Draw horizontal wavy lines (fat/burnt layers and cartoon outlines)
      const numLayers = 16;
      for (let i = 0; i <= numLayers; i++) {
        const yBase = (i / numLayers) * 256;
        ctx.beginPath();
        ctx.moveTo(0, yBase);
        
        const randomPhase = Math.random() * Math.PI * 2;
        const isBlackLine = Math.random() > 0.5; // High chance of black lines for cel-shading
        const colorVariation = Math.random() > 0.6 ? '#cc7766' : '#5c2d22'; // bright fat vs burnt meat
        
        ctx.strokeStyle = isBlackLine ? '#221411' : colorVariation;
        ctx.lineWidth = isBlackLine ? 4 : 8;

        for (let x = 0; x <= 256; x += 10) {
          const y = yBase + Math.sin(x * 0.05 + randomPhase) * 10 + Math.cos(x * 0.15) * 6;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      
      return new THREE.MeshStandardMaterial({
        map: tex, roughness: 0.9, metalness: 0.05
      });
    };
    
    const donerMeatMat = getDonerMeatMat();
    // For cel-shaded look on the outside
    const donerOutlineMat = new THREE.MeshBasicMaterial({ color: 0x0a0503, side: THREE.BackSide });

    // Pizza geometries and materials
    const pizzaGeo = new THREE.CylinderGeometry(8, 8, 1.5, 32);
    const pizzaSideMat = new THREE.MeshStandardMaterial({ color: 0xc9a46b, roughness: 0.8 }); // Baked dough side
    const pizzaBottomMat = new THREE.MeshStandardMaterial({ color: 0xba9256, roughness: 0.9 }); // Baked dough bottom
    
    const getPizzaTopMat = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext('2d')!;

      // Crust edge (golden brown)
      ctx.fillStyle = '#dbad67';
      ctx.fillRect(0, 0, 256, 256);
      
      // Sauce (tomato red circle)
      ctx.beginPath();
      ctx.arc(128, 128, 115, 0, Math.PI * 2);
      ctx.fillStyle = '#b33017';
      ctx.fill();

      // Cheese (melted yellow splotches)
      ctx.beginPath();
      ctx.arc(128, 128, 108, 0, Math.PI * 2);
      ctx.fillStyle = '#ebd56e';
      ctx.fill();

      // Pepperoni slices
      ctx.fillStyle = '#a12c2a';
      for (let i = 0; i < 12; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * 85;
        ctx.beginPath();
        ctx.arc(128 + Math.cos(angle)*dist, 128 + Math.sin(angle)*dist, 16, 0, Math.PI * 2);
        ctx.fill();
        // small darker rim
        ctx.strokeStyle = '#7d201e';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Basil / Oregano speckles
      ctx.fillStyle = '#226b2d';
      for (let i = 0; i < 30; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * 100;
        ctx.beginPath();
        ctx.arc(128 + Math.cos(angle)*dist, 128 + Math.sin(angle)*dist, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      const tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = 4;
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.1 });
    };
    const pizzaTopMat = getPizzaTopMat();
    
    // Steam particle material
    const getSteamMat = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
      grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.1)');
      grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 64);
      return new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false });
    };
    const steamMat = getSteamMat();
    
    // Cafe geometries
    const cupGeo = new THREE.CylinderGeometry(5.5, 4, 10, 32, 1, true); // Open ended cup
    const cupBottomGeo = new THREE.CircleGeometry(4.0, 32);
    // At y=1.66 (approx 2/3 height up from -5 to 5), the radius is exactly 5.0
    const coffeeGeo = new THREE.CircleGeometry(5.0, 32);
    // Half an arc so it doesn't clip into the inside of the cup
    const handleGeo = new THREE.TorusGeometry(3.0, 0.9, 16, 32, Math.PI);
    const cupMat = new THREE.MeshStandardMaterial({ color: 0xfdfdfd, roughness: 0.1, metalness: 0.1, side: THREE.DoubleSide });
    const coffeeMat = new THREE.MeshStandardMaterial({ color: 0x22110a, roughness: 0.8 }); // Darker coffee color
    
    // Kiosk geometries & materials
    const kioskBaseGeo = new THREE.BoxGeometry(10, 8, 8);
    const kioskWindowGeo = new THREE.BoxGeometry(8, 4, 0.5);
    const kioskAwningGeo = new THREE.BoxGeometry(10, 0.5, 6);
    
    const kioskBaseMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.7, metalness: 0.2 });
    const kioskWindowMat = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.1, metalness: 0.8 }); 

    const getKioskAwningMat = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#cc2222';
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 256; i += 64) {
        ctx.fillRect(i, 0, 32, 256);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.1 });
    };
    const kioskAwningMat = getKioskAwningMat();

    // Asia geometries & materials
    const asiaBowlGeo = new THREE.CylinderGeometry(5.5, 3.5, 4, 32, 1, true); // Open ended
    const asiaBowlBottomGeo = new THREE.CircleGeometry(3.5, 32);
    // At y=0.66 (approx 2/3 height up from -2 to 2), radius is ~4.8
    const asiaRiceGeo = new THREE.CircleGeometry(4.8, 32);
    const asiaChopstickGeo = new THREE.CylinderGeometry(0.15, 0.15, 10, 8);
    
    // Blue ceramic bowl - a bit brighter China porcelain blue
    const asiaBowlMat = new THREE.MeshStandardMaterial({ color: 0x0033aa, roughness: 0.1, metalness: 0.6, side: THREE.DoubleSide });
    // Light wood chopsticks
    const asiaChopstickMat = new THREE.MeshStandardMaterial({ color: 0xead9a2, roughness: 0.8 });
    
    const getAsiaRiceMat = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext('2d')!;
      
      // Base layer
      ctx.fillStyle = '#fdfdfd'; 
      ctx.fillRect(0, 0, 256, 256);
      
      // Rice grains (small overlapping white/light-grey strokes)
      ctx.lineCap = 'round';
      for (let i = 0; i < 1200; i++) {
        ctx.beginPath();
        const startX = Math.random() * 256;
        const startY = Math.random() * 256;
        const length = 3 + Math.random() * 5;
        const angle = Math.random() * Math.PI * 2;
        ctx.moveTo(startX, startY);
        ctx.strokeStyle = Math.random() > 0.8 ? '#f2f2f2' : (Math.random() > 0.9 ? '#e6e6e6' : '#ffffff'); 
        ctx.lineWidth = 3 + Math.random() * 2;
        ctx.lineTo(startX + Math.cos(angle) * length, startY + Math.sin(angle) * length);
        ctx.stroke();
      }
      
      // Small black dots (black sesame seeds)
      ctx.fillStyle = '#222222';
      for (let i = 0; i < 30; i++) {
        ctx.beginPath();
        ctx.arc(Math.random() * 256, Math.random() * 256, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      
      // A little bit of garnish (Green onions)
      ctx.fillStyle = '#3a8128';
      for (let i = 0; i < 40; i++) {
        ctx.beginPath();
        ctx.arc(Math.random() * 256, Math.random() * 256, 1.5 + Math.random() * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.0 });
    };
    const asiaRiceMat = getAsiaRiceMat();

    // Burger geometries & materials
    const burgerBunBottomGeo = new THREE.CylinderGeometry(5, 5, 2, 32);
    const burgerPattyGeo = new THREE.CylinderGeometry(5.2, 5.2, 1.5, 32);
    const burgerCheeseGeo = new THREE.BoxGeometry(5.5, 0.2, 5.5);
    const burgerTopGeo = new THREE.SphereGeometry(5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    
    const bunMat = new THREE.MeshStandardMaterial({ color: 0xd4a373, roughness: 0.8, metalness: 0.1 });
    const pattyMat = new THREE.MeshStandardMaterial({ color: 0x3d1f14, roughness: 0.9, metalness: 0.0 });
    const cheeseMat = new THREE.MeshStandardMaterial({ color: 0xffd700, roughness: 0.6, metalness: 0.2 });
    const lettuceMat = new THREE.MeshStandardMaterial({ color: 0x228b22, roughness: 0.9, metalness: 0.0 });

    const getBunTopMat = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 128; // Rectangular since it wraps around sphere tip
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#d4a373';
      ctx.fillRect(0, 0, 256, 128);
      // Sesame seeds
      ctx.fillStyle = '#f5deb3';
      for (let i = 0; i < 100; i++) {
        const x = Math.random() * 256;
        const y = Math.random() * 128;
        ctx.beginPath();
        ctx.ellipse(x, y, 2, 4, Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      const tex = new THREE.CanvasTexture(canvas);
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0.1 });
    };
    const bunTopMat = getBunTopMat();

    // Restaurant geometries & materials
    const plateGeo = new THREE.CylinderGeometry(5.5, 5.0, 0.4, 32);
    const steakGeo = new THREE.CylinderGeometry(3.6, 3.6, 1.2, 16);
    const glassBaseGeo = new THREE.CylinderGeometry(1.5, 1.5, 0.2, 16);
    const glassStemGeo = new THREE.CylinderGeometry(0.12, 0.12, 5.5, 8);
    const glassBowlGeo = new THREE.CylinderGeometry(1.6, 0.1, 4.0, 12, 1, true);
    const champagneGeo = new THREE.CylinderGeometry(1.4, 0.1, 3.5, 12);
    
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1 });
    const steakMat = new THREE.MeshStandardMaterial({ color: 0x8b2222, roughness: 0.8 }); // Reddish meat color
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xaaffff, transparent: true, opacity: 0.3, roughness: 0.0, metalness: 0.5, side: THREE.DoubleSide });
    const champagneMat = new THREE.MeshStandardMaterial({ color: 0xffe135, transparent: true, opacity: 0.8 });

    const getSteakTopMat = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 256;
      const ctx = canvas.getContext('2d')!;
      
      // Fat/Rim base
      ctx.fillStyle = '#fce4ec'; 
      ctx.fillRect(0, 0, 256, 256);
      
      // Meat shape
      ctx.fillStyle = '#a02020';
      ctx.beginPath();
      ctx.ellipse(128, 128, 110, 90, 0.2, 0, Math.PI * 2);
      ctx.fill();
      
      // The "Eye" of fat / Bone
      ctx.fillStyle = '#fefefe';
      ctx.beginPath();
      const bx = 180, by = 100;
      ctx.arc(bx, by, 15, 0, Math.PI * 2);
      ctx.fill();
      
      // Fat veins
      ctx.strokeStyle = '#fefefe';
      ctx.lineWidth = 6;
      ctx.beginPath();
      // Vein to top
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + 20, by - 60);
      // Vein to center
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - 80, by + 40);
      // Vein to bottom
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + 10, by + 80);
      ctx.stroke();
      
      // Central bone dot
      ctx.fillStyle = '#f8bbd0';
      ctx.beginPath();
      ctx.arc(bx, by, 6, 0, Math.PI * 2);
      ctx.fill();
      
      const tex = new THREE.CanvasTexture(canvas);
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
    };
    const steakTopMat = getSteakTopMat();

    this.engine.getGastronomes().forEach(item => {
      if (!item) return;
      const pos = this.latLonToWorld(item.lat, item.lon);
      const group = new THREE.Group();
      
      const createTextSprite = (text: string) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        ctx.font = 'bold 48px sans-serif';
        const textWidth = ctx.measureText(text).width;
        
        // Pad canvas dynamically
        canvas.width = Math.max(textWidth + 40, 64);
        canvas.height = 128; // Needs adequate height
        
        ctx.font = 'bold 48px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Text Shadow / Outline
        ctx.lineWidth = 10;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#000000';
        ctx.strokeText(text, canvas.width / 2, 64);
        
        ctx.fillStyle = '#ffe600'; // Yellow text
        ctx.fillText(text, canvas.width / 2, 64);
        
        const tex = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: true });
        const sprite = new THREE.Sprite(spriteMat);
        // Correct aspect ratio so text isn't squeezed, using world-scale units (much smaller now)
        const ratio = canvas.width / canvas.height;
        sprite.scale.set(7.5 * ratio, 7.5, 1);
        return sprite;
      };

      if (item.type === 'doner') {
        const stick = new THREE.Mesh(donerStickGeo, donerStickMat);
        const meatGroup = new THREE.Group();
        const meat = new THREE.Mesh(donerMeatGeo, donerMeatMat);
        const outline = new THREE.Mesh(donerMeatGeo, donerOutlineMat);
        outline.scale.set(1.05, 1.05, 1.05); // slightly larger, inverted normals
        
        meat.castShadow = true;
        stick.castShadow = true;
        
        meatGroup.add(meat);
        meatGroup.add(outline);
        
        group.add(stick);
        group.add(meatGroup);
        
        // Give it a floating name tag
        const nameNode = createTextSprite(item.name);
        nameNode.position.set(0, 16, 0); // Above the doner
        group.add(nameNode);
        
        group.position.copy(pos);
        group.userData = { 
          type: 'gastro',
          gastroType: 'doner',
          id: item.id, 
          baseY: 12.5, // Half pacman size ~24 height -> y ~12
          animOffset: pos.x / 300,
          bobSpeed: 150 + Math.random() * 100 
        };
      } else if (item.type === 'pizza') {
        const pzMesh = new THREE.Mesh(pizzaGeo, [pizzaSideMat, pizzaTopMat, pizzaBottomMat]);
        pzMesh.castShadow = true;
        pzMesh.rotation.x = Math.PI / 6; // Tilt it so you can see the top nicely
        group.add(pzMesh);
        
        // Steam particles
        const steamGroup = new THREE.Group();
        for (let i = 0; i < 3; i++) {
           const sprite = new THREE.Sprite(steamMat.clone());
           sprite.scale.set(8, 8, 1);
           sprite.userData.phase = i * (Math.PI * 2 / 3);
           steamGroup.add(sprite);
        }
        steamGroup.name = "steamGroup";
        group.add(steamGroup);

        // Name tag
        const nameNode = createTextSprite(item.name);
        nameNode.position.set(0, 18, 0); // Above the pizza
        group.add(nameNode);
        
        group.position.copy(pos);
        group.userData = { 
          type: 'gastro',
          gastroType: 'pizza',
          id: item.id, 
          baseY: 10,
          animOffset: pos.x / 300,
          bobSpeed: 250 + Math.random() * 200 
        };
      } else if (item.type === 'cafe') {
        const cfGroup = new THREE.Group();
        
        const cup = new THREE.Mesh(cupGeo, cupMat);
        cup.castShadow = true;
        cfGroup.add(cup);
        
        const bottom = new THREE.Mesh(cupBottomGeo, cupMat);
        bottom.rotation.x = Math.PI / 2;
        bottom.position.y = -5;
        cfGroup.add(bottom);
        
        const coffee = new THREE.Mesh(coffeeGeo, coffeeMat);
        coffee.rotation.x = -Math.PI / 2;
        coffee.position.y = 1.66; // 2/3 filled
        cfGroup.add(coffee);
        
        const handle = new THREE.Mesh(handleGeo, cupMat);
        handle.rotation.z = -Math.PI / 2; // Orient half-arc outwards
        handle.position.set(4.7, 0, 0); // Attach to the outer wall
        handle.castShadow = true;
        cfGroup.add(handle);
        
        cfGroup.rotation.x = Math.PI / 8; // Tilt cup nicely so user sees coffee
        group.add(cfGroup);
        
        // Steam particles
        const steamGroup = new THREE.Group();
        for (let i = 0; i < 2; i++) {
           const sprite = new THREE.Sprite(steamMat.clone());
           sprite.scale.set(6, 6, 1);
           sprite.userData.phase = i * Math.PI;
           steamGroup.add(sprite);
        }
        steamGroup.name = "steamGroup";
        steamGroup.position.y = 5;
        group.add(steamGroup);

        // Name tag
        const nameNode = createTextSprite(item.name);
        nameNode.position.set(0, 18, 0); 
        group.add(nameNode);
        
        group.position.copy(pos);
        group.userData = { 
          type: 'gastro',
          gastroType: 'cafe',
          id: item.id, 
          baseY: 10,
          animOffset: pos.x / 300,
          bobSpeed: 250 + Math.random() * 200 
        };
      } else if (item.type === 'kiosk') {
        const kGroup = new THREE.Group();
        
        const base = new THREE.Mesh(kioskBaseGeo, kioskBaseMat);
        base.castShadow = true;
        kGroup.add(base);
        
        const win = new THREE.Mesh(kioskWindowGeo, kioskWindowMat);
        win.position.set(0, 1, 4.01); // Stick out the front +Z
        kGroup.add(win);
        
        const awning = new THREE.Mesh(kioskAwningGeo, kioskAwningMat);
        awning.position.set(0, 4.25, 3.5); // Top front
        awning.rotation.x = Math.PI / 8; // Slanted down
        awning.castShadow = true;
        kGroup.add(awning);
        
        group.add(kGroup);
        
        // Name tag
        const nameNode = createTextSprite(item.name);
        nameNode.position.set(0, 14, 0); 
        group.add(nameNode);
        
        group.position.copy(pos);
        group.userData = { 
          type: 'gastro',
          gastroType: 'kiosk',
          id: item.id, 
          baseY: 8,
          animOffset: pos.x / 300,
          bobSpeed: 250 + Math.random() * 200 
        };
      } else if (item.type === 'asia') {
        const aGroup = new THREE.Group();
        
        const bowl = new THREE.Mesh(asiaBowlGeo, asiaBowlMat);
        bowl.castShadow = true;
        aGroup.add(bowl);
        
        const bowlBottom = new THREE.Mesh(asiaBowlBottomGeo, asiaBowlMat);
        bowlBottom.rotation.x = Math.PI / 2;
        bowlBottom.position.y = -2;
        aGroup.add(bowlBottom);
        
        const rice = new THREE.Mesh(asiaRiceGeo, asiaRiceMat);
        rice.rotation.x = -Math.PI / 2;
        rice.position.y = 0.66; // 2/3 filled inside the 4-high bowl
        aGroup.add(rice);
        
        const chopstick1 = new THREE.Mesh(asiaChopstickGeo, asiaChopstickMat);
        chopstick1.position.set(1.5, 2.0, 0.5); // Sunk into rice (~0.66 is rice surface)
        chopstick1.rotation.set(0.3, 0.3, 0.2);
        chopstick1.castShadow = true;
        aGroup.add(chopstick1);
        
        const chopstick2 = new THREE.Mesh(asiaChopstickGeo, asiaChopstickMat);
        chopstick2.position.set(2.0, 2.2, 1.0);
        chopstick2.rotation.set(0.4, 0.2, 0.15);
        chopstick2.castShadow = true;
        aGroup.add(chopstick2);
        
        aGroup.rotation.x = Math.PI / 10;
        group.add(aGroup);
        
        // Steam particles
        const steamGroup = new THREE.Group();
        for (let i = 0; i < 2; i++) {
           const sprite = new THREE.Sprite(steamMat.clone());
           sprite.scale.set(7, 7, 1);
           sprite.userData.phase = i * Math.PI;
           steamGroup.add(sprite);
        }
        steamGroup.name = "steamGroup";
        steamGroup.position.y = 3;
        group.add(steamGroup);

        // Name tag
        const nameNode = createTextSprite(item.name);
        nameNode.position.set(0, 16, 0); 
        group.add(nameNode);
        
        group.position.copy(pos);
        group.userData = { 
          type: 'gastro',
          gastroType: 'asia',
          id: item.id, 
          baseY: 9,
          animOffset: pos.x / 300,
          bobSpeed: 250 + Math.random() * 200 
        };
      } else if (item.type === 'burger') {
        const bGroup = new THREE.Group();
        
        // Bottom Bun
        const bottomBun = new THREE.Mesh(burgerBunBottomGeo, bunMat);
        bottomBun.position.y = 0.5;
        bottomBun.castShadow = true;
        bGroup.add(bottomBun);
        
        // Patty
        const patty = new THREE.Mesh(burgerPattyGeo, pattyMat);
        patty.position.y = 2.0;
        patty.castShadow = true;
        bGroup.add(patty);
        
        // Lettuce (simplified as another thin disc/box for now)
        const lettuce = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.4, 0.4, 32), lettuceMat);
        lettuce.position.y = 2.8;
        bGroup.add(lettuce);
        
        // Cheese
        const cheese = new THREE.Mesh(burgerCheeseGeo, cheeseMat);
        cheese.position.y = 3.1;
        cheese.rotation.y = Math.PI / 4; // Rotated
        bGroup.add(cheese);
        
        // Top Bun
        const topBun = new THREE.Mesh(burgerTopGeo, bunTopMat);
        topBun.position.y = 3.2;
        topBun.castShadow = true;
        bGroup.add(topBun);
        
        bGroup.rotation.x = Math.PI / 10;
        group.add(bGroup);

        // Name tag
        const nameNode = createTextSprite(item.name);
        nameNode.position.set(0, 15, 0); 
        group.add(nameNode);
        
        group.position.copy(pos);
        group.userData = { 
          type: 'gastro',
          gastroType: 'burger',
          id: item.id, 
          baseY: 9,
          animOffset: pos.x / 300,
          bobSpeed: 250 + Math.random() * 200 
        };
      } else if (item.type === 'restaurant') {
        const rGroup = new THREE.Group();
        
        // Plate
        const plate = new THREE.Mesh(plateGeo, plateMat);
        plate.position.y = -2;
        plate.castShadow = true;
        rGroup.add(plate);
        
        // Steak
        const steak = new THREE.Mesh(steakGeo, [steakMat, steakTopMat, steakMat]);
        steak.scale.set(1.15, 1, 1); // Only slightly oval for Ribeye look
        steak.position.set(0.2, -1.2, 0); 
        steak.rotation.y = Math.PI / 6;
        steak.castShadow = true;
        rGroup.add(steak);
        
        // Taller Champagne Glas next to the plate
        const glass = new THREE.Group();
        const base = new THREE.Mesh(glassBaseGeo, glassMat);
        base.position.y = -2.1;
        glass.add(base);
        
        const stem = new THREE.Mesh(glassStemGeo, glassMat);
        stem.position.y = 0.6;
        glass.add(stem);
        
        const bowl = new THREE.Mesh(glassBowlGeo, glassMat);
        bowl.position.y = 5.3;
        glass.add(bowl);
        
        const liquid = new THREE.Mesh(champagneGeo, champagneMat);
        liquid.position.y = 5.0;
        glass.add(liquid);
        
        glass.position.set(6.5, 0, -3.5); // Beside the plate
        rGroup.add(glass);
        
        // No tilt (perfectly level with the ground)
        rGroup.rotation.x = 0;
        rGroup.rotation.z = 0;
        group.add(rGroup);

        // Name tag
        const nameNode = createTextSprite(item.name);
        nameNode.position.set(0, 15, 0); 
        group.add(nameNode);
        
        group.position.copy(pos);
        group.userData = { 
          type: 'gastro',
          gastroType: 'restaurant',
          id: item.id, 
          baseY: 9,
          animOffset: pos.x / 300,
          bobSpeed: 300 + Math.random() * 250 
        };
      } else {
        const faceMat = getGastroMat(item.type);
        const mesh = new THREE.Mesh(gastroGeo, [gastroSide, gastroSide, gastroSide, gastroSide, faceMat, faceMat]);
        mesh.castShadow = true;
        group.add(mesh);
        
        const nameNode = createTextSprite(item.name);
        nameNode.position.set(0, 14, 0); 
        group.add(nameNode);
        
        group.position.copy(pos);
        group.userData = { 
          type: 'gastro', 
          gastroType: 'other',
          id: item.id, 
          baseY: 8,
          animOffset: pos.x / 300,
          bobSpeed: 200 + Math.random() * 200 
        };
      }
      this.itemsGroup.add(group);
    });
  }

  public drawFrame(_now: number): void {
    if (!this.map || !this.scene || !this.camera || !this.renderer) return;

    if (!this.isMapBuilt && this.engine.getNodes().size > 0) {
      this.buildMap3D();
    }

    // Update Homebase Animation
    if (this.homebaseGroup.children.length > 0) {
      const pulse = Math.sin(_now / 400) * 0.1 + 1; // 0.9 to 1.1 scale pulsing
      const pillar = this.homebaseGroup.getObjectByName('pillar');
      if (pillar) {
        pillar.scale.set(pulse, 1, pulse);
      }

      const flag = this.homebaseGroup.getObjectByName('flag') as THREE.Mesh;
      if (flag && flag.userData.initialPositions) {
        const posAttribute = flag.geometry.attributes.position;
        const initials = flag.userData.initialPositions;
        const fWidth = flag.userData.flagWidth || 26;
        for (let i = 0; i < posAttribute.count; i++) {
          const initV = initials[i];
          // Local x goes from -fWidth/2 to +fWidth/2. 
          // The left edge is -fWidth/2, which is attached to the mast.
          const xDist = initV.x + (fWidth / 2); 
          
          // Add a flutter wave based on time and distance from mast
          const wave = Math.sin(_now / 150 - xDist * 0.3) * (xDist * 0.15);
          
          posAttribute.setZ(i, initV.z + wave);
        }
        posAttribute.needsUpdate = true;
        flag.geometry.computeVertexNormals();
      }
    }

    // Update Clouds
    if (this.cloudsGroup.children.length > 0) {
      this.cloudsGroup.children.forEach((cloud) => {
        // Only gentle bobbing up and down, no sideways drift
        cloud.position.y = cloud.userData.targetY + Math.sin(_now / 1500 + cloud.userData.bobPhase) * 10;
        
        // Sync shadow position
        if (cloud.userData.shadowMesh) {
          const sMesh = cloud.userData.shadowMesh as THREE.Mesh;
          sMesh.position.x = cloud.position.x;
          sMesh.position.z = cloud.position.z;
          // Scale shadow slightly as the cloud bobs up and down (fake perspective)
          const sScale = 1.0 - (cloud.position.y - cloud.userData.targetY) * 0.005;
          sMesh.scale.set(sScale, sScale, 1);
        }
      });
    }

    // Update Dots (visibility and rotation)
    const activeDotsMap = this.engine.getDots();
    const activeDotIds = new Set(Array.from(activeDotsMap.values()).map(d => d.id));
    this.dotsGroup.children.forEach(dotMesh => {
      const dotId = dotMesh.userData.id;
      if (!dotId) return;

      if (activeDotIds.has(dotId)) {
        dotMesh.visible = true;
        // Spin 0 and 1 numbers
        dotMesh.rotation.y = _now / 500 + parseFloat(dotMesh.userData.hash || 0) * 0.5;
      } else {
        dotMesh.visible = false;
      }
    });

    // Animate and cull Items (Power, Rocket, Gastro)
    const powerIds = new Set(this.engine.getPowerItems().map(i => i.id));
    const rocketIds = new Set(this.engine.getRocketItems().map(i => i.id));
    
    this.itemsGroup.children.forEach((group: any) => {
      const u = group.userData;
      if (!u || !u.type) return;

      // Unrender if collected
      if (u.type === 'power' && !powerIds.has(u.id)) {
        group.visible = false;
        return;
      }
      if (u.type === 'rocket' && !rocketIds.has(u.id)) {
        group.visible = false;
        return;
      }
      
      if (!group.visible) group.visible = true; // reset just in case

      // Animate rotation and hovering
      const timeVal = _now / 500;
      if (u.type === 'gastro') {
         if (u.gastroType === 'doner') {
           // Doner rotates faster and doesn't bob up and down, it just stays anchored and spins
           group.rotation.y = timeVal * 1.5 + u.animOffset;
           group.position.y = u.baseY + Math.sin((_now / (u.bobSpeed || 300)) + u.animOffset) * 1.0; // Döner very subtle bobbing
         } else if (u.gastroType === 'pizza' || u.gastroType === 'cafe' || u.gastroType === 'asia' || u.gastroType === 'burger') {
           // These rotate slowly and hover
           group.rotation.y = timeVal * 0.4 + u.animOffset;
           group.position.y = u.baseY + Math.sin((_now / (u.bobSpeed || 300)) + u.animOffset) * 2;
         } else if (u.gastroType === 'restaurant') {
           // Restaurant does NOT rotate, only hovers
           group.position.y = u.baseY + Math.sin((_now / (u.bobSpeed || 300)) + u.animOffset) * 2;
           
           // Animate steam particles
           const steamGroup = group.getObjectByName("steamGroup");
           if (steamGroup) {
              const isSmall = u.gastroType === 'cafe' || u.gastroType === 'asia';
              steamGroup.children.forEach((steamSp: any) => {
                  const progress = ((_now / (isSmall ? 2500 : 2000)) + steamSp.userData.phase / (Math.PI*2)) % 1; 
                  steamSp.position.set(
                    Math.sin((_now/400) + steamSp.userData.phase) * (isSmall ? 1.5 : 3), 
                    -1 + progress * (isSmall ? 10 : 14), 
                    Math.cos((_now/500) + steamSp.userData.phase) * (isSmall ? 1.5 : 3)
                  );
                  const sScale = (isSmall ? 3 : 5) + progress * (isSmall ? 6 : 8);
                  steamSp.scale.set(sScale, sScale, 1);
                  (steamSp.material as THREE.SpriteMaterial).opacity = Math.sin(progress * Math.PI) * (isSmall ? 0.6 : 0.8);
              });
              // Steam group must be counter-rotated so steam rises straight up regardless of rotation
              steamGroup.rotation.y = -group.rotation.y;
           }
         } else {
           group.rotation.y = timeVal * 0.5 + u.animOffset;
           group.position.y = u.baseY + Math.sin((_now / (u.bobSpeed || 300)) + u.animOffset) * 2;
         }
      } else {
         group.rotation.y = timeVal + u.animOffset;
         group.position.y = u.baseY + Math.sin((_now / (u.bobSpeed || 200)) + u.animOffset) * 3;
      }
    });

    // Update Pacman
    if (this.pacLatLng && this.pacMesh) {
      const pos = this.latLonToWorld(this.pacLatLng.lat, this.pacLatLng.lng);

      // Blinking effect during respawn
      if (this.isRespawning) {
        this.pacMesh.visible = Math.floor(performance.now() / 150) % 2 === 0;
      } else {
        this.pacMesh.visible = true;
      }

      // Lift Pacman off the ground (hovering at y=15)
      this.pacMesh.position.set(pos.x, 15, pos.z);

      // Mouth animation
      const upper = this.pacMesh.getObjectByName('upperMouth') as THREE.Group;
      const lower = this.pacMesh.getObjectByName('lowerMouth') as THREE.Group;
      if (upper && lower) {
        const mouthAngle = 0.4 * Math.PI * (0.5 + 0.5 * Math.sin(performance.now() * 0.015));
        upper.rotation.z = mouthAngle;
        lower.rotation.z = -mouthAngle;

        // Swap jaw material on power-up change — never recreate per frame
        const state = this.engine.getState();
        const upperMesh = upper.children[0] as THREE.Mesh;
        const lowerMesh = lower.children[0] as THREE.Mesh;
        if (state.powerUpActive !== this.jawPowerUpActive) {
          this.jawPowerUpActive = state.powerUpActive;
          if (state.powerUpActive) {
            if (!this.jawMatPowerUp) {
              this.jawMatPowerUp = new THREE.MeshStandardMaterial({
                color: 0xffff00, emissive: 0xff00ff, emissiveIntensity: 0.5
              });
            }
            upperMesh.material = this.jawMatPowerUp;
          } else {
            upperMesh.material = this.jawMatNormal;
          }
          lowerMesh.material = upperMesh.material;
        }
      }

      // Eyes are embedded in the mesh and rotate with it — no billboard needed.

      // Move directional light with Pac-Man so shadow frustum always covers the visible area.
      if (this.dirLight && this.pacMesh) {
        const px = this.pacMesh.position.x;
        const pz = this.pacMesh.position.z;
        this.dirLight.position.set(px + 800, 1200, pz + 400);
        this.dirLight.target.position.set(px, 0, pz);
        this.dirLight.target.updateMatrixWorld();
        this.dirLight.shadow.camera.updateProjectionMatrix();

        if (this.sunMesh) {
          // Light direction vector on XZ is (800, 400). Distance = 894.427
          // The shadows are cast away from light, so the source (sun) must be exactly in the +800, +400 direction
          const dist = 3500;
          const sx = px + (800 / 894.427) * dist;
          const sz = pz + (400 / 894.427) * dist;
          this.sunMesh.position.set(sx, 0, sz);
          this.sunMesh.lookAt(px, 0, pz);
        }
      }

      // Rotate Pacman to face movement direction.
      // currentRotation is in screen-pixel space: 0=East, 90=South, -90=North, 180=West.
      // In our 3D world: +x=East, +z=South.
      // Three.js rotation.y: 0 → mouth(+X) faces East, π/2 → faces North(-Z), -π/2 → faces South(+Z).
      // Correct mapping: rotation.y = -currentRotation_in_radians (no +π/2 offset).
      if (this.currentRotation !== undefined && !isNaN(this.currentRotation)) {
        this.pacMesh.rotation.y = -(this.currentRotation * Math.PI) / 180;
      }

      // 3rd Person Follow Camera
      const tiltRad = (90 - this.camTilt) * Math.PI / 180;

      // Apply continuous joystick rotation if present
      if (Math.abs(this.camJoyX) > 0.05) this.camAngle -= this.camJoyX * 0.05;
      if (Math.abs(this.camJoyY) > 0.05) this.camTilt = Math.min(85, Math.max(10, this.camTilt + this.camJoyY * 2.5));

      // Auto-center camera horizontally if mouse is released and cam joystick is idle
      if (!this.isPointerDown && Math.abs(this.camJoyX) < 0.05) {
        this.camAngle *= 0.9; // Smoothly return to 0 (looking straight ahead)
      }

      // Calculate offset behind PacMan based on his current Y rotation plus user look-around offset.
      // Pacman's local +X is his forward direction, so behind is local -X.
      const heading = this.pacMesh.rotation.y + this.camAngle;

      const groundDist = this.camDistance * Math.sin(tiltRad);
      const offsetX = -groundDist * Math.cos(heading);
      const offsetZ = groundDist * Math.sin(heading);
      const offsetY = this.camDistance * Math.cos(tiltRad);

      const idealCamPos = pos.clone().add(new THREE.Vector3(offsetX, offsetY, offsetZ));

      // Smoothly interpolate camera position to create a nice swinging effect behind Pac-Man
      this.camera.position.lerp(idealCamPos, 0.15);

      // Always look at Pac-Man (slightly above his origin so he stays centered)
      this.camera.lookAt(pos.x, pos.y + 10, pos.z);
    }

    // Update Ghosts
    const activeGhostIds = new Set();

    this.ghosts.forEach((ghost) => {
      activeGhostIds.add(ghost);
      let group = this.ghostMeshes.get(ghost) as unknown as THREE.Group;
      if (!group) {
        group = new THREE.Group();
        const color = new THREE.Color(ghost.color);
        const gMat = new THREE.MeshStandardMaterial({ color, roughness: 0.2, metalness: 0.5 });

        // Shape-specific geometry
        if (ghost.shape === 0) { // Dome
          const body = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 12, 16), gMat);
          const top = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2), gMat);
          top.position.y = 6;
          group.add(body, top);
          // Ears
          for (const s of [-1, 1]) {
            const ear = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 6, 8), gMat);
            ear.rotation.z = Math.PI / 2;
            ear.position.set(s * 9, 0, 0);
            group.add(ear);
          }
        } else if (ghost.shape === 1) { // Square
          const body = new THREE.Mesh(new THREE.BoxGeometry(14, 16, 14), gMat);
          group.add(body);
          for (const s of [-1, 1]) {
            const ear = new THREE.Mesh(new THREE.BoxGeometry(3, 8, 3), gMat);
            ear.position.set(s * 8.5, 0, 0);
            group.add(ear);
          }
        } else if (ghost.shape === 2) { // Round
          const body = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 16), gMat);
          group.add(body);
          for (const s of [-1, 1]) {
            const ear = new THREE.Mesh(new THREE.SphereGeometry(3, 8, 8), gMat);
            ear.position.set(s * 10, 0, 0);
            group.add(ear);
          }
        } else { // TV
          const body = new THREE.Mesh(new THREE.BoxGeometry(16, 12, 10), gMat);
          group.add(body);
          // Rabbit ears (cones)
          for (const s of [-1, 1]) {
            const ear = new THREE.Mesh(new THREE.ConeGeometry(1.5, 8, 4), gMat);
            ear.position.set(s * 4, 10, 0);
            ear.rotation.z = s * 0.3;
            group.add(ear);
          }
        }

        // Antenna
        const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 8), gMat);
        ant.position.y = 12;
        const ball = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 8), gMat);
        ball.position.y = 16;
        group.add(ant, ball);

        // Enable shadows for all parts
        group.traverse(child => {
          if ((child as any).isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        group.position.y = 10;
        this.ghostGroup.add(group);
        this.ghostMeshes.set(ghost, group as any);
      }

      // Update position and power-up color
      const gPos = this.latLonToWorld(ghost.lat, ghost.lon);
      group.position.x = gPos.x;
      group.position.z = gPos.z;

      const state = this.engine.getState();
      const groupMesh = group.children[0] as THREE.Mesh; // Assume first child has main material
      if (state.powerUpActive) {
        const remaining = state.powerUpEndTime - performance.now();
        if (remaining < 3000 && Math.floor(performance.now() / 200) % 2 === 0) {
          (groupMesh.material as THREE.MeshStandardMaterial).color.set('#ffffff');
        } else {
          (groupMesh.material as THREE.MeshStandardMaterial).color.set('#0000ff');
        }
      } else {
        (groupMesh.material as THREE.MeshStandardMaterial).color.set(ghost.color);
      }
    });

    // Cleanup old ghosts
    for (const [key, mesh] of this.ghostMeshes.entries()) {
      if (!activeGhostIds.has(key)) {
        this.ghostGroup.remove(mesh);
        this.ghostMeshes.delete(key);
      }
    }

    // Update active Rockets
    const activeRockets = new Set();
    this.rockets.forEach(rocket => {
      activeRockets.add(rocket);
      let group = this.rocketMeshes.get(rocket);
      if (!group) {
        group = new THREE.Group();
        
        const meshGroup = new THREE.Group();
        const blackMat = new THREE.MeshStandardMaterial({ color: 0x181818, roughness: 0.3 });
        const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
        const rimMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a });

        // Body (Capsule is pointing UP/Y)
        const body = new THREE.Mesh(new THREE.CapsuleGeometry(4, 6, 16, 16), blackMat);
        
        // Rim
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 2, 16), rimMat);
        rim.position.y = -6;

        // Eyes placed on -Z (will be rotated to Top/Up)
        const leftEye = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 16), whiteMat);
        leftEye.scale.set(1, 1, 0.4);
        leftEye.position.set(-2, 3, -3.2); // -Z
        leftEye.rotation.y = Math.PI / 6;

        const rightEye = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 16), whiteMat);
        rightEye.scale.set(1, 1, 0.4);
        rightEye.position.set(2, 3, -3.2); // -Z
        rightEye.rotation.y = -Math.PI / 6;

        const lp = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 16), new THREE.MeshBasicMaterial({ color: 0x0 }));
        lp.position.set(-1.8, 3, -3.7);
        const rp = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 16), new THREE.MeshBasicMaterial({ color: 0x0 }));
        rp.position.set(1.8, 3, -3.7);

        // Mouth on -Z
        const mouthStart = Math.PI * 0.7;
        const mouthLen = Math.PI * 0.6;
        const mouth = new THREE.Mesh(new THREE.CylinderGeometry(4.05, 4.05, 3, 16, 1, true, mouthStart, mouthLen), whiteMat);
        mouth.position.y = -1;

        // Teeth lines
        const lineMat = new THREE.MeshBasicMaterial({ color: 0x0 });
        for(let i=-2; i<=2; i++) {
           if (i === 0) continue; 
           const line = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 0.2), lineMat);
           line.position.set(i * 1.0, -1, -4.1);
           meshGroup.add(line);
        }
        const hLine = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.2, 0.2), lineMat);
        hLine.position.set(0, -1, -4.1);
        meshGroup.add(hLine);
        
        meshGroup.add(body, rim, leftEye, rightEye, lp, rp, mouth);

        // Rotate so it points along Z! +Y nose -> +Z. -Z face -> +Y Up!
        meshGroup.rotation.x = Math.PI / 2;
        group.add(meshGroup);

        group.position.y = 8;
        this.rocketsGroup.add(group);
        this.rocketMeshes.set(rocket, group);
      }
      const rPos = this.latLonToWorld(rocket.lat, rocket.lon);
      group.position.x = rPos.x;
      group.position.z = rPos.z;

      // Orient rocket along path
      const cNode = this.engine.getNodes().get(rocket.currentNodeId);
      const tNode = this.engine.getNodes().get(rocket.targetNodeId);
      if (cNode && tNode) {
        const p1 = this.latLonToWorld(cNode.lat, cNode.lon);
        const p2 = this.latLonToWorld(tNode.lat, tNode.lon);
        const direction = p2.clone().sub(p1).normalize();

        // Calculate angle on XZ plane
        // Mesh is built natively facing +Z, so direct atan2(x,z) handles exact heading
        const angle = Math.atan2(direction.x, direction.z);
        group.rotation.y = angle;

        // Emit smoke trail
        if (Math.random() < 0.6) {
           const sMat = new THREE.MeshBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.8 });
           const smoke = new THREE.Mesh(new THREE.SphereGeometry(1.5 + Math.random(), 8, 8), sMat);
           smoke.position.copy(rPos);
           smoke.position.y = 8; 
           // pull backward slightly
           smoke.position.sub(direction.clone().multiplyScalar(4));
           smoke.userData = { life: 1.0, fade: 0.02, scale: 1.03 };
           this.particlesGroup.add(smoke);
           this.smokeTrail.push(smoke);
        }
      }
    });

    // Cleanup old rockets
    for (const [key, mesh] of this.rocketMeshes.entries()) {
      if (!activeRockets.has(key)) {
        this.rocketsGroup.remove(mesh);
        this.rocketMeshes.delete(key);
      }
    }

    // Process smoke trail
    for (let i = this.smokeTrail.length - 1; i >= 0; i--) {
        const s = this.smokeTrail[i];
        s.userData.life -= s.userData.fade;
        s.scale.multiplyScalar(s.userData.scale);
        s.position.y += 0.2;
        (s.material as THREE.Material).opacity = s.userData.life;
        if (s.userData.life <= 0) {
          this.particlesGroup.remove(s);
          this.smokeTrail.splice(i, 1);
        }
    }

    // Particles (Sparks)
    while (this.sparkMeshes.length < this.sparks.length) {
      const mesh = new THREE.Mesh(this.sparkGeo, this.sparkMat.clone());
      this.particlesGroup.add(mesh);
      this.sparkMeshes.push(mesh);
    }
    for (let i = 0; i < this.sparkMeshes.length; i++) {
      const mesh = this.sparkMeshes[i];
      if (i < this.sparks.length) {
        const s = this.sparks[i];
        mesh.visible = true;
        (mesh.material as THREE.MeshBasicMaterial).color.set(s.color);
        (mesh.material as THREE.MeshBasicMaterial).opacity = s.life;
        // Map Canvas screen-space coordinates roughly to 3D. 
        // Sparks are currently generated in screen-coord space by main.ts, which is buggy for 3D.
        // For now, place them high up or relative to pacman for a cool effect.
        // In a full refactor, sparks would use world lat/lng.
        if (this.pacMesh) {
          mesh.position.set(this.pacMesh.position.x + s.vx * 10, 10 + s.life * 10, this.pacMesh.position.z + s.vy * 10);
        }
      } else {
        mesh.visible = false;
      }
    }

    // Particles (Fire)
    while (this.fireMeshes.length < this.fireParticles.length) {
      const mesh = new THREE.Mesh(this.fireGeo, this.fireMat.clone());
      this.particlesGroup.add(mesh);
      this.fireMeshes.push(mesh);
    }
    for (let i = 0; i < this.fireMeshes.length; i++) {
      const mesh = this.fireMeshes[i];
      if (i < this.fireParticles.length) {
        const f = this.fireParticles[i];
        mesh.visible = true;
        (mesh.material as THREE.MeshBasicMaterial).opacity = f.life;
        if (this.rocketsGroup.children.length > 0) {
          const r = this.rocketsGroup.children[0];
          mesh.position.set(r.position.x + (Math.random() - 0.5) * 5, 5 + f.life * 10, r.position.z + (Math.random() - 0.5) * 5);
        }
      } else {
        mesh.visible = false;
      }
    }

    // Vibe theme handling
    if (this.currentTheme === 'satellite') {
      this.scene.background = new THREE.Color('#0b0c10');
    } else if (this.currentTheme === 'street') {
      this.scene.background = new THREE.Color('#101820');
    } else {
      this.scene.background = new THREE.Color('#0a0a0a');
    }

    this.renderer.render(this.scene, this.camera);
  }

  public resize(): void {
    if (this.renderer && this.camera && this.renderer.domElement.parentElement) {
      const w = this.renderer.domElement.parentElement.clientWidth;
      const h = this.renderer.domElement.parentElement.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    }
  }

  public destroy(): void {
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = undefined;
    }
    // Clean up scene resources if needed
    if (this.scene) {
      this.scene.clear();
      this.scene = undefined;
    }
  }

  public setView(_lat: number, _lon: number, _zoom?: number): void {
    // Move camera logic
  }

  public panTo(_lat: number, _lon: number): void {
    // Pan logic
  }
}
