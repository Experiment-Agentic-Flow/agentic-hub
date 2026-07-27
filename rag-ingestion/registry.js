import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(__dirname, '..', 'rag-registry.json');

export function readRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  const registry = JSON.parse(raw);
  if (!Array.isArray(registry.api_services) || !Array.isArray(registry.monorepos)) {
    throw new Error('rag-registry.json must contain "api_services" and "monorepos" arrays');
  }
  return registry;
}

/** Looks up the registered branch for `repo` (checked across both api_services and monorepos). */
export function findRegistryBranch(repo) {
  const { api_services, monorepos } = readRegistry();
  const entry = [...api_services, ...monorepos].find((e) => e.repo === repo);
  return entry?.branch;
}
