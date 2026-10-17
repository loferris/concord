import { NativeConnection, Worker } from '@temporalio/worker';
import { loadEnv, useFakeModel } from './env';
import * as activities from './activities';
import { TASK_QUEUES } from './config';

async function main() {
  loadEnv();
  console.log(`[worker] model backend: ${useFakeModel() ? 'FAKE (CRUSOE_API_KEY unset or FAKE_LLM=1)' : 'crusoe'}`);
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const workflowsPath = require.resolve('./workflows');

  // Concurrency lives here, per task queue (Crusoe limits are per model per minute).
  const workers = await Promise.all([
    Worker.create({ connection, taskQueue: TASK_QUEUES.workflows, workflowsPath }),
    Worker.create({ connection, taskQueue: TASK_QUEUES.fast, activities, maxConcurrentActivityTaskExecutions: 4 }),
    Worker.create({ connection, taskQueue: TASK_QUEUES.smart, activities, maxConcurrentActivityTaskExecutions: 2 }),
  ]);
  console.log(`[worker] listening on queues: ${Object.values(TASK_QUEUES).join(', ')}`);
  await Promise.all(workers.map((w) => w.run()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
