import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Game phase states. These are mutually exclusive.
 *
 * - building:  Player is constructing the pipeline (default)
 * - executing: Pipeline is running
 * - paused:    Execution paused by user
 */
export type GamePhase = 'building' | 'executing' | 'paused';

/** Valid transition table. Each key lists the phases it can transition TO. */
const VALID_TRANSITIONS: Readonly<Record<GamePhase, readonly GamePhase[]>> = {
  building: ['executing'],
  executing: ['building', 'paused'],
  paused: ['executing', 'building'],
};

/**
 * Manages game phase as a finite state machine with validated transitions.
 *
 * Responsibilities:
 * - Single source of truth for game phase
 * - Validates all transitions (rejects invalid ones in dev, logs warning)
 * - Provides observable for reactive phase changes
 *
 * Does NOT own:
 * - UI panel toggles (showHelp, showSettings, showObjectives)
 * - Execution state (owned by PipelineRunnerService)
 */
@Injectable()
export class GamePhaseService {
  private readonly phaseSubject = new BehaviorSubject<GamePhase>('building');
  readonly phase$: Observable<GamePhase> = this.phaseSubject.asObservable();

  get phase(): GamePhase {
    return this.phaseSubject.value;
  }

  // ─── Convenience Getters ──────────────────────────────────────────────────

  get isBuilding(): boolean {
    return this.phase === 'building';
  }
  get isExecuting(): boolean {
    return this.phase === 'executing';
  }
  get isPaused(): boolean {
    return this.phase === 'paused';
  }

  // ─── Transitions ──────────────────────────────────────────────────────────

  /**
   * Attempt a phase transition. Returns true if successful, false if invalid.
   * Invalid transitions log a warning in dev mode but do not throw.
   */
  transition(to: GamePhase): boolean {
    const from = this.phase;
    if (from === to) return true; // No-op, already there

    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      window.debugLogBridge?.log(`Invalid phase transition: ${from} → ${to}`, 'error');
      return false;
    }

    this.phaseSubject.next(to);
    return true;
  }

  /**
   * Force reset to building phase. Bypasses transition validation.
   * Use for level loads, error recovery, and restarts.
   */
  reset(): void {
    this.phaseSubject.next('building');
  }
}
