

export interface GameNode {
  id: string;
  lat: number;
  lon: number;
  neighbors: string[]; // Neighbor node IDs
}

export interface Building {
  id: string;
  nodes: { lat: number, lon: number }[];
}

export interface Tree {
  id: string;
  lat: number;
  lon: number;
}

export interface GameState {
  score: number;
  lives: number;
  isGameOver: boolean;
  powerUpActive: boolean;
  powerUpEndTime: number;
}

export class GameEngine {
  private nodes: Map<string, GameNode> = new Map();
  private dots: Set<string> = new Set(); // Node IDs where dots are located
  private powerItems: Set<string> = new Set(); // Node IDs for code blocks
  private rocketItems: Set<string> = new Set(); // Node IDs for rocket items
  private buildings: Building[] = [];
  private trees: Tree[] = [];
  private pacmanNodeId: string = "";
  private initialPacmanNodeId: string = "";
  private state: GameState = { score: 0, lives: 3, isGameOver: false, powerUpActive: false, powerUpEndTime: 0 };

  constructor() {}

  public buildGraph(osmData: any) {
    this.nodes.clear();
    this.dots.clear();
    this.powerItems.clear();
    this.rocketItems.clear();
    this.buildings = [];
    this.trees = [];

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

      // Collect buildings
      if (way.tags && way.tags.building) {
        const bNodes: {lat: number, lon: number}[] = [];
        for (let i = 0; i < way.nodes.length; i++) {
          const osmNode = nodeLookup.get(way.nodes[i]);
          if (osmNode) {
            bNodes.push({ lat: osmNode.lat, lon: osmNode.lon });
          }
        }
        if (bNodes.length > 2) {
          this.buildings.push({ id: way.id.toString(), nodes: bNodes });
        }
      }
    });

    // Collect trees
    nodeElements.forEach((n: any) => {
      if (n.tags && n.tags.natural === 'tree') {
        this.trees.push({ id: n.id.toString(), lat: n.lat, lon: n.lon });
      }
    });

    // 2. Initial dots and power items
    this.nodes.forEach((_, id) => this.dots.add(id));
    
    // Randomly select 2-3 nodes to be power items (intersections only)
    const intersections = Array.from(this.nodes.keys()).filter(id => this.nodes.get(id)!.neighbors.length > 2);
    const count = Math.min(intersections.length, 3);
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * intersections.length);
      const id = intersections.splice(idx, 1)[0];
      this.dots.delete(id);
      this.powerItems.add(id);
    }

    // Randomly select 2-3 nodes to be rocket items
    const possibleRocketNodes = Array.from(this.nodes.keys()).filter(id => !this.powerItems.has(id) && this.nodes.get(id)!.neighbors.length > 2);
    const rocketCount = Math.min(possibleRocketNodes.length, 3);
    for (let i = 0; i < rocketCount; i++) {
      const idx = Math.floor(Math.random() * possibleRocketNodes.length);
      const id = possibleRocketNodes.splice(idx, 1)[0];
      this.dots.delete(id);
      this.rocketItems.add(id);
    }
    
    // ✅ Keep only the largest connected component (remove isolated road islands)
    this.keepLargestConnectedComponent();

    console.log(`Graph built with ${this.nodes.size} nodes, ${this.powerItems.size} power items, and ${this.rocketItems.size} rockets.`);
  }

  /**
   * BFS to find all connected components, then discard everything
   * except the largest one. This prevents isolated road islands.
   */
  private keepLargestConnectedComponent() {
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const id of this.nodes.keys()) {
      if (visited.has(id)) continue;

      // BFS from this node
      const component: string[] = [];
      const queue: string[] = [id];
      visited.add(id);

      while (queue.length > 0) {
        const current = queue.shift()!;
        component.push(current);
        const node = this.nodes.get(current)!;
        for (const neighborId of node.neighbors) {
          if (!visited.has(neighborId) && this.nodes.has(neighborId)) {
            visited.add(neighborId);
            queue.push(neighborId);
          }
        }
      }

      components.push(component);
    }

    if (components.length <= 1) return; // Already fully connected

    // Find largest component
    let largest = components[0];
    for (const comp of components) {
      if (comp.length > largest.length) largest = comp;
    }

    const keepSet = new Set(largest);
    const toRemove = Array.from(this.nodes.keys()).filter(id => !keepSet.has(id));

    console.log(`Connectivity: ${components.length} components found. Keeping ${largest.length} nodes, removing ${toRemove.length}.`);

    for (const id of toRemove) {
      this.nodes.delete(id);
      this.dots.delete(id);
      this.powerItems.delete(id);
      this.rocketItems.delete(id);
    }

    // Clean up dangling neighbor references
    for (const node of this.nodes.values()) {
      node.neighbors = node.neighbors.filter(nId => this.nodes.has(nId));
    }
  }

  public resetGame() {
    this.dots.clear();
    this.powerItems.clear();
    this.rocketItems.clear();
    this.nodes.forEach((_, id) => this.dots.add(id));
    
    const intersections = Array.from(this.nodes.keys()).filter(id => this.nodes.get(id)!.neighbors.length > 2);
    
    // Power items
    const powerCount = Math.min(intersections.length, 3);
    const chosenIntersections = [...intersections];
    for (let i = 0; i < powerCount; i++) {
        const idx = Math.floor(Math.random() * chosenIntersections.length);
        const id = chosenIntersections.splice(idx, 1)[0];
        this.dots.delete(id);
        this.powerItems.add(id);
    }

    // Rocket items
    const rocketCount = Math.min(chosenIntersections.length, 3);
    for (let i = 0; i < rocketCount; i++) {
        const idx = Math.floor(Math.random() * chosenIntersections.length);
        const id = chosenIntersections.splice(idx, 1)[0];
        this.dots.delete(id);
        this.rocketItems.add(id);
    }

    this.pacmanNodeId = "";
    this.initialPacmanNodeId = "";
    this.state.score = 0;
    this.state.lives = 3;
    this.state.isGameOver = false;
    this.state.powerUpActive = false;
    this.state.powerUpEndTime = 0;
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
    } else if (this.powerItems.has(nodeId)) {
      this.powerItems.delete(nodeId);
      this.state.score += 50;
      this.activatePowerUp();
    } else if (this.rocketItems.has(nodeId)) {
      this.rocketItems.delete(nodeId);
      this.state.score += 100;
      // Trigger event or callback for rocket launch
      (window as any).dispatchGameEvent?.('launch-rocket');
    }
  }

  private activatePowerUp() {
    this.state.powerUpActive = true;
    this.state.powerUpEndTime = performance.now() + 20000; // 20 seconds
  }

  public updatePowerUp(now: number) {
    if (this.state.powerUpActive && now > this.state.powerUpEndTime) {
      this.state.powerUpActive = false;
    }
  }

  public eatGhost() {
    this.state.score += 200;
  }

  public getState() {
    return this.state;
  }

  public getDots() {
    return Array.from(this.dots)
      .map(id => this.nodes.get(id))
      .filter((n): n is GameNode => !!n);
  }

  public getPowerItems() {
    return Array.from(this.powerItems)
      .map(id => this.nodes.get(id))
      .filter((n): n is GameNode => !!n);
  }

  public getRocketItems() {
    return Array.from(this.rocketItems)
      .map(id => this.nodes.get(id))
      .filter((n): n is GameNode => !!n);
  }
  
  public getPacmanNode() {
    return this.nodes.get(this.pacmanNodeId);
  }

  public getNodes() {
    return this.nodes;
  }

  public getBuildings() {
    return this.buildings;
  }

  public getTrees() {
    return this.trees;
  }
}
