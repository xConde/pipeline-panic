import { Injectable, OnDestroy } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { PipelineExecutionService } from './pipeline-execution.service';
import { PipelineBuilderService } from './pipeline-builder.service';
import { ResourceManagerService } from './resource-manager.service';
import {
  DeployStrategy,
  FindingSeverity,
  NodeConfig,
  NodeStatus,
  NodeType,
  OptimizationLevel,
  Pipeline,
  PipelineNode,
  ScanType,
} from '../models/pipeline.model';
import { isControlledPrototype, Level } from '../models/game-state.model';
import {
  CONTROLLED_PROTOTYPE_PLAYBACK_RATE,
  DEPLOY_STRATEGY_CONFIG,
  DEPLOY_STRATEGY_FAILURE_RATES,
  GAME_CONSTANTS,
  PIPELINE_SCHEDULER_TICK_SECONDS,
} from '../game-constants';
import {
  getNodeDurationTicks,
  getNodeEffectiveDurationSeconds,
  PipelineSchedule,
  schedulerTicksToSeconds,
  simulatePipelineSchedule,
} from './pipeline-scheduling';

// ─── P6: Deterministic Cache Key ─────────────────────────────────────────────

/**
 * P6+P5 shared: Cache is a hit when at least one Build node has reached Success
 * earlier in the SAME run. On first run or before any Build completes, it is always
 * a MISS. This replaces the Math.random() < CACHE_HIT_RATE stochastic approach.
 */
// (Implementation via _buildSucceededThisRun private field on the service.)

// ─── Config Effect Multipliers ───────────────────────────────────────────────

/** Failure rate multipliers for build optimization levels */
const OPTIMIZATION_FAILURE_MULTIPLIERS: Record<OptimizationLevel, number> = {
  fast: 1.5,
  balanced: 1,
  thorough: 0.5,
};

/** Browser timers clamp shorter delays and overflow signed 32-bit delays. */
const MIN_BROWSER_TIMER_DELAY_MS = 1;
const MAX_BROWSER_TIMER_DELAY_MS = 2_147_483_647;

// ─── Internal Types ─────────────────────────────────────────────────────────────

interface NodeExecutionState {
  progress: number;
  elapsedTicks: number;
  durationTicks: number | null;
  scheduledStartTick: number | null;
  startTime: number; // wall-clock start for timeout
  pausedDurationAtStart: number; // snapshot of _totalPausedMs when node started
  intervalId: ReturnType<typeof setInterval>;
  // Evaluated once per execution attempt. A retry creates a new state and a fresh
  // transient roll; changing game speed preserves this guard.
  purposefulFailureChecked: boolean;
  // P4: guard so the midpoint config-failure roll + SecurityScan severity gate fire
  // EXACTLY ONCE per execution. A progress-window check double-fired (window wider than
  // one tick), turning the advertised 23% severity-fail rate into ~41%.
  midGateRolled: boolean;
}

// ─── Event Types ────────────────────────────────────────────────────────────────

export interface ParallelInfo {
  readonly jobCount: number;
  readonly nodeNames: string;
  readonly savedTime: number;
  readonly maxTime: number;
  readonly sumTime: number;
}

export interface PipelineResult {
  readonly success: boolean;
  readonly missingRequired: boolean;
  readonly failedCount: number;
  readonly cancelledCount: number;
  readonly successCount: number;
  /** Number of Deploy nodes whose status is RolledBack (not a hard failure). */
  readonly rolledBackCount: number;
  readonly totalNodes: number;
  /** Deterministic consequences attached to the artifact by speed-saving choices. */
  readonly artifactMarks: readonly ReleaseArtifactMark[];
}

export type ReleaseArtifactMarkCode = 'unoptimized' | 'low-evidence' | 'partial-rollout';

/** Machine-readable run data. Presentation and authored labels live outside the runner. */
export interface ReleaseArtifactMark {
  readonly code: ReleaseArtifactMarkCode;
  readonly nodeId: string;
  readonly secondsSaved: number;
}

/**
 * Scheduler-owned prediction for the longest dependency chain in a pipeline.
 * Duration is expressed in logical game seconds (100 ms scheduler ticks), so
 * the pre-run forecast and the measured execution use the same timing model.
 */
export interface CriticalPathEstimate {
  readonly durationSeconds: number;
  readonly nodeIds: readonly string[];
  readonly nodeNames: readonly string[];
}

/**
 * When each stage occupies the maintenance window, in the same logical game
 * seconds the forecast and the measured run use.
 *
 * This exists so the rail can draw stage widths from the scheduler's own timing
 * model instead of re-deriving durations in the view, where the two would drift.
 */
export interface ScheduledStage {
  readonly nodeId: string;
  readonly name: string;
  readonly color: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly onCriticalPath: boolean;
  readonly lane: number;
}

/**
 * Discriminated union of all events the runner can emit.
 *
 * The component subscribes to events$ and handles presentation concerns
 * (audio, particles, rail and receipt). The runner only owns execution flow
 * and node state transitions.
 *
 * RxJS Subject is synchronous — when the runner emits, the component's
 * handler runs to completion before the runner continues. This preserves
 * ordering: e.g. stat updates in the handler happen before downstream
 * nodes start executing.
 */
export type RunnerEvent =
  | {
      readonly type: 'started';
      readonly isRetry: boolean;
      readonly runAttempt: number;
      readonly lastFailedNodeType?: NodeType;
    }
  | { readonly type: 'node-started'; readonly node: PipelineNode; readonly isRetry: boolean }
  | { readonly type: 'node-success'; readonly node: PipelineNode; readonly parallelInfo?: ParallelInfo }
  | {
      readonly type: 'node-failure';
      readonly node: PipelineNode;
      readonly reason: string;
      readonly rollbackTriggered: boolean;
    }
  | { readonly type: 'node-retry'; readonly node: PipelineNode; readonly attemptNumber: number }
  | {
      readonly type: 'cache-result';
      readonly node: PipelineNode;
      readonly isHit: boolean;
      readonly message: string;
    }
  | { readonly type: 'node-skipped'; readonly node: PipelineNode }
  | { readonly type: 'node-cancelled'; readonly node: PipelineNode }
  | { readonly type: 'logical-time'; readonly elapsedSeconds: number; readonly elapsedTicks: number }
  | { readonly type: 'conditional-route'; readonly conditionType: string; readonly message: string }
  | { readonly type: 'pipeline-complete'; readonly result: PipelineResult }
  | { readonly type: 'rollback-complete'; readonly node: PipelineNode }
  | { readonly type: 'stopped' }
  | { readonly type: 'execution-warning'; readonly message: string }
  | {
      readonly type: 'scan-warning';
      readonly node: PipelineNode;
      readonly severity: FindingSeverity;
      readonly finding: string;
      readonly tool: string;
      readonly scanType: ScanType;
    }
  | {
      readonly type: 'coverage-warn';
      readonly node: PipelineNode;
      readonly produced: number;
      readonly threshold: number;
    }
  | {
      /** Emitted before the generic node failure so a UI can explain the coverage gate. */
      readonly type: 'coverage-fail';
      readonly node: PipelineNode;
      readonly produced: number;
      readonly threshold: number;
    }
  | {
      /** Emitted before the generic failure so a UI can name the missing scan type. */
      readonly type: 'dual-scan-fail';
      readonly node: PipelineNode;
      readonly missingType: ScanType;
    }
  | {
      /** Emitted at Deploy start so a UI can explain the selected strategy. */
      readonly type: 'deploy-strategy-info';
      readonly node: PipelineNode;
      readonly strategy: DeployStrategy;
      readonly trafficModel: string;
      readonly rollbackSpeedLabel: string;
      readonly blastRadius: string;
    };

