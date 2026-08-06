# Cloud LLM Hub — Deployment Readiness Questionnaire

This questionnaire collects the information needed to plan a Cloud LLM Hub deployment in your
landscape: which SAP BTP resources exist, which LLM we may use, whether AI usage is permitted, and
which SAP systems the solution will connect to.

**How to fill it in**

- Answer in the `Answer` column. Free text is fine — the options in brackets are only a hint.
- **"Unknown" is a valid answer.** It tells us where to dig; a guess does not.
- If an answer differs per system or per environment, say so (for example: "Yes for DEV, no for PRD").
- Name the responsible person for each section where you can — most delays come from not knowing
  whom to ask.
- You do not need every answer before we talk. Partial answers are useful.

---

## 1. SAP BTP and Infrastructure

Owner / contact: ______________________

| # | Question | Answer |
|---|----------|--------|
| 1.1 | Is an SAP BTP subaccount available for this deployment? (Yes / No / Unknown) | |
| 1.2 | Is the Cloud Foundry environment enabled in that subaccount? (Yes / No / Unknown) | |
| 1.3 | Which region / landscape is the subaccount in? (for example eu10, eu20, us10) | |
| 1.4 | Which of these entitlements are already assigned to the subaccount: Authorization and Trust Management (XSUAA, plan `application`), Destination (plan `lite`), Connectivity (plan `lite`), SAP AI Core (plan `extended`), Cloud Foundry runtime quota (at least 2.5 GB free per environment)? | |
| 1.5 | Who can assign missing entitlements (Global Account admin), and what is the typical lead time for such a request? | |
| 1.6 | How many environments should the solution be deployed to? (DEV only / DEV + QA / DEV + QA + PROD) | |
| 1.7 | Is a Cloud Foundry space available, or does one need to be created? Who has Space Developer rights? | |
| 1.8 | Is a custom domain required for the web UI, or is the default `*.cfapps.<region>.hana.ondemand.com` acceptable? | |
| 1.9 | Are there network restrictions on outbound HTTPS traffic from the subaccount (for example an egress proxy or allowlist)? | |

---

## 2. LLM Provider and Models

Owner / contact: ______________________

| # | Question | Answer |
|---|----------|--------|
| 2.1 | Is SAP AI Core available — entitlement assigned and an instance provisioned? (Yes / No / Unknown) | |
| 2.2 | Which LLM models are already deployed in SAP AI Launchpad? Please list the exact model IDs (for example `anthropic--claude-4.5-sonnet`, `gpt-4.1-mini`). | |
| 2.3 | Is an embedding model deployed (for example `text-embedding-3-small`)? Which one? | |
| 2.4 | If SAP AI Core is not available: is there another LLM API we may use? (OpenAI / Azure OpenAI / Anthropic / Google / self-hosted Ollama or vLLM / other) | |
| 2.5 | For that API — what is the base URL, and who owns the API key? Please name the owner only; **do not write the key itself into this document.** | |
| 2.6 | Which interface does that API expose? (OpenAI-compatible `/chat/completions` / the native Anthropic API / the native DeepSeek API / something else — please describe) | |
| 2.7 | Is a self-hosted model an option (Ollama, vLLM, or similar running inside your network)? Is the hardware for it available? | |
| 2.8 | Who pays for token consumption, and is there a budget or quota cap we must stay under? | |
| 2.9 | Are there rate limits, request quotas, or concurrency limits on the LLM API we should plan for? | |
| 2.10 | Is there a preferred or mandated model (for example, only models hosted in the EU, or only a specific vendor)? | |

---

## 3. AI Usage Permission and Compliance

Owner / contact: ______________________

