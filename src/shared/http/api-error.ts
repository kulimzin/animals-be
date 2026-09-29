export const API_ERROR_CODES = [
  'ANIMAL_NOT_AVAILABLE',
  'CLIENT_ISSUANCE_RATE_LIMITED',
  'CLIENT_TOKEN_INVALID',
  'CLIENT_TOKEN_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'INTERNAL_ERROR',
  'NOT_FOUND',
  'REQUEST_INVALID',
  'VALIDATION_ERROR',
] as const;

export type ApiErrorCode = typeof API_ERROR_CODES[number];

export type ApiErrorDetail = {
  path: string;
  message: string;
};

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message);
  }
}
