import { ResourceManagerService } from './resource-manager.service';
import { Level } from '../models/game-state.model';
import { NodeType, PipelineNode } from '../models/pipeline.model';
import { createMockNode, createMockPipeline } from '../testing/test-utils';

describe('ResourceManagerService', () => {
  let service: ResourceManagerService;

  // Helper to create a minimal level for testing
  const createLevel = (overrides: Partial<Level> = {}): Level =>
    ({
      id: 'test-level',
      name: 'Test Level',
      cpuLimit: 100,
      memoryLimit: 1000,
      parTime: 60,
      ...overrides,
    }) as Level;

  // Helper to create a node with specific resource requirements
  const createNodeWithResources = (
    id: string,
    type: NodeType,
    cpuRequired: number,
    memoryRequired: number
  ): PipelineNode => {
    const node = createMockNode(id, type);
    node.config = {
      ...node.config,
      cpuRequired,
      memoryRequired,
    };
    return node;
  };

  beforeEach(() => {
    service = new ResourceManagerService();
  });

  describe('initial state', () => {
    it('should have default CPU resources', () => {
      const cpu = service.getCpu();
      expect(cpu.total).toBe(100);
      expect(cpu.used).toBe(0);
      expect(cpu.available).toBe(100);
      expect(cpu.cost).toBe(1);
    });

    it('should have default memory resources', () => {
      const memory = service.getMemory();
      expect(memory.total).toBe(1000);
      expect(memory.used).toBe(0);
      expect(memory.available).toBe(1000);
      expect(memory.cost).toBe(0.5);
    });

    it('should have default build agents', () => {
      const agents = service.getBuildAgents();
      expect(agents.total).toBe(5);
      expect(agents.used).toBe(0);
      expect(agents.available).toBe(5);
      expect(agents.cost).toBe(10);
    });
  });

  describe('resetResources', () => {
    it('should reset CPU to level limits', () => {
      const level = createLevel({ cpuLimit: 200 });

      service.resetResources(level);
      const cpu = service.getCpu();

      expect(cpu.total).toBe(200);
      expect(cpu.used).toBe(0);
      expect(cpu.available).toBe(200);
    });

    it('should reset memory to level limits', () => {
      const level = createLevel({ memoryLimit: 2000 });

      service.resetResources(level);
      const memory = service.getMemory();

      expect(memory.total).toBe(2000);
      expect(memory.used).toBe(0);
      expect(memory.available).toBe(2000);
    });

    it('should reset build agents to defaults', () => {
      // First use some agents
      service.allocateBuildAgent();
      service.allocateBuildAgent();

      const level = createLevel();
      service.resetResources(level);
      const agents = service.getBuildAgents();

      expect(agents.total).toBe(5);
      expect(agents.used).toBe(0);
      expect(agents.available).toBe(5);
    });

    it('should apply the literal one-agent prototype condition', () => {
      const level = createLevel({
        prototypeRules: {
          deterministic: true,
          agentPoolLimit: 1,
        },
      });

      service.resetResources(level);

      expect(service.getBuildAgents()).toEqual(jasmine.objectContaining({ total: 1, used: 0, available: 1 }));
      expect(service.allocateBuildAgent()).toBeTrue();
      expect(service.allocateBuildAgent()).toBeFalse();
      service.freeBuildAgent();
      expect(service.getBuildAgents()).toEqual(jasmine.objectContaining({ total: 1, used: 0, available: 1 }));
    });

    it('should clear previously used resources', () => {
      // Allocate some resources first
      const node = createNodeWithResources('build-1', NodeType.Build, 30, 300);
      service.allocateNodeResources(node);

      // Reset should clear everything
      const level = createLevel({ cpuLimit: 100, memoryLimit: 1000 });
      service.resetResources(level);

      expect(service.getCpu().used).toBe(0);
      expect(service.getMemory().used).toBe(0);
    });
  });

  describe('canAddNode', () => {
    it('should return true when resources are available', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 10, 100);

      expect(service.canAddNode(node)).toBeTrue();
    });

    it('should return false when CPU is insufficient', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 150, 100);

      expect(service.canAddNode(node)).toBeFalse();
    });

    it('should return false when memory is insufficient', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 10, 1500);

      expect(service.canAddNode(node)).toBeFalse();
    });

    it('should return false when both CPU and memory are insufficient', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 150, 1500);

      expect(service.canAddNode(node)).toBeFalse();
    });

    it('should return false when node has no config', () => {
      const node = { id: 'test', type: NodeType.Build } as Partial<PipelineNode>;

      expect(service.canAddNode(node)).toBeFalse();
    });

    it('should account for already used resources', () => {
      // Use up most CPU
      const firstNode = createNodeWithResources('build-1', NodeType.Build, 90, 100);
      service.allocateNodeResources(firstNode);

      // This node needs more CPU than available
      const secondNode = createNodeWithResources('build-2', NodeType.Build, 20, 100);

      expect(service.canAddNode(secondNode)).toBeFalse();
    });

    it('should allow node that exactly uses remaining resources', () => {
      const firstNode = createNodeWithResources('build-1', NodeType.Build, 80, 800);
      service.allocateNodeResources(firstNode);

      const secondNode = createNodeWithResources('build-2', NodeType.Build, 20, 200);

      expect(service.canAddNode(secondNode)).toBeTrue();
    });
  });

  describe('allocateNodeResources', () => {
    it('should increase used CPU', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 25, 100);

      service.allocateNodeResources(node);

      expect(service.getCpu().used).toBe(25);
      expect(service.getCpu().available).toBe(75);
    });

    it('should increase used memory', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 10, 300);

      service.allocateNodeResources(node);

      expect(service.getMemory().used).toBe(300);
      expect(service.getMemory().available).toBe(700);
    });

    it('should accumulate resources from multiple nodes', () => {
      const node1 = createNodeWithResources('build-1', NodeType.Build, 20, 200);
      const node2 = createNodeWithResources('build-2', NodeType.Build, 30, 300);

      service.allocateNodeResources(node1);
      service.allocateNodeResources(node2);

      expect(service.getCpu().used).toBe(50);
      expect(service.getMemory().used).toBe(500);
    });

    it('should allow over-allocation (no guard)', () => {
      // This tests the actual behavior - the service allows over-allocation
      // Validation should happen via canAddNode before allocation
      const node = createNodeWithResources('build-1', NodeType.Build, 150, 100);

      service.allocateNodeResources(node);

      expect(service.getCpu().used).toBe(150);
      expect(service.getCpu().available).toBe(-50); // Negative available
    });
  });

  describe('freeNodeResources', () => {
    it('should decrease used CPU', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 30, 100);
      service.allocateNodeResources(node);

      service.freeNodeResources(node);

      expect(service.getCpu().used).toBe(0);
      expect(service.getCpu().available).toBe(100);
    });

    it('should decrease used memory', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 10, 400);
      service.allocateNodeResources(node);

      service.freeNodeResources(node);

      expect(service.getMemory().used).toBe(0);
      expect(service.getMemory().available).toBe(1000);
    });

    it('should not go below zero (clamp to 0)', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 30, 300);

      // Free without allocating first
      service.freeNodeResources(node);

      expect(service.getCpu().used).toBe(0);
      expect(service.getMemory().used).toBe(0);
    });

    it('should correctly free partial resources', () => {
      const node1 = createNodeWithResources('build-1', NodeType.Build, 40, 400);
      const node2 = createNodeWithResources('build-2', NodeType.Build, 30, 300);

      service.allocateNodeResources(node1);
      service.allocateNodeResources(node2);
      service.freeNodeResources(node1);

      expect(service.getCpu().used).toBe(30);
      expect(service.getMemory().used).toBe(300);
    });
  });

  describe('validateResources', () => {
    it('should return valid for empty pipeline', () => {
      const pipeline = createMockPipeline([]);

      const result = service.validateResources(pipeline);

      expect(result.valid).toBeTrue();
      expect(result.message).toBeUndefined();
    });

    it('should return valid when within limits', () => {
      const nodes = [
        createNodeWithResources('build-1', NodeType.Build, 30, 300),
        createNodeWithResources('test-1', NodeType.Test, 20, 200),
      ];
      const pipeline = createMockPipeline(nodes);

      const result = service.validateResources(pipeline);

      expect(result.valid).toBeTrue();
    });

    it('should return invalid when CPU exceeded', () => {
      const nodes = [
        createNodeWithResources('build-1', NodeType.Build, 60, 100),
        createNodeWithResources('build-2', NodeType.Build, 60, 100),
      ];
      const pipeline = createMockPipeline(nodes);

      const result = service.validateResources(pipeline);

      expect(result.valid).toBeFalse();
      expect(result.message).toContain('CPU limit exceeded');
      expect(result.message).toContain('120/100');
    });

    it('should return invalid when memory exceeded', () => {
      const nodes = [
        createNodeWithResources('build-1', NodeType.Build, 10, 600),
        createNodeWithResources('build-2', NodeType.Build, 10, 600),
      ];
      const pipeline = createMockPipeline(nodes);

      const result = service.validateResources(pipeline);

      expect(result.valid).toBeFalse();
      expect(result.message).toContain('Memory limit exceeded');
      expect(result.message).toContain('1200/1000');
    });

    it('should report CPU error first when both exceeded', () => {
      const nodes = [createNodeWithResources('build-1', NodeType.Build, 150, 1500)];
      const pipeline = createMockPipeline(nodes);

      const result = service.validateResources(pipeline);

      expect(result.valid).toBeFalse();
      expect(result.message).toContain('CPU');
    });

    it('should validate against current totals (respects level limits)', () => {
      // Reset with smaller limits
      service.resetResources(createLevel({ cpuLimit: 50, memoryLimit: 500 }));

      const nodes = [
        createNodeWithResources('build-1', NodeType.Build, 30, 300),
        createNodeWithResources('build-2', NodeType.Build, 30, 300),
      ];
      const pipeline = createMockPipeline(nodes);

      const result = service.validateResources(pipeline);

      expect(result.valid).toBeFalse();
      expect(result.message).toContain('60/50'); // CPU exceeds 50
    });
  });

  describe('getTotalCost', () => {
    it('should return 0 when nothing is used', () => {
      expect(service.getTotalCost()).toBe(0);
    });

    it('should calculate CPU cost correctly', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 20, 0);
      service.allocateNodeResources(node);

      // CPU cost is 1 per unit, so 20 * 1 = 20
      expect(service.getTotalCost()).toBe(20);
    });

    it('should calculate memory cost correctly', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 0, 200);
      service.allocateNodeResources(node);

      // Memory cost is 0.5 per unit, so 200 * 0.5 = 100
      expect(service.getTotalCost()).toBe(100);
    });

    it('should include build agent cost', () => {
      service.allocateBuildAgent();

      // Build agent cost is 10 per unit
      expect(service.getTotalCost()).toBe(10);
    });

    it('should sum all resource costs', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 30, 400);
      service.allocateNodeResources(node);
      service.allocateBuildAgent();
      service.allocateBuildAgent();

      // CPU: 30 * 1 = 30
      // Memory: 400 * 0.5 = 200
      // Agents: 2 * 10 = 20
      // Total: 250
      expect(service.getTotalCost()).toBe(250);
    });

    it('should update when resources are freed', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 50, 500);
      service.allocateNodeResources(node);
      const costBefore = service.getTotalCost();

      service.freeNodeResources(node);

      expect(service.getTotalCost()).toBe(0);
      expect(costBefore).toBeGreaterThan(0);
    });
  });

  describe('getResourceEfficiency', () => {
    it('should return 100% when nothing is used', () => {
      expect(service.getResourceEfficiency()).toBe(100);
    });

    it('should return 50% when half resources used', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 50, 500);
      service.allocateNodeResources(node);

      // CPU: (100-50)/100 = 0.5
      // Memory: (1000-500)/1000 = 0.5
      // Average: 0.5 * 100 = 50%
      expect(service.getResourceEfficiency()).toBe(50);
    });

    it('should return 0% when all resources used', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 100, 1000);
      service.allocateNodeResources(node);

      expect(service.getResourceEfficiency()).toBe(0);
    });

    it('should handle asymmetric resource usage', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 80, 200);
      service.allocateNodeResources(node);

      // CPU: (100-80)/100 = 0.2
      // Memory: (1000-200)/1000 = 0.8
      // Average: (0.2 + 0.8) / 2 = 0.5 * 100 = 50%
      expect(service.getResourceEfficiency()).toBe(50);
    });

    it('should handle zero total resources gracefully', () => {
      // Reset with zero limits
      service.resetResources(createLevel({ cpuLimit: 0, memoryLimit: 0 }));

      // Should not throw and should return 0
      expect(service.getResourceEfficiency()).toBe(0);
    });
  });

  describe('update', () => {
    it('should recalculate available resources', () => {
      // Manually manipulate internal state would require accessing private members
      // Instead, test that update maintains consistency after operations
      const node = createNodeWithResources('build-1', NodeType.Build, 40, 400);
      service.allocateNodeResources(node);

      service.update();

      expect(service.getCpu().available).toBe(60);
      expect(service.getMemory().available).toBe(600);
    });
  });

  describe('allocateBuildAgent', () => {
    it('should allocate agent when available', () => {
      const result = service.allocateBuildAgent();

      expect(result).toBeTrue();
      expect(service.getBuildAgents().used).toBe(1);
      expect(service.getBuildAgents().available).toBe(4);
    });

    it('should allocate multiple agents', () => {
      service.allocateBuildAgent();
      service.allocateBuildAgent();
      service.allocateBuildAgent();

      expect(service.getBuildAgents().used).toBe(3);
      expect(service.getBuildAgents().available).toBe(2);
    });

    it('should return false when no agents available', () => {
      // Allocate all 5 agents
      for (let i = 0; i < 5; i++) {
        service.allocateBuildAgent();
      }

      const result = service.allocateBuildAgent();

      expect(result).toBeFalse();
      expect(service.getBuildAgents().used).toBe(5);
      expect(service.getBuildAgents().available).toBe(0);
    });
  });

  describe('freeBuildAgent', () => {
    it('should free an allocated agent', () => {
      service.allocateBuildAgent();
      service.allocateBuildAgent();

      service.freeBuildAgent();

      expect(service.getBuildAgents().used).toBe(1);
      expect(service.getBuildAgents().available).toBe(4);
    });

    it('should not go below zero', () => {
      service.freeBuildAgent(); // Free without allocating

      expect(service.getBuildAgents().used).toBe(0);
      expect(service.getBuildAgents().available).toBe(5);
    });

    it('should allow freeing all allocated agents', () => {
      service.allocateBuildAgent();
      service.allocateBuildAgent();
      service.allocateBuildAgent();

      service.freeBuildAgent();
      service.freeBuildAgent();
      service.freeBuildAgent();

      expect(service.getBuildAgents().used).toBe(0);
      expect(service.getBuildAgents().available).toBe(5);
    });
  });

  describe('getter immutability', () => {
    it('getCpu should return a copy, not the internal reference', () => {
      const cpu1 = service.getCpu();
      cpu1.used = 999;

      const cpu2 = service.getCpu();
      expect(cpu2.used).toBe(0); // Should not be affected
    });

    it('getMemory should return a copy, not the internal reference', () => {
      const memory1 = service.getMemory();
      memory1.used = 999;

      const memory2 = service.getMemory();
      expect(memory2.used).toBe(0); // Should not be affected
    });

    it('getBuildAgents should return a copy, not the internal reference', () => {
      const agents1 = service.getBuildAgents();
      agents1.used = 999;

      const agents2 = service.getBuildAgents();
      expect(agents2.used).toBe(0); // Should not be affected
    });
  });

  describe('integration scenarios', () => {
    it('should handle typical level workflow', () => {
      // Start level
      service.resetResources(createLevel({ cpuLimit: 100, memoryLimit: 1000 }));

      // Add nodes
      const source = createNodeWithResources('source-1', NodeType.Source, 5, 50);
      const build = createNodeWithResources('build-1', NodeType.Build, 20, 200);
      const deploy = createNodeWithResources('deploy-1', NodeType.Deploy, 15, 150);

      expect(service.canAddNode(source)).toBeTrue();
      service.allocateNodeResources(source);

      expect(service.canAddNode(build)).toBeTrue();
      service.allocateNodeResources(build);

      expect(service.canAddNode(deploy)).toBeTrue();
      service.allocateNodeResources(deploy);

      // Verify totals
      expect(service.getCpu().used).toBe(40);
      expect(service.getMemory().used).toBe(400);

      // Calculate cost
      // CPU: 40 * 1 = 40
      // Memory: 400 * 0.5 = 200
      // Total: 240
      expect(service.getTotalCost()).toBe(240);

      // Validate pipeline
      const pipeline = createMockPipeline([source, build, deploy]);
      expect(service.validateResources(pipeline).valid).toBeTrue();
    });

    it('should handle node removal and re-addition', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 30, 300);

      service.allocateNodeResources(node);
      expect(service.getCpu().used).toBe(30);

      service.freeNodeResources(node);
      expect(service.getCpu().used).toBe(0);

      service.allocateNodeResources(node);
      expect(service.getCpu().used).toBe(30);
    });

    it('should work correctly across level resets', () => {
      // Level 1 with small limits
      service.resetResources(createLevel({ cpuLimit: 50, memoryLimit: 500 }));
      const node1 = createNodeWithResources('build-1', NodeType.Build, 40, 400);
      service.allocateNodeResources(node1);

      expect(service.getCpu().total).toBe(50);
      expect(service.getCpu().used).toBe(40);

      // Level 2 with larger limits
      service.resetResources(createLevel({ cpuLimit: 200, memoryLimit: 2000 }));

      expect(service.getCpu().total).toBe(200);
      expect(service.getCpu().used).toBe(0);
      expect(service.getCpu().available).toBe(200);
    });
  });

  describe('reconcile', () => {
    it('should detect and correct CPU drift', () => {
      // Allocate a node, then simulate drift by manually calling allocate again
      const node = createNodeWithResources('build-1', NodeType.Build, 20, 200);
      service.allocateNodeResources(node);
      // Simulate extra allocation that drifted (e.g., double-add bug)
      service.allocateNodeResources(node);

      // CPU should be 40 used but nodes say 20
      expect(service.getCpu().used).toBe(40);

      const drift = service.reconcile([node]);

      expect(drift.cpuDrift).toBe(20); // was 40, expected 20
      expect(service.getCpu().used).toBe(20);
      expect(service.getCpu().available).toBe(80);
    });

    it('should detect and correct Memory drift', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 10, 300);
      service.allocateNodeResources(node);
      service.allocateNodeResources(node); // double allocation drift

      expect(service.getMemory().used).toBe(600);

      const drift = service.reconcile([node]);

      expect(drift.memoryDrift).toBe(300);
      expect(service.getMemory().used).toBe(300);
      expect(service.getMemory().available).toBe(700);
    });

    it('should return zero drift when resources are correct', () => {
      const node1 = createNodeWithResources('build-1', NodeType.Build, 20, 200);
      const node2 = createNodeWithResources('test-1', NodeType.Test, 15, 150);
      service.allocateNodeResources(node1);
      service.allocateNodeResources(node2);

      const drift = service.reconcile([node1, node2]);

      expect(drift.cpuDrift).toBe(0);
      expect(drift.memoryDrift).toBe(0);
      expect(service.getCpu().used).toBe(35);
      expect(service.getMemory().used).toBe(350);
    });
  });

  describe('getResourceWarnings', () => {
    it('should return empty array when usage is low', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 10, 100);
      service.allocateNodeResources(node);

      const warnings = service.getResourceWarnings();

      expect(warnings.length).toBe(0);
    });

    it('should return warning at 80%+ CPU usage', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 85, 100);
      service.allocateNodeResources(node);

      const warnings = service.getResourceWarnings();

      expect(warnings.some((w) => w.includes('CPU at 85%'))).toBeTrue();
    });

    it('should return warning at 80%+ memory usage', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 10, 850);
      service.allocateNodeResources(node);

      const warnings = service.getResourceWarnings();

      expect(warnings.some((w) => w.includes('Memory at 85%'))).toBeTrue();
    });

    it('should return critical warning at 95%+ CPU usage', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 96, 100);
      service.allocateNodeResources(node);

      const warnings = service.getResourceWarnings();

      expect(warnings.some((w) => w.includes('CPU at 96%') && w.includes('near limit'))).toBeTrue();
    });

    it('should return critical warning at 95%+ memory usage', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 10, 960);
      service.allocateNodeResources(node);

      const warnings = service.getResourceWarnings();

      expect(warnings.some((w) => w.includes('Memory at 96%') && w.includes('near limit'))).toBeTrue();
    });

    it('should handle zero total resources without errors', () => {
      service.resetResources(createLevel({ cpuLimit: 0, memoryLimit: 0 }));

      const warnings = service.getResourceWarnings();

      expect(warnings.length).toBe(0);
    });
  });

  describe('getForecast', () => {
    it('should show over-budget when node would exceed CPU', () => {
      const existingNode = createNodeWithResources('build-1', NodeType.Build, 80, 200);
      service.allocateNodeResources(existingNode);

      const newNode = createNodeWithResources('build-2', NodeType.Build, 30, 100);
      const forecast = service.getForecast(newNode);

      expect(forecast.cpuAfter).toBe(110);
      expect(forecast.cpuOverBudget).toBeTrue();
      expect(forecast.memoryAfter).toBe(300);
      expect(forecast.memoryOverBudget).toBeFalse();
    });

    it('should show over-budget when node would exceed memory', () => {
      const existingNode = createNodeWithResources('build-1', NodeType.Build, 10, 900);
      service.allocateNodeResources(existingNode);

      const newNode = createNodeWithResources('build-2', NodeType.Build, 10, 200);
      const forecast = service.getForecast(newNode);

      expect(forecast.memoryAfter).toBe(1100);
      expect(forecast.memoryOverBudget).toBeTrue();
      expect(forecast.cpuAfter).toBe(20);
      expect(forecast.cpuOverBudget).toBeFalse();
    });

    it('should show within-budget when node fits', () => {
      const newNode = createNodeWithResources('build-1', NodeType.Build, 20, 200);
      const forecast = service.getForecast(newNode);

      expect(forecast.cpuAfter).toBe(20);
      expect(forecast.memoryAfter).toBe(200);
      expect(forecast.cpuOverBudget).toBeFalse();
      expect(forecast.memoryOverBudget).toBeFalse();
    });
  });

  describe('canAddNode → allocate → free round trip', () => {
    it('should maintain consistency through full lifecycle', () => {
      const node = createNodeWithResources('build-1', NodeType.Build, 30, 300);

      // Check availability
      expect(service.canAddNode(node)).toBeTrue();

      // Allocate
      service.allocateNodeResources(node);
      expect(service.getCpu().used).toBe(30);
      expect(service.getCpu().available).toBe(70);
      expect(service.getMemory().used).toBe(300);
      expect(service.getMemory().available).toBe(700);

      // Free
      service.freeNodeResources(node);
      expect(service.getCpu().used).toBe(0);
      expect(service.getCpu().available).toBe(100);
      expect(service.getMemory().used).toBe(0);
      expect(service.getMemory().available).toBe(1000);
    });
  });

  describe('validateResources detects over-allocation', () => {
    it('should detect over-allocation via validateResources', () => {
      const nodes = [
        createNodeWithResources('build-1', NodeType.Build, 60, 600),
        createNodeWithResources('build-2', NodeType.Build, 60, 600),
      ];
      const pipeline = createMockPipeline(nodes);

      const result = service.validateResources(pipeline);

      expect(result.valid).toBeFalse();
      expect(result.message).toBeDefined();
    });
  });
});
