# Monitoring Guide

Comprehensive monitoring setup and best practices for Cloud LLM Hub.

## 📊 Overview

This guide covers monitoring strategies, metrics, dashboards, and alerting for Cloud LLM Hub in production environments.

## 🎯 Key Metrics to Monitor

### Application Metrics

#### Response Time

**Targets:**
- P50 (median): < 500ms
- P95: < 2s
- P99: < 5s

**Monitoring:**
```bash
# Check response times
cf logs cloud-llm-hub-srv --recent | grep -E "response-time|duration"

# Or use application metrics endpoint (if implemented)
curl https://your-app.cfapps.eu10.hana.ondemand.com/metrics
```

**Alert Thresholds:**
- P95 > 5s: Warning
- P95 > 10s: Critical

#### Error Rate

**Targets:**
- Error rate: < 1%
- Critical threshold: > 5%

**Monitoring:**
```bash
# Count errors
cf logs cloud-llm-hub-srv --recent | grep -i error | wc -l

# Error rate calculation
ERRORS=$(cf logs cloud-llm-hub-srv --recent | grep -i error | wc -l)
TOTAL=$(cf logs cloud-llm-hub-srv --recent | wc -l)
ERROR_RATE=$(echo "scale=2; $ERRORS * 100 / $TOTAL" | bc)
echo "Error rate: $ERROR_RATE%"
```

**Alert Thresholds:**
- Error rate > 1%: Warning
- Error rate > 5%: Critical

#### Request Rate

**Metrics:**
- Requests per second (RPS)
- Requests per minute (RPM)
- Peak load

**Monitoring:**
```bash
# Count requests per minute
cf logs cloud-llm-hub-srv --recent | grep -E "GET|POST" | wc -l
```

#### Active Connections

**Metrics:**
- Concurrent SSE connections
- Concurrent Stream-HTTP sessions
- Total active connections

**Alert Thresholds:**
- > 80% capacity: Warning
- > 95% capacity: Critical

### Service Metrics

#### XSUAA Authentication

**Metrics:**
- Token refresh success rate
- Authentication failures
- Token expiration rate

**Monitoring:**
```bash
# Check authentication failures
cf logs cloud-llm-hub-srv --recent | grep -i "401\|unauthorized" | wc -l

# Check token refresh
cf logs cloud-llm-hub-srv --recent | grep -i "token.*refresh"
```

**Alert Thresholds:**
- Auth failures > 10/minute: Warning
- Auth failures > 50/minute: Critical

#### Destination Service

**Metrics:**
- Destination resolution time
- Destination resolution failures
- Cache hit rate

**Monitoring:**
```bash
# Check destination resolution
cf logs cloud-llm-hub-srv --recent | grep -i "destination"
```

**Alert Thresholds:**
- Resolution time > 500ms: Warning
- Resolution failures > 5%: Warning

#### SAP Connectivity

**Metrics:**
- SAP connection success rate
- SAP response time
- Connection timeouts

**Monitoring:**
```bash
# Check SAP connection errors
cf logs cloud-llm-hub-srv --recent | grep -i "sap.*timeout\|connection.*failed"
```

**Alert Thresholds:**
- Connection failures > 5%: Warning
- Response time > 10s: Warning

### Resource Metrics

#### Memory Usage

**Targets:**
- Normal: < 70%
- Warning: > 80%
- Critical: > 90%

**Monitoring:**
```bash
# Check memory usage
cf app cloud-llm-hub-srv | grep memory

# Or via metrics (if available)
cf app cloud-llm-hub-srv --guid | xargs cf curl /v2/apps/{guid}/stats
```

#### CPU Usage

**Targets:**
- Normal: < 70%
- Warning: > 80%
- Critical: > 90%

**Monitoring:**
```bash
# Check CPU usage
cf app cloud-llm-hub-srv --guid | xargs cf curl /v2/apps/{guid}/stats
```

#### Disk Usage

**Targets:**
- Normal: < 70%
- Warning: > 80%
- Critical: > 90%

**Monitoring:**
```bash
# Check disk usage
cf ssh cloud-llm-hub-srv -c "df -h"
```

### Cache Metrics

#### MCP Server Cache

**Metrics:**
- Cache hit rate
- Cache size
- Cache evictions

**Targets:**
- Cache hit rate: > 80%
- Cache size: Monitor growth

**Monitoring:**
```bash
# Check cache operations (from application logs)
cf logs cloud-llm-hub-srv --recent | grep -i "cache"
```

---

## 🔔 Alerting

### Alert Configuration

#### Critical Alerts (P0)

**Triggers:**
- Health endpoint down > 2 minutes
- Error rate > 10%
- All instances down
- Authentication service unavailable

**Actions:**
- Immediate notification (SMS, PagerDuty)
- On-call escalation
- Auto-restart attempt

