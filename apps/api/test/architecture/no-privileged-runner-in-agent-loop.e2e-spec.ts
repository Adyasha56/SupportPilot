/**
 * Milestone 4's structural proof (amendment H, extended by G3 and G4):
 * nothing under agent/ or chat/ may import PrivilegedRefundRunner,
 * ApprovalService, ToolRunnerService, or runTool directly - only
 * ReadOnlyToolRunner (apps/api/src/agent/loop/read-only-tool-runner.ts, the
 * one documented exception) may import the generic runTool function, and
 * it already gates every call by connector riskLevel before ever reaching
 * it (Milestone 3). Amendment G3 adds ApprovalService to the forbidden
 * list: chat/ and agent/ may depend only on the narrow
 * APPROVAL_PROPOSAL_PORT (ApprovalProposalPort's single-method shape,
 * apps/api/src/approvals/approval-proposal.port.ts) - never the whole
 * class, which also exposes the admin-decision surface (decide/getById/list)
 * those layers have no business touching.
 *
 * Amendment G4 widens HOW a forbidden reference can be detected, beyond a
 * plain static `import` statement: a dynamic `import('...')` of one of the
 * forbidden modules, a `require('...')` of one, or a call through a
 * `moduleRef.get(...)`/`moduleRef.resolve(...)` naming one of the forbidden
 * identifiers directly, all bypass a plain import-statement scan while
 * reaching the exact same forbidden class. There are no TypeScript path
 * aliases configured anywhere in this project (confirmed against
 * tsconfig.base.json and every apps/*\/tsconfig.json - no `compilerOptions.paths`
 * entry exists) - so "a path-alias import naming the forbidden identifier"
 * has nothing extra to construct a case for today; the existing
 * specifier-based matching already generalizes to any import PATH
 * (including a hypothetical future alias) because it matches on the
 * imported NAME, never on the module specifier string.
 *
 * The detection logic (findForbiddenReferences) is a pure function over an
 * in-memory file map, unit-tested below with synthetic bad code for EVERY
 * construct it claims to catch - proving the test itself actually detects
 * each violation BEFORE it is ever pointed at the real source tree. This is
 * deliberately safer than writing a real bad-import fixture file to disk
 * and deleting it again: no risk of a failed test run leaving a stray file
 * behind, no file-lock fragility, and the exact same proof value (the
 * matcher is exercised against a genuinely bad case, not just the real
 * codebase's current clean state).
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
 * naming one of these as a specifier.
 */
const IMPORT_STATEMENT_PATTERN = /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\S+))\s+from\s+['"]([^'"]+)['"]/g;

/** A dynamic `import('...')` call - always a runtime/value import, never type-only, so matching purely by module path is safe here (unlike the static case, where a type-only named import of the same module must stay exempt). */
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** A CommonJS `require('...')` call - same reasoning as the dynamic-import pattern above. */
const REQUIRE_CALL_PATTERN = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * A call through a variable literally named (or ending in) `moduleRef` -
 * `moduleRef.get(X)` / `this.moduleRef.resolve(X)` / etc. A ModuleRef bound
 * to some other variable name would evade this heuristic; this project has
 * no such usage today (confirmed by the clean real-codebase scan below),
 * and the point of this specific check is to catch the one way Nest's own
 * DI escape hatch could otherwise route around the plain import scan, not
 * to catch every conceivable obfuscation.
 */
