// The permission list lives in `common/auth` so the core principal type (`JwtPayload`) and the
// `User` entity do not depend on the payments domain. Re-exported here so payments code and its
// tests keep importing it from the finance module.
export * from '../common/auth/finance-permissions';
