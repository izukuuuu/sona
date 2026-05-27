'use client';

import { ActionIcon, Block, FileTypeIcon, Flexbox, Text, Tooltip } from '@lobehub/ui';
import { Download, ExternalLink, PanelRightOpen } from 'lucide-react';
import type { ReportRef } from '@/features/workspace/reportRefs';
import { reportApiPath } from '@/features/workspace/reportRefs';

type SonaReportFileCardProps = {
  report: ReportRef;
  onOpenReport?: (sessionId: string) => void;
};

async function downloadReport(url: string, fileName: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 (${response.status})`);
  const blob = await response.blob();
  const blobUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = fileName;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export function SonaReportFileCard({ report, onOpenReport }: SonaReportFileCardProps) {
  const previewUrl = report.sessionId ? reportApiPath(report.sessionId) : undefined;
  const fileLabel = report.fileType.toUpperCase();
  const canOpen = Boolean(previewUrl);

  const openReport = () => {
    if (!previewUrl) return;
    if (report.sessionId && onOpenReport) {
      onOpenReport(report.sessionId);
      return;
    }
    window.open(previewUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <Block
      align="center"
      className="sonaReportFileCard"
      gap={12}
      horizontal
      onClick={openReport}
      onKeyDown={(event) => {
        if (!canOpen) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openReport();
        }
      }}
      padding={12}
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      variant="outlined"
    >
      <FileTypeIcon filetype={report.fileType} size={40} type="file" variant="color" />
      <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
        <Text ellipsis style={{ fontWeight: 600, fontSize: 14 }}>
          {report.fileName}
        </Text>
        <Text style={{ color: 'var(--muted)', fontSize: 12 }}>{fileLabel} 报告</Text>
      </Flexbox>
      <Flexbox gap={4} horizontal>
        {previewUrl && onOpenReport ? (
          <Tooltip title="在侧栏打开报告">
            <ActionIcon
              icon={PanelRightOpen}
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                onOpenReport(report.sessionId!);
              }}
            />
          </Tooltip>
        ) : null}
        {previewUrl ? (
          <Tooltip title="新标签页打开">
            <ActionIcon
              icon={ExternalLink}
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                window.open(previewUrl, '_blank', 'noopener,noreferrer');
              }}
            />
          </Tooltip>
        ) : null}
        {previewUrl ? (
          <Tooltip title="下载报告">
            <ActionIcon
              icon={Download}
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                void downloadReport(previewUrl, report.fileName).catch((error) => {
                  console.error(error);
                });
              }}
            />
          </Tooltip>
        ) : null}
      </Flexbox>
    </Block>
  );
}