const MODULE_REF_CALL_PATTERN = /\bmoduleRef\s*\.\s*(?:get|resolve)\s*\(\s*(\w+)/gi;

// Deliberately only the forbidden VALUES (not types like ToolRunResult/ToolRunErrorCode, which
// are fine to import anywhere - run-agent.ts legitimately imports ToolRunResult from
// tool-runner.ts, and ApprovalProposalPort/APPROVAL_PROPOSAL_PORT are the legitimate port surface
// chat.service.ts, Stage 5, is meant to depend on). A path-suffix check for the static import case
// was tried and dropped: it flagged a legitimate type-only import just for sharing a module path
// with a forbidden function, which is not what this rule is about - only importing the VALUES
// themselves (by name) is forbidden there.
const FORBIDDEN_SPECIFIERS = new Set(['PrivilegedRefundRunner', 'ApprovalService', 'ToolRunnerService', 'runTool']);

/** For dynamic import()/require() only (amendment G4) - these are always value-level, so matching by module path suffix is safe and sufficient; there is no identifier to inspect at the call site itself. */
const FORBIDDEN_DYNAMIC_MODULE_SUFFIXES = ['privileged-refund-runner', 'approval.service', 'tool-runner.service', '/tool-runner'];

/** The one, deliberate, documented exception - matched by filename only, never by directory, so it can never accidentally widen to cover an unrelated file that merely shares a path segment. */
const EXEMPT_FILENAME = 'read-only-tool-runner.ts';

function matchesForbiddenDynamicModule(path: string): boolean {
  return FORBIDDEN_DYNAMIC_MODULE_SUFFIXES.some((suffix) => path === suffix.replace(/^\//, '') || path.endsWith(suffix));
}

export function findForbiddenReferences(files: Record<string, string>): ForbiddenImportViolation[] {
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
          violations.push({ file, label: `${specifier} identifier (static import)` });
        }
      }
    }

    for (const match of content.matchAll(DYNAMIC_IMPORT_PATTERN)) {
      const path = match[1];
      if (matchesForbiddenDynamicModule(path)) {
        violations.push({ file, label: `dynamic import('${path}')` });
      }
    }

    for (const match of content.matchAll(REQUIRE_CALL_PATTERN)) {
      const path = match[1];
      if (matchesForbiddenDynamicModule(path)) {
        violations.push({ file, label: `require('${path}')` });
      }
    }

    for (const match of content.matchAll(MODULE_REF_CALL_PATTERN)) {
      const specifier = match[1];
      if (FORBIDDEN_SPECIFIERS.has(specifier)) {
        violations.push({ file, label: `${specifier} identifier (moduleRef.get/resolve)` });
      }
    }
  }
  return violations;
}

/**
 * `agent/tool-runner/` is excluded - it's the tool-runner subsystem's OWN
 * implementation (it defines ToolRunnerService and runTool; of course it
 * references them). `approvals/` is excluded for the same reason regarding
 * ApprovalService/PrivilegedRefundRunner - it is that subsystem's own
 * implementation. The rule under test is about the agent LOOP
 * (planner/compose/run-agent, under agent/loop/ and its siblings) and the
 * chat layer never reaching PAST ReadOnlyToolRunner / APPROVAL_PROPOSAL_PORT
 * into either implementation directly - not about an implementation
 * referencing itself.
 */
