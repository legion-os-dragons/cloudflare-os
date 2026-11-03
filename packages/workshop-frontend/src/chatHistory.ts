import type {AiChatHistoryPage} from '@gadgets/workshop-shared/api';

/** Transport pages are assembled before the UI sees a logical history page:
 * exposing a partial prefix could omit still-pending code changes. */
export async function loadChatHistoryPage(
    load: (before?: number, transport?: {boundary?: number | null}) => Promise<AiChatHistoryPage>,
    before?: number, cancelled: () => boolean = () => false): Promise<AiChatHistoryPage> {
  const current = () => { if (cancelled()) throw new DOMException('History load cancelled.', 'AbortError'); };
  current();
  let page = await load(before, {});
  current();
  const fragments = [page.messages];
  const visited = new Set<number>();
  let boundary: number | null | undefined;
  let priorBefore = before;
  while (page.continuation) {
    const next = page.continuation;
    if (!Number.isSafeInteger(next.beforeSequence) || next.beforeSequence < 0 ||
        next.boundary !== null && (!Number.isSafeInteger(next.boundary) || next.boundary < 0) ||
        next.boundary !== null && next.beforeSequence < next.boundary ||
        priorBefore !== undefined && next.beforeSequence >= priorBefore ||
        boundary !== undefined && next.boundary !== boundary || visited.has(next.beforeSequence) ||
        page.messages.length === 0 || page.messages[0].sequence !== next.beforeSequence || page.compacted) {
      throw Error('The history transport cursor changed. Reload the conversation.');
    }
    boundary = next.boundary;
    priorBefore = next.beforeSequence;
    visited.add(next.beforeSequence);
    page = await load(next.beforeSequence, {boundary: next.boundary});
    current();
    fragments.push(page.messages);
  }
  if (boundary !== undefined && (page.compacted?.to ?? null) !== boundary) {
    throw Error('The history checkpoint changed. Reload the conversation.');
  }
  return {messages: fragments.toReversed().flat(), ...(page.compacted ? {compacted: page.compacted} : {})};
}
