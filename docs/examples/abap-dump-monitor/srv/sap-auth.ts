/**
 * Per-request SAP credentials for the technical user.
 *
 * cloud-llm-hub fails closed for **OnPremise** and **NoAuthentication**
 * destinations (see srv/mcp-manager.ts in cloud-llm-hub): it ignores the BTP
 * destination's own auth and demands `x-sap-login` / `x-sap-password` headers.
 * `S4HANA_E19` is on-premise (Cloud Connector), so those headers are mandatory.
 *
 * This monitor is headless — there is no end-user whose credentials to forward —
 * so it sends a technical user supplied via the `SAP_LOGIN` / `SAP_PASSWORD`
 * env vars (wired in mta.yaml, value provided per subaccount in `.mtaext`).
 *
 * Returns an empty object when unset, so Internet / BasicAuthentication
 * destinations (which carry their own credentials) keep working unchanged.
 */
export function sapCredentialHeaders(): Record<string, string> {
  const login = process.env.SAP_LOGIN?.trim();
  const password = process.env.SAP_PASSWORD?.trim();
  if (!login || !password) return {};
  return { 'x-sap-login': login, 'x-sap-password': password };
}
