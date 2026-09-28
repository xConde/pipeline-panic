import { PipelineExecutionService } from './pipeline-execution.service';
import { CoverageThreshold, NodeStatus, NodeType, ScanType } from '../models/pipeline.model';
import { createMockNode, createMockPipeline } from '../testing/test-utils';
import { DUAL_SCAN_TYPES, SCAN_SEVERITY_TABLES } from '../game-constants';

describe('PipelineExecutionService', () => {
  let service: PipelineExecutionService;
  beforeEach(() => {
    service = new PipelineExecutionService();
  });

  describe('checkPurposefulFailure', () => {
    describe('Level 1 (Tutorial)', () => {
      it('should never fail on level 1 regardless of node type', () => {
        const level = { securityAudit: false, fridayDeploy: false, rushHour: false } as never;
        const pipeline = createMockPipeline();

        const nodeTypes = [NodeType.Build, NodeType.Test, NodeType.Deploy, NodeType.SecurityScan];

        nodeTypes.forEach((type) => {
          const node = createMockNode('test-node', type);
          const result = service.checkPurposefulFailure(node, level, 0, pipeline);
          expect(result.shouldFail).toBeFalse();
        });
      });
    });

    describe('deterministic prototype', () => {
      const level = {
        securityAudit: false,
        fridayDeploy: true,
        rushHour: true,
        prototypeRules: { deterministic: true },
      } as never;

      it('skips random Friday and Rush Hour failures even when their rolls would fail', () => {
        spyOn(Math, 'random').and.returnValue(0);
        const deployNode = createMockNode('deploy-1', NodeType.Deploy);
        const testNode = createMockNode('test-1', NodeType.Test);
        const pipeline = createMockPipeline([testNode, deployNode]);

        expect(service.checkPurposefulFailure(testNode, level, 2, pipeline).shouldFail).toBeFalse();
        expect(service.checkPurposefulFailure(deployNode, level, 2, pipeline).shouldFail).toBeFalse();
      });

      it('still enforces deterministic security policy gates', () => {
        const secureLevel = {
          securityAudit: true,
          fridayDeploy: true,
          rushHour: true,
          prototypeRules: { deterministic: true },
        } as never;
        const deployNode = createMockNode('deploy-1', NodeType.Deploy);
        const pipeline = createMockPipeline([deployNode]);

        const result = service.checkPurposefulFailure(deployNode, secureLevel, 2, pipeline);

        expect(result.shouldFail).toBeTrue();
        expect(result.reason).toContain('Security audit failed');
      });
    });

    describe('Security Audit (Level 2+)', () => {
      const level = { securityAudit: true, fridayDeploy: false, rushHour: false } as never;

      it('should fail Deploy without passing SecurityScan', () => {
        const deployNode = createMockNode('deploy-1', NodeType.Deploy);
        const pipeline = createMockPipeline([
          createMockNode('source-1', NodeType.Source, NodeStatus.Success),
          createMockNode('build-1', NodeType.Build, NodeStatus.Success),
          deployNode,
        ]);

        const result = service.checkPurposefulFailure(deployNode, level, 1, pipeline);

        expect(result.shouldFail).toBeTrue();
        expect(result.reason).toContain('Security audit failed');
      });

      it('should allow Deploy after SecurityScan passes', () => {
        const deployNode = createMockNode('deploy-1', NodeType.Deploy);
        const pipeline = createMockPipeline([
          createMockNode('source-1', NodeType.Source, NodeStatus.Success),
          createMockNode('security-1', NodeType.SecurityScan, NodeStatus.Success),
          deployNode,
        ]);

        const result = service.checkPurposefulFailure(deployNode, level, 1, pipeline);

        expect(result.shouldFail).toBeFalse();
      });

      it('should not affect non-Deploy nodes', () => {
        const testNode = createMockNode('test-1', NodeType.Test);
        const pipeline = createMockPipeline([testNode]);

        const result = service.checkPurposefulFailure(testNode, level, 1, pipeline);

        expect(result.shouldFail).toBeFalse();
      });

      it('should fail if SecurityScan exists but did not pass', () => {
        const deployNode = createMockNode('deploy-1', NodeType.Deploy);
        const pipeline = createMockPipeline([
          createMockNode('security-1', NodeType.SecurityScan, NodeStatus.Running),
          deployNode,
        ]);

        const result = service.checkPurposefulFailure(deployNode, level, 1, pipeline);

        expect(result.shouldFail).toBeTrue();
      });
    });

    describe('Friday Deploy (Level 4)', () => {
      const level = { securityAudit: false, fridayDeploy: true, rushHour: false } as never;

      it('should make exactly one 10% roll per check', () => {
        const deployNode = createMockNode('deploy-1', NodeType.Deploy);
        const pipeline = createMockPipeline([deployNode]);
        const randomSpy = spyOn(Math, 'random').and.returnValue(0.05);

        const result = service.checkPurposefulFailure(deployNode, level, 3, pipeline);

        expect(result.shouldFail).toBeTrue();
        expect(randomSpy).toHaveBeenCalledTimes(1);
      });

      it('should not affect non-Deploy nodes', () => {
        const buildNode = createMockNode('build-1', NodeType.Build);
        const pipeline = createMockPipeline([buildNode]);

        // Run multiple times - should never fail
        for (let i = 0; i < 100; i++) {
          const result = service.checkPurposefulFailure(buildNode, level, 3, pipeline);
          expect(result.shouldFail).toBeFalse();
        }
      });
    });

    describe('Rush Hour modifier', () => {
      const level = { securityAudit: false, fridayDeploy: false, rushHour: true } as never;

      it('should make exactly one 8% roll per check', () => {
        const testNode = createMockNode('test-1', NodeType.Test);
        const pipeline = createMockPipeline([testNode]);
        const randomSpy = spyOn(Math, 'random').and.returnValue(0.07);

        const result = service.checkPurposefulFailure(testNode, level, 2, pipeline);

        expect(result.shouldFail).toBeTrue();
        expect(randomSpy).toHaveBeenCalledTimes(1);
      });

      it('should provide flakiness reason for Test failures', () => {
        const testNode = createMockNode('test-1', NodeType.Test);
        const pipeline = createMockPipeline([testNode]);
        spyOn(Math, 'random').and.returnValue(0);

        const result = service.checkPurposefulFailure(testNode, level, 2, pipeline);

        expect(result.shouldFail).toBeTrue();
        expect(result.reason).toContain('flaky');
      });
    });

    describe('Dual-scan compliance', () => {
      const level = {
        securityAudit: true,
        requireDualScanTypes: true,
        fridayDeploy: false,
        rushHour: false,
      } as never;

      it('blocks Deploy when only one required scan type passed', () => {
        const deploy = createMockNode('deploy-1', NodeType.Deploy);
        const sast = createMockNode('sast-1', NodeType.SecurityScan, NodeStatus.Success);
        sast.config.scanType = 'sast';
        const pipeline = createMockPipeline([sast, deploy]);

        const result = service.checkPurposefulFailure(deploy, level, 6, pipeline);

        expect(result.shouldFail).toBeTrue();
        expect(result.reason).toContain('compliance');
        expect(result.dualScanMissingType).toBeTruthy();
      });

      it('allows Deploy once both scan types passed', () => {
        const deploy = createMockNode('deploy-1', NodeType.Deploy);
        const sast = createMockNode('sast-1', NodeType.SecurityScan, NodeStatus.Success);
        sast.config.scanType = 'sast';
        const sca = createMockNode('sca-1', NodeType.SecurityScan, NodeStatus.Success);
        sca.config.scanType = 'sca';
        const pipeline = createMockPipeline([sast, sca, deploy]);

        const result = service.checkPurposefulFailure(deploy, level, 6, pipeline);

        expect(result.shouldFail).toBeFalse();
      });
    });
  });

  describe('getRandomFailureReason', () => {
    it('should return a reason for Build nodes', () => {
      const reason = service.getRandomFailureReason(NodeType.Build);
      expect(reason).toBeTruthy();
      expect(typeof reason).toBe('string');
    });

    it('should return a reason for Test nodes', () => {
      const reason = service.getRandomFailureReason(NodeType.Test);
      expect(reason).toBeTruthy();
    });

    it('should return a reason for Deploy nodes', () => {
      const reason = service.getRandomFailureReason(NodeType.Deploy);
      expect(reason).toBeTruthy();
    });

    it('should return a reason for SecurityScan nodes (default scanType sast)', () => {
      const reason = service.getRandomFailureReason(NodeType.SecurityScan);
      expect(reason).toBeTruthy();
      // Should come from the SAST sub-array (semgrep/CodeQL)
      expect(reason).toMatch(/Semgrep|CodeQL|SAST/i);
    });

    it('should return fallback for unknown node types', () => {
      const reason = service.getRandomFailureReason(NodeType.Notification);
      expect(reason).toBe('Unknown error occurred');
    });
  });

  describe('P3: getRandomFailureReason with scanType', () => {
    const allScanTypes: ScanType[] = ['sast', 'sca', 'secret', 'container'];

    allScanTypes.forEach((scanType) => {
      it(`should return a non-empty reason for SecurityScan with scanType=${scanType}`, () => {
        const reason = service.getRandomFailureReason(NodeType.SecurityScan, scanType);
        expect(reason).toBeTruthy();
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThan(0);
      });
    });

    it('SAST failure reasons reference semgrep/CodeQL tools', () => {
      // Run multiple times to cover all 3 entries
      const reasons = new Set<string>();
      for (let i = 0; i < 50; i++) {
        reasons.add(service.getRandomFailureReason(NodeType.SecurityScan, 'sast'));
      }
      const combinedText = Array.from(reasons).join(' ');
      expect(combinedText).toMatch(/Semgrep|CodeQL|SAST/i);
    });

    it('SCA failure reasons reference snyk/npm audit tools', () => {
      const reasons = new Set<string>();
      for (let i = 0; i < 50; i++) {
        reasons.add(service.getRandomFailureReason(NodeType.SecurityScan, 'sca'));
      }
      const combinedText = Array.from(reasons).join(' ');
      expect(combinedText).toMatch(/snyk|npm audit|SCA|CVE|CVSS/i);
    });

    it('Secret failure reasons reference gitleaks/credential tools', () => {
      const reasons = new Set<string>();
      for (let i = 0; i < 50; i++) {
        reasons.add(service.getRandomFailureReason(NodeType.SecurityScan, 'secret'));
      }
      const combinedText = Array.from(reasons).join(' ');
      expect(combinedText).toMatch(/gitleaks|Secret|Credential|JWT|AWS/i);
    });

    it('Container failure reasons reference trivy/grype tools', () => {
      const reasons = new Set<string>();
      for (let i = 0; i < 50; i++) {
        reasons.add(service.getRandomFailureReason(NodeType.SecurityScan, 'container'));
      }
      const combinedText = Array.from(reasons).join(' ');
      expect(combinedText).toMatch(/trivy|grype|Container|CVE|base image/i);
    });

    it('different scanTypes return different failure reason domains', () => {
      // Pin Math.random to 0 so both calls hit index 0 of their respective arrays.
      // Wrapping in try/finally ensures the spy is restored even if the assertions throw,
      // preventing spy leakage into subsequent tests.
      const mockRandom = spyOn(Math, 'random').and.returnValue(0);
      let sastReason: string;
      let containerReason: string;
      try {
        sastReason = service.getRandomFailureReason(NodeType.SecurityScan, 'sast');
        containerReason = service.getRandomFailureReason(NodeType.SecurityScan, 'container');
      } finally {
        mockRandom.and.callThrough();
      }
      // They should reference different tools — sast index 0 is semgrep-based, container index 0 is trivy-based
      expect(sastReason!).not.toBe(containerReason!);
    });

    it('non-SecurityScan nodes are unaffected by scanType param', () => {
      const reasonWithScan = service.getRandomFailureReason(NodeType.Build, 'sast');
      const reasonWithoutScan = service.getRandomFailureReason(NodeType.Build);
      // Both should return a valid string from the FAILURE_REASONS[Build] array
      expect(reasonWithScan).toBeTruthy();
      expect(reasonWithoutScan).toBeTruthy();
    });
  });

  describe('areAllInputsComplete', () => {
    it('should return true when all inputs are successful', () => {
      const node = createMockNode('deploy-1', NodeType.Deploy, NodeStatus.Idle, {
        inputs: ['build-1', 'test-1'],
      });
      const pipeline = createMockPipeline([
        createMockNode('build-1', NodeType.Build, NodeStatus.Success),
        createMockNode('test-1', NodeType.Test, NodeStatus.Success),
        node,
      ]);

      expect(service.areAllInputsComplete(node, pipeline)).toBeTrue();
    });

    it('should return true when inputs are skipped', () => {
      const node = createMockNode('deploy-1', NodeType.Deploy, NodeStatus.Idle, {
        inputs: ['build-1'],
      });
      const pipeline = createMockPipeline([createMockNode('build-1', NodeType.Build, NodeStatus.Skipped), node]);

      expect(service.areAllInputsComplete(node, pipeline)).toBeTrue();
    });

    it('should return false when any input is still running', () => {
      const node = createMockNode('deploy-1', NodeType.Deploy, NodeStatus.Idle, {
        inputs: ['build-1', 'test-1'],
      });
      const pipeline = createMockPipeline([
        createMockNode('build-1', NodeType.Build, NodeStatus.Success),
        createMockNode('test-1', NodeType.Test, NodeStatus.Running),
        node,
      ]);

      expect(service.areAllInputsComplete(node, pipeline)).toBeFalse();
    });

    it('should return true for nodes with no inputs', () => {
      const node = createMockNode('source-1', NodeType.Source);
      const pipeline = createMockPipeline([node]);

      expect(service.areAllInputsComplete(node, pipeline)).toBeTrue();
    });
  });

  describe('isPipelineComplete', () => {
    it('should return true when all nodes are in terminal state', () => {
      const pipeline = createMockPipeline([
        createMockNode('node-1', NodeType.Build, NodeStatus.Success),
        createMockNode('node-2', NodeType.Test, NodeStatus.Failed),
        createMockNode('node-3', NodeType.Deploy, NodeStatus.Skipped),
      ]);

      expect(service.isPipelineComplete(pipeline)).toBeTrue();
    });

    it('should return false when any node is still running', () => {
      const pipeline = createMockPipeline([
        createMockNode('node-1', NodeType.Build, NodeStatus.Success),
        createMockNode('node-2', NodeType.Test, NodeStatus.Running),
      ]);

      expect(service.isPipelineComplete(pipeline)).toBeFalse();
    });

    it('should return false when any node is idle', () => {
      const pipeline = createMockPipeline([
        createMockNode('node-1', NodeType.Build, NodeStatus.Success),
        createMockNode('node-2', NodeType.Test, NodeStatus.Idle),
      ]);

      expect(service.isPipelineComplete(pipeline)).toBeFalse();
    });

    it('P2: should return true when all nodes are Success or RolledBack (RolledBack is terminal)', () => {
      // A rolled-back deploy means the run finished — the pipeline is complete
      // even though no new version shipped. The deploy objective is not satisfied,
      // but the pipeline evaluation should not stall waiting for more nodes.
      const pipeline = createMockPipeline([
        createMockNode('source-1', NodeType.Source, NodeStatus.Success),
        createMockNode('build-1', NodeType.Build, NodeStatus.Success),
        createMockNode('d1', NodeType.Deploy, NodeStatus.RolledBack),
      ]);

      expect(service.isPipelineComplete(pipeline)).toBeTrue();
    });

    it('P2: should return false when any node is still running after a sibling rolled back', () => {
      const pipeline = createMockPipeline([
        createMockNode('d1', NodeType.Deploy, NodeStatus.RolledBack),
        createMockNode('test-1', NodeType.Test, NodeStatus.Running),
      ]);

      expect(service.isPipelineComplete(pipeline)).toBeFalse();
    });
  });

  describe('hasPipelineFailures', () => {
    it('should return true when any node failed', () => {
      const pipeline = createMockPipeline([
        createMockNode('node-1', NodeType.Build, NodeStatus.Success),
        createMockNode('node-2', NodeType.Test, NodeStatus.Failed),
      ]);

      expect(service.hasPipelineFailures(pipeline)).toBeTrue();
    });

    it('should return true when any node cancelled', () => {
      const pipeline = createMockPipeline([
        createMockNode('node-1', NodeType.Build, NodeStatus.Success),
        createMockNode('node-2', NodeType.Test, NodeStatus.Cancelled),
      ]);

      expect(service.hasPipelineFailures(pipeline)).toBeTrue();
    });

    it('should return false when all nodes succeeded', () => {
      const pipeline = createMockPipeline([
        createMockNode('node-1', NodeType.Build, NodeStatus.Success),
        createMockNode('node-2', NodeType.Test, NodeStatus.Success),
      ]);

      expect(service.hasPipelineFailures(pipeline)).toBeFalse();
    });

    it('P2: should return false when only rolled-back deploys (RolledBack is NOT a hard failure)', () => {
      // A rolled-back deploy means the pipeline recovered — no incident counted.
      // The component's pipeline-complete handler will route to handlePartialPipelineRun()
      // specifically because hasPipelineFailures returns false with rolledBackCount > 0.
      const pipeline = createMockPipeline([
        createMockNode('source-1', NodeType.Source, NodeStatus.Success),
        createMockNode('d1', NodeType.Deploy, NodeStatus.RolledBack),
      ]);

      expect(service.hasPipelineFailures(pipeline)).toBeFalse();
    });

    it('P2: should return true when pipeline has both Failed and RolledBack nodes (real failure not masked)', () => {
      // RolledBack does NOT mask a co-existing hard failure. If another node truly
      // failed, hasPipelineFailures must still return true so the failure branch fires.
      const pipeline = createMockPipeline([
        createMockNode('build-1', NodeType.Build, NodeStatus.Failed),
        createMockNode('d1', NodeType.Deploy, NodeStatus.RolledBack),
      ]);

      expect(service.hasPipelineFailures(pipeline)).toBeTrue();
    });
  });

  describe('hasRequiredNodes', () => {
    it('should return true when all required node types succeeded', () => {
      const pipeline = createMockPipeline([
        createMockNode('source-1', NodeType.Source, NodeStatus.Success),
        createMockNode('build-1', NodeType.Build, NodeStatus.Success),
        createMockNode('deploy-1', NodeType.Deploy, NodeStatus.Success),
      ]);

      expect(service.hasRequiredNodes(pipeline, [NodeType.Source, NodeType.Build, NodeType.Deploy])).toBeTrue();
    });

    it('should return false when required node type is missing', () => {
      const pipeline = createMockPipeline([
        createMockNode('source-1', NodeType.Source, NodeStatus.Success),
        createMockNode('build-1', NodeType.Build, NodeStatus.Success),
      ]);

      expect(service.hasRequiredNodes(pipeline, [NodeType.Source, NodeType.Build, NodeType.Deploy])).toBeFalse();
    });

    it('should return false when required node exists but not succeeded', () => {
      const pipeline = createMockPipeline([
        createMockNode('source-1', NodeType.Source, NodeStatus.Success),
        createMockNode('deploy-1', NodeType.Deploy, NodeStatus.Failed),
      ]);

      expect(service.hasRequiredNodes(pipeline, [NodeType.Source, NodeType.Deploy])).toBeFalse();
    });

    it('should count a RolledBack required node as present (structure check, not objective)', () => {
      // P2: a rolled-back Deploy DID run — the pipeline is not "missing required nodes".
      // This is the topology check that lets checkPipelineComplete reach the honest
      // partial-run branch instead of the misleading "missing required nodes" failure.
      // (Without this, the entire rollback-honesty path is dead code in all 10 levels.)
      const pipeline = createMockPipeline([
        createMockNode('source-1', NodeType.Source, NodeStatus.Success),
        createMockNode('deploy-1', NodeType.Deploy, NodeStatus.RolledBack),
      ]);

      expect(service.hasRequiredNodes(pipeline, [NodeType.Source, NodeType.Deploy])).toBeTrue();
    });
  });

  describe('getDownstreamNodes', () => {
    it('should return nodes connected to outputs', () => {
      const sourceNode = createMockNode('source-1', NodeType.Source, NodeStatus.Success, {
        outputs: ['build-1', 'test-1'],
      });
      const buildNode = createMockNode('build-1', NodeType.Build);
      const testNode = createMockNode('test-1', NodeType.Test);
      const pipeline = createMockPipeline([sourceNode, buildNode, testNode]);

      const downstream = service.getDownstreamNodes(sourceNode, pipeline);

      expect(downstream.length).toBe(2);
      expect(downstream.map((n) => n.id)).toContain('build-1');
      expect(downstream.map((n) => n.id)).toContain('test-1');
    });

    it('should return empty array for nodes with no outputs', () => {
      const deployNode = createMockNode('deploy-1', NodeType.Deploy);
      const pipeline = createMockPipeline([deployNode]);

      const downstream = service.getDownstreamNodes(deployNode, pipeline);

      expect(downstream.length).toBe(0);
    });
  });

  describe('getUpstreamNodesOfType', () => {
    it('should find upstream Test nodes via direct inputs', () => {
      const test1 = createMockNode('t1', NodeType.Test, NodeStatus.Success, { outputs: ['qg1'] });
      const test2 = createMockNode('t2', NodeType.Test, NodeStatus.Failed, { outputs: ['qg1'] });
      const qg = createMockNode('qg1', NodeType.QualityGate, NodeStatus.Running, {
        inputs: ['t1', 't2'],
      });
      const pipeline = createMockPipeline([test1, test2, qg]);

      const upstream = service.getUpstreamNodesOfType(qg, pipeline, NodeType.Test);

      expect(upstream.length).toBe(2);
      expect(upstream.map((n) => n.id)).toContain('t1');
      expect(upstream.map((n) => n.id)).toContain('t2');
    });

    it('should traverse multiple levels to find upstream Test nodes', () => {
      const test1 = createMockNode('t1', NodeType.Test, NodeStatus.Success, { outputs: ['b1'] });
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Success, {
        inputs: ['t1'],
        outputs: ['qg1'],
      });
      const qg = createMockNode('qg1', NodeType.QualityGate, NodeStatus.Running, {
        inputs: ['b1'],
      });
      const pipeline = createMockPipeline([test1, build, qg]);

      const upstream = service.getUpstreamNodesOfType(qg, pipeline, NodeType.Test);

      expect(upstream.length).toBe(1);
      expect(upstream[0].id).toBe('t1');
    });

    it('should return empty array when no upstream nodes of type exist', () => {
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Success, { outputs: ['qg1'] });
      const qg = createMockNode('qg1', NodeType.QualityGate, NodeStatus.Running, {
        inputs: ['b1'],
      });
      const pipeline = createMockPipeline([build, qg]);

      const upstream = service.getUpstreamNodesOfType(qg, pipeline, NodeType.Test);

      expect(upstream.length).toBe(0);
    });

    it('should return empty array when node has no inputs', () => {
      const qg = createMockNode('qg1', NodeType.QualityGate, NodeStatus.Running);
      const pipeline = createMockPipeline([qg]);

      const upstream = service.getUpstreamNodesOfType(qg, pipeline, NodeType.Test);

      expect(upstream.length).toBe(0);
    });
  });

  describe('QualityGate purposeful failure', () => {
    const level = { securityAudit: false, fridayDeploy: false, rushHour: false } as never;

    it('should fail QualityGate when upstream test failed', () => {
      const test1 = createMockNode('t1', NodeType.Test, NodeStatus.Success, { outputs: ['qg1'] });
      const test2 = createMockNode('t2', NodeType.Test, NodeStatus.Failed, { outputs: ['qg1'] });
      const qg = createMockNode('qg1', NodeType.QualityGate, NodeStatus.Running, {
        inputs: ['t1', 't2'],
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          threshold: 1.0,
        },
      });
      const pipeline = createMockPipeline([test1, test2, qg]);

      const result = service.checkPurposefulFailure(qg, level, 1, pipeline);

      expect(result.shouldFail).toBeTrue();
      expect(result.reason).toContain('Quality gate failed');
      expect(result.reason).toContain('50%');
    });

    it('should pass QualityGate when all upstream tests succeed', () => {
      const test1 = createMockNode('t1', NodeType.Test, NodeStatus.Success, { outputs: ['qg1'] });
      const test2 = createMockNode('t2', NodeType.Test, NodeStatus.Success, { outputs: ['qg1'] });
      const qg = createMockNode('qg1', NodeType.QualityGate, NodeStatus.Running, {
        inputs: ['t1', 't2'],
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          threshold: 1.0,
        },
      });
      const pipeline = createMockPipeline([test1, test2, qg]);

      const result = service.checkPurposefulFailure(qg, level, 1, pipeline);

      expect(result.shouldFail).toBeFalse();
    });

    it('should not fail QualityGate with no upstream tests (no threshold check)', () => {
      const build = createMockNode('b1', NodeType.Build, NodeStatus.Success, { outputs: ['qg1'] });
      const qg = createMockNode('qg1', NodeType.QualityGate, NodeStatus.Running, {
        inputs: ['b1'],
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          threshold: 1.0,
        },
      });
      const pipeline = createMockPipeline([build, qg]);

      const result = service.checkPurposefulFailure(qg, level, 1, pipeline);

      expect(result.shouldFail).toBeFalse();
    });

    it('should respect custom threshold (50% pass rate)', () => {
      const test1 = createMockNode('t1', NodeType.Test, NodeStatus.Success, { outputs: ['qg1'] });
      const test2 = createMockNode('t2', NodeType.Test, NodeStatus.Failed, { outputs: ['qg1'] });
      const qg = createMockNode('qg1', NodeType.QualityGate, NodeStatus.Running, {
        inputs: ['t1', 't2'],
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          threshold: 0.5,
        },
      });
      const pipeline = createMockPipeline([test1, test2, qg]);

      const result = service.checkPurposefulFailure(qg, level, 1, pipeline);

      // 50% pass rate meets 50% threshold
      expect(result.shouldFail).toBeFalse();
    });

    it('should not check QualityGate on level 0 (tutorial)', () => {
      const test1 = createMockNode('t1', NodeType.Test, NodeStatus.Failed, { outputs: ['qg1'] });
      const qg = createMockNode('qg1', NodeType.QualityGate, NodeStatus.Running, {
        inputs: ['t1'],
        config: {
          cpuRequired: 10,
          memoryRequired: 100,
          timeEstimate: 1,
          failureRate: 0,
          flakiness: 0,
          threshold: 1.0,
        },
      });
      const pipeline = createMockPipeline([test1, qg]);

      const result = service.checkPurposefulFailure(qg, level, 0, pipeline);

      expect(result.shouldFail).toBeFalse();
    });
  });

  describe('isPipelineComplete with Retrying status', () => {
    it('should return false when any node is Retrying', () => {
      const pipeline = createMockPipeline([
        createMockNode('node-1', NodeType.Build, NodeStatus.Success),
        createMockNode('node-2', NodeType.Test, NodeStatus.Retrying),
      ]);

      expect(service.isPipelineComplete(pipeline)).toBeFalse();
    });
  });

  // ─── P4: checkSeverityGate ─────────────────────────────────────────────────

  describe('P4: checkSeverityGate', () => {
    const allScanTypes: ScanType[] = ['sast', 'sca', 'secret', 'container'];

    it('returns shouldFail=false when roll produces INFO severity', () => {
      // Force Math.random to return a value that falls into INFO bucket (>= 0.78)
      spyOn(Math, 'random').and.returnValue(0.99);
      const node = createMockNode('sec-1', NodeType.SecurityScan);
      node.config.scanType = 'sast';
      const result = service.checkSeverityGate(node);
      expect(result.shouldFail).toBeFalse();
      expect(result.isWarn).toBeFalsy();
    });

    it('returns shouldFail=true for CRITICAL severity (roll < 0.08)', () => {
      spyOn(Math, 'random').and.returnValue(0.01);
      const node = createMockNode('sec-1', NodeType.SecurityScan);
      node.config.scanType = 'sast';
      const result = service.checkSeverityGate(node);
      expect(result.shouldFail).toBeTrue();
      expect(result.severity).toBe('CRITICAL');
      expect(result.finding).toBeTruthy();
      expect(result.finding?.tool).toBeTruthy();
    });

    it('returns shouldFail=true for HIGH severity (0.08 <= roll < 0.23)', () => {
      spyOn(Math, 'random').and.returnValue(0.1);
      const node = createMockNode('sec-1', NodeType.SecurityScan);
      node.config.scanType = 'sca';
      const result = service.checkSeverityGate(node);
      expect(result.shouldFail).toBeTrue();
      expect(result.severity).toBe('HIGH');
    });

    it('returns isWarn=true for MEDIUM severity (0.23 <= roll < 0.48)', () => {
      spyOn(Math, 'random').and.returnValue(0.3);
      const node = createMockNode('sec-1', NodeType.SecurityScan);
      node.config.scanType = 'secret';
      const result = service.checkSeverityGate(node);
      expect(result.shouldFail).toBeFalse();
      expect(result.isWarn).toBeTrue();
      expect(result.severity).toBe('MEDIUM');
      expect(result.finding).toBeTruthy();
    });

    it('returns isWarn=true for LOW severity (0.48 <= roll < 0.78)', () => {
      spyOn(Math, 'random').and.returnValue(0.6);
      const node = createMockNode('sec-1', NodeType.SecurityScan);
      node.config.scanType = 'container';
      const result = service.checkSeverityGate(node);
      expect(result.shouldFail).toBeFalse();
      expect(result.isWarn).toBeTrue();
      expect(result.severity).toBe('LOW');
    });

    allScanTypes.forEach((scanType) => {
      it(`finding tool matches ${scanType} scan type tools`, () => {
        // Roll CRITICAL to get a finding object
        spyOn(Math, 'random').and.returnValue(0.01);
        const node = createMockNode('sec-1', NodeType.SecurityScan);
        node.config.scanType = scanType;
        const result = service.checkSeverityGate(node);
        expect(result.finding?.tool).toBeTruthy();
        // Verify the finding comes from the correct scan type table
        const tableTools = SCAN_SEVERITY_TABLES[scanType].map((f) => f.tool);
        expect(tableTools).toContain(result.finding!.tool);
      });
    });

    it('defaults to sast scan type when scanType is not configured', () => {
      spyOn(Math, 'random').and.returnValue(0.01);
      const node = createMockNode('sec-1', NodeType.SecurityScan);
      // Don't set scanType — should default to sast
      const result = service.checkSeverityGate(node);
      expect(result.shouldFail).toBeTrue();
      // sast CRITICAL finding uses semgrep
      expect(result.finding?.tool).toBe('semgrep');
    });
  });

  // ─── P4: checkCoverageGate ──────────────────────────────────────────────────

  describe('P4: checkCoverageGate', () => {
    it('stores producedCoverage on node.config after the call', () => {
      const node = createMockNode('test-1', NodeType.Test);
      node.config.coverageThreshold = 75;
      service.checkCoverageGate(node);
      expect(node.config.producedCoverage).toBeDefined();
      expect(node.config.producedCoverage).toBeGreaterThanOrEqual(0);
      expect(node.config.producedCoverage).toBeLessThanOrEqual(100);
    });

    it('returns shouldFail=true when producedCoverage is below the threshold', () => {
      spyOn(Math, 'random').and.returnValue(0);
      const node = createMockNode('test-1', NodeType.Test);
      node.config.coverageThreshold = 90;
      const result = service.checkCoverageGate(node);
      expect(result.shouldFail).toBeTrue();
      expect(result.produced).toBe(60);
      expect(result.threshold).toBe(90);
    });

    it('returns shouldFail=false when producedCoverage meets the threshold', () => {
      spyOn(Math, 'random').and.returnValue(0.99);
      const node = createMockNode('test-1', NodeType.Test);
      node.config.coverageThreshold = 75;
      const result = service.checkCoverageGate(node);
      expect(result.shouldFail).toBeFalse();
      expect(result.produced).toBe(100);
    });

    it('returns isNearThreshold=true when coverage is within 5% above threshold', () => {
      spyOn(Math, 'random').and.returnValue(0.34);
      const node = createMockNode('test-1', NodeType.Test);
      node.config.coverageThreshold = 75;
      const result = service.checkCoverageGate(node);
      expect(result.produced).toBe(75);
      expect(result.shouldFail).toBeFalse();
      expect(result.isNearThreshold).toBeTrue();
    });

    it('clamps produced coverage to the supported range', () => {
      spyOn(Math, 'random').and.returnValue(0.99);
      const node = createMockNode('test-1', NodeType.Test);
      node.config.coverageThreshold = 50;
      const result = service.checkCoverageGate(node);
      expect(result.produced).toBe(100);
    });

    it('defaults coverageThreshold to 75 when not configured', () => {
      spyOn(Math, 'random').and.returnValue(0.99);
      const node = createMockNode('test-1', NodeType.Test);
      const result = service.checkCoverageGate(node);
      expect(result.threshold).toBe(75);
    });

    it('makes higher thresholds monotonically harder to clear', () => {
      const passRate = (threshold: CoverageThreshold): number => {
        const node = createMockNode('t', NodeType.Test);
        node.config.coverageThreshold = threshold;
        let passes = 0;
        const attempts = 5000;
        for (let i = 0; i < attempts; i++) {
          if (!service.checkCoverageGate(node).shouldFail) passes++;
        }
        return passes / attempts;
      };

      const rate50 = passRate(50);
      const rate75 = passRate(75);
      const rate90 = passRate(90);
      const rate100 = passRate(100);

      expect(rate50).toBeGreaterThan(rate75);
      expect(rate75).toBeGreaterThan(rate90);
      expect(rate90).toBeGreaterThan(rate100);
      expect(rate50).toBeGreaterThan(0.98);
      expect(rate75).toBeGreaterThan(0.6);
      expect(rate75).toBeLessThan(0.73);
      expect(rate90).toBeGreaterThan(0.27);
      expect(rate90).toBeLessThan(0.4);
      expect(rate100).toBeGreaterThan(0.06);
      expect(rate100).toBeLessThan(0.17);
    });
  });

  // ─── P4: checkDualScanTypes ─────────────────────────────────────────────────

  describe('P4: checkDualScanTypes', () => {
    const level = { securityAudit: true, requireDualScanTypes: true } as never;

    it('returns satisfied=true when both sast and sca scans passed', () => {
      const pipeline = createMockPipeline([
        createMockNode('sec-sast', NodeType.SecurityScan, NodeStatus.Success, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sast',
          },
        }),
        createMockNode('sec-sca', NodeType.SecurityScan, NodeStatus.Success, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sca',
          },
        }),
      ]);
      const result = service.checkDualScanTypes(pipeline, level);
      expect(result.satisfied).toBeTrue();
    });

    it('returns satisfied=false with missingType=sca when only sast passed', () => {
      const pipeline = createMockPipeline([
        createMockNode('sec-sast', NodeType.SecurityScan, NodeStatus.Success, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sast',
          },
        }),
        createMockNode('sec-sca', NodeType.SecurityScan, NodeStatus.Failed, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sca',
          },
        }),
      ]);
      const result = service.checkDualScanTypes(pipeline, level);
      expect(result.satisfied).toBeFalse();
      expect(result.missingType).toBe('sca');
    });

    it('returns satisfied=false with missingType=sast when only sca passed', () => {
      const pipeline = createMockPipeline([
        createMockNode('sec-sast', NodeType.SecurityScan, NodeStatus.Failed, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sast',
          },
        }),
        createMockNode('sec-sca', NodeType.SecurityScan, NodeStatus.Success, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sca',
          },
        }),
      ]);
      const result = service.checkDualScanTypes(pipeline, level);
      expect(result.satisfied).toBeFalse();
      expect(result.missingType).toBe('sast');
    });

    it('returns satisfied=false when both scans are the same type (two sast)', () => {
      const pipeline = createMockPipeline([
        createMockNode('sec-1', NodeType.SecurityScan, NodeStatus.Success, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sast',
          },
        }),
        createMockNode('sec-2', NodeType.SecurityScan, NodeStatus.Success, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sast',
          },
        }),
      ]);
      const result = service.checkDualScanTypes(pipeline, level);
      // Both are sast — sca is missing
      expect(result.satisfied).toBeFalse();
      expect(result.missingType).toBe('sca');
    });

    it('returns satisfied=false when no scans passed at all', () => {
      const pipeline = createMockPipeline([createMockNode('deploy-1', NodeType.Deploy, NodeStatus.Running)]);
      const result = service.checkDualScanTypes(pipeline, level);
      expect(result.satisfied).toBeFalse();
    });

    it('DUAL_SCAN_TYPES constant is [sast, sca]', () => {
      // Verify the constant itself — this is the spec plan requirement that
      // DUAL_SCAN_TYPES is ['sast','sca']. Spec asserting the constant covers
      // the "NO MASKED MOCKS" rule: real checkDualScanTypes uses this constant,
      // so mock returns of {satisfied:true} are only valid when these types passed.
      expect(DUAL_SCAN_TYPES[0]).toBe('sast');
      expect(DUAL_SCAN_TYPES[1]).toBe('sca');
    });
  });

  // ─── P4: Level 7 dual-scan check in checkPurposefulFailure ─────────────────

  describe('P4: checkPurposefulFailure — dual-scan gate for Level 7 Deploy', () => {
    it('fails a Deploy on Level 7 when only sast scan passed (sca missing)', () => {
      const level = {
        securityAudit: true,
        requireDualScanTypes: true,
        fridayDeploy: false,
        rushHour: false,
      } as never;
      const deployNode = createMockNode('deploy-1', NodeType.Deploy);
      const pipeline = createMockPipeline([
        createMockNode('sec-sast', NodeType.SecurityScan, NodeStatus.Success, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sast',
          },
        }),
        deployNode,
      ]);

      const result = service.checkPurposefulFailure(deployNode, level, 6, pipeline);

      expect(result.shouldFail).toBeTrue();
      expect(result.reason).toContain('sca');
    });

    it('passes a Deploy on Level 7 when both sast AND sca scans passed', () => {
      const level = {
        securityAudit: true,
        requireDualScanTypes: true,
        fridayDeploy: false,
        rushHour: false,
      } as never;
      const deployNode = createMockNode('deploy-1', NodeType.Deploy);
      const pipeline = createMockPipeline([
        createMockNode('sec-sast', NodeType.SecurityScan, NodeStatus.Success, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sast',
          },
        }),
        createMockNode('sec-sca', NodeType.SecurityScan, NodeStatus.Success, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sca',
          },
        }),
        deployNode,
      ]);

      const result = service.checkPurposefulFailure(deployNode, level, 6, pipeline);

      expect(result.shouldFail).toBeFalse();
    });

    it('does NOT apply dual-scan check on levels without requireDualScanTypes', () => {
      const level = {
        securityAudit: true,
        requireDualScanTypes: false,
        fridayDeploy: false,
        rushHour: false,
      } as never;
      const deployNode = createMockNode('deploy-1', NodeType.Deploy);
      // Only sast — but requireDualScanTypes is false so gate should not fire
      const pipeline = createMockPipeline([
        createMockNode('sec-sast', NodeType.SecurityScan, NodeStatus.Success, {
          config: {
            cpuRequired: 10,
            memoryRequired: 100,
            timeEstimate: 6,
            failureRate: 0,
            flakiness: 0,
            scanType: 'sast',
          },
        }),
        deployNode,
      ]);

      const result = service.checkPurposefulFailure(deployNode, level, 1, pipeline);

      // Gate does not fire — only securityAudit check (which passes since a scan DID pass)
      expect(result.shouldFail).toBeFalse();
    });
  });
});
