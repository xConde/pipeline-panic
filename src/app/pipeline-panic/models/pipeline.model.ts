export interface PipelineNode {
  id: string;
  type: NodeType;
  name: string;
  x: number;
  y: number;
  status: NodeStatus;
  config: NodeConfig;

  // Performance
  processingTime: number;
  cpuUsage: number;
  memoryUsage: number;

  // Connections
  inputs: string[]; // IDs of input nodes
  outputs: string[]; // IDs of output nodes

  // Visual
  color: string;
  icon: string;
  particles: Particle[];

  // Execution history - for retry-aware logging
  executionCount: number; // How many times this node has been executed
  lastStatus: NodeStatus | null; // Previous status before current run
  lastFailureReason?: string; // Why it failed (if applicable)
  retriesRemaining?: number; // Decremented on each retry attempt

  /**
   * Wall-clock ms (Date.now()) when the user placed this node. Drives the scale-in
   * "pop" draw animation. Optional on purpose: template restore, undo/redo replay, and
   * old saves leave it undefined (or stale) and simply render at full radius with no pop.
   */
  placedAt?: number;
}

export enum NodeType {
  Source = 'source',
  Build = 'build',
  Test = 'test',
  SecurityScan = 'security',
  QualityGate = 'quality',
  Deploy = 'deploy',
  Rollback = 'rollback',
  Notification = 'notification',
  Approval = 'approval',
  Parallel = 'parallel',
  Conditional = 'conditional',
  Cache = 'cache',
  Artifact = 'artifact',
}

export enum NodeStatus {
  Idle = 'idle',
  Running = 'running',
  Retrying = 'retrying',
  Success = 'success',
  Failed = 'failed',
  RolledBack = 'rolled-back',
  Skipped = 'skipped',
  Waiting = 'waiting',
  Cancelled = 'cancelled',
}

export type OptimizationLevel = 'fast' | 'balanced' | 'thorough';
export type CoverageThreshold = 50 | 75 | 90 | 100;
export type ScanType = 'sast' | 'sca' | 'secret' | 'container';
export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type DeployStrategy = 'rolling' | 'blue-green' | 'canary';

export interface NodeConfig {
  // Build nodes
  language?: 'javascript' | 'python' | 'java' | 'go' | 'rust';
  buildCommand?: string;
  optimizationLevel?: OptimizationLevel;

  // Test nodes
  testType?: 'unit' | 'integration' | 'e2e' | 'performance';
  coverage?: number;
  coverageThreshold?: CoverageThreshold;
  threshold?: number;

  // Security scan nodes
  scanType?: ScanType;

  // Test nodes (runtime-computed, set by execution service after each run)
  producedCoverage?: number; // Simulated coverage produced for the latest attempt (0–100)

  // Deploy nodes
  environment?: 'dev' | 'staging' | 'production';
  region?: string; // e.g., 'us-east', 'us-west', 'eu-west', 'eu-central', 'apac'
  strategy?: DeployStrategy;
  rollbackEnabled?: boolean;

  // Conditional nodes
  // Determines which output branch to take based on configured condition
  conditionType?: 'all' | 'first' | 'random' | 'round-robin';
  // 'all' - Execute all branches (parallel-like)
  // 'first' - Execute only first connected branch
  // 'random' - Random selection (legacy behavior)
  // 'round-robin' - Cycles through branches on each run
  conditionIndex?: number; // For round-robin, tracks current branch index

  // Resource requirements
  cpuRequired: number;
  memoryRequired: number;
  timeEstimate: number;

  // Failure probability
  failureRate: number; // 0-1
  flakiness: number; // 0-1, chance of random failure

  // Retry behavior
  retryCount?: number; // Max retries on failure (0 = no retry, default)
  retryDelayMs?: number; // Delay before retry in ms (default 1500)
}

export interface Connection {
  id: string;
  sourceId: string;
  targetId: string;
  status: 'active' | 'inactive' | 'broken';
  dataFlow: DataPacket[];
  path?: string; // SVG path data
}

export interface DataPacket {
  id: string;
  type: 'code' | 'artifact' | 'test-result' | 'metrics';
  progress: number; // 0-1 position along connection
  speed: number;
  size: number;
  color: string;
  glowColor: string;
}

export interface Pipeline {
  id: string;
  name: string;
  nodes: PipelineNode[];
  connections: Connection[];

  // Metrics
  totalExecutionTime: number;
  successRate: number;
  throughput: number;

  // Resources
  totalCpuUsed: number;
  totalMemoryUsed: number;
  parallelExecutions: number;

  // Status
  isValid: boolean;
  isRunning: boolean;
  lastRunStatus: 'success' | 'failed' | 'partial';
  errors: PipelineError[];

  // Execution history - for retry-aware logging
  runAttempt: number; // Which attempt this is (1 = first run)
  lastFailedNodeType?: NodeType; // What type of node failed last time
}

export interface PipelineError {
  nodeId: string;
  type: 'connection' | 'resource' | 'config' | 'runtime';
  message: string;
  severity: 'warning' | 'error' | 'critical';
  suggestion?: string;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
}
