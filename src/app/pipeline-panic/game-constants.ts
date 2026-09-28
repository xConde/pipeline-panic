/**
 * Pipeline Panic Game Constants
 * Centralized configuration for all magic numbers and game parameters
 */

import { DeployStrategy, FindingSeverity, ScanType } from './models/pipeline.model';

const SIMULATION_TICK_INTERVAL_MS = 100;

/** Four release-seconds play per wall-second in the controlled prototype. */
export const CONTROLLED_PROTOTYPE_PLAYBACK_RATE = 4;

export const GAME_CONSTANTS = {
  GAME_LOOP_INTERVAL: SIMULATION_TICK_INTERVAL_MS,
  NODE_EXECUTION_UPDATE_INTERVAL: SIMULATION_TICK_INTERVAL_MS,
  NODE_RADIUS: 30,
  NODE_MOVE_STEP: 20,
  MIN_NODE_SPACING: 80,
  MAX_NODES_PER_PIPELINE: 20,
  MAX_CONNECTIONS_PER_PIPELINE: 30,
  INPUT_DEBOUNCE_MS: 100,
  DEFAULT_BUILD_AGENTS: 5,
  RESOURCE_WARNING_THRESHOLD: 0.8,
  RESOURCE_CRITICAL_THRESHOLD: 0.95,
  NODE_TIMEOUT_MULTIPLIER: 3,
  STUCK_THRESHOLD_MS: 5000,
  STUCK_WATCHDOG_INTERVAL_MS: 1000,
  DEFAULT_RETRY_DELAY: 1500,
  DEFAULT_RETRY_COUNT: 0,
} as const;
export const PIPELINE_SCHEDULER_TICK_SECONDS = GAME_CONSTANTS.NODE_EXECUTION_UPDATE_INTERVAL / 1000;

// ─── Canvas Fonts ───────────────────────────────────────────────────────────

// COUPLING: these two stacks MUST match $font-mono / $font-system in
// styles/_design-system.scss (copied verbatim, same family order). Canvas 2D's
// ctx.font can't read a SCSS variable at runtime, so the same font list is
// expressed twice — if they drift, DOM text and canvas-drawn text (node icons,
// labels, the empty-board prompt) render in visibly different fonts.
const CANVAS_FONT_MONO = "'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', monospace";
const CANVAS_FONT_SYSTEM = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";

/**
 * Fully-assembled `ctx.font` shorthand strings, built once at module load.
 * Consume these directly in the render loop — never rebuild a font string
 * per frame (allocates a new string every call for no visual benefit).
 */
export const CANVAS_NODE_ICON_FONT = `bold 14px ${CANVAS_FONT_MONO}`;
export const CANVAS_NODE_LABEL_FONT = `600 12px ${CANVAS_FONT_SYSTEM}`;
export const CANVAS_EMPTY_PROMPT_FONT = `500 16px ${CANVAS_FONT_SYSTEM}`;

// ─── Canvas Node Fitting ────────────────────────────────────────────────────

/**
 * Desk-neutral "socket plate" fill for a node that hasn't run yet
 * (Idle/Waiting). Same material as the node's name-label chip background —
 * unified into one constant pair here so the plate and its own label chip
 * read as one fitting, not two coincidentally-matching rectangles — a
 * patch-jack face rather than a flat saturated disc.
 */
export const CANVAS_NODE_PLATE_FILL_DARK = 'rgba(0, 0, 0, 0.85)';
export const CANVAS_NODE_PLATE_FILL_LIGHT = 'rgba(255, 255, 255, 0.95)';

/**
 * Alpha for the translucent stage-hue wash layered over the socket plate.
 * COUPLING: matches the evidence rail's `color-mix(in srgb, var(--stage-ink)
 * 42%, transparent)` recipe for `.rail-stage` in styles/_canvas.scss, so a
 * node on the board and its stage segment on the rail below read as the same
 * material under the same hue instead of two unrelated color treatments.
 */
