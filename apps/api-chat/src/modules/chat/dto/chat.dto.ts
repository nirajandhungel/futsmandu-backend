import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  Max,
  IsNotEmpty,
  MaxLength,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum ChatUserRole {
  PLAYER = 'PLAYER',
  OWNER = 'OWNER',
}

export enum ChatType {
  DIRECT = 'DIRECT',
  GROUP = 'GROUP',
}

export enum MessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  SYSTEM = 'SYSTEM',
}

// ── Shared ────────────────────────────────────────────────────────────────────

export class ParticipantDto {
  @ApiProperty({ example: 'uuid-of-user' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: ChatUserRole })
  @IsEnum(ChatUserRole)
  role!: ChatUserRole;
}

// ── REST DTOs ─────────────────────────────────────────────────────────────────

export class CreateDirectChatDto {
  @ApiProperty({ description: 'The other participant (Player or Owner)' })
  @ValidateNested()
  @Type(() => ParticipantDto)
  participant!: ParticipantDto;

  @ApiPropertyOptional({ description: 'Optionally link to a booking' })
  @IsUUID()
  @IsOptional()
  bookingId?: string;
}

export class CreateGroupChatDto {
  @ApiProperty({ example: 'Team Alpha Chat' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    type: [ParticipantDto],
    description: 'Must include at least 2 participants (creator not counted)',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParticipantDto)
  @ArrayMinSize(2)
  participants!: ParticipantDto[];

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  bookingId?: string;
}

export class AddParticipantDto {
  @ApiProperty()
  @ValidateNested()
  @Type(() => ParticipantDto)
  participant!: ParticipantDto;
}

export class RemoveParticipantDto {
  @ApiProperty()
  @ValidateNested()
  @Type(() => ParticipantDto)
  participant!: ParticipantDto;
}

export class GetMessagesQueryDto {
  @ApiPropertyOptional({ description: 'Cursor-based pagination: last message ID' })
  @IsUUID()
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;
}

// ── WebSocket Event Payloads ──────────────────────────────────────────────────

export class WsSendMessageDto {
  @IsUUID()
  chatId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  content!: string;

  @IsEnum(MessageType)
  @IsOptional()
  type?: MessageType = MessageType.TEXT;
}

export class WsJoinChatDto {
  @IsUUID()
  chatId!: string;
}

export class WsTypingDto {
  @IsUUID()
  chatId!: string;

  @IsOptional()
  isTyping?: boolean = true;
}

export class WsMarkReadDto {
  @IsUUID()
  chatId!: string;

  @IsUUID()
  messageId!: string;
}
