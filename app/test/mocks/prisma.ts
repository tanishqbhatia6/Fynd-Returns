/**
 * Mock Prisma client for tests.
 * All model methods are vi.fn() stubs that can be configured per-test.
 */
import { vi } from "vitest";

function createMockModel() {
  return {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
}

export function createMockPrisma() {
  return {
    shop: createMockModel(),
    shopSettings: createMockModel(),
    session: createMockModel(),
    returnCase: createMockModel(),
    returnItem: createMockModel(),
    returnEvent: createMockModel(),
    fyndWebhookLog: createMockModel(),
    fyndOrderMapping: createMockModel(),
    lookupSession: createMockModel(),
    blocklistEntry: createMockModel(),
    notificationLog: createMockModel(),
    apiKey: createMockModel(),
    webhookSubscription: createMockModel(),
    $transaction: vi.fn((fn: (tx: any) => any) => fn(createMockPrisma())),
  };
}

export const mockPrisma = createMockPrisma();
