import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database.js';
import { animals } from '../../infrastructure/database/schema.js';

export type AnimalListItem = {
  id: string;
  slug: string;
  nameRu: string;
  nameEn: string;
};

export type AnimalRepository = {
  listActive(): Promise<AnimalListItem[]>;
};

export function createPostgresAnimalRepository(database: Database): AnimalRepository {
  return {
    listActive() {
      return database.select({
        id: animals.id,
        slug: animals.slug,
        nameRu: animals.nameRu,
        nameEn: animals.nameEn,
      }).from(animals)
        .where(eq(animals.isActive, true))
        .orderBy(asc(animals.slug));
    },
  };
}
