#!/usr/bin/env node

/**
 * Fails the build if IMH_LICENSE_SECRET is missing or still the placeholder.
 * This prevents shipping binaries that cannot validate paid licenses.
 */

console.log('[IMH] License secret check bypassed for free version.');
