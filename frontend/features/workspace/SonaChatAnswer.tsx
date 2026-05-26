'use client';

import { parseAnswerSegments, hasReportRefs } from '@/features/workspace/reportRefs';
import { SonaMarkdown } from '@/features/workspace/SonaMarkdown';
import { SonaReportFileCard } from '@/features/workspace/SonaReportFileCard';

type SonaChatAnswerProps = {
  answer: string;
  currentTaskId?: string;
  onOpenReport?: (taskId: string) => void;
  streaming?: boolean;
};

export function SonaChatAnswer({
  answer,
  currentTaskId,
  onOpenReport,
  streaming,
}: SonaChatAnswerProps) {
  if (!hasReportRefs(answer)) {
    return <SonaMarkdown content={answer} streaming={streaming} />;
  }

  const segments = parseAnswerSegments(answer, currentTaskId);

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