export const CANVAS_NODE_HUE_WASH_ALPHA = 0.42;

// ─── P4: Severity Tables ────────────────────────────────────────────────────

/**
 * Representative findings per severity tier per scan type.
 * CRITICAL and HIGH cause node failure; MEDIUM and LOW emit warnings;
 * INFO is a silent pass.
 *
 * Probabilities (sum = 1.0):
 *   CRITICAL ~8%, HIGH ~15%, MEDIUM ~25%, LOW ~30%, INFO ~22%
 */
export interface ScanFinding {
  finding: string;
  severity: FindingSeverity;
  tool: string;
}

export const SCAN_SEVERITY_TABLES: Record<ScanType, ScanFinding[]> = {
  sast: [
    { severity: 'CRITICAL', finding: 'SQL injection via unsanitized input in /api/users (CWE-89)', tool: 'semgrep' },
    { severity: 'HIGH', finding: 'XSS via untrusted data in innerHTML (CWE-79)', tool: 'CodeQL' },
    { severity: 'MEDIUM', finding: 'Path traversal risk in file upload handler (CWE-22)', tool: 'semgrep' },
    { severity: 'LOW', finding: 'Insecure random number generator in session ID (CWE-330)', tool: 'semgrep' },
    { severity: 'INFO', finding: 'Dead code branch detected, no security impact', tool: 'semgrep' },
  ],
  sca: [
    {
      severity: 'CRITICAL',
      finding: 'lodash@4.17.20: Prototype Pollution (CVE-2019-10744, CVSS 9.1)',
      tool: 'snyk',
    },
    { severity: 'HIGH', finding: 'axios@0.21.1: SSRF via open redirect (CVE-2021-3749)', tool: 'npm audit' },
    {
      severity: 'MEDIUM',
      finding: 'minimist@1.2.5: Prototype Pollution (CVE-2021-44906)',
      tool: 'snyk',
    },
    { severity: 'LOW', finding: 'debug@4.3.1: ReDoS via long input string (CVE-2017-20165)', tool: 'npm audit' },
    { severity: 'INFO', finding: 'chalk@4.1.2: no known CVEs; license: MIT', tool: 'snyk' },
  ],
  secret: [
    { severity: 'CRITICAL', finding: 'AWS_SECRET_ACCESS_KEY found in src/config/aws.ts (line 14)', tool: 'gitleaks' },
    { severity: 'HIGH', finding: 'Hardcoded JWT signing secret in src/auth/jwt.ts (line 7)', tool: 'gitleaks' },
    { severity: 'MEDIUM', finding: 'Generic password pattern in .env.example (low entropy)', tool: 'gitleaks' },
    { severity: 'LOW', finding: 'Test fixture contains example API key (non-production)', tool: 'gitleaks' },
    { severity: 'INFO', finding: 'No credential patterns detected in staged changes', tool: 'gitleaks' },
  ],
  container: [
    { severity: 'CRITICAL', finding: 'debian:buster base image: openssl CVE-2023-0286 (CVSS 9.8)', tool: 'trivy' },
    { severity: 'HIGH', finding: 'libssl3: CVE-2022-4450 heap buffer overflow', tool: 'grype' },
    { severity: 'MEDIUM', finding: 'curl@7.74.0: URL parsing confusion (CVE-2022-27776)', tool: 'trivy' },
    { severity: 'LOW', finding: 'libc6@2.31: informational hardening gap (no CVSS)', tool: 'grype' },
    { severity: 'INFO', finding: 'Image layers scanned. 0 CVEs above INFO threshold', tool: 'trivy' },
  ],
};

/**
 * Severity roll probability thresholds (cumulative).
 * Roll a value in [0, 1) and pick the first bucket it falls into:
 *   < 0.08  → CRITICAL
 *   < 0.23  → HIGH
 *   < 0.48  → MEDIUM
 *   < 0.78  → LOW
 *   else    → INFO
 */
