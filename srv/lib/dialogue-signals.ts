import {
  DIALOGUE_SIGNALS_VERSION,
  type DialogueSignals,
  type ISignalBus,
} from '@mcp-abap-adt/llm-agent';
import { createSignalBus } from '@mcp-abap-adt/llm-signals';
import cds from '@sap/cds';

if (!(DIALOGUE_SIGNALS_VERSION >= 1))
  throw new Error('Dialogue signals version 1 or later is required');

let bus: ISignalBus<DialogueSignals> | undefined;

export function dialogueSignals(): ISignalBus<DialogueSignals> {
  bus ??= createSignalBus<DialogueSignals>({
    onHandlerError: (_error, signal) => {
      cds.log('dialogue-signals').warn(signal.name);
    },
  });
  return bus;
}

export function setDialogueSignalsForTest(
  value: ISignalBus<DialogueSignals> | undefined,
): void {
  bus = value;
}
