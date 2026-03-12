/**
 * Resilience — Circuit Breaker + Timeout/Retry Tracking
 *
 * Lightweight circuit breaker for external services (Fynd, Shopify, SMTP).
 * Prevents cascading failures when a dependency is down.
 *
 * States: closed (normal) → open (blocking) → half_open (testing) → closed
 */

import { securityLogger } from "./logger.server";
import {
  circuitBreakerStateChange,
  circuitBreakerRejected,
  externalTimeoutCounter,
  fallbackActivated,
} from "./metrics.server";

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half_open";

const STATE_NUMERIC: Record<CircuitState, number> = {
  closed: 0,
  open: 1,
  half_open: 2,
};

export class CircuitBreaker {
  private _state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private lastStateChange = Date.now();

  constructor(
    public readonly name: string,
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 30_000,
    private readonly halfOpenMaxAttempts: number = 3,
  ) {}

  get state(): CircuitState {
    // Auto-transition from open to half_open after timeout
    if (this._state === "open" && Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
      this.transitionTo("half_open");
    }
    return this._state;
  }

  get stateNumeric(): number {
    return STATE_NUMERIC[this.state];
  }

  /**
   * Check if a request should be allowed through.
   * Returns true if the circuit allows execution.
   */
  canExecute(): boolean {
    const currentState = this.state;

    if (currentState === "closed") return true;

    if (currentState === "half_open") {
      // Allow limited requests in half_open to test recovery
      return this.successCount < this.halfOpenMaxAttempts;
    }

    // Open — reject
    circuitBreakerRejected.add(1, { service: this.name });
    return false;
  }

  /**
   * Record a successful execution. May close the circuit.
   */
  recordSuccess(): void {
    if (this._state === "half_open") {
      this.successCount++;
      if (this.successCount >= this.halfOpenMaxAttempts) {
        this.transitionTo("closed");
      }
    } else if (this._state === "closed") {
      // Reset failure count on success
      this.failureCount = 0;
    }
  }

  /**
   * Record a failed execution. May open the circuit.
   */
  recordFailure(): void {
    this.lastFailureTime = Date.now();

    if (this._state === "half_open") {
      // Any failure in half_open → back to open
      this.transitionTo("open");
      return;
    }

    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.transitionTo("open");
    }
  }

  /**
   * Execute a function with circuit breaker protection.
   * Throws CircuitOpenError if circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  private transitionTo(newState: CircuitState): void {
    const prevState = this._state;
    if (prevState === newState) return;

    this._state = newState;
    this.lastStateChange = Date.now();

    if (newState === "closed") {
      this.failureCount = 0;
      this.successCount = 0;
    } else if (newState === "half_open") {
      this.successCount = 0;
    }

    circuitBreakerStateChange.add(1, {
      service: this.name,
      from_state: prevState,
      to_state: newState,
    });

    securityLogger.warn(
      {
        circuit: this.name,
        from: prevState,
        to: newState,
        failureCount: this.failureCount,
        timeSinceLastChange: Date.now() - this.lastStateChange,
      },
      `Circuit breaker ${this.name}: ${prevState} → ${newState}`,
    );
  }

  /** Get current status for health checks */
  getStatus(): {
    name: string;
    state: CircuitState;
    stateNumeric: number;
    failureCount: number;
    lastStateChange: number;
  } {
    return {
      name: this.name,
      state: this.state,
      stateNumeric: this.stateNumeric,
      failureCount: this.failureCount,
      lastStateChange: this.lastStateChange,
    };
  }
}

export class CircuitOpenError extends Error {
  constructor(public readonly serviceName: string) {
    super(`Circuit breaker open for ${serviceName} — requests are being rejected`);
    this.name = "CircuitOpenError";
  }
}

// ---------------------------------------------------------------------------
// Pre-built circuit breakers for key services
// ---------------------------------------------------------------------------

/** Circuit breaker for Fynd Platform API calls */
export const fyndCircuitBreaker = new CircuitBreaker("fynd", 5, 30_000);

/** Circuit breaker for Shopify GraphQL API calls */
export const shopifyCircuitBreaker = new CircuitBreaker("shopify", 5, 30_000);

/** Circuit breaker for SMTP/email delivery */
export const smtpCircuitBreaker = new CircuitBreaker("smtp", 3, 60_000);

/** Circuit breaker for WhatsApp API */
export const whatsappCircuitBreaker = new CircuitBreaker("whatsapp", 3, 60_000);

// ---------------------------------------------------------------------------
// Timeout tracking
// ---------------------------------------------------------------------------

/**
 * Record an external API timeout.
 */
export function recordTimeout(
  service: string,
  operation: string,
  timeoutMs: number,
): void {
  externalTimeoutCounter.add(1, { service, operation, timeout_ms: String(timeoutMs) });
  securityLogger.warn(
    { service, operation, timeoutMs },
    `External timeout: ${service}.${operation} (${timeoutMs}ms)`,
  );
}

/**
 * Record activation of a fallback path.
 */
export function recordFallback(
  service: string,
  fallbackType: string,
  meta?: Record<string, string>,
): void {
  fallbackActivated.add(1, { service, fallback_type: fallbackType });
  securityLogger.info(
    { service, fallbackType, ...meta },
    `Fallback activated: ${service} — ${fallbackType}`,
  );
}

// ---------------------------------------------------------------------------
// Get all circuit breaker statuses (for health endpoint)
// ---------------------------------------------------------------------------

export function getAllCircuitBreakerStatuses() {
  return [
    fyndCircuitBreaker.getStatus(),
    shopifyCircuitBreaker.getStatus(),
    smtpCircuitBreaker.getStatus(),
    whatsappCircuitBreaker.getStatus(),
  ];
}
