import cds, { type Request, type Service } from '@sap/cds';

/**
 * CAP User interface extension for type safety
 */
interface CdsUser {
  id?: string;
  _is_anonymous?: boolean;
  roles?: string[];
  // eslint-disable-next-line no-unused-vars
  is?: (role: string) => boolean;
}

/**
 * Request headers interface
 */
interface RequestHeaders {
  authorization?: string;
  [key: string]: string | string[] | undefined;
}

/**
 * Request data for CheckRoles action
 */
interface CheckRolesData {
  required?: string[];
}

export default async function registerAuthHandlers(
  srv: Service,
): Promise<void> {
  const log = cds.log('auth-service');

  srv.on('CheckAuth', async (req: Request) => {
    const user = req.user as CdsUser | undefined;
    const headers = req.headers as RequestHeaders;

    log.info('🔐 CheckAuth handler called', {
      hasUser: !!user,
      userId: user?.id,
      isAnonymous: user?._is_anonymous,
      hasAuthHeader: !!headers?.authorization,
      authHeaderPrefix: headers?.authorization?.substring(0, 20),
    });

    if (!user || user._is_anonymous) {
      log.warn('❌ CheckAuth: Unauthorized - no user or anonymous', {
        hasUser: !!user,
        isAnonymous: user?._is_anonymous,
        hasAuthHeader: !!headers?.authorization,
      });
      req.reject(401, 'Unauthorized');
      return;
    }

    log.info('✅ CheckAuth: Authorized', {
      userId: user.id,
      roles: user.roles,
    });

    return {
      id: user.id,
      roles: user.roles || [],
      authenticated: true,
    };
  });

  srv.on('CheckRoles', async (req: Request) => {
    const user = req.user as CdsUser | undefined;

    log.debug('CheckRoles handler called', {
      hasUser: !!user,
      userId: user?.id,
    });

    if (!user || user._is_anonymous) {
      log.warn('CheckRoles: Unauthorized - no user or anonymous', {
        hasUser: !!user,
        isAnonymous: user?._is_anonymous,
      });
      req.reject(401, 'Unauthorized');
      return;
    }

    const data = req.data as CheckRolesData;
    const required: string[] = Array.isArray(data?.required)
      ? data.required
      : [];

    log.debug('CheckRoles: Checking roles', {
      required,
      userRoles: user.roles,
    });

    const missing = required.filter((r: string) => !user.is?.(r));
    if (missing.length) {
      log.warn('CheckRoles: Forbidden - missing roles', {
        required,
        missing,
        userRoles: user.roles,
      });
      req.reject(
        403,
        `Forbidden: missing required roles: ${missing.join(', ')}`,
      );
      return;
    }

    log.debug('CheckRoles: Authorized', { userId: user.id, roles: user.roles });
    return {
      id: user.id,
      roles: user.roles || [],
      required,
      missing: [],
      authorized: true,
    };
  });
}

// CommonJS compatibility
module.exports = registerAuthHandlers;
