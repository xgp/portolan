/**
 * OpenAPI parameter serialization (SPEC.md §22).
 *
 * Implements `style` and `explode` for path, query, header and cookie parameters,
 * including arrays, objects, `allowReserved` and the `content` form.
 *
 * Where a style/location/type combination has no defined meaning in the specification,
 * this module throws rather than guessing. SPEC.md §22 is explicit about that: silently
 * producing a plausible-but-wrong request is worse than an error the agent can act on.
 */
import { PortolanError } from '../errors/errors.js';
import { isRecord, type OpenApiParameter, type ParameterLocation } from './types.js';

export type ParameterStyle =
  'simple' | 'label' | 'matrix' | 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';

const DEFAULT_STYLE: Record<ParameterLocation, ParameterStyle> = {
  path: 'simple',
  query: 'form',
  header: 'simple',
  cookie: 'form',
};

const ALLOWED_STYLES: Record<ParameterLocation, ParameterStyle[]> = {
  path: ['simple', 'label', 'matrix'],
  query: ['form', 'spaceDelimited', 'pipeDelimited', 'deepObject'],
  header: ['simple'],
  cookie: ['form'],
};

export interface SerializedQueryPair {
  name: string;
  value: string;
  /** Already percent-encoded by the serializer; the URL builder must not encode again. */
  encoded: true;
}

export interface ParameterSpec {
  name: string;
  in: ParameterLocation;
  style: ParameterStyle;
  explode: boolean;
  allowReserved: boolean;
  /** Set when the parameter uses `content` rather than `schema`. */
  contentType?: string;
}

function invalid(
  name: string,
  location: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return new PortolanError('PARAMETER_INVALID', message, {
    parameter: name,
    in: location,
    ...details,
  });
}

/** Resolve the effective style/explode for a parameter, rejecting undefined combinations. */
export function parameterSpec(
  parameter: OpenApiParameter,
  location: ParameterLocation,
): ParameterSpec {
  const name = typeof parameter.name === 'string' ? parameter.name : '';
  const style: string =
    typeof parameter.style === 'string' ? parameter.style : DEFAULT_STYLE[location];

  if (!(ALLOWED_STYLES[location] as string[]).includes(style)) {
    throw invalid(
      name,
      location,
      `Parameter '${name}' declares style '${style}', which OpenAPI does not define for a ${location} parameter. Portolan will not guess an encoding.`,
      { style, supported: ALLOWED_STYLES[location] },
    );
  }
  const resolvedStyle = style as ParameterStyle;

  // OpenAPI defaults `explode` to true for `form` and false otherwise. `deepObject` is
  // only defined in its exploded form, and real documents routinely omit the flag, so it
  // defaults to true here too; an *explicit* `explode: false` is still rejected below.
  const explode =
    typeof parameter.explode === 'boolean'
      ? parameter.explode
      : resolvedStyle === 'form' || resolvedStyle === 'deepObject';

  if ((resolvedStyle === 'spaceDelimited' || resolvedStyle === 'pipeDelimited') && explode) {
    throw invalid(
      name,
      location,
      `Parameter '${name}' combines style '${resolvedStyle}' with explode=true, which OpenAPI leaves undefined.`,
      { style: resolvedStyle, explode },
    );
  }
  if (resolvedStyle === 'deepObject' && parameter.explode === false) {
    throw invalid(
      name,
      location,
      `Parameter '${name}' uses style 'deepObject' with explode=false, which OpenAPI leaves undefined.`,
      { style: resolvedStyle, explode },
    );
  }

  const spec: ParameterSpec = {
    name,
    in: location,
    style: resolvedStyle,
    explode,
    allowReserved: parameter.allowReserved === true,
  };

  if (isRecord(parameter.content)) {
    const types = Object.keys(parameter.content);
    const jsonType = types.find((t) => /^application\/(\w+\+)?json$/i.test(t));
    if (!jsonType) {
      throw invalid(
        name,
        location,
        `Parameter '${name}' is defined with content types [${types.join(', ')}]; only JSON content parameters are supported.`,
        { content_types: types },
      );
    }
    spec.contentType = jsonType;
  }

  return spec;
}

/** Percent-encode a value. `allowReserved` leaves RFC 3986 reserved characters intact. */
export function encodeValue(value: string, allowReserved: boolean): string {
  if (allowReserved) {
    // Keep gen-delims and sub-delims, encode everything else.
    return encodeURI(value).replace(/%25/g, '%25');
  }
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function primitive(value: unknown): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function entriesOf(value: Record<string, unknown>): [string, string][] {
  return Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, primitive(v)]);
}

// ---------------------------------------------------------------------------
// Path, header and cookie
// ---------------------------------------------------------------------------

