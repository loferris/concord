// Deterministic fake model, used when CRUSOE_API_KEY is unset (or FAKE_LLM=1).
// It understands the prompt formats our activities produce and returns schema-shaped JSON.
import type { ChatJsonRequest, ChatJsonRaw } from './llm';

const BLOCK_RE = /\[(p\d{3})\]\n([\s\S]*?)(?=\n\n\[p\d{3}\]\n|$)/g;

export async function fakeChatJson(req: ChatJsonRequest): Promise<ChatJsonRaw> {
  let content: string;
  switch (req.schemaName) {
    case 'translation': {
      const paragraphs: { id: string; text: string }[] = [];
      for (const m of req.user.matchAll(BLOCK_RE)) {
        paragraphs.push({ id: m[1], text: `(fake-en) ${m[2].trim()}` });
      }
      content = JSON.stringify({ paragraphs });
      break;
    }
    default:
      throw new Error(`fake model: no handler for schema "${req.schemaName}"`);
  }
  const promptTokens = Math.ceil((req.system.length + req.user.length) / 3);
  return {
    content,
    finishReason: 'stop',
    usage: {
      model: `fake:${req.model}`,
      prompt_tokens: promptTokens,
      completion_tokens: Math.ceil(content.length / 3),
      cached_tokens: Math.floor(req.system.length / 3), // pretend the stable prefix is cached
    },
  };
}
