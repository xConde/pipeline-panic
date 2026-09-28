import { DEPLOY_STRATEGY_CONFIG, PIPELINE_SCHEDULER_TICK_SECONDS } from '../game-constants';
import { Level } from '../models/game-state.model';
import {
  DeployStrategy,
  NodeConfig,
  NodeType,
  OptimizationLevel,
  Pipeline,
  PipelineNode,
} from '../models/pipeline.model';

const OPTIMIZATION_TIME_MULTIPLIERS: Readonly<Record<OptimizationLevel, number>> = {
  fast: 0.5,
  balanced: 1,
  thorough: 2,
};

const COVERAGE_TIME_MULTIPLIERS: Readonly<Record<number, number>> = {
  50: 0.7,
  75: 1,
  90: 1.4,
  100: 2,
};

const ENVIRONMENT_TIME_MULTIPLIERS: Readonly<Record<string, number>> = {
  dev: 1,
  staging: 0.7,
  production: 1.3,
};

const SUPPORTED_OPTIMIZATION_LEVELS = new Set<string>(Object.keys(OPTIMIZATION_TIME_MULTIPLIERS));
const SUPPORTED_COVERAGE_THRESHOLDS = new Set<number>(
  Object.keys(COVERAGE_TIME_MULTIPLIERS).map((value) => Number(value))
);
const SUPPORTED_ENVIRONMENTS = new Set<string>(Object.keys(ENVIRONMENT_TIME_MULTIPLIERS));
const SUPPORTED_DEPLOY_STRATEGIES = new Set<string>(Object.keys(DEPLOY_STRATEGY_CONFIG));

/** Defensive ceiling: one stage may represent at most ~27 release-hours. */
const MAX_STAGE_DURATION_TICKS = 1_000_000;

export interface SimulatedStage {
  readonly nodeId: string;
  readonly startTick: number;
  readonly endTick: number;
  readonly durationTicks: number;
  readonly executionIndex: number;
  /** Stable lane assignment for projections that need to draw concurrent work separately. */
  readonly lane: number;
  /** Dependency or occupied lane that made this stage start when it did. */
  readonly determiningPredecessorId: string | null;
}

export interface PipelineSchedule {
  readonly tickSeconds: number;
  readonly totalTicks: number;
  readonly totalSeconds: number;
  readonly stages: readonly SimulatedStage[];
  readonly executionOrderNodeIds: readonly string[];
  readonly criticalNodeIds: readonly string[];
}

interface SchedulingAgent {
  readonly lane: number;
  available: boolean;
  lastNodeId: string | null;
}

interface RunningStage {
  readonly stage: SimulatedStage;
  readonly agent: SchedulingAgent;
}

/** Convert scheduler ticks to release-seconds without leaking floating-point tails. */
export function schedulerTicksToSeconds(ticks: number): number {
  return Number((ticks * PIPELINE_SCHEDULER_TICK_SECONDS).toFixed(10));
}

/**
 * Return the exact tick count the execution engine consumes for one stage.
 *
 * The loop intentionally mirrors the runner's repeated progress additions.
 * Decimal durations such as 1s can consume an eleventh 100ms tick because ten
 * binary floating-point additions remain just below one. Keeping that behavior
 * here preserves the authored 11.5s/14.6s routes while giving every consumer one
 * place to account for it.
 */
export function getNodeDurationTicks(node: PipelineNode, level: Level): number | null {
  const effectiveDuration = getNodeEffectiveDurationSeconds(node, level);
  if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) return null;

  const expectedTicks = Math.ceil(effectiveDuration / PIPELINE_SCHEDULER_TICK_SECONDS);
  if (!Number.isSafeInteger(expectedTicks) || expectedTicks > MAX_STAGE_DURATION_TICKS) return null;

  const increment = PIPELINE_SCHEDULER_TICK_SECONDS / effectiveDuration;
  let progress = 0;
  let ticks = 0;

  while (progress < 1 && ticks <= expectedTicks + 2) {
    progress += increment;
    ticks++;
  }

  return progress >= 1 ? ticks : null;
}

