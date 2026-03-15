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

  // Camera orbital parameters
  private camAngle = 0; // Horizontal rotation
  private camTilt = 45; // Vertical tilt in degrees
  private camDistance = 450; // Distance from target

  // Interaction state
  private isPointerDown = false;
  private lastPointerPos = { x: 0, y: 0 };

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
  }

  public bindMap(map: L.Map, _canvas: HTMLCanvasElement, _ctx?: CanvasRenderingContext2D): void {
    this.map = map;
  }

  public init(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a0a0a'); // Dark vibe background

    this.camera = new THREE.PerspectiveCamera(45, w / h, 1, 10000);
    // Position for a tilted "isometric-like" perspective
    this.camera.position.set(0, 800, 800);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // Canvas styling to overlay Leaflet map
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.top = '0';
    this.renderer.domElement.style.left = '0';
    this.renderer.domElement.style.zIndex = '600'; // above leaflet (500) but below HUD (2000) and joystick (2000)
    this.renderer.domElement.style.pointerEvents = 'none'; // let input pass through to joystick
    container.appendChild(this.renderer.domElement);

    // Lighting config
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(200, 500, 300);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 2500;
    // larger orthographic frustum for shadows
    const ext = 1000;
    dirLight.shadow.camera.left = -ext;
    dirLight.shadow.camera.right = ext;
    dirLight.shadow.camera.top = ext;
    dirLight.shadow.camera.bottom = -ext;
    this.scene.add(dirLight);

    // Neon grid for aesthetic
    const grid = new THREE.GridHelper(4000, 100, 0x00ffcc, 0x222222);
    grid.position.y = -0.1;
    this.scene.add(grid);

    this.scene.add(this.streetsGroup);
    this.scene.add(this.dotsGroup);
    this.scene.add(this.ghostGroup);
    this.scene.add(this.itemsGroup);
    this.scene.add(this.buildingsGroup);
    this.scene.add(this.treesGroup);
    this.scene.add(this.rocketsGroup);
    this.scene.add(this.particlesGroup);

    this.setupCameraControls(container);

    // Pacman mesh (Mechanical Look)
    this.pacMesh = new THREE.Group();
    
    const sphereMat = new THREE.MeshStandardMaterial({
      color: 0xffd22f, // Pacman Yellow
      roughness: 0.3,
      metalness: 0.2
    });

    const jawMat = new THREE.MeshStandardMaterial({
      color: 0x141c28, // Dark Blue secondary
      roughness: 0.4,
      metalness: 0.1
    });

    // Upper Jaw
    const upperGroup = new THREE.Group();
    upperGroup.name = 'upperMouth';
    const upperGeo = new THREE.SphereGeometry(12, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2);
    const upperMesh = new THREE.Mesh(upperGeo, jawMat);
    upperGroup.add(upperMesh);

    // Hood accent (smaller semi-sphere inside)
    const hoodGeo = new THREE.SphereGeometry(11, 32, 32, 0, Math.PI * 2, 0, Math.PI / 2);
    const hoodMesh = new THREE.Mesh(hoodGeo, sphereMat);
    hoodMesh.scale.set(0.9, 0.9, 0.9);
    upperGroup.add(hoodMesh);

    // Upper Teeth
    const teethCount = 7;
    const teethGeo = new THREE.ConeGeometry(1.5, 4, 4);
    const teethMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < teethCount; i++) {
      const tooth = new THREE.Mesh(teethGeo, teethMat);
      const angle = (i / (teethCount - 1)) * Math.PI - Math.PI / 2;
      tooth.position.set(11.5 * Math.cos(angle), -1.5, 11.5 * Math.sin(angle));
      tooth.rotation.x = Math.PI;
      upperGroup.add(tooth);
    }
    this.pacMesh.add(upperGroup);

    // Lower Jaw
    const lowerGroup = new THREE.Group();
    lowerGroup.name = 'lowerMouth';
    const lowerGeo = new THREE.SphereGeometry(12, 32, 32, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    const lowerMesh = new THREE.Mesh(lowerGeo, jawMat);
    lowerGroup.add(lowerMesh);

    // Lower Teeth
    for (let i = 0; i < teethCount; i++) {
        const tooth = new THREE.Mesh(teethGeo, teethMat);
        const angle = (i / (teethCount - 1)) * Math.PI - Math.PI / 2;
        tooth.position.set(11.5 * Math.cos(angle), 1.5, 11.5 * Math.sin(angle));
        lowerGroup.add(tooth);
    }
    this.pacMesh.add(lowerGroup);

    // X-Eye (Billboard)
    const eyeGroup = new THREE.Group();
    eyeGroup.name = 'xEye';
    const markerMat = new THREE.LineBasicMaterial({ color: 0xffd22f, linewidth: 2 });
    const line1Geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-3, -3, 0), new THREE.Vector3(3, 3, 0)]);
    const line2Geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(3, -3, 0), new THREE.Vector3(-3, 3, 0)]);
    eyeGroup.add(new THREE.Line(line1Geo, markerMat));
    eyeGroup.add(new THREE.Line(line2Geo, markerMat));
    eyeGroup.position.set(0, 16, 0); // Above head
    this.pacMesh.add(eyeGroup);

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
      this.camDistance = Math.min(1500, Math.max(150, this.camDistance + e.deltaY * 0.5));
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

    // A low-poly representation of streets (dark blue lines or thin boxes)
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00d2ff, opacity: 0.5, transparent: true });
    nodes.forEach(node => {
      const p1 = this.latLonToWorld(node.lat, node.lon);
      node.neighbors.forEach(nId => {
        const target = nodes.get(nId);
        if (target) {
          const p2 = this.latLonToWorld(target.lat, target.lon);
          const geo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
          const line = new THREE.Line(geo, lineMat);
          line.position.y = 1.0;
          this.streetsGroup.add(line);
        }
      });
    });

    // Dots
    const dots = this.engine.getDots();
    const dotGeo = new THREE.BoxGeometry(3, 3, 3);
    const dotMat = new THREE.MeshStandardMaterial({ color: 0xffde00, emissive: 0xffde00, emissiveIntensity: 0.5 });
    dots.forEach(dot => {
      if (!dot) return;
      const pos = this.latLonToWorld(dot.lat, dot.lon);
      const mesh = new THREE.Mesh(dotGeo, dotMat);
      mesh.position.copy(pos);
      mesh.position.y = 5;
      mesh.castShadow = true;
      this.dotsGroup.add(mesh);
    });

    this.buildBuildings3D();
    this.buildTrees3D();

    this.isMapBuilt = true;
  }

  private buildBuildings3D() {
    this.buildingsGroup.clear();
    const buildings = this.engine.getBuildings();
    const buildingMat = new THREE.MeshStandardMaterial({ color: 0x112233, roughness: 0.3, metalness: 0.2 });

    buildings.forEach(building => {
      const shape = new THREE.Shape();
      building.nodes.forEach((node, i) => {
        const p = this.latLonToWorld(node.lat, node.lon);
        if (i === 0) shape.moveTo(p.x, -p.z);
        else shape.lineTo(p.x, -p.z);
      });

      const extrudeSettings = {
        steps: 1,
        depth: 20 + Math.random() * 40,
        beveled: false
      };

      const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
      const mesh = new THREE.Mesh(geo, buildingMat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.buildingsGroup.add(mesh);
    });
  }

  private buildTrees3D() {
    this.treesGroup.clear();
    const trees = this.engine.getTrees();

    const trunkGeo = new THREE.CylinderGeometry(2, 2, 15, 8);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3d2b1f });
    const foliageGeo = new THREE.ConeGeometry(8, 20, 8);
    const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2d5a27 });

    trees.forEach(tree => {
      const group = new THREE.Group();
      const p = this.latLonToWorld(tree.lat, tree.lon);

      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.y = 7.5;
      trunk.castShadow = true;

      const foliage = new THREE.Mesh(foliageGeo, foliageMat);
      foliage.position.y = 20;
      foliage.castShadow = true;

      group.add(trunk);
      group.add(foliage);
      group.position.copy(p);
      this.treesGroup.add(group);
    });
  }

  private updateItems3D() {
    // We recreate items occasionally or just keep track. For now, simple clear and rebuild since count is low.
    this.itemsGroup.clear();

    const pGeo = new THREE.OctahedronGeometry(6);
    const pMat = new THREE.MeshStandardMaterial({ color: 0x00ffcc, emissive: 0x00ffcc, emissiveIntensity: 0.8 });

    this.engine.getPowerItems().forEach(item => {
      if (!item) return;
      const pos = this.latLonToWorld(item.lat, item.lon);
      const mesh = new THREE.Mesh(pGeo, pMat);
      mesh.position.copy(pos);
      mesh.position.y = 10 + Math.sin(performance.now() / 200) * 3;
      mesh.rotation.y += performance.now() / 500;
      this.itemsGroup.add(mesh);
    });

    const rGeo = new THREE.ConeGeometry(5, 15, 4);
    const rMat = new THREE.MeshStandardMaterial({ color: 0xff3300, emissive: 0xff3300, emissiveIntensity: 0.8 });

    this.engine.getRocketItems().forEach(item => {
      if (!item) return;
      const pos = this.latLonToWorld(item.lat, item.lon);
      const mesh = new THREE.Mesh(rGeo, rMat);
      mesh.position.copy(pos);
      mesh.position.y = 10 + Math.sin(performance.now() / 200) * 3;
      mesh.rotation.y += performance.now() / 500;
      mesh.rotation.x = Math.PI; // point down
      this.itemsGroup.add(mesh);
    });
  }

  public drawFrame(_now: number): void {
    if (!this.map || !this.scene || !this.camera || !this.renderer) return;

    if (!this.isMapBuilt && this.engine.getNodes().size > 0) {
      this.buildMap3D();
    }

    // Update Pacman
    if (this.pacLatLng && this.pacMesh) {
      const pos = this.latLonToWorld(this.pacLatLng.lat, this.pacLatLng.lng);
      
      // Blinking effect during respawn
      if (this.isRespawning) {
        this.pacMesh.visible = Math.floor(performance.now() / 150) % 2 === 0;
      } else {
        this.pacMesh.visible = true;
      }

      // Set position directly to avoid "vanishing" or extreme lag
      this.pacMesh.position.copy(pos);

      // Mouth animation
      const upper = this.pacMesh.getObjectByName('upperMouth') as THREE.Group;
      const lower = this.pacMesh.getObjectByName('lowerMouth') as THREE.Group;
      if (upper && lower) {
        const mouthAngle = 0.4 * Math.PI * (0.5 + 0.5 * Math.sin(performance.now() * 0.015));
        upper.rotation.z = mouthAngle;
        lower.rotation.z = -mouthAngle;
        
        // Update jaws material based on power-up
        const state = this.engine.getState();
        const upperMesh = upper.children[0] as THREE.Mesh;
        const lowerMesh = lower.children[0] as THREE.Mesh;
        if (state.powerUpActive) {
          const t = (Math.sin(performance.now() / 120) + 1) / 2;
          const r = Math.floor(t * 255);
          upperMesh.material = new THREE.MeshStandardMaterial({ color: new THREE.Color(r/255, r/255, 0), emissive: 0xff00ff, emissiveIntensity: 0.5 });
          lowerMesh.material = upperMesh.material;
        } else {
          upperMesh.material = new THREE.MeshStandardMaterial({ color: 0x141c28 });
          lowerMesh.material = upperMesh.material;
        }
      }

      // Billboard Eye
      const eye = this.pacMesh.getObjectByName('xEye') as THREE.Group;
      if (eye) {
        eye.lookAt(this.camera.position);
      }

      // Rotate Pacman to face movement direction
      if (this.currentRotation !== undefined && !isNaN(this.currentRotation)) {
        this.pacMesh.rotation.y = - (this.currentRotation * Math.PI) / 180 + Math.PI / 2;
      }

      // Center camera smoothly with orbital physics
      const tiltRad = (90 - this.camTilt) * Math.PI / 180;
      const offsetX = this.camDistance * Math.sin(tiltRad) * Math.sin(this.camAngle);
      const offsetY = this.camDistance * Math.cos(tiltRad);
      const offsetZ = this.camDistance * Math.sin(tiltRad) * Math.cos(this.camAngle);

      const idealCamPos = pos.clone().add(new THREE.Vector3(offsetX, offsetY, offsetZ));
      this.camera.position.lerp(idealCamPos, 0.1);
      this.camera.lookAt(pos);
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

    // Update Items
    this.updateItems3D();

    // Update active Rockets
    const activeRockets = new Set();
    this.rockets.forEach(rocket => {
      activeRockets.add(rocket);
      let group = this.rocketMeshes.get(rocket);
      if (!group) {
        group = new THREE.Group();
        const rBody = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 12, 8), new THREE.MeshStandardMaterial({ color: 0x333333 }));
        const rTip = new THREE.Mesh(new THREE.ConeGeometry(3, 6, 8), new THREE.MeshStandardMaterial({ color: 0xff3300 }));
        rTip.position.y = 9;
        group.add(rBody, rTip);
        group.position.y = 15;
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
        const angle = Math.atan2(direction.x, direction.z);
        group.rotation.y = angle;
        group.rotation.x = Math.PI / 2; // lay flat pointing forward
      }
    });

    // Cleanup old rockets
    for (const [key, mesh] of this.rocketMeshes.entries()) {
      if (!activeRockets.has(key)) {
        this.rocketsGroup.remove(mesh);
        this.rocketMeshes.delete(key);
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
