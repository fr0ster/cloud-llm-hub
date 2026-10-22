import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const xsApp = JSON.parse(
  readFileSync(join(__dirname, '../../app/router/xs-app.json'), 'utf8'),
) as {
  welcomeFile?: string;
  routes: { source: string; localDir?: string; authenticationType?: string }[];
};

describe('approuter xs-app.json', () => {
  it('opens the chat at the root URL', () => {
    expect(xsApp.welcomeFile).toBe('/chat/webapp/index.html');
  });

  it('serves the welcome file from the authenticated chat route', () => {
    const path = xsApp.welcomeFile ?? '';
    const route = xsApp.routes.find((r) => new RegExp(r.source).test(path));
    expect(route).toMatchObject({ localDir: '.', authenticationType: 'xsuaa' });
  });
});
