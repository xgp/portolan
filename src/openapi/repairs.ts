/**
 * Automatic repair of common structural flaws (docs/DEVIATIONS.md D21).
 *
 * Real-world documents are often rejected by a strict validator for mistakes whose fix is
 * not in doubt: a path template variable nobody declared, a path parameter missing
 * `required: true`, an OpenAPI 3.0 operation with no `responses`. Refusing the whole
 * document for one of those helps nobody, so Portolan corrects its own copy, records each
 * repair as a JSON Patch, and reports it so it can be raised with the upstream project.
 *
 * Only repairs with exactly one reasonable outcome belong here. Anything that needs a
 * judgment about what the API actually does is left to the validator to reject, or to an
 * agent to correct through add_api.
 */
import {
  applyJsonPatchInPlace,
  getAtPointer,
  toPointer,
  type JsonPatchOperation,
} from './json-patch.js';
import { HTTP_METHODS, isRecord, type OpenApiDocument } from './types.js';

export type SpecRepairKind =
  | 'path-parameter-undeclared'
  | 'path-parameter-renamed'
  | 'path-parameter-orphaned'
  | 'path-parameter-not-required'
  | 'responses-missing'
  | 'info-version-missing';

export interface SpecRepair {
  kind: SpecRepairKind;
  /** JSON Pointer to the location that was wrong. */
  pointer: string;
  /** One line, suitable for an issue title or a list item. */
  title: string;
  /** The change applied, relative to the document as it stood before this repair. */
  patch: JsonPatchOperation[];
}

export interface RepairResult {
  document: OpenApiDocument;
  repairs: SpecRepair[];
}

/** Placeholder `info.version` for a document that declares none. */
export const UNSPECIFIED_VERSION = 'unspecified';

/** Repair a copy of `document`. The input is not modified. */
export function repairDocument(document: OpenApiDocument): RepairResult {
  const working = structuredClone(document);
  const repairs: SpecRepair[] = [];
  const apply = (repair: SpecRepair) => {
    applyJsonPatchInPlace(working, repair.patch);
    repairs.push(repair);
  };

  if (isRecord(working.info) && typeof working.info.version !== 'string') {
    apply({
      kind: 'info-version-missing',
      pointer: '/info/version',
      title: 'info.version is missing',
      patch: [{ op: 'add', path: '/info/version', value: UNSPECIFIED_VERSION }],
    });
  }

  const is30 = typeof working.openapi === 'string' && working.openapi.startsWith('3.0.');
  const paths = isRecord(working.paths) ? working.paths : {};
  for (const path of Object.keys(paths)) {
    if (isRecord(paths[path])) repairPathItem(working, path, is30, apply);
  }
  return { document: working, repairs };
}

interface DeclaredParameter {
  /** Where the entry sits in its `parameters` array. */
  entryPointer: string;
  /** Where the parameter object itself lives: the entry, or the target of its `$ref`. */
  targetPointer: string;
  index: number;
  name: string;
  required: unknown;
}

