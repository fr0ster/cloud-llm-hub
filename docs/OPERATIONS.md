# Operations Guide (Runbook)

Production operations guide for Cloud LLM Hub administrators and DevOps teams.

## 📋 Table of Contents

- [Monitoring](#monitoring)
- [Health Checks](#health-checks)
- [Scaling](#scaling)
- [Backup & Recovery](#backup--recovery)
- [Incident Response](#incident-response)
- [Maintenance Windows](#maintenance-windows)
- [Log Analysis](#log-analysis)
- [Performance Tuning](#performance-tuning)

---

## 📊 Monitoring

### Key Metrics

Monitor the following metrics to ensure healthy operation:

#### Application Metrics

- **Response Time**
  - P50: < 500ms
  - P95: < 2s
  - P99: < 5s
- **Error Rate**
  - Target: < 1%
  - Critical threshold: > 5%
- **Active Connections**
  - Monitor concurrent SSE/Stream-HTTP connections
  - Alert if approaching limits
- **Cache Hit Rate**
  - MCP server cache: Target > 80%
  - Session cache: Monitor expiration

#### Service Metrics

- **XSUAA Token Refresh Rate**
  - Monitor token refresh failures
  - Alert on authentication errors
- **Destination Resolution Time**
  - Target: < 100ms
  - Alert if > 500ms
- **SAP Connection Pool**
  - Monitor active connections
  - Alert on connection exhaustion

### Health Checks

#### Automated Health Monitoring

```bash
# Health check endpoint (every 30 seconds)
curl -H "Authorization: Bearer $TOKEN" \
     https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health\(\)

# Expected response: {"status":"UP","timestamp":"..."}
```

**Monitoring Schedule:**
- Check interval: 30 seconds
- Failure threshold: 3 consecutive failures
- Alert on: Status != "UP" for > 2 minutes

#### Manual Health Check

```bash
# Quick health check
cf ssh cloud-llm-hub-srv -c "curl -H 'Authorization: Bearer \$(cat /tmp/xsuaa-token)' \
  http://localhost:4004/odata/v4/mcp/Health\(\)"
```

### Alerts

Configure alerts for:

| Metric | Threshold | Action |
|--------|-----------|--------|
| Response time (P95) | > 5s | Investigate |
| Error rate | > 5% | Immediate investigation |
| Health check failure | > 2 minutes | On-call escalation |
| Active connections | > 80% capacity | Scale up |
| Cache hit rate | < 50% | Review cache TTL |
| Authentication failures | > 10/minute | Security review |

---

## 🔍 Health Checks

### Application Health

**Endpoint:** `GET /odata/v4/mcp/Health()`

**Check Frequency:** Every 30 seconds

**Expected Response:**
```json
{
  "status": "UP",
  "timestamp": "2025-11-05T12:00:00.000Z"
}
```

**Failure Indicators:**
- Status != "UP"
- No response (timeout)
- HTTP status != 200

### Service Dependencies

**XSUAA Service:**
```bash
cf service cloud-llm-hub-auth
cf service-key cloud-llm-hub-auth mcp
```

**Destination Service:**
```bash
cf service cloud-llm-hub-destination
cf service-key cloud-llm-hub-destination mcp
```

**Connectivity Service:**
```bash
cf service cloud-llm-hub-connectivity
cf service-key cloud-llm-hub-connectivity mcp
```

### SAP System Connectivity

**Probe Destination:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
     "https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/ProbeDestination?destination=SAP_PROD_DEST"
```

**Expected Response:**
```json
{
  "destination": "SAP_PROD_DEST",
  "probe": {
    "status": 200,
    "statusText": "OK"
  }
}
```

---

## 📈 Scaling

### Horizontal Scaling

**Scale out (add instances):**
```bash
cf scale cloud-llm-hub-srv -i 3
```

**Scale in (reduce instances):**
```bash
cf scale cloud-llm-hub-srv -i 1
```

**Check current instances:**
```bash
cf app cloud-llm-hub-srv
```

### Vertical Scaling

**Increase memory:**
```bash
# Edit mta.yaml
# Change memory limit in module configuration
# Rebuild and redeploy
```

**Recommended Instance Sizes:**
- **Development:** 512M RAM, 1 instance
- **Production (small):** 1G RAM, 2-3 instances
- **Production (large):** 2G RAM, 3-5 instances

### Auto-scaling (Future)

Consider implementing auto-scaling based on:
- CPU utilization > 70%
- Memory usage > 80%
- Request queue length > 100

---

## 💾 Backup & Recovery

### What to Backup

#### Configuration Files
- `xs-security.json` - Security configuration
- `mta.yaml` - Deployment descriptor
- Destination configurations (in BTP Cockpit)

#### Service Bindings
- XSUAA service instance configuration
- Destination service instance configuration
- Connectivity service instance configuration

**Backup Procedure:**
```bash
# Export service configurations
cf service cloud-llm-hub-auth > backups/xsuaa-config.json
cf service-key cloud-llm-hub-auth mcp > backups/xsuaa-key.json
cf service cloud-llm-hub-destination > backups/destination-config.json
cf service-key cloud-llm-hub-destination mcp > backups/destination-key.json
```

### Recovery Procedures

#### Application Recovery

**1. Restart Application:**
```bash
cf restart cloud-llm-hub-srv
```

**2. Restage Application:**
```bash
cf restage cloud-llm-hub-srv
```

**3. Redeploy from Backup:**
```bash
# Restore from MTAR backup
cf deploy backups/cloud-llm-hub_1.0.0.mtar
```

#### Service Recovery

**1. Rebind Services:**
```bash
cf unbind-service cloud-llm-hub-srv cloud-llm-hub-auth
cf bind-service cloud-llm-hub-srv cloud-llm-hub-auth
cf restage cloud-llm-hub-srv
```

**2. Recreate Service Instances:**
```bash
# Delete and recreate (last resort)
cf delete-service cloud-llm-hub-auth
cf create-service xsuaa application cloud-llm-hub-auth -c xs-security.json
cf bind-service cloud-llm-hub-srv cloud-llm-hub-auth
cf restage cloud-llm-hub-srv
```

#### Data Recovery

**Note:** Cloud LLM Hub is stateless - no data recovery needed.

**Session Recovery:**
- Sessions are in-memory only
- Restarting clears all sessions
- Clients will automatically reconnect

---

## 🚨 Incident Response

### Severity Levels

| Level | Description | Response Time | Example |
|-------|-------------|---------------|---------|
| **P0** | Service down | Immediate | Health check failing, no response |
| **P1** | Degraded performance | 15 minutes | High error rate, slow responses |
| **P2** | Non-critical issues | 2 hours | Single endpoint failing, minor errors |

### P0 Incident Procedure

**1. Verify Service Status:**
```bash
# Check health endpoint
curl -H "Authorization: Bearer $TOKEN" \
     https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health\(\)

# Check application status
cf app cloud-llm-hub-srv
```

**2. Review Recent Logs:**
```bash
# Get recent logs
cf logs cloud-llm-hub-srv --recent

# Stream logs
cf logs cloud-llm-hub-srv
```

**3. Check Service Bindings:**
```bash
# Verify services are bound
cf env cloud-llm-hub-srv | grep -i service

# Check service status
cf services
```

**4. Restart Application:**
```bash
# Try restart first
cf restart cloud-llm-hub-srv

# Wait 2 minutes, check health
# If still failing, proceed to restage
cf restage cloud-llm-hub-srv
```

**5. Escalate if Needed:**
- If restart/restage doesn't resolve, check:
  - Service instance status
  - SAP system connectivity
  - Cloud Connector status (for on-premise)
  - Network connectivity

### P1 Incident Procedure

**1. Identify Root Cause:**
```bash
# Check error rates
cf logs cloud-llm-hub-srv --recent | grep -i error

# Check response times
# Monitor application metrics
```

**2. Check Resource Usage:**
```bash
# Check memory/CPU
cf app cloud-llm-hub-srv

# Check if scaling needed
```

**3. Apply Fix:**
- Scale up if needed
- Restart if memory leak suspected
- Check destination/SAP connectivity

### Common Incidents

#### High Error Rate

**Symptoms:**
- Error rate > 5%
- Multiple 502/503 errors

**Actions:**
1. Check SAP system connectivity
2. Verify destination configuration
3. Check Cloud Connector (if on-premise)
4. Review authentication token validity
5. Scale up if needed

#### Slow Response Times

**Symptoms:**
- P95 > 5 seconds
- Timeout errors

**Actions:**
1. Check SAP system response times
2. Verify destination resolution time
3. Check cache hit rate
4. Review connection pool usage
5. Scale up if needed

#### Authentication Failures

**Symptoms:**
- Multiple 401 errors
- Token refresh failures

**Actions:**
1. Verify XSUAA service is healthy
2. Check service key validity
3. Review token expiration
4. Check XSUAA configuration

---

## 🔧 Maintenance Windows

### Planned Maintenance

**Schedule:**
- **Frequency:** Monthly (or as needed)
- **Duration:** 1-2 hours
- **Time:** Off-peak hours (e.g., weekend nights)

**Pre-Maintenance Checklist:**
- [ ] Notify users 48 hours in advance
- [ ] Backup all configurations
- [ ] Verify backup integrity
- [ ] Prepare rollback plan
- [ ] Schedule maintenance window

**Maintenance Tasks:**
1. Update dependencies
2. Apply security patches
3. Review and update configurations
4. Clean up old logs
5. Performance optimization

**Post-Maintenance:**
- [ ] Verify health endpoint
- [ ] Test all endpoints
- [ ] Monitor for 1 hour
- [ ] Notify users of completion

### Emergency Maintenance

**Procedure:**
1. Document issue
2. Notify stakeholders
3. Perform maintenance
4. Verify fixes
5. Post-incident review

---

## 📝 Log Analysis

### Log Locations

**Cloud Foundry Logs:**
```bash
# Recent logs
cf logs cloud-llm-hub-srv --recent

# Stream logs
cf logs cloud-llm-hub-srv

# Filter by log type
cf logs cloud-llm-hub-srv --recent | grep ERROR
cf logs cloud-llm-hub-srv --recent | grep WARN
```

**Application Logs:**
- Standard output: Available via `cf logs`
- Log levels: `debug`, `info`, `warn`, `error`

### Common Log Patterns

#### Authentication Errors

**Pattern:**
```
401 Unauthorized
Authentication failed
Token expired
```

**Actions:**
- Check XSUAA service status
- Verify token validity
- Review authentication configuration

#### Connection Timeouts

**Pattern:**
```
ETIMEDOUT
Connection timeout
Request timeout
```

**Actions:**
- Check SAP system connectivity
- Verify Cloud Connector status
- Review network configuration

#### Destination Errors

**Pattern:**
```
Destination not found
Destination resolution failed
```

**Actions:**
- Verify destination exists
- Check service binding
- Review destination configuration

#### MCP Server Errors

**Pattern:**
```
MCP server initialization failed
Server already initialized
Session expired
```

**Actions:**
- Check MCP server status
- Verify session management
- Review cache configuration

### Log Analysis Tools

**Useful Commands:**
```bash
# Count errors
cf logs cloud-llm-hub-srv --recent | grep -i error | wc -l

# Find most common errors
cf logs cloud-llm-hub-srv --recent | grep -i error | sort | uniq -c | sort -rn

# Monitor real-time
cf logs cloud-llm-hub-srv | grep -E "(ERROR|WARN)"

# Export logs for analysis
cf logs cloud-llm-hub-srv --recent > logs-$(date +%Y%m%d).log
```

---

## ⚡ Performance Tuning

### Application Settings

**Memory:**
- Default: 512M
- Recommended: 1G for production
- Increase if seeing OOM errors

**Instance Count:**
- Development: 1 instance
- Production: 2-3 instances (minimum)
- Scale up based on load

**Environment Variables:**
```bash
# Cache TTL (30 minutes default)
CACHE_TTL=1800000

# Session timeout (2 minutes default)
SESSION_TIMEOUT=120000

# Max connections per instance
MAX_CONNECTIONS=100
```

### Cache Configuration

**MCP Server Cache:**
- TTL: 30 minutes (default)
- Key: SAP system URL
- Purpose: Reuse MCP server instances

**Tuning:**
- Increase TTL if cache hit rate is low
- Decrease TTL if memory pressure
- Monitor cache hit rate

### Connection Pool

**SAP Connections:**
- Monitor active connections
- Adjust pool size based on load
- Close idle connections

### Database Connections (Future)

If database is added:
- Connection pool size: 10-20
- Idle timeout: 30 minutes
- Max connections: 50

---

## 🔄 Deployment Procedures

### Standard Deployment

**1. Build:**
```bash
npm install
npm run build
mbt build
```

**2. Deploy:**
```bash
cf deploy mta_archives/cloud-llm-hub_1.0.0.mtar
```

**3. Verify:**
```bash
# Check health
curl -H "Authorization: Bearer $TOKEN" \
     https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health\(\)

# Check logs
cf logs cloud-llm-hub-srv --recent
```

### Rollback Procedure

**1. Identify Previous Version:**
```bash
# List previous deployments
cf apps | grep cloud-llm-hub
```

**2. Deploy Previous MTAR:**
```bash
cf deploy backups/cloud-llm-hub_1.0.0-previous.mtar
```

**3. Verify:**
```bash
# Check health
# Test endpoints
# Monitor for issues
```

---

## 📞 Escalation Contacts

### Internal Contacts

- **Development Team:** [Contact]
- **DevOps Team:** [Contact]
- **SAP Basis Team:** [Contact]

### External Contacts

- **SAP Support:** [If applicable]
- **Cloud Foundry Support:** [If applicable]

---

## 📚 Additional Resources

- [Monitoring Guide](MONITORING.md) - Detailed monitoring setup
- [Troubleshooting Guide](TROUBLESHOOTING.md) - Common issues
- [API Reference](API_REFERENCE.md) - API documentation
- [Deployment Checklist](DEPLOYMENT_CHECKLIST.md) - Deployment steps

---

**Last Updated:** 2025-11-05  
**Version:** 1.0

