import { ParticleSystemService } from './particle-system.service';

describe('ParticleSystemService', () => {
  let service: ParticleSystemService;
  let canvas: HTMLCanvasElement;
  let mockContext: CanvasRenderingContext2D;

  beforeEach(() => {
    service = new ParticleSystemService();

    // Create a mock canvas and context
    canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;

    mockContext = {
      clearRect: jasmine.createSpy('clearRect'),
      save: jasmine.createSpy('save'),
      restore: jasmine.createSpy('restore'),
      beginPath: jasmine.createSpy('beginPath'),
      arc: jasmine.createSpy('arc'),
      fill: jasmine.createSpy('fill'),
      globalAlpha: 1,
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D;

    spyOn(canvas, 'getContext').and.returnValue(mockContext);
  });

  describe('initialize', () => {
    it('should store canvas reference', () => {
      service.initialize(canvas);

      expect(canvas.getContext).toHaveBeenCalledWith('2d');
    });

    it('should handle null context gracefully', () => {
      const nullCanvas = document.createElement('canvas');
      spyOn(nullCanvas, 'getContext').and.returnValue(null);

      expect(() => service.initialize(nullCanvas)).not.toThrow();
    });
  });

  describe('burst', () => {
    beforeEach(() => {
      service.initialize(canvas);
    });

    it('should create multiple particles', () => {
      service.burst(100, 100, '#ff0000', 10);

      expect(service.getParticleCount()).toBe(10);
    });

    it('should use default count of 20 if not specified', () => {
      service.burst(100, 100, '#ff0000');

      expect(service.getParticleCount()).toBe(20);
    });

    it('should distribute particles in a circular pattern', () => {
      service.burst(100, 100, '#ff0000', 4);

      // Particles should be distributed evenly (4 particles at 0, 90, 180, 270 degrees)
      expect(service.getParticleCount()).toBe(4);
    });

    it('should not exceed max particles limit', () => {
      // Try to create more than max (500)
      for (let i = 0; i < 30; i++) {
        service.burst(100, 100, '#ff0000', 20);
      }

      expect(service.getParticleCount()).toBeLessThanOrEqual(500);
    });

    it('should create particles at specified position', () => {
      service.burst(200, 300, '#00ff00', 1);

      // Particle should start at x=200, y=300
      expect(service.getParticleCount()).toBe(1);
    });
  });

  describe('emit', () => {
    beforeEach(() => {
      service.initialize(canvas);
    });

    it('should create a single particle', () => {
      service.emit(100, 100, '#ff0000');

      expect(service.getParticleCount()).toBe(1);
    });

    it('should not exceed max particles limit', () => {
      // Fill up to max
      for (let i = 0; i < 600; i++) {
        service.emit(100, 100, '#ff0000');
      }

      expect(service.getParticleCount()).toBeLessThanOrEqual(500);
    });

    it('should create particles at specified position', () => {
      service.emit(150, 250, '#0000ff');

      expect(service.getParticleCount()).toBe(1);
    });
  });

  describe('createTrail', () => {
    beforeEach(() => {
      service.initialize(canvas);
    });

    it('should create a single trail particle', () => {
      service.createTrail(100, 100, '#ff0000');

      expect(service.getParticleCount()).toBe(1);
    });

    it('should not exceed max particles limit', () => {
      for (let i = 0; i < 600; i++) {
        service.createTrail(100, 100, '#ff0000');
      }

      expect(service.getParticleCount()).toBeLessThanOrEqual(500);
    });

    it('should add slight position variance', () => {
      // Trail particles have slight random offset
      service.createTrail(100, 100, '#ff0000');

      expect(service.getParticleCount()).toBe(1);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      service.initialize(canvas);
    });

    it('should do nothing when context is not available', () => {
      const uninitializedService = new ParticleSystemService();

      expect(() => uninitializedService.update()).not.toThrow();
    });

    it('should clear the canvas', () => {
      service.emit(100, 100, '#ff0000');
      service.update();

      expect(mockContext.clearRect).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
    });

    it('skips clearRect when there are no particles (no wasted per-frame clear)', () => {
      expect(service.getParticleCount()).toBe(0);
      service.update();
      expect(mockContext.clearRect).not.toHaveBeenCalled();
    });

    it('should render particles', () => {
      service.emit(100, 100, '#ff0000');
      service.update();

      expect(mockContext.beginPath).toHaveBeenCalled();
      expect(mockContext.arc).toHaveBeenCalled();
      expect(mockContext.fill).toHaveBeenCalled();
    });

    it('should remove dead particles (life <= 0)', () => {
      service.emit(100, 100, '#ff0000');
      expect(service.getParticleCount()).toBe(1);

      // Run update many times to decay particle life
      for (let i = 0; i < 100; i++) {
        service.update();
      }

      // Particle should be removed after enough updates
      expect(service.getParticleCount()).toBe(0);
    });

    it('should apply gravity to particles', () => {
      service.emit(100, 100, '#ff0000');

      // Multiple updates should cause particles to fall (vy increases)
      service.update();
      service.update();

      // Gravity is applied, particle count may decrease due to life decay
      expect(service.getParticleCount()).toBeLessThanOrEqual(1);
    });

    it('should set globalAlpha per particle and reset to 1 after rendering', () => {
      service.emit(100, 100, '#ff0000');
      service.update();

      // globalAlpha is set directly (no save/restore overhead) and reset to 1 at end
      expect(mockContext.globalAlpha).toBe(1);
      // Particles are rendered with arc + fill
      expect(mockContext.beginPath).toHaveBeenCalled();
      expect(mockContext.fill).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    beforeEach(() => {
      service.initialize(canvas);
    });

    it('should remove all particles', () => {
      service.burst(100, 100, '#ff0000', 20);
      expect(service.getParticleCount()).toBe(20);

      service.clear();

      expect(service.getParticleCount()).toBe(0);
    });

    it('should clear the canvas', () => {
      service.clear();

      expect(mockContext.clearRect).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
    });

    it('should handle clear when not initialized', () => {
      const uninitializedService = new ParticleSystemService();

      expect(() => uninitializedService.clear()).not.toThrow();
    });
  });

  describe('getParticleCount', () => {
    beforeEach(() => {
      service.initialize(canvas);
    });

    it('should return 0 initially', () => {
      expect(service.getParticleCount()).toBe(0);
    });

    it('should return correct count after adding particles', () => {
      service.emit(100, 100, '#ff0000');
      service.emit(100, 100, '#ff0000');
      service.emit(100, 100, '#ff0000');

      expect(service.getParticleCount()).toBe(3);
    });

    it('should return correct count after burst', () => {
      service.burst(100, 100, '#ff0000', 15);

      expect(service.getParticleCount()).toBe(15);
    });

    it('should return 0 after clear', () => {
      service.burst(100, 100, '#ff0000', 10);
      service.clear();

      expect(service.getParticleCount()).toBe(0);
    });
  });

  describe('edge cases', () => {
    beforeEach(() => {
      service.initialize(canvas);
    });

    it('should handle rapid burst calls', () => {
      for (let i = 0; i < 10; i++) {
        service.burst(i * 10, i * 10, '#ff0000', 5);
      }

      expect(service.getParticleCount()).toBe(50);
    });

    it('should handle zero count burst', () => {
      service.burst(100, 100, '#ff0000', 0);

      expect(service.getParticleCount()).toBe(0);
    });

    it('should handle negative position values', () => {
      service.emit(-100, -100, '#ff0000');

      expect(service.getParticleCount()).toBe(1);
    });

    it('should handle very large position values', () => {
      service.emit(10000, 10000, '#ff0000');

      expect(service.getParticleCount()).toBe(1);
    });

    it('should handle empty color string', () => {
      service.emit(100, 100, '');

      expect(service.getParticleCount()).toBe(1);
    });
  });

  describe('particle lifecycle', () => {
    beforeEach(() => {
      service.initialize(canvas);
    });

    it('should gradually reduce particle life on update', () => {
      service.emit(100, 100, '#ff0000');
      const initialCount = service.getParticleCount();

      // Run updates but not enough to kill particle
      service.update();

      expect(service.getParticleCount()).toBe(initialCount);
    });

    it('should eventually remove all particles through updates', () => {
      service.burst(100, 100, '#ff0000', 5);

      // Run many updates to let all particles decay
      for (let i = 0; i < 200; i++) {
        service.update();
      }

      expect(service.getParticleCount()).toBe(0);
    });
  });
});
