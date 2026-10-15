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
