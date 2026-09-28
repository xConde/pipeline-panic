import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import {
  CoverageThreshold,
  DeployStrategy,
  NodeType,
  OptimizationLevel,
  PipelineNode,
} from '../../models/pipeline.model';
import { getIconSvg } from '../../utils/icons';

export interface ConfigChangeEvent {
  readonly field: string;
  readonly value: string | number | boolean;
}

@Component({
  selector: 'app-node-palette',
  templateUrl: './node-palette.component.html',
  styleUrls: ['./node-palette.component.scss'],
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NodePaletteComponent {
  readonly availableNodes = input.required<Partial<PipelineNode>[]>();
  readonly selectedNode = input.required<PipelineNode | null>();
  readonly isRunning = input.required<boolean>();
  readonly readOnly = input<boolean>(false);
  /** NodeType currently queued for tap-to-place (null = none pending). */
  readonly selectedForPlacement = input<NodeType | null>(null);

  readonly nodeDragStart = output<{ event: DragEvent; node: Partial<PipelineNode> }>();
  /** Emitted on a tap/click of an unlocked palette item — carries the NodeType. */
  readonly nodeTap = output<NodeType>();
  readonly closeDetail = output<void>();
  readonly deleteNode = output<void>();
  readonly configChange = output<ConfigChangeEvent>();

  readonly coverageOptions: CoverageThreshold[] = [50, 75, 90, 100];
  readonly optimizationOptions: OptimizationLevel[] = ['fast', 'balanced', 'thorough'];
  readonly strategyOptions: DeployStrategy[] = ['rolling', 'blue-green', 'canary'];

  constructor(private sanitizer: DomSanitizer) {}

  onNodeDragStart(event: DragEvent, node: Partial<PipelineNode>): void {
    if (this.readOnly()) return;
    this.nodeDragStart.emit({ event, node });
  }

  isNodeInteractive(node: Partial<PipelineNode>): boolean {
    return !!node.type && !this.readOnly() && !this.isRunning();
  }

  onNodeTap(node: Partial<PipelineNode>): void {
    const type = node.type;
    if (!type || !this.isNodeInteractive(node)) return;
    this.nodeTap.emit(type);
  }

  getIcon(iconName: 'trash', size = 16): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(getIconSvg(iconName, size, size));
  }

  onCoverageChange(event: Event): void {
    const value = parseInt((event.target as HTMLSelectElement).value, 10) as CoverageThreshold;
    this.configChange.emit({ field: 'coverageThreshold', value });
  }

  onOptimizationChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as OptimizationLevel;
    this.configChange.emit({ field: 'optimizationLevel', value });
  }

  onStrategyChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as DeployStrategy;
    this.configChange.emit({ field: 'strategy', value });
  }
}
