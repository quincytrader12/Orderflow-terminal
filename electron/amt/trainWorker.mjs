// Worker thread for training: holds the trade columns once, then evaluates
// one candidate parameter set per message.
import { parentPort } from 'node:worker_threads';
import { paperFill } from './engine.mjs';
import { evaluate } from './train.mjs';

let cols = null;
let daily = null;
parentPort.on('message', async (m) => {
  if (m.type === 'data') {
    cols = m.cols;
    daily = m.daily ?? null;
    return;
  }
  try {
    let last = 0;
    const result = await evaluate(m.params, cols, m.splitT, {
      fill: paperFill,
      minTrades: m.minTrades,
      daily,
      // progress inside a candidate, a few times per run
      onProgress: (f) => {
        if (f - last >= 0.1 || f === 1) {
          last = f;
          parentPort.postMessage({ tick: f });
        }
      },
    });
    parentPort.postMessage({ result });
  } catch (e) {
    parentPort.postMessage({ error: String(e?.message ?? e) });
  }
});