/**
 * Deterministically list-schedule a pipeline under the level's resource rules.
 *
 * Authored pipeline order is the only tie-break. An omitted agent limit means
 * unbounded concurrency; any positive integer limit is handled by the same
 * simulation. Invalid timing, duplicate IDs, dangling inputs, cycles, and invalid
 * resource limits return null rather than a plausible-looking partial forecast.
 */
export function simulatePipelineSchedule(pipeline: Pipeline, level: Level): PipelineSchedule | null {
  if (pipeline.nodes.length === 0) return null;

  const nodesById = new Map(pipeline.nodes.map((node) => [node.id, node]));
  if (nodesById.size !== pipeline.nodes.length) return null;

  const authoredIndex = new Map(pipeline.nodes.map((node, index) => [node.id, index]));
  const durationTicksById = new Map<string, number>();
  for (const node of pipeline.nodes) {
    if (node.inputs.some((inputId) => !nodesById.has(inputId))) return null;
    const durationTicks = getNodeDurationTicks(node, level);
    if (durationTicks === null) return null;
    durationTicksById.set(node.id, durationTicks);
  }

  const configuredLimit = level.prototypeRules?.agentPoolLimit;
  if (
    configuredLimit !== undefined &&
    (!Number.isFinite(configuredLimit) || !Number.isInteger(configuredLimit) || configuredLimit <= 0)
  ) {
    return null;
  }

  // A route can never occupy more lanes than it has stages. Bounding the
  // allocation also makes very large, otherwise-valid declarative limits safe.
  const agentCount = Math.min(configuredLimit ?? pipeline.nodes.length, pipeline.nodes.length);
  const resourceConstrained = agentCount < pipeline.nodes.length;
  const agents: SchedulingAgent[] = Array.from({ length: agentCount }, (_, lane) => ({
    lane,
    available: true,
    lastNodeId: null,
  }));

  const remainingIds = new Set(pipeline.nodes.map((node) => node.id));
  const completedIds = new Set<string>();
  const stages: SimulatedStage[] = [];
  const stagesById = new Map<string, SimulatedStage>();
  const running: RunningStage[] = [];
  let currentTick = 0;

  while (remainingIds.size > 0 || running.length > 0) {
    const finishedNow = running
      .filter((entry) => entry.stage.endTick === currentTick)
      .sort((left, right) => left.agent.lane - right.agent.lane);
    for (const entry of finishedNow) {
      completedIds.add(entry.stage.nodeId);
      entry.agent.available = true;
      running.splice(running.indexOf(entry), 1);
    }

    const readyNodes = pipeline.nodes.filter(
      (node) => remainingIds.has(node.id) && node.inputs.every((inputId) => completedIds.has(inputId))
    );

    for (const node of readyNodes) {
      const agent = agents.find((candidate) => candidate.available);
      if (!agent) break;

      const dependencyStages = node.inputs
        .map((inputId) => stagesById.get(inputId))
        .filter((stage): stage is SimulatedStage => stage !== undefined);
      const latestDependencyEnd = dependencyStages.reduce((latest, stage) => Math.max(latest, stage.endTick), 0);
      const dependencyPredecessor = dependencyStages
        .filter((stage) => stage.endTick === latestDependencyEnd)
        .sort(
          (left, right) =>
            (authoredIndex.get(left.nodeId) ?? Number.MAX_SAFE_INTEGER) -
            (authoredIndex.get(right.nodeId) ?? Number.MAX_SAFE_INTEGER)
        )[0];
      const resourcePredecessor = resourceConstrained && currentTick > latestDependencyEnd ? agent.lastNodeId : null;
      const durationTicks = durationTicksById.get(node.id);
      if (durationTicks === undefined) return null;

      const stage: SimulatedStage = {
        nodeId: node.id,
        startTick: currentTick,
        endTick: currentTick + durationTicks,
        durationTicks,
        executionIndex: stages.length,
        lane: agent.lane,
        determiningPredecessorId: resourcePredecessor ?? dependencyPredecessor?.nodeId ?? null,
      };

      agent.available = false;
      agent.lastNodeId = node.id;
      remainingIds.delete(node.id);
      stages.push(stage);
      stagesById.set(node.id, stage);
      running.push({ stage, agent });
    }

    if (running.length === 0) {
      // Nothing can run while unscheduled work remains: the graph is cyclic.
      if (remainingIds.size > 0) return null;
      break;
    }

    currentTick = running.reduce((next, entry) => Math.min(next, entry.stage.endTick), Number.POSITIVE_INFINITY);
  }

  const finalStage = [...stages].sort((left, right) => {
    if (right.endTick !== left.endTick) return right.endTick - left.endTick;
    return (
      (authoredIndex.get(left.nodeId) ?? Number.MAX_SAFE_INTEGER) -
      (authoredIndex.get(right.nodeId) ?? Number.MAX_SAFE_INTEGER)
    );
  })[0];
  if (!finalStage) return null;

  const criticalNodeIds: string[] = [];
  const criticalSeen = new Set<string>();
  let criticalCursor: SimulatedStage | undefined = finalStage;
  while (criticalCursor) {
    if (criticalSeen.has(criticalCursor.nodeId)) return null;
    criticalSeen.add(criticalCursor.nodeId);
    criticalNodeIds.unshift(criticalCursor.nodeId);
    criticalCursor = criticalCursor.determiningPredecessorId
      ? stagesById.get(criticalCursor.determiningPredecessorId)
      : undefined;
  }

  return {
    tickSeconds: PIPELINE_SCHEDULER_TICK_SECONDS,
    totalTicks: finalStage.endTick,
    totalSeconds: schedulerTicksToSeconds(finalStage.endTick),
    stages,
    executionOrderNodeIds: stages.map((stage) => stage.nodeId),
    criticalNodeIds,
  };
}

