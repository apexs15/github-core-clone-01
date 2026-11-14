// GitHub GraphQL v4, the documents gh and github-mcp-server actually send. A small, complete
// parser and executor for the GraphQL subset those clients use — queries, mutations, variables,
// aliases, inline fragments (`... on Repository { ... }`), named fragments, inline input objects,
// enums, lists, and batched JSON-array operations — over the same Store the REST API reads, so
// the two views of one repository can never disagree.
//
// The schema the suite introspects is a static table (field names and the SearchType enum) plus
// the live data for repositories, issues and pull requests. An unknown field is a 200 with an
// errors array whose message names the field; an unknown repository is data.repository = null
// with no errors; a missing token is 401. Cursors are base64 of `cursor:<seq>`, so pagination is
// deterministic across runs.

import { scenarioIdentity } from './scenario.ts';
import { type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer + parser (the GraphQL subset the clients send)
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

const PUNCTS = new Set(['{', '}', '(', ')', ':', ',', '!', '$', '=', '@', '[', ']', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCTS.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1] as string;
          if (escaped === 'n') out += '\n';
          else if (escaped === 't') out += '\t';
          else if (escaped === 'r') out += '\r';
          else if (escaped === '"') out += '"';
          else if (escaped === '\\') out += '\\';
          else if (escaped === '/') out += '/';
          else if (escaped === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += escaped;
          j += 2;
          continue;
        }
        out += source[j];
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  arguments: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

export interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationDefinition {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

export interface FragmentDefinition {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export type DefinitionNode = OperationDefinition | FragmentDefinition;

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error('unexpected end of document');
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", got ${token.kind} ${token.value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind} ${token.value}`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.index < this.tokens.length) definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (token?.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new Error('expected "on" after a fragment name');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek()?.kind === 'name') name = this.next().value;
      const variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }> = [];
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
          this.expectPunct('$');
          const varName = this.expectName();
          this.expectPunct(':');
          this.parseType();
          let defaultValue: ValueNode | null = null;
          if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
            this.next();
            defaultValue = this.parseValue();
          }
          this.skipDirectives();
          variableDefinitions.push({ name: varName, defaultValue });
        }
        this.expectPunct(')');
      }
      this.skipDirectives();
      return { kind: 'operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token ${token?.kind} ${token?.value}`);
  }

  private parseType(): void {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, arguments: args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!(this.peek()?.kind === 'punct' && this.peek()?.value === '(')) return args;
    this.next();
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind} ${token.value}`);
  }
}

export function parseGraphQL(source: string): DefinitionNode[] {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

export type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Variables): unknown {
  const arg = field.arguments.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

// ---------------------------------------------------------------------------------------------
// ids and cursors
// ---------------------------------------------------------------------------------------------

function encodeId(kind: string, parts: string): string {
  return Buffer.from(`${kind}:${parts}`, 'utf8').toString('base64');
}

function decodeId(id: string): { kind: string; parts: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const seq = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isNaN(seq) ? null : seq;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// the introspected schema (a static table the suite reads through __type)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', 'search'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'labels', 'comments', 'url'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequest: [
    'id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body',
    'mergedAt', 'mergeCommitSha', 'createdAt', 'url',
  ],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueComment: ['id', 'body', 'createdAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  RepositoryOwner: ['login', 'id'],
  Ref: ['name'],
  Label: ['name', 'color'],
  SearchType: [],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface ExecutionContext {
  store: Store;
  variables: Variables;
  fragments: Map<string, FragmentDefinition>;
  errors: Array<{ message: string }>;
}

type ParentValue =
  | { __typename: 'Query' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: PageInfoValue }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: PullRequest[]; pageInfo: PageInfoValue }
  | { __typename: 'IssueComment'; comment: { id: number; body: string; createdAt: string } }
  | { __typename: 'PageInfo'; value: PageInfoValue }
  | { __typename: 'RepositoryOwner'; login: string; id: number }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Label'; name: string; color: string }
  | { __typename: '__Type'; name: string }
  | { __typename: 'Node'; repo: Repo };

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function unknownField(ctx: ExecutionContext, parentType: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${parentType}".` });
  return null;
}

