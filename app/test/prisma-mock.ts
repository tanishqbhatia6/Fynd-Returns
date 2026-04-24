/**
 * Reusable Prisma mock factory for unit + integration tests.
 *
 * Motivation
 * ──────────
 * Most of our server code touches Prisma. Writing ad-hoc `vi.fn()` for
 * every model in every test file:
 *   (a) leads to drift — tests diverge from the real schema,
 *   (b) duplicates boilerplate, and
 *   (c) silently passes when the SUT calls a model/method we forgot to
 *       mock (undefined is neither an assert nor a throw).
 *
 * This factory creates a single object covering every model used in the
 * app, with every method pre-stubbed as a `vi.fn()` that returns a
 * sensible default. Tests override just the calls they care about via
 * `mockResolvedValueOnce` / `mockImplementationOnce`.
 *
 * Usage
 * ─────
 *   import { createPrismaMock } from "../../test/prisma-mock";
 *   const { findManyMock } = vi.hoisted(() => ({
 *     findManyMock: vi.fn(),
 *   }));
 *   const prismaMock = createPrismaMock({ returnCase: { findFirst: findManyMock } });
 *   vi.mock("../../db.server", () => ({ default: prismaMock }));
 *
 * If the subject under test touches a method you haven't stubbed, the
 * factory's default returns `null` (findUnique / findFirst) or `[]`
 * (findMany / groupBy) — same as the real Prisma for empty tables.
 */

import { vi } from "vitest";

type JsMethod =
  | "findFirst"
  | "findUnique"
  | "findMany"
  | "count"
  | "groupBy"
  | "aggregate"
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "upsert"
  | "delete"
  | "deleteMany";

type ModelOverride = Partial<Record<JsMethod, ReturnType<typeof vi.fn>>>;

/** Every Prisma model the app uses. Keep in sync with `prisma/schema.prisma`. */
export const PRISMA_MODELS = [
  "shop",
  "shopSettings",
  "returnCase",
  "returnItem",
  "returnEvent",
  "session",
  "apiKey",
  "webhookEndpoint",
  "webhookSubscription",
  "webhookDeliveryFailure",
  "webhookDelivery",
  "fyndWebhookLog",
  "lookupSession",
  "blocklistEntry",
  "notification",
  "customerRiskProfile",
] as const;

export type PrismaModel = (typeof PRISMA_MODELS)[number];

/**
 * Build a default mock for a single model. Each method is a `vi.fn()`
 * resolving to a schema-friendly empty value.
 */
function makeModelMock(): Record<JsMethod, ReturnType<typeof vi.fn>> {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockResolvedValue({ _count: 0, _sum: {}, _avg: {}, _min: {}, _max: {} }),
    create: vi.fn().mockImplementation(async ({ data }) => ({ id: "cmmock", ...data })),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    update: vi.fn().mockImplementation(async ({ data, where }) => ({ ...where, ...data })),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert: vi.fn().mockImplementation(async ({ create, where }) => ({ ...where, ...create })),
    delete: vi.fn().mockImplementation(async ({ where }) => ({ ...where })),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

/**
 * Build a complete Prisma mock with every model + method stubbed.
 *
 * `overrides` is a shallow map keyed by model name, values are partial
 * objects whose methods override the default stubs. This preserves test
 * readability — you only see the lines you actually care about.
 */
export function createPrismaMock(
  overrides: Partial<Record<PrismaModel, ModelOverride>> = {},
): Record<PrismaModel, Record<JsMethod, ReturnType<typeof vi.fn>>> & {
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
  $queryRawUnsafe: ReturnType<typeof vi.fn>;
  $executeRawUnsafe: ReturnType<typeof vi.fn>;
  $connect: ReturnType<typeof vi.fn>;
  $disconnect: ReturnType<typeof vi.fn>;
} {
  const mock = {} as Record<PrismaModel, Record<JsMethod, ReturnType<typeof vi.fn>>>;
  for (const model of PRISMA_MODELS) {
    const base = makeModelMock();
    const override = overrides[model];
    if (override) {
      for (const [method, fn] of Object.entries(override) as Array<[JsMethod, ReturnType<typeof vi.fn>]>) {
        base[method] = fn;
      }
    }
    mock[model] = base;
  }
  // Raw / transaction methods — $transaction of a callback runs the
  // callback with the same mock (matches Prisma's behaviour for
  // interactive transactions).
  return Object.assign(mock, {
    $transaction: vi.fn().mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (p: typeof mock) => unknown)(mock);
      }
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return arg;
    }),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  });
}

/** Reset every vi.fn() on the mock — call in beforeEach to isolate tests. */
export function resetPrismaMock(
  mock: ReturnType<typeof createPrismaMock>,
): void {
  for (const model of PRISMA_MODELS) {
    for (const fn of Object.values(mock[model])) {
      fn.mockClear();
    }
  }
  mock.$transaction.mockClear();
  mock.$queryRaw.mockClear();
  mock.$executeRaw.mockClear();
  mock.$queryRawUnsafe.mockClear();
  mock.$executeRawUnsafe.mockClear();
}