/** Serialize a path parameter into the substitution for `{name}`. */
export function serializePathParameter(spec: ParameterSpec, value: unknown): string {
  if (spec.contentType) return encodeValue(JSON.stringify(value), spec.allowReserved);
  const enc = (v: string) => encodeValue(v, spec.allowReserved);

  if (Array.isArray(value)) {
    const parts = value.map((v) => enc(primitive(v)));
    switch (spec.style) {
      case 'simple':
        return parts.join(',');
      case 'label':
        return spec.explode ? `.${parts.join('.')}` : `.${parts.join(',')}`;
      case 'matrix':
        return spec.explode
          ? parts.map((p) => `;${enc(spec.name)}=${p}`).join('')
          : `;${enc(spec.name)}=${parts.join(',')}`;
      default:
        throw invalid(
          spec.name,
          'path',
          `Unsupported style '${spec.style}' for an array path parameter.`,
        );
    }
  }

  if (isRecord(value)) {
    const pairs = entriesOf(value);
    switch (spec.style) {
      case 'simple':
        return spec.explode
          ? pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join(',')
          : pairs.flatMap(([k, v]) => [enc(k), enc(v)]).join(',');
      case 'label':
        return spec.explode
          ? `.${pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('.')}`
          : `.${pairs.flatMap(([k, v]) => [enc(k), enc(v)]).join(',')}`;
      case 'matrix':
        return spec.explode
          ? pairs.map(([k, v]) => `;${enc(k)}=${enc(v)}`).join('')
          : `;${enc(spec.name)}=${pairs.flatMap(([k, v]) => [enc(k), enc(v)]).join(',')}`;
      default:
        throw invalid(
          spec.name,
          'path',
          `Unsupported style '${spec.style}' for an object path parameter.`,
        );
    }
  }

  const single = enc(primitive(value));
  switch (spec.style) {
    case 'simple':
      return single;
    case 'label':
      return `.${single}`;
    case 'matrix':
      return `;${enc(spec.name)}=${single}`;
    default:
      throw invalid(spec.name, 'path', `Unsupported style '${spec.style}' for a path parameter.`);
  }
}

/** Serialize a header parameter value. Header values are not percent-encoded. */
export function serializeHeaderParameter(spec: ParameterSpec, value: unknown): string {
  if (spec.contentType) return JSON.stringify(value);
  if (Array.isArray(value)) return value.map((v) => primitive(v)).join(',');
  if (isRecord(value)) {
    const pairs = entriesOf(value);
    return spec.explode
      ? pairs.map(([k, v]) => `${k}=${v}`).join(',')
      : pairs.flatMap(([k, v]) => [k, v]).join(',');
  }
  return primitive(value);
}

/** Serialize a cookie parameter value (style `form`, encoded for a Cookie header). */
export function serializeCookieParameter(spec: ParameterSpec, value: unknown): string {
  if (spec.contentType) return encodeURIComponent(JSON.stringify(value));
  if (Array.isArray(value)) return value.map((v) => encodeURIComponent(primitive(v))).join(',');
  if (isRecord(value)) {
    return entriesOf(value)
      .flatMap(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
      .join(',');
  }
  return encodeURIComponent(primitive(value));
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Serialize one query parameter into already-encoded `name=value` pairs. */
export function serializeQueryParameter(
  spec: ParameterSpec,
  value: unknown,
): SerializedQueryPair[] {
  const enc = (v: string) => encodeValue(v, spec.allowReserved);
  const name = encodeValue(spec.name, false);

  if (spec.contentType) {
    return [{ name, value: enc(JSON.stringify(value)), encoded: true }];
  }

  if (Array.isArray(value)) {
    const parts = value.map((v) => enc(primitive(v)));
    switch (spec.style) {
      case 'form':
        return spec.explode
          ? parts.map((part) => ({ name, value: part, encoded: true as const }))
          : [{ name, value: parts.join(','), encoded: true }];
      case 'spaceDelimited':
        return [{ name, value: parts.join('%20'), encoded: true }];
      case 'pipeDelimited':
        return [{ name, value: parts.join('|'), encoded: true }];
      case 'deepObject':
        throw invalid(
          spec.name,
          'query',
          `Parameter '${spec.name}' uses style 'deepObject', which OpenAPI defines only for objects, but an array was supplied.`,
        );
      default:
        throw invalid(
          spec.name,
          'query',
          `Unsupported style '${spec.style}' for an array query parameter.`,
        );
    }
  }

  if (isRecord(value)) {
    const pairs = entriesOf(value);
    switch (spec.style) {
      case 'form':
        return spec.explode
          ? pairs.map(([k, v]) => ({
              name: encodeValue(k, false),
              value: enc(v),
              encoded: true as const,
            }))
          : [
              {
                name,
                value: pairs.flatMap(([k, v]) => [enc(k), enc(v)]).join(','),
                encoded: true,
              },
            ];
      case 'deepObject':
        return pairs.map(([k, v]) => ({
          name: `${name}%5B${encodeValue(k, false)}%5D`,
          value: enc(v),
          encoded: true as const,
        }));
      case 'spaceDelimited':
        return [
          { name, value: pairs.flatMap(([k, v]) => [enc(k), enc(v)]).join('%20'), encoded: true },
        ];
      case 'pipeDelimited':
        return [
          { name, value: pairs.flatMap(([k, v]) => [enc(k), enc(v)]).join('|'), encoded: true },
        ];
      default:
        throw invalid(
          spec.name,
          'query',
          `Unsupported style '${spec.style}' for an object query parameter.`,
        );
    }
  }

  if (value === undefined) return [];
  if (spec.style === 'deepObject') {
    throw invalid(
      spec.name,
      'query',
      `Parameter '${spec.name}' uses style 'deepObject', which OpenAPI defines only for objects.`,
    );
  }
  return [{ name, value: enc(primitive(value)), encoded: true }];
}

/** Substitute serialized path parameters into a path template. */
export function applyPathTemplate(template: string, values: ReadonlyMap<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    const value = values.get(name);
    if (value === undefined) {
      throw new PortolanError(
        'PARAMETER_REQUIRED',
        `Path parameter '${name}' is required by '${template}' but was not supplied.`,
        { parameter: name, in: 'path', path: template },
      );
    }
    // Matrix and label styles carry their own prefix, which replaces the placeholder
    // along with any separator the template already contains.
    return value;
  });
}

export function buildQueryString(pairs: readonly SerializedQueryPair[]): string {
  if (pairs.length === 0) return '';
  return pairs
    .map((pair) => (pair.value === '' ? pair.name : `${pair.name}=${pair.value}`))
    .join('&');
}
