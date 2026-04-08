import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class TransactionItemDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  amount: number;
}

export class IssueTransactionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransactionItemDto)
  transactions: TransactionItemDto[];

  @IsOptional()
  @IsBoolean()
  checkBalance?: boolean;
}
