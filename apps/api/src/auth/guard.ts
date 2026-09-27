import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { PrivyVerifier, AuthUser } from "./privy.js";

export const VERIFIER = Symbol("PrivyVerifier");
export const USERS = Symbol("UserStore");

export interface UserStore {
  upsert(u: AuthUser): Promise<void>;
}

/** Authorization: Bearer <access token>; privy-id-token: <identity token> (docs.privy.io, identity tokens). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(VERIFIER) private readonly v: PrivyVerifier, @Inject(USERS) private readonly users: UserStore) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const access = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!access) throw new UnauthorizedException("login required");
    try {
      const idt = req.headers["privy-id-token"] ?? req.cookies?.["privy-id-token"];
      req.user = await this.v.verify(access, idt ? String(idt) : undefined);
    } catch {
      throw new UnauthorizedException("invalid or expired token");
    }
    await this.users.upsert(req.user);
    return true;
  }
}
