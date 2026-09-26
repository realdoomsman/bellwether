import type { ApiError } from '@floor/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Thrown by route handlers; rendered as an `ApiError` body with `status`. */
export class ApiFailure extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: ContentfulStatusCode, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ApiError {
    return this.details ? { error: this.message, code: this.code, details: this.details } : { error: this.message, code: this.code };
  }
}
