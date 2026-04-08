import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('balance_transactions')
export class BalanceTransaction {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  userId: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  amount: string;

  @Column({ type: 'numeric', precision: 20, scale: 4 })
  endingBalance: string;

  @CreateDateColumn()
  createdAt: Date;
}
