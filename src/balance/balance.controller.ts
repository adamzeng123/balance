import {
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { BalanceService } from './balance.service';
import { IssueTransactionsDto } from './dto/issue-transactions.dto';

@Controller('balance')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  /**
   * POST /balance/transactions
   * Body: { transactions: [{ userId, amount }, ...], checkBalance?: boolean }
   */
  @Post('transactions')
  async issueTransactions(@Body() dto: IssueTransactionsDto) {
    const result = await this.balanceService.issueTransactions(
      dto.transactions,
      { checkBalance: dto.checkBalance },
    );
    return { transactions: result };
  }

  /**
   * GET /balance/:userId
   */
  @Get(':userId')
  async getBalance(@Param('userId') userId: string) {
    return this.balanceService.getBalance(userId);
  }
}
