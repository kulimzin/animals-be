import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const app = buildApp();
afterEach(async () => { await app.close(); });

describe('application foundation', () => {
  it('starts the HTTP pipeline without opening a port or requiring a database', async () => {
    const response = await app.inject({ method: 'GET', url: '/observations' });
    expect(response.statusCode).toBe(404);
  });
});
