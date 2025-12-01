# Security Policy

## Supported Versions

We actively support the following versions of Cloud LLM Hub:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**⚠️ IMPORTANT: Please DO NOT create public GitHub issues for security vulnerabilities.**

Security vulnerabilities should be reported privately to ensure responsible disclosure and allow time for fixes before public disclosure.

### How to Report

Please report security vulnerabilities via:

- **Email:** [Add your security email here]
- **GitHub Security Advisory:** Use the "Report a vulnerability" button on the repository's Security tab
- **Expected response time:** Within 48 hours

### What to Include

When reporting a vulnerability, please include:

1. **Description** - Clear description of the vulnerability
2. **Steps to Reproduce** - Detailed steps to reproduce the issue
3. **Potential Impact** - Assessment of the security impact
4. **Suggested Fix** - If you have ideas for fixing it (optional)
5. **Affected Versions** - Which versions are affected

### What Happens Next

1. **Acknowledgment** - We'll acknowledge receipt within 48 hours
2. **Investigation** - We'll investigate and provide an initial assessment within 5 business days
3. **Fix Development** - We'll work on a fix and coordinate disclosure timing with you
4. **Credit** - We'll credit you in the security advisory (if you wish)

### Disclosure Timeline

- **Initial Response:** 48 hours
- **Assessment:** 5 business days
- **Fix Development:** Depends on severity
- **Public Disclosure:** After fix is available or coordinated with reporter

## Security Best Practices

### For Administrators

- ✅ **Always use XSUAA authentication in production**
  - Never use Basic authentication in production environments
  - Configure proper role collections and scopes

- ✅ **Rotate JWT tokens regularly**
  - Implement token rotation policies
  - Monitor token expiration

- ✅ **Use Cloud Connector for on-premise systems**
  - Never expose on-premise systems directly to the internet
  - Configure proper Cloud Connector security

- ✅ **Enable HTTPS only**
  - Disable HTTP in production
  - Use proper SSL/TLS certificates

- ✅ **Review access logs regularly**
  - Monitor authentication failures
  - Check for suspicious activity
  - Set up alerts for unusual patterns

- ✅ **Keep dependencies updated**
  - Regularly update npm packages
  - Monitor for security advisories
  - Use `npm audit` to check for vulnerabilities

- ✅ **Secure service keys**
  - Store service keys securely
  - Never commit service keys to git
  - Rotate service keys periodically

### For Developers

- ✅ **Never commit credentials to git**
  - Use `.env` files for local development (excluded from git)
  - Use environment variables for sensitive data
  - Use `.gitignore` to exclude sensitive files

- ✅ **Use service keys for BTP authentication**
  - Never hardcode credentials
  - Use service keys stored securely
  - Rotate credentials regularly

- ✅ **Follow the principle of least privilege**
  - Grant minimum necessary permissions
  - Use specific scopes instead of broad access
  - Review and audit permissions regularly

- ✅ **Validate all inputs**
  - Sanitize user inputs
  - Validate request parameters
  - Check authentication tokens

- ✅ **Use secure defaults**
  - Enable security features by default
  - Disable debug modes in production
  - Use secure communication protocols

- ✅ **Keep dependencies secure**
  - Regularly update dependencies
  - Use `npm audit` to check for vulnerabilities
  - Review security advisories

## Known Security Considerations

### Authentication

- **Development Mode:** Uses mocked Basic authentication (users: `alice`, `bob`)
  - ⚠️ **Never use in production**
  - Development mode is for local testing only

- **Production Mode:** Uses XSUAA with JWT tokens
  - ✅ Proper authentication and authorization
  - Token validation and expiration handling
  - Role-based access control

### Network Security

- **HTTPS:** All production deployments should use HTTPS
- **Cloud Connector:** Required for on-premise SAP systems
- **Firewall:** Configure proper firewall rules

### Data Protection

- **No Data Storage:** Cloud LLM Hub does not store user data
- **Session Management:** Sessions are in-memory only
- **Logging:** Be careful not to log sensitive data

## Security Updates

Security updates will be released as:

- **Patch releases** (1.0.x) for security fixes
- **Minor releases** (1.x.0) for security improvements
- **Major releases** (x.0.0) for breaking security changes

## Security Changelog

Security-related changes will be documented in:

- `CHANGELOG.md` - General changelog
- GitHub Security Advisories - For vulnerabilities
- Release notes - For security improvements

## Additional Resources

- [SAP Security Best Practices](https://help.sap.com/docs/btp)
- [SAP BTP Security Guide](https://help.sap.com/docs/btp/sap-business-technology-platform-security-guide)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

---

**Last Updated:** 2025-11-05  
**Version:** 1.0
