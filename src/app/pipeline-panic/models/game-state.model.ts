import { NodeType, Pipeline } from './pipeline.model';

export interface GameState {
  level: number;
  currentLevel: Level;
  currentPipeline: Pipeline;
  /** Logical release-seconds elapsed in the active dispatch. */
  elapsedTime: number;
  cpu: Resource;
  memory: Resource;
  buildAgents: Resource;
  particlesEnabled: boolean;
}

export interface Level {
  id: string;
  name: string;
  description: string;

  // Requirements
  requiredNodes: NodeType[];
  forbiddenNodes?: NodeType[];

  // Constraints
  maxNodes: number;
  maxConnections: number;
  cpuLimit: number;
  memoryLimit: number;

  // Challenge modifiers
  rushHour?: boolean; // Increased load
  fridayDeploy?: boolean; // Higher failure rate
  legacySystem?: boolean; // Slower processing
  securityAudit?: boolean; // Must pass all scans

  // P4: Dual-scan compliance gate (Level 7+)
  // When true, Deploy requires at least one SAST AND one SCA scan both passing.
  requireDualScanTypes?: boolean;

  /** Explicit rules for the deterministic release-desk experiment. */
  prototypeRules?: {
    /** Skip random node, coverage, scan, and modifier failures. */
    deterministic: true;
    /** Active shared-runner cap. Any positive integer is handled by list scheduling. */
    agentPoolLimit?: number;
    /** Authored conditions available to the prototype; presentation activates one later. */
    conditionCards?: readonly PrototypeConditionCard[];
    /** Require each target node to depend transitively on these upstream node types. */
    dependencyGate?: {
      targetType: NodeType;
      requiredUpstreamTypes: NodeType[];
    };
  };

  /** Maintenance gate in logical release-seconds. */
  parTime: number;
}

/** Machine-readable condition data. Authored labels and presentation live elsewhere. */
export interface PrototypeConditionCard {
  readonly id: 'agent-pool-1';
  readonly agentPoolLimit: 1;
}

/**
 * A level with prototype rules participates in the complete controlled-study
 * contract. Keep speed, randomness, objectives, templates, and forecasts on
 * this single predicate so new rule fields cannot opt into only half the study.
 */
export type ControlledPrototypeLevel = Level & { prototypeRules: NonNullable<Level['prototypeRules']> };

export function isControlledPrototype(level: Level | null | undefined): level is ControlledPrototypeLevel {
  return level?.prototypeRules !== undefined;
}

export interface Resource {
  total: number;
  used: number;
  available: number;
  cost: number; // Per unit cost
}
