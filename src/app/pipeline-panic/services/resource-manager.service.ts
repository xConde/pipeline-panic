import { Injectable } from '@angular/core';
import { Pipeline, PipelineNode } from '../models/pipeline.model';
import { Level, Resource } from '../models/game-state.model';
import { GAME_CONSTANTS } from '../game-constants';

@Injectable()
export class ResourceManagerService {
  private cpu: Resource = {
    total: 100,
    used: 0,
    available: 100,
    cost: 1,
  };

  private memory: Resource = {
    total: 1000,
    used: 0,
    available: 1000,
    cost: 0.5,
  };

  private buildAgents: Resource = {
    total: GAME_CONSTANTS.DEFAULT_BUILD_AGENTS,
    used: 0,
    available: GAME_CONSTANTS.DEFAULT_BUILD_AGENTS,
    cost: 10,
  };

  constructor() {}

  resetResources(level: Level): void {
    this.cpu = {
      total: level.cpuLimit,
      used: 0,
      available: level.cpuLimit,
      cost: 1,
    };

    this.memory = {
      total: level.memoryLimit,
      used: 0,
      available: level.memoryLimit,
      cost: 0.5,
    };

    this.resetBuildAgents(level.prototypeRules?.agentPoolLimit ?? GAME_CONSTANTS.DEFAULT_BUILD_AGENTS);
  }

  resetBuildAgents(total: number): void {
    this.buildAgents = { total, used: 0, available: total, cost: 10 };
  }

  getCpu(): Resource {
    return { ...this.cpu };
  }

  getMemory(): Resource {
    return { ...this.memory };
  }

  getBuildAgents(): Resource {
    return { ...this.buildAgents };
  }

  canAddNode(node: Partial<PipelineNode>): boolean {
    if (!node.config) return false;

    const cpuAvailable = this.cpu.available >= node.config.cpuRequired;
    const memoryAvailable = this.memory.available >= node.config.memoryRequired;

    return cpuAvailable && memoryAvailable;
  }

  allocateNodeResources(node: PipelineNode): void {
    this.cpu.used += node.config.cpuRequired;
    this.cpu.available = this.cpu.total - this.cpu.used;

    this.memory.used += node.config.memoryRequired;
    this.memory.available = this.memory.total - this.memory.used;
  }

  freeNodeResources(node: PipelineNode): void {
    this.cpu.used = Math.max(0, this.cpu.used - node.config.cpuRequired);
    this.cpu.available = this.cpu.total - this.cpu.used;

    this.memory.used = Math.max(0, this.memory.used - node.config.memoryRequired);
    this.memory.available = this.memory.total - this.memory.used;
  }

  validateResources(pipeline: Pipeline): { valid: boolean; message?: string } {
    let totalCpu = 0;
    let totalMemory = 0;

    for (const node of pipeline.nodes) {
      totalCpu += node.config.cpuRequired;
      totalMemory += node.config.memoryRequired;
    }

    if (totalCpu > this.cpu.total) {
      return {
        valid: false,
        message: `CPU limit exceeded: ${totalCpu}/${this.cpu.total}`,
      };
    }

    if (totalMemory > this.memory.total) {
      return {
        valid: false,
        message: `Memory limit exceeded: ${totalMemory}/${this.memory.total}`,
      };
    }

    return { valid: true };
  }

  getTotalCost(): number {
    const cpuCost = this.cpu.used * this.cpu.cost;
    const memoryCost = this.memory.used * this.memory.cost;
    const agentCost = this.buildAgents.used * this.buildAgents.cost;

    return cpuCost + memoryCost + agentCost;
  }

  getResourceEfficiency(): number {
    const cpuEfficiency = this.cpu.total > 0 ? (this.cpu.total - this.cpu.used) / this.cpu.total : 0;
    const memoryEfficiency = this.memory.total > 0 ? (this.memory.total - this.memory.used) / this.memory.total : 0;

    return ((cpuEfficiency + memoryEfficiency) / 2) * 100;
  }

  update(): void {
    // Recalculate available resources
    this.cpu.available = this.cpu.total - this.cpu.used;
    this.memory.available = this.memory.total - this.memory.used;
    this.buildAgents.available = this.buildAgents.total - this.buildAgents.used;
  }

  allocateBuildAgent(): boolean {
    if (this.buildAgents.available > 0) {
      this.buildAgents.used++;
      this.buildAgents.available--;
      return true;
    }
    return false;
  }

  freeBuildAgent(): void {
    if (this.buildAgents.used > 0) {
      this.buildAgents.used--;
      this.buildAgents.available++;
    }
  }

  reconcile(nodes: PipelineNode[]): { cpuDrift: number; memoryDrift: number } {
    const expectedCpu = nodes.reduce((sum, n) => sum + n.config.cpuRequired, 0);
    const expectedMemory = nodes.reduce((sum, n) => sum + n.config.memoryRequired, 0);

    const cpuDrift = this.cpu.used - expectedCpu;
    const memoryDrift = this.memory.used - expectedMemory;

    if (cpuDrift !== 0 || memoryDrift !== 0) {
      window.debugLogBridge?.log(
        `Resource drift detected: CPU=${cpuDrift}, Memory=${memoryDrift}. Correcting.`,
        'warning'
      );
      this.cpu.used = expectedCpu;
      this.cpu.available = this.cpu.total - this.cpu.used;
      this.memory.used = expectedMemory;
      this.memory.available = this.memory.total - this.memory.used;
    }

    return { cpuDrift, memoryDrift };
  }

  getResourceWarnings(): string[] {
    const warnings: string[] = [];
    const cpuRatio = this.cpu.total > 0 ? this.cpu.used / this.cpu.total : 0;
    const memRatio = this.memory.total > 0 ? this.memory.used / this.memory.total : 0;

    if (cpuRatio >= GAME_CONSTANTS.RESOURCE_CRITICAL_THRESHOLD) {
      warnings.push(`CPU at ${Math.round(cpuRatio * 100)}%, near limit!`);
    } else if (cpuRatio >= GAME_CONSTANTS.RESOURCE_WARNING_THRESHOLD) {
      warnings.push(`CPU at ${Math.round(cpuRatio * 100)}%`);
    }

    if (memRatio >= GAME_CONSTANTS.RESOURCE_CRITICAL_THRESHOLD) {
      warnings.push(`Memory at ${Math.round(memRatio * 100)}%, near limit!`);
    } else if (memRatio >= GAME_CONSTANTS.RESOURCE_WARNING_THRESHOLD) {
      warnings.push(`Memory at ${Math.round(memRatio * 100)}%`);
    }

    return warnings;
  }

  getForecast(node: { config: { cpuRequired: number; memoryRequired: number } }): {
    cpuAfter: number;
    memoryAfter: number;
    cpuOverBudget: boolean;
    memoryOverBudget: boolean;
  } {
    const cpuAfter = this.cpu.used + node.config.cpuRequired;
    const memoryAfter = this.memory.used + node.config.memoryRequired;
    return {
      cpuAfter,
      memoryAfter,
      cpuOverBudget: cpuAfter > this.cpu.total,
      memoryOverBudget: memoryAfter > this.memory.total,
    };
  }
}
