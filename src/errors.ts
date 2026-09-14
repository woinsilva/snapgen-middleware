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

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
