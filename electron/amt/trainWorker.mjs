// Worker thread for training: holds the trade columns once, then evaluates
// one candidate parameter set per message.
import { parentPort } from 'node:worker_threads';
import { paperFill } from './engine.mjs';
import { evaluate } from './train.mjs';

let cols = null;
parentPort.on('message', async (m) => {
  if (m.type === 'data') {
    cols = m.cols;
    return;
  }
  try {
    const result = await evaluate(m.params, cols, m.splitT, { fill: paperFill, minTrades: m.minTrades });
    parentPort.postMessage({ result });
  } catch (e) {
    parentPort.postMessage({ error: String(e?.message ?? e) });
  }
});
