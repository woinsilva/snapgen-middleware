export class SnapGenError extends Error {
  constructor(
    public readonly status: number,
    public readonly details: unknown,
    message = 'SnapGen request failed',
  ) {
    super(message);
    this.name = 'SnapGenError';
  }
}
