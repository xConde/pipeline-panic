import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { getIconSvg } from '../../utils/icons';

@Component({
  selector: 'app-pipeline-toolbar',
  templateUrl: './pipeline-toolbar.component.html',
  styleUrls: ['./pipeline-toolbar.component.scss'],
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PipelineToolbarComponent {
  readonly isRunning = input.required<boolean>();
  readonly hasSelection = input.required<boolean>();
  readonly canUndo = input<boolean>(false);
  readonly canRedo = input<boolean>(false);
  readonly readOnly = input<boolean>(false);
  readonly connectModeActive = input<boolean>(false);

  readonly stopClick = output<void>();
  readonly restoreClick = output<void>();
  readonly deleteClick = output<void>();
  readonly undoClick = output<void>();
  readonly redoClick = output<void>();
  readonly connectModeToggle = output<void>();

  constructor(private sanitizer: DomSanitizer) {}

  getIcon(iconName: 'stop' | 'arrowsClockwise' | 'trash' | 'undo' | 'redo', size = 16): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(getIconSvg(iconName, size, size));
  }
}
