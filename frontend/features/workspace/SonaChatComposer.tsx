'use client';

import { useMemo, useRef } from 'react';
import { Dropdown } from 'antd';
import { Button, Flexbox, Text, Tooltip } from '@lobehub/ui';
import { ArrowBigUp, ChevronDown, CornerDownLeft, SendHorizontal } from 'lucide-react';
import type { ComposerCommand } from '@/types/sona';
import { sortComposerCommands } from './sonaToolUi';

const VISIBLE_COMMAND_COUNT = 5;
const COMPOSER_MIN_HEIGHT = 120;

type SonaChatComposerProps = {
  busy?: boolean;
  commands: ComposerCommand[];
  onCommand: (command: ComposerCommand) => void;
  onInput: (value: string) => void;
  onSend: () => void;
  value: string;
};

function CommandStrip({
  commands,
  onCommand,
}: Readonly<{
  commands: ComposerCommand[];
  onCommand: (command: ComposerCommand) => void;
}>) {
  const sorted = useMemo(() => sortComposerCommands(commands), [commands]);
  const visible = sorted.slice(0, VISIBLE_COMMAND_COUNT);
  const overflow = sorted.slice(VISIBLE_COMMAND_COUNT);

  if (!sorted.length) {
    return null;
  }

  return (
    <Flexbox align="center" gap={4} horizontal style={{ flexWrap: 'wrap', minWidth: 0 }}>
      {visible.map((command) => (
        <Tooltip
          key={command.id}
          title={
            command.action === 'run'
              ? `${command.description}（点击直接执行 ${command.default_query || command.command}）`
              : `${command.description}（填入 ${command.command} 后发送）`
          }
        >
          <Button className="sonaToolChip" onClick={() => onCommand(command)} size="small">
            {command.label}
          </Button>
        </Tooltip>
      ))}
      {overflow.length ? (
        <Dropdown
          menu={{
            items: overflow.map((command) => ({
              key: command.id,
              label: command.label,
              title: command.description,
              onClick: () => onCommand(command),
            })),
          }}
          trigger={['click']}
        >
          <Button className="sonaToolChip" icon={<ChevronDown size={14} />} size="small" type="text">
            更多
          </Button>
        </Dropdown>
      ) : null}
    </Flexbox>
  );
}

function ComposerHint() {
  return (
    <Flexbox align="center" className="sonaChatComposerHint" gap={4} horizontal>
      <CornerDownLeft size={14} />
      <Text fontSize={12} type="secondary">
        发送
      </Text>
      <Text fontSize={12} type="secondary">
        /
      </Text>
      <Flexbox align="center" gap={2} horizontal>
        <ArrowBigUp size={14} />
        <CornerDownLeft size={14} />
      </Flexbox>
      <Text fontSize={12} type="secondary">
        Ctrl+Enter 换行
      </Text>
    </Flexbox>
  );
}

export function SonaChatComposer({
  busy = false,
  commands,
  onCommand,
  onInput,
  onSend,
  value,
}: Readonly<SonaChatComposerProps>) {
  const isComposingRef = useRef(false);
  const canSend = busy || Boolean(value.trim());

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposingRef.current) return;
    if (event.key !== 'Enter') return;
    if (event.ctrlKey || event.metaKey) return;
    if (event.shiftKey) return;
    event.preventDefault();
    if (canSend) onSend();
  }

  return (
    <div className="sonaChatComposerDock">
      <Flexbox
        className="sonaChatComposerShell"
        paddingInline={16}
        style={{
          marginInline: 'auto',
          marginTop: -12,
          position: 'relative',
          width: 'min(960px, 100%)',
        }}
      >
        <div className="sonaChatComposerCard">
          <textarea
            className="sonaChatComposerEditor"
            disabled={busy}
            onChange={(event) => onInput(event.target.value)}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onKeyDown={handleKeyDown}
            placeholder="输入任务、问题，或描述你想做的事…"
            rows={3}
            style={{ minHeight: COMPOSER_MIN_HEIGHT }}
            value={value}
          />

          <footer className="sonaChatComposerFoot">
            <div className="sonaChatComposerFootLeft">
              <CommandStrip commands={commands} onCommand={onCommand} />
            </div>
            <div className="sonaChatComposerFootRight">
              <ComposerHint />
              <Tooltip title="发送">
                <Button
                  className="sonaSendButton"
                  disabled={!canSend}
                  icon={SendHorizontal}
                  loading={busy}
                  onClick={onSend}
                  shape="round"
                  style={{ '--send-button-size': '32px' } as React.CSSProperties}
                  type="primary"
                />
              </Tooltip>
            </div>
          </footer>
        </div>
      </Flexbox>
    </div>
  );
}
