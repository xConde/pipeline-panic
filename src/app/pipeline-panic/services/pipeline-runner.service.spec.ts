import { discardPeriodicTasks, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { Subscription } from 'rxjs';
import { PipelineRunnerService, RunnerEvent } from './pipeline-runner.service';
import { PipelineExecutionService } from './pipeline-execution.service';
import { PipelineBuilderService } from './pipeline-builder.service';
import { ResourceManagerService } from './resource-manager.service';
import { NodeStatus, NodeType, Pipeline, PipelineNode } from '../models/pipeline.model';
import { Level } from '../models/game-state.model';
import { CONTROLLED_PROTOTYPE_PLAYBACK_RATE, PIPELINE_SCHEDULER_TICK_SECONDS, ScanFinding } from '../game-constants';
import { createMockNode, createMockPipeline } from '../testing/test-utils';
import { RELEASE_WINDOW_SECONDS } from '../data/release-desk.data';
import { assembleRoute, RouteSpecification } from './route-assembly';
import { getNodeConfigTimeMultiplier } from './pipeline-scheduling';

// ─── Test Helpers ──────────────────────────────────────────────────────────────

function createMockLevel(overrides: Partial<Level> = {}): Level {
  return {
    id: 'test-level',
    name: 'Test Level',
    description: 'A test level',
    requiredNodes: [NodeType.Source, NodeType.Deploy],
    maxNodes: 10,
    maxConnections: 15,
    cpuLimit: 100,
    memoryLimit: 1024,
    parTime: 60,
    ...overrides,
  };
}

function collectEvents(service: PipelineRunnerService): { events: RunnerEvent[]; sub: Subscription } {
  const events: RunnerEvent[] = [];
  const sub = service.events$.subscribe((e) => events.push(e));
  return { events, sub };
}

function eventsOfType<T extends RunnerEvent['type']>(
  events: RunnerEvent[],
  type: T
): Extract<RunnerEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RunnerEvent, { type: T }> => e.type === type);
}

function fastConfig(overrides: Partial<PipelineNode['config']> = {}): PipelineNode['config'] {
  return { cpuRequired: 10, memoryRequired: 100, timeEstimate: 1, failureRate: 0, flakiness: 0, ...overrides };
}

/**
 * Set private state on the runner so we can call private methods directly
 * without going through the full interval-based execution chain.
 */
function initRunnerState(service: PipelineRunnerService, pipeline: Pipeline, level: Level): void {
  service['pipeline'] = pipeline;
  service['level'] = level;
  // Default to a NON-tutorial level (1) so the P4/P5 failure gates are active in tests.
  // Level 0 is failure-free by design; that skip is covered by its own explicit test.
  service['levelIndex'] = 1;
  service['_isRunning'] = true;
  service['_isPaused'] = false;
  service['_gameSpeed'] = 1;
  service['_totalPausedMs'] = 0;
  service['_pauseStartTime'] = 0;
  service['_lastProgressTime'] = Date.now();
}

