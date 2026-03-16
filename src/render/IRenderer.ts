export interface IRenderer {
  /**
   * Initialize the renderer with the container element.
   */
  init(container: HTMLElement): void;

  /**
   * Called every frame to render the game state.
   */
  drawFrame(now: number): void;

  /**
   * Handle window resize events.
   */
  resize(): void;

  /**
   * Clean up resources before switching to another renderer or destroying.
   */
  destroy(): void;

  /**
   * Center the camera/view on the given map coordinates.
   */
  setView(lat: number, lon: number, zoom?: number): void;

  /**
   * Pan camera to coordinates with animation.
   */
  panTo(lat: number, lon: number): void;

  /**
   * Bind the map instance and canvas context (if applicable) for projection.
   */
  bindMap(map: L.Map, canvas: HTMLCanvasElement, ctx?: CanvasRenderingContext2D): void;

  /**
   * Keep references to game state.
   */
  setStateReferences(state: {
    pacLatLng: L.LatLng | null;
    ghosts: any[];
    rockets: any[];
    sparks: any[];
    fireParticles: any[];
    currentTheme: 'street' | 'pacman' | 'satellite';
    streetEdges?: Array<{ aLat: number; aLon: number; bLat: number; bLon: number }>;
    currentRotation?: number;
    isRespawning?: boolean;
    camJoyX?: number;
    camJoyY?: number;
  }): void;
}
