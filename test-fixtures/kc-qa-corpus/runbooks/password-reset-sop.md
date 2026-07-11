# Emergency password reset SOP

## Scope

Applies when a user is locked out and cannot use self-service MFA recovery.

## Approval

An **emergency password reset** requires approval from the user's manager **or** a SOC lead on call.
Document the approver name in the ServiceNow ticket.

## Procedure

1. Verify caller identity using employee ID and manager callback.
2. Reset password in Active Directory admin console.
3. Force MFA re-enrollment on next login.
4. Send the temporary password through the approved secure channel (never email).

## Audit

All emergency resets are logged to `auth-service.log` with tag `EMERGENCY_RESET`.
