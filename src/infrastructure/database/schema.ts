import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export type Point = { longitude: number; latitude: number };

const geometryPoint4326 = customType<{ data: Point; driverData: string }>({
  dataType: () => 'geometry(Point,4326)',
  toDriver: ({ longitude, latitude }) => `SRID=4326;POINT(${longitude} ${latitude})`,
  fromDriver: (value) => {
    const bytes = Buffer.from(value, 'hex');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const isLittleEndian = view.getUint8(0) === 1;
    const geometryType = view.getUint32(1, isLittleEndian);
    const hasSrid = (geometryType & 0x20000000) !== 0;
    const coordinateOffset = hasSrid ? 9 : 5;
    if ((geometryType & 0xffff) !== 1 || bytes.byteLength < coordinateOffset + 16) {
      throw new Error('Database returned an unsupported geometry value');
    }
    return {
      longitude: view.getFloat64(coordinateOffset, isLittleEndian),
      latitude: view.getFloat64(coordinateOffset + 8, isLittleEndian),
    };
  },
});

export const animals = pgTable('animals', {
  id: uuid().defaultRandom().primaryKey(),
  slug: text().notNull(),
  nameRu: text('name_ru').notNull(),
  nameEn: text('name_en').notNull(),
  icon: text().notNull(),
}, (table) => [
  uniqueIndex('animals_slug_unique').on(table.slug),
  check('animals_slug_not_blank', sql`length(btrim(${table.slug})) > 0`),
  check('animals_name_ru_not_blank', sql`length(btrim(${table.nameRu})) > 0`),
  check('animals_name_en_not_blank', sql`length(btrim(${table.nameEn})) > 0`),
  check('animals_icon_not_blank', sql`length(btrim(${table.icon})) > 0`),
]);

export const clients = pgTable('clients', {
  id: uuid().defaultRandom().primaryKey(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('clients_token_hash_unique').on(table.tokenHash),
  check('clients_token_hash_sha256', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
]);

export const observations = pgTable('observations', {
  id: uuid().defaultRandom().primaryKey(),
  animalId: uuid('animal_id').notNull().references(() => animals.id, { onDelete: 'restrict' }),
  clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  location: geometryPoint4326().notNull(),
  locationLabel: varchar('location_label', { length: 300 }),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  note: varchar({ length: 200 }),
}, (table) => [
  index('observations_location_gist').using('gist', table.location),
  index('observations_animal_observed_at_idx').on(table.animalId, table.observedAt),
  index('observations_observed_at_idx').on(table.observedAt),
  check('observations_location_not_empty', sql`NOT ST_IsEmpty(${table.location})`),
  check('observations_longitude_range', sql`ST_X(${table.location}) BETWEEN -180 AND 180`),
  check('observations_latitude_range', sql`ST_Y(${table.location}) BETWEEN -90 AND 90`),
  check('observations_time_range', sql`
    ${table.observedAt} <= ${table.createdAt}
    AND ${table.observedAt} > ${table.createdAt} - interval '30 days'
  `),
  check('observations_location_label_not_blank', sql`
    ${table.locationLabel} IS NULL OR length(btrim(${table.locationLabel})) > 0
  `),
  check('observations_note_not_blank', sql`${table.note} IS NULL OR length(btrim(${table.note})) > 0`),
]);

export const voteValue = pgEnum('vote_value', ['confirm', 'reject']);

export const votes = pgTable('votes', {
  observationId: uuid('observation_id').notNull().references(() => observations.id, { onDelete: 'cascade' }),
  clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  value: voteValue().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'votes_observation_client_pk', columns: [table.observationId, table.clientId] }),
  index('votes_client_id_idx').on(table.clientId),
]);

export const observationIdempotency = pgTable('observation_idempotency', {
  clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  idempotencyKey: uuid('idempotency_key').notNull(),
  requestHash: varchar('request_hash', { length: 64 }).notNull(),
  observationId: uuid('observation_id').references(() => observations.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({
    name: 'observation_idempotency_client_key_pk',
    columns: [table.clientId, table.idempotencyKey],
  }),
  index('observation_idempotency_expires_at_idx').on(table.expiresAt),
  check('observation_idempotency_request_hash_sha256', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  check('observation_idempotency_expiry', sql`${table.expiresAt} = ${table.createdAt} + interval '24 hours'`),
]);

export const publicationEvents = pgTable('publication_events', {
  id: uuid().defaultRandom().primaryKey(),
  clientId: uuid('client_id').notNull().references(() => clients.id, { onDelete: 'restrict' }),
  publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('publication_events_client_published_at_idx').on(table.clientId, table.publishedAt),
  index('publication_events_published_at_idx').on(table.publishedAt),
]);

export const clientIssuanceEvents = pgTable('client_issuance_events', {
  id: uuid().defaultRandom().primaryKey(),
  ipHash: varchar('ip_hash', { length: 64 }).notNull(),
  browserFamily: varchar('browser_family', { length: 100 }),
  osFamily: varchar('os_family', { length: 100 }),
  language: varchar({ length: 50 }),
  wasIssued: boolean('was_issued').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  index('client_issuance_events_ip_created_at_idx').on(table.ipHash, table.createdAt),
  index('client_issuance_events_expires_at_idx').on(table.expiresAt),
  check('client_issuance_events_ip_hash_sha256', sql`${table.ipHash} ~ '^[0-9a-f]{64}$'`),
  check('client_issuance_events_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
]);

export const animalsRelations = relations(animals, ({ many }) => ({ observations: many(observations) }));

export const clientsRelations = relations(clients, ({ many }) => ({
  observations: many(observations),
  votes: many(votes),
  idempotencyRecords: many(observationIdempotency),
  publicationEvents: many(publicationEvents),
}));

export const observationsRelations = relations(observations, ({ one, many }) => ({
  animal: one(animals, { fields: [observations.animalId], references: [animals.id] }),
  client: one(clients, { fields: [observations.clientId], references: [clients.id] }),
  votes: many(votes),
  idempotencyRecords: many(observationIdempotency),
}));

export const votesRelations = relations(votes, ({ one }) => ({
  observation: one(observations, { fields: [votes.observationId], references: [observations.id] }),
  client: one(clients, { fields: [votes.clientId], references: [clients.id] }),
}));

export const observationIdempotencyRelations = relations(observationIdempotency, ({ one }) => ({
  client: one(clients, { fields: [observationIdempotency.clientId], references: [clients.id] }),
  observation: one(observations, {
    fields: [observationIdempotency.observationId],
    references: [observations.id],
  }),
}));

export const publicationEventsRelations = relations(publicationEvents, ({ one }) => ({
  client: one(clients, { fields: [publicationEvents.clientId], references: [clients.id] }),
}));
