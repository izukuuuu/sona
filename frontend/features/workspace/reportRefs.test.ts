import { describe, expect, it } from 'vitest';
import {
  extractTaskIdFromUrl,
  hasReportRefs,
  parseAnswerSegments,
  parseReportFileName,
  reportApiPath,
} from '@/features/workspace/reportRefs';

const TASK_ID = '45c6b9fa-b1d0-41de-9e28-22f6bd64a487';
const FILE_URL = `file:///Users/me/sona-master/sandbox/${TASK_ID}/%E7%BB%93%E6%9E%9C%E6%96%87%E4%BB%B6/report_20260421_093344.html`;

describe('reportRefs', () => {
  it('extracts task id from sandbox file url', () => {
    expect(extractTaskIdFromUrl(FILE_URL)).toBe(TASK_ID);
    expect(extractTaskIdFromUrl('https://example.com/report.html', TASK_ID)).toBe(TASK_ID);
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
      expect(segments[1].ref.taskId).toBe(TASK_ID);
      expect(segments[1].ref.fileType).toBe('html');
    }
  });

  it('detects report refs in plain answers', () => {
    expect(hasReportRefs(answerWithReport())).toBe(true);
    expect(hasReportRefs('暂无报告')).toBe(false);
  });

  it('builds report api path', () => {
    expect(reportApiPath(TASK_ID)).toBe(`/api/sona/v1/tasks/${TASK_ID}/report`);
  });
});

function answerWithReport() {
  return `报告：${FILE_URL}`;
}
