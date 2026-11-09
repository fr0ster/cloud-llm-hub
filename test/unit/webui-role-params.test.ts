import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');
const start = html.indexOf('function renderLlmParams(');
const script = html.slice(
  start,
  html.indexOf('function renderLlmSettings(', start),
);

test.each([true, false])(
  'effective parameters remain visible and read-only (catalogue=%s)',
  (catalogue) => {
    const target = { innerHTML: '' };
    runInNewContext(`${script}; renderLlmParams('executor', null);`, {
      document: { getElementById: () => target },
      escapeHtml: (text: string) => text,
      llmSnapshot: {
        effective: {
          executor: {
            model: null,
            params: {
              temperature: { value: 0.7, source: 'default' },
              maxOutputTokens: { value: 4096, source: 'config' },
            },
          },
        },
        capabilities: catalogue
          ? {
              null: {
                params: [
                  { name: 'temperature' },
                  { name: 'maxOutputTokens', canDisable: true },
                  { name: 'topP' },
                ],
              },
            }
          : {},
      },
    });
    expect(target.innerHTML).toContain(
      'readonly value="0.7 (source: default)"',
    );
    expect(target.innerHTML).toContain(
      'readonly value="4096 (source: config)"',
    );
    if (catalogue) {
      expect(target.innerHTML).toContain('Not sent by hub');
      expect(target.innerHTML).toContain('type="checkbox" disabled');
    }
    expect(target.innerHTML).not.toContain('Not exposed by API');
  },
);
