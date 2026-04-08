import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UserBalance } from './entities/user-balance.entity';
import { BalanceTransaction } from './entities/balance-transaction.entity';
import { TransactionItemDto } from './dto/issue-transactions.dto';

export interface IssueTransactionsOptions {
  checkBalance?: boolean;
}

@Injectable()
export class BalanceService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Issue a batch of transactions atomically and concurrency-safely.
   *
   * Concurrency strategy:
   *   1. Wrap everything in a single SERIALIZABLE-friendly DB transaction.
   *   2. Group transactions by userId, then iterate users in a deterministic
   *      (sorted) order so concurrent callers acquire row locks in the same
   *      order — this avoids deadlocks.
   *   3. For each user, take a row-level write lock with `SELECT ... FOR UPDATE`
   *      (pessimistic_write). Other transactions touching the same row block
   *      until we commit.
   *   4. Apply each amount in order, recording endingBalance per row.
   *   5. If `checkBalance` is true, abort the whole batch when any intermediate
   *      balance would go negative.
   */
  async issueTransactions(
    items: TransactionItemDto[],
    options: IssueTransactionsOptions = {},
  ): Promise<BalanceTransaction[]> {
    if (!items || items.length === 0) {
      throw new BadRequestException('No transactions provided');
    }

    const { checkBalance = false } = options;

    // Group by userId, preserving original order within each user
    const grouped = new Map<string, TransactionItemDto[]>();
    for (const item of items) {
      const key = String(item.userId);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(item);
    }

    // Sorted user ids → deterministic lock order → no deadlocks
    const sortedUserIds = Array.from(grouped.keys()).sort();

    return this.dataSource.transaction(async (manager) => {
      const created: BalanceTransaction[] = [];

      for (const userId of sortedUserIds) {
        // Acquire row lock; create the row if it doesn't exist yet.
        let userBalance = await manager
          .getRepository(UserBalance)
          .createQueryBuilder('ub')
          .setLock('pessimistic_write')
          .where('ub.userId = :userId', { userId })
          .getOne();

        if (!userBalance) {
          // Insert with ON CONFLICT DO NOTHING to be safe under races,
          // then re-select with the lock.
          await manager
            .createQueryBuilder()
            .insert()
            .into(UserBalance)
            .values({ userId, balance: '0' })
            .orIgnore()
            .execute();

          userBalance = await manager
            .getRepository(UserBalance)
            .createQueryBuilder('ub')
            .setLock('pessimistic_write')
            .where('ub.userId = :userId', { userId })
            .getOne();

          if (!userBalance) {
            throw new Error(
              `Failed to initialize balance row for user ${userId}`,
            );
          }
        }

        let running = Number(userBalance.balance);

        for (const item of grouped.get(userId)!) {
          const amount = Number(item.amount);
          const next = round4(running + amount);

          if (checkBalance && next < 0) {
            throw new BadRequestException(
              `Insufficient balance for user ${userId}: ` +
                `current=${running}, amount=${amount}`,
            );
          }

          const tx = manager.getRepository(BalanceTransaction).create({
            userId,
            amount: amount.toString(),
            endingBalance: next.toString(),
          });
          const saved = await manager
            .getRepository(BalanceTransaction)
            .save(tx);
          created.push(saved);

          running = next;
        }

        userBalance.balance = running.toString();
        await manager.getRepository(UserBalance).save(userBalance);
      }

      return created;
    });
  }

  async getBalance(userId: string): Promise<{ userId: string; balance: string }> {
    const row = await this.dataSource
      .getRepository(UserBalance)
      .findOne({ where: { userId } });

    if (!row) {
      throw new NotFoundException(`User ${userId} has no balance record`);
    }
    return { userId: row.userId, balance: row.balance };
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