export function getNodeEffectiveDurationSeconds(node: PipelineNode, _level: Level): number {
  return node.config.timeEstimate * getNodeConfigTimeMultiplier(node);
}

/**
 * Validate the optional configuration values that change simulated duration.
 * Properties are read as unknown so restored or JavaScript-authored data cannot
 * rely on TypeScript's compile-time unions at this runtime boundary.
 */
export function hasSupportedNodeTimingConfiguration(type: NodeType, config: Readonly<NodeConfig>): boolean {
  switch (type) {
    case NodeType.Build: {
      const optimization: unknown = config.optimizationLevel;
      return (
        optimization === undefined ||
        (typeof optimization === 'string' && SUPPORTED_OPTIMIZATION_LEVELS.has(optimization))
      );
    }
    case NodeType.Test: {
      const coverage: unknown = config.coverageThreshold;
      return coverage === undefined || (typeof coverage === 'number' && SUPPORTED_COVERAGE_THRESHOLDS.has(coverage));
    }
    case NodeType.Deploy: {
      const environment: unknown = config.environment;
      const strategy: unknown = config.strategy;
      return (
        (environment === undefined || (typeof environment === 'string' && SUPPORTED_ENVIRONMENTS.has(environment))) &&
        (strategy === undefined || (typeof strategy === 'string' && SUPPORTED_DEPLOY_STRATEGIES.has(strategy)))
      );
    }
    default:
      return true;
  }
}

export function getNodeConfigTimeMultiplier(node: PipelineNode): number {
  if (!hasSupportedNodeTimingConfiguration(node.type, node.config)) return Number.NaN;

  switch (node.type) {
    case NodeType.Build: {
      const optimization = node.config.optimizationLevel ?? 'balanced';
      return OPTIMIZATION_TIME_MULTIPLIERS[optimization];
    }
    case NodeType.Test: {
      const coverage = node.config.coverageThreshold ?? 75;
      return COVERAGE_TIME_MULTIPLIERS[coverage];
    }
    case NodeType.Deploy: {
      const environment = node.config.environment ?? 'staging';
      const environmentMultiplier = ENVIRONMENT_TIME_MULTIPLIERS[environment];
      const strategy: DeployStrategy = node.config.strategy ?? 'rolling';
      return environmentMultiplier * DEPLOY_STRATEGY_CONFIG[strategy].timeMultiplier;
    }
    default:
      return 1;
  }
}
