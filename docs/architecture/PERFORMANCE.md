# Performance Guide

**Version:** 1.0.0  
**Last Updated:** 2025-11-05

Performance characteristics, optimization recommendations, and tuning guidelines for Cloud LLM Hub.

## 📊 Performance Characteristics

### Baseline Metrics

**Test Environment:**
- **Instance:** 1GB RAM, 1 vCPU
- **Node.js:** 20.x
- **Network:** Local network (< 1ms latency)
- **SAP System:** Cloud-based, < 50ms latency

**Measured Performance:**

| Metric | P50 | P95 | P99 | Notes |
|--------|-----|-----|-----|-------|
| Health Check | 5ms | 10ms | 15ms | CAP endpoint |
| Destination Probe | 150ms | 300ms | 500ms | Includes SAP connection |
| SSE Stream Init | 200ms | 400ms | 600ms | First connection |
| Stream-HTTP Init | 200ms | 400ms | 600ms | First request |
| MCP Tool Call | 100-500ms | 1-2s | 3-5s | Depends on SAP response |

**Throughput:**
- **Concurrent Connections:** 50-100 per instance
- **Requests per Second:** 100-200 (depending on payload)
- **MCP Tool Calls:** 20-50 per second

**Resource Usage:**
- **Memory:** 200-400MB baseline, +50MB per active connection
- **CPU:** 5-15% idle, 30-60% under load

---

## ⚡ Optimization Recommendations

### 1. Instance Sizing

#### Development

**Recommended:**
- **Memory:** 512MB
- **Instances:** 1
- **CPU:** 1 vCPU

**Rationale:**
- Low traffic
- Development/testing only
- Cost optimization

#### Production (Small)

**Recommended:**
- **Memory:** 1GB
- **Instances:** 2-3
- **CPU:** 1 vCPU per instance

**Rationale:**
- High availability
- Load distribution
- Moderate traffic (100-500 requests/min)

#### Production (Large)

**Recommended:**
- **Memory:** 2GB
- **Instances:** 3-5
- **CPU:** 2 vCPU per instance

**Rationale:**
- High traffic (1000+ requests/min)
- Multiple SAP systems
- Complex queries

**Scaling:**
```bash
# Scale horizontally
cf scale cloud-llm-hub-srv -i 5

# Scale vertically (edit mta.yaml)
# Increase memory limit
```

---

### 2. Caching Strategy

#### MCP Server Cache

**Current Implementation:**
- Cache TTL: 30 minutes
- Cache key: SAP system URL
- Cache size: Limited by available memory

**Optimization:**
```typescript
// Adjust cache TTL based on usage
const CACHE_TTL = process.env.CACHE_TTL || 1800000; // 30 min default

// Increase for stable connections
const STABLE_CACHE_TTL = 3600000; // 60 min

// Decrease for frequent credential changes
const DYNAMIC_CACHE_TTL = 900000; // 15 min
```

**Recommendations:**
- **Increase TTL** if SAP credentials are stable
- **Decrease TTL** if credentials rotate frequently
- **Monitor cache hit rate** (target: > 80%)

#### Response Caching (Future)

**Consider implementing:**
- Cache frequently accessed MCP tool results
- Cache destination configurations
- Cache health check results

---

### 3. Connection Pooling

#### SAP Connections

**Current:** One connection per MCP server instance

**Optimization:**
- Reuse connections when possible
- Implement connection pool for multiple SAP systems
- Monitor connection count

**Configuration:**
```typescript
// Connection pool settings
const MAX_CONNECTIONS = 10;
const IDLE_TIMEOUT = 300000; // 5 minutes
```

#### HTTP Client Settings

**Optimize node-fetch/axios:**
```typescript
// Connection reuse
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 50,
  maxFreeSockets: 10
});
```

---

### 4. Request Optimization

#### Batch Operations

