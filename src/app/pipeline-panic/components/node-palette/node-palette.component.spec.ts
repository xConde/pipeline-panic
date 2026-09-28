import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NodeStatus, NodeType, PipelineNode } from '../../models/pipeline.model';
import { ConfigChangeEvent, NodePaletteComponent } from './node-palette.component';

function node(type: NodeType, config: Partial<PipelineNode['config']> = {}): PipelineNode {
  return {
    id: `${type}-1`,
    type,
    name: type === NodeType.SecurityScan ? 'Security Scan' : type,
    x: 10,
    y: 10,
    status: NodeStatus.Idle,
    config: {
      cpuRequired: 10,
      memoryRequired: 100,
      timeEstimate: 5,
      failureRate: 0,
      flakiness: 0,
      ...config,
    },
    processingTime: 0,
    cpuUsage: 10,
    memoryUsage: 100,
    inputs: ['before'],
    outputs: ['after'],
    color: '#fff',
    icon: 'STG',
    particles: [],
    executionCount: 0,
    lastStatus: null,
  };
}

describe('NodePaletteComponent', () => {
  let fixture: ComponentFixture<NodePaletteComponent>;
  let component: NodePaletteComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [NodePaletteComponent] }).compileComponents();
    fixture = TestBed.createComponent(NodePaletteComponent);
    component = fixture.componentInstance;
  });

  function render(selected: PipelineNode | null, available: Partial<PipelineNode>[] = []): void {
    fixture.componentRef.setInput('availableNodes', available);
    fixture.componentRef.setInput('selectedNode', selected);
    fixture.componentRef.setInput('isRunning', false);
    fixture.detectChanges();
  }

  it('presents the patch shelf as native buttons', () => {
    const source = node(NodeType.Source);
    render(null, [source]);

    const button = fixture.nativeElement.querySelector('.node-item') as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toContain('source');
    expect(button.disabled).toBeFalse();
  });

  it('emits the chosen stage and marks tap-to-place selection', () => {
    const source = node(NodeType.Source);
    fixture.componentRef.setInput('selectedForPlacement', NodeType.Source);
    const chosen: NodeType[] = [];
    component.nodeTap.subscribe((type) => chosen.push(type));
    render(null, [source]);

    const button = fixture.nativeElement.querySelector('.node-item') as HTMLButtonElement;
    button.click();
    expect(chosen).toEqual([NodeType.Source]);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('disables mutation when the patch bay is read-only', () => {
    fixture.componentRef.setInput('readOnly', true);
    render(null, [node(NodeType.Build)]);

    expect((fixture.nativeElement.querySelector('.node-item') as HTMLButtonElement).disabled).toBeTrue();
  });

  it('shows only causal route facts for a selected stage', () => {
    render(node(NodeType.Build, { optimizationLevel: 'balanced' }));
    const text = fixture.nativeElement.textContent ?? '';

    expect(text).toContain('Inputs');
    expect(text).toContain('Outputs');
    expect(text).toContain('Build pass');
    expect(text).not.toContain('CPU');
    expect(text).not.toContain('Memory');
    expect(text).not.toContain('Failure rate');
  });

  [
    { type: NodeType.Build, selector: '#build-optimization', value: 'fast', field: 'optimizationLevel' },
    { type: NodeType.Test, selector: '#test-evidence', value: '90', field: 'coverageThreshold' },
    { type: NodeType.Deploy, selector: '#deploy-strategy', value: 'canary', field: 'strategy' },
  ].forEach(({ type, selector, value, field }) => {
    it(`emits the ${field} lever from the selected ${type} stage`, () => {
      const changes: ConfigChangeEvent[] = [];
      component.configChange.subscribe((change) => changes.push(change));
      render(node(type));

      const select = fixture.nativeElement.querySelector(selector) as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event('change'));

      expect(changes.length).toBe(1);
      expect(changes[0].field).toBe(field);
      expect(String(changes[0].value)).toBe(value);
    });
  });
});
