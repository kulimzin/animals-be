import { and, count, desc, eq, gt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../infrastructure/database.js';
import { clientIssuanceEvents, clients } from '../../infrastructure/database/schema.js';

export const CLIENT_ISSUANCE_LIMIT = 10;
export const CLIENT_ISSUANCE_WINDOW_MS = 10 * 60 * 1000;
export const CLIENT_ISSUANCE_BLOCK_MS = 60 * 60 * 1000;

export type ClientIssuanceResult =
  | { status: 'issued' }
  | { status: 'rate-limited'; retryAfterSeconds: number };

export type ClientRepository = {
  issueClient(ipHash: string, tokenHash: string): Promise<ClientIssuanceResult>;
  findClientIdByTokenHash(tokenHash: string): Promise<string | undefined>;
};

export function createPostgresClientRepository(database: Database): ClientRepository {
  return {
    async issueClient(ipHash, tokenHash) {
      return database.transaction(async (transaction) => {
        // Serializing one hashed address prevents parallel requests bypassing the limit.
        await transaction.execute(sql`
          select pg_advisory_xact_lock(hashtextextended(${ipHash}, 0))
        `);

        const databaseTime = await transaction.execute<{ now: string }>(
          sql`select clock_timestamp() as now`,
        );
        const now = new Date(databaseTime.rows[0]?.now ?? Number.NaN);
        if (Number.isNaN(now.getTime())) throw new Error('Database did not return its current time');

        await transaction.delete(clientIssuanceEvents).where(and(
          eq(clientIssuanceEvents.ipHash, ipHash),
          lte(clientIssuanceEvents.expiresAt, now),
        ));

        const [activeBlock] = await transaction.select({
          retryAt: clientIssuanceEvents.expiresAt,
        }).from(clientIssuanceEvents).where(and(
          eq(clientIssuanceEvents.ipHash, ipHash),
          eq(clientIssuanceEvents.wasIssued, false),
          gt(clientIssuanceEvents.expiresAt, now),
        )).orderBy(desc(clientIssuanceEvents.expiresAt)).limit(1);

        if (activeBlock) {
          return {
            status: 'rate-limited',
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((activeBlock.retryAt.getTime() - now.getTime()) / 1000),
            ),
          };
        }

        const [issuanceCount] = await transaction.select({ value: count() })
          .from(clientIssuanceEvents)
          .where(and(
            eq(clientIssuanceEvents.ipHash, ipHash),
            eq(clientIssuanceEvents.wasIssued, true),
            gt(clientIssuanceEvents.expiresAt, now),
          ));

        if ((issuanceCount?.value ?? 0) >= CLIENT_ISSUANCE_LIMIT) {
          const retryAt = new Date(now.getTime() + CLIENT_ISSUANCE_BLOCK_MS);
          await transaction.insert(clientIssuanceEvents).values({
            ipHash,
            wasIssued: false,
            createdAt: now,
            expiresAt: retryAt,
          });
          return {
            status: 'rate-limited',
            retryAfterSeconds: CLIENT_ISSUANCE_BLOCK_MS / 1000,
          };
        }

        await transaction.insert(clients).values({ tokenHash });
        await transaction.insert(clientIssuanceEvents).values({
          ipHash,
          wasIssued: true,
          createdAt: now,
          expiresAt: new Date(now.getTime() + CLIENT_ISSUANCE_WINDOW_MS),
        });
        return { status: 'issued' };
      });
    },

    async findClientIdByTokenHash(tokenHash) {
      const [client] = await database.select({ id: clients.id })
        .from(clients)
        .where(eq(clients.tokenHash, tokenHash))
        .limit(1);
      return client?.id;
    },
  };
}
