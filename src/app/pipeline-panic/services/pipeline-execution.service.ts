import { Injectable } from '@angular/core';
import { FindingSeverity, NodeStatus, NodeType, Pipeline, PipelineNode, ScanType } from '../models/pipeline.model';
import { isControlledPrototype, Level } from '../models/game-state.model';
import { DUAL_SCAN_TYPES, SCAN_SEVERITY_TABLES, ScanFinding, SEVERITY_THRESHOLDS } from '../game-constants';

/**
 * Result of checking for purposeful failure
 */
export interface PurposefulFailureResult {
  shouldFail: boolean;
  reason?: string;
  /**
   * P4: Set only when the failure is due to the Level 7 dual-scan compliance gate.
   * Carries the missing scan type so the runner can emit a 'dual-scan-fail' event
   * before calling handleNodeFailure, allowing a presentation layer to explain
   * which scan type was missing.
   */
  dualScanMissingType?: ScanType;
}

/**
 * Result of the severity gate check for a SecurityScan node.
 */
export interface SeverityGateResult {
  shouldFail: boolean;
  severity?: FindingSeverity;
  finding?: ScanFinding;
  /** True when the finding is MEDIUM/LOW — emit as warning, do NOT fail the node. */
  isWarn?: boolean;
}

/**
 * Result of the coverage gate check for a Test node.
 */
export interface CoverageGateResult {
  shouldFail: boolean;
  produced: number;
  threshold: number;
  /** True when coverage passes but is within 5% above threshold — emit as warning. */
  isNearThreshold?: boolean;
}

/**
 * Result of the dual-scan-type compliance check for Level 7 Deploy nodes.
 */
export interface DualScanCheckResult {
  satisfied: boolean;
  /** The scan type that is missing (only set when satisfied=false). */
  missingType?: ScanType;
}

/**
 * Failure reasons by node type for realistic CI/CD messages
 */
const FAILURE_REASONS: Record<string, string[]> = {
  [NodeType.Test]: [
    'Flaky test detected - assertion timeout',
    'Test coverage below threshold (78% < 80%)',
    'Integration test failed - service unavailable',
    'Race condition in async test',
  ],
  [NodeType.Build]: [
    'Compilation error in module',
    'Missing dependency resolution',
    'Out of memory during build',
    'Type mismatch in strict mode',
  ],
  [NodeType.Deploy]: [
    'Health check failed after deployment',
    'Container failed to start',
    'Connection timeout to cluster',
    'Resource quota exceeded',
  ],
};

/**
 * Per-scan-type failure reasons for SecurityScan nodes.
 * Each type reflects realistic findings from the named tooling.
 */
const SECURITY_SCAN_FAILURE_REASONS: Record<ScanType, string[]> = {
  sast: [
    'Semgrep: SQL injection pattern detected (CWE-89)',
    'CodeQL alert: untrusted data flows into sink',
    'SAST rule violation: eval() with user input',
  ],
  sca: [
    'snyk: 3 high-severity dependency CVEs found',
    'npm audit: critical in lodash@4.17.20 (CVE-2021-23337)',
    'SCA gate: CVSS 9.1 in direct dependency',
  ],
  secret: [
    'gitleaks: AWS_SECRET_KEY found in src/config.ts',
    'Secret scan: hardcoded JWT signing key detected',
    'Credential pattern matched in commit history',
  ],
  container: [
    'trivy: critical CVE in base image (debian:buster)',
    'grype: 2 HIGH vulns in libssl layer',
    'Container scan: unpinned base image with known CVEs',
  ],
};

/**
 * PipelineExecutionService - Core game logic for pipeline execution
 *
 * Responsibilities:
 * - Check for purposeful (level-designed) failures
 * - Generate failure reasons
 * - Pipeline state queries (completion, failures, inputs)
 *
 * This service contains PURE BUSINESS LOGIC with no side effects.
 * The component is responsible for applying the results.
 *
 * Usage:
 * ```typescript
 * const failureCheck = this.executionService.checkPurposefulFailure(node, level, levelIndex, pipeline);
 * if (failureCheck.shouldFail) {
 *   // Handle failure
 * }
 * ```
 */
@Injectable()
export class PipelineExecutionService {
  /** Clamp authored failure data at the engine boundary. */
  clampFailureRate(baseRate: number): number {
    return Math.max(0, Math.min(1, baseRate));
  }

