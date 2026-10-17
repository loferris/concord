// Deterministic only: no I/O, no OpenAI import. Text never enters history; activities pass paths.
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';
import { TASK_QUEUES } from './config';
import type { Usage } from './schemas';

const { translateChapter } = proxyActivities<typeof activities>({
  taskQueue: TASK_QUEUES.fast,
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '15 seconds',
  retry: { initialInterval: '2s', backoffCoefficient: 2, maximumInterval: '60s', maximumAttempts: 6 },
});

export interface ChapterWorkflowInput {
  runId: string;
  chapterPath: string;
  glossaryPath?: string;
}

export interface ChapterWorkflowResult {
  chapterName: string;
  paragraphCount: number;
  translationPath: string;
  englishPath: string;
  usage: Usage;
  status: 'translated';
}

/** Milestone 1: translate only. Later: translate -> term lint -> review -> revise (<=3) -> approve or flag. */
export async function ChapterWorkflow(input: ChapterWorkflowInput): Promise<ChapterWorkflowResult> {
  const t = await translateChapter(input);
  return { ...t, status: 'translated' };
}
