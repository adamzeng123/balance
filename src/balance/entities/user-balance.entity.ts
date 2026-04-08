import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('user_balances')
export class UserBalance {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  userId: string;

  @Column({ type: 'numeric', precision: 20, scale: 4, default: 0 })
  balance: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
