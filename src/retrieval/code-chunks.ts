import ts from "typescript-ast";
import { hashText, type Chunk } from "./chunk-types.js";

const MAX_LINES = 100;
const MAX_CHARACTERS = 4000;

/** Keep semantic ancestors intact; embed only the small terminal chunks. */
export function codeChunks(
  repository: string,
  file: string,
  content: string,
  indexVersion: string,
): Chunk[] {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const lines = content.split("\n");
  const fileHash = hashText(content);
  const chunks: Chunk[] = [];
  const ranges = new Map<string, Chunk>();
  const start = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const end = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.end).line + 1;
  const add = (
    symbol: string,
    first: number,
    last: number,
    kind: NonNullable<Chunk["kind"]>,
    parent?: Chunk,
  ) => {
    const key = JSON.stringify([symbol, first, last, parent?.id]);
    const existing = ranges.get(key);
    if (existing) return existing;
    const raw = hashText(
      JSON.stringify([
        repository,
        file,
        symbol,
        first,
        last,
        fileHash,
        indexVersion,
        parent?.id,
      ]),
    ).slice(0, 32);
    const chunk: Chunk = {
      id: `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`,
      repository,
      path: file,
      symbol,
      startLine: first,
      endLine: last,
      fileHash,
      indexVersion,
      content: lines.slice(first - 1, last).join("\n"),
      kind,
      role: "leaf",
      ...(parent ? { parentId: parent.id } : {}),
    };
    if (parent) parent.role = "parent";
    chunks.push(chunk);
    ranges.set(key, chunk);
    return chunk;
  };
  const large = (node: ts.Node) =>
    end(node) - start(node) + 1 > MAX_LINES ||
    node.getWidth(source) > MAX_CHARACTERS;

  // Last resort for a single indivisible statement (e.g. a huge literal).
  const windows = (parent: Chunk) => {
    for (let first = parent.startLine; first <= parent.endLine; first += 90) {
      const last = Math.min(parent.endLine, first + MAX_LINES - 1);
      add(`${parent.symbol}#lines:${first}`, first, last, "fragment", parent);
      if (last === parent.endLine) break;
    }
  };
  const statementsOf = (node: ts.Node): readonly ts.Statement[] | undefined => {
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      node.initializer
    )
      return statementsOf(node.initializer);
    if (ts.isBlock(node) || ts.isSourceFile(node)) return node.statements;
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      node.body &&
      ts.isBlock(node.body)
    )
      return node.body.statements;
    return undefined;
  };
  const divide = (node: ts.Node, parent: Chunk) => {
    const statements = statementsOf(node);
    if (statements?.length) {
      let group: ts.Statement[] = [];
      const flush = () => {
        if (!group.length) return;
        add(
          `${parent.symbol}#statements:${start(group[0])}`,
          start(group[0]),
          end(group[group.length - 1]),
          "fragment",
          parent,
        );
        group = [];
      };
      for (const statement of statements) {
        if (large(statement)) {
          flush();
          const child = add(
            `${parent.symbol}#${ts.SyntaxKind[statement.kind]}:${start(statement)}`,
            start(statement),
            end(statement),
            "branch",
            parent,
          );
          divide(statement, child);
        } else {
          if (
            group.length &&
            (end(statement) - start(group[0]) + 1 > MAX_LINES ||
              statement.end - group[0].getStart(source) > MAX_CHARACTERS)
          )
            flush();
          group.push(statement);
        }
      }
      flush();
      return;
    }
    const branches: Array<[string, ts.Node]> = [];
    if (ts.isIfStatement(node)) {
      if (start(node.thenStatement) > start(node))
        add(
          `${parent.symbol}/condition`,
          start(node),
          start(node.thenStatement) - 1,
          "branch",
          parent,
        );
      branches.push(["if", node.thenStatement]);
      if (node.elseStatement) branches.push(["else", node.elseStatement]);
    } else if (ts.isSwitchStatement(node)) {
      for (const clause of node.caseBlock.clauses)
        branches.push([
          ts.isCaseClause(clause)
            ? `case ${clause.expression.getText(source)}`
            : "default",
          clause,
        ]);
    } else if (ts.isTryStatement(node)) {
      branches.push(["try", node.tryBlock]);
      if (node.catchClause) branches.push(["catch", node.catchClause.block]);
      if (node.finallyBlock) branches.push(["finally", node.finallyBlock]);
    } else if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      branches.push(["body", node.statement]);
    } else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      for (const statement of node.statements)
        branches.push([`statement:${start(statement)}`, statement]);
    }
    if (!branches.length) {
      const findCallbacks = (child: ts.Node) => {
        if (
          (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) &&
          child.body &&
          ts.isBlock(child.body)
        )
          branches.push([`callback:${start(child)}`, child]);
        else ts.forEachChild(child, findCallbacks);
      };
      ts.forEachChild(node, findCallbacks);
    }
    if (branches.length) {
      for (const [label, branch] of branches) {
        const child = add(
          `${parent.symbol}/${label}`,
          start(branch),
          end(branch),
          "branch",
          parent,
        );
        if (large(branch)) divide(branch, child);
      }
    } else windows(parent);
  };
  const callable = (
    node: ts.Node,
    symbol: string,
    parent?: Chunk,
    kind: NonNullable<Chunk["kind"]> = "function",
  ) => {
    const chunk = add(symbol, start(node), end(node), kind, parent);
    if (large(node)) divide(node, chunk);
    return chunk;
  };
  const nestedFunctions = (node: ts.Node, parent: Chunk) => {
    ts.forEachChild(node, (child) => {
      if (
        (ts.isFunctionDeclaration(child) || ts.isFunctionExpression(child)) &&
        child.name
      ) {
        const chunk = callable(child, child.name.text, parent);
        nestedFunctions(child, chunk);
      } else if (
        ts.isVariableDeclaration(child) &&
        child.initializer &&
        (ts.isArrowFunction(child.initializer) ||
          ts.isFunctionExpression(child.initializer))
      ) {
        const chunk = callable(
          child.initializer,
          child.name.getText(source),
          parent,
        );
        nestedFunctions(child.initializer, chunk);
      } else nestedFunctions(child, parent);
    });
  };
  for (const node of source.statements) {
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text ?? "default";
      const parent = add(name, start(node), end(node), "class");
      for (const member of node.members) {
        const memberName = ts.isConstructorDeclaration(member)
          ? "constructor"
          : member.name?.getText(source);
        if (!memberName) continue;
        const method =
          ts.isMethodDeclaration(member) ||
          ts.isConstructorDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member);
        const chunk = callable(
          member,
          `${name}.${memberName}`,
          parent,
          method ? "method" : "declaration",
        );
        nestedFunctions(member, chunk);
      }
    } else if (ts.isFunctionDeclaration(node)) {
      const chunk = callable(node, node.name?.text ?? "default");
      nestedFunctions(node, chunk);
    } else if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      callable(node, node.name.text, undefined, "declaration");
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const chunk = callable(
          declaration,
          declaration.name.getText(source),
          undefined,
          "declaration",
        );
        nestedFunctions(declaration, chunk);
      }
    } else if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.expression.left) &&
      ts.isIdentifier(node.expression.left.expression) &&
      node.expression.left.expression.text === "module" &&
      node.expression.left.name.text === "exports" &&
      (ts.isFunctionExpression(node.expression.right) ||
        (ts.isArrowFunction(node.expression.right) &&
          ts.isBlock(node.expression.right.body)))
    ) {
      const parent = callable(node.expression.right, "module.exports");
      if (
        ts.isFunctionExpression(node.expression.right) &&
        node.expression.right.name
      )
        callable(
          node.expression.right,
          node.expression.right.name.text,
          parent,
        );
      nestedFunctions(node.expression.right, parent);
    } else {
      const chunk = add("module", start(node), end(node), "module");
      if (large(node)) divide(node, chunk);
    }
  }
  // A short function containing a nested function still has searchable outer logic.
  for (const chunk of [...chunks]) {
    if (
      chunk.role === "parent" &&
      chunk.kind !== "class" &&
      chunk.endLine - chunk.startLine + 1 <= MAX_LINES &&
      chunk.content.length <= MAX_CHARACTERS &&
      !chunks.some(
        (child) =>
          child.parentId === chunk.id &&
          child.startLine === chunk.startLine &&
          child.endLine === chunk.endLine,
      )
    )
      add(
        `${chunk.symbol}#body`,
        chunk.startLine,
        chunk.endLine,
        "fragment",
        chunk,
      );
  }
  if (!chunks.length && content.trim())
    add("module", 1, lines.length, "module");
  return chunks;
}
