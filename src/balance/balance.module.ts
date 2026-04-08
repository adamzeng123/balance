import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceController } from './balance.controller';
import { BalanceService } from './balance.service';
import { UserBalance } from './entities/user-balance.entity';
import { BalanceTransaction } from './entities/balance-transaction.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UserBalance, BalanceTransaction])],
  controllers: [BalanceController],
  providers: [BalanceService],
  exports: [BalanceService],
})
export class BalanceModule {}
