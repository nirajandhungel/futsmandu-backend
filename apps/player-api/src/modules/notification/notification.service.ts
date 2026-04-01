// apps/player-api/src/modules/notification/notification.service.ts
import { Injectable } from '@nestjs/common'
import { PrismaService } from '@futsmandu/database'

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, page = 1, limit = 30) {
    const take = Math.min(limit, 50)
    const [notifications, unreadCount] = await Promise.all([
      this.prisma.notifications.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.notifications.count({ where: { user_id: userId, is_read: false } }),
    ])
    return { data: notifications, meta: { unreadCount } }
  }

  async markAllRead(userId: string) {
    await this.prisma.notifications.updateMany({
      where: { user_id: userId, is_read: false },
      data: { is_read: true },
    })
    return { message: 'All notifications marked as read' }
  }

  async markOneRead(notifId: string, userId: string) {
    await this.prisma.notifications.updateMany({
      where: { id: notifId, user_id: userId },
      data: { is_read: true },
    })
    return { message: 'Notification marked as read' }
  }
}
