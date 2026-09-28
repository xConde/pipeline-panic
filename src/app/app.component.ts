import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: '<main class="app-shell"><router-outlet /></main>',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.day-mode]': 'isDayMode()',
    '[class.night-mode]': '!isDayMode()',
  },
})
export class AppComponent {
  readonly isDayMode = toSignal(inject(ThemeService).isDayMode$, { initialValue: false });
}
