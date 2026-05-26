import type { ComposerCommand } from '@/types/sona';

const COMMAND_ORDER = [
  'event',
  'wiki',
  'case',
  'hot',
  'monitor_list',
  'monitor_demo',
  'memory',
];

export function sortComposerCommands(commands: ComposerCommand[]): ComposerCommand[] {
  const rank = new Map(COMMAND_ORDER.map((id, index) => [id, index]));
  return [...commands].sort((left, right) => {
    const leftRank = rank.get(left.id) ?? 999;
    const rightRank = rank.get(right.id) ?? 999;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.label.localeCompare(right.label, 'zh-CN');
  });
}

export function commandInputValue(command: ComposerCommand): string {
  if (command.action === 'run' && command.default_query.trim()) {
    return command.default_query.trim();
  }
  return `${command.command} `;
}
