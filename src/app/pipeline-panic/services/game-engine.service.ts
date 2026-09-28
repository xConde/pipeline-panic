import { Injectable } from '@angular/core';
import { Level } from '../models/game-state.model';
import { createReleaseDesk } from '../data/release-desk.data';

@Injectable()
export class GameEngineService {
  loadLevels(): Level[] {
    return [createReleaseDesk()];
  }
}
