'use client';

import { useEffect, useMemo, useState } from 'react';
import { Switch } from 'antd';
import {
  Flexbox,
  Form,
  Segmented,
  SliderWithInput,
  Text,
  type FormItemProps,
} from '@lobehub/ui';
import type { MemorySettings } from '@/types/sona';

const DEFAULT_SETTINGS: MemorySettings = {
  enable_memory: true,
  wiki_style: 'teach',
  wiki_topk: 6,
  wiki_weibo_aux: true,
};

type SonaMemorySettingsProps = {
  settings: MemorySettings | null;
  onChange: (patch: Partial<MemorySettings>) => void;
};

export function SonaMemorySettings({ settings, onChange }: Readonly<SonaMemorySettingsProps>) {
  const values = settings ?? DEFAULT_SETTINGS;
  const [wikiTopk, setWikiTopk] = useState(values.wiki_topk);

  useEffect(() => {
    setWikiTopk(values.wiki_topk);
  }, [values.wiki_topk]);

  const items = useMemo<FormItemProps[]>(
    () => [
      {
        label: 'Enable Memory',
        desc: '允许后端保存并复用当前会话的 harness memory 偏好。',
        children: (
          <Switch
            checked={values.enable_memory}
            onChange={(checked) => onChange({ enable_memory: checked })}
          />
        ),
      },
      {
        label: 'Wiki Style',
        desc: '控制知识库回答的默认风格。',
        children: (
          <Segmented
            options={[
              { label: 'Teach', value: 'teach' },
              { label: 'Concise', value: 'concise' },
            ]}
            value={values.wiki_style}
            onChange={(value) => onChange({ wiki_style: value as MemorySettings['wiki_style'] })}
          />
        ),
      },
      {
        label: 'Aggressiveness',
        desc: '对应后端 wiki_topk，值越高检索召回越宽。',
        children: (
          <SliderWithInput
            max={12}
            min={1}
            step={1}
            size="small"
            style={{ minWidth: 280 }}
            value={wikiTopk}
            onChange={(value) => setWikiTopk(value)}
            onChangeComplete={(value) => onChange({ wiki_topk: value })}
          />
        ),
      },
      {
        label: 'Weibo Auxiliary Context',
        desc: '允许 Wiki 流程在需要时注入微博辅助片段。',
        children: (
          <Switch
            checked={values.wiki_weibo_aux}
            onChange={(checked) => onChange({ wiki_weibo_aux: checked })}
          />
        ),
      },
    ],
    [onChange, values.enable_memory, values.wiki_style, values.wiki_weibo_aux, wikiTopk],
  );

  return (
    <Flexbox gap={36} style={{ maxWidth: 1024, width: '100%' }}>
      <Flexbox gap={6}>
        <Text style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.25 }}>Memory</Text>
        <Text fontSize={14} type="secondary">
          会话记忆偏好会写入后端 harness memory，并用于后续 Agent run。
        </Text>
      </Flexbox>

      <Form
        items={[
          {
            title: 'Memory Settings',
            children: items,
          },
        ]}
        itemsType="group"
        variant="borderless"
      />
    </Flexbox>
  );
}
