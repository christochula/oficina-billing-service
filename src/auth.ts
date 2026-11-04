import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { verify } from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { Claims } from './types';

export function decodeToken(header: string | undefined, env: NodeJS.ProcessEnv = process.env): Claims {
  if (!env.JWT_SECRET || !header?.startsWith('Bearer ')) throw new UnauthorizedException('JWT obrigatorio');
  try {
    const claims = verify(header.slice(7), env.JWT_SECRET, { algorithms: ['HS256'], issuer: env.JWT_ISSUER ?? 'oficina-auth-serverless', audience: env.JWT_AUDIENCE ?? 'oficina-api' });
    if (typeof claims === 'string' || !claims.sub) throw new Error('Claims invalidos');
    return claims as Claims;
  } catch { throw new UnauthorizedException('JWT invalido'); }
}
export function internalToken(value: string | undefined, expected = process.env.AUTH_CLIENT_LOOKUP_TOKEN): void {
  if (!value || !expected || Buffer.byteLength(value) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(value), Buffer.from(expected))) throw new UnauthorizedException('Token interno invalido');
}
@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean { const req = context.switchToHttp().getRequest(); req.claims = decodeToken(req.headers.authorization); return true; }
}
