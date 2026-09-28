import { TestBed } from '@angular/core/testing';
import { PipelineBuilderService } from './pipeline-builder.service';
import { NodeStatus, NodeType, Pipeline, PipelineNode } from '../models/pipeline.model';
import { GAME_CONSTANTS } from '../game-constants';

describe('PipelineBuilderService', () => {
  let service: PipelineBuilderService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [PipelineBuilderService],
    });
    service = TestBed.inject(PipelineBuilderService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('createEmptyPipeline', () => {
    it('should create a valid empty pipeline', () => {
      const pipeline = service.createEmptyPipeline();

      expect(pipeline).toBeDefined();
      expect(pipeline.id).toContain('pipeline-');
      expect(pipeline.name).toBe('New Pipeline');
      expect(pipeline.nodes).toEqual([]);
      expect(pipeline.connections).toEqual([]);
      expect(pipeline.isValid).toBe(false);
      expect(pipeline.isRunning).toBe(false);
    });

    it('should initialize metrics to zero', () => {
      const pipeline = service.createEmptyPipeline();

      expect(pipeline.totalExecutionTime).toBe(0);
      expect(pipeline.successRate).toBe(0);
      expect(pipeline.throughput).toBe(0);
      expect(pipeline.totalCpuUsed).toBe(0);
      expect(pipeline.totalMemoryUsed).toBe(0);
      expect(pipeline.parallelExecutions).toBe(0);
    });

    it('should create unique IDs for each pipeline', () => {
      const pipeline1 = service.createEmptyPipeline();
      const pipeline2 = service.createEmptyPipeline();

      expect(pipeline1.id).not.toBe(pipeline2.id);
    });
  });

  describe('canConnect', () => {
    let sourceNode: PipelineNode;
    let buildNode: PipelineNode;
    let testNode: PipelineNode;
    let deployNode: PipelineNode;

    beforeEach(() => {
      sourceNode = createMockNode('source-1', NodeType.Source);
      buildNode = createMockNode('build-1', NodeType.Build);
      testNode = createMockNode('test-1', NodeType.Test);
      deployNode = createMockNode('deploy-1', NodeType.Deploy);
    });

    it('should allow valid connections', () => {
      expect(service.canConnect(sourceNode, buildNode)).toBe(true);
      expect(service.canConnect(buildNode, testNode)).toBe(true);
      expect(service.canConnect(testNode, deployNode)).toBe(true);
    });

    it('should prevent connecting to self', () => {
      expect(service.canConnect(sourceNode, sourceNode)).toBe(false);
    });

    it('should prevent duplicate connections', () => {
      sourceNode.outputs.push(buildNode.id);

      expect(service.canConnect(sourceNode, buildNode)).toBe(false);
    });

    it('should prevent invalid Deploy → Source connection', () => {
      expect(service.canConnect(deployNode, sourceNode)).toBe(false);
    });

    it('should prevent invalid Deploy → Build connection', () => {
      expect(service.canConnect(deployNode, buildNode)).toBe(false);
    });

    it('should prevent invalid Test → Source connection', () => {
      expect(service.canConnect(testNode, sourceNode)).toBe(false);
    });
  });

  describe('hasCycles', () => {
    it('should return false for acyclic pipeline', () => {
      const pipeline = createLinearPipeline();

      expect(service.hasCycles(pipeline)).toBe(false);
    });

    it('should detect simple cycles', () => {
      const pipeline = service.createEmptyPipeline();
      const node1 = createMockNode('node-1', NodeType.Build);
      const node2 = createMockNode('node-2', NodeType.Test);

      // Create cycle: node1 → node2 → node1
      node1.outputs.push(node2.id);
      node2.inputs.push(node1.id);
      node2.outputs.push(node1.id);
      node1.inputs.push(node2.id);

      pipeline.nodes = [node1, node2];

      expect(service.hasCycles(pipeline)).toBe(true);
    });

    it('should detect cycles in complex pipelines', () => {
      const pipeline = service.createEmptyPipeline();
      const node1 = createMockNode('node-1', NodeType.Source);
      const node2 = createMockNode('node-2', NodeType.Build);
      const node3 = createMockNode('node-3', NodeType.Test);

      // Create cycle: 1 → 2 → 3 → 1
      node1.outputs.push(node2.id);
      node2.inputs.push(node1.id);
      node2.outputs.push(node3.id);
      node3.inputs.push(node2.id);
      node3.outputs.push(node1.id);
      node1.inputs.push(node3.id);

      pipeline.nodes = [node1, node2, node3];

      expect(service.hasCycles(pipeline)).toBe(true);
    });
  });

  describe('validatePipeline', () => {
    it('should fail validation without source node', () => {
      const pipeline = service.createEmptyPipeline();
      const buildNode = createMockNode('build-1', NodeType.Build);
      const deployNode = createMockNode('deploy-1', NodeType.Deploy);

      pipeline.nodes = [buildNode, deployNode];

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(false);
      expect(pipeline.errors.length).toBeGreaterThan(0);
      expect(pipeline.errors.some((e) => e.message.includes('source'))).toBe(true);
    });

    it('should fail validation without deploy node', () => {
      const pipeline = service.createEmptyPipeline();
      const sourceNode = createMockNode('source-1', NodeType.Source);
      const buildNode = createMockNode('build-1', NodeType.Build);

      pipeline.nodes = [sourceNode, buildNode];

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(false);
      expect(pipeline.errors.some((e) => e.message.includes('deploy'))).toBe(true);
    });

    it('should fail validation with cycles', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const build = createMockNode('build-1', NodeType.Build);
      const deploy = createMockNode('deploy-1', NodeType.Deploy);

      // Create cycle
      source.outputs.push(build.id);
      build.inputs.push(source.id);
      build.outputs.push(deploy.id);
      deploy.inputs.push(build.id);
      deploy.outputs.push(source.id);
      source.inputs.push(deploy.id);

      pipeline.nodes = [source, build, deploy];

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(false);
      expect(pipeline.errors.some((e) => e.message.includes('circular'))).toBe(true);
    });

    it('should warn about orphaned nodes', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const build = createMockNode('build-1', NodeType.Build);
      const deploy = createMockNode('deploy-1', NodeType.Deploy);

      // build node is orphaned (no inputs)
      pipeline.nodes = [source, build, deploy];

      service.validatePipeline(pipeline);

      const warnings = pipeline.errors.filter((e) => e.severity === 'warning');
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('should pass validation for valid pipeline', () => {
      const pipeline = createLinearPipeline();

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(true);
      expect(pipeline.isValid).toBe(true);
      const criticalErrors = pipeline.errors.filter((e) => e.severity === 'error');
      expect(criticalErrors.length).toBe(0);
    });
  });

  describe('hasRequiredUpstreamNodes', () => {
    const connect = (source: PipelineNode, target: PipelineNode): void => {
      source.outputs.push(target.id);
      target.inputs.push(source.id);
    };

    const releaseGateTypes = [NodeType.Build, NodeType.Test, NodeType.SecurityScan, NodeType.Parallel];

    it('accepts a split where Test and SecurityScan both feed Deploy', () => {
      const source = createMockNode('source', NodeType.Source);
      const build = createMockNode('build', NodeType.Build);
      const parallel = createMockNode('parallel', NodeType.Parallel);
      const test = createMockNode('test', NodeType.Test);
      const scan = createMockNode('scan', NodeType.SecurityScan);
      const deploy = createMockNode('deploy', NodeType.Deploy);
      connect(source, build);
      connect(build, parallel);
      connect(parallel, test);
      connect(parallel, scan);
      connect(test, deploy);
      connect(scan, deploy);
      const pipeline = service.createEmptyPipeline();
      pipeline.nodes = [source, build, parallel, test, scan, deploy];

      expect(service.hasRequiredUpstreamNodes(pipeline, NodeType.Deploy, releaseGateTypes)).toBeTrue();
    });

    it('accepts a merge after Test and SecurityScan', () => {
      const source = createMockNode('source', NodeType.Source);
      const build = createMockNode('build', NodeType.Build);
      const test = createMockNode('test', NodeType.Test);
      const scan = createMockNode('scan', NodeType.SecurityScan);
      const parallel = createMockNode('parallel', NodeType.Parallel);
      const deploy = createMockNode('deploy', NodeType.Deploy);
      connect(source, build);
      connect(build, test);
      connect(build, scan);
      connect(test, parallel);
      connect(scan, parallel);
      connect(parallel, deploy);
      const pipeline = service.createEmptyPipeline();
      pipeline.nodes = [source, build, test, scan, parallel, deploy];

      expect(service.hasRequiredUpstreamNodes(pipeline, NodeType.Deploy, releaseGateTypes)).toBeTrue();
    });

    it('rejects a shortcut Deploy while required nodes run on another branch', () => {
      const source = createMockNode('source', NodeType.Source);
      const build = createMockNode('build', NodeType.Build);
      const parallel = createMockNode('parallel', NodeType.Parallel);
      const test = createMockNode('test', NodeType.Test);
      const scan = createMockNode('scan', NodeType.SecurityScan);
      const deploy = createMockNode('deploy', NodeType.Deploy);
      connect(source, deploy);
      connect(source, build);
      connect(build, parallel);
      connect(parallel, test);
      connect(parallel, scan);
      const pipeline = service.createEmptyPipeline();
      pipeline.nodes = [source, build, parallel, test, scan, deploy];

      expect(service.hasRequiredUpstreamNodes(pipeline, NodeType.Deploy, releaseGateTypes)).toBeFalse();
      expect(service.getMissingRequiredUpstreamNodeTypes(pipeline, NodeType.Deploy, releaseGateTypes)).toEqual(
        releaseGateTypes
      );
    });
  });

  describe('getExecutionOrder', () => {
    it('should return nodes in execution order', () => {
      const pipeline = createLinearPipeline();

      const ordered = service.getExecutionOrder(pipeline);

      expect(ordered.length).toBe(4);
      expect(ordered[0].type).toBe(NodeType.Source);
      expect(ordered[ordered.length - 1].type).toBe(NodeType.Deploy);
    });

    it('should handle parallel branches', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const build1 = createMockNode('build-1', NodeType.Build);
      const build2 = createMockNode('build-2', NodeType.Build);

      source.outputs.push(build1.id, build2.id);
      build1.inputs.push(source.id);
      build2.inputs.push(source.id);

      pipeline.nodes = [source, build1, build2];

      const ordered = service.getExecutionOrder(pipeline);

      expect(ordered[0].type).toBe(NodeType.Source);
      expect(ordered.length).toBe(3);
    });
  });

  describe('resetPipeline', () => {
    it('should reset all node statuses to idle', () => {
      const pipeline = createLinearPipeline();
      pipeline.nodes.forEach((node) => {
        node.status = NodeStatus.Success;
        node.processingTime = 100;
      });

      service.resetPipeline(pipeline);

      pipeline.nodes.forEach((node) => {
        expect(node.status).toBe(NodeStatus.Idle);
        expect(node.processingTime).toBe(0);
      });
    });

    it('RTG: clears executionCount + retriesRemaining so retries re-seed on the next run', () => {
      // Without this, the runner seed guard `if (executionCount === 0)` never re-fires
      // after run 1, so a Test node that consumed its retries silently gets ZERO retries
      // on every Reset-and-rerun while the palette still shows the configured count.
      const pipeline = createLinearPipeline();
      const testNode = pipeline.nodes[0];
      testNode.config.retryCount = 2;
      // Simulate state at the end of a prior run that exhausted retries.
      testNode.executionCount = 3;
      testNode.retriesRemaining = 0;
      testNode.lastStatus = NodeStatus.Failed;
      testNode.lastFailureReason = 'flaky';

      service.resetPipeline(pipeline);

      expect(testNode.executionCount).toBe(0); // seed guard `executionCount === 0` re-fires
      expect(testNode.retriesRemaining).toBeUndefined(); // re-read from config.retryCount next run
      expect(testNode.lastStatus).toBeNull();
      expect(testNode.lastFailureReason).toBeUndefined();
      expect(testNode.config.retryCount).toBe(2); // config (the player's choice) is preserved
    });

    it('should reset connection statuses', () => {
      const pipeline = createLinearPipeline();
      pipeline.connections.forEach((conn) => {
        conn.status = 'active';
      });

      service.resetPipeline(pipeline);

      pipeline.connections.forEach((conn) => {
        expect(conn.status).toBe('inactive');
      });
    });

    it('should reset pipeline running state', () => {
      const pipeline = createLinearPipeline();
      pipeline.isRunning = true;
      pipeline.totalExecutionTime = 1000;

      service.resetPipeline(pipeline);

      expect(pipeline.isRunning).toBe(false);
      expect(pipeline.totalExecutionTime).toBe(0);
    });

    describe('Conditional node reset (Level 5 - round-robin fix)', () => {
      it('should reset conditionIndex for Conditional nodes in round-robin mode', () => {
        const pipeline = service.createEmptyPipeline();
        const conditionalNode = createMockNode('cond-1', NodeType.Conditional);
        conditionalNode.config.conditionType = 'round-robin';
        conditionalNode.config.conditionIndex = 3; // Simulating used 3 times

        pipeline.nodes.push(conditionalNode);

        service.resetPipeline(pipeline);

        expect(conditionalNode.config.conditionIndex).toBe(0);
        expect(conditionalNode.status).toBe(NodeStatus.Idle);
      });

      it('should handle Conditional nodes without conditionIndex (random mode)', () => {
        const pipeline = service.createEmptyPipeline();
        const conditionalNode = createMockNode('cond-1', NodeType.Conditional);
        conditionalNode.config.conditionType = 'random';
        // No conditionIndex set

        pipeline.nodes.push(conditionalNode);

        // Should not crash
        expect(() => service.resetPipeline(pipeline)).not.toThrow();
        expect(conditionalNode.status).toBe(NodeStatus.Idle);
      });

      it('should reset conditionIndex for multiple Conditional nodes', () => {
        const pipeline = service.createEmptyPipeline();
        const cond1 = createMockNode('cond-1', NodeType.Conditional);
        const cond2 = createMockNode('cond-2', NodeType.Conditional);

        cond1.config.conditionType = 'round-robin';
        cond1.config.conditionIndex = 2;
        cond2.config.conditionType = 'round-robin';
        cond2.config.conditionIndex = 5;

        pipeline.nodes.push(cond1, cond2);

        service.resetPipeline(pipeline);

        expect(cond1.config.conditionIndex).toBe(0);
        expect(cond2.config.conditionIndex).toBe(0);
      });

      it('should not affect non-Conditional nodes', () => {
        const pipeline = createLinearPipeline();
        const conditionalNode = createMockNode('cond-1', NodeType.Conditional);
        conditionalNode.config.conditionType = 'round-robin';
        conditionalNode.config.conditionIndex = 4;

        pipeline.nodes.push(conditionalNode);

        service.resetPipeline(pipeline);

        // All nodes reset, but only Conditional affected
        pipeline.nodes.forEach((node) => {
          expect(node.status).toBe(NodeStatus.Idle);
          if (node.type === NodeType.Conditional) {
            expect(node.config.conditionIndex).toBe(0);
          }
        });
      });

      it('should not set conditionIndex if undefined (random mode edge case)', () => {
        const pipeline = service.createEmptyPipeline();
        const conditionalNode = createMockNode('cond-1', NodeType.Conditional);
        conditionalNode.config.conditionType = 'random';
        conditionalNode.config.conditionIndex = undefined;

        pipeline.nodes.push(conditionalNode);

        service.resetPipeline(pipeline);

        // Should remain undefined (only resets if already set)
        expect(conditionalNode.config.conditionIndex).toBeUndefined();
        expect(conditionalNode.status).toBe(NodeStatus.Idle);
      });
    });
  });

  // ===== DEEP DIVE #5: Pipeline Validation - Critical Connection Errors =====
  describe('validatePipeline - Critical Connection Errors', () => {
    it('should fail validation when Source node has no outputs', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const deploy = createMockNode('deploy-1', NodeType.Deploy);

      // Source has no outputs - pipeline cannot flow
      deploy.inputs.push('some-other-node'); // Deploy has inputs but not from source

      pipeline.nodes = [source, deploy];

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(false);
      const sourceError = pipeline.errors.find(
        (e) => e.nodeId === 'source-1' && e.severity === 'error' && e.message.includes('no outputs')
      );
      expect(sourceError).toBeDefined();
    });

    it('should fail validation when Deploy node has no inputs', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const deploy = createMockNode('deploy-1', NodeType.Deploy);

      // Source outputs to something else, Deploy has no inputs
      source.outputs.push('some-other-node');

      pipeline.nodes = [source, deploy];

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(false);
      const deployError = pipeline.errors.find(
        (e) => e.nodeId === 'deploy-1' && e.severity === 'error' && e.message.includes('no inputs')
      );
      expect(deployError).toBeDefined();
    });

    it('should pass validation for minimal valid pipeline (Source→Deploy)', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const deploy = createMockNode('deploy-1', NodeType.Deploy);

      // Properly connected: Source → Deploy
      source.outputs.push(deploy.id);
      deploy.inputs.push(source.id);

      pipeline.nodes = [source, deploy];

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(true);
      const criticalErrors = pipeline.errors.filter((e) => e.severity === 'error');
      expect(criticalErrors.length).toBe(0);
    });

    it('should detect multiple critical errors at once', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const deploy = createMockNode('deploy-1', NodeType.Deploy);

      // Both nodes disconnected
      pipeline.nodes = [source, deploy];

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(false);
      // Should have errors for: Source no outputs, Deploy no inputs
      const criticalErrors = pipeline.errors.filter((e) => e.severity === 'error');
      expect(criticalErrors.length).toBeGreaterThanOrEqual(2);
    });

    it('should pass validation for complex valid pipeline', () => {
      const pipeline = createLinearPipeline();

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(true);
      const criticalErrors = pipeline.errors.filter((e) => e.severity === 'error');
      expect(criticalErrors.length).toBe(0);
    });
  });

  describe('isNodeTooClose', () => {
    it('should return conflicting node when too close', () => {
      const existingNode = createMockNode('node-1', NodeType.Build);
      existingNode.x = 100;
      existingNode.y = 100;

      const result = service.isNodeTooClose(120, 120, [existingNode]);

      expect(result).toBe(existingNode);
    });

    it('should return null when far enough apart', () => {
      const existingNode = createMockNode('node-1', NodeType.Build);
      existingNode.x = 100;
      existingNode.y = 100;

      const result = service.isNodeTooClose(300, 300, [existingNode]);

      expect(result).toBeNull();
    });

    it('should return null at exactly the minimum spacing boundary', () => {
      const existingNode = createMockNode('node-1', NodeType.Build);
      existingNode.x = 0;
      existingNode.y = 0;

      // Place at exactly MIN_NODE_SPACING distance on X axis
      const result = service.isNodeTooClose(GAME_CONSTANTS.MIN_NODE_SPACING, 0, [existingNode]);

      expect(result).toBeNull();
    });

    it('should exclude specified node id', () => {
      const existingNode = createMockNode('node-1', NodeType.Build);
      existingNode.x = 100;
      existingNode.y = 100;

      // Same position, but excluded
      const result = service.isNodeTooClose(100, 100, [existingNode], 'node-1');

      expect(result).toBeNull();
    });

    it('should return first conflicting node when multiple are close', () => {
      const node1 = createMockNode('node-1', NodeType.Build);
      node1.x = 100;
      node1.y = 100;
      const node2 = createMockNode('node-2', NodeType.Test);
      node2.x = 110;
      node2.y = 100;

      const result = service.isNodeTooClose(105, 100, [node1, node2]);

      expect(result).not.toBeNull();
      // Should return the first conflicting node (node1)
      expect(result).toBe(node1);
    });

    it('should return null for empty node list', () => {
      const result = service.isNodeTooClose(100, 100, []);
      expect(result).toBeNull();
    });
  });

  describe('isValidCoordinate', () => {
    it('should accept valid coordinates', () => {
      expect(PipelineBuilderService.isValidCoordinate(0, 0)).toBe(true);
      expect(PipelineBuilderService.isValidCoordinate(500, 300)).toBe(true);
      expect(PipelineBuilderService.isValidCoordinate(10000, 10000)).toBe(true);
    });

    it('should reject NaN values', () => {
      expect(PipelineBuilderService.isValidCoordinate(NaN, 100)).toBe(false);
      expect(PipelineBuilderService.isValidCoordinate(100, NaN)).toBe(false);
    });

    it('should reject Infinity values', () => {
      expect(PipelineBuilderService.isValidCoordinate(Infinity, 100)).toBe(false);
      expect(PipelineBuilderService.isValidCoordinate(100, -Infinity)).toBe(false);
    });

    it('should reject negative values', () => {
      expect(PipelineBuilderService.isValidCoordinate(-1, 100)).toBe(false);
      expect(PipelineBuilderService.isValidCoordinate(100, -1)).toBe(false);
    });

    it('should reject values beyond bounds', () => {
      expect(PipelineBuilderService.isValidCoordinate(10001, 100)).toBe(false);
      expect(PipelineBuilderService.isValidCoordinate(100, 10001)).toBe(false);
    });
  });

  describe('canConnectWithConstraints', () => {
    it('should reject when at max connections', () => {
      const source = createMockNode('source-1', NodeType.Source);
      const target = createMockNode('build-1', NodeType.Build);
      const pipeline = service.createEmptyPipeline();
      // Fill up to max
      pipeline.connections = [
        { id: 'c1', sourceId: 'a', targetId: 'b', status: 'inactive', dataFlow: [] },
        { id: 'c2', sourceId: 'c', targetId: 'd', status: 'inactive', dataFlow: [] },
      ];

      const result = service.canConnectWithConstraints(source, target, pipeline, 2);

      expect(result).toBe(false);
    });

    it('should pass when under connection limit', () => {
      const source = createMockNode('source-1', NodeType.Source);
      const target = createMockNode('build-1', NodeType.Build);
      const pipeline = service.createEmptyPipeline();
      pipeline.connections = [{ id: 'c1', sourceId: 'a', targetId: 'b', status: 'inactive', dataFlow: [] }];

      const result = service.canConnectWithConstraints(source, target, pipeline, 5);

      expect(result).toBe(true);
    });

    it('should reject invalid connections regardless of limit', () => {
      const source = createMockNode('source-1', NodeType.Source);
      // Self-connect is always invalid
      const pipeline = service.createEmptyPipeline();

      const result = service.canConnectWithConstraints(source, source, pipeline, 100);

      expect(result).toBe(false);
    });
  });

  describe('validatePipeline - reachability check', () => {
    it('should warn about unreachable nodes', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const build = createMockNode('build-1', NodeType.Build);
      const orphanTest = createMockNode('test-1', NodeType.Test);
      const deploy = createMockNode('deploy-1', NodeType.Deploy);

      // Source → Build → Deploy, but Test is disconnected from flow
      source.outputs.push(build.id);
      build.inputs.push(source.id);
      build.outputs.push(deploy.id);
      deploy.inputs.push(build.id);

      // orphanTest has inputs/outputs to avoid other warnings but not from source path
      // Actually, it must be isolated from source to be flagged as unreachable
      pipeline.nodes = [source, build, orphanTest, deploy];

      service.validatePipeline(pipeline);

      const reachabilityWarning = pipeline.errors.find(
        (e) => e.nodeId === 'test-1' && e.message.includes('not reachable')
      );
      expect(reachabilityWarning).toBeDefined();
    });

    it('should not warn about reachable nodes', () => {
      const pipeline = createLinearPipeline();

      service.validatePipeline(pipeline);

      const reachabilityWarnings = pipeline.errors.filter((e) => e.message.includes('not reachable'));
      expect(reachabilityWarnings.length).toBe(0);
    });

    it('should mark all source-connected nodes as reachable in diamond topology', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const build1 = createMockNode('build-1', NodeType.Build);
      const build2 = createMockNode('build-2', NodeType.Build);
      const deploy = createMockNode('deploy-1', NodeType.Deploy);

      // Diamond: Source → Build1, Source → Build2, Build1 → Deploy, Build2 → Deploy
      source.outputs.push(build1.id, build2.id);
      build1.inputs.push(source.id);
      build1.outputs.push(deploy.id);
      build2.inputs.push(source.id);
      build2.outputs.push(deploy.id);
      deploy.inputs.push(build1.id, build2.id);

      pipeline.nodes = [source, build1, build2, deploy];

      service.validatePipeline(pipeline);

      const reachabilityWarnings = pipeline.errors.filter((e) => e.message.includes('not reachable'));
      expect(reachabilityWarnings.length).toBe(0);
    });
  });

  describe('validatePipeline - Edge Cases', () => {
    it('should handle empty pipeline gracefully', () => {
      const pipeline = service.createEmptyPipeline();

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(false);
      // Should report missing source and deploy
      expect(pipeline.errors.some((e) => e.message.includes('source'))).toBe(true);
      expect(pipeline.errors.some((e) => e.message.includes('deploy'))).toBe(true);
    });

    it('should handle single node pipeline (Source only)', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      pipeline.nodes = [source];

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(false);
      // Missing deploy AND source has no outputs
      expect(pipeline.errors.some((e) => e.message.includes('deploy'))).toBe(true);
      expect(pipeline.errors.some((e) => e.message.includes('no outputs'))).toBe(true);
    });

    it('should handle single node pipeline (Deploy only)', () => {
      const pipeline = service.createEmptyPipeline();
      const deploy = createMockNode('deploy-1', NodeType.Deploy);
      pipeline.nodes = [deploy];

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(false);
      // Missing source AND deploy has no inputs
      expect(pipeline.errors.some((e) => e.message.includes('source'))).toBe(true);
      expect(pipeline.errors.some((e) => e.message.includes('no inputs'))).toBe(true);
    });

    it('should warn about orphaned intermediate nodes', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const orphanBuild = createMockNode('build-1', NodeType.Build);
      const deploy = createMockNode('deploy-1', NodeType.Deploy);

      // Source → Deploy, but Build is orphaned
      source.outputs.push(deploy.id);
      deploy.inputs.push(source.id);

      pipeline.nodes = [source, orphanBuild, deploy];

      service.validatePipeline(pipeline);

      // Build should have warnings for no inputs AND no outputs
      const buildWarnings = pipeline.errors.filter((e) => e.nodeId === 'build-1' && e.severity === 'warning');
      expect(buildWarnings.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect cycles in diamond topology', () => {
      const pipeline = service.createEmptyPipeline();
      const source = createMockNode('source-1', NodeType.Source);
      const build1 = createMockNode('build-1', NodeType.Build);
      const build2 = createMockNode('build-2', NodeType.Build);
      const deploy = createMockNode('deploy-1', NodeType.Deploy);

      // Create cycle: build1 → build2 → build1
      source.outputs.push(build1.id, build2.id);
      build1.inputs.push(source.id, build2.id);
      build1.outputs.push(build2.id, deploy.id);
      build2.inputs.push(source.id, build1.id);
      build2.outputs.push(build1.id, deploy.id);
      deploy.inputs.push(build1.id, build2.id);

      pipeline.nodes = [source, build1, build2, deploy];

      const isValid = service.validatePipeline(pipeline);

      expect(isValid).toBe(false);
      expect(pipeline.errors.some((e) => e.message.includes('circular'))).toBe(true);
    });
  });
});

