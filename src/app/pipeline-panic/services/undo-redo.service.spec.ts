import { TestBed } from '@angular/core/testing';
import { UndoRedoService } from './undo-redo.service';
import { PipelineCommand } from '../models/command.model';

describe('UndoRedoService', () => {
  let service: UndoRedoService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [UndoRedoService],
    });
    service = TestBed.inject(UndoRedoService);
  });

  function createMockCommand(executeFn?: () => void, undoFn?: () => void, type = 'test'): PipelineCommand {
    return {
      type,
      execute: executeFn ?? (() => {}),
      undo: undoFn ?? (() => {}),
    };
  }

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should have canUndo and canRedo both false initially', () => {
    expect(service.canUndo).toBe(false);
    expect(service.canRedo).toBe(false);
    expect(service.undoCount).toBe(0);
    expect(service.redoCount).toBe(0);
  });

  it('should push command to undo stack on execute', () => {
    const cmd = createMockCommand();
    service.execute(cmd);

    expect(service.canUndo).toBe(true);
    expect(service.canRedo).toBe(false);
    expect(service.undoCount).toBe(1);
  });

  it('should call command.execute() on execute', () => {
    const executeSpy = jasmine.createSpy('execute');
    const cmd = createMockCommand(executeSpy);

    service.execute(cmd);
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it('should clear redo stack on execute', () => {
    // Build up a redo state
    service.execute(createMockCommand());
    service.undo();
    expect(service.canRedo).toBe(true);

    // New command should clear redo
    service.execute(createMockCommand());
    expect(service.canRedo).toBe(false);
    expect(service.redoCount).toBe(0);
  });

  it('should call command.undo() and push to redo stack on undo', () => {
    const undoSpy = jasmine.createSpy('undo');
    const cmd = createMockCommand(undefined, undoSpy);

    service.execute(cmd);
    service.undo();

    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(service.canUndo).toBe(false);
    expect(service.canRedo).toBe(true);
    expect(service.redoCount).toBe(1);
  });

  it('should call command.execute() and push to undo stack on redo', () => {
    let value = 0;
    const cmd = createMockCommand(
      () => {
        value = 1;
      },
      () => {
        value = 0;
      }
    );

    service.execute(cmd);
    expect(value).toBe(1);

    service.undo();
    expect(value).toBe(0);

    service.redo();
    expect(value).toBe(1);
    expect(service.canUndo).toBe(true);
    expect(service.canRedo).toBe(false);
  });

  it('should do nothing when undo is called with empty stack', () => {
    expect(service.canUndo).toBe(false);
    service.undo(); // Should not throw
    expect(service.canUndo).toBe(false);
    expect(service.canRedo).toBe(false);
  });

  it('should do nothing when redo is called with empty stack', () => {
    expect(service.canRedo).toBe(false);
    service.redo(); // Should not throw
    expect(service.canUndo).toBe(false);
    expect(service.canRedo).toBe(false);
  });

  it('should enforce max stack size by dropping oldest command', () => {
    // Push 55 commands — should cap at 50
    for (let i = 0; i < 55; i++) {
      service.execute(createMockCommand());
    }
    expect(service.undoCount).toBe(50);
  });

  it('should clear both stacks on clear()', () => {
    service.execute(createMockCommand());
    service.execute(createMockCommand());
    service.undo();

    expect(service.canUndo).toBe(true);
    expect(service.canRedo).toBe(true);

    service.clear();

    expect(service.canUndo).toBe(false);
    expect(service.canRedo).toBe(false);
    expect(service.undoCount).toBe(0);
    expect(service.redoCount).toBe(0);
  });

  it('should support multiple undo/redo round-trips correctly', () => {
    const values: number[] = [];
    const commands: PipelineCommand[] = [];

    for (let i = 0; i < 5; i++) {
      const val = i;
      commands.push(
        createMockCommand(
          () => {
            values.push(val);
          },
          () => {
            values.pop();
          }
        )
      );
    }

    // Execute all 5
    commands.forEach((cmd) => service.execute(cmd));
    expect(values).toEqual([0, 1, 2, 3, 4]);
    expect(service.undoCount).toBe(5);
    expect(service.redoCount).toBe(0);

    // Undo 3
    service.undo();
    service.undo();
    service.undo();
    expect(values).toEqual([0, 1]);
    expect(service.undoCount).toBe(2);
    expect(service.redoCount).toBe(3);

    // Redo 2
    service.redo();
    service.redo();
    expect(values).toEqual([0, 1, 2, 3]);
    expect(service.undoCount).toBe(4);
    expect(service.redoCount).toBe(1);

    // Undo all
    service.undo();
    service.undo();
    service.undo();
    service.undo();
    expect(values).toEqual([]);
    expect(service.undoCount).toBe(0);
    expect(service.redoCount).toBe(5);

    // Redo all
    service.redo();
    service.redo();
    service.redo();
    service.redo();
    service.redo();
    expect(values).toEqual([0, 1, 2, 3, 4]);
    expect(service.undoCount).toBe(5);
    expect(service.redoCount).toBe(0);
  });

  it('should invalidate redo stack when new command is executed after undo', () => {
    const values: number[] = [];

    service.execute(
      createMockCommand(
        () => {
          values.push(1);
        },
        () => {
          values.pop();
        }
      )
    );
    service.execute(
      createMockCommand(
        () => {
          values.push(2);
        },
        () => {
          values.pop();
        }
      )
    );

    // Undo one
    service.undo();
    expect(values).toEqual([1]);
    expect(service.redoCount).toBe(1);

    // Execute a new command — redo should be cleared
    service.execute(
      createMockCommand(
        () => {
          values.push(99);
        },
        () => {
          values.pop();
        }
      )
    );
    expect(values).toEqual([1, 99]);
    expect(service.redoCount).toBe(0);

    // Redo should do nothing
    service.redo();
    expect(values).toEqual([1, 99]);
  });
});
