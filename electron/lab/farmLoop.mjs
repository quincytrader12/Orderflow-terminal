// The edge finder's loop, in its own thread: breed, train, test, forward-test —
// one bot at a time, posting its state to the desktop process as it goes.
// Kept apart from the thread wiring (farmWorker.mjs) so tests can drive it.
import { Farm } from "../../src/lab/farm.ts";

const toMarkets = (byTf) =>
  Object.fromEntries(
    Object.entries(byTf ?? {}).map(([tf, ms]) => [
      tf,
      ms.map((m) => ({
        ...m,
        funding: m.funding ? Float64Array.from(m.funding) : null,
      })),
    ]),
  );

/**
 * @param post (msg) => void — posts to the desktop process
 * @param o {{ now?: () => number, sleep?: (ms: number) => Promise<void> }}
 */
export function createFarmRunner(post, o = {}) {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let farm = null;
  let running = false;
  let deployed = [];
  let note = "";
  let looping = null;
  const state = () => farm?.state(running, note, "");
  const send = () => farm && post({ type: "state", state: state() });
  const save = () =>
    farm && post({ type: "save", save: farm.save(), state: state() });

  async function loop() {
    let lastPost = 0;
    let lastSave = now();
    while (running) {
      const t0 = performance.now();
      try {
        farm.step();
      } catch (err) {
        note = `a bot could not be tested: ${String(err?.message ?? err).slice(0, 120)}`;
      }
      const dt = performance.now() - t0;
      if (now() - lastPost > 1500) {
        lastPost = now();
        send();
      }
      if (now() - lastSave > 60_000) {
        lastSave = now();
        save();
      }
      // gentle: rest as long as the work took (about half of one core); full: just let messages in
      await sleep(
        farm.cfg.pace === "full" ? 0 : Math.max(5, Math.min(2000, dt)),
      );
    }
  }

  return {
    async onMessage(msg) {
      if (msg.type === "start") {
        farm = new Farm(msg.cfg, { save: msg.save ?? null, now });
        farm.setMarkets(toMarkets(msg.markets));
        deployed = msg.deployed ?? [];
        farm.checkFleet(deployed);
        note = "";
        running = true;
        send();
        looping = loop();
      } else if (msg.type === "markets" && farm) {
        // fresher candles: the survivors' and the fleet's forward tests move on
        farm.setMarkets(toMarkets(msg.markets));
        farm.checkFleet(deployed);
        send();
        save();
      } else if (msg.type === "fleet" && farm) {
        deployed = msg.deployed ?? [];
        farm.checkFleet(deployed);
        send();
      } else if (msg.type === "stop") {
        running = false;
        await looping;
        if (farm) post({ type: "save", save: farm.save(), state: state() });
        post({ type: "stopped" });
      }
    },
    /** for tests */
    get farm() {
      return farm;
    },
  };
}
