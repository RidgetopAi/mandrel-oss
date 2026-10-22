/**
 * OpenAPI Configuration - Re-export from modular structure
 *
 * This file maintains backward compatibility.
 * The actual implementation is in ./openapi/index.ts
 *
 * NOTE: `./openapi/index.ts` is the SERVING path — it loads the spec
 * built into dist/. Generation from the route sources now lives in
 * `./openapi/generate.ts` and is a BUILD-time concern; do not re-export it here.
 */

export { swaggerSpec, swaggerSpec as default, specResolution } from './openapi/index';
