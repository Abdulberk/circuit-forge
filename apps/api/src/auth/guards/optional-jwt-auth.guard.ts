/**
 * Optional JWT Auth Guard
 * Allows both authenticated and unauthenticated requests
 * If authenticated, user info is attached to request
 */
import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
    canActivate(context: ExecutionContext) {
        return super.canActivate(context);
    }

    // Passport hands these through untyped; `unknown` is the honest shape — the body only tests
    // truthiness and passes the user straight back to the request.
    handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser | null {
        // Don't throw on missing/invalid token
        // Just return null user
        if (err || !user) {
            return null;
        }
        return user;
    }
}