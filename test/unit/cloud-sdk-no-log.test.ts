import { registerDestination } from '@sap-cloud-sdk/connectivity';
import axios from 'axios';
import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';
import { applyLoggingConfig } from '../../srv/lib/logging-config';

it('keeps noLog request headers out of logs with SAP Cloud SDK debug enabled', async () => {
  const url = 'https://sap.example.test';
  const destinationName = 'ABAP_GIT_LOG_TEST';
  const username = 'ABAP_GIT_USERNAME_SENTINEL';
  const password = 'ABAP_GIT_PASSWORD_SENTINEL';
  const logOutput = [
    jest.spyOn(process.stdout, 'write').mockReturnValue(true),
    jest.spyOn(process.stderr, 'write').mockReturnValue(true),
  ];
  const request = jest.spyOn(axios, 'request').mockResolvedValue({
    status: 200,
    data: '',
    headers: { 'x-csrf-token': 'csrf-token' },
  });
  const connection = new CloudSdkAbapConnection(
    { url, authType: 'basic', client: '600' },
    destinationName,
  );

  try {
    applyLoggingConfig({
      LLM_AGENT_LOG_LEVEL: 'debug',
      LLM_AGENT_LOG_LEVELS: 'sap-cloud-sdk=debug',
    });
    await registerDestination({ name: destinationName, url });
    const response = await connection.makeAdtRequest({
      url: '/sap/bc/adt/abapgit/repos',
      method: 'POST',
      headers: { Username: username, Password: password },
      timeout: 0,
      noLog: true,
      noResend: true,
      stateless: true,
    });

    expect(response.status).toBe(200);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          Username: username,
          Password: password,
        }),
      }),
    );
    const logs = logOutput
      .flatMap((output) => output.mock.calls.map(([chunk]) => String(chunk)))
      .join('');
    expect(logs).toContain('Method is GET no CSRF token needed.');
    expect(logs).not.toContain(username);
    expect(logs).not.toContain(password);
  } finally {
    connection.reset();
    jest.restoreAllMocks();
  }
});
