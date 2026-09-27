import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

/**
 * SLICE ONLY. Operator endpoints accept an `x-dev-user` header. Real login is Privy (STACK.md);
 * its token verification is not wired yet — Privy docs were unreachable from this environment.
 * Refuses to run in production. Approver actions do not depend on this: they are authenticated by
 * their signatures, checked against the on-chain approver set.
 */
@Injectable()
export class DevAuthGuard implements CanActivate {
  constructor() {
    if (process.env.NODE_ENV === "production") throw new Error("DevAuthGuard must not run in production");
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (!req.headers["x-dev-user"]) throw new UnauthorizedException("x-dev-user header required (slice auth)");
    return true;
  }
}
