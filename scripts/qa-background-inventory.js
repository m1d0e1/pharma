#!/usr/bin/env node
'use strict';

// Source-level inventory, not execution evidence. Runtime verification is
// recorded separately by Jest and the isolated WebView2 CDP stage.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function walk(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['__tests__', 'node_modules', '.next', 'out'].includes(entry.name)) walk(name, output);
    } else if (/\.(tsx|jsx)$/.test(entry.name)) output.push(name);
  }
  return output;
}

function catalog() {
  const files = [...walk(path.join(root, 'src/app')), ...walk(path.join(root, 'src/components'))];
  const controls = [];
  const tags = new Set(['button', 'input', 'textarea', 'select', 'form', 'option', 'a', 'Link']);
  const sensitive = /pay|refund|supplier|checkout|save|submit|delete|remove|restore|rollback|merge|post|charge|close|revoke|activate|renew|approve|purchase|return|تحصيل|سداد|حفظ|حذف|اعتماد|استرداد|مرتجع|مورد|وردية/i;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const filename = path.relative(root, file).replaceAll('\\', '/');
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(ast);
        const attributes = {};
        for (const attr of node.attributes.properties) {
          if (ts.isJsxAttribute(attr)) attributes[attr.name.getText(ast)] = attr.initializer?.getText(ast) || 'true';
        }
        if (tags.has(tag) || ['tab', 'switch', 'menuitem', 'checkbox', 'combobox'].some(role => attributes.role?.includes(role))) {
          const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          const handler = attributes.onClick || attributes.onSubmit || attributes.onChange || attributes.onKeyDown || null;
          const label = attributes['aria-label'] || attributes.title || attributes.placeholder || attributes.name || '';
          const intent = `${handler || ''} ${label} ${attributes.type || ''} ${attributes.role || ''}`;
          controls.push({ source: filename, line: line + 1, tag,
            role: attributes.role || null, label_expression: label.slice(0, 100),
            handler_expression: handler?.slice(0, 140) || null,
            required: Object.hasOwn(attributes, 'required'),
            disabled_expression: attributes.disabled?.slice(0, 120) || null,
            category: sensitive.test(intent) || ['form'].includes(tag) || attributes.type?.includes('submit')
              ? 'state_changing_or_sensitive_manual_native_check'
              : ['button', 'option', 'select', 'input', 'textarea'].includes(tag)
                ? 'read_or_input_requires_runtime_verification' : 'navigation_or_option',
            coverage: 'source_inventoried_not_proven' });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  const buckets = controls.reduce((acc, c) => {
    acc[c.tag] = (acc[c.tag] || 0) + 1;
    return acc;
  }, {});
  return { source_files: files.length, controls_found: controls.length,
    counts_by_element: buckets,
    sensitive_manual_count: controls.filter(c => c.category === 'state_changing_or_sensitive_manual_native_check').length,
    coverage_semantics: 'AST/source inventory only; Jest and CDP runtime steps tracked independently',
    controls };
}

if (require.main === module) console.log(JSON.stringify(catalog(), null, 2));
module.exports = { catalog };