#### Warning Alerts (P1)

**Triggers:**
- Response time P95 > 5s
- Error rate > 5%
- Memory usage > 80%
- Cache hit rate < 50%

**Actions:**
- Email notification
- Dashboard alert
- Investigation required

#### Info Alerts

**Triggers:**
- Deployment completed
- Configuration changes
- Scheduled maintenance

**Actions:**
- Log entry
- Dashboard notification

### Alert Examples

#### Health Check Failure

```yaml
Alert: CloudLLMHub_HealthDown
Condition: health_check_status == "DOWN" for 2 minutes
Severity: Critical
Notification: SMS, Email, PagerDuty
```

#### High Error Rate

```yaml
Alert: CloudLLMHub_HighErrorRate
Condition: error_rate > 5% for 5 minutes
Severity: Warning
Notification: Email, Dashboard
```

#### Memory Pressure

```yaml
Alert: CloudLLMHub_HighMemory
Condition: memory_usage > 80% for 10 minutes
Severity: Warning
Notification: Email
Action: Scale up or investigate memory leak
```

---

## 📈 Dashboards

### Recommended Dashboard Panels

#### Overview Dashboard

**Panels:**
1. **Health Status** - Current health check status
2. **Request Rate** - Requests per second/minute
3. **Response Time** - P50, P95, P99
4. **Error Rate** - Percentage of errors
5. **Active Connections** - Current connections
6. **Resource Usage** - CPU, Memory, Disk

#### Service Health Dashboard

**Panels:**
1. **XSUAA Status** - Authentication health
2. **Destination Service** - Resolution success rate
3. **SAP Connectivity** - Connection status
4. **Cloud Connector** - Tunnel status (if on-premise)

#### Performance Dashboard

**Panels:**
1. **Response Time Distribution** - Histogram
2. **Endpoint Performance** - Per-endpoint metrics
3. **Cache Performance** - Hit rate, size
4. **Connection Pool** - Active/idle connections

### Dashboard Tools

#### Cloud Foundry Metrics

**Using CF CLI:**
```bash
# Get app metrics
cf app cloud-llm-hub-srv --guid | xargs cf curl /v2/apps/{guid}/stats

# Get service metrics
cf service cloud-llm-hub-srv
```

#### Prometheus (If Integrated)

**Metrics Endpoint:**
```yaml
# Example metrics endpoint
/metrics:
  - cloud_llm_hub_requests_total
  - cloud_llm_hub_response_time_seconds
  - cloud_llm_hub_errors_total
  - cloud_llm_hub_active_connections
```

**Prometheus Queries:**
```promql
# Request rate
rate(cloud_llm_hub_requests_total[5m])

# Error rate
rate(cloud_llm_hub_errors_total[5m]) / rate(cloud_llm_hub_requests_total[5m])

# P95 response time
histogram_quantile(0.95, cloud_llm_hub_response_time_seconds_bucket)
```

#### Grafana Dashboards

**Recommended Dashboards:**
1. **Cloud LLM Hub Overview** - Key metrics
2. **Service Health** - Service dependencies
3. **Performance Analysis** - Detailed performance metrics
4. **Error Analysis** - Error breakdown

---

## 🔍 Logging

### Log Levels

#### Development

```bash
# Enable debug logging
export CDS_LOG_LEVEL=debug
cds watch --profile development
```

#### Production

```bash
# Use info level (default)
export CDS_LOG_LEVEL=info
```

### Log Collection

#### Cloud Foundry Logs

**Stream Logs:**
```bash
cf logs cloud-llm-hub-srv
```

**Recent Logs:**
```bash
cf logs cloud-llm-hub-srv --recent
```

**Filtered Logs:**
```bash
# Errors only
cf logs cloud-llm-hub-srv --recent | grep -i error

# Specific endpoint
cf logs cloud-llm-hub-srv --recent | grep "/mcp/stream/sse"

# Time range
cf logs cloud-llm-hub-srv --recent | grep "2025-11-05"
```

#### Log Aggregation

**External Log Aggregation:**
- **ELK Stack** (Elasticsearch, Logstash, Kibana)
- **Splunk**
- **Datadog**
- **CloudWatch** (AWS)

**Log Shipping:**
```bash
# Export logs
cf logs cloud-llm-hub-srv --recent > logs-$(date +%Y%m%d).log

# Send to log aggregation
cf logs cloud-llm-hub-srv | curl -X POST \
  -H "Content-Type: application/json" \
  -d @- https://your-log-aggregator.com/logs
```

### Log Analysis

#### Common Patterns

**Authentication Errors:**
```bash
cf logs cloud-llm-hub-srv --recent | grep -E "401|unauthorized|token"
```

