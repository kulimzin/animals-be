import { readFile, writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import type { AnimalService } from '../src/modules/animals/animal-service.js';
import type { ClientService } from '../src/modules/clients/client-service.js';
import type { ObservationService } from '../src/modules/observations/observation-service.js';

const animalService: AnimalService = {
  listAvailableAnimals: () => Promise.resolve([]),
};

const clientService: ClientService = {
  issueClient: () => Promise.resolve({ status: 'issued', token: '' }),
  authenticateToken: () => Promise.resolve(undefined),
};

const observationService: ObservationService = {
  create: () => Promise.reject(new Error('OpenAPI export does not execute routes')),
  getDetails: () => Promise.reject(new Error('OpenAPI export does not execute routes')),
  vote: () => Promise.reject(new Error('OpenAPI export does not execute routes')),
  list: () => Promise.resolve({ observations: [], truncated: false, limit: 2000 }),
};

const app = buildApp({ animalService, clientService, observationService });

try {
  await app.ready();
  const openApi = app.swagger();
  const outputUrl = new URL('../openapi.json', import.meta.url);
  const output = `${JSON.stringify(openApi, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const existing = await readFile(outputUrl, 'utf8');
    if (existing !== output) throw new Error('openapi.json is outdated; run npm run openapi:export');
  } else {
    await writeFile(outputUrl, output);
  }
} finally {
  await app.close();
}