| # | Question | Answer |
|---|----------|--------|
| 3.1 | Does your organization have an approved policy for the use of generative AI? Is it already in force, or still being drafted? | |
| 3.2 | Is sending **ABAP source code** to an LLM permitted? (Yes / No / Only for non-production systems / Unknown) | |
| 3.3 | Is sending **business data** — table contents, short dumps, application logs — to an LLM permitted? If it is restricted, which systems or clients are in scope? (for example: DEV and QA only, never production data) | |
| 3.4 | Are there data residency requirements for LLM processing? (EU only / a specific region / no restriction) | |
| 3.5 | Is a Data Processing Agreement or equivalent contract with the LLM vendor already in place, or does it still need to be signed? | |
| 3.6 | Is there an AI review board, architecture board, or similar approval body that must sign off? What is its typical lead time? | |
| 3.7 | Is audit logging of AI interactions (prompts, responses, tool calls) required? For how long must it be retained? | |
| 3.8 | Is a security review, architecture review, or penetration test required before production use? | |
| 3.9 | Are there restrictions on where the solution may run — for example, must it stay inside the corporate network, or is SAP BTP acceptable? | |
| 3.10 | Are there works council, data protection officer, or similar approvals needed because developers' work is processed by an AI system? | |

---

## 4. SAP Systems and Access

Owner / contact: ______________________

| # | Question | Answer |
|---|----------|--------|
| 4.1 | Which SAP systems are in scope? Please list SID, client, product (S/4HANA, ECC, SAP BTP ABAP environment) and release for each. | |
| 4.2 | Are these systems on-premise, hosted, or cloud (SAP BTP ABAP environment / RISE)? | |
| 4.3 | Is a Cloud Connector installed, and is it registered for the target BTP subaccount? (Each subaccount requires its own registration.) | |
| 4.4 | Are the ICF services `/sap/bc/adt` and `/sap/bc/http` activated on the target systems? | |
| 4.5 | Is a technical or communication user available for ADT access, or does one need to be created? Who creates it? | |
| 4.6 | Which authorizations will that user have? (Display only / development / full) | |
| 4.7 | Are **write operations** permitted — creating and changing ABAP objects — or is read-only access required? | |
| 4.8 | Which package and namespace may be used for objects created through the solution? | |
| 4.9 | Is a transport request required for created objects, and who provides it? | |
| 4.10 | Is a developer registration or developer key needed for the technical user on on-premise systems? | |
| 4.11 | Which authentication method should the BTP destination use? (Basic authentication with a technical user / Principal Propagation / other) | |
| 4.12 | Are there change-freeze windows or maintenance windows on these systems? | |

---

## 5. Users, Roles, and Operations

Owner / contact: ______________________

| # | Question | Answer |
|---|----------|--------|
| 5.1 | Who will use the solution, and roughly how many people? (developers, consultants, support, analysts) | |
| 5.2 | Which identity provider does the subaccount trust? (SAP Cloud Identity Services / a corporate IdP via SAML or OIDC / default SAP ID service) | |
| 5.3 | Who assigns role collections to users in the BTP cockpit? | |
| 5.4 | Which access level does each user group need? (Reader — browse and search; Analyst — read plus SQL, dumps, profiling; Developer — create and change objects; Full — everything) | |
| 5.5 | How many concurrent users do you expect at peak? This drives sizing. | |
| 5.6 | Which client tools will connect? (built-in Chat UI / Claude Code CLI / Cline / Claude Desktop / custom integration) | |
| 5.7 | Who operates the solution after go-live? (our team / your team / joint) | |
| 5.8 | Is a formal SLA required for availability and support response? | |
| 5.9 | Is monitoring and alerting required — for example SAP Cloud Logging or Alert Notification service? Are those services entitled? | |
| 5.10 | Who is responsible for applying updates and new releases, and how often? | |

---

## 6. Commercial and Timeline

Owner / contact: ______________________

| # | Question | Answer |
|---|----------|--------|
| 6.1 | What is the intended scope? (proof of concept / pilot with a limited user group / production rollout) | |
| 6.2 | What is the target date for the first working deployment? | |
| 6.3 | Who owns the budget, and who is the technical decision maker? | |
| 6.4 | Please name a contact for each dependency: BTP administrator, SAP Basis, Security and Compliance, SAP AI Core administrator, Cloud Connector administrator. | |
| 6.5 | Are there project milestones, audits, or freeze periods that constrain the schedule? | |
| 6.6 | If the proof of concept succeeds, what does the path to production look like on your side — which approvals and steps are required? | |

---

## Anything else

Is there anything about your landscape, policies, or constraints that the questions above did not
cover, but that would affect this deployment?

______________________________________________________________________________

______________________________________________________________________________
