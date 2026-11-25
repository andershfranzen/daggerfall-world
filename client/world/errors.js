/** Thrown for missing, unreadable or malformed Daggerfall data. loadTown never substitutes generated content. */
export class WorldDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorldDataError';
  }
}