const EXCLUDED_DIR_SEGMENTS = [join('agent', 'tool-runner')];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (EXCLUDED_DIR_SEGMENTS.some((segment) => full.includes(segment))) {
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

describe('findForbiddenReferences - the detection logic itself, proven against synthetic bad code', () => {
  it('FAILS (detects a violation) on a deliberately bad static import of PrivilegedRefundRunner', () => {
    const violations = findForbiddenReferences({
      'agent/loop/run-agent.ts': "import { PrivilegedRefundRunner } from '../../approvals/privileged-refund-runner';",
    });
    expect(violations.length).toBeGreaterThan(0);
  });

  it('FAILS on a deliberately bad static import of ApprovalService (amendment G3)', () => {
    const violations = findForbiddenReferences({
      'chat/chat.service.ts': "import { ApprovalService } from '../approvals/approval.service';",
    });
    expect(violations.some((v) => v.label.includes('ApprovalService'))).toBe(true);
  });

  it('FAILS on a deliberately bad static import of ToolRunnerService', () => {
    const violations = findForbiddenReferences({
      'chat/chat.service.ts': "import { ToolRunnerService } from '../agent/tool-runner/tool-runner.service';",
    });
    expect(violations.some((v) => v.label.includes('ToolRunnerService'))).toBe(true);
  });

  it('FAILS on a deliberately bad static import of runTool', () => {
    const violations = findForbiddenReferences({
      'agent/loop/run-agent.ts': "import { runTool } from '../tool-runner/tool-runner';",
    });
    expect(violations.some((v) => v.label.includes('runTool'))).toBe(true);
  });

  it('FAILS on a deliberately bad DYNAMIC import() of privileged-refund-runner (amendment G4)', () => {
    const violations = findForbiddenReferences({
      'chat/chat.service.ts': "const { PrivilegedRefundRunner } = await import('../approvals/privileged-refund-runner');",
    });
    expect(violations.some((v) => v.label.includes("dynamic import"))).toBe(true);
  });

  it('FAILS on a deliberately bad DYNAMIC import() of approval.service (amendment G4)', () => {
    const violations = findForbiddenReferences({
      'agent/loop/run-agent.ts': "const mod = await import('../../approvals/approval.service');",
    });
    expect(violations.some((v) => v.label.includes('dynamic import'))).toBe(true);
  });

  it('FAILS on a deliberately bad require() of tool-runner.service (amendment G4)', () => {
    const violations = findForbiddenReferences({
      'chat/chat.service.ts': "const { ToolRunnerService } = require('../agent/tool-runner/tool-runner.service');",
    });
    expect(violations.some((v) => v.label.includes('require'))).toBe(true);
  });

  it('FAILS on a deliberately bad moduleRef.get(PrivilegedRefundRunner) call (amendment G4)', () => {
    const violations = findForbiddenReferences({
      'chat/chat.service.ts': 'const runner = this.moduleRef.get(PrivilegedRefundRunner, { strict: true });',
    });
    expect(violations.some((v) => v.label.includes('moduleRef.get/resolve'))).toBe(true);
  });

  it('FAILS on a deliberately bad moduleRef.resolve(ApprovalService) call (amendment G4)', () => {
    const violations = findForbiddenReferences({
      'agent/loop/run-agent.ts': 'const service = await moduleRef.resolve(ApprovalService);',
    });
    expect(violations.some((v) => v.label.includes('ApprovalService') && v.label.includes('moduleRef'))).toBe(true);
  });

  it('PASSES (no violation) for read-only-tool-runner.ts importing runTool - the one documented exception', () => {
    const violations = findForbiddenReferences({
      'agent/loop/read-only-tool-runner.ts': "import { runTool, RunToolParams, ToolRunResult } from '../tool-runner/tool-runner';",
    });
    expect(violations).toEqual([]);
  });

  it('PASSES for a legitimate import of the narrow APPROVAL_PROPOSAL_PORT token and type (amendment G3)', () => {
    const violations = findForbiddenReferences({
      'chat/chat.service.ts': "import { APPROVAL_PROPOSAL_PORT, ApprovalProposalPort } from '../approvals/approval-proposal.port';",
    });
    expect(violations).toEqual([]);
  });

  it('PASSES for ordinary, unrelated content, including an unrelated dynamic import and an unrelated moduleRef.get call', () => {
    const violations = findForbiddenReferences({
      'agent/loop/run-agent.ts': "import { x } from './y';\nconst z = await import('./some-other-module');\nconst w = moduleRef.get(SomethingElse);",
    });
    expect(violations).toEqual([]);
  });
});

describe('the REAL codebase, scanned for real', () => {
  it('nothing under agent/ or chat/ references PrivilegedRefundRunner, ApprovalService, ToolRunnerService, or runTool - by static import, dynamic import, require, or moduleRef.get/resolve (except read-only-tool-runner.ts)', () => {
    const roots = [join(__dirname, '../../src/agent'), join(__dirname, '../../src/chat')];
    const files: Record<string, string> = {};
    for (const root of roots) {
      for (const file of listTsFiles(root)) {
        files[file] = readFileSync(file, 'utf8');
      }
    }
    expect(Object.keys(files).length).toBeGreaterThan(10); // sanity - the scan actually found real files, not an empty/wrong path
    expect(findForbiddenReferences(files)).toEqual([]);
  });
});
