# What Is CALM Dump Analyzer

CALM Dump Analyzer is a lightweight SAP CAP service that acts as a bridge between SAP Cloud ALM (CALM) Event Management and cloud-llm-hub AI agent.

## Problem

When an ABAP runtime error (dump) occurs in an SAP system, CALM Event Management detects it and can trigger an alert. Traditionally, a basis administrator would manually:

1. Log into the SAP system
2. Open transaction ST22
3. Read the dump details
4. Analyze the source code
5. Determine the root cause
6. Write up recommendations

This is time-consuming and requires deep ABAP knowledge.

## Solution

This service automates the analysis:

1. CALM sends the dump event payload to this service
2. The service extracts key fields (program, error type, user, system)
3. Constructs a prompt and sends it to cloud-llm-hub
4. cloud-llm-hub's SmartAgent uses MCP tools to:
   - Read the actual dump from the SAP system (ReadDump)
   - Read the source code around the error (ReadClass/ReadReport)
   - Query RAG for known patterns and solutions
5. The LLM analyzes everything and returns structured diagnosis
6. This service parses the LLM response and returns clean JSON

## What This Service Does NOT Do

- It does not connect to SAP systems directly — cloud-llm-hub handles that via MCP
- It does not run AI models — cloud-llm-hub handles LLM orchestration via SAP AI Core
- It does not store data — it is a stateless proxy

## Architecture

```
┌──────────────┐     ┌─────────────────────┐     ┌─────────────────┐     ┌───────────┐
│  SAP Cloud   │     │  CALM Dump Analyzer  │     │  cloud-llm-hub  │     │ SAP ABAP  │
│  ALM (CALM)  │────►│  (this service)      │────►│  SmartAgent     │────►│ System    │
│              │     │                      │     │  + MCP + RAG    │     │ (via MCP) │
│  Event Mgmt  │     │  CAP OData service   │     │  + LLM          │     │           │
└──────────────┘     └─────────────────────┘     └─────────────────┘     └───────────┘
     alert               parse + prompt              analyze                read dump
                          + format result             + tools                + source
```

## When to Use

- Automated dump triage in CI/CD pipelines
- CALM alert enrichment with AI-powered analysis
- Integration Suite scenarios that need dump analysis
- Any consumer that wants structured JSON instead of raw LLM text
