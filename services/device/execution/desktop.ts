import { captureWindow, clickApp, observeApp, type ObservationConfig } from '../../../packages/computer-use/observe.ts';
import type { RunOutcome } from '../../../packages/protocol/task.ts';

export async function executeDesktopAction(
  config: ObservationConfig,
  root: string,
  goal: string,
  signal: AbortSignal,
  authorize: Parameters<typeof clickApp>[4],
  expectedText?: string,
): Promise<RunOutcome> {
  const visual = /^\/observe ([a-z0-9_-]{1,32}) --window (w-[0-9]{1,20}) --instance ([a-f0-9]{64}) --visual$/.exec(goal);
  if (visual) {
    const image = await captureWindow(config, root, visual[1], visual[2], visual[3], signal);
    return {
      status: 'succeeded',
      result: 'Window image is available for five minutes.',
      artifact: { name: 'window.png', mime: 'image/png', text: image.toString('base64') },
    };
  }

  const click = goal.startsWith('/click ');
  const text = click ? await clickApp(config, root, goal, signal, authorize, expectedText)
    : await observeApp(config, root, goal, signal);
  if (!click && expectedText && !text.includes(expectedText)) {
    return { status: 'failed', result: 'The target window did not contain the expected visible text.' };
  }
  const windowInventory = /^\/observe [a-z0-9_-]{1,32} --windows-json$/.test(goal);
  return {
    status: 'succeeded',
    result: windowInventory ? text : click ? 'Application action completed.' : 'Application snapshot is ready.',
    artifact: { name: 'application-observation.txt', text },
  };
}
