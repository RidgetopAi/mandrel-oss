import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import swaggerSpec from '../src/config/openapi';

const OUTPUT_PATH = path.resolve(__dirname, '../../frontend/.openapi/openapi.json');

mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(swaggerSpec, null, 2));

console.log(`OpenAPI specification exported to ${OUTPUT_PATH}`);
