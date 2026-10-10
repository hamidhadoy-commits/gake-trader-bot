import {runNetlifyReferenceCanary} from './netlify-reference-feed.js';
const KIND = "GAKE_PAPER_CRON_V1";
const CRON = "* * * * *";
export function withPaperCronQueue(worker, {canary = runNetlifyReferenceCanary} = {}) {
  return {
    ...worker,
    async scheduled(controller, env) {
      if (!env?.PAPER_CRON_QUEUE) throw new Error("PAPER_CRON_QUEUE binding missing");
      const scheduledTime = controller?.scheduledTime;
      if (!Number.isSafeInteger(scheduledTime) || scheduledTime <= 0 || controller?.cron !== CRON)
        throw new Error("Invalid paper cron event");
      await env.PAPER_CRON_QUEUE.send({kind: KIND, cron: CRON, scheduledTime});
      console.log({message: "PAPER CRON QUEUED", scheduledTime, execution: "DISABLED", realMoney: false});
    },
    async queue(batch, env, ctx) {
      if (!env?.DB) throw new Error("DB binding missing");
      for (const message of batch.messages) {
        const body = message.body;
        if (body?.kind !== KIND || body.cron !== CRON ||
            !Number.isSafeInteger(body.scheduledTime) || body.scheduledTime <= 0) {
          message.ack();
          console.error({message: "INVALID PAPER CRON MESSAGE", execution: "DISABLED", realMoney: false});
          continue;
        }
        const id = CRON + ":" + body.scheduledTime;
        const claim = await env.DB.prepare(
          "INSERT OR IGNORE INTO paper_cron_queue_runs(id, scheduled_time, status, started_at) VALUES (?, ?, 'STARTED', ?)"
        ).bind(id, body.scheduledTime, new Date().toISOString()).run();
        if (!claim.meta.changes) {
          message.ack();
          console.log({message: "DUPLICATE PAPER CRON SKIPPED", scheduledTime: body.scheduledTime});
          continue;
        }
        // A claimed delivery is never replayed: a partially completed paper cycle
        // is followed by the next minute's cycle, as with the original cron.
        try {
          // Bounded read-only canary. Its failure cannot stop the paper cycle.
          try { await canary(env, body.scheduledTime); }
          catch { console.warn({message:'NETLIFY CANARY ISOLATED FAILURE'}); }
          await worker.scheduled({cron: CRON, scheduledTime: body.scheduledTime}, env, ctx);
          await env.DB.prepare(
            "UPDATE paper_cron_queue_runs SET status = 'COMPLETE', finished_at = ? WHERE id = ?"
          ).bind(new Date().toISOString(), id).run();
          message.ack();
          console.log({message: "PAPER CRON QUEUE COMPLETE", scheduledTime: body.scheduledTime,
            execution: "DISABLED", realMoney: false});
        } catch (error) {
          message.ack();
          console.error({message: "PAPER CRON QUEUE FAILED", scheduledTime: body.scheduledTime,
            error: String(error), execution: "DISABLED", realMoney: false});
          throw error;
        }
      }
    }
  };
}