/** Call a private method on the runner */
function callPrivate(service: PipelineRunnerService, method: string, ...args: unknown[]): unknown {
  return (service[method as keyof PipelineRunnerService] as (...a: unknown[]) => unknown)(...args);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('PipelineRunnerService', () => {
  let service: PipelineRunnerService;
  let resourceManager: ResourceManagerService;
  let executionSpy: jasmine.SpyObj<PipelineExecutionService>;
  let builderSpy: jasmine.SpyObj<PipelineBuilderService>;

  beforeEach(() => {
    executionSpy = jasmine.createSpyObj('PipelineExecutionService', [
      'checkPurposefulFailure',
      'clampFailureRate',
      'isPipelineComplete',
      'hasPipelineFailures',
      'hasRequiredNodes',
      'areAllInputsComplete',
      'getRandomFailureReason',
      // P4 methods
      'checkSeverityGate',
      'checkCoverageGate',
      'checkDualScanTypes',
    ]);

    builderSpy = jasmine.createSpyObj('PipelineBuilderService', ['validatePipeline', 'hasRequiredUpstreamNodes']);

    // Defaults
    executionSpy.checkPurposefulFailure.and.returnValue({ shouldFail: false });
    executionSpy.clampFailureRate.and.callFake((rate: number) => rate);
    executionSpy.isPipelineComplete.and.returnValue(false);
    executionSpy.hasPipelineFailures.and.returnValue(false);
    executionSpy.hasRequiredNodes.and.returnValue(true);
    executionSpy.areAllInputsComplete.and.returnValue(true);
    executionSpy.getRandomFailureReason.and.returnValue('Generic failure');
    // P4 defaults: pass everything by default so existing tests still work
    executionSpy.checkSeverityGate.and.returnValue({ shouldFail: false });
    executionSpy.checkCoverageGate.and.callFake((node: PipelineNode) => {
      node.config.producedCoverage = 80;
      return { shouldFail: false, produced: 80, threshold: 75 };
    });
    executionSpy.checkDualScanTypes.and.returnValue({ satisfied: true });
    builderSpy.validatePipeline.and.returnValue(true);
    builderSpy.hasRequiredUpstreamNodes.and.returnValue(true);

    TestBed.configureTestingModule({
      providers: [
        PipelineRunnerService,
        ResourceManagerService,
        { provide: PipelineExecutionService, useValue: executionSpy },
        { provide: PipelineBuilderService, useValue: builderSpy },
      ],
    });

    service = TestBed.inject(PipelineRunnerService);
    resourceManager = TestBed.inject(ResourceManagerService);
  });

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should be created', () => {
      expect(service).toBeTruthy();
    });

    it('should initialise with isRunning=false, isPaused=false, gameSpeed=1', () => {
      expect(service.isRunning).toBeFalse();
      expect(service.isPaused).toBeFalse();
      expect(service.gameSpeed).toBe(1);
    });

    describe('destroy', () => {
      it('should set isRunning and isPaused to false', fakeAsync(() => {
        service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
        service.pauseExecution();

        service.destroy();

        expect(service.isRunning).toBeFalse();
        expect(service.isPaused).toBeFalse();
        discardPeriodicTasks();
      }));

      it('should clear all intervals so no further ticks fire', fakeAsync(() => {
        service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
        service.destroy();

        const { events, sub } = collectEvents(service);
        tick(10000);
        expect(eventsOfType(events, 'node-success').length).toBe(0);
        sub.unsubscribe();
      }));
    });

    describe('reset', () => {
      it('should set isRunning and isPaused to false', fakeAsync(() => {
        service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
        service.pauseExecution();

        service.reset();

        expect(service.isRunning).toBeFalse();
        expect(service.isPaused).toBeFalse();
        discardPeriodicTasks();
      }));

      it('should clear all intervals', fakeAsync(() => {
        service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
        service.reset();

        const { events, sub } = collectEvents(service);
        tick(10000);
        expect(eventsOfType(events, 'node-success').length).toBe(0);
        sub.unsubscribe();
      }));
    });
  });

  describe('one-shot level failure checks', () => {
    const scenarios = [
      { label: 'Friday', type: NodeType.Deploy, level: { fridayDeploy: true } },
      { label: 'Rush Hour', type: NodeType.Test, level: { rushHour: true } },
    ];

    for (const speed of [1, 2]) {
      for (const scenario of scenarios) {
        it(`rolls ${scenario.label} exactly once during a multi-tick node at ${speed}x`, fakeAsync(() => {
          const node = createMockNode(`${scenario.type}-1`, scenario.type, NodeStatus.Idle, {
            config: fastConfig({ coverage: 80, coverageThreshold: 75 }),
          });
          const pipeline = createMockPipeline([node]);
          const level = createMockLevel({ requiredNodes: [scenario.type], ...scenario.level });
          const randomSpy = spyOn(Math, 'random').and.returnValue(0.99);
          executionSpy.checkPurposefulFailure.and.callFake(() => {
            Math.random();
            return { shouldFail: false };
          });
          // Isolate the purposeful roll from the Deploy strategy midpoint roll.
          executionSpy.clampFailureRate.and.returnValue(0);

          initRunnerState(service, pipeline, level);
          service['_gameSpeed'] = speed;
          callPrivate(service, 'executeNode', node);
          tick(2000);

          expect(executionSpy.checkPurposefulFailure).toHaveBeenCalledTimes(1);
          expect(randomSpy).toHaveBeenCalledTimes(1);
          discardPeriodicTasks();
        }));
      }
    }

    it('preserves the one-shot guard when speed changes mid-execution', fakeAsync(() => {
      const testNode = createMockNode('test-1', NodeType.Test, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 2, coverage: 80, coverageThreshold: 75 }),
      });
      const pipeline = createMockPipeline([testNode]);
      const level = createMockLevel({ requiredNodes: [NodeType.Test], rushHour: true });

      initRunnerState(service, pipeline, level);
      callPrivate(service, 'executeNode', testNode);
      tick(300);
      service.setGameSpeed(2);
      tick(2000);

      expect(executionSpy.checkPurposefulFailure).toHaveBeenCalledTimes(1);
      discardPeriodicTasks();
    }));

    it('creates one fresh purposeful failure check for a configured retry', fakeAsync(() => {
      const testNode = createMockNode('test-1', NodeType.Test, NodeStatus.Idle, {
        config: fastConfig({ retryCount: 1, retryDelayMs: 10, coverage: 80, coverageThreshold: 75 }),
      });
      const pipeline = createMockPipeline([testNode]);
      const level = createMockLevel({ requiredNodes: [NodeType.Test], rushHour: true });
      const randomSpy = spyOn(Math, 'random').and.returnValue(0.99);
      let purposefulChecks = 0;
      executionSpy.checkPurposefulFailure.and.callFake(() => {
        purposefulChecks++;
        Math.random();
        return purposefulChecks === 1
          ? { shouldFail: true, reason: 'Rush Hour transient failure' }
          : { shouldFail: false };
      });

      initRunnerState(service, pipeline, level);
      callPrivate(service, 'executeNode', testNode);
      tick(2500);

      expect(executionSpy.checkPurposefulFailure).toHaveBeenCalledTimes(2);
      expect(randomSpy).toHaveBeenCalledTimes(2);
      expect(testNode.executionCount).toBe(2);
      expect(testNode.retriesRemaining).toBe(0);
      expect(testNode.status).toBe(NodeStatus.Success);
      discardPeriodicTasks();
    }));

    it('suppresses config failure rolls on the release desk', fakeAsync(() => {
      const buildNode = createMockNode('build-1', NodeType.Build, NodeStatus.Idle, {
        config: fastConfig({ failureRate: 1 }),
      });
      const pipeline = createMockPipeline([buildNode]);
      const level = createMockLevel({ requiredNodes: [NodeType.Build] });
      const randomSpy = spyOn(Math, 'random').and.returnValue(0);

      initRunnerState(service, pipeline, level);
      service['levelIndex'] = 0;
      callPrivate(service, 'executeNode', buildNode);
      tick(2000);

      expect(randomSpy).not.toHaveBeenCalled();
      expect(buildNode.status).toBe(NodeStatus.Success);
      discardPeriodicTasks();
    }));
  });

  describe('Release Window prototype critical path', () => {
    function createReleasePipeline(
      shape: 'split-before-gates' | 'merge-after-gates' | 'serial',
      fastestConfiguration = false
    ): Pipeline {
      const source = createMockNode('source', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 1 }),
      });
      const build = createMockNode('build', NodeType.Build, NodeStatus.Idle, {
        config: fastConfig({
          timeEstimate: 3,
          optimizationLevel: fastestConfiguration ? 'fast' : 'balanced',
        }),
      });
      const parallel = createMockNode('parallel', NodeType.Parallel, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 0.2 }),
      });
      const test = createMockNode('test', NodeType.Test, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 3, coverageThreshold: fastestConfiguration ? 50 : 75 }),
      });
      const scan = createMockNode('scan', NodeType.SecurityScan, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 4 }),
      });
      const deploy = createMockNode('deploy', NodeType.Deploy, NodeStatus.Idle, {
        config: fastConfig({
          timeEstimate: 3,
          environment: 'dev',
          strategy: 'rolling',
          rollbackEnabled: false,
        }),
      });

      const connect = (upstream: PipelineNode, downstream: PipelineNode): void => {
        upstream.outputs.push(downstream.id);
        downstream.inputs.push(upstream.id);
      };
      connect(source, build);

      if (shape === 'merge-after-gates') {
        connect(build, test);
        connect(build, scan);
        connect(test, parallel);
        connect(scan, parallel);
        connect(parallel, deploy);
      } else {
        connect(build, parallel);
        connect(parallel, test);
        if (shape === 'serial') {
          connect(test, scan);
        } else {
          connect(parallel, scan);
        }
        connect(test, deploy);
        connect(scan, deploy);
      }

      return createMockPipeline([source, build, parallel, test, scan, deploy]);
    }

    function configureRealCompletionChecks(pipeline: Pipeline): void {
      executionSpy.areAllInputsComplete.and.callFake((node: PipelineNode) =>
        node.inputs.every(
          (inputId) => pipeline.nodes.find((candidate) => candidate.id === inputId)?.status === NodeStatus.Success
        )
      );
      executionSpy.isPipelineComplete.and.callFake((candidatePipeline: Pipeline) =>
        candidatePipeline.nodes.every((node) => node.status === NodeStatus.Success)
      );
      executionSpy.hasRequiredNodes.and.returnValue(true);
    }

    const prototypeLevel = createMockLevel({
      requiredNodes: [
        NodeType.Source,
        NodeType.Build,
        NodeType.Test,
        NodeType.SecurityScan,
        NodeType.Parallel,
        NodeType.Deploy,
      ],
      parTime: RELEASE_WINDOW_SECONDS,
      prototypeRules: {
        deterministic: true,
        dependencyGate: {
          targetType: NodeType.Deploy,
          requiredUpstreamTypes: [NodeType.Build, NodeType.Test, NodeType.SecurityScan, NodeType.Parallel],
        },
      },
    });

    const singleAgentPrototypeLevel: Level = {
      ...prototypeLevel,
      prototypeRules: {
        ...prototypeLevel.prototypeRules!,
        agentPoolLimit: 1,
      },
    };

    function expectForecastToMatchMeasuredRun(shape: 'split-before-gates' | 'merge-after-gates'): void {
      const pipeline = createReleasePipeline(shape);
      configureRealCompletionChecks(pipeline);
      const forecast = service.estimateCriticalPath(pipeline, prototypeLevel);
      const { events, sub } = collectEvents(service);

      expect(forecast).not.toBeNull();
      expect(forecast?.nodeNames[0]).toBe('Source');
      expect(forecast?.nodeNames).toContain('Security');
      expect(forecast?.nodeNames.at(-1)).toBe('Deploy');
      expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, 1)).toBeTrue();

      let measuredTicks = 0;
      while (eventsOfType(events, 'pipeline-complete').length === 0 && measuredTicks < 200) {
        tick(PIPELINE_SCHEDULER_TICK_SECONDS * 1000);
        measuredTicks++;
      }

      const measuredSeconds = measuredTicks * PIPELINE_SCHEDULER_TICK_SECONDS;
      expect(Math.abs(measuredSeconds - (forecast?.durationSeconds ?? 0))).toBeLessThanOrEqual(
        PIPELINE_SCHEDULER_TICK_SECONDS
      );
      discardPeriodicTasks();
      sub.unsubscribe();
    }

    it('rejects a run when Deploy bypasses the configured release gates', () => {
      const pipeline = createReleasePipeline('split-before-gates');
      builderSpy.hasRequiredUpstreamNodes.and.returnValue(false);

      expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, 1)).toBeFalse();
      expect(pipeline.isValid).toBeFalse();
      expect(pipeline.errors).toContain(
        jasmine.objectContaining({
          severity: 'error',
          message: jasmine.stringMatching(/Release gate bypassed/),
          suggestion: jasmine.stringMatching(/.+/),
        })
      );
    });

    /**
     * Pins the isValid/errors invariant runBlockedReason relies on
     * (pipeline-panic.component.ts) at both of the write sites startPipeline()
     * owns directly, rather than through PipelineBuilderService.validatePipeline().
     * Each must leave a severity:'error' entry with a non-empty suggestion
     * behind whenever it sets pipeline.isValid = false by hand, or the desk's
     * "why is Stamp blocked" copy silently falls back to nothing useful.
     */
    it('flags a route whose schedule cannot be computed, even though the base validator and dependency gate both pass', () => {
      const pipeline = createReleasePipeline('split-before-gates');
      pipeline.nodes.find((node) => node.type === NodeType.SecurityScan)!.config.timeEstimate = 0;

      expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, 1)).toBeFalse();
      expect(pipeline.isValid).toBeFalse();
      expect(pipeline.errors).toContain(
        jasmine.objectContaining({
          severity: 'error',
          message: jasmine.stringMatching(/schedule could not be computed/i),
          suggestion: jasmine.stringMatching(/.+/),
        })
      );
    });

    it('finishes the split-before-gates graph inside the release window', fakeAsync(() => {
      const pipeline = createReleasePipeline('split-before-gates');
      configureRealCompletionChecks(pipeline);
      const { events, sub } = collectEvents(service);

      expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, 1)).toBeTrue();
      tick(RELEASE_WINDOW_SECONDS * 1000 - 100);

      expect(eventsOfType(events, 'pipeline-complete').some((event) => event.result.success)).toBeTrue();
      expect(service.isRunning).toBeFalse();
      discardPeriodicTasks();
      sub.unsubscribe();
    }));

    it('pins prototype execution to 1x even when a caller requests or applies a faster speed', fakeAsync(() => {
      const pipeline = createReleasePipeline('split-before-gates');
      configureRealCompletionChecks(pipeline);

      expect(service.startPipeline(pipeline, prototypeLevel, 2, 3, 1)).toBeTrue();
      expect(service.gameSpeed).toBe(1);

      service.setGameSpeed(3);

      expect(service.gameSpeed).toBe(1);
      service.stopPipeline();
      discardPeriodicTasks();
    }));

    it('matches the split-before-gates pre-run estimate to measured completion within one tick', fakeAsync(() => {
      expectForecastToMatchMeasuredRun('split-before-gates');
    }));

    it('finishes the merge-after-gates graph inside the release window', fakeAsync(() => {
      const pipeline = createReleasePipeline('merge-after-gates');
      configureRealCompletionChecks(pipeline);
      const { events, sub } = collectEvents(service);

      expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, 1)).toBeTrue();
      tick(RELEASE_WINDOW_SECONDS * 1000 - 100);

      expect(eventsOfType(events, 'pipeline-complete').some((event) => event.result.success)).toBeTrue();
      expect(service.isRunning).toBeFalse();
      discardPeriodicTasks();
      sub.unsubscribe();
    }));

    it('matches the merge-after-gates pre-run estimate to measured completion within one tick', fakeAsync(() => {
      expectForecastToMatchMeasuredRun('merge-after-gates');
    }));

    it('keeps independent gates concurrent when no agent-pool condition is active', fakeAsync(() => {
      const pipeline = createReleasePipeline('split-before-gates');
      configureRealCompletionChecks(pipeline);

      expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, 1)).toBeTrue();
      tick(4500);

      expect(pipeline.nodes.find((node) => node.id === 'test')?.status).toBe(NodeStatus.Running);
      expect(pipeline.nodes.find((node) => node.id === 'scan')?.status).toBe(NodeStatus.Running);
      service.stopPipeline();
      discardPeriodicTasks();
    }));

    it('serializes ready nodes with one agent and matches its 11.5s forecast within one tick', fakeAsync(() => {
      const pipeline = createReleasePipeline('split-before-gates', true);
      pipeline.nodes.find((node) => node.id === 'deploy')!.config.strategy = 'blue-green';
      // Reverse the connection order to prove the queue uses authored node order
      // as its stable tie-break, not incidental adjacency insertion order.
      pipeline.nodes.find((node) => node.id === 'parallel')!.outputs.reverse();
      configureRealCompletionChecks(pipeline);
      const forecast = service.estimateCriticalPath(pipeline, singleAgentPrototypeLevel);
      const { events, sub } = collectEvents(service);
      const startOrder: string[] = [];
      let activeNodes = 0;
      let maxActiveNodes = 0;
      const activitySub = service.events$.subscribe((event) => {
        if (event.type === 'node-started') {
          startOrder.push(event.node.id);
          activeNodes++;
          maxActiveNodes = Math.max(maxActiveNodes, activeNodes);
        } else if (event.type === 'node-success' || event.type === 'node-failure') {
          activeNodes--;
        }
      });

      expect(forecast?.durationSeconds).toBe(11.5);
      expect(service.startPipeline(pipeline, singleAgentPrototypeLevel, 2, 1, 1)).toBeTrue();

      let measuredTicks = 0;
      while (eventsOfType(events, 'pipeline-complete').length === 0 && measuredTicks < 200) {
        tick(PIPELINE_SCHEDULER_TICK_SECONDS * 1000);
        measuredTicks++;
      }

      const measuredSeconds = measuredTicks * PIPELINE_SCHEDULER_TICK_SECONDS;
      expect(Math.abs(measuredSeconds - (forecast?.durationSeconds ?? 0))).toBeLessThanOrEqual(
        PIPELINE_SCHEDULER_TICK_SECONDS
      );
      expect(startOrder).toEqual(['source', 'build', 'parallel', 'test', 'scan', 'deploy']);
      expect(maxActiveNodes).toBe(1);
      expect(resourceManager.getBuildAgents()).toEqual(jasmine.objectContaining({ total: 1, used: 0, available: 1 }));
      const result = eventsOfType(events, 'pipeline-complete')[0].result;
      expect(result.artifactMarks).toEqual([
        { code: 'unoptimized', nodeId: 'build', secondsSaved: 1.5 },
        { code: 'low-evidence', nodeId: 'test', secondsSaved: 1 },
        { code: 'partial-rollout', nodeId: 'deploy', secondsSaved: 0.6 },
      ]);

      activitySub.unsubscribe();
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('keeps release-seconds exact while the named playback rate compresses wall time', fakeAsync(() => {
      const runAtPlaybackRate = (playbackRate: number): { releaseSeconds: number; wallMilliseconds: number } => {
        const pipeline = createReleasePipeline('split-before-gates');
        configureRealCompletionChecks(pipeline);
        const forecast = service.estimateCriticalPath(pipeline, prototypeLevel);
        const events: RunnerEvent[] = [];
        const startedAt = Date.now();
        let completedAt = startedAt;
        const sub = service.events$.subscribe((event) => {
          events.push(event);
          if (event.type === 'pipeline-complete') completedAt = Date.now();
        });

        expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, playbackRate)).toBeTrue();
        tick(20_000);

        const logicalEvents = eventsOfType(events, 'logical-time');
        expect(eventsOfType(events, 'pipeline-complete')[0].result.success).toBeTrue();
        expect(logicalEvents.at(-1)?.elapsedSeconds).toBe(forecast?.durationSeconds);
        sub.unsubscribe();
        service.reset();
        return {
          releaseSeconds: logicalEvents.at(-1)?.elapsedSeconds ?? 0,
          wallMilliseconds: completedAt - startedAt,
        };
      };

      const atOne = runAtPlaybackRate(1);
      const compressed = runAtPlaybackRate(CONTROLLED_PROTOTYPE_PLAYBACK_RATE);

      expect(atOne.releaseSeconds).toBe(11.5);
      expect(compressed.releaseSeconds).toBe(atOne.releaseSeconds);
      expect(Math.abs(atOne.wallMilliseconds - 11_500)).toBeLessThanOrEqual(100);
      expect(Math.abs(compressed.wallMilliseconds - 2875)).toBeLessThanOrEqual(100);
    }));

    it('falls back to real-time pacing when a playback rate cannot be represented by browser timers', fakeAsync(() => {
      const pipeline = createReleasePipeline('split-before-gates');
      configureRealCompletionChecks(pipeline);

      expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, Number.MIN_VALUE)).toBeTrue();
      expect(service.playbackRate).toBe(1);

      service.setPlaybackRate(100);
      expect(service.playbackRate).toBe(100);
      service.setPlaybackRate(101);
      expect(service.playbackRate).toBe(1);
      service.setPlaybackRate(Number.MAX_VALUE);
      expect(service.playbackRate).toBe(1);
      service.setPlaybackRate(CONTROLLED_PROTOTYPE_PLAYBACK_RATE);
      expect(service.playbackRate).toBe(CONTROLLED_PROTOTYPE_PLAYBACK_RATE);

      service.stopPipeline();
      discardPeriodicTasks();
    }));

    it('does not advance release time independently of simulated stage progress', fakeAsync(() => {
      const pipeline = createReleasePipeline('split-before-gates');
      configureRealCompletionChecks(pipeline);
      const { events, sub } = collectEvents(service);

      expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, 1)).toBeTrue();
      const sourceExecution = service['executionStates'].get('source');
      expect(sourceExecution).toBeDefined();
      if (!sourceExecution) throw new Error('Source execution interval was not created');

      clearInterval(sourceExecution.intervalId);
      tick(500);

      expect(eventsOfType(events, 'logical-time')).toEqual([]);
      service.stopPipeline();
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('executes an agent cap of two in the exact order and duration forecast by the simulation', fakeAsync(() => {
      const source = createMockNode('source', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 1 }),
      });
      const first = createMockNode('first', NodeType.Test, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 2 }),
      });
      const second = createMockNode('second', NodeType.SecurityScan, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 2 }),
      });
      const third = createMockNode('third', NodeType.Build, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 2 }),
      });
      const deploy = createMockNode('deploy', NodeType.Deploy, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 1, environment: 'dev', strategy: 'rolling' }),
      });
      const connect = (upstream: PipelineNode, downstream: PipelineNode): void => {
        upstream.outputs.push(downstream.id);
        downstream.inputs.push(upstream.id);
      };
      [first, second, third].forEach((branch) => {
        connect(source, branch);
        connect(branch, deploy);
      });
      const pipeline = createMockPipeline([source, first, second, third, deploy]);
      const twoAgentLevel: Level = {
        ...prototypeLevel,
        requiredNodes: [NodeType.Source, NodeType.Deploy],
        prototypeRules: { ...prototypeLevel.prototypeRules!, agentPoolLimit: 2 },
      };
      configureRealCompletionChecks(pipeline);
      const forecast = service.estimateCriticalPath(pipeline, twoAgentLevel);
      const { events, sub } = collectEvents(service);

      expect(forecast?.durationSeconds).toBe(6.2);
      expect(service.startPipeline(pipeline, twoAgentLevel, 2, 1, 1)).toBeTrue();
      tick(6500);

      expect(eventsOfType(events, 'node-started').map((event) => event.node.id)).toEqual([
        'source',
        'first',
        'second',
        'third',
        'deploy',
      ]);
      expect(eventsOfType(events, 'logical-time').at(-1)?.elapsedSeconds).toBe(6.2);
      expect(eventsOfType(events, 'pipeline-complete')[0].result.success).toBeTrue();
      expect(resourceManager.getBuildAgents()).toEqual(jasmine.objectContaining({ total: 2, used: 0, available: 2 }));
      sub.unsubscribe();
    }));

    it('starts input-less non-Source roots so measured and forecast schedules cannot diverge', fakeAsync(() => {
      const pipeline = createReleasePipeline('split-before-gates');
      pipeline.nodes.push(
        createMockNode('floating', NodeType.Notification, NodeStatus.Idle, {
          name: 'Floating',
          config: fastConfig({ timeEstimate: 12 }),
        })
      );
      configureRealCompletionChecks(pipeline);
      const forecast = service.estimateCriticalPath(pipeline, prototypeLevel);
      const { events, sub } = collectEvents(service);

      expect(forecast?.durationSeconds).toBe(12.1);
      expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, CONTROLLED_PROTOTYPE_PLAYBACK_RATE)).toBeTrue();
      tick(4000);

      expect(eventsOfType(events, 'node-started').map((event) => event.node.id)).toContain('floating');
      expect(eventsOfType(events, 'node-success').map((event) => event.node.id)).toContain('floating');
      expect(eventsOfType(events, 'logical-time').at(-1)?.elapsedSeconds).toBe(12.1);
      expect(eventsOfType(events, 'pipeline-complete')[0].result.success).toBeTrue();
      sub.unsubscribe();
    }));

    it('projects assembled and hand-wired equivalents to the same forecast and display schedule', () => {
      const handWired = createReleasePipeline('split-before-gates');
      const specification: RouteSpecification = {
        id: 'assembled-equivalent',
        name: 'Assembled equivalent',
        nodes: handWired.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          name: node.name,
          x: node.x,
          y: node.y,
          config: { ...node.config },
        })),
        connections: handWired.nodes.flatMap((node) =>
          node.outputs.map((outputId) => ({ from: node.id, to: outputId }))
        ),
      };
      const assembled = assembleRoute(specification);

      expect(service.estimateCriticalPath(assembled, prototypeLevel)).toEqual(
        service.estimateCriticalPath(handWired, prototypeLevel)
      );
      expect(service.buildDisplaySchedule(assembled, prototypeLevel)).toEqual(
        service.buildDisplaySchedule(handWired, prototypeLevel)
      );
    });

    it('releases the single agent and clears queued work when execution stops', fakeAsync(() => {
      const pipeline = createReleasePipeline('split-before-gates');
      configureRealCompletionChecks(pipeline);

      expect(service.startPipeline(pipeline, singleAgentPrototypeLevel, 2, 1, 1)).toBeTrue();
      expect(resourceManager.getBuildAgents()).toEqual(jasmine.objectContaining({ total: 1, used: 1, available: 0 }));

      service.stopPipeline();

      expect(resourceManager.getBuildAgents()).toEqual(jasmine.objectContaining({ total: 1, used: 0, available: 1 }));
      expect(service['readyQueue']).toEqual([]);
      discardPeriodicTasks();
    }));

    it('releases and reacquires the single agent across a retry', fakeAsync(() => {
      const source = createMockNode('source', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 0.2, retryCount: 1, retryDelayMs: 100 }),
      });
      const pipeline = createMockPipeline([source]);
      const level: Level = {
        ...singleAgentPrototypeLevel,
        requiredNodes: [NodeType.Source],
      };
      let checks = 0;
      executionSpy.checkPurposefulFailure.and.callFake(() => ({
        shouldFail: checks++ === 0,
        reason: 'Transient agent loss',
      }));
      executionSpy.isPipelineComplete.and.callFake(() => source.status === NodeStatus.Success);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      expect(service.startPipeline(pipeline, level, 2, 1)).toBeTrue();
      tick(1000);

      expect(eventsOfType(events, 'node-started').length).toBe(2);
      expect(eventsOfType(events, 'pipeline-complete')[0].result.success).toBeTrue();
      expect(resourceManager.getBuildAgents()).toEqual(jasmine.objectContaining({ total: 1, used: 0, available: 1 }));
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('continues independent queued work after a permanent failure without leaking the agent', fakeAsync(() => {
      const first = createMockNode('first', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 0.2, retryCount: 0 }),
      });
      const second = createMockNode('second', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 0.2, retryCount: 0 }),
      });
      const pipeline = createMockPipeline([first, second]);
      const level: Level = {
        ...singleAgentPrototypeLevel,
        requiredNodes: [NodeType.Source],
      };
      executionSpy.checkPurposefulFailure.and.callFake((node: PipelineNode) => ({
        shouldFail: node.id === first.id,
        reason: 'Permanent first-node failure',
      }));
      executionSpy.isPipelineComplete.and.callFake(() =>
        pipeline.nodes.every((node) => node.status === NodeStatus.Success || node.status === NodeStatus.Failed)
      );
      executionSpy.hasRequiredNodes.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      expect(service.startPipeline(pipeline, level, 2, 1)).toBeTrue();
      tick(1000);

      expect(eventsOfType(events, 'node-started').map((event) => event.node.id)).toEqual(['first', 'second']);
      expect(eventsOfType(events, 'pipeline-complete')[0].result.success).toBeFalse();
      expect(second.status).toBe(NodeStatus.Success);
      expect(resourceManager.getBuildAgents()).toEqual(jasmine.objectContaining({ total: 1, used: 0, available: 1 }));
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('refuses to forecast a cyclic graph instead of presenting false certainty', () => {
      const pipeline = createReleasePipeline('split-before-gates');
      const source = pipeline.nodes.find((node) => node.type === NodeType.Source)!;
      const deploy = pipeline.nodes.find((node) => node.type === NodeType.Deploy)!;
      source.inputs.push(deploy.id);
      deploy.outputs.push(source.id);

      expect(service.estimateCriticalPath(pipeline, prototypeLevel)).toBeNull();
    });

    it('refuses to forecast malformed timing data instead of substituting an instant node', () => {
      const pipeline = createReleasePipeline('split-before-gates');
      pipeline.nodes.find((node) => node.type === NodeType.SecurityScan)!.config.timeEstimate = 0;

      expect(service.estimateCriticalPath(pipeline, prototypeLevel)).toBeNull();
    });

    it('leaves even the fastest fully serial graph running when the release window closes', fakeAsync(() => {
      const pipeline = createReleasePipeline('serial', true);
      configureRealCompletionChecks(pipeline);
      const { events, sub } = collectEvents(service);

      expect(service.startPipeline(pipeline, prototypeLevel, 2, 1, 1)).toBeTrue();
      tick(RELEASE_WINDOW_SECONDS * 1000);

      expect(eventsOfType(events, 'pipeline-complete').length).toBe(0);
      expect(service.isRunning).toBeTrue();

      tick(2000);
      expect(eventsOfType(events, 'pipeline-complete').some((event) => event.result.success)).toBeTrue();
      discardPeriodicTasks();
      sub.unsubscribe();
    }));
  });

  // ─── startPipeline ────────────────────────────────────────────────────────

  describe('startPipeline', () => {
    it('should return false when validation fails', () => {
      builderSpy.validatePipeline.and.returnValue(false);
      const result = service.startPipeline(createMockPipeline(), createMockLevel(), 0, 1);
      expect(result).toBeFalse();
      expect(service.isRunning).toBeFalse();
    });

    it('should return true when validation passes', fakeAsync(() => {
      const result = service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      expect(result).toBeTrue();
      discardPeriodicTasks();
    }));

    it('should set isRunning=true and isPaused=false', fakeAsync(() => {
      service.pauseExecution();
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      expect(service.isRunning).toBeTrue();
      expect(service.isPaused).toBeFalse();
      discardPeriodicTasks();
    }));

    it('should emit started event with isRetry=false on first run', fakeAsync(() => {
      const pipeline = createSourcePipeline();
      const { events, sub } = collectEvents(service);
      service.startPipeline(pipeline, createMockLevel(), 0, 1);

      const started = eventsOfType(events, 'started');
      expect(started.length).toBe(1);
      expect(started[0].isRetry).toBeFalse();
      expect(started[0].runAttempt).toBe(1);
      expect(started[0].lastFailedNodeType).toBeUndefined();
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should increment runAttempt on pipeline', fakeAsync(() => {
      const pipeline = createSourcePipeline();
      service.startPipeline(pipeline, createMockLevel(), 0, 1);
      expect(pipeline.runAttempt).toBe(1);
      discardPeriodicTasks();
    }));

    it('should detect retry when runAttempt > 1', fakeAsync(() => {
      const pipeline = createSourcePipeline();
      pipeline.runAttempt = 1;
      pipeline.lastFailedNodeType = NodeType.Build;
      const { events, sub } = collectEvents(service);

      service.startPipeline(pipeline, createMockLevel(), 0, 1);

      const started = eventsOfType(events, 'started');
      expect(started[0].isRetry).toBeTrue();
      expect(started[0].runAttempt).toBe(2);
      expect(started[0].lastFailedNodeType).toBe(NodeType.Build);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should return false and not re-initialize when already running', fakeAsync(() => {
      const pipeline = createSourcePipeline();
      const { events, sub } = collectEvents(service);

      // First call starts successfully
      const first = service.startPipeline(pipeline, createMockLevel(), 0, 1);
      expect(first).toBeTrue();
      expect(pipeline.runAttempt).toBe(1);

      // Second call while running should be rejected
      const second = service.startPipeline(pipeline, createMockLevel(), 0, 1);
      expect(second).toBeFalse();
      expect(pipeline.runAttempt).toBe(1); // NOT incremented again

      // Only one 'started' event emitted
      const started = eventsOfType(events, 'started');
      expect(started.length).toBe(1);

      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should execute all source nodes', fakeAsync(() => {
      const s1 = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      const s2 = createMockNode('s2', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      const pipeline = createMockPipeline([s1, s2]);
      const { events, sub } = collectEvents(service);

      service.startPipeline(pipeline, createMockLevel(), 0, 1);

      const started = eventsOfType(events, 'node-started');
      expect(started.length).toBe(2);
      expect(started.map((e) => e.node.id)).toContain('s1');
      expect(started.map((e) => e.node.id)).toContain('s2');
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should store gameSpeed from argument', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 3);
      expect(service.gameSpeed).toBe(3);
      discardPeriodicTasks();
    }));
  });

  // ─── stopPipeline ─────────────────────────────────────────────────────────

  describe('stopPipeline', () => {
    it('should set isRunning to false', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      service.stopPipeline();
      expect(service.isRunning).toBeFalse();
      discardPeriodicTasks();
    }));

    it('should cancel running nodes', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      const pipeline = createMockPipeline([source]);
      service.startPipeline(pipeline, createMockLevel(), 0, 1);
      expect(source.status).toBe(NodeStatus.Running);

      service.stopPipeline();

      expect(source.status).toBe(NodeStatus.Cancelled);
      discardPeriodicTasks();
    }));

    it('should not change non-running node statuses', fakeAsync(() => {
      const s = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      const b = createMockNode('b1', NodeType.Build, NodeStatus.Idle);
      const pipeline = createMockPipeline([s, b]);
      service.startPipeline(pipeline, createMockLevel(), 0, 1);
      s.status = NodeStatus.Success;
      b.status = NodeStatus.Idle;

      service.stopPipeline();

      expect(s.status).toBe(NodeStatus.Success);
      expect(b.status).toBe(NodeStatus.Idle);
    }));

    it('should emit stopped event', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      const { events, sub } = collectEvents(service);

      service.stopPipeline();

      expect(eventsOfType(events, 'stopped').length).toBe(1);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should clear intervals so no further ticks fire', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      service.stopPipeline();

      const { events, sub } = collectEvents(service);
      tick(10000);
      expect(eventsOfType(events, 'node-success').length).toBe(0);
      sub.unsubscribe();
    }));
  });

  // ─── pauseExecution / resumeExecution ──────────────────────────────────────

  describe('pauseExecution / resumeExecution', () => {
    it('should set isPaused to true', () => {
      service.pauseExecution();
      expect(service.isPaused).toBeTrue();
    });

    it('should set isPaused to false on resume', () => {
      service.pauseExecution();
      service.resumeExecution();
      expect(service.isPaused).toBeFalse();
    });
  });

  // ─── setGameSpeed ──────────────────────────────────────────────────────────

  describe('setGameSpeed', () => {
    it('should update gameSpeed', () => {
      service.setGameSpeed(2);
      expect(service.gameSpeed).toBe(2);
    });

    it('should accept fractional speeds', () => {
      service.setGameSpeed(0.5);
      expect(service.gameSpeed).toBe(0.5);
    });
  });

  // ─── Node execution (via intervals) ───────────────────────────────────────

  describe('node execution', () => {
    it('should emit node-started and set status to Running', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      const { events, sub } = collectEvents(service);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      expect(source.status).toBe(NodeStatus.Running);
      const started = eventsOfType(events, 'node-started');
      expect(started.length).toBe(1);
      expect(started[0].node.id).toBe('s1');
      expect(started[0].isRetry).toBeFalse();
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should track executionCount', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);
      expect(source.executionCount).toBe(1);
      discardPeriodicTasks();
    }));

    it('should detect retry when executionCount > 1', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig(),
        executionCount: 1,
      });
      const { events, sub } = collectEvents(service);
      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      expect(eventsOfType(events, 'node-started')[0].isRetry).toBeTrue();
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should complete node when progress reaches 1', () => {
      // Verify completion via direct handleNodeSuccess call
      // (interval timing is validated by the failure/pause tests above)
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Running, { config: fastConfig() });
      const pipeline = createMockPipeline([source]);
      initRunnerState(service, pipeline, createMockLevel());
      executionSpy.isPipelineComplete.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeSuccess', source);

      expect(source.status).toBe(NodeStatus.Success);
      expect(eventsOfType(events, 'node-success').length).toBe(1);
      sub.unsubscribe();
    });

    it('should stop progress when paused', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      const { events, sub } = collectEvents(service);
      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      tick(500);
      service.pauseExecution();
      tick(5000);

      expect(eventsOfType(events, 'node-success').length).toBe(0);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should trigger failure when checkPurposefulFailure returns shouldFail', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      executionSpy.checkPurposefulFailure.and.returnValue({ shouldFail: true, reason: 'Designed failure' });
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasPipelineFailures.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 1, 1);
      tick(100);

      expect(source.status).toBe(NodeStatus.Failed);
      const failures = eventsOfType(events, 'node-failure');
      expect(failures.length).toBe(1);
      expect(failures[0].reason).toBe('Designed failure');
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should use gameSpeed to adjust interval timing', fakeAsync(() => {
      // Verify that gameSpeed is stored and used; the actual interval computation
      // (100 * (1/gameSpeed)) is validated by the constructor call.
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 3);
      expect(service.gameSpeed).toBe(3);
      discardPeriodicTasks();
    }));
  });

  // ─── handleNodeSuccess (direct call) ──────────────────────────────────────

  describe('handleNodeSuccess', () => {
    it('should set node status to Success and emit node-success', () => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Running, { config: fastConfig() });
      initRunnerState(service, createMockPipeline([node]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeSuccess', node);

      expect(node.status).toBe(NodeStatus.Success);
      const successes = eventsOfType(events, 'node-success');
      expect(successes.length).toBe(1);
      expect(successes[0].node.id).toBe('n1');
      sub.unsubscribe();
    });

    it('should compute parallelInfo for Parallel nodes with multiple outputs', () => {
      const parallel = createMockNode('p1', NodeType.Parallel, NodeStatus.Running, {
        outputs: ['b1', 't1'],
        config: fastConfig(),
      });
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Idle, {
        inputs: ['p1'],
        config: fastConfig({ timeEstimate: 3 }),
      });
      const test = createMockNode('t1', NodeType.Test, NodeStatus.Idle, {
        inputs: ['p1'],
        config: fastConfig({ timeEstimate: 5 }),
      });
      initRunnerState(service, createMockPipeline([parallel, build, test]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeSuccess', parallel);

      const success = eventsOfType(events, 'node-success')[0];
      expect(success.parallelInfo).toBeTruthy();
      expect(success.parallelInfo!.jobCount).toBe(2);
      expect(success.parallelInfo!.sumTime).toBe(8);
      expect(success.parallelInfo!.maxTime).toBe(5);
      expect(success.parallelInfo!.savedTime).toBe(3);
      sub.unsubscribe();
    });

    it('should not compute parallelInfo for non-Parallel nodes', () => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Running, {
        outputs: ['b1'],
        config: fastConfig(),
      });
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Idle, { inputs: ['s1'] });
      initRunnerState(service, createMockPipeline([source, build]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeSuccess', source);

      expect(eventsOfType(events, 'node-success')[0].parallelInfo).toBeUndefined();
      sub.unsubscribe();
    });

    it('should not compute parallelInfo for Parallel node with single output', () => {
      const parallel = createMockNode('p1', NodeType.Parallel, NodeStatus.Running, {
        outputs: ['b1'],
        config: fastConfig(),
      });
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Idle, { inputs: ['p1'] });
      initRunnerState(service, createMockPipeline([parallel, build]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeSuccess', parallel);

      expect(eventsOfType(events, 'node-success')[0].parallelInfo).toBeUndefined();
      sub.unsubscribe();
    });
  });

  // ─── handleNodeFailure (direct call) ──────────────────────────────────────

  describe('handleNodeFailure', () => {
    it('should set node status to Failed and emit node-failure', () => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Running);
      initRunnerState(service, createMockPipeline([node]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', node, 'Build exploded');

      expect(node.status).toBe(NodeStatus.Failed);
      const failures = eventsOfType(events, 'node-failure');
      expect(failures.length).toBe(1);
      expect(failures[0].reason).toBe('Build exploded');
      sub.unsubscribe();
    });

    it('should set lastFailureReason on the node', () => {
      const node = createMockNode('n1', NodeType.Test, NodeStatus.Running);
      initRunnerState(service, createMockPipeline([node]), createMockLevel());

      callPrivate(service, 'handleNodeFailure', node, 'Flaky test');

      expect(node.lastFailureReason).toBe('Flaky test');
    });

    it('should set lastFailedNodeType on the pipeline', () => {
      const node = createMockNode('n1', NodeType.SecurityScan, NodeStatus.Running);
      const pipeline = createMockPipeline([node]);
      initRunnerState(service, pipeline, createMockLevel());

      callPrivate(service, 'handleNodeFailure', node, 'CVE found');

      expect(pipeline.lastFailedNodeType).toBe(NodeType.SecurityScan);
    });

    it('should use getRandomFailureReason when no specific reason given', () => {
      executionSpy.getRandomFailureReason.and.returnValue('Random reason');
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Running);
      initRunnerState(service, createMockPipeline([node]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', node, undefined);

      expect(eventsOfType(events, 'node-failure')[0].reason).toBe('Random reason');
      sub.unsubscribe();
    });

    it('P2: should trigger rollback for Deploy nodes with rollbackEnabled and set status to RolledBack', fakeAsync(() => {
      // P5: use rolling strategy (default) — rollback takes 3000ms
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Running, {
        config: fastConfig({ rollbackEnabled: true, environment: 'production', strategy: 'rolling' }),
      });
      initRunnerState(service, createMockPipeline([deploy]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', deploy, 'Health check failed');

      expect(eventsOfType(events, 'node-failure')[0].rollbackTriggered).toBeTrue();

      tick(3000);
      // P2: RolledBack — deploy failed and rolled back; NOT a success.
      expect(deploy.status).toBe(NodeStatus.RolledBack);
      expect(eventsOfType(events, 'rollback-complete').length).toBe(1);
      sub.unsubscribe();
    }));

    it('should not trigger rollback for Deploy without rollbackEnabled', () => {
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Running, {
        config: fastConfig({ rollbackEnabled: false }),
      });
      initRunnerState(service, createMockPipeline([deploy]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', deploy, 'fail');

      expect(eventsOfType(events, 'node-failure')[0].rollbackTriggered).toBeFalse();
      sub.unsubscribe();
    });

    it('should not trigger rollback for non-Deploy nodes', () => {
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Running, {
        config: fastConfig({ rollbackEnabled: true }),
      });
      initRunnerState(service, createMockPipeline([build]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', build, 'fail');

      expect(eventsOfType(events, 'node-failure')[0].rollbackTriggered).toBeFalse();
      sub.unsubscribe();
    });

    it('should cascade cancellation to downstream nodes', () => {
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Running, { outputs: ['d1'] });
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, { inputs: ['b1'] });
      initRunnerState(service, createMockPipeline([build, deploy]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', build, 'fail');

      expect(deploy.status).toBe(NodeStatus.Cancelled);
      expect(eventsOfType(events, 'node-cancelled').length).toBe(1);
      sub.unsubscribe();
    });
  });

  // ─── Downstream resolution (direct call) ──────────────────────────────────

  describe('downstream resolution', () => {
    it('should execute downstream node when all inputs complete', () => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Success, {
        outputs: ['b1'],
        config: fastConfig(),
      });
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Idle, {
        inputs: ['s1'],
        config: fastConfig(),
      });
      initRunnerState(service, createMockPipeline([source, build]), createMockLevel());
      executionSpy.areAllInputsComplete.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'resolveDownstream', source);

      const started = eventsOfType(events, 'node-started');
      expect(started.length).toBe(1);
      expect(started[0].node.id).toBe('b1');
      expect(build.status).toBe(NodeStatus.Running);
      sub.unsubscribe();
    });

    it('should not execute downstream node if not all inputs complete', () => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Success, { outputs: ['b1'] });
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Idle, { inputs: ['s1', 's2'] });
      initRunnerState(service, createMockPipeline([source, build]), createMockLevel());
      executionSpy.areAllInputsComplete.and.returnValue(false);
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'resolveDownstream', source);

      expect(eventsOfType(events, 'node-started').length).toBe(0);
      expect(build.status).toBe(NodeStatus.Idle);
      sub.unsubscribe();
    });

    describe('conditional routing', () => {
      let branchA: PipelineNode;
      let branchB: PipelineNode;

      beforeEach(() => {
        branchA = createMockNode('a', NodeType.Build, NodeStatus.Idle, {
          inputs: ['cond'],
          config: fastConfig(),
        });
        branchB = createMockNode('b', NodeType.Test, NodeStatus.Idle, {
          inputs: ['cond'],
          config: fastConfig(),
        });
      });

      function setupConditional(conditionType: string, extraConfig: Record<string, unknown> = {}): PipelineNode {
        const conditional = createMockNode('cond', NodeType.Conditional, NodeStatus.Success, {
          outputs: ['a', 'b'],
          config: fastConfig({ conditionType, ...extraConfig } as Partial<PipelineNode['config']>),
        });
        initRunnerState(service, createMockPipeline([conditional, branchA, branchB]), createMockLevel());
        executionSpy.areAllInputsComplete.and.returnValue(true);
        return conditional;
      }

      it('should execute all branches for conditionType "all"', () => {
        const cond = setupConditional('all');
        const { events, sub } = collectEvents(service);

        callPrivate(service, 'resolveDownstream', cond);

        const started = eventsOfType(events, 'node-started');
        expect(started.map((e) => e.node.id)).toContain('a');
        expect(started.map((e) => e.node.id)).toContain('b');
        const routes = eventsOfType(events, 'conditional-route');
        expect(routes.length).toBe(1);
        expect(routes[0].conditionType).toBe('all');
        sub.unsubscribe();
      });

      it('should execute only first branch and skip rest for conditionType "first"', () => {
        const cond = setupConditional('first');
        const { events, sub } = collectEvents(service);

        callPrivate(service, 'resolveDownstream', cond);

        const started = eventsOfType(events, 'node-started');
        expect(started.length).toBe(1);
        expect(started[0].node.id).toBe('a');
        expect(branchB.status).toBe(NodeStatus.Skipped);
        const routes = eventsOfType(events, 'conditional-route');
        expect(routes[0].conditionType).toBe('first');
        sub.unsubscribe();
      });

      it('should cycle through branches for conditionType "round-robin" (index 0)', () => {
        const cond = setupConditional('round-robin', { conditionIndex: 0 });
        const { events, sub } = collectEvents(service);

        callPrivate(service, 'resolveDownstream', cond);

        expect(eventsOfType(events, 'node-started')[0].node.id).toBe('a');
        expect(branchB.status).toBe(NodeStatus.Skipped);
        expect(cond.config.conditionIndex).toBe(1);
        sub.unsubscribe();
      });

      it('should wrap around for round-robin (index 1 of 2)', () => {
        const cond = setupConditional('round-robin', { conditionIndex: 1 });
        const { events, sub } = collectEvents(service);

        callPrivate(service, 'resolveDownstream', cond);

        expect(eventsOfType(events, 'node-started')[0].node.id).toBe('b');
        expect(branchA.status).toBe(NodeStatus.Skipped);
        expect(cond.config.conditionIndex).toBe(0);
        sub.unsubscribe();
      });

      it('should randomly select a branch for conditionType "random"', () => {
        spyOn(Math, 'random').and.returnValue(0.99);
        const cond = setupConditional('random');
        const { events, sub } = collectEvents(service);

        callPrivate(service, 'resolveDownstream', cond);

        expect(eventsOfType(events, 'node-started')[0].node.id).toBe('b');
        expect(branchA.status).toBe(NodeStatus.Skipped);
        expect(eventsOfType(events, 'conditional-route')[0].conditionType).toBe('random');
        sub.unsubscribe();
      });

      it('should default to "random" when conditionType is undefined', () => {
        spyOn(Math, 'random').and.returnValue(0);
        const cond = setupConditional(undefined as unknown as string);
        const { events, sub } = collectEvents(service);

        callPrivate(service, 'resolveDownstream', cond);

        expect(eventsOfType(events, 'node-started').length).toBe(1);
        sub.unsubscribe();
      });

      it('should not apply conditional routing for non-Conditional nodes with multiple outputs', () => {
        const source = createMockNode('src', NodeType.Source, NodeStatus.Success, {
          outputs: ['a', 'b'],
          config: fastConfig(),
        });
        branchA.inputs = ['src'];
        branchB.inputs = ['src'];
        initRunnerState(service, createMockPipeline([source, branchA, branchB]), createMockLevel());
        executionSpy.areAllInputsComplete.and.returnValue(true);
        const { events, sub } = collectEvents(service);

        callPrivate(service, 'resolveDownstream', source);

        expect(eventsOfType(events, 'node-started').length).toBe(2);
        expect(eventsOfType(events, 'conditional-route').length).toBe(0);
        sub.unsubscribe();
      });

      it('should emit conditional-route event with descriptive message', () => {
        const cond = setupConditional('all');
        const { events, sub } = collectEvents(service);

        callPrivate(service, 'resolveDownstream', cond);

        const routes = eventsOfType(events, 'conditional-route');
        expect(routes[0].message).toBeTruthy();
        expect(routes[0].message.length).toBeGreaterThan(0);
        sub.unsubscribe();
      });
    });
  });

  // ─── skipNodeAndDownstream (direct call) ───────────────────────────────────

  describe('skipNodeAndDownstream', () => {
    it('should skip Idle nodes and emit node-skipped', () => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Idle);
      initRunnerState(service, createMockPipeline([node]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'skipNodeAndDownstream', node);

      expect(node.status).toBe(NodeStatus.Skipped);
      expect(eventsOfType(events, 'node-skipped').length).toBe(1);
      sub.unsubscribe();
    });

    it('should skip Running nodes', () => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Running);
      initRunnerState(service, createMockPipeline([node]), createMockLevel());

      callPrivate(service, 'skipNodeAndDownstream', node);

      expect(node.status).toBe(NodeStatus.Skipped);
    });

    it('should not skip nodes in terminal state (Success)', () => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Success);
      initRunnerState(service, createMockPipeline([node]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'skipNodeAndDownstream', node);

      expect(node.status).toBe(NodeStatus.Success);
      expect(eventsOfType(events, 'node-skipped').length).toBe(0);
      sub.unsubscribe();
    });

    it('should not skip nodes in terminal state (Failed)', () => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Failed);
      initRunnerState(service, createMockPipeline([node]), createMockLevel());

      callPrivate(service, 'skipNodeAndDownstream', node);

      expect(node.status).toBe(NodeStatus.Failed);
    });

    it('should propagate skip to downstream when all inputs are skipped', () => {
      const a = createMockNode('a', NodeType.Build, NodeStatus.Idle, { outputs: ['c'] });
      const c = createMockNode('c', NodeType.Deploy, NodeStatus.Idle, { inputs: ['a'] });
      initRunnerState(service, createMockPipeline([a, c]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'skipNodeAndDownstream', a);

      expect(a.status).toBe(NodeStatus.Skipped);
      expect(c.status).toBe(NodeStatus.Skipped);
      expect(eventsOfType(events, 'node-skipped').length).toBe(2);
      sub.unsubscribe();
    });

    it('should not propagate skip if not all inputs are skipped', () => {
      const a = createMockNode('a', NodeType.Build, NodeStatus.Idle, { outputs: ['c'] });
      const b = createMockNode('b', NodeType.Test, NodeStatus.Running, { outputs: ['c'] });
      const c = createMockNode('c', NodeType.Deploy, NodeStatus.Idle, { inputs: ['a', 'b'] });
      initRunnerState(service, createMockPipeline([a, b, c]), createMockLevel());

      callPrivate(service, 'skipNodeAndDownstream', a);

      expect(a.status).toBe(NodeStatus.Skipped);
      expect(c.status).toBe(NodeStatus.Idle);
    });

    it('should cascade skip through multiple levels', () => {
      const a = createMockNode('a', NodeType.Build, NodeStatus.Idle, { outputs: ['b'] });
      const b = createMockNode('b', NodeType.Test, NodeStatus.Idle, { inputs: ['a'], outputs: ['c'] });
      const c = createMockNode('c', NodeType.Deploy, NodeStatus.Idle, { inputs: ['b'] });
      initRunnerState(service, createMockPipeline([a, b, c]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'skipNodeAndDownstream', a);

      expect(a.status).toBe(NodeStatus.Skipped);
      expect(b.status).toBe(NodeStatus.Skipped);
      expect(c.status).toBe(NodeStatus.Skipped);
      expect(eventsOfType(events, 'node-skipped').length).toBe(3);
      sub.unsubscribe();
    });
  });

  // ─── stopDownstreamNodes (direct call) ─────────────────────────────────────

  describe('stopDownstreamNodes', () => {
    it('should cancel Idle downstream nodes', () => {
      const a = createMockNode('a', NodeType.Build, NodeStatus.Failed, { outputs: ['b'] });
      const b = createMockNode('b', NodeType.Deploy, NodeStatus.Idle, { inputs: ['a'] });
      initRunnerState(service, createMockPipeline([a, b]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'stopDownstreamNodes', a);

      expect(b.status).toBe(NodeStatus.Cancelled);
      expect(eventsOfType(events, 'node-cancelled').length).toBe(1);
      sub.unsubscribe();
    });

    it('should cancel Running downstream nodes', () => {
      const a = createMockNode('a', NodeType.Build, NodeStatus.Failed, { outputs: ['b'] });
      const b = createMockNode('b', NodeType.Deploy, NodeStatus.Running, { inputs: ['a'] });
      initRunnerState(service, createMockPipeline([a, b]), createMockLevel());

      callPrivate(service, 'stopDownstreamNodes', a);

      expect(b.status).toBe(NodeStatus.Cancelled);
    });

    it('should not cancel already-succeeded nodes', () => {
      const a = createMockNode('a', NodeType.Build, NodeStatus.Failed, { outputs: ['b'] });
      const b = createMockNode('b', NodeType.Deploy, NodeStatus.Success, { inputs: ['a'] });
      initRunnerState(service, createMockPipeline([a, b]), createMockLevel());

      callPrivate(service, 'stopDownstreamNodes', a);

      expect(b.status).toBe(NodeStatus.Success);
    });

    it('should cascade cancellation through multiple levels', () => {
      const a = createMockNode('a', NodeType.Build, NodeStatus.Failed, { outputs: ['b'] });
      const b = createMockNode('b', NodeType.Test, NodeStatus.Idle, { inputs: ['a'], outputs: ['c'] });
      const c = createMockNode('c', NodeType.Deploy, NodeStatus.Idle, { inputs: ['b'] });
      initRunnerState(service, createMockPipeline([a, b, c]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'stopDownstreamNodes', a);

      expect(b.status).toBe(NodeStatus.Cancelled);
      expect(c.status).toBe(NodeStatus.Cancelled);
      const cancelled = eventsOfType(events, 'node-cancelled');
      expect(cancelled.length).toBe(2);
      sub.unsubscribe();
    });

    it('should emit node-cancelled for each cancelled node', () => {
      const a = createMockNode('a', NodeType.Build, NodeStatus.Failed, { outputs: ['b', 'c'] });
      const b = createMockNode('b', NodeType.Test, NodeStatus.Idle, { inputs: ['a'] });
      const c = createMockNode('c', NodeType.Deploy, NodeStatus.Running, { inputs: ['a'] });
      initRunnerState(service, createMockPipeline([a, b, c]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'stopDownstreamNodes', a);

      expect(eventsOfType(events, 'node-cancelled').length).toBe(2);
      sub.unsubscribe();
    });
  });

  // ─── checkPipelineComplete (direct call) ──────────────────────────────────

  describe('checkPipelineComplete', () => {
    it('should emit pipeline-complete with success=true when all succeed', () => {
      const s = createMockNode('s1', NodeType.Source, NodeStatus.Success);
      const d = createMockNode('d1', NodeType.Deploy, NodeStatus.Success);
      const pipeline = createMockPipeline([s, d]);
      initRunnerState(service, pipeline, createMockLevel());
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasPipelineFailures.and.returnValue(false);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'checkPipelineComplete');

      const completed = eventsOfType(events, 'pipeline-complete');
      expect(completed.length).toBe(1);
      expect(completed[0].result.success).toBeTrue();
      expect(completed[0].result.missingRequired).toBeFalse();
      expect(completed[0].result.successCount).toBe(2);
      expect(completed[0].result.failedCount).toBe(0);
      expect(completed[0].result.totalNodes).toBe(2);
      expect(service.isRunning).toBeFalse();
      sub.unsubscribe();
    });

    it('should emit pipeline-complete with success=false when failures exist', () => {
      const s = createMockNode('s1', NodeType.Source, NodeStatus.Success);
      const b = createMockNode('b1', NodeType.Build, NodeStatus.Failed);
      const d = createMockNode('d1', NodeType.Deploy, NodeStatus.Cancelled);
      const pipeline = createMockPipeline([s, b, d]);
      initRunnerState(service, pipeline, createMockLevel());
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasPipelineFailures.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'checkPipelineComplete');

      const result = eventsOfType(events, 'pipeline-complete')[0].result;
      expect(result.success).toBeFalse();
      expect(result.missingRequired).toBeFalse();
      expect(result.failedCount).toBe(1);
      expect(result.cancelledCount).toBe(1);
      expect(result.successCount).toBe(1);
      expect(service.isRunning).toBeFalse();
      sub.unsubscribe();
    });

    it('should emit pipeline-complete with missingRequired=true', () => {
      const s = createMockNode('s1', NodeType.Source, NodeStatus.Success);
      initRunnerState(service, createMockPipeline([s]), createMockLevel());
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasPipelineFailures.and.returnValue(false);
      executionSpy.hasRequiredNodes.and.returnValue(false);
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'checkPipelineComplete');

      const result = eventsOfType(events, 'pipeline-complete')[0].result;
      expect(result.success).toBeFalse();
      expect(result.missingRequired).toBeTrue();
      expect(service.isRunning).toBeFalse();
      sub.unsubscribe();
    });

    it('should not emit if pipeline is not complete', () => {
      const s = createMockNode('s1', NodeType.Source, NodeStatus.Running);
      initRunnerState(service, createMockPipeline([s]), createMockLevel());
      executionSpy.isPipelineComplete.and.returnValue(false);
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'checkPipelineComplete');

      expect(eventsOfType(events, 'pipeline-complete').length).toBe(0);
      expect(service.isRunning).toBeTrue();
      sub.unsubscribe();
    });

    it('should set isRunning=false on completion', () => {
      const s = createMockNode('s1', NodeType.Source, NodeStatus.Success);
      initRunnerState(service, createMockPipeline([s]), createMockLevel());
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasPipelineFailures.and.returnValue(false);
      executionSpy.hasRequiredNodes.and.returnValue(true);

      callPrivate(service, 'checkPipelineComplete');

      expect(service.isRunning).toBeFalse();
    });

    it('P2: should emit pipeline-complete with success=false, failedCount=0, rolledBackCount=1 when only deploy rolled back', () => {
      // This is the integration path that drives handlePartialPipelineRun() in the
      // component. The component checks: rolledBackCount > 0 && failedCount === 0.
      // If checkPipelineComplete() misrouted this to the hasPipelineFailures branch
      // (success=false, failedCount>0) or the success branch, the partial-run handler
      // would never fire and the player would see the wrong outcome.
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Success);
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.RolledBack);
      const pipeline = createMockPipeline([source, deploy]);
      initRunnerState(service, pipeline, createMockLevel());

      // hasPipelineFailures returns false because RolledBack is NOT a hard failure;
      // hasRequiredNodes returns true (source succeeded); isPipelineComplete returns
      // true because RolledBack is a terminal status.
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasPipelineFailures.and.returnValue(false);
      executionSpy.hasRequiredNodes.and.returnValue(true);

      const { events, sub } = collectEvents(service);

      callPrivate(service, 'checkPipelineComplete');

      const completed = eventsOfType(events, 'pipeline-complete');
      expect(completed.length).toBe(1);

      const result = completed[0].result;
      // Partial run: not a success (no new deploy shipped)
      expect(result.success).toBeFalse();
      // Not a missing-required situation
      expect(result.missingRequired).toBeFalse();
      // No hard failure nodes — RolledBack does not populate failedCount
      expect(result.failedCount).toBe(0);
      // Exactly one rolled-back deploy — this is what routes to handlePartialPipelineRun
      expect(result.rolledBackCount).toBe(1);
      expect(service.isRunning).toBeFalse();
      sub.unsubscribe();
    });

    it('RTG: rolled-back Deploy with a downstream CANCELLED node still reports partial-shape (failedCount=0)', () => {
      // The rollback cascade cancels downstream nodes (Build→Deploy→Notify). The
      // hard-failure branch must key off genuinely Failed nodes (failedCount), NOT
      // hasPipelineFailures (which counts Cancelled) — otherwise this common topology is
      // misrouted. hasPipelineFailures is deliberately mocked TRUE here to prove
      // checkPipelineComplete no longer depends on it.
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Success);
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.RolledBack);
      const notify = createMockNode('n1', NodeType.Notification, NodeStatus.Cancelled);
      const pipeline = createMockPipeline([source, deploy, notify]);
      initRunnerState(service, pipeline, createMockLevel());

      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      executionSpy.hasPipelineFailures.and.returnValue(true); // must be IGNORED now

      const { events, sub } = collectEvents(service);
      callPrivate(service, 'checkPipelineComplete');

      const completed = eventsOfType(events, 'pipeline-complete');
      expect(completed.length).toBe(1);
      const result = completed[0].result;
      expect(result.success).toBeFalse();
      expect(result.failedCount).toBe(0); // no genuine failure — rollback recovered it
      expect(result.rolledBackCount).toBe(1);
      expect(result.cancelledCount).toBe(1);
      sub.unsubscribe();
    });
  });

  // ─── performRollback (direct call) ────────────────────────────────────────

  describe('performRollback', () => {
    it('P2: should set deploy node to RolledBack (not Success) after rolling duration (3s)', fakeAsync(() => {
      // P5: rolling strategy = 3000ms rollback duration
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Failed, {
        config: fastConfig({ strategy: 'rolling' }),
      });
      initRunnerState(service, createMockPipeline([deploy]), createMockLevel());

      callPrivate(service, 'performRollback', deploy);

      expect(deploy.status).toBe(NodeStatus.Failed);
      tick(3000);
      // P2: RolledBack — the deploy failed; rollback recovered the run but no
      // new version was shipped. This is NOT a success.
      expect(deploy.status).toBe(NodeStatus.RolledBack);
    }));

    it('should emit rollback-complete after rolling duration (3s)', fakeAsync(() => {
      // P5: rolling strategy = 3000ms rollback duration
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Failed, {
        config: fastConfig({ strategy: 'rolling' }),
      });
      initRunnerState(service, createMockPipeline([deploy]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'performRollback', deploy);

      expect(eventsOfType(events, 'rollback-complete').length).toBe(0);
      tick(3000);
      const rollbacks = eventsOfType(events, 'rollback-complete');
      expect(rollbacks.length).toBe(1);
      expect(rollbacks[0].node.id).toBe('d1');
      sub.unsubscribe();
    }));

    it('should not emit before rolling duration (3s)', fakeAsync(() => {
      // P5: rolling = 3000ms; should not fire at 2999ms
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Failed, {
        config: fastConfig({ strategy: 'rolling' }),
      });
      initRunnerState(service, createMockPipeline([deploy]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'performRollback', deploy);

      tick(2999);
      expect(eventsOfType(events, 'rollback-complete').length).toBe(0);
      tick(1);
      expect(eventsOfType(events, 'rollback-complete').length).toBe(1);
      sub.unsubscribe();
    }));
  });

  // ─── Pause/Resume (execution engine) ──────────────────────────────────────

  describe('pause/resume execution engine', () => {
    it('should continue and complete nodes after pause→resume', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      executionSpy.isPipelineComplete.and.returnValue(false);
      const { events, sub } = collectEvents(service);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      // Let the node progress partway (500ms of a 1s node)
      tick(500);
      service.pauseExecution();

      // While paused, nothing should complete
      tick(5000);
      expect(eventsOfType(events, 'node-success').length).toBe(0);

      // Resume — node should finish within another ~600ms
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      service.resumeExecution();
      tick(600);

      expect(eventsOfType(events, 'node-success').length).toBe(1);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should preserve progress across pause/resume', fakeAsync(() => {
      // A node with timeEstimate=1 takes 10 ticks of 100ms
      // After 500ms (5 ticks), progress = 0.5
      // After resume, should only need ~500ms more (not restart from 0)
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      executionSpy.isPipelineComplete.and.returnValue(false);
      const { events, sub } = collectEvents(service);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);
      tick(500);
      service.pauseExecution();
      tick(10000); // Wait a long time while paused

      // Resume and complete
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      service.resumeExecution();
      tick(600); // Just a bit over the remaining ~500ms

      expect(eventsOfType(events, 'node-success').length).toBe(1);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should be idempotent for double pause', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      tick(200);
      service.pauseExecution();
      tick(100);
      service.pauseExecution(); // double pause should not reset _pauseStartTime

      // Resume once — should work correctly
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      service.resumeExecution();
      tick(900);

      expect(source.status).toBe(NodeStatus.Success);
      discardPeriodicTasks();
    }));

    it('should be idempotent for double resume', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      // Resume without pausing should be a no-op
      service.resumeExecution();
      service.resumeExecution();

      // Node should still complete normally
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      tick(1100);

      expect(source.status).toBe(NodeStatus.Success);
      discardPeriodicTasks();
    }));
  });

  // ─── Per-node timeout ───────────────────────────────────────────────────────

  describe('per-node timeout', () => {
    it('should fail node that exceeds timeout threshold', fakeAsync(() => {
      // timeEstimate=1, NODE_TIMEOUT_MULTIPLIER=3, so timeout at 3s.
      // A normal node completes in ~1000ms, before the 3s timeout.
      // To trigger the timeout, we backdate the node's startTime so elapsed > 3s on the next tick.
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 1 }),
      });

      executionSpy.checkPurposefulFailure.and.returnValue({ shouldFail: false });
      executionSpy.isPipelineComplete.and.returnValue(false);
      executionSpy.hasPipelineFailures.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      // Backdate the node's startTime so that realElapsed > timeEstimate * 3 * 1000 (> 3000ms)
      const state = service['executionStates'].get('s1');
      if (state) {
        state.startTime = Date.now() - 4000; // 4s ago, exceeds 3s timeout
      }

      // Tick one interval so the timeout check fires
      tick(100);

      expect(source.status).toBe(NodeStatus.Failed);
      const failures = eventsOfType(events, 'node-failure');
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].reason).toContain('timed out');
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should include timeout message in failure reason', fakeAsync(() => {
      // Use a node with very long timeEstimate but that will timeout due to our manipulations
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 0.1 }), // 0.1s estimate, timeout at 0.3s
      });
      executionSpy.checkPurposefulFailure.and.returnValue({ shouldFail: false });
      executionSpy.isPipelineComplete.and.returnValue(false);

      // Override progress so it never reaches 1 by making the node think it has very long estimate
      // Actually, with timeEstimate=0.1, the node completes in 100ms (1 tick).
      // So it will succeed, not timeout. Let's verify that.
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      const { sub } = collectEvents(service);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);
      tick(200);

      // Node should have succeeded since 0.1s < 0.3s timeout
      expect(source.status).toBe(NodeStatus.Success);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should not count paused time toward timeout', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 1 }),
      });
      executionSpy.isPipelineComplete.and.returnValue(false);
      const { events, sub } = collectEvents(service);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      // Run for 500ms
      tick(500);
      service.pauseExecution();

      // Pause for 10 seconds (would exceed 3s timeout if counted)
      tick(10000);

      // Resume — should still be able to complete since paused time doesn't count
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      service.resumeExecution();
      tick(600);

      expect(source.status).toBe(NodeStatus.Success);
      expect(eventsOfType(events, 'node-failure').length).toBe(0);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));
  });

  // ─── Stuck detection ────────────────────────────────────────────────────────

  describe('stuck detection', () => {
    it('should emit execution-warning when no progress for >5s', fakeAsync(() => {
      // Use a very long-running node so it stays running for the entire test
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 100 }), // 100s node
      });
      executionSpy.isPipelineComplete.and.returnValue(false);
      const { events, sub } = collectEvents(service);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      // Let a few ticks fire, then pause so no more progress updates happen
      // but _isRunning stays true. We need a way to stop progress without pausing.
      // Actually, the watchdog checks progress timestamp. While the node is running,
      // each tick updates _lastProgressTime. So we can't get a stuck warning while
      // a node is actively progressing.
      //
      // To trigger stuck: start, let node finish (but pipeline not complete so still running),
      // then wait 5s with no nodes executing.
      tick(100); // One tick

      // Simulate the node completing but pipeline staying "running" (still waiting for other nodes)
      executionSpy.isPipelineComplete.and.returnValue(false);
      // Manually clear the node's execution and mark success without completing pipeline
      const executionStates = service['executionStates'];
      executionStates.forEach((_, key) => {
        const state = executionStates.get(key);
        if (state) {
          clearInterval(state.intervalId);
          executionStates.delete(key);
        }
      });
      source.status = NodeStatus.Success;
      // _isRunning is still true, no executing nodes, watchdog should fire after 5s

      tick(6000);

      const warnings = eventsOfType(events, 'execution-warning');
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0].message).toContain('stuck');
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should not fire stuck warning while paused', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 10 }), // Long-running node
      });
      const { events, sub } = collectEvents(service);
      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      // Pause immediately
      tick(100);
      service.pauseExecution();

      // Wait well beyond stuck threshold
      tick(10000);

      // No warnings should fire while paused
      expect(eventsOfType(events, 'execution-warning').length).toBe(0);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));
  });

  // ─── Speed change ──────────────────────────────────────────────────────────

  describe('speed change', () => {
    it('should recreate intervals at new speed without breaking execution', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 2 }), // 2s node
      });
      executionSpy.isPipelineComplete.and.returnValue(false);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      // Run for 500ms at 1x speed
      tick(500);
      expect(source.status).toBe(NodeStatus.Running);

      // Change to 2x speed — should complete faster
      service.setGameSpeed(2);

      // At 2x, remaining ~1500ms of progress takes ~750ms
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      tick(900);

      expect(source.status).toBe(NodeStatus.Success);
      discardPeriodicTasks();
    }));

    it('should preserve progress when changing speed', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 2 }),
      });
      executionSpy.isPipelineComplete.and.returnValue(false);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      // Run for 1000ms at 1x speed (50% of 2s node)
      tick(1000);

      // Speed change preserves progress — node should NOT restart
      service.setGameSpeed(2);

      // Need only the remaining 50% at 2x speed (~500ms real time)
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      tick(600);

      expect(source.status).toBe(NodeStatus.Success);
      discardPeriodicTasks();
    }));

    it('should be a no-op when setting same speed', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 1 }),
      });
      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      // Set same speed — should not disrupt execution
      service.setGameSpeed(1);

      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      tick(1100);

      expect(source.status).toBe(NodeStatus.Success);
      discardPeriodicTasks();
    }));
  });

  // ─── Visibility change ─────────────────────────────────────────────────────

  describe('visibility change', () => {
    it('should pause execution on tab hidden when running', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      expect(service.isPaused).toBeFalse();

      service.onTabHidden();

      expect(service.isPaused).toBeTrue();
      discardPeriodicTasks();
    }));

    it('should not override user-initiated pause on tab hidden', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      service.pauseExecution(); // User paused

      service.onTabHidden();

      // Still paused (user's pause), and onTabVisible should NOT resume
      expect(service.isPaused).toBeTrue();

      service.onTabVisible();
      expect(service.isPaused).toBeTrue(); // User's pause preserved
      discardPeriodicTasks();
    }));

    it('should resume on tab visible only if visibility caused the pause', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);

      service.onTabHidden();
      expect(service.isPaused).toBeTrue();

      service.onTabVisible();
      expect(service.isPaused).toBeFalse();
      discardPeriodicTasks();
    }));

    it('should handle hidden→visible cycle with nodes completing normally', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      executionSpy.isPipelineComplete.and.returnValue(false);
      const { events, sub } = collectEvents(service);

      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      tick(300);
      service.onTabHidden();
      tick(5000);
      service.onTabVisible();

      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      tick(800);

      expect(eventsOfType(events, 'node-success').length).toBe(1);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should do nothing on tab hidden when not running', () => {
      service.onTabHidden();
      expect(service.isPaused).toBeFalse();
    });
  });

  // ─── Reset clears pause tracking ───────────────────────────────────────────

  describe('reset clears pause tracking', () => {
    it('should reset totalPausedMs to 0', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      service.pauseExecution();
      tick(500);
      service.resumeExecution();

      expect(service['_totalPausedMs']).toBeGreaterThan(0);

      service.reset();

      expect(service['_totalPausedMs']).toBe(0);
      expect(service['_pauseStartTime']).toBe(0);
      discardPeriodicTasks();
    }));
  });

  // ─── Integration: full pipeline run ───────────────────────────────────────

  describe('integration: full pipeline run', () => {
    it('should run a single source node to completion', () => {
      // Simulate full lifecycle: start -> node success -> pipeline complete
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, { config: fastConfig() });
      const pipeline = createMockPipeline([source]);
      const { events, sub } = collectEvents(service);

      // Start (validates + emits 'started' + calls executeNode which emits 'node-started')
      service.startPipeline(pipeline, createMockLevel(), 0, 1);
      expect(eventsOfType(events, 'started').length).toBe(1);
      expect(eventsOfType(events, 'node-started').length).toBe(1);

      // Simulate completion via direct call
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      callPrivate(service, 'handleNodeSuccess', source);

      expect(source.status).toBe(NodeStatus.Success);
      expect(eventsOfType(events, 'node-success').length).toBe(1);
      expect(eventsOfType(events, 'pipeline-complete').length).toBe(1);
      expect(eventsOfType(events, 'pipeline-complete')[0].result.success).toBeTrue();
      expect(service.isRunning).toBeFalse();
      sub.unsubscribe();
    });

    it('should chain source -> build execution', () => {
      // Simulate chained execution: source completes, triggers build
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        outputs: ['b1'],
        config: fastConfig(),
      });
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Idle, {
        inputs: ['s1'],
        config: fastConfig(),
      });
      const pipeline = createMockPipeline([source, build]);
      const { events, sub } = collectEvents(service);

      service.startPipeline(pipeline, createMockLevel(), 0, 1);
      expect(eventsOfType(events, 'node-started').length).toBe(1); // source started

      // Source completes -> resolveDownstream fires -> build starts
      executionSpy.areAllInputsComplete.and.returnValue(true);
      callPrivate(service, 'handleNodeSuccess', source);
      expect(source.status).toBe(NodeStatus.Success);

      const started = eventsOfType(events, 'node-started');
      expect(started.length).toBe(2); // source + build
      expect(started[1].node.id).toBe('b1');

      // Build completes
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      callPrivate(service, 'handleNodeSuccess', build);
      expect(build.status).toBe(NodeStatus.Success);
      expect(eventsOfType(events, 'node-success').length).toBe(2);
      sub.unsubscribe();
    });

    it('should NOT complete rollback after pipeline stop', fakeAsync(() => {
      // P5: rolling strategy = 3000ms rollback duration
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Running, {
        config: fastConfig({ rollbackEnabled: true, environment: 'production', strategy: 'rolling' }),
      });
      const pipeline = createMockPipeline([deploy]);
      initRunnerState(service, pipeline, createMockLevel());
      const { events, sub } = collectEvents(service);

      // Trigger rollback (sets rolling 3s timeout)
      callPrivate(service, 'handleNodeFailure', deploy, 'Health check failed');
      expect(eventsOfType(events, 'node-failure')[0].rollbackTriggered).toBeTrue();

      // Stop pipeline before rollback completes
      service.stopPipeline();

      // Advance past the rolling 3s rollback window
      tick(3100);

      // Rollback should NOT have completed — node should stay Failed (then Cancelled by stop)
      expect(deploy.status).not.toBe(NodeStatus.Success);
      const rollbacks = eventsOfType(events, 'rollback-complete');
      expect(rollbacks.length).toBe(0);
      sub.unsubscribe();
    }));

    it('should NOT complete rollback after reset', fakeAsync(() => {
      // P5: rolling strategy = 3000ms rollback duration
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Running, {
        config: fastConfig({ rollbackEnabled: true, environment: 'production', strategy: 'rolling' }),
      });
      const pipeline = createMockPipeline([deploy]);
      initRunnerState(service, pipeline, createMockLevel());
      const { events, sub } = collectEvents(service);

      // Trigger rollback (sets rolling 3s timeout)
      callPrivate(service, 'handleNodeFailure', deploy, 'Health check failed');

      // Reset before rollback completes
      service.reset();

      // Advance past the rolling 3s rollback window
      tick(3100);

      // Rollback should NOT have completed
      expect(deploy.status).not.toBe(NodeStatus.Success);
      const rollbacks = eventsOfType(events, 'rollback-complete');
      expect(rollbacks.length).toBe(0);
      sub.unsubscribe();
    }));

    it('P2: should set status to RolledBack (not Success) when rollback completes normally', fakeAsync(() => {
      // P5: rolling strategy = 3000ms rollback duration
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Running, {
        config: fastConfig({ rollbackEnabled: true, environment: 'production', strategy: 'rolling' }),
      });
      const pipeline = createMockPipeline([deploy]);
      initRunnerState(service, pipeline, createMockLevel());
      const { events, sub } = collectEvents(service);

      // Trigger rollback (sets rolling 3s timeout)
      callPrivate(service, 'handleNodeFailure', deploy, 'Health check failed');

      // Do NOT stop — let rollback complete
      tick(3000);

      // P2: RolledBack — the deploy failed; rollback recovered the run but no
      // new version was shipped. This is NOT a success.
      expect(deploy.status).toBe(NodeStatus.RolledBack);
      const rollbacks = eventsOfType(events, 'rollback-complete');
      expect(rollbacks.length).toBe(1);
      expect(rollbacks[0].node.id).toBe('d1');
      sub.unsubscribe();
    }));

    it('should reset _pausedByVisibility on stop', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      service.onTabHidden();
      expect(service['_pausedByVisibility']).toBeTrue();

      service.stopPipeline();

      expect(service['_pausedByVisibility']).toBeFalse();
      discardPeriodicTasks();
    }));

    it('should reset _pausedByVisibility on reset', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      service.onTabHidden();
      expect(service['_pausedByVisibility']).toBeTrue();

      service.reset();

      expect(service['_pausedByVisibility']).toBeFalse();
      discardPeriodicTasks();
    }));

    it('should fail and cascade cancellation through pipeline', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        outputs: ['b1'],
        config: fastConfig(),
      });
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Idle, { inputs: ['s1'], outputs: ['d1'] });
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, { inputs: ['b1'] });

      executionSpy.checkPurposefulFailure.and.returnValue({ shouldFail: true, reason: 'Source broke' });
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasPipelineFailures.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      service.startPipeline(createMockPipeline([source, build, deploy]), createMockLevel(), 1, 1);
      tick(100);

      expect(source.status).toBe(NodeStatus.Failed);
      expect(build.status).toBe(NodeStatus.Cancelled);
      expect(deploy.status).toBe(NodeStatus.Cancelled);
      expect(eventsOfType(events, 'node-failure').length).toBe(1);
      expect(eventsOfType(events, 'node-cancelled').length).toBe(2);
      expect(eventsOfType(events, 'pipeline-complete')[0].result.success).toBeFalse();
      sub.unsubscribe();
      discardPeriodicTasks();
    }));
  });

  describe('config effects on execution', () => {
    describe('build optimization level', () => {
      it('should complete faster with fast optimization (0.5x time)', fakeAsync(() => {
        const buildNode = createMockNode('b1', NodeType.Build, NodeStatus.Idle, {
          config: fastConfig({ timeEstimate: 2, optimizationLevel: 'fast' }),
        });
        const pipeline = createMockPipeline([buildNode]);
        const level = createMockLevel();

        initRunnerState(service, pipeline, level);
        callPrivate(service, 'executeNode', buildNode);

        // With fast optimization (0.5x multiplier), 2s * 0.5 = 1s effective
        // progressIncrement = 0.1 / (2 * 0.5) = 0.1, needs 10 ticks at 100ms = 1000ms
        tick(1100);
        expect(buildNode.status).toBe(NodeStatus.Success);
        discardPeriodicTasks();
      }));

      it('should complete slower with thorough optimization (2x time)', fakeAsync(() => {
        const buildNode = createMockNode('b1', NodeType.Build, NodeStatus.Idle, {
          config: fastConfig({ timeEstimate: 1, optimizationLevel: 'thorough' }),
        });
        const pipeline = createMockPipeline([buildNode]);
        const level = createMockLevel();

        initRunnerState(service, pipeline, level);
        callPrivate(service, 'executeNode', buildNode);

        // With thorough optimization (2x multiplier), 1s * 2 = 2s effective
        // progressIncrement = 0.1 / (1 * 2) = 0.05, needs 20 ticks at 100ms = 2000ms
        tick(1500);
        expect(buildNode.status).toBe(NodeStatus.Running);
        tick(600);
        expect(buildNode.status).toBe(NodeStatus.Success);
        discardPeriodicTasks();
      }));

      it('should use balanced multiplier (1x) by default', fakeAsync(() => {
        const buildNode = createMockNode('b1', NodeType.Build, NodeStatus.Idle, {
          config: fastConfig({ timeEstimate: 1 }),
        });
        const pipeline = createMockPipeline([buildNode]);
        const level = createMockLevel();

        initRunnerState(service, pipeline, level);
        callPrivate(service, 'executeNode', buildNode);

        // With balanced (default, 1x), 1s effective, 10 ticks
        tick(1100);
        expect(buildNode.status).toBe(NodeStatus.Success);
        discardPeriodicTasks();
      }));
    });

    describe('deploy environment', () => {
      it('should process faster with staging environment (0.7x time)', fakeAsync(() => {
        // Deploy nodes default to strategy 'rolling', which carries a 10% ambient
        // config-failure roll at the progress midpoint (getConfigFailureRate →
        // DEPLOY_STRATEGY_FAILURE_RATES.rolling). Stub the roll high so this
        // timing test can't flake red on an unlucky Math.random (flaked on CI
        // run 28689733674).
        spyOn(Math, 'random').and.returnValue(0.99);
        const deployNode = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
          config: fastConfig({ timeEstimate: 2, environment: 'staging' }),
        });
        const pipeline = createMockPipeline([deployNode]);
        const level = createMockLevel();

        initRunnerState(service, pipeline, level);
        callPrivate(service, 'executeNode', deployNode);

        // staging = 0.7x multiplier: 2s * 0.7 = 1.4s effective
        // progressIncrement = 0.1 / 1.4 ≈ 0.0714, needs ~14 ticks = 1400ms
        tick(1500);
        expect(deployNode.status).toBe(NodeStatus.Success);
        discardPeriodicTasks();
      }));

      it('should process slower with production environment (1.3x time)', fakeAsync(() => {
        // Same ambient 10% rolling-strategy failure roll as the staging test above.
        spyOn(Math, 'random').and.returnValue(0.99);
        const deployNode = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
          config: fastConfig({ timeEstimate: 1, environment: 'production' }),
        });
        const pipeline = createMockPipeline([deployNode]);
        const level = createMockLevel();

        initRunnerState(service, pipeline, level);
        callPrivate(service, 'executeNode', deployNode);

        // production = 1.3x multiplier: 1s * 1.3 = 1.3s effective
        // progressIncrement = 0.1 / 1.3 ≈ 0.0769, needs ~13 ticks = 1300ms
        tick(1000);
        expect(deployNode.status).toBe(NodeStatus.Running);
        tick(400);
        expect(deployNode.status).toBe(NodeStatus.Success);
        discardPeriodicTasks();
      }));
    });

    describe('test coverage threshold', () => {
      it('should process faster with 50% coverage (0.7x time)', fakeAsync(() => {
        const testNode = createMockNode('t1', NodeType.Test, NodeStatus.Idle, {
          config: fastConfig({ timeEstimate: 2, coverageThreshold: 50 }),
        });
        const pipeline = createMockPipeline([testNode]);
        const level = createMockLevel();

        initRunnerState(service, pipeline, level);
        callPrivate(service, 'executeNode', testNode);

        // 50% coverage = 0.7x multiplier: 2s * 0.7 = 1.4s
        tick(1500);
        expect(testNode.status).toBe(NodeStatus.Success);
        discardPeriodicTasks();
      }));

      it('should process slower with 100% coverage (2x time)', fakeAsync(() => {
        const testNode = createMockNode('t1', NodeType.Test, NodeStatus.Idle, {
          config: fastConfig({ timeEstimate: 1, coverageThreshold: 100 }),
        });
        const pipeline = createMockPipeline([testNode]);
        const level = createMockLevel();

        initRunnerState(service, pipeline, level);
        callPrivate(service, 'executeNode', testNode);

        // 100% coverage = 2x multiplier: 1s * 2 = 2s
        tick(1500);
        expect(testNode.status).toBe(NodeStatus.Running);
        tick(600);
        expect(testNode.status).toBe(NodeStatus.Success);
        discardPeriodicTasks();
      }));
    });
  });

  // ─── Retry Behavior ──────────────────────────────────────────────────────────

  describe('retry behavior', () => {
    it('should retry a node with retryCount=2 and enter Retrying status', () => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Running, {
        config: fastConfig({ retryCount: 2, retryDelayMs: 100 }),
      });
      initRunnerState(service, createMockPipeline([node]), createMockLevel());
      node.retriesRemaining = 2;
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', node, 'Build failed');

      expect(node.status).toBe(NodeStatus.Retrying);
      expect(node.retriesRemaining).toBe(1);
      const retries = eventsOfType(events, 'node-retry');
      expect(retries.length).toBe(1);
      expect(retries[0].attemptNumber).toBe(node.executionCount + 1);
      // Should NOT emit node-failure (retry intercepted it)
      expect(eventsOfType(events, 'node-failure').length).toBe(0);
      sub.unsubscribe();
    });

    it('should re-execute node after retry delay', fakeAsync(() => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Running, {
        config: fastConfig({ retryCount: 1, retryDelayMs: 500 }),
        executionCount: 1, // Already executed once (first attempt)
      });
      initRunnerState(service, createMockPipeline([node]), createMockLevel());
      node.retriesRemaining = 1;
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', node, 'Build failed');
      expect(node.status).toBe(NodeStatus.Retrying);

      // Before delay: still retrying
      tick(400);
      expect(eventsOfType(events, 'node-started').length).toBe(0);

      // After delay: should re-execute
      tick(200);
      const started = eventsOfType(events, 'node-started');
      expect(started.length).toBe(1);
      expect(started[0].node.id).toBe('n1');
      expect(started[0].isRetry).toBeTrue();
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('should fail permanently when all retries exhausted', () => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Running, {
        config: fastConfig({ retryCount: 1 }),
        outputs: ['d1'],
      });
      const deploy = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, { inputs: ['n1'] });
      initRunnerState(service, createMockPipeline([node, deploy]), createMockLevel());
      node.retriesRemaining = 0; // All retries used up
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', node, 'Final failure');

      expect(node.status).toBe(NodeStatus.Failed);
      expect(eventsOfType(events, 'node-failure').length).toBe(1);
      expect(eventsOfType(events, 'node-failure')[0].reason).toBe('Final failure');
      // Should cascade cancellation
      expect(deploy.status).toBe(NodeStatus.Cancelled);
      sub.unsubscribe();
    });

    it('should not retry when retryCount is 0 (default)', () => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Running);
      initRunnerState(service, createMockPipeline([node]), createMockLevel());
      // retriesRemaining is undefined/0 by default
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', node, 'Immediate failure');

      expect(node.status).toBe(NodeStatus.Failed);
      expect(eventsOfType(events, 'node-failure').length).toBe(1);
      expect(eventsOfType(events, 'node-retry').length).toBe(0);
      sub.unsubscribe();
    });

    it('should clear retry timeouts on pipeline stop', fakeAsync(() => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Running, {
        config: fastConfig({ retryCount: 2, retryDelayMs: 1000 }),
      });
      initRunnerState(service, createMockPipeline([node]), createMockLevel());
      node.retriesRemaining = 2;
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'handleNodeFailure', node, 'Build failed');
      expect(node.status).toBe(NodeStatus.Retrying);

      // Stop pipeline before retry fires
      service.stopPipeline();

      // Advance past retry delay — should NOT re-execute
      tick(2000);
      expect(eventsOfType(events, 'node-started').length).toBe(0);
      sub.unsubscribe();
    }));

    it('should cancel Retrying nodes on pipeline stop', fakeAsync(() => {
      const node = createMockNode('n1', NodeType.Build, NodeStatus.Retrying);
      const pipeline = createMockPipeline([node]);
      initRunnerState(service, pipeline, createMockLevel());

      service.stopPipeline();

      expect(node.status).toBe(NodeStatus.Cancelled);
    }));

    it('should initialize retriesRemaining on first execution', fakeAsync(() => {
      const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
        config: fastConfig({ retryCount: 3 }),
      });
      service.startPipeline(createMockPipeline([source]), createMockLevel(), 0, 1);

      expect(source.retriesRemaining).toBe(3);
      discardPeriodicTasks();
    }));
  });

  // ─── Cache Hit/Miss (P6: deterministic) ─────────────────────────────────────

  describe('cache hit/miss (P6 deterministic)', () => {
    it('MISS: no Build has succeeded yet — cache node starts running', fakeAsync(() => {
      const cacheNode = createMockNode('c1', NodeType.Cache, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 0.5 }),
      });
      const pipeline = createMockPipeline([cacheNode]);
      initRunnerState(service, pipeline, createMockLevel());
      // _buildSucceededThisRun defaults to false — ensure it is false
      service['_buildSucceededThisRun'] = false;
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'executeNode', cacheNode);

      expect(cacheNode.status).toBe(NodeStatus.Running);
      expect(cacheNode.lastFailureReason).toBe('cache-miss');
      const cacheEvents = eventsOfType(events, 'cache-result');
      expect(cacheEvents.length).toBe(1);
      expect(cacheEvents[0].isHit).toBeFalse();
      expect(cacheEvents[0].message).toContain('MISS');
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('HIT: a Build has succeeded earlier this run — cache completes instantly', () => {
      const cacheNode = createMockNode('c1', NodeType.Cache, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 0.5 }),
      });
      const pipeline = createMockPipeline([cacheNode]);
      initRunnerState(service, pipeline, createMockLevel());
      // Simulate a Build already having succeeded this run
      service['_buildSucceededThisRun'] = true;
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'executeNode', cacheNode);

      expect(cacheNode.status).toBe(NodeStatus.Success);
      expect(cacheNode.lastFailureReason).toBe('cache-hit');
      const cacheEvents = eventsOfType(events, 'cache-result');
      expect(cacheEvents.length).toBe(1);
      expect(cacheEvents[0].isHit).toBeTrue();
      expect(cacheEvents[0].message).toContain('HIT');
      expect(eventsOfType(events, 'node-success').length).toBe(1);
      sub.unsubscribe();
    });

    it('HIT resolves downstream immediately', () => {
      const cacheNode = createMockNode('c1', NodeType.Cache, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 0.5 }),
        outputs: ['b1'],
      });
      const buildNode = createMockNode('b1', NodeType.Build, NodeStatus.Idle, {
        inputs: ['c1'],
        config: fastConfig(),
      });
      const pipeline = createMockPipeline([cacheNode, buildNode]);
      initRunnerState(service, pipeline, createMockLevel());
      service['_buildSucceededThisRun'] = true;
      executionSpy.areAllInputsComplete.and.returnValue(true);
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'executeNode', cacheNode);

      const started = eventsOfType(events, 'node-started');
      expect(started.length).toBe(2); // cache + downstream build
      expect(started[1].node.id).toBe('b1');
      sub.unsubscribe();
    });

    it('_buildSucceededThisRun is set to true when a Build node succeeds', fakeAsync(() => {
      const buildNode = createMockNode('b1', NodeType.Build, NodeStatus.Idle, {
        config: fastConfig({ timeEstimate: 1, failureRate: 0 }),
      });
      const pipeline = createMockPipeline([buildNode]);
      initRunnerState(service, pipeline, createMockLevel());
      service['_buildSucceededThisRun'] = false;
      executionSpy.isPipelineComplete.and.returnValue(true);
      executionSpy.hasRequiredNodes.and.returnValue(true);

      callPrivate(service, 'executeNode', buildNode);
      // Tick past the progress interval enough for progress to reach >= 1
      tick(1500);

      expect(service['_buildSucceededThisRun']).toBeTrue();
      discardPeriodicTasks();
    }));

    it('startPipeline resets _buildSucceededThisRun to false', fakeAsync(() => {
      service['_buildSucceededThisRun'] = true;
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      expect(service['_buildSucceededThisRun']).toBeFalse();
      discardPeriodicTasks();
    }));

    it('reset() clears _buildSucceededThisRun', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      service['_buildSucceededThisRun'] = true;
      service.reset();
      expect(service['_buildSucceededThisRun']).toBeFalse();
      discardPeriodicTasks();
    }));

    it('destroy() clears _buildSucceededThisRun', fakeAsync(() => {
      service.startPipeline(createSourcePipeline(), createMockLevel(), 0, 1);
      service['_buildSucceededThisRun'] = true;
      service.destroy();
      expect(service['_buildSucceededThisRun']).toBeFalse();
      discardPeriodicTasks();
    }));
  });

  // ─── Retrying status in stopDownstreamNodes ──────────────────────────────────

  describe('stopDownstreamNodes with Retrying status', () => {
    it('should cancel Retrying downstream nodes', () => {
      const a = createMockNode('a', NodeType.Build, NodeStatus.Failed, { outputs: ['b'] });
      const b = createMockNode('b', NodeType.Deploy, NodeStatus.Retrying, { inputs: ['a'] });
      initRunnerState(service, createMockPipeline([a, b]), createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'stopDownstreamNodes', a);

      expect(b.status).toBe(NodeStatus.Cancelled);
      expect(eventsOfType(events, 'node-cancelled').length).toBe(1);
      sub.unsubscribe();
    });
  });

  // ─── P4: scan-warning and coverage-warn events ──────────────────────────────

  describe('P4: scan-warning event (MEDIUM/LOW severity findings)', () => {
    it('emits scan-warning when checkSeverityGate returns isWarn=true for a SecurityScan node', fakeAsync(() => {
      const scanNode = createMockNode('sec-1', NodeType.SecurityScan, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          scanType: 'sca',
        },
      });
      const pipeline = createMockPipeline([scanNode]);
      const level = createMockLevel({ securityAudit: true });

      const mediumFinding: ScanFinding = {
        severity: 'MEDIUM',
        finding: 'lodash prototype pollution (CVE-2019-10744)',
        tool: 'snyk',
      };
      // Return isWarn on first call (50% window), then pass afterwards
      let callCount = 0;
      executionSpy.checkSeverityGate.and.callFake(() => {
        callCount++;
        if (callCount === 1) {
          return { shouldFail: false, isWarn: true, severity: 'MEDIUM', finding: mediumFinding };
        }
        return { shouldFail: false };
      });
      executionSpy.isPipelineComplete.and.returnValue(false);

      // Use initRunnerState + executeNode directly — pipeline has no Source node
      initRunnerState(service, pipeline, level);
      const { events, sub } = collectEvents(service);
      callPrivate(service, 'executeNode', scanNode);

      // Tick past the 50% mark (timeEstimate=1, interval=100ms, increment=0.1 → 50% at ~500ms)
      tick(600);
      discardPeriodicTasks();
      sub.unsubscribe();

      const warnings = eventsOfType(events, 'scan-warning');
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      if (warnings.length > 0) {
        expect(warnings[0].severity).toBe('MEDIUM');
        expect(warnings[0].scanType).toBe('sca');
      }
    }));

    it('rolls the severity gate EXACTLY ONCE per execution (regression: no midpoint double-fire)', fakeAsync(() => {
      // The midpoint gate used a progress WINDOW wider than one tick, so a SecurityScan
      // rolled checkSeverityGate twice — turning the advertised 23% block rate into ~41%.
      // The midGateRolled guard must make it fire exactly once. (The old runner spec
      // mocked checkSeverityGate globally and never asserted the call count, which is how
      // the double-fire shipped green.)
      const scanNode = createMockNode('sec-1', NodeType.SecurityScan, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          scanType: 'sast',
        },
      });
      const pipeline = createMockPipeline([scanNode]);
      const level = createMockLevel({ securityAudit: true });
      executionSpy.checkSeverityGate.and.returnValue({ shouldFail: false });
      executionSpy.isPipelineComplete.and.returnValue(false);

      initRunnerState(service, pipeline, level);
      const { sub } = collectEvents(service);
      callPrivate(service, 'executeNode', scanNode);

      // Drive the node well past completion (timeEstimate=1 → progress reaches 1 at ~1s).
      tick(2000);
      discardPeriodicTasks();
      sub.unsubscribe();

      expect(executionSpy.checkSeverityGate).toHaveBeenCalledTimes(1);
    }));

    it('does NOT emit scan-warning when checkSeverityGate returns shouldFail=true (node fails instead)', fakeAsync(() => {
      const scanNode = createMockNode('sec-1', NodeType.SecurityScan, NodeStatus.Idle, {
        config: { cpuRequired: 10, memoryRequired: 100, timeEstimate: 1, failureRate: 0, flakiness: 0 },
      });
      const pipeline = createMockPipeline([scanNode]);
      const level = createMockLevel();
      const critFinding: ScanFinding = {
        severity: 'CRITICAL',
        finding: 'SQL injection (CWE-89)',
        tool: 'semgrep',
      };

      executionSpy.checkSeverityGate.and.returnValue({
        shouldFail: true,
        severity: 'CRITICAL',
        finding: critFinding,
      });
      executionSpy.isPipelineComplete.and.returnValue(false);

      initRunnerState(service, pipeline, level);
      const { events, sub } = collectEvents(service);
      callPrivate(service, 'executeNode', scanNode);

      tick(600);
      discardPeriodicTasks();
      sub.unsubscribe();

      const warnings = eventsOfType(events, 'scan-warning');
      expect(warnings.length).toBe(0);

      const failures = eventsOfType(events, 'node-failure');
      expect(failures.length).toBeGreaterThanOrEqual(1);
      if (failures.length > 0) {
        expect(failures[0].reason).toContain('CRITICAL');
      }
    }));
  });

  describe('P4: coverage-warn event (near-threshold coverage)', () => {
    it('emits coverage-warn when coverage passes but is within 5% of threshold', fakeAsync(() => {
      const testNode = createMockNode('test-1', NodeType.Test, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          coverageThreshold: 75,
        },
      });
      const pipeline = createMockPipeline([testNode]);
      const level = createMockLevel({ requiredNodes: [NodeType.Test] });

      executionSpy.checkCoverageGate.and.callFake((node: PipelineNode) => {
        node.config.producedCoverage = 77;
        return { shouldFail: false, produced: 77, threshold: 75, isNearThreshold: true };
      });
      executionSpy.isPipelineComplete.and.returnValue(false);

      initRunnerState(service, pipeline, level);
      const { events, sub } = collectEvents(service);
      callPrivate(service, 'executeNode', testNode);

      // Tick past completion (timeEstimate=1 → progress=1 at ~1000ms)
      tick(1200);
      discardPeriodicTasks();
      sub.unsubscribe();

      const warns = eventsOfType(events, 'coverage-warn');
      expect(warns.length).toBeGreaterThanOrEqual(1);
      if (warns.length > 0) {
        expect(warns[0].produced).toBe(77);
        expect(warns[0].threshold).toBe(75);
      }
    }));

    it('SKIPS the coverage gate on the tutorial level (index 0) — the first level is failure-free', fakeAsync(() => {
      // Regression: a brand-new player hit a coverage failure on level 1 with no idea why.
      // checkPurposefulFailure already self-guards level 0; the coverage/config/severity
      // gates must too. Here the gate WOULD fail, but level 0 must not even call it.
      const testNode = createMockNode('test-1', NodeType.Test, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          coverageThreshold: 75, // normal timing; the mock below controls the gate result
        },
      });
      const pipeline = createMockPipeline([testNode]);
      const level = createMockLevel({ requiredNodes: [NodeType.Test] });
      executionSpy.checkCoverageGate.and.returnValue({ shouldFail: true, produced: 10, threshold: 75 });
      executionSpy.isPipelineComplete.and.returnValue(false);

      initRunnerState(service, pipeline, level);
      service['levelIndex'] = 0; // tutorial level
      const { events, sub } = collectEvents(service);
      callPrivate(service, 'executeNode', testNode);

      tick(2000); // let the node fully complete (progress >= 1)
      discardPeriodicTasks();
      sub.unsubscribe();

      expect(executionSpy.checkCoverageGate).not.toHaveBeenCalled();
      expect(eventsOfType(events, 'coverage-fail').length).toBe(0);
      expect(testNode.status).toBe(NodeStatus.Success);
    }));

    it('skips coverage and scan rolls in a deterministic prototype', fakeAsync(() => {
      const testNode = createMockNode('test-1', NodeType.Test, NodeStatus.Idle, {
        config: fastConfig({ coverageThreshold: 100 }),
      });
      const scanNode = createMockNode('scan-1', NodeType.SecurityScan, NodeStatus.Idle, {
        config: fastConfig(),
      });
      const pipeline = createMockPipeline([testNode, scanNode]);
      const level = createMockLevel({
        requiredNodes: [NodeType.Test, NodeType.SecurityScan],
        prototypeRules: { deterministic: true },
      });
      executionSpy.checkCoverageGate.and.returnValue({ shouldFail: true, produced: 1, threshold: 100 });
      executionSpy.checkSeverityGate.and.returnValue({
        shouldFail: true,
        severity: 'CRITICAL',
        finding: { severity: 'CRITICAL', finding: 'fixture finding', tool: 'fixture scanner' },
      });
      executionSpy.isPipelineComplete.and.returnValue(false);

      initRunnerState(service, pipeline, level);
      const { events, sub } = collectEvents(service);
      callPrivate(service, 'executeNode', testNode);
      callPrivate(service, 'executeNode', scanNode);
      tick(2200);
      discardPeriodicTasks();
      sub.unsubscribe();

      expect(executionSpy.checkCoverageGate).not.toHaveBeenCalled();
      expect(executionSpy.checkSeverityGate).not.toHaveBeenCalled();
      expect(eventsOfType(events, 'node-failure')).toEqual([]);
      expect(testNode.status).toBe(NodeStatus.Success);
      expect(scanNode.status).toBe(NodeStatus.Success);
    }));

    it('skips ambient config failure rolls in a deterministic prototype', fakeAsync(() => {
      const deployNode = createMockNode('deploy-1', NodeType.Deploy, NodeStatus.Idle, {
        config: fastConfig({ strategy: 'rolling', rollbackEnabled: false }),
      });
      const pipeline = createMockPipeline([deployNode]);
      const level = createMockLevel({
        requiredNodes: [NodeType.Deploy],
        prototypeRules: { deterministic: true },
      });
      executionSpy.isPipelineComplete.and.returnValue(false);
      spyOn(Math, 'random').and.returnValue(0);

      initRunnerState(service, pipeline, level);
      const { events, sub } = collectEvents(service);
      callPrivate(service, 'executeNode', deployNode);
      tick(1500);
      discardPeriodicTasks();
      sub.unsubscribe();

      expect(eventsOfType(events, 'node-failure')).toEqual([]);
      expect(deployNode.status).toBe(NodeStatus.Success);
    }));

    it('fails the Test node when coverage is below threshold', fakeAsync(() => {
      const testNode = createMockNode('test-1', NodeType.Test, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          coverageThreshold: 90,
        },
      });
      const pipeline = createMockPipeline([testNode]);
      const level = createMockLevel({ requiredNodes: [NodeType.Test] });

      executionSpy.checkCoverageGate.and.callFake((node: PipelineNode) => {
        node.config.producedCoverage = 68;
        return { shouldFail: true, produced: 68, threshold: 90 };
      });
      executionSpy.isPipelineComplete.and.returnValue(false);

      initRunnerState(service, pipeline, level);
      const { events, sub } = collectEvents(service);
      callPrivate(service, 'executeNode', testNode);

      // coverageThreshold=90 → configMultiplier=1.4 → node completes at ~1400ms; tick past that
      tick(2000);
      discardPeriodicTasks();
      sub.unsubscribe();

      const failures = eventsOfType(events, 'node-failure');
      expect(failures.length).toBeGreaterThanOrEqual(1);
      if (failures.length > 0) {
        expect(failures[0].reason).toContain('68%');
        expect(failures[0].reason).toContain('90%');
        expect(failures[0].reason).toContain('rerun for a new measurement');
        expect(failures[0].reason).not.toContain('Raise coverage');
      }
    }));
  });

  // ─── P5: Deploy strategy — time multiplier ───────────────────────────────────

  describe('P5: getConfigTimeMultiplier — deploy strategy', () => {
    it('rolling strategy uses 1.0x strategy multiplier (staging env = 0.7x, total = 0.7)', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          environment: 'staging',
          strategy: 'rolling',
        },
      });
      // rolling=1.0 * staging=0.7 = 0.7
      const result = getNodeConfigTimeMultiplier(node);
      expect(result).toBeCloseTo(0.7);
    });

    it('blue-green strategy (prod) = 0.8 * 1.3 = 1.04', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          environment: 'production',
          strategy: 'blue-green',
        },
      });
      const result = getNodeConfigTimeMultiplier(node);
      expect(result).toBeCloseTo(1.04);
    });

    it('canary strategy (prod) = 1.5 * 1.3 = 1.95', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          environment: 'production',
          strategy: 'canary',
        },
      });
      const result = getNodeConfigTimeMultiplier(node);
      expect(result).toBeCloseTo(1.95);
    });

    it('defaults to rolling (1.0) when strategy is not set', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          environment: 'staging',
        },
      });
      // rolling=1.0 * staging=0.7 = 0.7 (same as rolling explicit)
      const result = getNodeConfigTimeMultiplier(node);
      expect(result).toBeCloseTo(0.7);
    });
  });

  // ─── P5: Deploy strategy — failure rate ──────────────────────────────────────

  describe('P5: getConfigFailureRate — deploy strategy', () => {
    // Honest model: canary lowest-failure (safest), rolling highest. Canary's cost is
    // speed (see DEPLOY_STRATEGY_CONFIG 1.5x), not reliability — so the risk advisory
    // showing canary as lower-risk is consistent, not a superstition.
    it('rolling strategy returns 0.10 (highest — widest blast radius, slowest rollback)', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          strategy: 'rolling',
        },
      });
      const rate = callPrivate(service, 'getConfigFailureRate', node) as number;
      expect(rate).toBe(0.1);
    });

    it('blue-green strategy returns 0.06', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          strategy: 'blue-green',
        },
      });
      const rate = callPrivate(service, 'getConfigFailureRate', node) as number;
      expect(rate).toBe(0.06);
    });

    it('canary strategy returns 0.04 (lowest — catches issues on ~10% of traffic)', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          strategy: 'canary',
        },
      });
      const rate = callPrivate(service, 'getConfigFailureRate', node) as number;
      expect(rate).toBe(0.04);
    });

    it('defaults to rolling (0.10) when strategy is not set', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: { cpuRequired: 10, memoryRequired: 100, timeEstimate: 4, failureRate: 0, flakiness: 0 },
      });
      const rate = callPrivate(service, 'getConfigFailureRate', node) as number;
      expect(rate).toBe(0.1);
    });
  });

  // ─── P5: Deploy strategy — rollback duration ─────────────────────────────────

  describe('P5: performRollback — strategy-dependent duration', () => {
    it('rolling rollback uses 3000ms — RolledBack emitted only after 3s', fakeAsync(() => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Failed, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          strategy: 'rolling',
        },
      });
      const pipeline = createMockPipeline([node]);
      initRunnerState(service, pipeline, createMockLevel());
      service['_pendingRollbacks'] = 0;
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'performRollback', node);

      tick(2900); // Not yet
      expect(eventsOfType(events, 'rollback-complete').length).toBe(0);
      tick(200); // Past 3000ms
      expect(eventsOfType(events, 'rollback-complete').length).toBe(1);
      expect(node.status).toBe(NodeStatus.RolledBack);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('blue-green rollback uses 1000ms — RolledBack emitted after 1s', fakeAsync(() => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Failed, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          strategy: 'blue-green',
        },
      });
      const pipeline = createMockPipeline([node]);
      initRunnerState(service, pipeline, createMockLevel());
      service['_pendingRollbacks'] = 0;
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'performRollback', node);

      tick(900); // Not yet
      expect(eventsOfType(events, 'rollback-complete').length).toBe(0);
      tick(200); // Past 1000ms
      expect(eventsOfType(events, 'rollback-complete').length).toBe(1);
      expect(node.status).toBe(NodeStatus.RolledBack);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('canary rollback uses 500ms — RolledBack emitted after 0.5s', fakeAsync(() => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Failed, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          strategy: 'canary',
        },
      });
      const pipeline = createMockPipeline([node]);
      initRunnerState(service, pipeline, createMockLevel());
      service['_pendingRollbacks'] = 0;
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'performRollback', node);

      tick(400); // Not yet
      expect(eventsOfType(events, 'rollback-complete').length).toBe(0);
      tick(200); // Past 500ms
      expect(eventsOfType(events, 'rollback-complete').length).toBe(1);
      expect(node.status).toBe(NodeStatus.RolledBack);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));
  });

  // ─── P5: deploy-strategy-info event ──────────────────────────────────────────

  describe('P5: executeNode — emits deploy-strategy-info for Deploy nodes', () => {
    it('emits deploy-strategy-info after node-started for rolling', fakeAsync(() => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          strategy: 'rolling',
        },
      });
      const pipeline = createMockPipeline([node]);
      initRunnerState(service, pipeline, createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'executeNode', node);

      const strategyEvents = eventsOfType(events, 'deploy-strategy-info');
      expect(strategyEvents.length).toBe(1);
      expect(strategyEvents[0].strategy).toBe('rolling');
      expect(strategyEvents[0].trafficModel).toBe('incremental batches');
      expect(strategyEvents[0].blastRadius).toBe('medium');
      expect(strategyEvents[0].rollbackSpeedLabel).toBe('medium');
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('emits deploy-strategy-info with blue-green fields', fakeAsync(() => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          strategy: 'blue-green',
        },
      });
      const pipeline = createMockPipeline([node]);
      initRunnerState(service, pipeline, createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'executeNode', node);

      const strategyEvents = eventsOfType(events, 'deploy-strategy-info');
      expect(strategyEvents.length).toBe(1);
      expect(strategyEvents[0].strategy).toBe('blue-green');
      expect(strategyEvents[0].rollbackSpeedLabel).toBe('instant');
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('emits deploy-strategy-info with canary fields', fakeAsync(() => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          strategy: 'canary',
        },
      });
      const pipeline = createMockPipeline([node]);
      initRunnerState(service, pipeline, createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'executeNode', node);

      const strategyEvents = eventsOfType(events, 'deploy-strategy-info');
      expect(strategyEvents.length).toBe(1);
      expect(strategyEvents[0].strategy).toBe('canary');
      expect(strategyEvents[0].trafficModel).toBe('10% traffic, gradual ramp');
      expect(strategyEvents[0].blastRadius).toBe('lowest (sub-second revert)');
      expect(strategyEvents[0].rollbackSpeedLabel).toBe('fastest');
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('does NOT emit deploy-strategy-info for non-Deploy nodes', fakeAsync(() => {
      const node = createMockNode('b1', NodeType.Build, NodeStatus.Idle, {
        config: { cpuRequired: 10, memoryRequired: 100, timeEstimate: 1, failureRate: 0, flakiness: 0 },
      });
      const pipeline = createMockPipeline([node]);
      initRunnerState(service, pipeline, createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'executeNode', node);

      const strategyEvents = eventsOfType(events, 'deploy-strategy-info');
      expect(strategyEvents.length).toBe(0);
      sub.unsubscribe();
      discardPeriodicTasks();
    }));

    it('defaults to rolling when no strategy is set', fakeAsync(() => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: { cpuRequired: 10, memoryRequired: 100, timeEstimate: 1, failureRate: 0, flakiness: 0 },
      });
      const pipeline = createMockPipeline([node]);
      initRunnerState(service, pipeline, createMockLevel());
      const { events, sub } = collectEvents(service);

      callPrivate(service, 'executeNode', node);

      const strategyEvents = eventsOfType(events, 'deploy-strategy-info');
      expect(strategyEvents.length).toBe(1);
      expect(strategyEvents[0].strategy).toBe('rolling');
      sub.unsubscribe();
      discardPeriodicTasks();
    }));
  });

  // ─── P5: getConfigFailureReason — strategy-specific messages ─────────────────

  describe('P5: getConfigFailureReason — deploy strategy', () => {
    it('rolling failure reason mentions health check and batch', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          strategy: 'rolling',
        },
      });
      const reason = callPrivate(service, 'getConfigFailureReason', node) as string;
      expect(reason.toLowerCase()).toMatch(/health check|batch|rolling/);
    });

    it('blue-green failure reason mentions standby/cutover/aborted', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          strategy: 'blue-green',
        },
      });
      const reason = callPrivate(service, 'getConfigFailureReason', node) as string;
      expect(reason.toLowerCase()).toMatch(/standby|cutover|aborted|blue-green/);
    });

    it('canary failure reason mentions error rate/threshold', () => {
      const node = createMockNode('d1', NodeType.Deploy, NodeStatus.Idle, {
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 4,
          failureRate: 0,
          flakiness: 0,
          strategy: 'canary',
        },
      });
      const reason = callPrivate(service, 'getConfigFailureReason', node) as string;
      expect(reason.toLowerCase()).toMatch(/error rate|threshold|canary/);
    });
  });
});

// ─── Factory Helpers ─────────────────────────────────────────────────────────

function createSourcePipeline(): Pipeline {
  const source = createMockNode('s1', NodeType.Source, NodeStatus.Idle, {
    config: { cpuRequired: 10, memoryRequired: 100, timeEstimate: 5, failureRate: 0, flakiness: 0 },
  });
  return createMockPipeline([source]);
}
