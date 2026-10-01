import { z } from 'zod';
import { API_ERROR_CODES } from './api-error.js';

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    details: z.array(z.object({
      path: z.string(),
      message: z.string(),
    })).optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
    availableAt: z.iso.datetime().optional(),
  }),
  requestId: z.string().min(1),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export function successResponseSchema<T extends z.ZodType>(data: T) {
  return z.object({ data });
}
