'use client';

import { Markdown } from '@lobehub/ui';

type SonaMarkdownProps = {
  content: string;
  /** Enable stream smoothing while the assistant reply is still generating. */
  streaming?: boolean;
};

export function SonaMarkdown({ content, streaming }: SonaMarkdownProps) {
  const trimmed = content.trim();
  if (!trimmed) return null;

  return (
    <Markdown
      animated={streaming}
      className="sonaChatMarkdown"
      enableGithubAlert
      variant="chat"
    >
      {content}
    </Markdown>
  );
}
