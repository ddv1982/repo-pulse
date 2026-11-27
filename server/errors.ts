/**
 * What went wrong, in terms the HTTP layer maps to a status. Modules throw an AppError when a failure has an answer
 * the reader should see; any other error is unexpected, and the HTTP layer answers it with a generic 500.
 */
export type ErrorKind =
  | 'invalid'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'method-not-allowed'
  | 'conflict'
  | 'too-large'
  | 'unsupported-media'
  | 'corrupt'
  | 'upstream';

export class AppError extends Error {
  readonly kind: ErrorKind;
  /** A stable identifier the browser may act on, sent with the message. */
  readonly code: string | undefined;

  constructor(kind: ErrorKind, message: string, code?: string) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

export const isAppError = (error: unknown, kind?: ErrorKind): error is AppError =>
  error instanceof AppError && (kind === undefined || error.kind === kind);

export const invalid = (message: string, code?: string) => new AppError('invalid', message, code);
export const forbidden = (message: string, code?: string) => new AppError('forbidden', message, code);
export const notFound = (message: string, code?: string) => new AppError('not-found', message, code);
export const conflict = (message: string, code?: string) => new AppError('conflict', message, code);
/** The one refusal for anything demo mode cannot do, with what the reader should know instead. */
export const notInDemo = (message: string) => new AppError('forbidden', message, 'NOT_IN_DEMO');
