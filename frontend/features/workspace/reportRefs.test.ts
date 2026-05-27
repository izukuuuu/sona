import { describe, expect, it } from 'vitest';
import {
  extractSessionIdFromUrl,
  hasReportRefs,
  parseAnswerSegments,
  parseReportFileName,
  reportApiPath,
} from '@/features/workspace/reportRefs';

const SESSION_ID = '45c6b9fa-b1d0-41de-9e28-22f6bd64a487';
const FILE_URL = `file:///Users/me/sona-master/sandbox/${SESSION_ID}/%E7%BB%93%E6%9E%9C%E6%96%87%E4%BB%B6/report_20260421_093344.html`;

describe('reportRefs', () => {
  it('extracts task id from sandbox file url', () => {
    expect(extractSessionIdFromUrl(FILE_URL)).toBe(SESSION_ID);
    expect(extractSessionIdFromUrl('https://example.com/report.html', SESSION_ID)).toBe(SESSION_ID);
  });

  it('parses localized file name', () => {
    expect(parseReportFileName(FILE_URL)).toBe('report_20260421_093344.html');
  });

  it('splits workflow answer into text and report card', () => {
    const answer = `已完成舆情事件分析工作流。报告：${FILE_URL}`;
    const segments = parseAnswerSegments(answer);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ kind: 'text', text: '已完成舆情事件分析工作流。报告' });
    expect(segments[1]?.kind).toBe('report');
    if (segments[1]?.kind === 'report') {
      expect(segments[1].ref.sessionId).toBe(SESSION_ID);
      expect(segments[1].ref.fileType).toBe('html');
    }
  });

  it('uses fallback task id for Windows report paths', () => {
    const answer = String.raw`报告路径：F:\sona-master\.pytest_cache\sona_reports\report_61c04840247d47d39e094edbbb2dc773.html`;
    const segments = parseAnswerSegments(answer, SESSION_ID);
    const last = segments[segments.length - 1];
    expect(last?.kind).toBe('report');
    if (last?.kind === 'report') {
      expect(last.ref.sessionId).toBe(SESSION_ID);
      expect(last.ref.fileName).toBe('report_61c04840247d47d39e094edbbb2dc773.html');
    }
  });

  it('detects bare report html filenames', () => {
    const answer = 'HTML report_61c04840247d47d39e094edbbb2dc773.html HTML 报告';
    expect(hasReportRefs(answer)).toBe(true);
    const segments = parseAnswerSegments(answer, SESSION_ID);
    expect(segments.some((segment) => segment.kind === 'report')).toBe(true);
  });

  it('detects report refs in plain answers', () => {
    expect(hasReportRefs(answerWithReport())).toBe(true);
    expect(hasReportRefs('暂无报告')).toBe(false);
  });

  it('builds report api path', () => {
    expect(reportApiPath(SESSION_ID)).toBe(`/api/sona/v1/chat/sessions/${SESSION_ID}/report`);
  });
});

function answerWithReport() {
  return `报告：${FILE_URL}`;
}

