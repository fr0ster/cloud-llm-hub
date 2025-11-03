import cds, { Request, Service } from '@sap/cds';

export default async function registerAuthHandlers(srv: Service): Promise<void> {
  const log = cds.log('auth-service');

  srv.on('CheckAuth', async (req: Request) => {
    log.info('🔐 CheckAuth handler called', {
      hasUser: !!req.user,
      userId: (req.user as any)?.id,
      isAnonymous: (req.user as any)?._is_anonymous,
      hasAuthHeader: !!(req.headers as any)?.authorization,
      authHeaderPrefix: (req.headers as any)?.authorization?.substring(0, 20),
      url: (req as any).url,
      path: (req as any).path
    });
    
    const user = req.user as any;
    if (!user || user._is_anonymous) {
      log.warn('❌ CheckAuth: Unauthorized - no user or anonymous', {
        hasUser: !!user,
        isAnonymous: user?._is_anonymous,
        hasAuthHeader: !!(req.headers as any)?.authorization
      });
      req.reject(401, 'Unauthorized');
      return; // unreachable
    }
    
    log.info('✅ CheckAuth: Authorized', {
      userId: user.id,
      roles: user.roles
    });
    
    return {
      id: user.id,
      roles: user.roles || [],
      authenticated: true
    };
  });

  srv.on('CheckRoles', async (req: Request) => {
    log.debug('CheckRoles handler called', { hasUser: !!req.user, userId: (req.user as any)?.id });
    
    const user = req.user as any;
    if (!user || user._is_anonymous) {
      log.warn('CheckRoles: Unauthorized - no user or anonymous', { hasUser: !!user, isAnonymous: user?._is_anonymous });
      req.reject(401, 'Unauthorized');
      return; // unreachable
    }

    const required: string[] = Array.isArray((req.data as any)?.required)
      ? (req.data as any).required
      : [];

    log.debug('CheckRoles: Checking roles', { required, userRoles: user.roles });

    const missing = required.filter((r: string) => !user.is?.(r));
    if (missing.length) {
      log.warn('CheckRoles: Forbidden - missing roles', { required, missing, userRoles: user.roles });
      req.reject(403, `Forbidden: missing required roles: ${missing.join(', ')}`);
      return; // unreachable
    }

    log.debug('CheckRoles: Authorized', { userId: user.id, roles: user.roles });
    return {
      id: user.id,
      roles: user.roles || [],
      required,
      missing: [],
      authorized: true
    };
  });
}

// CommonJS compatibility
module.exports = registerAuthHandlers;


