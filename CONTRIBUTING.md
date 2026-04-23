# Contributing to Fynd Returns

Thanks for helping improve Fynd Returns. This guide covers how to set up
your environment, the conventions the codebase follows, and how pull
requests are reviewed.

---

## Table of contents

- [Code of conduct](#code-of-conduct)
- [Quick setup](#quick-setup)
- [Development workflow](#development-workflow)
- [Testing](#testing)
  - [Running tests](#running-tests)
  - [Coverage ratchet](#coverage-ratchet)
  - [Writing tests](#writing-tests)
- [Code style](#code-style)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Reporting security issues](#reporting-security-issues)

---

## Code of conduct

Be kind. Be clear. Assume good intent. Disagree with ideas, not people.
Public harassment of any form is grounds for removal from the project.

---

## Quick setup

```bash
git clone https://github.com/Farhankhan0128/returnpromax.git
cd returnpromax
npm install
cp .env.example .env    # fill in Shopify + Fynd dev credentials
npx prisma generate
npx prisma migrate dev
npm run dev:local
```

Node 22+ is required (see `package.json` engines). PostgreSQL 14+ for the
database.

---

## Development workflow

1. **Create a branch** from `main`. Names like `feat/add-bulk-actions`,
   `fix/refund-location-fallback`, `docs/api-examples` are encouraged.
2. **Make changes in small, reviewable increments.** One logical change
   per commit — it makes bisecting regressions dramatically easier.
3. **Run the three gates locally before pushing**:
   ```bash
   npm run typecheck
   npm run test
   npm run build
   ```
4. **Open a PR against `main`**. Fill out the PR template — especially
   the "How to test" section.
5. **CI runs automatically** — typecheck, tests, coverage, build,
   CodeQL security scan. All must pass before merge.
6. **Review.** A maintainer reviews, leaves comments, or approves.
7. **Squash-merge** into main. Release is auto-deployed from `main`.

---

## Testing

### Running tests

```bash
npm run test              # one-shot run
npm run test:watch        # interactive watch mode (useful while developing)
npm run test:coverage     # full run with coverage report
```

After `test:coverage`, open `coverage/index.html` in your browser to
inspect line-by-line gaps.

### Coverage ratchet

We enforce a **coverage ratchet**: the `thresholds` in
`vitest.coverage.config.mts` are the current floor. CI fails if any
metric drops below the floor. When a PR raises coverage meaningfully,
the reviewer will ask you to bump the thresholds in the same PR.

The multi-phase plan for growing coverage is documented in
[COVERAGE.md](COVERAGE.md). Familiarise yourself with it before adding
large new surface area.

### Writing tests

- **Place tests next to the source** in `__tests__/` subdirectories
  (e.g. `app/lib/__tests__/x.test.ts` for `app/lib/x.ts`).
- **Unit tests first** — pure functions should be exhaustively tested.
- **Mock at the boundary** — Prisma, Shopify Admin, Fynd API. Never mock
  your own application code in a unit test; use a real test double.
- **One assertion per concept.** It's fine to have several `expect()`
  calls if they all verify the same behaviour.
- **Name tests so a reader knows the expectation**: `returns 400 when
  rejectionReason is missing` beats `test reject`.

Example skeleton:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fnUnderTest } from "../the-module";

vi.mock("../some-dependency", () => ({
  someExport: vi.fn(),
}));

describe("fnUnderTest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does the thing when given a valid input", () => {
    const result = fnUnderTest({ valid: true });
    expect(result.ok).toBe(true);
  });
});
```

---

## Code style

- **TypeScript strict mode.** No `any` unless you can defend it in review.
- **Prefer named exports** over default (except React components).
- **Short, direct comments** — explain *why*, not *what*. Code that
  needs a paragraph of explanation should usually be rewritten.
- **No unused imports.** TypeScript catches these; fix them before CI.
- **File-scope constants `UPPER_SNAKE_CASE`.** Functions and variables
  `camelCase`. Types/interfaces `PascalCase`.
- **React components**: functional, hooks-only. No class components.

---

## Commit messages

We follow a light Conventional Commits style:

```
feat(portal): add OTP-verified manual submission
fix(refund): use fulfillment location, fall back to default
docs(api): add webhook payload examples
test(fynd-webhook): cover credit_note_generated idempotency
chore(deps): bump vitest to 4.1.5
refactor(returns-list): extract filter toolbar
ci(codeql): switch to security-extended query pack
```

The `scope` (in parens) is the affected area. Keep the subject under
72 characters. Body (if present) explains *why*.

---

## Pull requests

- **Keep PRs focused.** One change per PR. If you find unrelated fixes
  worth making, stack them as separate PRs.
- **Write the description for a reviewer who is not in your head.**
- **Include screenshots** for UI changes.
- **All CI checks must pass** before review.
- **Rebase, don't merge** when updating your branch from main.
- **Use "Squash and merge"** — keeps `main` history linear and readable.

---

## Reporting security issues

**Do not file a public issue for security vulnerabilities.** Follow the
instructions in [SECURITY.md](SECURITY.md) — typically the fastest route
is GitHub's private advisory form:

<https://github.com/Farhankhan0128/returnpromax/security/advisories/new>

---

Thanks again for contributing!
