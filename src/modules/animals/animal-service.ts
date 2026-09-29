import type { AnimalRepository } from './animal-repository.js';

export type AnimalService = ReturnType<typeof createAnimalService>;

export function createAnimalService(repository: AnimalRepository) {
  return {
    listAvailableAnimals() {
      return repository.listActive();
    },
  };
}
