import {
  anthropicDoorRefusal,
  anthropicSessionClosed,
  type DoorRefusalReason,
  doorRefusalSentence,
  executeStepDoorRefusal,
  openAiDoorRefusal,
  openAiSessionClosed,
  sessionClosedText,
} from '../../srv/lib/throttle-surfacing';

const REASONS: DoorRefusalReason[] = ['session_busy', 'capacity', 'retention'];

describe.each(REASONS)('refusing for %s', (reason) => {
  it('speaks the OpenAI envelope with a code a program can branch on', () => {
    expect(openAiDoorRefusal(reason)).toEqual({
      status: 503,
      body: {
        error: {
          message: doorRefusalSentence(reason),
          type: 'server_error',
          code: `gatekeeper_${reason}`,
        },
      },
    });
  });

  it("speaks Anthropic's overloaded_error under 529, the reason in the sentence", () => {
    expect(anthropicDoorRefusal(reason)).toEqual({
      status: 529,
      body: {
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: doorRefusalSentence(reason),
        },
      },
    });
  });

  it('gives execute_step a prefixed line a planner can branch on without parsing prose', () => {
    expect(executeStepDoorRefusal(reason)).toBe(
      `gatekeeper_${reason}: ${doorRefusalSentence(reason)}`,
    );
  });

  it('carries no number anywhere', () => {
    for (const text of [
      JSON.stringify(openAiDoorRefusal(reason).body),
      JSON.stringify(anthropicDoorRefusal(reason).body),
      executeStepDoorRefusal(reason),
    ]) {
      expect(text).not.toMatch(/\d/);
    }
  });
});

describe('the sentences say what is missing, and only that', () => {
  it('retention never mentions pipelines, and capacity never mentions memory', () => {
    // The wrong one sends an operator to tune the wrong variable.
    expect(doorRefusalSentence('retention')).not.toMatch(/pipeline|capacity/i);
    expect(doorRefusalSentence('capacity')).not.toMatch(
      /memory|hold another session/i,
    );
  });
});

describe('a session closed under the request', () => {
  it('is 410 in both chat dialects, with the sentence RAG uses', () => {
    expect(openAiSessionClosed()).toEqual({
      status: 410,
      body: {
        error: {
          message: sessionClosedText(),
          type: 'invalid_request_error',
          code: 'session_closed',
        },
      },
    });
    expect(anthropicSessionClosed()).toEqual({
      status: 410,
      body: {
        type: 'error',
        error: { type: 'invalid_request_error', message: sessionClosedText() },
      },
    });
  });
});
