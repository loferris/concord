import { Client, Connection } from '@temporalio/client';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { loadEnv } from './env';
import { TASK_QUEUES } from './config';
import type { ChapterWorkflowResult } from './workflows';

function newRunId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

async function start(chapterPath: string, runIdArg?: string) {
  const runId = runIdArg ?? newRunId();
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection });
  const chapterName = basename(chapterPath, extname(chapterPath));
  const workflowId = `chapter-${runId}-${chapterName}`;
  console.log(`[cli] runId=${runId} workflowId=${workflowId}`);
  const handle = await client.workflow.start('ChapterWorkflow', {
    taskQueue: TASK_QUEUES.workflows,
    workflowId,
    args: [{ runId, chapterPath }],
  });
  const result = (await handle.result()) as ChapterWorkflowResult;

  console.log('\n[cli] result:');
  console.log(JSON.stringify(result, null, 2));
  const u = result.usage;
  const rate = u.prompt_tokens ? ((100 * u.cached_tokens) / u.prompt_tokens).toFixed(1) : '0.0';
  console.log(`\n[cli] tokens: prompt=${u.prompt_tokens} cached=${u.cached_tokens} (${rate}%) completion=${u.completion_tokens} model=${u.model}`);

  const json = JSON.parse(await readFile(result.translationPath, 'utf8')) as { paragraphs: { id: string; text: string }[] };
  console.log(`\n[cli] first paragraphs of ${result.englishPath}:`);
  for (const p of json.paragraphs.slice(0, 4)) console.log(`  ${p.id}: ${p.text.slice(0, 160)}${p.text.length > 160 ? '…' : ''}`);
  await connection.close();
}

async function main() {
  loadEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'start' && rest[0]) {
    await start(rest[0], rest[1]);
    return;
  }
  console.error('usage: cli start <chapter-file> [runId]');
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