**Connection Timeouts:**
```bash
cf logs cloud-llm-hub-srv --recent | grep -E "timeout|ETIMEDOUT"
```

**Destination Errors:**
```bash
cf logs cloud-llm-hub-srv --recent | grep -i "destination"
```

**MCP Errors:**
```bash
cf logs cloud-llm-hub-srv --recent | grep -i "mcp"
```

---

## 🎛️ Health Checks

### Automated Health Monitoring

#### Health Check Script

```bash
#!/bin/bash
# health-check.sh

ENDPOINT="https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health()"
TOKEN=$(cf oauth-token)

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$ENDPOINT")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -eq 200 ]; then
  STATUS=$(echo "$BODY" | jq -r '.status')
  if [ "$STATUS" = "UP" ]; then
    echo "✅ Health check passed"
    exit 0
  else
    echo "❌ Health check failed: Status=$STATUS"
    exit 1
  fi
else
  echo "❌ Health check failed: HTTP $HTTP_CODE"
  exit 1
fi
```

#### Cron Job

```bash
# Add to crontab (every 30 seconds via wrapper)
*/1 * * * * /path/to/health-check.sh
```

### Health Check Endpoints

#### Application Health

**Endpoint:** `GET /odata/v4/mcp/Health()`

**Expected Response:**
```json
{
  "status": "UP",
  "timestamp": "2025-11-05T12:00:00.000Z"
}
```

#### Service Health

**XSUAA:**
```bash
cf service cloud-llm-hub-auth
```

**Destination:**
```bash
cf service cloud-llm-hub-destination
```

**Connectivity:**
```bash
cf service cloud-llm-hub-connectivity
```

#### SAP System Health

**Probe Destination:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
     "https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/ProbeDestination?destination=SAP_PROD_DEST"
```

---

## 📊 Metrics Collection

### Application Metrics

#### Custom Metrics (Future)

If implementing custom metrics endpoint:

```typescript
// Example metrics endpoint
app.get('/metrics', async (req, res) => {
  res.json({
    requests: {
      total: requestCount,
      errors: errorCount,
      rate: requestRate
    },
    responseTime: {
      p50: responseTimeP50,
      p95: responseTimeP95,
      p99: responseTimeP99
    },
    connections: {
      active: activeConnections,
      max: maxConnections
    },
    cache: {
      hitRate: cacheHitRate,
      size: cacheSize
    }
  });
});
```

### System Metrics

#### Cloud Foundry Metrics

**Get App Stats:**
```bash
cf app cloud-llm-hub-srv --guid | xargs cf curl /v2/apps/{guid}/stats
```

**Response:**
```json
{
  "0": {
    "stats": {
      "usage": {
        "time": "2025-11-05T12:00:00Z",
        "cpu": 0.5,
        "mem": 524288000,
        "disk": 1048576000
      },
      "name": "cloud-llm-hub-srv",
      "uris": ["cloud-llm-hub-srv.cfapps.eu10.hana.ondemand.com"],
      "host": "10.0.0.1",
      "port": 8080,
      "uptime": 3600,
      "mem_quota": 1073741824,
      "disk_quota": 2147483648,
      "fds_quota": 16384
    }
  }
}
```

---

## 🔧 Monitoring Tools

### Recommended Tools

#### Application Performance Monitoring (APM)

- **New Relic** - Full APM solution
- **Datadog** - Infrastructure and APM
- **AppDynamics** - Enterprise APM
- **SAP Application Performance Management** - SAP-specific

#### Log Management

- **ELK Stack** - Open source log management
- **Splunk** - Enterprise log management
- **CloudWatch Logs** - AWS-native
- **Cloud Foundry Log Streaming** - CF-native

#### Metrics & Dashboards

- **Prometheus + Grafana** - Open source metrics
- **Datadog** - Metrics and dashboards
- **CloudWatch** - AWS-native
- **SAP Cloud Platform Monitoring** - SAP-native

---

## 📋 Monitoring Checklist

### Daily Checks

- [ ] Health endpoint status
- [ ] Error rate < 1%
- [ ] Response time P95 < 2s
- [ ] No critical alerts

### Weekly Reviews

- [ ] Review error logs
- [ ] Check resource usage trends
- [ ] Review cache performance
- [ ] Check SAP connectivity
- [ ] Review authentication metrics

### Monthly Reviews

- [ ] Capacity planning
- [ ] Performance optimization
- [ ] Alert tuning
- [ ] Dashboard updates
- [ ] Documentation updates

---

## 📚 Additional Resources

- [Operations Guide](OPERATIONS.md) - Operational procedures
- [Troubleshooting Guide](TROUBLESHOOTING.md) - Common issues
- [API Reference](API_REFERENCE.md) - API documentation

---

**Last Updated:** 2025-11-05  
**Version:** 1.0

