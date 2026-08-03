import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts');

/** Loads prompts/{name}.md and replaces every {{KEY}} placeholder with vars[KEY] (empty string if unset). */
export function loadPrompt(name, vars = {}) {
  const filePath = path.join(PROMPTS_DIR, `${name}.md`);
  let text = fs.readFileSync(filePath, 'utf-8');
  for (const [key, value] of Object.entries(vars)) {
    text = text.split(`{{${key}}}`).join(value ?? '');
  }
  return text;
}
