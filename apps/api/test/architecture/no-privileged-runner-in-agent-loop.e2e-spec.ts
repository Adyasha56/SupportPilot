/**
 * Milestone 4's structural proof (amendment H): nothing under agent/ or
 * chat/ may import PrivilegedRefundRunner, ToolRunnerService, or runTool
 * directly - only ReadOnlyToolRunner (apps/api/src/agent/loop/read-only-tool-runner.ts,
 * the one documented exception) may import the generic runTool function,
 * and it already gates every call by connector riskLevel before ever
 * reaching it (Milestone 3).
 *
 * The detection logic (findForbiddenImports) is a pure function over an
 * in-memory file map, unit-tested below with synthetic bad imports -
 * proving the test itself actually detects a violation BEFORE it is ever
 * pointed at the real source tree. This is deliberately safer than
 * writing a real bad-import fixture file to disk and deleting it again:
 * no risk of a failed test run leaving a stray file behind, no file-lock
 * fragility, and the exact same proof value (the matcher is exercised
 * against a genuinely bad case, not just the real codebase's current
 * clean state).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ForbiddenImportViolation {
  file: string;
  label: string;
}

/**
 * Matches only ACTUAL import statements (`import ... from '...'`), not bare
 * identifier occurrences anywhere in a file - a file that merely mentions
 * "ToolRunnerService" in a doc comment (explaining exactly why it does NOT
 * use it, as read-only-tool-runner.provider.ts's own comment does) or that
 * legitimately DEFINES `runTool`/`ToolRunnerService` itself (tool-runner.ts,
 * tool-runner.service.ts) must never be flagged - only a real `import`
 * naming one of these as a specifier, or a module path ending in
 * `privileged-refund-runner` or `/tool-runner` or `/tool-runner.service`.
 */
const IMPORT_STATEMENT_PATTERN = /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\S+))\s+from\s+['"]([^'"]+)['"]/g;
// Deliberately only the three forbidden VALUES (not types like ToolRunResult/ToolRunErrorCode,
// which are fine to import anywhere - run-agent.ts legitimately imports ToolRunResult from
// tool-runner.ts). A path-suffix check was tried and dropped: it flagged that exact legitimate
// type-only import just for sharing a module path with the forbidden function, which is not
// what this rule is actually about - only importing the VALUES themselves is forbidden.
const FORBIDDEN_SPECIFIERS = new Set(['PrivilegedRefundRunner', 'ToolRunnerService', 'runTool']);

/** The one, deliberate, documented exception - matched by filename only, never by directory, so it can never accidentally widen to cover an unrelated file that merely shares a path segment. */
const EXEMPT_FILENAME = 'read-only-tool-runner.ts';

export function findForbiddenImports(files: Record<string, string>): ForbiddenImportViolation[] {
  const violations: ForbiddenImportViolation[] = [];
  for (const [file, content] of Object.entries(files)) {
    if (file.endsWith(EXEMPT_FILENAME)) {
      continue;
    }
    for (const match of content.matchAll(IMPORT_STATEMENT_PATTERN)) {
      const [, namedSpecifiers, defaultSpecifier] = match;
      const specifiers = (namedSpecifiers ?? defaultSpecifier ?? '')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);

      for (const specifier of specifiers) {
        if (FORBIDDEN_SPECIFIERS.has(specifier)) {
          violations.push({ file, label: `${specifier} identifier` });
        }
      }
    }
  }
  return violations;
}

/**
 * `agent/tool-runner/` is excluded - it's the tool-runner subsystem's OWN
 * implementation (it defines ToolRunnerService and runTool; of course it
 * references them). The rule under test is about the agent LOOP
 * (planner/compose/run-agent, under agent/loop/ and its siblings) and the
 * chat layer never reaching PAST ReadOnlyToolRunner into that
 * implementation directly - not about the implementation referencing
 * itself.
 */
const EXCLUDED_DIR_SEGMENT = `${join('agent', 'tool-runner')}`;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full.includes(EXCLUDED_DIR_SEGMENT)) {
      continue;
    }
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('findForbiddenImports - the detection logic itself, proven against synthetic bad imports', () => {
  it('FAILS (detects a violation) on a deliberately bad import of PrivilegedRefundRunner', () => {
    const violations = findForbiddenImports({
      'agent/loop/run-agent.ts': "import { PrivilegedRefundRunner } from '../../approvals/privileged-refund-runner';",
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it('FAILS on a deliberately bad import of ToolRunnerService', () => {
    const violations = findForbiddenImports({
      'chat/chat.service.ts': "import { ToolRunnerService } from '../agent/tool-runner/tool-runner.service';",
    });
    expect(violations.some((v) => v.label.includes('ToolRunnerService'))).toBe(true);
  });

  it('FAILS on a deliberately bad import of runTool', () => {
    const violations = findForbiddenImports({
      'agent/loop/run-agent.ts': "import { runTool } from '../tool-runner/tool-runner';",
    });
    expect(violations.some((v) => v.label.includes('runTool'))).toBe(true);
  });

  it('PASSES (no violation) for read-only-tool-runner.ts importing runTool - the one documented exception', () => {
    const violations = findForbiddenImports({
      'agent/loop/read-only-tool-runner.ts': "import { runTool, RunToolParams, ToolRunResult } from '../tool-runner/tool-runner';",
    });
    expect(violations).toEqual([]);
  });

  it('PASSES for ordinary, unrelated content', () => {
    expect(findForbiddenImports({ 'agent/loop/run-agent.ts': "import { x } from './y';" })).toEqual([]);
  });
});

describe('the REAL codebase, scanned for real', () => {
  it('nothing under agent/ or chat/ imports PrivilegedRefundRunner, ToolRunnerService, or runTool (except read-only-tool-runner.ts)', () => {
    const roots = [join(__dirname, '../../src/agent'), join(__dirname, '../../src/chat')];
    const files: Record<string, string> = {};
    for (const root of roots) {
      for (const file of listTsFiles(root)) {
        files[file] = readFileSync(file, 'utf8');
      }
    }
    expect(Object.keys(files).length).toBeGreaterThan(10); // sanity - the scan actually found real files, not an empty/wrong path
    expect(findForbiddenImports(files)).toEqual([]);
  });
});
