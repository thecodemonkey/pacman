import L from 'leaflet';
import type { GameEngine } from '../game/engine';
import type { IRenderer } from './IRenderer';

export class Renderer2D implements IRenderer {
  private map!: L.Map;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private engine: GameEngine;
  private streetEdges: Array<{ aLat: number; aLon: number; bLat: number; bLon: number }> = [];

  // Data references passed from main game state
  private pacLatLng: L.LatLng | null = null;
  private ghosts: any[] = [];
  private rockets: any[] = [];
  private currentRotation = 0;
  private isRespawning = false;
  private sparks: any[] = [];
  private fireParticles: any[] = [];
  private currentTheme: 'street' | 'pacman' | 'satellite' = 'street';

  // Pacman animation state
  private mouthAngle = 0;
  private mouthOpening = true;

  constructor(engine: GameEngine) {
    this.engine = engine;
  }

  public setStateReferences(state: {
    pacLatLng: L.LatLng | null,
    ghosts: any[],
    rockets: any[],
    sparks: any[],
    fireParticles: any[],
    currentTheme: 'street' | 'pacman' | 'satellite',
    streetEdges?: Array<{ aLat: number; aLon: number; bLat: number; bLon: number }>,
    currentRotation?: number;
    isRespawning?: boolean;
    camJoyX?: number;
    camJoyY?: number;
  }) {
    this.pacLatLng = state.pacLatLng;
    this.ghosts = state.ghosts;
    this.rockets = state.rockets;
    this.sparks = state.sparks;
    this.fireParticles = state.fireParticles;
    this.currentTheme = state.currentTheme;
    if (state.streetEdges) this.streetEdges = state.streetEdges;
    if (state.currentRotation !== undefined) this.currentRotation = state.currentRotation;
    if (state.isRespawning !== undefined) this.isRespawning = state.isRespawning;
  }

  public init(_container: HTMLElement): void {
    // Scaffold for 2D initialization (moving from main.ts)
    // Map setup is assumed to be handled partially externally or here.
    // We'll manage just the Leaflet instance for rendering map tiles
    // and overlay canvas.
  }

  public bindMap(map: L.Map, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.map = map;
    this.canvas = canvas;
    this.ctx = ctx;
  }

  public setStreetEdges(edges: Array<{ aLat: number; aLon: number; bLat: number; bLon: number }>) {
    this.streetEdges = edges;
  }

  public drawFrame(_now: number): void {
    if (!this.map || this.engine.getNodes().size === 0) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.drawStreets();
    this.drawHomebase(_now);
    this.drawDots();
    this.drawPowerItems();
    this.drawRocketItems();
    this.drawFireTrail();
    this.drawRockets();
    this.drawGhosts();
    this.drawPacman();
    this.drawSparks();
    this.drawVignette(_now);
  }

  public resize(): void {
    if (this.map && this.canvas) {
      const mapEl = this.map.getContainer();
      const w = mapEl.clientWidth;
      const h = mapEl.clientHeight;
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
    }
  }