function issueStateValue(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateValue(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function executeSelectionSet(ctx: ExecutionContext, parent: ParentValue, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(ctx, parent, fragment.selectionSet));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === parent.__typename) {
        Object.assign(out, executeSelectionSet(ctx, parent, selection.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(ctx, parent, selection);
  }
  return out;
}

function executeField(ctx: ExecutionContext, parent: ParentValue, field: FieldNode): unknown {
  const { store, variables } = ctx;
  const viewer = scenarioIdentity().viewer;

  if (parent.__typename === 'Query') {
    if (field.name === 'viewer') {
      if (!field.selectionSet) return { login: viewer.login };
      return executeSelectionSet(ctx, { __typename: 'RepositoryOwner', login: viewer.login, id: viewer.id }, field.selectionSet);
    }
    if (field.name === 'repository') {
      const owner = argValue(field, 'owner', variables);
      const name = argValue(field, 'name', variables);
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      if (owner !== store.ownerLogin()) return null;
      const repo = store.getRepo(name);
      if (!repo) return null;
      if (!field.selectionSet) return {};
      return executeSelectionSet(ctx, { __typename: 'Repository', repo }, field.selectionSet);
    }
    if (field.name === 'node') {
      const id = argValue(field, 'id', variables);
      if (typeof id !== 'string') return null;
      const decoded = decodeId(id);
      if (!decoded || decoded.kind !== 'repo') return null;
      const repoId = Number.parseInt(decoded.parts, 10);
      const repo = [...store.listRepos()].find((candidate) => candidate.id === repoId);
      if (!repo) return null;
      if (!field.selectionSet) return {};
      return executeSelectionSet(ctx, { __typename: 'Repository', repo }, field.selectionSet);
    }
    if (field.name === '__type') {
      const name = argValue(field, 'name', variables);
      if (typeof name !== 'string') return null;
      if (!field.selectionSet) return {};
      return executeSelectionSet(ctx, { __typename: '__Type', name }, field.selectionSet);
    }
    return unknownField(ctx, 'Query', field.name);
  }

  if (parent.__typename === 'Repository') {
    const repo = parent.repo;
    switch (field.name) {
      case 'id':
        return encodeId('repo', String(repo.id));
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner': {
        if (!field.selectionSet) return { login: repo.owner };
        return executeSelectionSet(ctx, { __typename: 'RepositoryOwner', login: repo.owner, id: viewer.id }, field.selectionSet);
      }
      case 'defaultBranchRef': {
        if (!field.selectionSet) return { name: repo.defaultBranch };
        return executeSelectionSet(ctx, { __typename: 'Ref', name: repo.defaultBranch }, field.selectionSet);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'createdAt':
        return repo.createdAt;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'issue': {
        const number = argValue(field, 'number', variables);
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        if (!issue) return null;
        if (!field.selectionSet) return {};
        return executeSelectionSet(ctx, { __typename: 'Issue', repo, issue }, field.selectionSet);
      }
      case 'issues': {
        const first = typeof argValue(field, 'first', variables) === 'number' ? (argValue(field, 'first', variables) as number) : 10;
        const after = argValue(field, 'after', variables);
        const states = argValue(field, 'states', variables);
        const orderBy = argValue(field, 'orderBy', variables) as Record<string, unknown> | undefined;
        let issues = [...repo.issues.values()];
        if (Array.isArray(states) && states.length) {
          const wanted = new Set(states.map((s) => String(s)));
          issues = issues.filter((issue) => wanted.has(issueStateValue(issue.state)));
        }
        const direction = typeof orderBy?.direction === 'string' ? String(orderBy.direction) : 'DESC';
        issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        const afterSeq = decodeCursor(typeof after === 'string' ? after : undefined);
        // The default order is newest first, so the next page holds lower seqs.
        if (afterSeq !== null) issues = issues.filter((issue) => issue.seq < afterSeq);
        const page = issues.slice(0, Math.max(0, first));
        const hasNextPage = issues.length > page.length;
        const pageInfo: PageInfoValue = {
          hasNextPage,
          hasPreviousPage: afterSeq !== null,
          startCursor: page.length ? encodeCursor(page[0]?.seq ?? 0) : null,
          endCursor: page.length ? encodeCursor(page[page.length - 1]?.seq ?? 0) : null,
        };
        if (!field.selectionSet) return { nodes: [] };
        return executeSelectionSet(ctx, { __typename: 'IssueConnection', repo, issues: page, pageInfo }, field.selectionSet);
      }
      case 'pullRequests': {
        const first = typeof argValue(field, 'first', variables) === 'number' ? (argValue(field, 'first', variables) as number) : 10;
        const after = argValue(field, 'after', variables);
        let pulls = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
        const afterSeq = decodeCursor(typeof after === 'string' ? after : undefined);
        if (afterSeq !== null) pulls = pulls.filter((pull) => pull.seq < afterSeq);
        const page = pulls.slice(0, Math.max(0, first));
        const hasNextPage = pulls.length > page.length;
        const pageInfo: PageInfoValue = {
          hasNextPage,
          hasPreviousPage: afterSeq !== null,
          startCursor: page.length ? encodeCursor(page[0]?.seq ?? 0) : null,
          endCursor: page.length ? encodeCursor(page[page.length - 1]?.seq ?? 0) : null,
        };
        if (!field.selectionSet) return { nodes: [] };
        return executeSelectionSet(ctx, { __typename: 'PullRequestConnection', repo, pulls: page, pageInfo }, field.selectionSet);
      }
      case 'pullRequest': {
        const number = argValue(field, 'number', variables);
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.get(number);
        if (!pull) return null;
        if (!field.selectionSet) return {};
        return executeSelectionSet(ctx, { __typename: 'PullRequest', repo, pull }, field.selectionSet);
      }
      default:
        return unknownField(ctx, 'Repository', field.name);
    }
  }

  if (parent.__typename === 'Issue') {
    const issue = parent.issue;
    switch (field.name) {
      case 'id':
        return encodeId('issue', `${parent.repo.id}:${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueStateValue(issue.state);
      case 'body':
        return issue.body;
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'url':
        return `https://example.invalid/${parent.repo.owner}/${parent.repo.name}/issues/${issue.number}`;
      case 'labels': {
        if (!field.selectionSet) return issue.labels;
        return issue.labels.map((label) => executeSelectionSet(ctx, { __typename: 'Label', name: label.name, color: label.color }, field.selectionSet as SelectionNode[]));
      }
      case 'comments': {
        const first = typeof argValue(field, 'first', variables) === 'number' ? (argValue(field, 'first', variables) as number) : 10;
        const comments = issue.comments.slice(0, Math.max(0, first));
        if (!field.selectionSet) return { nodes: comments.map((c) => ({ id: c.id })) };
        const nodes = comments.map((comment) =>
          executeSelectionSet(ctx, { __typename: 'IssueComment', comment }, field.selectionSet as SelectionNode[]),
        );
        return { nodes };
      }
      default:
        return unknownField(ctx, 'Issue', field.name);
    }
  }

  if (parent.__typename === 'PullRequest') {
    const pull = parent.pull;
    switch (field.name) {
      case 'id':
        return encodeId('pull', `${parent.repo.id}:${pull.number}`);
      case 'number':
        return pull.number;
      case 'state':
        return pullStateValue(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable': {
        if (pull.state !== 'open') return 'UNKNOWN';
        return store.pullConflicts(parent.repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeCommitSha':
        return pull.mergeCommitSha;
      case 'createdAt':
        return pull.createdAt;
      case 'url':
        return `https://example.invalid/${parent.repo.owner}/${parent.repo.name}/pull/${pull.number}`;
      case 'files': {
        const first = typeof argValue(field, 'first', variables) === 'number' ? (argValue(field, 'first', variables) as number) : 10;
        const files = store.pullFiles(parent.repo, pull).slice(0, Math.max(0, first));
        if (!field.selectionSet) return { nodes: files.map((f) => ({ path: f.filename })) };
        const nodes = files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }));
        return { nodes };
      }
      default:
        return unknownField(ctx, 'PullRequest', field.name);
    }
  }

  if (parent.__typename === 'IssueConnection') {
    if (field.name === 'nodes') {
      if (!field.selectionSet) return parent.issues.map((issue) => ({ number: issue.number }));
      return parent.issues.map((issue) => executeSelectionSet(ctx, { __typename: 'Issue', repo: parent.repo, issue }, field.selectionSet as SelectionNode[]));
    }
    if (field.name === 'totalCount') return parent.issues.length;
    if (field.name === 'pageInfo') {
      if (!field.selectionSet) return parent.pageInfo;
      return executeSelectionSet(ctx, { __typename: 'PageInfo', value: parent.pageInfo }, field.selectionSet);
    }
    return unknownField(ctx, 'IssueConnection', field.name);
  }

  if (parent.__typename === 'PullRequestConnection') {
    if (field.name === 'nodes') {
      if (!field.selectionSet) return parent.pulls.map((pull) => ({ number: pull.number }));
      return parent.pulls.map((pull) => executeSelectionSet(ctx, { __typename: 'PullRequest', repo: parent.repo, pull }, field.selectionSet as SelectionNode[]));
    }
    if (field.name === 'totalCount') return parent.pulls.length;
    if (field.name === 'pageInfo') {
      if (!field.selectionSet) return parent.pageInfo;
      return executeSelectionSet(ctx, { __typename: 'PageInfo', value: parent.pageInfo }, field.selectionSet);
    }
    return unknownField(ctx, 'PullRequestConnection', field.name);
  }

  if (parent.__typename === 'IssueComment') {
    if (field.name === 'id') return encodeId('comment', String(parent.comment.id));
    if (field.name === 'body') return parent.comment.body;
    if (field.name === 'createdAt') return parent.comment.createdAt;
    return unknownField(ctx, 'IssueComment', field.name);
  }

  if (parent.__typename === 'PageInfo') {
    if (field.name === 'hasNextPage') return parent.value.hasNextPage;
    if (field.name === 'hasPreviousPage') return parent.value.hasPreviousPage;
    if (field.name === 'startCursor') return parent.value.startCursor;
    if (field.name === 'endCursor') return parent.value.endCursor;
    return unknownField(ctx, 'PageInfo', field.name);
  }

  if (parent.__typename === 'RepositoryOwner') {
    if (field.name === 'login') return parent.login;
    if (field.name === 'id') return parent.id;
    return unknownField(ctx, 'RepositoryOwner', field.name);
  }

  if (parent.__typename === 'Ref') {
    if (field.name === 'name') return parent.name;
    return unknownField(ctx, 'Ref', field.name);
  }

  if (parent.__typename === 'Label') {
    if (field.name === 'name') return parent.name;
    if (field.name === 'color') return parent.color;
    return unknownField(ctx, 'Label', field.name);
  }

  if (parent.__typename === '__Type') {
    const name = parent.name;
    if (field.name === 'name') return name;
    if (field.name === 'kind') return ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
    if (field.name === 'fields') {
      const names = TYPE_FIELDS[name] ?? [];
      if (!field.selectionSet) return names.map((n) => ({ name: n }));
      return names.map((n) => executeSelectionSet(ctx, { __typename: '__Type', name: n }, field.selectionSet as SelectionNode[]));
    }
    if (field.name === 'enumValues') {
      const values = ENUM_VALUES[name] ?? [];
      if (!field.selectionSet) return values.map((v) => ({ name: v }));
      return values.map((v) => executeSelectionSet(ctx, { __typename: '__Type', name: v }, field.selectionSet as SelectionNode[]));
    }
    if (field.name === 'description') return null;
    return unknownField(ctx, '__Type', field.name);
  }

  return unknownField(ctx, parent.__typename, field.name);
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

/**
 * Resolve one mutation's payload selection set. The payload wraps the created object: createIssue
 * and closeIssue expose `issue`, createPullRequest and mergePullRequest expose `pullRequest`,
 * addComment exposes `commentEdge { node }`. The wrapped object is resolved against its own type.
 */
function executePayload(
  ctx: ExecutionContext,
  field: FieldNode,
  wrapped: { kind: 'issue'; repo: Repo; issue: Issue } | { kind: 'pullRequest'; repo: Repo; pull: PullRequest } | { kind: 'comment'; comment: { id: number; body: string; createdAt: string } },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!field.selectionSet) return out;
  for (const selection of field.selectionSet) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    if (wrapped.kind === 'issue' && selection.name === 'issue') {
      out[key] = selection.selectionSet
        ? executeSelectionSet(ctx, { __typename: 'Issue', repo: wrapped.repo, issue: wrapped.issue }, selection.selectionSet)
        : {};
      continue;
    }
    if (wrapped.kind === 'pullRequest' && selection.name === 'pullRequest') {
      out[key] = selection.selectionSet
        ? executeSelectionSet(ctx, { __typename: 'PullRequest', repo: wrapped.repo, pull: wrapped.pull }, selection.selectionSet)
        : {};
      continue;
    }
    if (wrapped.kind === 'comment' && selection.name === 'commentEdge') {
      if (!selection.selectionSet) {
        out[key] = { node: { id: encodeId('comment', String(wrapped.comment.id)), body: wrapped.comment.body } };
        continue;
      }
      const edge: Record<string, unknown> = {};
      for (const edgeSelection of selection.selectionSet) {
        if (edgeSelection.kind !== 'field' || edgeSelection.name !== 'node') continue;
        edge.node = edgeSelection.selectionSet
          ? executeSelectionSet(ctx, { __typename: 'IssueComment', comment: wrapped.comment }, edgeSelection.selectionSet)
          : { id: encodeId('comment', String(wrapped.comment.id)), body: wrapped.comment.body };
      }
      out[key] = edge;
      continue;
    }
    ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Mutation payload".` });
    out[key] = null;
  }
  return out;
}

function executeMutation(ctx: ExecutionContext, field: FieldNode): unknown {
  const { store, variables } = ctx;
  const input = (argValue(field, 'input', variables) ?? {}) as Record<string, unknown>;

  if (field.name === 'createIssue') {
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'string') return null;
    const decoded = decodeId(repositoryId);
    if (!decoded || decoded.kind !== 'repo') return null;
    const repo = [...store.listRepos()].find((candidate) => candidate.id === Number.parseInt(decoded.parts, 10));
    if (!repo) return null;
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const issue = store.createIssue(repo, title, body, []);
    return executePayload(ctx, field, { kind: 'issue', repo, issue });
  }

  if (field.name === 'closeIssue') {
    const issueId = input.issueId;
    if (typeof issueId !== 'string') return null;
    const decoded = decodeId(issueId);
    if (!decoded || decoded.kind !== 'issue') return null;
    const [repoIdText, numberText] = decoded.parts.split(':');
    const repo = [...store.listRepos()].find((candidate) => candidate.id === Number.parseInt(repoIdText ?? '', 10));
    const issue = repo?.issues.get(Number.parseInt(numberText ?? '', 10));
    if (!repo || !issue) return null;
    issue.state = 'closed';
    return executePayload(ctx, field, { kind: 'issue', repo, issue });
  }

  if (field.name === 'createPullRequest') {
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'string') return null;
    const decoded = decodeId(repositoryId);
    if (!decoded || decoded.kind !== 'repo') return null;
    const repo = [...store.listRepos()].find((candidate) => candidate.id === Number.parseInt(decoded.parts, 10));
    if (!repo) return null;
    const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
    const title = typeof input.title === 'string' ? input.title : '';
    const pull = store.createPull(repo, title, typeof input.body === 'string' ? input.body : '', headRefName, baseRefName);
    if (pull === null) return null;
    return executePayload(ctx, field, { kind: 'pullRequest', repo, pull });
  }

  if (field.name === 'mergePullRequest') {
    const pullRequestId = input.pullRequestId;
    if (typeof pullRequestId !== 'string') return null;
    const decoded = decodeId(pullRequestId);
    if (!decoded || decoded.kind !== 'pull') return null;
    const [repoIdText, numberText] = decoded.parts.split(':');
    const repo = [...store.listRepos()].find((candidate) => candidate.id === Number.parseInt(repoIdText ?? '', 10));
    const pull = repo?.pulls.get(Number.parseInt(numberText ?? '', 10));
    if (!repo || !pull) return null;
    if (pull.state !== 'open') return null;
    if (store.pullConflicts(repo, pull)) return null;
    const mergeSha = store.mergePull(repo, pull);
    if (mergeSha === null) return null;
    return executePayload(ctx, field, { kind: 'pullRequest', repo, pull });
  }

  if (field.name === 'addComment') {
    const subjectId = input.subjectId;
    if (typeof subjectId !== 'string') return null;
    const decoded = decodeId(subjectId);
    if (!decoded || decoded.kind !== 'issue') return null;
    const [repoIdText, numberText] = decoded.parts.split(':');
    const repo = [...store.listRepos()].find((candidate) => candidate.id === Number.parseInt(repoIdText ?? '', 10));
    const issue = repo?.issues.get(Number.parseInt(numberText ?? '', 10));
    if (!repo || !issue) return null;
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = store.createComment(repo, issue, body);
    return executePayload(ctx, field, { kind: 'comment', comment });
  }

  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one operation (query or mutation) against the store. */
