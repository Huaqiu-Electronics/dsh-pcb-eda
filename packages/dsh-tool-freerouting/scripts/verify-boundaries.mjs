import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
async function files(directory) {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? files(path) : [path];
      }),
    )
  ).flat();
}
const errors = [],
  tools = [],
  views = [];
for (const path of await files(resolve(root, 'src'))) {
  if (!/\.tsx?$/.test(path)) {
    continue;
  }
  const content = await readFile(path, 'utf8');
  const name = relative(root, path).replaceAll('\\', '/');
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  if (content.split('\n').length > 500) {
    errors.push(`${name}: exceeds 500 lines`);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (name.startsWith('src/client/') && name.endsWith('.tsx') && specifier.endsWith('/run-api.js')) {
        errors.push(`${name}: components must call hooks instead of the browser API adapter`);
      }
      if (
        specifier.startsWith('@huaqiu/') ||
        (name.startsWith('src/client/') &&
          (specifier.startsWith('node:') ||
            (specifier.startsWith('../') &&
              !specifier.startsWith('../presentation/') &&
              !specifier.startsWith('../contracts/')))) ||
        (name.startsWith('src/presentation/') && !specifier.startsWith('./')) ||
        (name.startsWith('src/contracts/') && specifier !== 'zod' && !specifier.startsWith('./'))
      ) {
        errors.push(`${name}: invalid boundary import ${specifier}`);
      }
    }
    if (name.startsWith('src/client/') && name.endsWith('.tsx')) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['fetch', 'loadStatus', 'loadPreview', 'downloadResult'].includes(node.expression.text)
      ) {
        errors.push(`${name}: request ${node.expression.text} belongs in a hook/API adapter`);
      }
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(source) === 'style' &&
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression &&
        ts.isObjectLiteralExpression(node.initializer.expression) &&
        node.initializer.expression.properties.length > 0 &&
        node.initializer.expression.properties.every(
          (property) =>
            ts.isPropertyAssignment(property) &&
            (ts.isStringLiteral(property.initializer) ||
              ts.isNumericLiteral(property.initializer) ||
              property.initializer.kind === ts.SyntaxKind.TrueKeyword ||
              property.initializer.kind === ts.SyntaxKind.FalseKeyword),
        )
      ) {
        errors.push(`${name}: static inline styles belong in routing-card.css`);
      }
    }
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) {
      const key = node.name.getText(source),
        value = node.initializer.text;
      if (name.startsWith('src/tools/') && key === 'name' && value.startsWith('pcb_')) {
        tools.push(value);
      }
      if (name.startsWith('src/client/') && key === 'key' && value.startsWith('pcb_')) {
        views.push(value);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const name of [
  'pcb_route',
  'pcb_route_nets',
  'pcb_confirm_board_checked',
  'pcb_repair_route',
  'pcb_cancel_route',
]) {
  if (tools.filter((value) => value === name).length !== 1) {
    errors.push(`Tool ${name} must be defined once`);
  }
}
for (const name of ['pcb_route', 'pcb_route_nets', 'pcb_repair_route']) {
  if (views.filter((value) => value === name).length !== 1) {
    errors.push(`Tool view ${name} must be defined once`);
  }
}
if (errors.length) {
  throw new Error(errors.join('\n'));
}
console.log('DSH IPC boundaries and tool registrations verified');