// ─── Service ────────────────────────────────────────────────────────────────────

/**
 * Owns pipeline execution lifecycle: start → tick → success/fail → complete.
 *
 * Responsibilities:
 * - Interval management (per-node progress simulation)
 * - Node state transitions (Idle → Running → Success/Failed/Skipped/Cancelled)
 * - Downstream resolution (conditional routing, skip propagation, cascading cancellation)
 * - Pipeline completion detection
 *
 * Does NOT own:
 * - Player-facing narration (emits events, component calls its announce() helper)
 * - Audio/particles (emits events, component handles presentation)
 * - Score/stats (emits events, component updates GameState)
 * - Game tick / animation loop (stays in GameLoopService)
 */
@Injectable()
export class PipelineRunnerService implements OnDestroy {
  private readonly eventsSubject = new Subject<RunnerEvent>();
  readonly events$: Observable<RunnerEvent> = this.eventsSubject.asObservable();

  private readonly executionStates = new Map<string, NodeExecutionState>();
  private readonly activeRollbackTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private readonly activeRetryTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private readonly readyQueue: PipelineNode[] = [];
  private readonly queuedNodeIds = new Set<string>();
  private readonly allocatedAgentNodeIds = new Set<string>();
  private readonly scheduleOrderByNodeId = new Map<string, number>();

  private _isRunning = false;
  private _isPaused = false;
  private _gameSpeed = 1;
  private _playbackRate = 1;
  private _logicalElapsedTicks = 0;
  private activePrototypeSchedule: PipelineSchedule | null = null;

  /**
   * P6: Deterministic cache key tracking.
   * Set to true the moment any Build node reaches Success in the current run.
   * A Cache node is a HIT iff this flag is true when the cache node starts.
   * Cleared on startPipeline(), reset(), and destroy().
   */
  private _buildSucceededThisRun = false;

  // Pending rollback count — checkPipelineComplete() returns early if > 0.
  // A deploy that just failed may have a rollback in-flight; we must not
  // treat it as Failed for pipeline-complete purposes until it settles.
  private _pendingRollbacks = 0;

  // Pause/resume time tracking
  private _pauseStartTime = 0;
  private _totalPausedMs = 0;

  // Stuck detection
  private _stuckWatchdogId: ReturnType<typeof setInterval> | null = null;
  private _lastProgressTime = 0;

  // Visibility change tracking (separate from user-initiated pause)
  private _pausedByVisibility = false;

  private pipeline: Pipeline | null = null;
  private level: Level | null = null;
  private levelIndex = 0;

  get isRunning(): boolean {
    return this._isRunning;
  }
  get isPaused(): boolean {
    return this._isPaused;
  }
  get gameSpeed(): number {
    return this._gameSpeed;
  }
  get playbackRate(): number {
    return this._playbackRate;
  }
  get logicalElapsedSeconds(): number {
    return schedulerTicksToSeconds(this._logicalElapsedTicks);
  }

  constructor(
    private readonly executionService: PipelineExecutionService,
    private readonly pipelineBuilder: PipelineBuilderService,
    private readonly resourceManager: ResourceManagerService
  ) {}

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Predict the pipeline's completion time from its longest dependency chain.
   * Returns null for an empty graph, a cycle, or a dangling input reference.
   */
  estimateCriticalPath(pipeline: Pipeline, level: Level): CriticalPathEstimate | null {
    const schedule = simulatePipelineSchedule(pipeline, level);
    if (!schedule) return null;

    const nodesById = new Map(pipeline.nodes.map((node) => [node.id, node]));
    const criticalNodes = schedule.criticalNodeIds
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is PipelineNode => node !== undefined);
    if (criticalNodes.length !== schedule.criticalNodeIds.length) return null;

