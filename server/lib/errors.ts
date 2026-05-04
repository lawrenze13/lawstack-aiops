// Tiny app-error hierarchy so route handlers can throw and a wrapper maps to
// JSON responses. Each subclass has a stable HTTP status.
export class AppError extends Error {
  status = 500;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = this.constructor.name;
  }
}

export class BadRequest extends AppError {
  override status = 400;
}
export class Unauthorized extends AppError {
  override status = 401;
}
export class Forbidden extends AppError {
  override status = 403;
}
export class NotFound extends AppError {
  override status = 404;
}
export class Conflict extends AppError {
  override status = 409;
}
export class TooManyRequests extends AppError {
  override status = 429;
  retryAfterSec?: number;
  constructor(message: string, opts?: { cause?: unknown; retryAfterSec?: number }) {
    super(message, opts);
    if (opts?.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
  }
}

/**
 * Conflict variant for the preview-dev "dirty working tree" case. Carries
 * a `dirtyCount` so the client modal can render "Discard N changes and
 * switch?" without leaking file PATHS (those stay in the audit row only —
 * see security review H3 for why).
 */
export class DirtyTreeConflict extends Conflict {
  dirtyCount: number;
  constructor(message: string, dirtyCount: number, opts?: { cause?: unknown }) {
    super(message, opts);
    this.dirtyCount = dirtyCount;
  }
}
