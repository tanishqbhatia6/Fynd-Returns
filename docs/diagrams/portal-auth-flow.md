# Portal Authentication Flow

## OTP Verification Sequence

```
Customer                    Portal SPA                   Server
   │                            │                           │
   │  Enter order# + email      │                           │
   │ ─────────────────────────► │                           │
   │                            │  POST /api/portal/lookup  │
   │                            │ ────────────────────────► │
   │                            │                           │ Create LookupSession
   │                            │                           │ Hash lookup value (SHA-256)
   │                            │                           │ Find matching returns
   │                            │                           │
   │                            │  { requiresOtp: true,     │
   │                            │    sessionId: "..." }     │
   │                            │ ◄──────────────────────── │
   │                            │                           │
   │  (Portal shows OTP input)  │                           │
   │                            │  POST /api/portal/otp/send│
   │                            │ ────────────────────────► │
   │                            │                           │ Generate 6-digit OTP
   │                            │                           │ Hash OTP (bcrypt)
   │                            │                           │ Store hash + sentAt
   │                            │                           │ Send email/SMS
   │                            │                           │
   │  Receive OTP via email     │  { success: true }        │
   │ ◄─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │ ◄──────────────────────── │
   │                            │                           │
   │  Enter OTP code            │                           │
   │ ─────────────────────────► │                           │
   │                            │  POST /api/portal/otp/    │
   │                            │        verify             │
   │                            │ ────────────────────────► │
   │                            │                           │ Verify hash matches
   │                            │                           │ Check expiry (5 min)
   │                            │                           │ Check attempt count
   │                            │                           │ Mark session verified
   │                            │                           │ Generate JWT (1hr TTL)
   │                            │                           │
   │                            │  { verified: true,        │
   │                            │    portalToken: "jwt..." }│
   │                            │ ◄──────────────────────── │
   │                            │                           │
   │  (Portal stores JWT)       │                           │
   │                            │  GET /api/portal/returns  │
   │                            │  Authorization: Bearer jwt│
   │                            │ ────────────────────────► │
   │                            │                           │ Verify JWT signature
   │                            │                           │ Check session verified
   │                            │                           │ Load return data
   │                            │                           │
   │  View return details       │  { returns: [...] }       │
   │ ◄───────────────────────── │ ◄──────────────────────── │
```

## Security Controls

| Control | Detail |
|---------|--------|
| OTP length | 6 digits |
| OTP expiry | 5 minutes from generation |
| OTP hash | bcrypt (plaintext never stored; legacy SHA-256 accepted only for pre-rollout sessions) |
| Max OTP send attempts | 5 per 5-minute window |
| Max verify attempts | 10 per session, lockout at 0 remaining |
| JWT TTL | 1 hour |
| JWT secret | PORTAL_JWT_SECRET (min 32 chars, required in production) |
| Session expiry | LookupSession.expiresAt (typically 1 hour) |
| Lookup value | Always hashed before storage (SHA-256) |
| Rate limiting | 5 OTP sends / 5 min, 10 verifies / min per IP |

## Dev Mode Behavior

When `NODE_ENV !== "production"` and SMTP is not configured:
- OTP is emitted only through the structured redacted development logger
- No email is actually sent
- JWT secret falls back to a dev default (with a structured warning)

## Session Cleanup

Expired `LookupSession` records are cleaned up by `cleanupExpiredSessions()`.
Default retention: 7 days past expiry.
