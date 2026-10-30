import type { ISmartAgent } from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  PlannerToolsClient,
} from '@mcp-abap-adt/llm-agent-libs';
import { AgentProfileRunner } from '../../srv/lib/agent-profile-runner';
import { AgentProfileSource } from '../../srv/lib/agent-profile-source';
import { CollectionRegistry } from '../../srv/rag-collections';
import { profileToolAllowed } from '../../srv/request-session';

test('dialogue discovers arbitrary names, resolves planner variants and executes a legacy checker plan', async () => {
  const registry = new CollectionRegistry();
  await registry.seedAgentConfiguration('agents', 'planner');
  await registry.addDocument('agents', {
    id: 'research_42',
    text: 'CUSTOM_BODY',
    metadata: {
      canonicalKey: 'research_42',
      name: 'research_42',
      kind: 'profile',
      description: 'Custom evidence reader',
      tools: 'read-only',
      result: 'report',
    },
  });
  await registry.addDocument('agents', {
    id: 'planner-custom',
    text: 'VARIANT_BODY',
    metadata: {
      canonicalKey: 'planner-custom',
      name: 'planner-custom',
      kind: 'planner',
    },
  });
  const source = new AgentProfileSource(registry, {
    userId: 'reader',
    globalCollectionId: 'agents',
    selectedCollectionId: () => 'agents',
    plannerRecord: 'planner-custom',
    timeoutMs: 3000,
  });
  const built: { name: string; preamble: string }[] = [];
  const plannerTexts: string[] = [];
  let phase = 0;
  let session: DialogueSession | undefined;
  const planner: ISmartAgent = {
    process: async () => {
      const tools = new PlannerToolsClient();
      if (phase === 0) {
        phase = 1;
        const plan = await tools.callTool('update_plan', {
          status: 'active',
          steps: [
            {
              id: 'research',
              worker: 'research_42',
              goal: 'Read evidence',
              state: 'pending',
            },
            // Persisted legacy plans omit result; checker retains verdict behavior.
            {
              id: 'verify',
              worker: 'checker',
              goal: 'Check evidence',
              dependsOn: ['research'],
              state: 'pending',
            },
          ],
        });
        expect(plan.ok).toBe(true);
        await tools.callTool('delegate_task', {
          step_id: 'research',
          worker: 'research_42',
          goal: 'Read evidence',
        });
      } else if (
        phase === 1 &&
        session
          ?.snapshot()
          .tasks.some(
            (task) => task.worker === 'research_42' && task.state === 'done',
          )
      ) {
        phase = 2;
        await tools.callTool('delegate_task', {
          step_id: 'verify',
          worker: 'checker',
          goal: 'Check evidence',
        });
      }
      return {
        ok: true,
        value: {
          content: 'NO_MESSAGE',
          iterations: 1,
          toolCallCount: 0,
          stopReason: 'stop',
        },
      };
    },
    streamProcess: async function* () {},
  };
  const runner = new AgentProfileRunner({
    catalogue: () => [
      { name: 'Read', effect: 'read' },
      { name: 'Write', effect: 'write' },
    ],
    grants: () => new Set(['Read', 'Write']),
    buildWorker: async (profile, preamble) => {
      built.push({ name: profile.name, preamble });
      return {
        name: profile.name,
        description: profile.description,
        capabilities: { contextPolicy: 'optional' },
        run: async () => {
          expect(profileToolAllowed('Read')).toBe(true);
          expect(profileToolAllowed('Write')).toBe(false);
          return {
            output:
              profile.result === 'verdict' ? '{"verdict":"pass"}' : 'Evidence',
          };
        },
      };
    },
    buildPlanner: async (text) => {
      plannerTexts.push(text);
      return planner;
    },
  });
  session = await DialogueSession.open({
    id: 'profiles-dialogue',
    profileSource: source,
    profileRunner: runner,
    profileTimeoutMs: 3000,
    board: { maxConcurrent: 1 },
    maxCorrections: 0,
  });
  try {
    await session.send('Research and verify');
    for (
      let attempt = 0;
      attempt < 1000 &&
      session.snapshot().tasks.filter((task) => task.state === 'done').length <
        2;
      attempt++
    )
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      session
        .snapshot()
        .tasks.map((task) => [task.worker, task.result, task.state]),
    ).toEqual([
      ['research_42', 'report', 'done'],
      ['checker', 'verdict', 'done'],
    ]);
    expect(built.map((entry) => entry.name)).toEqual([
      'research_42',
      'checker',
    ]);
    expect(built[0].preamble).toContain('CUSTOM_BODY');
    expect(
      built.every((entry) => !entry.preamble.includes('fails twice')),
    ).toBe(true);
    expect(plannerTexts.length).toBeGreaterThan(0);
    expect(plannerTexts.every((text) => text.startsWith('VARIANT_BODY'))).toBe(
      true,
    );
  } finally {
    await session.close();
  }
});
