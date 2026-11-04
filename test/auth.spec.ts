import { decodeToken, internalToken, JwtGuard } from '../src/auth';
import { sign } from 'jsonwebtoken';
describe('JWT and internal authentication', () => {
  const env = { JWT_SECRET: 'secret' };
  const token = (claims: object, options = {}) => sign(claims, 'secret', { issuer: 'oficina-auth-serverless', audience: 'oficina-api', expiresIn: 300, ...options });
  it('validates issuer, audience, algorithm, expiration and subject', () => {
    expect(decodeToken(`Bearer ${token({ sub: 'client', role: 'CLIENTE' })}`, env).sub).toBe('client');
    for (const value of [undefined, 'Basic x', 'Bearer bad', `Bearer ${token({})}`, `Bearer ${token({ sub: 'x' }, { issuer: 'other' })}`, `Bearer ${token({ sub: 'x' }, { audience: 'other' })}`, `Bearer ${token({ sub: 'x' }, { expiresIn: -1 })}`]) expect(() => decodeToken(value, env)).toThrow();
    expect(() => decodeToken('Bearer token', {})).toThrow();
  });
  it('uses constant-time internal secrets and attaches claims in guard', () => {
    expect(() => internalToken('x', 'x')).not.toThrow(); for (const pair of [[undefined, 'x'], ['x', undefined], ['y', 'x'], ['é', 'xx']]) expect(() => internalToken(pair[0], pair[1])).toThrow();
    process.env.JWT_SECRET = 'secret'; const req = { headers: { authorization: `Bearer ${token({ sub: 'c' })}` }, claims: undefined };
    expect(new JwtGuard().canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never)).toBe(true); expect(req.claims).toMatchObject({ sub: 'c' });
  });
});
