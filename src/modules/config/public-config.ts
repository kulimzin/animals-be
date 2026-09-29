export const NOTE_MAX_LENGTH = 200;
export const MAP_RESULT_LIMIT = 2_000;

export type PublicConfig = {
  descriptionsEnabled: boolean;
  noteMaxLength: number;
  mapResultLimit: number;
};

export function createPublicConfig(descriptionsEnabled: boolean): PublicConfig {
  return {
    descriptionsEnabled,
    noteMaxLength: NOTE_MAX_LENGTH,
    mapResultLimit: MAP_RESULT_LIMIT,
  };
}
