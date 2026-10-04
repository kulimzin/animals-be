export const API_ERROR_CODES = [
  'CLIENT_TOKEN_INVALID',
  'CLIENT_TOKEN_REQUIRED',
  'DESCRIPTION_DISABLED',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_RESULT_GONE',
  'INTERNAL_ERROR',
  'NOT_FOUND',
  'OBSERVATION_NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'REQUEST_INVALID',
  'SERVICE_UNAVAILABLE',
  'TEXT_CONTENT_REJECTED',
  'VALIDATION_ERROR',
] as const;

export type ApiErrorCode = typeof API_ERROR_CODES[number];

export const API_FIELD_ERROR_CODES = [
  'ANIMAL_NOT_AVAILABLE',
  'INVALID_VALUE',
  'MAX_LENGTH_EXCEEDED',
  'OUT_OF_RANGE',
] as const;

export type ApiFieldErrorCode = typeof API_FIELD_ERROR_CODES[number];

export type ApiFieldError = {
  field: string;
  code: ApiFieldErrorCode;
};

export type ApiErrorRateLimit = {
  retryAfterSeconds: number;
  availableAt: Date;
};

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly fieldErrors?: ApiFieldError[],
    readonly rateLimit?: ApiErrorRateLimit,
  ) {
    super(message);
  }
}
