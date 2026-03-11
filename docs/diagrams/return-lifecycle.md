# Return Lifecycle -- State Diagram

This document describes every status a return case (`ReturnCase.status`) can hold and the transitions between them. Each arrow is labeled with the trigger that causes the transition.

---

## Status Overview

| Status        | Type       | Description                                             |
|---------------|------------|---------------------------------------------------------|
| `initiated`   | Initial    | Return submitted by customer via portal (alias for pending) |
| `pending`     | Initial    | Return awaiting admin review                            |
| `processing`  | Active     | Admin has begun reviewing or processing the return      |
| `in progress` | Active     | Return is actively being handled (logistics, QC, etc.)  |
| `approved`    | Active     | Return approved; awaiting refund or item receipt        |
| `rejected`    | Terminal   | Return denied by admin with a reason                    |
| `completed`   | Terminal   | Refund issued and/or return fully resolved              |
| `cancelled`   | Terminal   | Return cancelled by admin or system                     |

---

## State Transition Diagram

```
                          Customer submits return
                                   |
                                   v
                    +------------------------------+
                    |    INITIATED / PENDING       |
                    |   (new return request)        |
                    +------------------------------+
                       |        |        |        |
    +-auto-approve-----+        |        |        +----admin cancels--------+
    |  rules match              |        |                                  |
    |                           |        +---admin rejects---+              |
    v                           |                            |              |
+----------+        admin moves to               +-----------v-+    +------v------+
| APPROVED |<------ processing/review            |  REJECTED   |    |  CANCELLED  |
+----------+            |                        |  (terminal) |    |  (terminal) |
    |    |               v                       +-------------+    +-------------+
    |    |      +---------------+
    |    |      |  PROCESSING   |
    |    |      |  / IN PROGRESS|
    |    |      +---------------+
    |    |         |         |
    |    |   admin |    admin|
    |    |  approves  rejects|
    |    |         |         |
    |    |         v         v
    |    |    APPROVED   REJECTED
    |    |
    |    +---admin cancels-----------+
    |                                |
    |                                v
    |                          +-------------+
    +--refund issued---------->| COMPLETED   |
       or green return         | (terminal)  |
       resolved                +-------------+
```

---

## Detailed Transition Table

| From            | To              | Trigger                                                                 |
|-----------------|-----------------|-------------------------------------------------------------------------|
| `initiated`     | `approved`      | Auto-approve rules match at submission time                             |
| `initiated`     | `pending`       | Implicit -- `initiated` and `pending` are functionally equivalent       |
| `initiated`     | `rejected`      | Admin rejects via dashboard or bulk action                              |
| `initiated`     | `cancelled`     | Admin cancels via dashboard or bulk action                              |
| `pending`       | `approved`      | Admin approves via return detail page or API                            |
| `pending`       | `rejected`      | Admin rejects with a rejection reason                                   |
| `pending`       | `processing`    | Admin moves to processing status                                       |
| `pending`       | `in progress`   | Admin moves to in-progress status                                       |
| `pending`       | `cancelled`     | Admin cancels the return                                                |
| `processing`    | `approved`      | Admin approves after review                                             |
| `processing`    | `rejected`      | Admin rejects after review                                              |
| `processing`    | `cancelled`     | Admin cancels the return                                                |
| `in progress`   | `approved`      | Admin approves after handling                                           |
| `in progress`   | `rejected`      | Admin rejects after handling                                            |
| `in progress`   | `cancelled`     | Admin cancels the return                                                |
| `approved`      | `completed`     | Refund issued (original payment, store credit, or discount code)        |
| `approved`      | `completed`     | Green return resolved (customer keeps item, refund issued)              |
| `approved`      | `completed`     | Fynd webhook reports `refund_done` / `refunded` / `completed`           |
| `approved`      | `completed`     | Fynd status poll detects terminal refund status                         |
| `approved`      | `cancelled`     | Admin cancels an approved-but-not-yet-refunded return                   |
| `rejected`      | --              | Terminal state. No outbound transitions.                                |
| `completed`     | --              | Terminal state. No outbound transitions.                                |
| `cancelled`     | --              | Terminal state. No outbound transitions.                                |

---

## Terminal Status Rules

The codebase enforces terminal status constraints in multiple places:

```typescript
const TERMINAL_STATUSES = ["approved", "rejected", "completed", "cancelled"];
```

Once a return reaches `rejected`, `completed`, or `cancelled`, no further status updates are allowed through the standard approve/reject actions. The `approved` status is included in the terminal list for approve/reject guards (you cannot approve an already-approved return), but approved returns can still transition to `completed` or `cancelled`.

---

## Non-Terminal (Active) Statuses

Used to determine which returns are "open" and need attention:

```typescript
const NON_TERMINAL_STATUSES = ["initiated", "pending", "processing", "in progress", "approved"];
```

These statuses appear in dashboard counts, active return lists, and duplicate-submission checks on the portal.

---

## Refund Sub-Lifecycle

Refund status is tracked separately in `ReturnCase.refundStatus` and does not affect the main status directly, except that a successful refund typically triggers the `approved -> completed` transition.

```
(null)  ───refund initiated──>  refund_in_progress  ───success──>  refunded
                                        |
                                        +───failure──>  failed
```

---

## Fynd Status Synchronization

When Fynd integration is active, inbound webhooks update `ReturnCase.fyndCurrentStatus` independently from the ReturnProMax status. Certain Fynd terminal statuses (`refund_done`, `refunded`, `completed`) trigger an automatic transition to `completed` in the ReturnProMax status.

```
Fynd webhook arrives
        |
        v
Update fyndCurrentStatus field
        |
        +-- Is Fynd status a refund-complete status?
        |       |
        |      YES --> Set ReturnCase.status = "completed"
        |              Set ReturnCase.refundStatus = "refunded"
        |
        +-- Otherwise --> Log status update, no RPM status change
```

---

*Last updated: 2026-03-12*
