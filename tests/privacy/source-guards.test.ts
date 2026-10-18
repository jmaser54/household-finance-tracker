import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles('src').map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('application source privacy guards', () => {
  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each([
    ['console logging', /\bconsole\s*\.\s*\w+\s*\(/],
    ['network APIs', /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|new\s+(XMLHttpRequest|WebSocket|EventSource)\b/],
    ['external URLs', /https?:\/\/(?!www\.w3\.org\/)/],
    ['dynamic code evaluation', /\beval\s*\(|new\s+Function\s*\(/],
    ['browser storage meant for small values', /\b(localStorage|sessionStorage|document\.cookie)\b/],
    ['URL or history state writes', /\b(history\.(pushState|replaceState)|location\.(hash|search|href)\s*=)/],
  ])('application code does not use %s', (_label, pattern) => {
    const offenders = files.filter((file) => pattern.test(file.text)).map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
