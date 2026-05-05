import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { RedisService } from '@futsmandu/redis';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | undefined;

  constructor(
    appOrHttpServer: any,
    private readonly redisService: RedisService,
  ) {
    super(appOrHttpServer);
  }

  async connectToRedis(): Promise<void> {
    const pubClient = this.redisService.client;
    const subClient = pubClient.duplicate();

    // Since we're using lazyConnect in RedisService, ensure they connect if not already
    if (pubClient.status === 'wait') {
      await pubClient.connect();
    }
    await subClient.connect();

    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
