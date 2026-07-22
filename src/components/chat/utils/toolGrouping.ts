import type { ChatMessage } from '../types/types';

// Every groupable tool call is wrapped in a collapsed group container — even a
// lone one (a "group" of 1) — so tool calls render uniformly behind a compact,
// expandable header instead of dumping their input/output inline. Consecutive
// calls of the same tool still merge into a single multi-count group.
export const TOOL_GROUP_THRESHOLD = 1;

export interface ToolGroupItem {
  _isGroup: true;
  toolName: string;
  messages: ChatMessage[];
  timestamp: ChatMessage['timestamp'];
}

export type MessageListItem = ChatMessage | ToolGroupItem;

export function isToolGroupItem(item: MessageListItem): item is ToolGroupItem {
  return '_isGroup' in item && (item as ToolGroupItem)._isGroup === true;
}

// Interactive / decision tools render rich inline UI the user acts on (or reads
// as the outcome of a turn); collapsing them behind a group header — especially
// as a group of one — would bury them, so they always render inline.
const NON_GROUPABLE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);

function isGroupableToolMessage(message: ChatMessage): message is ChatMessage & { toolName: string } {
  return Boolean(
    message.isToolUse &&
      message.toolName &&
      !message.isSubagentContainer &&
      !NON_GROUPABLE_TOOLS.has(message.toolName),
  );
}

// Messages that render nothing (e.g. reasoning hidden when showThinking is off)
// shouldn't split an otherwise-continuous run of the same tool — providers like
// Codex interleave hidden reasoning between consecutive tool calls.
function rendersNothing(message: ChatMessage, showThinking: boolean): boolean {
  return Boolean(message.isThinking && !showThinking);
}

export function groupConsecutiveTools(
  messages: ChatMessage[],
  showThinking: boolean = true,
): MessageListItem[] {
  const items: MessageListItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (!isGroupableToolMessage(message)) {
      items.push(message);
      index += 1;
      continue;
    }

    const run: ChatMessage[] = [message];
    let nextIndex = index + 1;

    while (nextIndex < messages.length) {
      const candidate = messages[nextIndex];

      // Skip invisible interleaved messages so they don't break the run.
      if (rendersNothing(candidate, showThinking)) {
        nextIndex += 1;
        continue;
      }

      if (isGroupableToolMessage(candidate) && candidate.toolName === message.toolName) {
        run.push(candidate);
        nextIndex += 1;
        continue;
      }

      break;
    }

    if (run.length >= TOOL_GROUP_THRESHOLD) {
      items.push({
        _isGroup: true,
        toolName: message.toolName,
        messages: run,
        timestamp: message.timestamp,
      });
    } else {
      items.push(...run);
    }

    index = nextIndex;
  }

  return items;
}