    return {
      durationSeconds: schedule.totalSeconds,
      nodeIds: schedule.criticalNodeIds,
      nodeNames: criticalNodes.map((node) => node.name),
    };
  }

  /**
   * Lay every stage out on the maintenance window.
   *
   * Mirrors the execution model exactly: unconstrained runs start each stage as
   * soon as its inputs finish, and a one-agent pool serialises them in authored
   * pipeline order, which is the same deterministic tie-break drainReadyQueue uses.
   *
   * Returns an empty list for an empty graph, a cycle, or a dangling input, which
   * are the same conditions that make estimateCriticalPath return null.
   */
  buildDisplaySchedule(pipeline: Pipeline, level: Level): readonly ScheduledStage[] {
    const schedule = simulatePipelineSchedule(pipeline, level);
    if (!schedule) return [];

    const nodesById = new Map(pipeline.nodes.map((node) => [node.id, node]));
    const criticalPathIds = new Set(schedule.criticalNodeIds);
    return schedule.stages
      .map((stage) => {
        const node = nodesById.get(stage.nodeId);
        if (!node) return null;
        return {
          nodeId: stage.nodeId,
          name: node.name,
          color: node.color,
          startSeconds: schedulerTicksToSeconds(stage.startTick),
          endSeconds: schedulerTicksToSeconds(stage.endTick),
          onCriticalPath: criticalPathIds.has(stage.nodeId),
          lane: stage.lane,
        };
      })
      .filter((stage): stage is ScheduledStage => stage !== null);
  }

  /**
   * Validate and start pipeline execution.
   * @returns true if execution started, false if validation failed.
   * On failure, the component should read pipeline.errors for details.
   */
  startPipeline(
    pipeline: Pipeline,
    level: Level,
    levelIndex: number,
    gameSpeed: number,
    playbackRate = isControlledPrototype(level) ? CONTROLLED_PROTOTYPE_PLAYBACK_RATE : 1
  ): boolean {
    if (this._isRunning) {
      return false;
    }

    const isValid = this.pipelineBuilder.validatePipeline(pipeline);
    if (!isValid) {
      return false;
    }

    const dependencyGate = level.prototypeRules?.dependencyGate;
    if (
      dependencyGate &&
      !this.pipelineBuilder.hasRequiredUpstreamNodes(
        pipeline,
        dependencyGate.targetType,
        dependencyGate.requiredUpstreamTypes
      )
    ) {
      const requiredTypes = dependencyGate.requiredUpstreamTypes.join(', ');
      pipeline.errors.push({
        nodeId: '',
        type: 'connection',
        message: `Release gate bypassed: every ${dependencyGate.targetType} must depend on ${requiredTypes}`,
        severity: 'error',
        suggestion: 'Rewire the release path so Test and Security Scan finish before Deploy.',
      });
      pipeline.isValid = false;
      return false;
    }

    const prototypeSchedule = isControlledPrototype(level) ? simulatePipelineSchedule(pipeline, level) : null;
    if (isControlledPrototype(level) && !prototypeSchedule) {
      pipeline.errors.push({
        nodeId: '',
        type: 'runtime',
        message: 'Release schedule could not be computed from this route',
        severity: 'error',
        suggestion: 'Check stage timing, dependencies, and the active agent-pool condition.',
      });
      pipeline.isValid = false;
      return false;
    }

    this.pipeline = pipeline;
    this.level = level;
    this.levelIndex = levelIndex;
    this._gameSpeed = isControlledPrototype(level) ? 1 : gameSpeed;
    this._playbackRate = isControlledPrototype(level) ? this.normalizePlaybackRate(playbackRate) : 1;
    this._logicalElapsedTicks = 0;
    this.activePrototypeSchedule = prototypeSchedule;
    this.scheduleOrderByNodeId.clear();
    prototypeSchedule?.executionOrderNodeIds.forEach((nodeId, index) => {
      this.scheduleOrderByNodeId.set(nodeId, index);
    });
    this._isRunning = true;
    this._isPaused = false;
    this._totalPausedMs = 0;
    this._pauseStartTime = 0;
    this._lastProgressTime = Date.now();
    // P6: Reset cache key for new run — every run starts with a MISS until a Build succeeds.
    this._buildSucceededThisRun = false;
    this.readyQueue.length = 0;
    this.queuedNodeIds.clear();
    this.allocatedAgentNodeIds.clear();
    this.resourceManager.resetBuildAgents(level.prototypeRules?.agentPoolLimit ?? GAME_CONSTANTS.DEFAULT_BUILD_AGENTS);

    // Track run attempts for retry-aware logging
    pipeline.runAttempt++;
    const isRetry = pipeline.runAttempt > 1;

    this.emit({
      type: 'started',
      isRetry,
      runAttempt: pipeline.runAttempt,
      lastFailedNodeType: isRetry ? pipeline.lastFailedNodeType : undefined,
    });

    this.startStuckWatchdog();

    if (isControlledPrototype(level)) {
      // Input-less stages are roots in the timing model regardless of their type.
      // Starting the same set here prevents floating nodes from appearing only in
      // the forecast while leaving the actual run permanently idle.
      this.enqueueReadyPrototypeNodes();
    } else {
      // Preserve the campaign's existing Source-only execution entry point.
      pipeline.nodes.filter((node) => node.type === NodeType.Source).forEach((node) => this.scheduleNode(node, false));
      this.drainReadyQueue();
    }

    return true;
  }

  /** Stop pipeline execution immediately. Cancels all running nodes. */
  stopPipeline(): void {
    this._isRunning = false;
    this._pausedByVisibility = false;
    this.clearAllExecutions();
    this.clearAllRollbackTimeouts();
    this.clearAllRetryTimeouts();
    // Symmetry with reset()/cleanup(): a stop mid-rollback must not leave a stale
    // pending count that would make the next run's checkPipelineComplete() hang.
    this._pendingRollbacks = 0;

    if (this.pipeline) {
      this.pipeline.nodes.forEach((node) => {
        if (node.status === NodeStatus.Running || node.status === NodeStatus.Retrying) {
          node.status = NodeStatus.Cancelled;
        }
      });
    }

    this.emit({ type: 'stopped' });
  }

  pauseExecution(): void {
    if (!this._isPaused) {
      this._isPaused = true;
      this._pauseStartTime = Date.now();
    }
  }

  resumeExecution(): void {
    if (this._isPaused) {
      this._totalPausedMs += Date.now() - this._pauseStartTime;
      this._isPaused = false;
    }
  }

  setGameSpeed(speed: number): void {
    const nextSpeed = this._isRunning && isControlledPrototype(this.level) ? 1 : speed;
    if (nextSpeed === this._gameSpeed) return;
    this._gameSpeed = nextSpeed;

    // Recreate intervals for all running nodes at new speed
    if (this._isRunning && this.executionStates.size > 0) {
      this.recreateIntervalsAtCurrentSpeed();
    }
  }

  /** Change controlled-prototype wall-clock pacing without changing release time. */
  setPlaybackRate(rate: number): void {
    if (!isControlledPrototype(this.level)) return;
    const nextRate = this.normalizePlaybackRate(rate);
    if (nextRate === this._playbackRate) return;
    this._playbackRate = nextRate;

    if (this._isRunning) {
      this.recreateIntervalsAtCurrentSpeed();
    }
  }

  /** Reset execution state for level transitions. Does not null references. */
  reset(): void {
    this.clearAllExecutions();
    this.clearAllRetryTimeouts();
    this._isRunning = false;
    this._isPaused = false;
    this._pausedByVisibility = false;
    this._totalPausedMs = 0;
    this._pauseStartTime = 0;
    this._pendingRollbacks = 0;
    this._logicalElapsedTicks = 0;
    this._playbackRate = 1;
    this.activePrototypeSchedule = null;
    this.scheduleOrderByNodeId.clear();
    // P6: Clear cache key so next run starts fresh.
    this._buildSucceededThisRun = false;
  }

  /** Full cleanup. Call from component's ngOnDestroy. */
  destroy(): void {
    this.clearAllExecutions();
    this.clearAllRetryTimeouts();
    this._isRunning = false;
    this._isPaused = false;
    this._pausedByVisibility = false;
    this._totalPausedMs = 0;
    this._pauseStartTime = 0;
    this._pendingRollbacks = 0;
    this._logicalElapsedTicks = 0;
    this._playbackRate = 1;
    this.activePrototypeSchedule = null;
    this.scheduleOrderByNodeId.clear();
    // P6: Clear cache key.
    this._buildSucceededThisRun = false;
    this.pipeline = null;
    this.level = null;
  }

  /** Auto-invoked by Angular when the injector is destroyed. Delegates to destroy(). */
  ngOnDestroy(): void {
    this.destroy();
  }

  /** Pause execution for tab visibility change. Does not affect user-initiated pause. */
  onTabHidden(): void {
    if (this._isRunning && !this._isPaused) {
      this._pausedByVisibility = true;
      this.pauseExecution();
    }
  }

  /** Resume execution after tab becomes visible. Only resumes if we paused it. */
  onTabVisible(): void {
    if (this._pausedByVisibility) {
      this._pausedByVisibility = false;
      this.resumeExecution();
    }
  }

  // ─── Execution Flow ─────────────────────────────────────────────────────────

  private scheduleNode(node: PipelineNode, drainImmediately = true): void {
    if (!this._isRunning || !this.pipeline || !this.level) return;
    const pipeline = this.pipeline;

    if (!isControlledPrototype(this.level)) {
      this.executeNode(node);
      return;
    }

    if (
      (node.status !== NodeStatus.Idle && node.status !== NodeStatus.Retrying) ||
      this.queuedNodeIds.has(node.id) ||
      this.allocatedAgentNodeIds.has(node.id)
    ) {
      return;
    }

    this.readyQueue.push(node);
    this.queuedNodeIds.add(node.id);
    // Consume the simulation's execution order rather than rebuilding the
    // scheduler's tie-break from adjacency order inside the runner.
    this.readyQueue.sort((left, right) => {
      const leftOrder = this.scheduleOrderByNodeId.get(left.id) ?? pipeline.nodes.indexOf(left);
      const rightOrder = this.scheduleOrderByNodeId.get(right.id) ?? pipeline.nodes.indexOf(right);
      return leftOrder - rightOrder;
    });
    if (drainImmediately) {
      this.drainReadyQueue();
    }
  }

  private drainReadyQueue(): void {
    if (!this._isRunning || !isControlledPrototype(this.level)) return;

    const agentPoolLimit = this.level.prototypeRules.agentPoolLimit;

    while (this.readyQueue.length > 0) {
      if (agentPoolLimit !== undefined && !this.resourceManager.allocateBuildAgent()) break;
      const node = this.readyQueue.shift();
      if (!node) {
        if (agentPoolLimit !== undefined) this.resourceManager.freeBuildAgent();
        break;
      }
      this.queuedNodeIds.delete(node.id);
      if (node.status !== NodeStatus.Idle && node.status !== NodeStatus.Retrying) {
        if (agentPoolLimit !== undefined) this.resourceManager.freeBuildAgent();
        continue;
      }
      if (agentPoolLimit !== undefined) this.allocatedAgentNodeIds.add(node.id);
      this.executeNode(node);
    }
  }

  /** Queue every newly-ready prototype stage as one batch, in schedule order. */
  private enqueueReadyPrototypeNodes(): void {
    if (!this._isRunning || !this.pipeline || !isControlledPrototype(this.level)) return;

    const readyNodes = this.pipeline.nodes.filter(
      (node) =>
        (node.status === NodeStatus.Idle || node.status === NodeStatus.Retrying) &&
        node.inputs.every(
          (inputId) => this.pipeline?.nodes.find((candidate) => candidate.id === inputId)?.status === NodeStatus.Success
        )
    );
    readyNodes.forEach((node) => this.scheduleNode(node, false));
    this.drainReadyQueue();
  }

  private executeNode(node: PipelineNode): void {
    if (!this._isRunning || !this.pipeline || !this.level) return;

    // Initialize retriesRemaining on first execution
    if (node.executionCount === 0) {
      node.retriesRemaining = node.config.retryCount ?? GAME_CONSTANTS.DEFAULT_RETRY_COUNT;
    }

    // Track execution history for retry-aware logging
    node.lastStatus = node.status;
    node.executionCount++;
    const isRetry = node.executionCount > 1;

    node.status = NodeStatus.Running;

    // Emit node-started BEFORE mock output so component can log in order
    this.emit({ type: 'node-started', node, isRetry });

    // P5: For Deploy nodes, emit strategy info so the component can log a strategy
    // header before the detailed mock output lines.
    if (node.type === NodeType.Deploy) {
      const strategy: DeployStrategy = node.config.strategy ?? 'rolling';
      const strategyConfig = DEPLOY_STRATEGY_CONFIG[strategy];
      this.emit({
        type: 'deploy-strategy-info',
        node,
        strategy,
        trafficModel: strategyConfig.trafficModel,
        rollbackSpeedLabel: strategyConfig.rollbackSpeedLabel,
        blastRadius: strategyConfig.blastRadius,
      });
    }

    // P6: Cache node — deterministic hit/miss based on whether a Build has succeeded
    // earlier in this same run. HIT = _buildSucceededThisRun is true. MISS otherwise.
    if (node.type === NodeType.Cache) {
      const isHit = this._buildSucceededThisRun;
      const message = isHit
        ? '[CACHE] HIT: upstream build succeeded this run, artifacts reused'
        : '[CACHE] MISS: no successful build upstream yet, rebuilding from source';
      this.emit({ type: 'cache-result', node, isHit, message });
      if (isHit) {
        // Cache hit: complete instantly
        node.status = NodeStatus.Success;
        node.lastFailureReason = 'cache-hit';
        this.clearNodeExecution(node.id);
        this.emit({ type: 'node-success', node });
        this.resolveDownstream(node);
        this.checkPipelineComplete();
        return; // Don't create interval
      }
      // Cache miss: proceed with normal execution
      node.lastFailureReason = 'cache-miss';
    }

    const scheduledStage = this.activePrototypeSchedule?.stages.find((stage) => stage.nodeId === node.id);
    const state: NodeExecutionState = {
      progress: 0,
      elapsedTicks: 0,
      durationTicks: scheduledStage?.durationTicks ?? null,
      scheduledStartTick: scheduledStage?.startTick ?? null,
      startTime: Date.now(),
      pausedDurationAtStart: this._totalPausedMs,
      intervalId: null as unknown as ReturnType<typeof setInterval>,
      purposefulFailureChecked: false,
      midGateRolled: false,
    };

    state.intervalId = this.createNodeInterval(node, state);
    this.executionStates.set(node.id, state);
  }

  /**
   * Create the interval that ticks a node's execution forward.
   * Extracted to avoid duplication between executeNode and recreateIntervalsAtCurrentSpeed.
   */
  private createNodeInterval(node: PipelineNode, state: NodeExecutionState): ReturnType<typeof setInterval> {
    const campaignDuration = state.durationTicks === null ? this.getCampaignEffectiveNodeDuration(node, this.level) : 1;
    const campaignProgressIncrement = PIPELINE_SCHEDULER_TICK_SECONDS / campaignDuration;

    return setInterval(() => {
      // Not running: clean up and stop
      if (!this._isRunning) {
        this.clearNodeExecution(node.id);
        return;
      }

      // Paused: skip tick, keep interval alive
      if (this._isPaused) {
        return;
      }

      state.elapsedTicks++;
      state.progress =
        state.durationTicks === null
          ? state.progress + campaignProgressIncrement
          : state.elapsedTicks / state.durationTicks;
      if (state.durationTicks !== null && state.scheduledStartTick !== null) {
        this.advancePrototypeLogicalTime(state.scheduledStartTick + Math.min(state.elapsedTicks, state.durationTicks));
      }
      this._lastProgressTime = Date.now();

      const pipeline = this.pipeline;
      const level = this.level;
      if (!pipeline || !level) return;
      const deterministicScenario = isControlledPrototype(level);

      // Per-node timeout check
      const pausedSinceStart = this._totalPausedMs - state.pausedDurationAtStart;
      const timeoutElapsed = deterministicScenario
        ? schedulerTicksToSeconds(state.elapsedTicks) * 1000
        : Date.now() - state.startTime - pausedSinceStart;
      if (timeoutElapsed > node.config.timeEstimate * GAME_CONSTANTS.NODE_TIMEOUT_MULTIPLIER * 1000) {
        this.clearNodeExecution(node.id);
        this.handleNodeFailure(
          node,
          `Node timed out after ${Math.round(timeoutElapsed / 1000)}s (expected ~${node.config.timeEstimate}s)`
        );
        return;
      }

      // Level-designed checks run once per execution attempt. The previous per-tick
      // call turned an advertised 10% Friday roll into ~96% over a 3-second node.
      if (!state.purposefulFailureChecked) {
        state.purposefulFailureChecked = true;
        const failureCheck = this.executionService.checkPurposefulFailure(node, level, this.levelIndex, pipeline);
        if (failureCheck.shouldFail) {
          this.clearNodeExecution(node.id);
          // P4: Emit dedicated dual-scan-fail event so component can call addDualScanBlockLog
          if (failureCheck.dualScanMissingType) {
            this.emit({ type: 'dual-scan-fail', node, missingType: failureCheck.dualScanMissingType });
          }
          this.handleNodeFailure(node, failureCheck.reason);
          return;
        }
      }

      // Config-based failure check + SecurityScan severity gate — fire EXACTLY ONCE,
      // the first tick progress reaches the midpoint. (The old progress-window check
      // spanned >1 tick and double-rolled, inflating the 23% severity-fail rate to ~41%.)
      if (!state.midGateRolled && state.progress >= 0.5) {
        state.midGateRolled = true;
        // Tutorial level (index 0) is failure-free BY DESIGN — "let players learn the
        // basics" (see checkPurposefulFailure's own level-0 guard). The P4/P5 gates added
        // later must respect the same rule, or a brand-new player hits an unexplained
        // coverage/config failure on level 1 with no idea why.
        const randomFailuresDisabled = this.levelIndex === 0 || deterministicScenario;
        const configFailureRate = randomFailuresDisabled
          ? 0
          : this.executionService.clampFailureRate(this.getConfigFailureRate(node));
        if (configFailureRate > 0 && Math.random() < configFailureRate) {
          this.clearNodeExecution(node.id);
          this.handleNodeFailure(node, this.getConfigFailureReason(node));
          return;
        }

        // P4: Severity gate for SecurityScan nodes (at ~50% progress, single roll).
        // Skipped on the tutorial level (SecurityScan is also locked there).
        if (this.levelIndex > 0 && !deterministicScenario && node.type === NodeType.SecurityScan) {
          const severityResult = this.executionService.checkSeverityGate(node);
          if (severityResult.shouldFail && severityResult.finding) {
            this.clearNodeExecution(node.id);
            const scanType = node.config.scanType ?? 'sast';
            const failReason = `[FAIL] ${scanType}: ${severityResult.finding.tool}: ${severityResult.severity}: ${severityResult.finding.finding}. Deploy blocked.`;
            this.handleNodeFailure(node, failReason);
            return;
          }
          if (severityResult.isWarn && severityResult.finding && severityResult.severity) {
            const scanType: ScanType = node.config.scanType ?? 'sast';
            this.emit({
              type: 'scan-warning',
              node,
              severity: severityResult.severity,
              finding: severityResult.finding.finding,
              tool: severityResult.finding.tool,
              scanType,
            });
          }
        }
      }

      if (state.progress >= 1) {
        // P4: Coverage gate for Test nodes (at completion, before marking Success).
        // Skipped on the tutorial level (index 0) so a new player's first pipeline can't
        // fail a coverage threshold they were never taught about.
        // The current coverage model is stochastic, so Junior's promise to
        // disable random failures applies here too. The deterministic
        // prototype also removes it so pressing Run confirms topology.
        const shouldCheckCoverage = this.levelIndex > 0 && !deterministicScenario && node.type === NodeType.Test;
        if (shouldCheckCoverage) {
          const coverageResult = this.executionService.checkCoverageGate(node);
          if (coverageResult.shouldFail) {
            this.clearNodeExecution(node.id);
            // Emit a dedicated event so a UI can explain the failed gate.
            this.emit({
              type: 'coverage-fail',
              node,
              produced: coverageResult.produced,
              threshold: coverageResult.threshold,
            });
            this.handleNodeFailure(
              node,
              `Test coverage: ${coverageResult.produced}% < threshold ${coverageResult.threshold}%. Lower the threshold to improve the pass odds, or rerun for a new measurement.`
            );
            return;
          }
          if (coverageResult.isNearThreshold) {
            this.emit({
              type: 'coverage-warn',
              node,
              produced: coverageResult.produced,
              threshold: coverageResult.threshold,
            });
          }
        }

        this.clearNodeExecution(node.id);
        this.handleNodeSuccess(node);
      }
    }, this.getExecutionWallIntervalMs());
  }

  private handleNodeSuccess(node: PipelineNode): void {
    node.status = NodeStatus.Success;

    // P6: Track whether a Build has succeeded this run for deterministic cache logic.
    if (node.type === NodeType.Build) {
      this._buildSucceededThisRun = true;
    }

    // Compute parallel info if applicable
    let parallelInfo: ParallelInfo | undefined;
    const pipeline = this.pipeline;
    if (node.type === NodeType.Parallel && node.outputs.length > 1 && pipeline) {
      const downstreamNodes = node.outputs
        .map((id) => pipeline.nodes.find((n) => n.id === id))
        .filter((n): n is PipelineNode => n !== undefined);

      const sumTime = downstreamNodes.reduce((sum, n) => sum + n.config.timeEstimate, 0);
      const maxTime = Math.max(...downstreamNodes.map((n) => n.config.timeEstimate));

      parallelInfo = {
        jobCount: node.outputs.length,
        nodeNames: downstreamNodes.map((n) => n.name).join(', '),
        savedTime: sumTime - maxTime,
        maxTime,
        sumTime,
      };
    }

    // Emit success — the component handles presentation and receipt state.
    this.emit({ type: 'node-success', node, parallelInfo });

    // Resolve downstream execution (with conditional routing)
    this.resolveDownstream(node);

    // Check if pipeline is fully complete
    this.checkPipelineComplete();
  }

  private handleNodeFailure(node: PipelineNode, specificReason?: string): void {
    const reason = specificReason || this.executionService.getRandomFailureReason(node.type, node.config.scanType);
    node.lastFailureReason = reason;

    // Check if node has retries remaining
    const retriesRemaining = node.retriesRemaining ?? 0;
    if (retriesRemaining > 0) {
      node.retriesRemaining = retriesRemaining - 1;
      node.status = NodeStatus.Retrying;
      const retryDelay = node.config.retryDelayMs ?? GAME_CONSTANTS.DEFAULT_RETRY_DELAY;

      // Emit retry event (attemptNumber = next attempt, i.e. executionCount + 1)
      this.emit({ type: 'node-retry', node, attemptNumber: node.executionCount + 1 });

      // Schedule re-execution after delay
      const retryTimer = setTimeout(() => {
        this.activeRetryTimeouts.delete(retryTimer);
        if (!this._isRunning) return; // Guard against stale callbacks
        this.scheduleNode(node);
      }, retryDelay);
      this.activeRetryTimeouts.add(retryTimer);
      this.drainReadyQueue();
      return; // Don't cascade failure
    }

    // No retries left — fail permanently
    node.status = NodeStatus.Failed;

    if (this.pipeline) {
      this.pipeline.lastFailedNodeType = node.type;
    }

    const rollbackTriggered = node.type === NodeType.Deploy && !!node.config.rollbackEnabled;

    // Emit failure — the component handles presentation and receipt state.
    this.emit({ type: 'node-failure', node, reason, rollbackTriggered });

    // Rollback: after 2s, mark deploy as success
    if (rollbackTriggered) {
      this.performRollback(node);
    }

    // Cascade cancellation to downstream nodes
    this.stopDownstreamNodes(node);

    this.drainReadyQueue();
    this.checkPipelineComplete();
  }

  // ─── Downstream Resolution ──────────────────────────────────────────────────

  private resolveDownstream(node: PipelineNode): void {
    if (!this.pipeline) return;

    if (isControlledPrototype(this.level)) {
      this.enqueueReadyPrototypeNodes();
      return;
    }

    const pipelineRef = this.pipeline;
    if (!pipelineRef) return;

    let nextNodes = node.outputs
      .map((id) => pipelineRef.nodes.find((n) => n.id === id))
      .filter((n): n is PipelineNode => n !== undefined);

    // Conditional node: select which output paths to execute
    if (node.type === NodeType.Conditional && nextNodes.length > 1) {
      nextNodes = this.resolveConditionalBranches(node, nextNodes);
    }

    // Execute each eligible downstream node
    nextNodes.forEach((nextNode) => {
      const allInputsComplete = this.executionService.areAllInputsComplete(nextNode, pipelineRef);
      if (allInputsComplete) {
        this.scheduleNode(nextNode, false);
      }
    });
    this.drainReadyQueue();
  }

  private resolveConditionalBranches(node: PipelineNode, nextNodes: PipelineNode[]): PipelineNode[] {
    const conditionType = node.config.conditionType || 'random';
    let selectedNodes: PipelineNode[];
    let skippedNodes: PipelineNode[];

    switch (conditionType) {
      case 'all':
        selectedNodes = [...nextNodes];
        this.emit({
          type: 'conditional-route',
          conditionType,
          message: `Executing all ${nextNodes.length} branches`,
        });
        break;

      case 'first':
        selectedNodes = [nextNodes[0]];
        skippedNodes = nextNodes.slice(1);
        this.emit({
          type: 'conditional-route',
          conditionType,
          message: `Proceeding with first branch: ${nextNodes[0].name}`,
        });
        skippedNodes.forEach((s) => this.skipNodeAndDownstream(s));
        break;

      case 'round-robin': {
        const currentIndex = node.config.conditionIndex || 0;
        const selectedIndex = currentIndex % nextNodes.length;
        selectedNodes = [nextNodes[selectedIndex]];
        skippedNodes = nextNodes.filter((_, i) => i !== selectedIndex);
        node.config.conditionIndex = (currentIndex + 1) % nextNodes.length;
        this.emit({
          type: 'conditional-route',
          conditionType,
          message: `Round-robin selected: ${nextNodes[selectedIndex].name} (branch ${selectedIndex + 1}/${nextNodes.length})`,
        });
        skippedNodes.forEach((s) => this.skipNodeAndDownstream(s));
        break;
      }

      case 'random':
      default: {
        const randomIndex = Math.floor(Math.random() * nextNodes.length);
        selectedNodes = [nextNodes[randomIndex]];
        skippedNodes = nextNodes.filter((_, i) => i !== randomIndex);
        this.emit({
          type: 'conditional-route',
          conditionType,
          message: `Randomly selected: ${nextNodes[randomIndex].name}`,
        });
        skippedNodes.forEach((s) => this.skipNodeAndDownstream(s));
        break;
      }
    }

    return selectedNodes;
  }

  private skipNodeAndDownstream(node: PipelineNode): void {
    if (node.status !== NodeStatus.Idle && node.status !== NodeStatus.Running) return;

    node.status = NodeStatus.Skipped;
    this.emit({ type: 'node-skipped', node });

    const pipelineRef = this.pipeline;
    if (!pipelineRef) return;

    node.outputs.forEach((outputId) => {
      const outputNode = pipelineRef.nodes.find((n) => n.id === outputId);
      if (!outputNode) return;

      // Only skip if ALL inputs to this node will be skipped
      const allInputsWillBeSkipped = outputNode.inputs.every((inputId) => {
        const inputNode = pipelineRef.nodes.find((n) => n.id === inputId);
        return inputNode?.status === NodeStatus.Skipped || inputId === node.id;
      });

      if (allInputsWillBeSkipped) {
        this.skipNodeAndDownstream(outputNode);
      }
    });
  }

  private stopDownstreamNodes(node: PipelineNode): void {
    const pipelineRef = this.pipeline;
    if (!pipelineRef) return;

    node.outputs.forEach((outputId) => {
      const outputNode = pipelineRef.nodes.find((n) => n.id === outputId);
      if (!outputNode) return;

      if (
        outputNode.status === NodeStatus.Running ||
        outputNode.status === NodeStatus.Idle ||
        outputNode.status === NodeStatus.Retrying
      ) {
        outputNode.status = NodeStatus.Cancelled;
        this.emit({ type: 'node-cancelled', node: outputNode });
        this.stopDownstreamNodes(outputNode);
      }
      // RolledBack is already terminal — do NOT overwrite it with Cancelled.
    });
  }

  // ─── Completion Detection ───────────────────────────────────────────────────

  private checkPipelineComplete(): void {
    if (!this.pipeline || !this.level) return;

    // A rollback timeout is still in-flight — a node is transitioning from
    // Failed to RolledBack. Wait for it to settle before evaluating completion.
    if (this._pendingRollbacks > 0) {
      return;
    }

    if (!this.executionService.isPipelineComplete(this.pipeline)) {
      return; // Still running
    }

    // P2: RolledBack nodes do NOT count as hard failures in the failedCount.
    const failedCount = this.pipeline.nodes.filter((n) => n.status === NodeStatus.Failed).length;
    const cancelledCount = this.pipeline.nodes.filter((n) => n.status === NodeStatus.Cancelled).length;
    const successCount = this.pipeline.nodes.filter((n) => n.status === NodeStatus.Success).length;
    const rolledBackCount = this.pipeline.nodes.filter((n) => n.status === NodeStatus.RolledBack).length;
    const totalNodes = this.pipeline.nodes.length;
    const noArtifactMarks: readonly ReleaseArtifactMark[] = [];
    this.finalizePrototypeLogicalTime(failedCount === 0 && cancelledCount === 0 && rolledBackCount === 0);
    this.stopStuckWatchdog();

    // Check for hard failures: a GENUINELY Failed node only. RTG (2026-06-23): do NOT
    // use hasPipelineFailures here — it also counts Cancelled, and a rollback-enabled
    // Deploy cancels its downstream nodes (stopDownstreamNodes). Gating on Cancelled
    // mislabeled every recovered run with a downstream node (the common Build→Deploy→Notify
    // shape) as a hard failure, leaving the partial-run branch below dead. Within
    // checkPipelineComplete a Cancelled node always descends from a Failed or RolledBack
    // ancestor, so failedCount>0 is the correct hard-failure signal.
    if (failedCount > 0) {
      this._isRunning = false;
      this.emit({
        type: 'pipeline-complete',
        result: {
          success: false,
          missingRequired: false,
          failedCount,
          cancelledCount,
          successCount,
          rolledBackCount,
          totalNodes,
          artifactMarks: noArtifactMarks,
        },
      });
      return;
    }

    // Check for missing required nodes
    if (!this.executionService.hasRequiredNodes(this.pipeline, this.level.requiredNodes)) {
      this._isRunning = false;
      this.emit({
        type: 'pipeline-complete',
        result: {
          success: false,
          missingRequired: true,
          failedCount,
          cancelledCount,
          successCount,
          rolledBackCount,
          totalNodes,
          artifactMarks: noArtifactMarks,
        },
      });
      return;
    }

    // If any nodes rolled back but no hard failures, this is a partial run
    if (rolledBackCount > 0) {
      this._isRunning = false;
      this.emit({
        type: 'pipeline-complete',
        result: {
          success: false,
          missingRequired: false,
          failedCount: 0,
          cancelledCount,
          successCount,
          rolledBackCount,
          totalNodes,
          artifactMarks: noArtifactMarks,
        },
      });
      return;
    }

    // All nodes succeeded / skipped
    this._isRunning = false;
    this.emit({
      type: 'pipeline-complete',
      result: {
        success: true,
        missingRequired: false,
        failedCount,
        cancelledCount,
        successCount,
        rolledBackCount,
        totalNodes,
        artifactMarks: this.getReleaseArtifactMarks(),
      },
    });
  }

  // ─── Rollback ───────────────────────────────────────────────────────────────

  private performRollback(deployNode: PipelineNode): void {
    // Track pending rollback so checkPipelineComplete() waits for it.
    this._pendingRollbacks++;

    // P5: Rollback duration is strategy-dependent (see DEPLOY_STRATEGY_CONFIG).
    //   canary:     500ms  — weight already at 0%, flush is near-instant
    //   blue-green: 1000ms — flip traffic back; standby slot is still running
    //   rolling:    3000ms — must wait for in-flight batches to drain
    const strategy: DeployStrategy = deployNode.config.strategy ?? 'rolling';
    const rollbackDurationMs = DEPLOY_STRATEGY_CONFIG[strategy].rollbackDurationMs;

    const timeoutId = setTimeout(() => {
      this.activeRollbackTimeouts.delete(timeoutId);
      // Guard: only complete rollback if still running
      if (!this._isRunning) {
        this._pendingRollbacks = Math.max(0, this._pendingRollbacks - 1);
        return;
      }
      // P2: RolledBack — NOT a success. The deploy failed; rollback recovered the
      // run but no new version was shipped. Player must re-run for a real Success.
      deployNode.status = NodeStatus.RolledBack;
      this._pendingRollbacks = Math.max(0, this._pendingRollbacks - 1);
      this.emit({ type: 'rollback-complete', node: deployNode });
      // Re-check completion now that this node has settled.
      this.checkPipelineComplete();
    }, rollbackDurationMs);
    this.activeRollbackTimeouts.add(timeoutId);
  }

  private clearAllRollbackTimeouts(): void {
    this.activeRollbackTimeouts.forEach((id) => this.safeClearTimeout(id));
    this.activeRollbackTimeouts.clear();
  }

  private clearAllRetryTimeouts(): void {
    this.activeRetryTimeouts.forEach((id) => this.safeClearTimeout(id));
    this.activeRetryTimeouts.clear();
  }

  // ─── Interval Management ────────────────────────────────────────────────────

  private normalizePlaybackRate(rate: number): number {
    if (!Number.isFinite(rate) || rate <= 0) return 1;

    const intervalMs = GAME_CONSTANTS.NODE_EXECUTION_UPDATE_INTERVAL / rate;
    return intervalMs >= MIN_BROWSER_TIMER_DELAY_MS && intervalMs <= MAX_BROWSER_TIMER_DELAY_MS ? rate : 1;
  }

  private getExecutionWallIntervalMs(): number {
    const rate = isControlledPrototype(this.level) ? this._playbackRate : this._gameSpeed;
    return GAME_CONSTANTS.NODE_EXECUTION_UPDATE_INTERVAL / rate;
  }

  private advancePrototypeLogicalTime(elapsedTicks: number): void {
    if (!isControlledPrototype(this.level) || !this.activePrototypeSchedule) return;

    const boundedTicks = Math.min(this.activePrototypeSchedule.totalTicks, elapsedTicks);
    if (!Number.isSafeInteger(boundedTicks) || boundedTicks <= this._logicalElapsedTicks) return;

    this._logicalElapsedTicks = boundedTicks;
    this.emit({
      type: 'logical-time',
      elapsedSeconds: this.logicalElapsedSeconds,
      elapsedTicks: this._logicalElapsedTicks,
    });
  }

  private finalizePrototypeLogicalTime(useScheduledFinish: boolean): void {
    if (!isControlledPrototype(this.level) || !this.activePrototypeSchedule) return;

    if (useScheduledFinish) {
      this._logicalElapsedTicks = this.activePrototypeSchedule.totalTicks;
    }
    this.emit({
      type: 'logical-time',
      elapsedSeconds: this.logicalElapsedSeconds,
      elapsedTicks: this._logicalElapsedTicks,
    });
  }

  private clearNodeExecution(nodeId: string): void {
    const state = this.executionStates.get(nodeId);
    if (state) {
      this.safeClearInterval(state.intervalId);
      this.executionStates.delete(nodeId);
    }
    if (this.allocatedAgentNodeIds.delete(nodeId)) {
      this.resourceManager.freeBuildAgent();
    }
  }

  private clearAllExecutions(): void {
    this.executionStates.forEach((state) => this.safeClearInterval(state.intervalId));
    this.executionStates.clear();
    this.allocatedAgentNodeIds.forEach(() => this.resourceManager.freeBuildAgent());
    this.allocatedAgentNodeIds.clear();
    this.readyQueue.length = 0;
    this.queuedNodeIds.clear();
    this.clearAllRollbackTimeouts();
    this.clearAllRetryTimeouts();
    this.stopStuckWatchdog();
  }

  /**
   * Defensive clearInterval wrapper. Zone.js monkey-patches clearInterval to
   * remove the task from its internal map; during test teardown the owning
   * zone may already be destroyed, causing a null dereference inside zone.js.
   * Swallow that specific failure mode — the interval is already unregistered
   * as far as the browser is concerned.
   */
  private safeClearInterval(id: ReturnType<typeof setInterval>): void {
    try {
      clearInterval(id);
    } catch {
      // Zone torn down during async cleanup; ignore.
    }
  }

  /** See safeClearInterval — same defense for clearTimeout. */
  private safeClearTimeout(id: ReturnType<typeof setTimeout>): void {
    try {
      clearTimeout(id);
    } catch {
      // Zone torn down during async cleanup; ignore.
    }
  }

  private recreateIntervalsAtCurrentSpeed(): void {
    const pipeline = this.pipeline;
    if (!pipeline) return;

    // Snapshot current entries
    const entries = Array.from(this.executionStates.entries());

    // Clear old intervals only (keep state)
    entries.forEach(([, state]) => this.safeClearInterval(state.intervalId));

    // Recreate with new timing
    entries.forEach(([nodeId, state]) => {
      const node = pipeline.nodes.find((n) => n.id === nodeId);
      if (!node || node.status !== NodeStatus.Running) {
        this.executionStates.delete(nodeId);
        return;
      }
      state.intervalId = this.createNodeInterval(node, state);
    });
  }

  // ─── Stuck Detection ───────────────────────────────────────────────────────

  private startStuckWatchdog(): void {
    this.stopStuckWatchdog();
    this._lastProgressTime = Date.now();
    this._stuckWatchdogId = setInterval(() => {
      if (!this._isRunning || this._isPaused) return;

      const elapsed = Date.now() - this._lastProgressTime;
      if (elapsed > GAME_CONSTANTS.STUCK_THRESHOLD_MS) {
        this.emit({
          type: 'execution-warning',
          message: `No node progress for ${Math.round(elapsed / 1000)}s. Execution may be stuck`,
        });
        // Reset timer to avoid spamming
        this._lastProgressTime = Date.now();
      }
    }, GAME_CONSTANTS.STUCK_WATCHDOG_INTERVAL_MS);
  }

  private stopStuckWatchdog(): void {
    if (this._stuckWatchdogId !== null) {
      this.safeClearInterval(this._stuckWatchdogId);
      this._stuckWatchdogId = null;
    }
  }

  // ─── Config Effects ─────────────────────────────────────────────────────────

  private getCampaignEffectiveNodeDuration(node: PipelineNode, level: Level | null): number {
    return level ? getNodeEffectiveDurationSeconds(node, level) : node.config.timeEstimate;
  }

  /**
   * Calculate additional failure rate from node config.
   * Returns a probability (0-1) of config-induced failure.
   */
  private getConfigFailureRate(node: PipelineNode): number {
    if (node.type === NodeType.Build) {
      const opt = node.config.optimizationLevel || 'balanced';
      const baseRate = node.config.failureRate || 0;
      // Apply optimization multiplier to the base failure rate
      // For 'fast': 1.5x, for 'thorough': 0.5x
      const multiplier = OPTIMIZATION_FAILURE_MULTIPLIERS[opt];
      return baseRate * multiplier;
    }

    // Deploy nodes have an ambient strategy-driven failure rate. On Friday levels,
    // the one-shot Friday check happens first; if it passes, this independent
    // strategy check happens once at the midpoint.
    if (node.type === NodeType.Deploy) {
      const strategy: DeployStrategy = node.config.strategy ?? 'rolling';
      return DEPLOY_STRATEGY_FAILURE_RATES[strategy];
    }

    return 0;
  }

  /**
   * Get a failure reason based on node config settings.
   */
  private getConfigFailureReason(node: PipelineNode): string {
    if (node.type === NodeType.Build) {
      const opt = node.config.optimizationLevel || 'balanced';
      if (opt === 'fast') {
        return 'Build optimization skipped critical checks. Compilation error';
      }
    }
    if (node.type === NodeType.Deploy) {
      const strategy: DeployStrategy = node.config.strategy ?? 'rolling';
      const strategyReasons: Record<DeployStrategy, string> = {
        rolling: 'Rolling deploy failed. Health check failed on updated batch, halting rollout',
        'blue-green': 'Blue-green deploy failed. Standby slot health check did not pass, cutover aborted',
        canary: 'Canary deploy failed. Error rate exceeded threshold at 10% traffic, promotion blocked',
      };
      return strategyReasons[strategy];
    }
    return this.executionService.getRandomFailureReason(node.type, node.config.scanType);
  }

  private getReleaseArtifactMarks(): readonly ReleaseArtifactMark[] {
    if (!isControlledPrototype(this.level) || !this.pipeline) return [];

    return this.pipeline.nodes.flatMap((node): ReleaseArtifactMark[] => {
      if (node.type === NodeType.Build && node.config.optimizationLevel === 'fast') {
        return [
          {
            code: 'unoptimized',
            nodeId: node.id,
            secondsSaved: this.getScheduledSavingsSeconds(node, { optimizationLevel: 'balanced' }),
          },
        ];
      }
      if (node.type === NodeType.Test && node.config.coverageThreshold === 50) {
        return [
          {
            code: 'low-evidence',
            nodeId: node.id,
            secondsSaved: this.getScheduledSavingsSeconds(node, { coverageThreshold: 75 }),
          },
        ];
      }
      if (node.type === NodeType.Deploy && node.config.strategy === 'blue-green') {
        return [
          {
            code: 'partial-rollout',
            nodeId: node.id,
            secondsSaved: this.getScheduledSavingsSeconds(node, { strategy: 'rolling' }),
          },
        ];
      }
      return [];
    });
  }

  /** Compare quantized stage widths through the same scheduler used by the rail. */
  private getScheduledSavingsSeconds(node: PipelineNode, baselineConfig: Partial<NodeConfig>): number {
    if (!isControlledPrototype(this.level)) return 0;

    const actualTicks =
      this.activePrototypeSchedule?.stages.find((stage) => stage.nodeId === node.id)?.durationTicks ??
      getNodeDurationTicks(node, this.level);
    const baselineNode: PipelineNode = {
      ...node,
      config: { ...node.config, ...baselineConfig },
    };
    const baselineTicks = getNodeDurationTicks(baselineNode, this.level);
    if (actualTicks === null || baselineTicks === null) return 0;
    return schedulerTicksToSeconds(Math.max(0, baselineTicks - actualTicks));
  }

  // ─── Event Emission ─────────────────────────────────────────────────────────

  private emit(event: RunnerEvent): void {
    this.eventsSubject.next(event);
  }
}
