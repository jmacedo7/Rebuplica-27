export type HttpMethod = 'GET' | 'POST';

export interface RouteMatch<P extends Readonly<Record<string, string>>> {
  readonly params: P;
}

interface CompiledRoute {
  readonly method: HttpMethod;
  readonly segments: readonly string[];
  readonly pattern: string;
}

const segmentPatterns = (pattern: string): readonly string[] =>
  pattern.split('/').filter(part => part !== '');

const matchSegments = (route: readonly string[],path: readonly string[]): Record<string, string> | null => {
  if (route.length !== path.length) return null;
  const params: Record<string, string> = {};
  for (const [index,segment] of route.entries()) {
    const value = path[index];
    if (value === undefined) return null;
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (value === '') return null;
      params[name] = decodeURIComponent(value);
      continue;
    }
    if (segment !== value) return null;
  }
  return params;
};

/**
 * Minimal router: no dependencies, exact segment matching, `:param` placeholders and
 * method awareness (so an unknown method on a known path answers 405 instead of 404).
 */
export class Router {
  readonly #routes: readonly CompiledRoute[];

  constructor(patterns: readonly {readonly method: HttpMethod; readonly pattern: string}[]) {
    this.#routes = patterns.map(route => ({
      method:route.method,
      pattern:route.pattern,
      segments:segmentPatterns(route.pattern),
    }));
  }

  match(method: string,pathname: string): {readonly pattern: string; readonly params: Readonly<Record<string,string>>} | null {
    const path = segmentPatterns(pathname);
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments,path);
      if (params !== null) return {pattern:route.pattern,params};
    }
    return null;
  }

  /** Methods that would match this path, used to answer 405 with an `Allow` header. */
  allowedMethods(pathname: string): readonly HttpMethod[] {
    const path = segmentPatterns(pathname);
    const methods: HttpMethod[] = [];
    for (const route of this.#routes) {
      if (matchSegments(route.segments,path) !== null && !methods.includes(route.method)) methods.push(route.method);
    }
    return methods;
  }
}
