import { inject, Injectable, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject } from 'rxjs';

const THEME_STORAGE_KEY = 'pipeline-panic-theme-preference';

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  // PLATFORM_ID guard: localStorage and matchMedia are browser-only.
  // Server-side prerender always returns night mode (false) — no stored
  // preference is available during static HTML generation.
  private readonly platformId = inject(PLATFORM_ID);

  private isDayModeSubject = new BehaviorSubject<boolean>(this.getInitialTheme());
  isDayMode$ = this.isDayModeSubject.asObservable();

  get isDayMode(): boolean {
    return this.isDayModeSubject.value;
  }

  toggleDayMode(): void {
    const newMode = !this.isDayModeSubject.value;
    this.isDayModeSubject.next(newMode);
    this.saveThemePreference(newMode);
  }

  /**
   * Determines initial theme:
   * 1. Check localStorage for saved preference (browser only)
   * 2. Fall back to system preference (prefers-color-scheme)
   * 3. Default to night mode (false) — always used during SSR/prerender
   */
  private getInitialTheme(): boolean {
    if (!isPlatformBrowser(this.platformId)) {
      return false;
    }

    // Check localStorage first
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved !== null) {
      return saved === 'day';
    }

    // Fall back to system preference
    if (window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: light)').matches;
    }

    // Default to night mode
    return false;
  }

  private saveThemePreference(isDayMode: boolean): void {
    if (!isPlatformBrowser(this.platformId)) return;
    localStorage.setItem(THEME_STORAGE_KEY, isDayMode ? 'day' : 'night');
  }
}
