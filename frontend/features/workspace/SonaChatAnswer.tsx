'use client';

import { parseAnswerSegments, hasReportRefs } from '@/features/workspace/reportRefs';
import { SonaMarkdown } from '@/features/workspace/SonaMarkdown';
import { SonaReportFileCard } from '@/features/workspace/SonaReportFileCard';

type SonaChatAnswerProps = {
  answer: string;
  currentSessionId?: string;
  onOpenReport?: (sessionId: string) => void;
  streaming?: boolean;
};

export function SonaChatAnswer({
  answer,
  currentSessionId,
  onOpenReport,
  streaming,
}: SonaChatAnswerProps) {
  if (!hasReportRefs(answer)) {
    return <SonaMarkdown content={answer} streaming={streaming} />;
  }

  const segments = parseAnswerSegments(answer, currentSessionId);

  return (
    <div className="sonaChatAnswerBody">
      {segments.map((segment, index) => {
        if (segment.kind === 'text') {
          return (
            <SonaMarkdown
              content={segment.text}
              key={`text-${index}`}
              streaming={streaming}
            />
          );
        }
        return (
          <SonaReportFileCard
            key={`report-${segment.ref.url}`}
            onOpenReport={onOpenReport}
            report={segment.ref}
          />
        );
      })}
    </div>
  );
}

