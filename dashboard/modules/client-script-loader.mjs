// Load a dashboard module's source as a browser-safe script string.
//
// Why: renderPage() emits a monolithic HTML template with inline
// <script> blocks. When we extract browser-safe logic into an ES module
// under ./modules/, the Node side can `import` it, but the inline
// client-side script cannot. Strip ES-module export syntax so the
// source can be embedded verbatim in a <script> block and keep a
// single source of truth.

import fs from 'node:fs';

const EXPORT_LIST_RE = /^[ \t]*export[ \t]*\{[^}]*\}[ \t]*;?[ \t]*$/gm;
const EXPORT_DECL_PREFIX_RE = /^([ \t]*)export[ \t]+(default[ \t]+)?(async[ \t]+function|function|const|let|var|class)\b/gm;

export function stripEsModuleExports(source) {
  return source
    .replace(EXPORT_LIST_RE, '')
    .replace(EXPORT_DECL_PREFIX_RE, '$1$3');
}

export function loadClientModuleSource(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  return stripEsModuleExports(raw);
}