  public destroy(): void {
    // We don't destroy the Leaflet map because it's shared/managed by main.ts
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  public setView(lat: number, lon: number, zoom: number = 19): void {
    if (this.map) {
      this.map.setView([lat, lon], zoom);
    }
  }

  public panTo(lat: number, lon: number): void {
    if (this.map) {
      this.map.panTo([lat, lon], { animate: true, duration: 0.5 });
    }
  }

  // --- Core Drawing Logic extracted from main.ts ---

  private toPoint(lat: number, lon: number): L.Point {
    return this.map.latLngToContainerPoint([lat, lon]);
  }

  private getThemeColors() {
    if (this.currentTheme === 'pacman') {
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
    } else if (this.currentTheme === 'satellite') {
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

  private drawStreets() {
    const colors = this.getThemeColors();
    const ctx = this.ctx;

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
    for (const edge of this.streetEdges) {
      const a = this.toPoint(edge.aLat, edge.aLon);
      const b = this.toPoint(edge.bLat, edge.bLon);
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
    for (const edge of this.streetEdges) {
      const a = this.toPoint(edge.aLat, edge.aLon);
      const b = this.toPoint(edge.bLat, edge.bLon);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawDots() {
    const colors = this.getThemeColors();
    const dots = this.engine.getDots();
    const ctx = this.ctx;
    const dotRadius = 9;
    const minDist = dotRadius * 2.5;
    const minDistSq = minDist * minDist;
    const placed: Array<{ x: number; y: number }> = [];

    ctx.save();
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const dot of dots) {
      if (!dot) continue;
      const p = this.toPoint(dot.lat, dot.lon);
      const px = Math.round(p.x);
      const py = Math.round(p.y);

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

      let hash = 0;
      for (let j = 0; j < dot.id.length; j++) hash += dot.id.charCodeAt(j);

      ctx.beginPath();
      ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = colors.dotCircle;
      ctx.globalAlpha = 0.9;
      ctx.fill();

      ctx.fillStyle = colors.dotText;
      ctx.globalAlpha = 1;
      ctx.fillText(hash % 2 === 0 ? '0' : '1', px, py + 1);
    }
    ctx.restore();
  }

  private drawHomebase(now: number) {
    const homeNodeId = this.engine.getInitialPacmanNodeId();
    if (!homeNodeId) return;
    const node = this.engine.getNodes().get(homeNodeId);
    if (!node) return;

    const p = this.toPoint(node.lat, node.lon);
    const ctx = this.ctx;

    // Pacman radius is 22, homebase should be ca. 2x
    const baseRadius = 48;

    ctx.save();

    // 1. Pulsating Main Circle
    const pulse = Math.sin(now / 400) * 0.05 + 1; // Slight pulse 0.95 to 1.05
    const r = baseRadius * pulse;

    // Main pink fill (0.3 opacity as requested)
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 0, 255, 0.3)';
    ctx.fill();

    // Small solid blue center circle
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#0050ff';
    ctx.fill();

    // Cyan border (1px, more opaque as requested)
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 2. Wave-like glow impulses moving outwards
    const waveCycle = 2000;
    const numWaves = 3;

    for (let i = 0; i < numWaves; i++) {
      const offset = (i / numWaves) * waveCycle;
      const progress = ((now + offset) % waveCycle) / waveCycle;

      const waveRadius = r + (progress * baseRadius * 0.7);
      const alpha = (1 - progress) * 0.6; // Increased alpha for waves

      ctx.beginPath();
      ctx.arc(p.x, p.y, waveRadius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0, 255, 255, ${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Subtle central glow to make it feel more "alive"
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grad.addColorStop(0, 'rgba(0, 255, 255, 0.15)');
    grad.addColorStop(1, 'rgba(0, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.restore();
  }

  private drawPowerItems() {
    const items = this.engine.getPowerItems();
    const ctx = this.ctx;
    const radius = 16;

    ctx.save();
    for (const item of items) {
      if (!item) continue;
      const p = this.toPoint(item.lat, item.lon);

      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a1a';
      ctx.strokeStyle = '#00ffcc';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();

      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#00ffcc';
      ctx.fillText('</>', p.x, p.y);

      const pulse = Math.sin(performance.now() / 200) * 5 + 5;
      ctx.shadowColor = '#00ffcc';
      ctx.shadowBlur = pulse;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRocketItems() {
    const items = this.engine.getRocketItems();
    const ctx = this.ctx;
    const radius = 16;

    ctx.save();
    for (const item of items) {
      if (!item) continue;
      const p = this.toPoint(item.lat, item.lon);

      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1a1a';
      ctx.strokeStyle = '#ff3300';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();

      ctx.font = '18px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🚀', p.x, p.y);

      const pulse = Math.sin(performance.now() / 200) * 5 + 5;
      ctx.shadowColor = '#ff3300';
      ctx.shadowBlur = pulse;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRockets() {
    const ctx = this.ctx;
    this.rockets.forEach((rocket) => {
      const p = this.toPoint(rocket.lat, rocket.lon);

      if (Math.random() > 0.3) {
        this.fireParticles.push({
          x: p.x, y: p.y,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          life: 1.0
        });
      }

      ctx.save();
      ctx.translate(p.x, p.y);

      const cNode = this.engine.getNodes().get(rocket.currentNodeId);
      const tNode = this.engine.getNodes().get(rocket.targetNodeId);
      if (cNode && tNode) {
        const p1 = this.map.project([cNode.lat, cNode.lon], this.map.getMaxZoom());
        const p2 = this.map.project([tNode.lat, tNode.lon], this.map.getMaxZoom());
        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        ctx.rotate(angle);
      }

      ctx.beginPath();
      ctx.moveTo(-22, -11);
      ctx.lineTo(-22, 11);
      ctx.quadraticCurveTo(8, 14, 32, 0);
      ctx.quadraticCurveTo(8, -14, -22, -11);
      ctx.closePath();

      ctx.fillStyle = 'black';
      ctx.shadowColor = '#ffd22f';
      ctx.shadowBlur = 15;
      ctx.fill();

      ctx.strokeStyle = '#ffd22f';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.ellipse(-4, -5, 15, 4, -0.1, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fill();

      ctx.restore();
    });
  }

  private drawFireTrail() {
    const ctx = this.ctx;
    ctx.save();
    for (let i = this.fireParticles.length - 1; i >= 0; i--) {
      const p = this.fireParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.05;
      if (p.life <= 0) {
        this.fireParticles.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, 8 * p.life), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, ${Math.floor(p.life * 150)}, 0, ${p.life})`;
      ctx.fill();
    }
    ctx.restore();
  }

  private drawSparks() {
    const ctx = this.ctx;
    ctx.save();
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.x += s.vx;
      s.y += s.vy;
      s.life -= 0.02;
      if (s.life <= 0) {
        this.sparks.splice(i, 1);
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

  private drawGhosts() {
    for (const ghost of this.ghosts) {
      const p = this.toPoint(ghost.lat, ghost.lon);
      const state = this.engine.getState();
      let color = ghost.color;

      if (state.powerUpActive) {
        const remaining = state.powerUpEndTime - performance.now();
        if (remaining < 3000 && Math.floor(performance.now() / 200) % 2 === 0) {
          color = '#ffffff'; // flashing white
        } else {
          color = '#0000ff'; // scared blue
        }
      }

      this.ctx.save();
      this.ctx.translate(p.x, p.y);

      // Drop shadow
      this.ctx.shadowColor = 'rgba(0,0,0,0.35)';
      this.ctx.shadowBlur = 5;
      this.ctx.shadowOffsetY = 2;

      if (ghost.shape === 0) {
        // --- Dome bot: antenna ball + dome + side ears ---
        this.ctx.beginPath();
        this.ctx.moveTo(0, -20); this.ctx.lineTo(0, -28);
        this.ctx.strokeStyle = color; this.ctx.lineWidth = 3; this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.arc(0, -31, 4, 0, Math.PI * 2); this.ctx.fillStyle = color; this.ctx.fill();
        for (const s of [-1, 1]) { this.ctx.beginPath(); this.ctx.roundRect(s * 17, -6, 5, 14, 3); this.ctx.fillStyle = color; this.ctx.fill(); }
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 18, Math.PI, 0);
        this.ctx.lineTo(18, 10); this.ctx.quadraticCurveTo(18, 16, 12, 16);
        this.ctx.lineTo(-12, 16); this.ctx.quadraticCurveTo(-18, 16, -18, 10);
        this.ctx.closePath(); this.ctx.fillStyle = color; this.ctx.fill();
        this.ctx.shadowBlur = 0;
        this.drawBotEyes(-7, 7, 2, 6, state.powerUpActive ? false : ghost.isBlinking);

      } else if (ghost.shape === 1) {
        // --- Square bot: antenna + boxy head + side ears ---
        this.ctx.beginPath();
        this.ctx.moveTo(0, -18); this.ctx.lineTo(0, -26);
        this.ctx.strokeStyle = color; this.ctx.lineWidth = 3; this.ctx.lineCap = 'round'; this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.arc(0, -28, 4, 0, Math.PI * 2); this.ctx.fillStyle = color; this.ctx.fill();
        for (const s of [-1, 1]) { this.ctx.beginPath(); this.ctx.roundRect(s * 16, -6, 5, 12, 2); this.ctx.fillStyle = color; this.ctx.fill(); }
        this.ctx.beginPath();
        this.ctx.roundRect(-16, -18, 32, 34, 6);
        this.ctx.fillStyle = color; this.ctx.fill();
        this.ctx.shadowBlur = 0;
        this.drawBotEyes(-6, 6, -2, 5, state.powerUpActive ? false : ghost.isBlinking);

      } else if (ghost.shape === 2) {
        // --- Round bot: V-antenna + circle head + ear bumps ---
        for (const s of [-1, 1]) {
          this.ctx.beginPath(); this.ctx.moveTo(s * 4, -16); this.ctx.lineTo(s * 10, -28);
          this.ctx.strokeStyle = color; this.ctx.lineWidth = 2; this.ctx.lineCap = 'round'; this.ctx.stroke();
          this.ctx.beginPath(); this.ctx.arc(s * 10, -30, 3, 0, Math.PI * 2); this.ctx.fillStyle = color; this.ctx.fill();
        }
        this.ctx.beginPath(); this.ctx.arc(0, 0, 18, 0, Math.PI * 2); this.ctx.fillStyle = color; this.ctx.fill();
        for (const s of [-1, 1]) { this.ctx.beginPath(); this.ctx.arc(s * 18, 0, 4, 0, Math.PI * 2); this.ctx.fillStyle = color; this.ctx.fill(); }
        this.ctx.shadowBlur = 0;
        this.drawBotEyes(-7, 7, -2, 6, state.powerUpActive ? false : ghost.isBlinking);

      } else {
        // --- TV bot: rabbit-ear antenna + wide rectangle head ---
        for (const s of [-1, 1]) {
          this.ctx.beginPath(); this.ctx.moveTo(s * 4, -16); this.ctx.lineTo(s * 10, -30);
          this.ctx.strokeStyle = color; this.ctx.lineWidth = 2.5; this.ctx.lineCap = 'round'; this.ctx.stroke();
          this.ctx.beginPath(); this.ctx.arc(s * 10, -31, 3, 0, Math.PI * 2); this.ctx.fillStyle = color; this.ctx.fill();
        }
        this.ctx.beginPath();
        this.ctx.roundRect(-18, -16, 36, 28, 5);
        this.ctx.fillStyle = color; this.ctx.fill();
        this.ctx.shadowBlur = 0;
        this.drawBotEyes(-6, 6, -4, 5, state.powerUpActive ? false : ghost.isBlinking);
      }

      this.ctx.restore();
    }
  }

  private drawBotEyes(eyeX1: number, eyeX2: number, eyeY: number, r: number, blinking: boolean) {
    for (const ex of [eyeX1, eyeX2]) {
      if (blinking) {
        // Closed eye — horizontal line
        this.ctx.beginPath();
        this.ctx.moveTo(ex - r, eyeY);
        this.ctx.lineTo(ex + r, eyeY);
        this.ctx.strokeStyle = '#1a1a2e';
        this.ctx.lineWidth = 2;
        this.ctx.lineCap = 'round';
        this.ctx.stroke();
      } else {
        // White sclera
        this.ctx.beginPath();
        this.ctx.arc(ex, eyeY, r, 0, Math.PI * 2);
        this.ctx.fillStyle = 'white';
        this.ctx.fill();
        // Pupil
        this.ctx.beginPath();
        this.ctx.arc(ex, eyeY, r * 0.5, 0, Math.PI * 2);
        this.ctx.fillStyle = '#1a1a2e';
        this.ctx.fill();
        // Highlight
        this.ctx.beginPath();
        this.ctx.arc(ex - r * 0.25, eyeY - r * 0.3, r * 0.22, 0, Math.PI * 2);
        this.ctx.fillStyle = 'rgba(255,255,255,0.7)';
        this.ctx.fill();
      }
    }
  }

  private drawPacman() {
    if (!this.pacLatLng) return;

    // Blinking effect during respawn
    if (this.isRespawning && Math.floor(performance.now() / 150) % 2 === 0) return;

    const ctx = this.ctx;
    const p = this.toPoint(this.pacLatLng.lat, this.pacLatLng.lng);
    const radius = 22;
    const rot = (this.currentRotation * Math.PI) / 180;

    const state = this.engine.getState();

    // Power-up flashing effect
    let primaryColor = '#ffd22f'; // default yellow
    let secondaryColor = '#141c28';
    let eyeColor = '#ffd22f';
    let glowColor = 'rgba(255, 210, 47, 0.3)';

    if (state.powerUpActive) {
      primaryColor = '#ff00ff'; // Constant Neon-Pink for outline
      const t = (Math.sin(performance.now() / 120) + 1) / 2;
      const colorVal = Math.floor(t * 255);
      secondaryColor = `rgb(${colorVal}, ${colorVal}, 0)`;
      glowColor = 'rgba(0, 255, 255, 0.8)'; // Constant Neon-Cyan for glow
      eyeColor = '#ffffff';

      // Create sparks around pacman (handled by setStateReferences from main.ts if integrated,
      // but here we can add to the local sparks array)
      if (Math.random() > 0.5) {
        this.createLocalSparks(p.x, p.y, '#ff00ff', '#00ffff');
      }
    }

    // Animate mouth
    // mouthAngle logic from commit 093dcd0 but adapted for Renderer2D state
    // We'll use a simpler version or just the one from commit code
    const isMoving = true; // For now assume always moving if we have rotation
    if (isMoving) {
      if (this.mouthOpening) {
        this.mouthAngle += 0.08;
        if (this.mouthAngle >= 0.85) this.mouthOpening = false;
      } else {
        this.mouthAngle -= 0.08;
        if (this.mouthAngle <= 0.05) this.mouthOpening = true;
      }
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
    ctx.rotate(-this.mouthAngle);
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
    ctx.rotate(this.mouthAngle);
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

    // --- X-eye: screen-aligned ---
    ctx.save();
    ctx.rotate(-rot); // undo body rotation
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

  private createLocalSparks(x: number, y: number, color1: string, color2: string) {
    for (let i = 0; i < 5; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 3;
      this.sparks.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.0,
        color: Math.random() > 0.5 ? color1 : color2
      });
    }
  }

  private drawVignette(_now: number) {
    const state = this.engine.getState();
    if (!state.powerUpActive) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const vSizeW = w * 0.10;
    const vSizeH = h * 0.10;
    const ctx = this.ctx;

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
}