function repairPathItem(
  document: OpenApiDocument,
  path: string,
  is30: boolean,
  apply: (repair: SpecRepair) => void,
): void {
  const itemPointer = toPointer(['paths', path]);
  const template = templateVariables(path);
  const methods = HTTP_METHODS.filter((method) =>
    isRecord(getAtPointer(document, `${itemPointer}/${method}`)),
  );

  // --- path-item level ---------------------------------------------------
  const itemParams = () => pathParameters(document, `${itemPointer}/parameters`);
  const declaredByAnyOperation = new Set(
    methods.flatMap((method) =>
      pathParameters(document, `${itemPointer}/${method}/parameters`).map((p) => p.name),
    ),
  );
  const itemOrphans = itemParams().filter((p) => !template.includes(p.name));
  const itemMissing = template.filter(
    (name) => !itemParams().some((p) => p.name === name) && !declaredByAnyOperation.has(name),
  );
  // One misspelt declaration and one undeclared variable: the declaration was meant for
  // that variable. Rename it rather than delete one and invent the other.
  if (itemOrphans.length === 1 && itemMissing.length === 1 && isInline(itemOrphans[0]!)) {
    apply(renameRepair(itemOrphans[0]!, itemMissing[0]!, path));
  } else {
    for (const orphan of [...itemOrphans].sort((a, b) => b.index - a.index)) {
      apply(orphanRepair(orphan, path));
    }
  }
  for (const parameter of itemParams()) {
    if (parameter.required !== true) apply(requiredRepair(parameter, path));
  }

  // --- operation level ---------------------------------------------------
  for (const method of methods) {
    const operationPointer = `${itemPointer}/${method}`;
    const label = `${method.toUpperCase()} ${path}`;
    const opParams = () => pathParameters(document, `${operationPointer}/parameters`);

    const orphans = opParams().filter((p) => !template.includes(p.name));
    const declared = () => new Set([...itemParams(), ...opParams()].map((p) => p.name));
    const missing = template.filter((name) => !declared().has(name));
    if (orphans.length === 1 && missing.length === 1 && isInline(orphans[0]!)) {
      apply(renameRepair(orphans[0]!, missing[0]!, label));
    } else {
      for (const orphan of [...orphans].sort((a, b) => b.index - a.index)) {
        apply(orphanRepair(orphan, label));
      }
    }

    for (const parameter of opParams()) {
      if (parameter.required !== true) apply(requiredRepair(parameter, label));
    }

    for (const name of template.filter((n) => !declared().has(n))) {
      const parameter = {
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: 'Not declared by the upstream specification; added by Portolan.',
      };
      const hasArray = Array.isArray(getAtPointer(document, `${operationPointer}/parameters`));
      apply({
        kind: 'path-parameter-undeclared',
        pointer: operationPointer,
        title: `${label}: path variable {${name}} is not declared as a parameter`,
        patch: hasArray
          ? [{ op: 'add', path: `${operationPointer}/parameters/-`, value: parameter }]
          : [{ op: 'add', path: `${operationPointer}/parameters`, value: [parameter] }],
      });
    }

    if (is30) {
      const responses = getAtPointer(document, `${operationPointer}/responses`);
      if (!isRecord(responses) || Object.keys(responses).length === 0) {
        apply({
          kind: 'responses-missing',
          pointer: `${operationPointer}/responses`,
          title: `${label}: operation declares no responses`,
          patch: [
            {
              op: 'add',
              path: `${operationPointer}/responses`,
              value: { default: { description: 'Not described by the upstream specification.' } },
            },
          ],
        });
      }
    }
  }
}

function renameRepair(parameter: DeclaredParameter, name: string, label: string): SpecRepair {
  return {
    kind: 'path-parameter-renamed',
    pointer: parameter.entryPointer,
    title: `${label}: path parameter '${parameter.name}' does not match path variable {${name}}`,
    patch: [{ op: 'replace', path: `${parameter.entryPointer}/name`, value: name }],
  };
}

function orphanRepair(parameter: DeclaredParameter, label: string): SpecRepair {
  return {
    kind: 'path-parameter-orphaned',
    pointer: parameter.entryPointer,
    title: `${label}: path parameter '${parameter.name}' has no matching {${parameter.name}} in the path`,
    patch: [{ op: 'remove', path: parameter.entryPointer }],
  };
}

function requiredRepair(parameter: DeclaredParameter, label: string): SpecRepair {
  return {
    kind: 'path-parameter-not-required',
    pointer: parameter.targetPointer,
    title: `${label}: path parameter '${parameter.name}' is not marked required: true`,
    patch: [{ op: 'add', path: `${parameter.targetPointer}/required`, value: true }],
  };
}

function isInline(parameter: DeclaredParameter): boolean {
  return parameter.entryPointer === parameter.targetPointer;
}

/** `in: path` parameters declared in the array at `pointer`, with local `$ref`s followed. */
function pathParameters(document: OpenApiDocument, pointer: string): DeclaredParameter[] {
  const list = getAtPointer(document, pointer);
  if (!Array.isArray(list)) return [];
  const out: DeclaredParameter[] = [];
  list.forEach((entry, index) => {
    const entryPointer = `${pointer}/${index}`;
    let targetPointer = entryPointer;
    let parameter: unknown = entry;
    if (isRecord(entry) && typeof entry.$ref === 'string') {
      if (!entry.$ref.startsWith('#/')) return;
      targetPointer = decodeURIComponent(entry.$ref.slice(1));
      parameter = getAtPointer(document, targetPointer);
      // A chain of references is rare enough not to repair through.
      if (isRecord(parameter) && '$ref' in parameter) return;
    }
    if (!isRecord(parameter) || parameter.in !== 'path' || typeof parameter.name !== 'string') {
      return;
    }
    out.push({
      entryPointer,
      targetPointer,
      index,
      name: parameter.name,
      required: parameter.required,
    });
  });
  return out;
}

function templateVariables(path: string): string[] {
  return [...new Set([...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!))];
}
