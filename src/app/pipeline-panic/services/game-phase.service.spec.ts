import { TestBed } from '@angular/core/testing';
import { GamePhase, GamePhaseService } from './game-phase.service';

describe('GamePhaseService', () => {
  let service: GamePhaseService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [GamePhaseService],
    });
    service = TestBed.inject(GamePhaseService);
  });

  // ============================================================
  // CREATION
  // ============================================================

  describe('Creation', () => {
    it('should be created', () => {
      expect(service).toBeTruthy();
    });

    it('should start in building phase', () => {
      expect(service.phase).toBe('building');
    });
  });

  // ============================================================
  // CONVENIENCE GETTERS
  // ============================================================

  describe('Convenience Getters', () => {
    it('should report isBuilding=true in building phase', () => {
      expect(service.isBuilding).toBe(true);
      expect(service.isExecuting).toBe(false);
      expect(service.isPaused).toBe(false);
    });

    it('should report isExecuting=true in executing phase', () => {
      service.transition('executing');

      expect(service.isBuilding).toBe(false);
      expect(service.isExecuting).toBe(true);
      expect(service.isPaused).toBe(false);
    });

    it('should report isPaused=true in paused phase', () => {
      service.transition('executing');
      service.transition('paused');

      expect(service.isBuilding).toBe(false);
      expect(service.isExecuting).toBe(false);
      expect(service.isPaused).toBe(true);
    });
  });

  // ============================================================
  // VALID TRANSITIONS
  // ============================================================

  describe('Valid Transitions', () => {
    it('should allow building → executing', () => {
      const result = service.transition('executing');

      expect(result).toBe(true);
      expect(service.phase).toBe('executing');
    });

    it('should allow executing → building', () => {
      service.transition('executing');
      const result = service.transition('building');

      expect(result).toBe(true);
      expect(service.phase).toBe('building');
    });

    it('should allow executing → paused', () => {
      service.transition('executing');
      const result = service.transition('paused');

      expect(result).toBe(true);
      expect(service.phase).toBe('paused');
    });

    it('should allow paused → executing', () => {
      service.transition('executing');
      service.transition('paused');
      const result = service.transition('executing');

      expect(result).toBe(true);
      expect(service.phase).toBe('executing');
    });

    it('should allow paused → building', () => {
      service.transition('executing');
      service.transition('paused');
      const result = service.transition('building');

      expect(result).toBe(true);
      expect(service.phase).toBe('building');
    });
  });

  // ============================================================
  // INVALID TRANSITIONS
  // ============================================================

  describe('Invalid Transitions', () => {
    it('should reject building → paused', () => {
      const result = service.transition('paused');

      expect(result).toBe(false);
      expect(service.phase).toBe('building');
    });
  });

  // ============================================================
  // NO-OP TRANSITIONS
  // ============================================================

  describe('No-op Transitions', () => {
    it('should return true for building → building', () => {
      const result = service.transition('building');

      expect(result).toBe(true);
      expect(service.phase).toBe('building');
    });

    it('should return true for executing → executing', () => {
      service.transition('executing');
      const result = service.transition('executing');

      expect(result).toBe(true);
      expect(service.phase).toBe('executing');
    });

    it('should return true for paused → paused', () => {
      service.transition('executing');
      service.transition('paused');
      const result = service.transition('paused');

      expect(result).toBe(true);
      expect(service.phase).toBe('paused');
    });
  });

  // ============================================================
  // RESET
  // ============================================================

  describe('reset()', () => {
    it('should reset to building from executing', () => {
      service.transition('executing');

      service.reset();

      expect(service.phase).toBe('building');
    });

    it('should reset to building from paused', () => {
      service.transition('executing');
      service.transition('paused');

      service.reset();

      expect(service.phase).toBe('building');
    });

    it('should be a no-op when already in building phase', () => {
      service.reset();

      expect(service.phase).toBe('building');
    });
  });

  // ============================================================
  // OBSERVABLE (phase$)
  // ============================================================

  describe('Observable (phase$)', () => {
    it('should emit initial building phase on subscribe', () => {
      const emissions: GamePhase[] = [];
      service.phase$.subscribe((phase) => emissions.push(phase));

      expect(emissions).toEqual(['building']);
    });

    it('should emit on valid transitions', () => {
      const emissions: GamePhase[] = [];
      service.phase$.subscribe((phase) => emissions.push(phase));

      service.transition('executing');
      service.transition('paused');
      service.transition('building');

      expect(emissions).toEqual(['building', 'executing', 'paused', 'building']);
    });

    it('should NOT emit on invalid transitions', () => {
      const emissions: GamePhase[] = [];
      service.phase$.subscribe((phase) => emissions.push(phase));

      service.transition('paused'); // invalid from building

      expect(emissions).toEqual(['building']);
    });

    it('should NOT emit extra value on no-op transitions', () => {
      const emissions: GamePhase[] = [];
      service.phase$.subscribe((phase) => emissions.push(phase));

      service.transition('building'); // no-op

      expect(emissions).toEqual(['building']);
    });

    it('should emit on reset()', () => {
      const emissions: GamePhase[] = [];

      service.transition('executing');
      service.phase$.subscribe((phase) => emissions.push(phase));
      service.reset();

      expect(emissions).toEqual(['executing', 'building']);
    });
  });
});
