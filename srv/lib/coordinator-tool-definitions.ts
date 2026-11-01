import { z } from 'zod';
import { getAvailableDestinations } from './btp-destinations';

/**
 * The contract. Read by the connecting MCP client (the planner/controller) the
 * moment it lists tools — this is what makes the role split self-documenting.
 */
export const EXECUTE_STEP_DESCRIPTION = [
  'Delegate ONE step to the ABAP/SAP executor agent — describe the OUTCOME you want, and get its result.',
  '',
  'You say WHAT, the executor decides HOW. State the goal in plain business/domain terms. Do NOT prescribe the approach — do not name SAP transactions, GUI steps, MCP tools, function modules, or endpoints. Your theoretical knowledge of HOW something is usually done in SAP (e.g. "run ST22", "use SE11") is very likely WRONG here: the executor works through ADT and picks the right tool itself — telling it HOW only pushes it down a wrong path. Name the subject/outcome (the WHAT — e.g. "the latest short dumps", "table VBAK’s definition"), never the method (the HOW). If it cannot do something, it will tell you.',
  '',
  'Roles. The agent is a capable ABAP executor: it knows the system and selects the right MCP tools by analysing your request, but it does NOT plan. It continues the conversation and ABAP connection (debugger, locks) when given a session. YOU are the planner and controller.',
  '',
  'Two kinds of knowledge — keep them apart. GENERAL ABAP knowledge (the language, RAP, CDS, DDIC, the patterns) is yours to bring: if your client supports skills, load `sap-abap` from the `sap-skills` marketplace (invoke it as `sap-abap:sap-abap`) — that exact one, the marketplace ships ~33 similarly named SAP plugins (`sap-abap-cds`, `sap-sqlscript`, `sap-cap-capire` …) which are not it. CONCRETE knowledge about THIS system — what actually exists in it, how it really behaves, which tool reaches it — belongs to the executor, not to you. So use the skill to decide WHAT to build and to write any source you hand over; never use it to prescribe HOW the executor should reach the system.',
  '',
  'ONE object per step — keep every step MINIMAL. Keep one object per step, including when several steps share a session. NEVER batch several objects into a single step: a long step can exceed the client timeout, and a step cut mid-flight leaves objects created-but-INACTIVE and LOCKED by the orphaned session — which then blocks every later attempt to activate them.',
  '',
  'Parallel is allowed — sequencing is only for real dependencies. Steps that do not depend on each other’s result MAY be dispatched in parallel; only a step that needs a previous step’s outcome waits for it. Do not serialise work that has no dependency between its parts.',
  '',
  'Step granularity — always CREATE without activating, ACTIVATE in a separate step. Creating and activating are separate concerns, and combining them in one step is unreliable: a create-and-activate in a single call leaves the ABAP edit-session open when it activates, so the object can be left INACTIVE and reporting "currently being edited" — do NOT ask for "create and activate" in one step. For EVERY object: (1) create it WITHOUT activating (independent objects — domains, data elements, tables — may be created in parallel steps); (2) then ACTIVATE it in a SEPARATE step. Independent objects can each be activated in their own step. Mutually dependent objects (e.g. CDS views linked by composition, a projection view with its behavior definition and implementation) must be created first (each in its own step, without activating) and then activated TOGETHER in ONE shared activation step once all of them exist. Group activation applies only to genuinely co-dependent objects; the create-then-activate split applies to everything.',
  '',
  'Example — building a RAP business object, one object per step in dependency order, always create-without-activate then activate separately: (1) create each domain (own step, parallel) then activate each; (2) create each data element (parallel) then activate, after the domains are active; (3) create then activate each table/structure; (4) create then activate each CDS interface view; (5) create the CDS projection view, its behavior definition and its behavior implementation — each in its OWN step, parallel, WITHOUT activating — then ONE step that activates all three together (mutually dependent, consistent only as a unit); (6) service definition (create, then activate); (7) service binding. Minimal steps throughout; only the mutually dependent set shares an activation step, but no object is created-and-activated in the same step.',
  '',
  "Verify after every step — do NOT trust a step's reply alone. Creating and activating ABAP objects can take time and may not finish (or may fail) even when the step returned text. So after each step run SEPARATE verification step(s) that check the state that step was SUPPOSED to reach: after a CREATE step (which does NOT activate), check the object EXISTS — inactive is the CORRECT expected state there, so never poll it for ACTIVE; after an ACTIVATE step, check the object (or the whole co-dependent set) is ACTIVE. Give it a little time first, then re-check a FEW times (poll) until you confirm the expected state, or you get an error. Only move on once the current step is verified in its expected state. On a confirmed error, analyse it and REACT — fix and retry, change the plan, or ask the user what to do — do not push on as if it succeeded.",
  '',
  'How to use:',
  '- Plan: split the goal into MINIMAL steps that each express ONE concrete outcome for ONE object; one call per step. Mark which steps are independent (dispatch those in parallel) and which must wait for another step’s result. Where a set of objects only becomes consistent as a unit, plan their creates as separate parallel steps and ONE shared activation step after all of them finish. Keep each step about WHAT, not HOW.',
  '- Pick the system: `destination` is OPTIONAL. If THIS MCP server is already bound to one system (a default `X-SAP-Destination` is configured for the connection), omit it — every step runs there. Pass `destination` only when ONE connection can reach several systems and you want to choose per call (see `list_destinations`). To compare two systems, the usual setup is two MCP servers (one per system) — route by server, not by this argument.',
  '- ANALYSE each response before the next step; the executor can err or hallucinate. An impossible request answered confidently is an error or a problem, not success — surface it; do not accept the hallucination.',
  '- CORRECT the plan from what the executor actually returns; do not assume success just because text came back.',
  '',
  'For multi-step work call `session_open` first, pass its key as `session` in every call, and call `session_close` when done. With `session`, execute_step continues the conversation and ABAP connection (debugger, locks). Calls of one session run one after another. Without `session`, each call is independent as before.',
  '',
  'Every result with known usage ends with [usage] prompt=<n> completion=<n> total=<n> time=<seconds>s (one decimal) and includes structuredContent.usage. structuredContent.result holds the reply text. EMPTY_RESULT means the executor replied nothing. When a reviewer runs, its tokens are separate in structuredContent.usage_reviewer and reviewer=<n> in the footer. Use it to track and budget what the executor spends across your plan.',
].join('\n');

export const executeStepSchema = {
  session: z
    .string()
    .optional()
    .describe('Session key returned by session_open.'),
  destination: z
    .string()
    .optional()
    .describe(
      'OPTIONAL. The SAP system to run this step against (a destination name from list_destinations). Omit it when this MCP server is already bound to a system via a default `X-SAP-Destination` header; only pass it when one connection can reach several systems.',
    ),
  worker: z
    .string()
    .optional()
    .describe('Worker profile name; defaults to executor.'),
  task: z
    .string()
    .describe(
      'What outcome you want (the WHAT, in plain domain terms — not the HOW).',
    ),
};

export const listDestinationsDefinition = {
  description:
    'List the SAP systems (destinations) this instance can reach. Pick one and pass its `name` as the `destination` argument of execute_step. Reachability is confirmed when you actually run a step ? if a destination is down the executor reports it.',
  inputSchema: {},
};

export async function listDestinations() {
  const dests = await getAvailableDestinations();
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            destinations: dests.map(({ name, proxyType, authentication }) => ({
              name,
              proxyType,
              authentication,
            })),
          },
          null,
          2,
        ),
      },
    ],
  };
}