export const SEVERITY_THRESHOLDS: Record<FindingSeverity, number> = {
  CRITICAL: 0.08,
  HIGH: 0.23,
  MEDIUM: 0.48,
  LOW: 0.78,
  INFO: 1.0,
};

/** Suffix appended to coverage-fail evidence messages. */
export const COVERAGE_FAILURE_SUFFIX = 'Test coverage below threshold. Failing node.';

/** The 1-based level number (and 0-based index 6) that enforces dual scan types */
export const DUAL_SCAN_REQUIRED_LEVEL = 7;

/** The two distinct scan types that must both pass on DUAL_SCAN_REQUIRED_LEVEL */
export const DUAL_SCAN_TYPES: [ScanType, ScanType] = ['sast', 'sca'];

// ─── P5: Deploy Strategy Configuration ─────────────────────────────────────

/**
 * Per-strategy simulation parameters.
 *
 * timeMultiplier: multiplied with ENVIRONMENT_TIME_MULTIPLIERS to determine
 *   effective node duration. Values > 1 = slower; < 1 = faster.
 * rollbackDurationMs: how long the rollback timeout runs in performRollback().
 *   Replaces the hardcoded 2000ms so each strategy has a realistic recovery time.
 * trafficModel: human-readable description of the traffic routing model.
 * blastRadius: human-readable blast-radius description for presentation layers.
 * rollbackSpeedLabel: human-readable rollback speed for presentation layers.
 */
export const DEPLOY_STRATEGY_CONFIG: Record<
  DeployStrategy,
  {
    timeMultiplier: number;
    rollbackDurationMs: number;
    trafficModel: string;
    blastRadius: string;
    rollbackSpeedLabel: string;
  }
> = {
  rolling: {
    timeMultiplier: 1.0,
    rollbackDurationMs: 3000,
    trafficModel: 'incremental batches',
    blastRadius: 'medium',
    rollbackSpeedLabel: 'medium',
  },
  'blue-green': {
    timeMultiplier: 0.8,
    rollbackDurationMs: 1000,
    trafficModel: 'instant cutover + standby',
    blastRadius: 'low (instant revert)',
    rollbackSpeedLabel: 'instant',
  },
  canary: {
    timeMultiplier: 1.5,
    rollbackDurationMs: 500,
    trafficModel: '10% traffic, gradual ramp',
    blastRadius: 'lowest (sub-second revert)',
    rollbackSpeedLabel: 'fastest',
  },
};

/**
 * Ambient per-run failure rates per deploy strategy.
 *
 * Applied at the midGate (once per run, at 50% progress) ONLY when the level's
 * fridayDeploy purposeful check has NOT already triggered. These represent the
 * inherent production reliability of each strategy's rollout mechanism.
 *
 * Honest model: the SAFEST strategy fails least (reaches users with a bad version
 * least often); its cost is SPEED, not reliability (see DEPLOY_STRATEGY_CONFIG —
 * canary is the slowest at 1.5x). This keeps the risk advisory consistent: the
 * strategy shown as lower-risk must also fail less, or it is a superstition.
 *
 * canary: 0.04 — gradual ramp catches a bad release on ~10% of traffic before it
 *   ever reaches the fleet. Lowest blast radius AND lowest reach-the-user rate.
 *   Balanced by being the slowest to fully roll out.
 * blue-green: 0.06 — atomic cutover to a pre-warmed standby; fast and safe, but the
 *   whole fleet flips at once, so a latent bug hits everyone until the (instant) revert.
 * rolling: 0.10 — incremental in-place replacement, no isolated slice; a bad version
 *   reaches users progressively and rollback is the slowest. Highest reach-the-user rate.
 */
export const DEPLOY_STRATEGY_FAILURE_RATES: Record<DeployStrategy, number> = {
  rolling: 0.1,
  'blue-green': 0.06,
  canary: 0.04,
};