  /**
   * Check if a node should fail based on level-designed conditions
   *
   * @param node - The node being executed
   * @param level - Current level configuration
   * @param levelIndex - Zero-based level index
   * @param pipeline - Current pipeline state
   * @returns Whether the node should fail and why
   */
  checkPurposefulFailure(
    node: PipelineNode,
    level: Level,
    levelIndex: number,
    pipeline: Pipeline
  ): PurposefulFailureResult {
    // Level 1: Tutorial - no failures, let players learn the basics
    if (levelIndex === 0) {
      return { shouldFail: false };
    }

    // The release desk disables RNG-based failures. Deterministic policy gates
    // still apply below for any future authored scenario that enables them.
    if (isControlledPrototype(level)) {
      // Security audit is deterministic (not RNG), so it still applies
      if (level.securityAudit && node.type === NodeType.Deploy) {
        const hasPassedSecurityScan = pipeline.nodes.some(
          (n) => n.type === NodeType.SecurityScan && n.status === NodeStatus.Success
        );
        if (!hasPassedSecurityScan) {
          return {
            shouldFail: true,
            reason: 'Security audit failed - deployment blocked without security scan',
          };
        }
      }
      // RTG (2026-06-23): dual-scan compliance is DETERMINISTIC (like securityAudit),
      // so it must apply even on Junior where RNG failures are disabled. Previously this
      // gate lived after the Junior early-return, letting a single SAST scan satisfy
      // Level 7 on Junior while the copy still claimed "SAST AND SCA required".
      const juniorDualGate = this.checkDualScanGate(node, level, pipeline);
      if (juniorDualGate) {
        return juniorDualGate;
      }
      return { shouldFail: false };
    }

    // Level 2+: Security Audit - Deploy fails if no SecurityScan has passed
    if (level.securityAudit && node.type === NodeType.Deploy) {
      const hasPassedSecurityScan = pipeline.nodes.some(
        (n) => n.type === NodeType.SecurityScan && n.status === NodeStatus.Success
      );
      if (!hasPassedSecurityScan) {
        return {
          shouldFail: true,
          reason: 'Security audit failed - deployment blocked without security scan',
        };
      }
    }

    // Level 4: Friday Deploy - Deploy nodes have increased failure rate
    // BALANCE: Reduced from 20% to 10% - still challenging but not frustrating
    // Real-world risk: reduced on-call coverage, short rollback window, larger blast radius.
    // No mitigation reduces this RNG roll — plan around it (smaller change batch, ensure a
    // rollback path is enabled, time deployments earlier in the day when possible).
    if (level.fridayDeploy && node.type === NodeType.Deploy) {
      const fridayFailureChance = this.clampFailureRate(0.1);
      if (Math.random() < fridayFailureChance) {
        return {
          shouldFail: true,
          reason: 'Friday deploy failure - reduced on-call coverage increases blast radius',
        };
      }
    }

    // Rush Hour modifier: Test nodes have increased flakiness per node
    // BALANCE: Reduced from 15% to 8% - noticeable but manageable
    // Honest model: this is a transient per-node roll. Adding more Test nodes does NOT
    // reduce per-node flakiness — each node rolls independently, so more nodes means more
    // potential failures. The real mitigation is retry-with-backoff: set the Test node's
    // retryCount (now a player-settable control) so the runner re-rolls on a transient
    // failure. (Real-world flaky tests are also fixed by isolation/quarantine.)
    if (level.rushHour && node.type === NodeType.Test) {
      const rushHourFlakiness = this.clampFailureRate(0.08);
      if (Math.random() < rushHourFlakiness) {
        return {
          shouldFail: true,
          reason: 'Test flaky under high load - transient roll, reset and re-run to clear it',
        };
      }
    }

    // QualityGate: fail if upstream test success rate is below threshold
    if (node.type === NodeType.QualityGate) {
      const threshold = node.config.threshold ?? 1.0;
      const upstreamTests = this.getUpstreamNodesOfType(node, pipeline, NodeType.Test);
      if (upstreamTests.length > 0) {
        const passedTests = upstreamTests.filter((t) => t.status === NodeStatus.Success).length;
        const successRate = passedTests / upstreamTests.length;
        if (successRate < threshold) {
          return {
            shouldFail: true,
            reason: `Quality gate failed: ${Math.round(successRate * 100)}% pass rate (need ${Math.round(threshold * 100)}%)`,
          };
        }
      }
    }

    // P4: Dual-scan compliance check (Level 7 only, for Deploy nodes)
    const dualGate = this.checkDualScanGate(node, level, pipeline);
    if (dualGate) {
      return dualGate;
    }

    return { shouldFail: false };
  }

