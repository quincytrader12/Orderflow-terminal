// Worker thread for training: loads the recorded trades (off the main thread),
// holds the trade columns once, then evaluates one candidate parameter set per message.
import { parentPort } from 'node:worker_threads';
import { readColumnsFromFile } from '../db.mjs';
import { paperFill } from './engine.mjs';
import { evaluate } from './train.mjs';

let cols = null;
let daily = null;
parentPort.on('message', async (m) => {
  if (m.type === 'load') {
    // read the recorded trades here, off the app's main thread
    try {
      const c = await readColumnsFromFile(m.file, m.venue, m.symbol, m.from, m.to, m.limit);
      parentPort.postMessage({ cols: c });
    } catch (e) {
      parentPort.postMessage({ error: String(e?.message ?? e) });
    }
    return;
  }
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
