import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * E2E tests that lock in the two ordering guarantees of BalanceService:
 *
 *   (A) WITHIN a single user, transactions are applied in the original
 *       submission order. Verified via:
 *         - the endingBalance sequence on the response
 *         - checkBalance rejecting an order-dependent batch
 *
 *   (B) ACROSS users / across concurrent callers, the service stays
 *       correct under parallel load: no lost updates, no deadlocks,
 *       and the final stored balance equals the sum of all amounts.
 */
describe('BalanceController (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  // Use unique user IDs per test run so reruns don't collide
  const runId = Date.now().toString();
  const u = (suffix: string) => `${runId}-${suffix}`;

  // Matches any userId produced by this test file across runs:
  // a numeric timestamp prefix followed by `-`, e.g. `1775604838167-order-1`.
  // Used by both startup and teardown cleanup so a crashed prior run can't
  // leave orphan rows in the DB.
  const TEST_USER_ID_PATTERN = '^[0-9]+-';

  async function purgeTestRows(ds: DataSource) {
    // balance_transactions has an FK-free `userId` column too, so order
    // doesn't strictly matter, but children-first is the safe habit.
    await ds.query(
      `DELETE FROM balance_transactions WHERE "userId" ~ $1`,
      [TEST_USER_ID_PATTERN],
    );
    await ds.query(
      `DELETE FROM user_balances WHERE "userId" ~ $1`,
      [TEST_USER_ID_PATTERN],
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);

    // Wipe any leftover rows from a previous broken run so tests start
    // from a known-clean state.
    await purgeTestRows(dataSource);
  });

  afterAll(async () => {
    // Defensive teardown: never let cleanup failures hide the real test
    // result, and never leave the DB dirty for the next run.
    if (dataSource?.isInitialized) {
      try {
        await purgeTestRows(dataSource);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[e2e cleanup] purge failed:', (e as Error).message);
      }
    }
    if (app) {
      try {
        await app.close();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[e2e cleanup] app.close failed:', (e as Error).message);
      }
    }
  });

  // -----------------------------------------------------------------
  // (A) Per-user ordering guarantee
  // -----------------------------------------------------------------
  describe('within-user order is preserved', () => {
    it('endingBalance sequence reflects original submission order', async () => {
      const userId = u('order-1');

      const res = await request(app.getHttpServer())
        .post('/balance/transactions')
        .send({
          transactions: [
            { userId, amount: 100 },
            { userId, amount: -30 },
            { userId, amount: 5 },
            { userId, amount: -25 },
          ],
        })
        .expect(201);

      // Filter to this user's rows in DB-insertion order, which mirrors
      // submission order because the service inserts sequentially.
      const rows = res.body.transactions.filter(
        (t: any) => t.userId === userId,
      );

      expect(rows).toHaveLength(4);
      expect(Number(rows[0].endingBalance)).toBe(100);
      expect(Number(rows[1].endingBalance)).toBe(70);
      expect(Number(rows[2].endingBalance)).toBe(75);
      expect(Number(rows[3].endingBalance)).toBe(50);

      const final = await request(app.getHttpServer())
        .get(`/balance/${userId}`)
        .expect(200);
      expect(Number(final.body.balance)).toBe(50);
    });

    it('checkBalance rejects when an intermediate step would go negative, even if the net would be positive', async () => {
      const userId = u('order-2');

      // Net = +20, but the FIRST step (-30 from a zero balance) is negative.
      // If the service silently reordered into a "safe" sequence, this
      // would pass. It must NOT pass — order is sacred.
      await request(app.getHttpServer())
        .post('/balance/transactions')
        .send({
          checkBalance: true,
          transactions: [
            { userId, amount: -30 },
            { userId, amount: 50 },
          ],
        })
        .expect(400);

      // Nothing should have been written: balance row must not exist
      // (or if it was lazily created, must still be 0).
      const after = await request(app.getHttpServer()).get(
        `/balance/${userId}`,
      );

      if (after.status === 200) {
        expect(Number(after.body.balance)).toBe(0);
      } else {
        expect(after.status).toBe(404);
      }
    });

    it('reverse-ordered batch is accepted because the order it was submitted in is valid', async () => {
      const userId = u('order-3');

      // Same two amounts as above, but submitted in the safe order.
      await request(app.getHttpServer())
        .post('/balance/transactions')
        .send({
          checkBalance: true,
          transactions: [
            { userId, amount: 50 },
            { userId, amount: -30 },
          ],
        })
        .expect(201);

      const final = await request(app.getHttpServer())
        .get(`/balance/${userId}`)
        .expect(200);
      expect(Number(final.body.balance)).toBe(20);
    });
  });

  // -----------------------------------------------------------------
  // (B) Cross-user / concurrency guarantee
  // -----------------------------------------------------------------
  describe('concurrent batches stay correct (no lost updates, no deadlocks)', () => {
    it('100 parallel +1 credits to the same user end at exactly +100', async () => {
      const userId = u('concurrent-1');
      const N = 100;

      const calls = Array.from({ length: N }, () =>
        request(app.getHttpServer())
          .post('/balance/transactions')
          .send({ transactions: [{ userId, amount: 1 }] }),
      );

      const responses = await Promise.all(calls);
      for (const r of responses) {
        expect(r.status).toBe(201);
      }

      const final = await request(app.getHttpServer())
        .get(`/balance/${userId}`)
        .expect(200);
      expect(Number(final.body.balance)).toBe(N);
    });

    it('parallel batches that lock the same two users in opposite orders do not deadlock', async () => {
      // If sorted-lock-acquisition is working, neither order should
      // cause a deadlock — both callers will acquire userA before userB.
      const userA = u('concurrent-A');
      const userB = u('concurrent-B');
      const N = 50;

      const callsAB = Array.from({ length: N }, () =>
        request(app.getHttpServer())
          .post('/balance/transactions')
          .send({
            transactions: [
              { userId: userA, amount: 1 },
              { userId: userB, amount: 1 },
            ],
          }),
      );
      const callsBA = Array.from({ length: N }, () =>
        request(app.getHttpServer())
          .post('/balance/transactions')
          .send({
            transactions: [
              { userId: userB, amount: 1 },
              { userId: userA, amount: 1 },
            ],
          }),
      );

      const responses = await Promise.all([...callsAB, ...callsBA]);
      for (const r of responses) {
        expect(r.status).toBe(201);
      }

      const a = await request(app.getHttpServer())
        .get(`/balance/${userA}`)
        .expect(200);
      const b = await request(app.getHttpServer())
        .get(`/balance/${userB}`)
        .expect(200);

      // Each user got 2 * N credits of +1
      expect(Number(a.body.balance)).toBe(2 * N);
      expect(Number(b.body.balance)).toBe(2 * N);
    });

    it('checkBalance under contention never lets the balance go negative', async () => {
      const userId = u('concurrent-2');

      // Seed with 10
      await request(app.getHttpServer())
        .post('/balance/transactions')
        .send({ transactions: [{ userId, amount: 10 }] })
        .expect(201);

      // Fire 50 concurrent debits of -1 with checkBalance.
      // Only 10 should succeed; the rest must fail with 400.
      const N = 50;
      const calls = Array.from({ length: N }, () =>
        request(app.getHttpServer())
          .post('/balance/transactions')
          .send({
            checkBalance: true,
            transactions: [{ userId, amount: -1 }],
          }),
      );

      const responses = await Promise.all(calls);
      const ok = responses.filter((r) => r.status === 201).length;
      const rejected = responses.filter((r) => r.status === 400).length;

      expect(ok).toBe(10);
      expect(rejected).toBe(N - 10);

      const final = await request(app.getHttpServer())
        .get(`/balance/${userId}`)
        .expect(200);
      expect(Number(final.body.balance)).toBe(0);
    });
  });
});
