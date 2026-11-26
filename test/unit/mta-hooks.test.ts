import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

interface Mta {
  modules: {
    name: string;
    hooks?: { name: string }[];
  }[];
}

it('declares a before-start migration task on the hub module', () => {
  const mta = load(
    readFileSync(join(__dirname, '..', '..', 'mta.yaml'), 'utf8'),
  ) as Mta;
  const hub = mta.modules.find(({ name }) => name === 'cloud-llm-hub-srv');
  expect(hub?.hooks).toContainEqual({
    name: 'migrate-embeddings',
    type: 'task',
    phases: ['deploy.application.before-start'],
    parameters: {
      name: 'migrate-embeddings',
      command: 'node srv/migrate-embeddings.js',
      memory: '2048M',
    },
  });
});
