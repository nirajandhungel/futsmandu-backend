// apps/player-api/src/common/interceptors/response.interceptor.ts
// Wraps all successful responses in { data: ... } envelope.
// Controllers return plain objects; interceptor wraps them consistently.

import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common'
import { Observable } from 'rxjs'
import { map } from 'rxjs/operators'

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, { data: T }> {
  intercept(_ctx: ExecutionContext, next: CallHandler<T>): Observable<{ data: T }> {
    return next.handle().pipe(
      map((data) => {
        // If the controller already returns { data: ..., meta: ... }, don't double-wrap
        if (data && typeof data === 'object' && 'data' in (data as object)) {
          return data as unknown as { data: T }
        }
        return { data }
      }),
    )
  }
}
