import { HubError } from './llm-failure';

export class RagWriteError extends HubError {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
