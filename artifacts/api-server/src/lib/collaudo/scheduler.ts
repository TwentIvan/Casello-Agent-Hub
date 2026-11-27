// Avvio del collaudo dei lavori: avvisi del protocollo (claim e report) e controllo ogni 60 s (sweeper, poi lancio dei collaudi in
// coda). All'avvio i collaudi `running` restano: li chiude la lease o il report; i `dispatching` li chiude lo sweeper.

import { logger } from "../logger";
import { setOnTestClaimed, setOnTestReported } from "./protocol";
import { onTestClaimed, onTestReported, scheduleReleaseTests, sweepReleaseTests } from "./service";

export const COLLAUDO_SWEEP_MS = 60_000;

export function startCollaudoScheduler(): () => void {
  setOnTestClaimed(onTestClaimed);
  setOnTestReported(onTestReported);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepReleaseTests();
      await scheduleReleaseTests();
    } catch (err) {
      logger.error({ errName: err instanceof Error ? err.name : "unknown" }, "Controllo dei collaudi non riuscito");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), COLLAUDO_SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
