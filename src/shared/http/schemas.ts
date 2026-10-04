import { z } from 'zod';
import { API_ERROR_CODES, API_FIELD_ERROR_CODES } from './api-error.js';

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    fieldErrors: z.array(z.object({
      field: z.string(),
      code: z.enum(API_FIELD_ERROR_CODES),
    })).optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
    availableAt: z.iso.datetime().optional(),
  }),
  requestId: z.string().min(1),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
