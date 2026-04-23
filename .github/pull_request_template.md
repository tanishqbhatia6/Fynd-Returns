<!--
Thanks for the PR! Please fill this out so reviewers have the context
they need to merge confidently. Delete sections that don't apply.
-->

## Summary

<!-- What does this PR do, and WHY? One or two sentences is fine. -->

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Refactor / chore (no behaviour change)
- [ ] Docs only
- [ ] CI / infra / tests

## How to test

<!-- Step-by-step so a reviewer can reproduce on their laptop. -->

1.
2.
3.

## Test coverage

<!-- Coverage must not drop. See COVERAGE.md for the ratchet. -->

- [ ] Added unit tests for new logic
- [ ] Added API/route tests for new endpoints
- [ ] Added/updated regression test for this bug
- [ ] Not applicable (explain): …

## Risk & blast radius

<!-- Production risk? Which flows can this break? -->

- [ ] Customer-visible portal flow
- [ ] Admin dashboard / returns management
- [ ] Fynd integration (reverse logistics / webhooks)
- [ ] Shopify Admin API (refunds, inventory)
- [ ] Database schema migration
- [ ] None of the above

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run test` passes
- [ ] `npm run build` passes
- [ ] Coverage ratchet respected (CI will block if not)
- [ ] No secrets in code or commit messages
- [ ] Updated [COVERAGE.md](../COVERAGE.md) thresholds if they increased
- [ ] Updated docs (`docs/`, `README.md`) if applicable

## Screenshots / recordings

<!-- For UI changes only. Drag-drop here. -->

## Related issues

<!-- e.g. closes #123, refs #456 -->