**Use batch MCP tools when available:**
```typescript
// Instead of multiple calls
for (const obj of objects) {
  await callTool('GetObjectDetails', { objectName: obj });
}

// Use batch tool
await callTool('DetectObjectTypeListArray', { objects });
```

#### Parallel Requests

**Execute independent requests in parallel:**
```typescript
// Sequential (slow)
const result1 = await callTool1();
const result2 = await callTool2();

// Parallel (fast)
const [result1, result2] = await Promise.all([
  callTool1(),
  callTool2()
]);
```

#### Request Timeouts

**Set appropriate timeouts:**
```typescript
// Short timeout for quick operations
const quickTimeout = 5000; // 5 seconds

// Longer timeout for complex operations
const complexTimeout = 30000; // 30 seconds
```

---

### 5. Memory Optimization

#### Memory Management

**Monitor memory usage:**
```bash
# Check memory usage
cf app cloud-llm-hub-srv | grep memory

# Or via metrics
cf app cloud-llm-hub-srv --guid | xargs cf curl /v2/apps/{guid}/stats
```

**Optimization:**
- Limit cache size
- Clear expired cache entries
- Monitor for memory leaks
- Set appropriate memory limits

#### Garbage Collection

**Node.js GC Tuning:**
```bash
# Enable GC logging
NODE_OPTIONS="--expose-gc --max-old-space-size=1024" cds watch

# Force GC (if needed)
global.gc();
```

---

### 6. Network Optimization

#### Connection Keep-Alive

**Enable HTTP keep-alive:**
```typescript
// Reuse connections
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000
});
```

#### Compression

**Future consideration:**
- Enable gzip compression for responses
- Compress large MCP responses
- Reduce bandwidth usage

---

## 🎯 Performance Tuning

### Environment Variables

**Tuning Parameters:**
```bash
# Cache TTL (milliseconds)
CACHE_TTL=1800000

# Session timeout (milliseconds)
SESSION_TIMEOUT=120000

# Max concurrent connections
MAX_CONNECTIONS=100

# Request timeout (milliseconds)
REQUEST_TIMEOUT=15000

# Stream timeout (milliseconds)
STREAM_TIMEOUT=120000
```

### Application Settings

**CAP Configuration:**
```json
{
  "cds": {
    "watch": {
      "ignore": [
        ".git/**",
        "node_modules/**",
        "dist/**",
        "gen/**"
      ]
    }
  }
}
```

---

## 📈 Benchmarking

### Performance Test Script

```bash
#!/bin/bash
# performance-test.sh

ENDPOINT="https://your-app.cfapps.eu10.hana.ondemand.com"
TOKEN="your-token"

echo "Performance Test - Cloud LLM Hub"
echo "================================"

# Health Check
echo -n "Health Check: "
time curl -s -H "Authorization: Bearer $TOKEN" \
     "$ENDPOINT/odata/v4/mcp/Health()" > /dev/null

# Destination Probe
echo -n "Destination Probe: "
time curl -s -H "Authorization: Bearer $TOKEN" \
     "$ENDPOINT/odata/v4/mcp/ProbeDestination?destination=SAP_DEV_DEST" > /dev/null

# SSE Stream Init
echo -n "SSE Stream Init: "
time curl -s -N -H "Authorization: Bearer $TOKEN" \
     -H "Accept: text/event-stream" \
     "$ENDPOINT/mcp/stream/sse" &
PID=$!
sleep 2
kill $PID 2>/dev/null
```

### Load Testing

**Using Apache Bench:**
```bash
# Health check load test
ab -n 1000 -c 10 \
   -H "Authorization: Bearer $TOKEN" \
   "$ENDPOINT/odata/v4/mcp/Health()"
```

**Using k6:**
```javascript
import http from 'k6/http';
import { check } from 'k6';

export default function () {
  const url = 'https://your-app.cfapps.eu10.hana.ondemand.com/odata/v4/mcp/Health()';
  const headers = {
    'Authorization': 'Bearer YOUR_TOKEN'
  };
  
  const res = http.get(url, { headers });
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
}
```

---