// Helper functions
function createMockNode(id: string, type: NodeType): PipelineNode {
  return {
    id,
    type,
    name: type.charAt(0).toUpperCase() + type.slice(1),
    x: 0,
    y: 0,
    status: NodeStatus.Idle,
    config: {
      cpuRequired: 10,
      memoryRequired: 100,
      timeEstimate: 5,
      failureRate: 0.01,
      flakiness: 0,
    },
    processingTime: 0,
    cpuUsage: 10,
    memoryUsage: 100,
    inputs: [],
    outputs: [],
    color: '#ffffff',
    icon: 'ICN',
    particles: [],
    executionCount: 0,
    lastStatus: null,
  };
}

function createLinearPipeline(): Pipeline {
  const service = new PipelineBuilderService();
  const pipeline = service.createEmptyPipeline();

  const source = createMockNode('source-1', NodeType.Source);
  source.name = 'Git Source';
  const build = createMockNode('build-1', NodeType.Build);
  const test = createMockNode('test-1', NodeType.Test);
  const deploy = createMockNode('deploy-1', NodeType.Deploy);

  // Connect: source → build → test → deploy
  source.outputs.push(build.id);
  build.inputs.push(source.id);
  build.outputs.push(test.id);
  test.inputs.push(build.id);
  test.outputs.push(deploy.id);
  deploy.inputs.push(test.id);

  pipeline.nodes = [source, build, test, deploy];
  pipeline.connections = [
    {
      id: 'conn-1',
      sourceId: source.id,
      targetId: build.id,
      status: 'inactive',
      dataFlow: [],
    },
    {
      id: 'conn-2',
      sourceId: build.id,
      targetId: test.id,
      status: 'inactive',
      dataFlow: [],
    },
    {
      id: 'conn-3',
      sourceId: test.id,
      targetId: deploy.id,
      status: 'inactive',
      dataFlow: [],
    },
  ];

  return pipeline;
}
