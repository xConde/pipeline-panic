import { Level } from '../models/game-state.model';
import { NodeStatus, NodeType, Pipeline, PipelineNode } from '../models/pipeline.model';
import { createMockNode, createMockPipeline } from '../testing/test-utils';
import { getNodeDurationTicks, simulatePipelineSchedule } from './pipeline-scheduling';

describe('pipeline scheduling simulation', () => {
  function level(agentPoolLimit?: number): Level {
    return {
      id: 'schedule-level',
      name: 'Schedule level',
      description: '',
      requiredNodes: [NodeType.Source, NodeType.Deploy],
      maxNodes: 20,
      maxConnections: 30,
      cpuLimit: 100,
      memoryLimit: 1000,
      parTime: 12,
      prototypeRules: { deterministic: true, agentPoolLimit },
    };
  }

  function node(id: string, type: NodeType, seconds: number): PipelineNode {
    return createMockNode(id, type, NodeStatus.Idle, {
      name: id,
      config: {
        cpuRequired: 1,
        memoryRequired: 1,
        timeEstimate: seconds,
        failureRate: 0,
        flakiness: 0,
        ...(type === NodeType.Deploy ? { environment: 'dev', strategy: 'rolling' as const } : {}),
      },
    });
  }

  function connect(upstream: PipelineNode, downstream: PipelineNode): void {
    upstream.outputs.push(downstream.id);
    downstream.inputs.push(upstream.id);
  }

  function releaseRoute(): Pipeline {
    const source = node('source', NodeType.Source, 1);
    const build = node('build', NodeType.Build, 3);
    const parallel = node('parallel', NodeType.Parallel, 0.2);
    const test = node('test', NodeType.Test, 3);
    const scan = node('scan', NodeType.SecurityScan, 4);
    const deploy = node('deploy', NodeType.Deploy, 3);
    connect(source, build);
    connect(build, parallel);
    connect(parallel, test);
    connect(parallel, scan);
    connect(test, deploy);
    connect(scan, deploy);
    return createMockPipeline([source, build, parallel, test, scan, deploy]);
  }

  it('preserves the authored release tick math from one duration source', () => {
    const route = releaseRoute();
    const uncapped = simulatePipelineSchedule(route, level());
    const capped = simulatePipelineSchedule(route, level(1));

    expect(getNodeDurationTicks(route.nodes[0], level())).toBe(11);
    expect(uncapped?.totalSeconds).toBe(11.5);
    expect(uncapped?.criticalNodeIds).toEqual(['source', 'build', 'parallel', 'scan', 'deploy']);
    expect(capped?.totalSeconds).toBe(14.6);
    expect(capped?.executionOrderNodeIds).toEqual(['source', 'build', 'parallel', 'test', 'scan', 'deploy']);
    expect(capped?.criticalNodeIds).toEqual(['source', 'build', 'parallel', 'test', 'scan', 'deploy']);
  });

  it('list-schedules an arbitrary cap of two exactly with stable lanes', () => {
    const source = node('source', NodeType.Source, 1);
    const first = node('first', NodeType.Test, 2);
    const second = node('second', NodeType.SecurityScan, 2);
    const third = node('third', NodeType.Build, 2);
    const deploy = node('deploy', NodeType.Deploy, 1);
    [first, second, third].forEach((branch) => {
      connect(source, branch);
      connect(branch, deploy);
    });
    const route = createMockPipeline([source, first, second, third, deploy]);

    const schedule = simulatePipelineSchedule(route, level(2));

    expect(schedule?.totalSeconds).toBe(6.2);
    expect(schedule?.executionOrderNodeIds).toEqual(['source', 'first', 'second', 'third', 'deploy']);
    expect(schedule?.criticalNodeIds).toEqual(['source', 'first', 'third', 'deploy']);
    expect(schedule?.stages.map((stage) => [stage.nodeId, stage.startTick, stage.endTick, stage.lane])).toEqual([
      ['source', 0, 11, 0],
      ['first', 11, 31, 0],
      ['second', 11, 31, 1],
      ['third', 31, 51, 0],
      ['deploy', 51, 62, 0],
    ]);
  });

  it('schedules an input-less non-Source as a real root rather than forecast-only work', () => {
    const route = releaseRoute();
    route.nodes.push(node('floating', NodeType.Notification, 12));

    const schedule = simulatePipelineSchedule(route, level());
    const floating = schedule?.stages.find((stage) => stage.nodeId === 'floating');

    expect(floating).toEqual(jasmine.objectContaining({ startTick: 0, endTick: 121 }));
    expect(schedule?.totalSeconds).toBe(12.1);
    expect(schedule?.criticalNodeIds).toEqual(['floating']);
  });

  it('treats an agent cap above the route size as unbounded without allocating one lane per cap', () => {
    const route = releaseRoute();

    const uncapped = simulatePipelineSchedule(route, level());
    const oversized = simulatePipelineSchedule(route, level(Number.MAX_SAFE_INTEGER));

    expect(oversized).toEqual(uncapped);
    expect(oversized?.stages.every((stage) => stage.lane < route.nodes.length)).toBeTrue();
  });

  it('refuses unsupported timing configuration from restored or hand-built routes', () => {
    const invalidCases: ReadonlyArray<{
      readonly type: NodeType;
      readonly property: string;
      readonly value: unknown;
    }> = [
      { type: NodeType.Build, property: 'optimizationLevel', value: 'instant' },
      { type: NodeType.Test, property: 'coverageThreshold', value: 80 },
      { type: NodeType.Deploy, property: 'environment', value: 'qa' },
      { type: NodeType.Deploy, property: 'strategy', value: 'all-at-once' },
    ];

    for (const invalidCase of invalidCases) {
      const route = releaseRoute();
      const target = route.nodes.find((candidate) => candidate.type === invalidCase.type);
      expect(target).toBeDefined();
      if (!target) throw new Error(`Missing ${invalidCase.type} test node`);
      Object.defineProperty(target.config, invalidCase.property, { value: invalidCase.value });

      expect(simulatePipelineSchedule(route, level())).toBeNull();
    }
  });

  it('refuses cycles, dangling inputs, duplicate ids, malformed durations, and invalid limits', () => {
    const cycle = releaseRoute();
    cycle.nodes[0].inputs.push('deploy');
    const dangling = releaseRoute();
    dangling.nodes[1].inputs.push('missing');
    const duplicate = releaseRoute();
    duplicate.nodes[1].id = 'source';
    const malformed = releaseRoute();
    malformed.nodes[1].config.timeEstimate = Number.NaN;
    const extreme = releaseRoute();
    extreme.nodes[1].config.timeEstimate = Number.MAX_VALUE;

    expect(simulatePipelineSchedule(cycle, level())).toBeNull();
    expect(simulatePipelineSchedule(dangling, level())).toBeNull();
    expect(simulatePipelineSchedule(duplicate, level())).toBeNull();
    expect(simulatePipelineSchedule(malformed, level())).toBeNull();
    expect(getNodeDurationTicks(extreme.nodes[1], level())).toBeNull();
    expect(simulatePipelineSchedule(extreme, level())).toBeNull();
    expect(simulatePipelineSchedule(releaseRoute(), level(0))).toBeNull();
    expect(simulatePipelineSchedule(releaseRoute(), level(1.5))).toBeNull();
  });
});
