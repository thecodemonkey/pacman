

export interface GameNode {
  id: string;
  lat: number;
  lon: number;
  neighbors: string[]; // Neighbor node IDs
}

export interface GameState {
  score: number;
  lives: number;
  isGameOver: boolean;
}

export class GameEngine {
  private nodes: Map<string, GameNode> = new Map();
  private dots: Set<string> = new Set(); // Node IDs where dots are located
  private pacmanNodeId: string = "";
  private initialPacmanNodeId: string = "";
  private state: GameState = { score: 0, lives: 3, isGameOver: false };

  constructor() {}

  public buildGraph(osmData: any) {
    this.nodes.clear();
    this.dots.clear();

    // 1. Collect all nodes from the ways we care about
    const wayElements = osmData.elements.filter((e: any) => e.type === 'way');
    const nodeElements = osmData.elements.filter((e: any) => e.type === 'node');

    const nodeLookup = new Map<number, any>();
    nodeElements.forEach((n: any) => nodeLookup.set(n.id, n));

    wayElements.forEach((way: any) => {
      for (let i = 0; i < way.nodes.length; i++) {
        const nodeId = way.nodes[i].toString();
        const osmNode = nodeLookup.get(way.nodes[i]);

        if (!this.nodes.has(nodeId) && osmNode) {
          this.nodes.set(nodeId, {
            id: nodeId,
            lat: osmNode.lat,
            lon: osmNode.lon,
            neighbors: [],
          });
        }

        // Add connectivity
        if (i > 0) {
          const prevId = way.nodes[i - 1].toString();
          this.nodes.get(nodeId)!.neighbors.push(prevId);
          this.nodes.get(prevId)!.neighbors.push(nodeId);
        }
      }
    });

    // 2. Initial dots - place on all nodes for now
    this.nodes.forEach((_, id) => this.dots.add(id));
    
    console.log(`Graph built with ${this.nodes.size} nodes.`);
  }

  public resetGame() {
    this.dots.clear();
    this.nodes.forEach((_, id) => this.dots.add(id));
    this.pacmanNodeId = "";
    this.initialPacmanNodeId = "";
    this.state.score = 0;
    this.state.lives = 3;
    this.state.isGameOver = false;
  }

  public loseLife(): boolean {
    this.state.lives -= 1;
    if (this.state.lives <= 0) {
      this.state.isGameOver = true;
    }
    return this.state.isGameOver;
  }

  public findNearestNode(lat: number, lon: number): string {
    let minDist = Infinity;
    let nearestId = "";
    this.nodes.forEach((node) => {
      const dist = Math.sqrt(Math.pow(node.lat - lat, 2) + Math.pow(node.lon - lon, 2));
      if (dist < minDist) {
        minDist = dist;
        nearestId = node.id;
      }
    });
    return nearestId;
  }

  /**
   * Find a good spawn node: an intersection (2+ neighbors) close to the target.
   * Falls back to findNearestNode if no intersection is found.
   */
  public findBestSpawnNode(lat: number, lon: number): string {
    let bestId = "";
    let bestScore = -Infinity;

    this.nodes.forEach((node) => {
      if (node.neighbors.length < 2) return; // skip dead-ends
      const dist = Math.sqrt(Math.pow(node.lat - lat, 2) + Math.pow(node.lon - lon, 2));
      // Score: prefer more neighbors, penalize distance
      const score = node.neighbors.length * 0.0001 - dist;
      if (score > bestScore) {
        bestScore = score;
        bestId = node.id;
      }
    });

    return bestId || this.findNearestNode(lat, lon);
  }

  public setInitialPacmanPosition(nodeId: string) {
    this.initialPacmanNodeId = nodeId;
    this.setPacmanPosition(nodeId);
  }

  public getInitialPacmanNodeId() {
    return this.initialPacmanNodeId;
  }

  public setPacmanPosition(nodeId: string) {
    this.pacmanNodeId = nodeId;
    this.collectDot(nodeId);
  }

  public getNextNode(nodeId: string, direction: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): string | null {
    const currentNode = this.nodes.get(nodeId);
    if (!currentNode) return null;

    // Target angle in radians for each direction (in lat/lon space)
    const targetAngle: Record<string, number> = {
      'ArrowRight': 0,
      'ArrowUp': Math.PI / 2,
      'ArrowLeft': Math.PI,
      'ArrowDown': -Math.PI / 2,
    };
    const target = targetAngle[direction];

    let bestNeighbor = "";
    let bestAngleDiff = Infinity;

    currentNode.neighbors.forEach((nbId) => {
      const nb = this.nodes.get(nbId)!;
      const dLat = nb.lat - currentNode.lat;
      const dLon = nb.lon - currentNode.lon;
      if (dLat === 0 && dLon === 0) return;

      const angle = Math.atan2(dLat, dLon);
      let diff = Math.abs(angle - target);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;

      // Accept neighbors within 90° cone
      if (diff < Math.PI / 2 && diff < bestAngleDiff) {
        bestAngleDiff = diff;
        bestNeighbor = nbId;
      }
    });

    return bestNeighbor || null;
  }

  public movePacman(direction: 'up' | 'down' | 'left' | 'right') {
    if (!this.pacmanNodeId) return;

    let dirKey: 'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight' = 'ArrowUp';
    if (direction === 'up') dirKey = 'ArrowUp';
    if (direction === 'down') dirKey = 'ArrowDown';
    if (direction === 'left') dirKey = 'ArrowLeft';
    if (direction === 'right') dirKey = 'ArrowRight';

    const bestNeighbor = this.getNextNode(this.pacmanNodeId, dirKey);
    if (bestNeighbor) {
      this.pacmanNodeId = bestNeighbor;
      this.collectDot(bestNeighbor);
      return this.nodes.get(bestNeighbor);
    }
    return null;
  }

  private collectDot(nodeId: string) {
    if (this.dots.has(nodeId)) {
      this.dots.delete(nodeId);
      this.state.score += 10;
    }
  }

  public getState() {
    return this.state;
  }

  public getDots() {
    return Array.from(this.dots).map(id => this.nodes.get(id)!);
  }
  
  public getPacmanNode() {
    return this.nodes.get(this.pacmanNodeId);
  }

  public getNodes() {
    return this.nodes;
  }
}
