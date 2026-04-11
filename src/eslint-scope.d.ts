import type { ScopeManager } from "eslint-scope";

/**
 * Register Glimmer template scopes (path expressions, component references,
 * block params) into an existing eslint-scope ScopeManager.
 */
export function registerGlimmerScopes(scopeManager: ScopeManager): void;
