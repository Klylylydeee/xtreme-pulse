# ADR 0004: Password-only sign-in on an internal network

- **Status:** Accepted
- **Date:** 2026-09-24 (original spec)

## Context

Xtreme Pulse is reachable only on the office network or through the VPN. Every user is an employee created by HR or the System Administrator.

## Decision

Use Auth.js with the Credentials provider: email and password only, on allowed email domains, with no self-registration and no third-party sign-in. Because the network itself limits who can reach the app, there's no MFA, account lockout or login history. JWT sessions can't be revoked on their own, so the account status is checked on every request.

## Consequences

- Simple sign-in with nothing external to depend on.
- The network boundary is part of the security model. Exposing the app outside the office network or VPN means revisiting MFA, lockout and login history first.
- Password reset by email waits for the email system. Until then, HR or the System Administrator resets passwords.

## Where the rules live

[Account & access](../../SECURITY.md#account--access), [Network exposure](../../SECURITY.md#network-exposure)
