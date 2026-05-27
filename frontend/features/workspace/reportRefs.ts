const REPORT_REF_RE =
  /(file:\/\/[^\s)\]]+|https?:\/\/[^\s)\]]+|[A-Za-z]:[\\/][^\s)\]]+\.(?:html?|md|pdf|docx?)|(?:\.{1,2}[\\/]|[/\\]|sandbox[\\/]|\.pytest_cache[\\/])[^\s)\]]+\.(?:html?|md|pdf|docx?)|\breport_[A-Za-z0-9_.-]+\.(?:html?|md|pdf|docx?))/gi;
const SANDBOX_TASK_RE = /[/\\]sandbox[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const REPORT_FILE_RE = /\.(html?|md|pdf|docx?)$/i;

export type ReportRef = {
  url: string;
  fileName: string;
  fileType: string;
  sessionId?: string;
};

export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'report'; ref: ReportRef };

export function parseReportFileName(url: string): string {
  try {
    const decoded = decodeURIComponent(url);
    const parts = decoded.split(/[/\\]/);
    return parts[parts.length - 1]?.replace(/^["']|["']$/g, '') || 'report';
  } catch {
    return 'report';
  }
}

export function parseReportFileType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext && ext.length <= 5 ? ext : 'html';
}

export function extractSessionIdFromUrl(url: string, fallbackSessionId?: string): string | undefined {
  const match = url.match(SANDBOX_TASK_RE);
  if (match?.[1]) return match[1];
  return fallbackSessionId?.trim() || undefined;
}

export function isReportUrl(url: string): boolean {
  const fileName = parseReportFileName(url);
  if (REPORT_FILE_RE.test(fileName)) return true;
  return /report/i.test(url);
}

export function reportApiPath(sessionId: string): string {
  return `/api/sona/v1/chat/sessions/${sessionId}/report`;
}

function cleanLeadText(text: string): string {
  return text.replace(/[：:]\s*$/, '').trimEnd();
}

export function parseAnswerSegments(answer: string, fallbackSessionId?: string): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let lastIndex = 0;
  const re = new RegExp(REPORT_REF_RE.source, 'gi');
  let match: RegExpExecArray | null;

  while ((match = re.exec(answer)) !== null) {
    const url = match[0];
    if (!isReportUrl(url)) continue;

    const before = answer.slice(lastIndex, match.index);
    if (before.trim()) {
      segments.push({ kind: 'text', text: cleanLeadText(before) });
    }

    const fileName = parseReportFileName(url);
    segments.push({
      kind: 'report',
      ref: {
        url,
        fileName,
        fileType: parseReportFileType(fileName),
        sessionId: extractSessionIdFromUrl(url, fallbackSessionId),
      },
    });
    lastIndex = match.index + url.length;
  }

  const tail = answer.slice(lastIndex).trim();
  if (tail) segments.push({ kind: 'text', text: tail });

  if (!segments.length && answer.trim()) {
    segments.push({ kind: 'text', text: answer });
  }

  return segments;
}

export function hasReportRefs(answer: string): boolean {
  const re = new RegExp(REPORT_REF_RE.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(answer)) !== null) {
    if (isReportUrl(match[0])) return true;
  }
  return false;
}
