import type { AuthenticationType } from '@sap-cloud-sdk/connectivity';

// User exchange flows in the Cloud SDK, plus principal propagation.
export const userDependentAuthenticationTypes: ReadonlySet<string> =
  new Set<AuthenticationType>([
    'PrincipalPropagation',
    'SAMLAssertion',
    'OAuth2SAMLBearerAssertion',
    'OAuth2UserTokenExchange',
    'OAuth2JWTBearer',
  ]);

/**
 * Shared credential policy for the UI, chat connection, and active probe.
 * User-dependent auth uses the forwarded JWT. Other OnPremise destinations
 * and NoAuthentication require caller credentials; Internet auth uses the
 * destination's configured credentials unless the caller supplies an override.
 */
export function destinationRequiresCredentials(
  proxyType?: string | null,
  authentication?: string,
): boolean {
  return (
    ((proxyType ?? '').toLowerCase() === 'onpremise' &&
      !userDependentAuthenticationTypes.has(authentication ?? '')) ||
    authentication === 'NoAuthentication'
  );
}