  /**
   * P4 dual-scan compliance gate (Level 7, `requireDualScanTypes`). DETERMINISTIC — must
   * be enforced on all difficulties (including Junior), exactly like the securityAudit
   * gate. Returns a failure result when a Deploy lacks two DIFFERENT passed scan types,
   * otherwise null. Single source of truth so the Junior branch and the main path can't
   * drift.
   */
  private checkDualScanGate(node: PipelineNode, level: Level, pipeline: Pipeline): PurposefulFailureResult | null {
    if (node.type !== NodeType.Deploy || !level.requireDualScanTypes) {
      return null;
    }
    const dualCheck = this.checkDualScanTypes(pipeline, level);
    if (dualCheck.satisfied) {
      return null;
    }
    const missingType: ScanType = dualCheck.missingType ?? 'sast';
    return {
      shouldFail: true,
      reason: `Level 7 compliance: deploy requires both ${DUAL_SCAN_TYPES[0].toUpperCase()} AND ${DUAL_SCAN_TYPES[1].toUpperCase()} scan types. Missing: ${missingType.toUpperCase()}. Add a SecurityScan node with scanType=${missingType}.`,
      dualScanMissingType: missingType,
    };
  }

  /**
   * P4: Severity gate for SecurityScan nodes.
   *
   * Rolls a severity from the SCAN_SEVERITY_TABLES for the node's configured scan type.
   * CRITICAL and HIGH cause node failure. MEDIUM and LOW return isWarn=true (emit warning,
   * but the node continues to Success). INFO is a silent pass.
   *
   * This is called at ~50% progress by the runner's createNodeInterval().
   *
   * @param node - The SecurityScan node being executed
   * @returns SeverityGateResult — whether to fail, warn, or pass
   */
  checkSeverityGate(node: PipelineNode): SeverityGateResult {
    const scanType: ScanType = node.config.scanType ?? 'sast';
    const findings = SCAN_SEVERITY_TABLES[scanType];

    const roll = Math.random();
    const criticalThreshold = this.clampFailureRate(SEVERITY_THRESHOLDS.CRITICAL);
    const highThreshold = this.clampFailureRate(SEVERITY_THRESHOLDS.HIGH);
    const mediumThreshold = this.clampFailureRate(SEVERITY_THRESHOLDS.MEDIUM);
    const lowThreshold = this.clampFailureRate(SEVERITY_THRESHOLDS.LOW);
    let severity: FindingSeverity = 'INFO';
    if (roll < criticalThreshold) {
      severity = 'CRITICAL';
    } else if (roll < highThreshold) {
      severity = 'HIGH';
    } else if (roll < mediumThreshold) {
      severity = 'MEDIUM';
    } else if (roll < lowThreshold) {
      severity = 'LOW';
    } else {
      severity = 'INFO';
    }

    // Pick the finding entry matching this severity level
    const finding = findings.find((f) => f.severity === severity);
    // INFO is a silent pass
    if (severity === 'INFO' || !finding) {
      return { shouldFail: false };
    }
    // CRITICAL or HIGH → fail the node
    if (severity === 'CRITICAL' || severity === 'HIGH') {
      return { shouldFail: true, severity, finding };
    }
    // MEDIUM or LOW → warn but pass
    return { shouldFail: false, isWarn: true, severity, finding };
  }

  /**
   * P4: Coverage gate for Test nodes.
   *
   * Produces a threshold-independent simulated measurement for this attempt and
   * compares it with the configured policy. This preserves the current risk/reward
   * control without pretending that the player can raise coverage. A causal coverage
   * model remains deferred until the core-loop prototype passes its playtest gate.
   *
   * @param node - The Test node that just completed
   * @returns CoverageGateResult — whether to fail, the produced value, the threshold
   */
  checkCoverageGate(node: PipelineNode): CoverageGateResult {
    const threshold = node.config.coverageThreshold ?? 75;
    const raw = Math.floor(60 + Math.random() * 45);
    const produced = Math.max(0, Math.min(100, raw));

    // Store on the node so a presentation layer can display it.
    node.config.producedCoverage = produced;

    if (produced < threshold) {
      return { shouldFail: true, produced, threshold };
    }
    // Warn when coverage is within 5% of threshold (passed but just barely)
    const isNearThreshold = produced < threshold + 5;
    return { shouldFail: false, produced, threshold, isNearThreshold };
  }

  /**
   * P4: Dual-scan compliance check for Level 7 Deploy nodes.
   *
   * Verifies that at least one SecurityScan node configured as 'sast' AND at
   * least one configured as 'sca' have both reached NodeStatus.Success.
   * This is ADDITIVE to the existing securityAudit check — both must pass.
   *
   * @param pipeline - Current pipeline state
   * @param _level - Level configuration (unused currently; kept for API consistency)
   * @returns DualScanCheckResult — whether the dual-scan requirement is satisfied
   */
  checkDualScanTypes(pipeline: Pipeline, _level: Level): DualScanCheckResult {
    const passedScans = pipeline.nodes.filter(
      (n) => n.type === NodeType.SecurityScan && n.status === NodeStatus.Success
    );
    const passedTypes = new Set(passedScans.map((n) => n.config.scanType ?? 'sast'));

    const [required1, required2] = DUAL_SCAN_TYPES;
    const hasFirst = passedTypes.has(required1);
    const hasSecond = passedTypes.has(required2);

    if (hasFirst && hasSecond) {
      return { satisfied: true };
    }
    // Return the first missing type
    if (!hasFirst) {
      return { satisfied: false, missingType: required1 };
    }
    return { satisfied: false, missingType: required2 };
  }