export function executeGraphQL(store: Store, body: unknown): GraphQLResponse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: [{ message: 'Request body must be a JSON object with a query field.' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string') return { errors: [{ message: 'Must provide query string.' }] };
  const variables = (record.variables ?? {}) as Variables;
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;

  let definitions: DefinitionNode[];
  try {
    definitions = parseGraphQL(query);
  } catch (err) {
    return { errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
  }
  const fragments = new Map<string, FragmentDefinition>();
  const operations = definitions.filter((d): d is OperationDefinition => d.kind === 'operation');
  for (const definition of definitions) if (definition.kind === 'fragment') fragments.set(definition.name, definition);
  let operation: OperationDefinition | undefined;
  if (operationName) operation = operations.find((op) => op.name === operationName);
  else if (operations.length === 1) operation = operations[0];
  else operation = operations.find((op) => op.operation === 'query') ?? operations[0];
  if (!operation) return { errors: [{ message: 'Must provide an operation.' }] };

  const ctx: ExecutionContext = { store, variables, fragments, errors: [] };
  const data: Record<string, unknown> = {};
  if (operation.operation === 'mutation') {
    for (const selection of operation.selectionSet) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      data[key] = executeMutation(ctx, selection);
    }
  } else {
    Object.assign(data, executeSelectionSet(ctx, { __typename: 'Query' }, operation.selectionSet));
  }
  const response: GraphQLResponse = { data };
  if (ctx.errors.length) response.errors = ctx.errors;
  return response;
}

/** Execute a batched request (a JSON array of operations), in order. */
export function executeGraphQLBatch(store: Store, bodies: unknown[]): GraphQLResponse[] {
  return bodies.map((body) => executeGraphQL(store, body));
}
