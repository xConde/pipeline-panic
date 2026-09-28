import { Injectable } from '@angular/core';
import { Particle } from '../models/pipeline.model';

@Injectable()
export class ParticleSystemService {
  private particles: Particle[] = [];
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private maxParticles = 500;

  constructor() {}

  initialize(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (context) {
      this.ctx = context;
    }
  }

  burst(x: number, y: number, color: string, count: number = 20): void {
    for (let i = 0; i < count && this.particles.length < this.maxParticles; i++) {
      const angle = (Math.PI * 2 * i) / count;
      const speed = 2 + Math.random() * 3;

      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        color,
        size: 2 + Math.random() * 3,
      });
    }
  }

  emit(x: number, y: number, color: string): void {
    if (this.particles.length >= this.maxParticles) return;

    const angle = Math.random() * Math.PI * 2;
    const speed = 1 + Math.random() * 2;

    this.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      color,
      size: 2 + Math.random() * 2,
    });
  }

  update(): void {
    if (!this.ctx || !this.canvas) return;
    // Nothing to animate: the frame that trimmed the last particle already cleared the
    // canvas, so skip the per-frame clearRect while the desk sits idle between bursts.
    if (this.particles.length === 0) return;

    // Clear canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Track live count for efficient dead-particle removal
    let writeIndex = 0;

    // Update and render particles
    // Avoids save()/restore() per particle — just set globalAlpha directly
    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i];

      // Update position
      particle.x += particle.vx;
      particle.y += particle.vy;

      // Apply gravity
      particle.vy += 0.1;

      // Fade out
      particle.life -= 0.02;

      // Skip dead particles
      if (particle.life <= 0) {
        continue;
      }

      // Keep alive particle (compact array in-place)
      this.particles[writeIndex++] = particle;

      // Render particle
      this.ctx.globalAlpha = particle.life;
      this.ctx.fillStyle = particle.color;
      this.ctx.beginPath();
      this.ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      this.ctx.fill();
    }

    // Trim dead particles in one operation
    this.particles.length = writeIndex;

    // Reset alpha
    this.ctx.globalAlpha = 1;
  }

  createTrail(x: number, y: number, color: string): void {
    if (this.particles.length >= this.maxParticles) return;

    this.particles.push({
      x: x + (Math.random() - 0.5) * 5,
      y: y + (Math.random() - 0.5) * 5,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      life: 0.8,
      color,
      size: 1 + Math.random(),
    });
  }

  clear(): void {
    this.particles = [];
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  getParticleCount(): number {
    return this.particles.length;
  }
}