  /**
   * Get a random failure reason for a node type.
   * For SecurityScan nodes, dispatches to the per-scan-type sub-array.
   * @param nodeType - The type of node that failed
   * @param scanType - For SecurityScan nodes, which scan type was configured (default 'sast')
   */
  getRandomFailureReason(nodeType: NodeType, scanType?: ScanType): string {
    if (nodeType === NodeType.SecurityScan) {
      const effectiveScanType: ScanType = scanType ?? 'sast';
      const reasons = SECURITY_SCAN_FAILURE_REASONS[effectiveScanType];
      return reasons[Math.floor(Math.random() * reasons.length)];
    }
    const reasons = FAILURE_REASONS[nodeType] || ['Unknown error occurred'];
    return reasons[Math.floor(Math.random() * reasons.length)];
  }

  /**
   * Check if all inputs to a node are complete (Success or Skipped)
   */
  areAllInputsComplete(node: PipelineNode, pipeline: Pipeline): boolean {
    return node.inputs.every((inputId) => {
      const inputNode = pipeline.nodes.find((n) => n.id === inputId);
      return inputNode?.status === NodeStatus.Success || inputNode?.status === NodeStatus.Skipped;
    });
  }

  /**
   * Check if pipeline execution is complete.
   * A node in Retrying status is NOT complete — it will re-execute.
   * RolledBack is terminal — pipeline can complete with rolled-back Deploy nodes.
   */
  isPipelineComplete(pipeline: Pipeline): boolean {
    return pipeline.nodes.every(
      (node) =>
        node.status === NodeStatus.Success ||
        node.status === NodeStatus.Skipped ||
        node.status === NodeStatus.Failed ||
        node.status === NodeStatus.Cancelled ||
        node.status === NodeStatus.RolledBack
    );
  }

  /**
   * Check if pipeline has any hard failures.
   *
   * P2 SEMANTIC: RolledBack is NOT a hard failure.
   * A rolled-back deploy means the run recovered — no incident, but also no
   * new deploy shipped. The pipeline-complete handler distinguishes partial
   * (only RolledBack) from failed (at least one Failed node).
   */
  hasPipelineFailures(pipeline: Pipeline): boolean {
    return pipeline.nodes.some((node) => node.status === NodeStatus.Failed || node.status === NodeStatus.Cancelled);
  }

  /**
   * Helper: returns true when a node's terminal status is RolledBack.
   * Use this in the component instead of comparing status strings directly.
   */
  isRolledBack(node: PipelineNode): boolean {
    return node.status === NodeStatus.RolledBack;
  }

  /**
   * Check if all required nodes are present and ran to a terminal non-failed state.
   *
   * P2 SEMANTIC: this is a TOPOLOGY/structure check ("did the pipeline contain and
   * run each required node type?"), NOT an objective check. A RolledBack Deploy DID
   * run — the pipeline is not "missing required nodes" — so it counts here, which lets
   * checkPipelineComplete fall through to the honest partial-run branch instead of the
   * misleading "missing required nodes" failure. Objective crediting is separate: a
   * rolled-back deploy never increments totalDeployments, so it still fails the deploy
   * objective and the player must re-run for a clean ship.
   */
  hasRequiredNodes(pipeline: Pipeline, requiredNodes: NodeType[]): boolean {
    return requiredNodes.every((requiredType) =>
      pipeline.nodes.some(
        (node) =>
          node.type === requiredType && (node.status === NodeStatus.Success || node.status === NodeStatus.RolledBack)
      )
    );
  }

  /**
   * Get downstream nodes from a given node
   */
  getDownstreamNodes(node: PipelineNode, pipeline: Pipeline): PipelineNode[] {
    return node.outputs
      .map((id) => pipeline.nodes.find((n) => n.id === id))
      .filter((n): n is PipelineNode => n !== undefined);
  }

  /**
   * Get all upstream nodes of a specific type by traversing connections backwards.
   * Uses BFS to avoid infinite loops in case of cyclic connections.
   */
  getUpstreamNodesOfType(node: PipelineNode, pipeline: Pipeline, targetType: NodeType): PipelineNode[] {
    const visited = new Set<string>();
    const queue: string[] = [...node.inputs];
    const result: PipelineNode[] = [];

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (currentId === undefined) break;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const current = pipeline.nodes.find((n) => n.id === currentId);
      if (!current) continue;

      if (current.type === targetType) {
        result.push(current);
      }
      // Continue traversing upstream
      queue.push(...current.inputs);
    }

    return result;
  }
}