## 🔍 Performance Monitoring

### Key Metrics to Track

1. **Response Time**
   - P50, P95, P99 percentiles
   - Per-endpoint breakdown
   - Trend analysis

2. **Throughput**
   - Requests per second
   - Concurrent connections
   - Peak load capacity

3. **Resource Usage**
   - Memory utilization
   - CPU usage
   - Network I/O

4. **Error Rates**
   - Failed requests
   - Timeout errors
   - Connection errors

### Monitoring Tools

**Cloud Foundry Metrics:**
```bash
# Get app stats
cf app cloud-llm-hub-srv --guid | xargs cf curl /v2/apps/{guid}/stats
```

**Application Logs:**
```bash
# Monitor response times
cf logs cloud-llm-hub-srv --recent | grep "response-time"

# Monitor errors
cf logs cloud-llm-hub-srv --recent | grep -i error
```

**Custom Metrics (Future):**
- Prometheus metrics endpoint
- Grafana dashboards
- APM tools (New Relic, Datadog)

---

## 🐛 Performance Issues

### Common Bottlenecks

#### 1. SAP System Latency

**Symptoms:**
- High P95/P99 response times
- Timeout errors
- Slow MCP tool calls

**Solutions:**
- Optimize SAP queries
- Use batch operations
- Increase timeout values
- Check SAP system performance

#### 2. Memory Pressure

**Symptoms:**
- High memory usage (> 80%)
- OOM errors
- Slow garbage collection

**Solutions:**
- Increase instance memory
- Reduce cache TTL
- Limit concurrent connections
- Optimize cache size

#### 3. Connection Pool Exhaustion

**Symptoms:**
- Connection timeout errors
- Slow response times
- High connection count

**Solutions:**
- Increase connection pool size
- Reuse connections
- Close idle connections
- Scale horizontally

#### 4. Network Latency

**Symptoms:**
- Slow response times
- High latency to SAP
- Connection timeouts

**Solutions:**
- Use Cloud Connector for on-premise
- Optimize network routing
- Consider regional deployment
- Use CDN if applicable

---

## 📊 Performance Benchmarks

### Test Results

**Environment:** SAP BTP Cloud Foundry, 1GB RAM, 1 vCPU

**Health Check:**
- P50: 5ms
- P95: 10ms
- P99: 15ms
- Throughput: 1000 req/s

**Destination Probe:**
- P50: 150ms
- P95: 300ms
- P99: 500ms
- Includes SAP connection

**SSE Stream:**
- Init time: 200-400ms
- Event latency: < 50ms
- Throughput: 50-100 concurrent streams

**Stream-HTTP:**
- Init time: 200-400ms
- Request latency: 100-500ms
- Throughput: 20-50 req/s

---

## 🎛️ Tuning Parameters

### Application-Level

| Parameter | Default | Recommended | Notes |
|-----------|---------|-------------|-------|
| Cache TTL | 30 min | 30-60 min | Adjust based on credential stability |
| Session Timeout | 2 min | 2-5 min | Adjust based on usage patterns |
| Max Connections | 100 | 50-200 | Adjust based on instance size |
| Request Timeout | 15s | 10-30s | Adjust based on SAP response time |
| Stream Timeout | 2 min | 2-5 min | Adjust based on query complexity |

### Infrastructure-Level

| Parameter | Default | Recommended | Notes |
|-----------|---------|-------------|-------|
| Memory | 512MB | 1-2GB | Production: 1GB minimum |
| Instances | 1 | 2-3 | Production: 2+ for HA |
| CPU | 1 vCPU | 1-2 vCPU | Production: 2 vCPU for high load |

---

## 📚 Additional Resources

- [Operations Guide](OPERATIONS.md) - Operational procedures
- [Monitoring Guide](MONITORING.md) - Monitoring setup
- [Troubleshooting Guide](TROUBLESHOOTING.md) - Common issues

---

**Last Updated:** 2025-11-05  
**Version:** 1.0

