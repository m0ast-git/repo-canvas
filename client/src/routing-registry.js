export const ROUTING_VERSION = 17;

import {
  applyRoutingMoves,
  routesFromRoutingResults,
  routingResultsComplete,
} from "./routing-scopes.js";

export class RoutingRegistry {
  constructor({ createSession, routeOnce, convertResults = routesFromRoutingResults, onError = () => {} } = {}) {
    this.createSession = createSession;
    this.routeOnce = routeOnce;
    this.convertResults = convertResults;
    this.onError = onError;
    this.entries = new Map();
    this.generation = 0;
    this.metrics = { created: 0, destroyed: 0, rebuilds: 0, transactions: 0, fallbacks: 0 };
  }

  stats() {
    return { ...this.metrics, active: [...this.entries.values()].filter((entry) => entry.session).length };
  }

  routes() {
    return [...this.entries.values()].flatMap((entry) => entry.routes || []);
  }

  destroyEntry(entry) {
    if (!entry?.session) return;
    try { entry.session.destroy(); }
    finally { entry.session = null; this.metrics.destroyed += 1; }
  }

  destroy() {
    this.generation += 1;
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();
  }

  async fallback(entry, error) {
    this.metrics.fallbacks += 1;
    this.onError(error);
    try {
      const routes = await this.routeOnce(entry.scope);
      if (routes?.length === entry.scope.edges.length) entry.routes = routes;
    } catch (fallbackError) {
      this.onError(fallbackError);
    }
    entry.retry = true;
    return entry.routes || [];
  }

  async buildEntry(scope, previousRoutes = []) {
    const entry = { scope, routes: previousRoutes, session: null, retry: false };
    try {
      const session = await this.createSession(scope.graph);
      this.metrics.created += 1;
      entry.session = session;
      const results = session.processTransaction();
      if (!routingResultsComplete(scope, results)) {
        throw new Error(`Routing scope ${scope.id} returned an incomplete initial route set`);
      }
      entry.routes = this.convertResults(scope, results);
      return entry;
    } catch (error) {
      this.destroyEntry(entry);
      return this.fallback(entry, error).then(() => entry);
    }
  }

  async replace(scopes = []) {
    const generation = ++this.generation;
    const previous = new Map([...this.entries].map(([id, entry]) => [id, entry.routes || []]));
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();

    for (const scope of scopes.filter((item) => item.edges.length)) {
      const entry = await this.buildEntry(scope, previous.get(scope.id) || []);
      if (generation !== this.generation) {
        this.destroyEntry(entry);
        continue;
      }
      this.entries.set(scope.id, entry);
    }
    return this.routes();
  }

  restore(scopes=[],routes=[]) {
    this.destroy();const byId=new Map(routes.map(route=>[route.id,route]));
    for(const scope of scopes.filter(item=>item.edges.length))this.entries.set(scope.id,{scope,routes:scope.edges.map(edge=>byId.get(edge.id)).filter(Boolean),session:null,retry:false,restored:true});
    return routes;
  }

  async rebuild(entry, error) {
    this.metrics.rebuilds += 1;
    this.destroyEntry(entry);
    const replacement = await this.buildEntry(entry.scope, entry.routes || []);
    this.entries.set(entry.scope.id, replacement);
    if (replacement.retry && error) this.onError(error);
    return replacement;
  }

  async settle(moves = []) {
    const updates = [];
    for (const original of [...this.entries.values()]) {
      const scopedMoves = applyRoutingMoves(original.scope, moves);
      const existingIds=new Set(original.routes.map(route=>route.id));const missing=original.scope.edges.filter(edge=>!existingIds.has(edge.id));
      if (!scopedMoves.length&&!missing.length) continue;
      let entry = original;
      if (!entry.session || entry.retry) {
        entry = await this.rebuild(entry, new Error(`Routing scope ${entry.scope.id} requires a session retry`));
        updates.push(...entry.routes);
        continue;
      }
      try {
        for (const move of scopedMoves) entry.session.moveNode(move.id, { x: move.x, y: move.y });
        const startedAt = performance.now();
        const results = entry.session.processTransaction();
        entry.lastTransactionMs = performance.now() - startedAt;
        this.metrics.transactions += 1;
        if (!routingResultsComplete(entry.scope, results)) throw new Error(`Routing scope ${entry.scope.id} returned an incomplete route set`);
        entry.routes = this.convertResults(entry.scope, results);
        entry.retry = false;
        updates.push(...entry.routes);
      } catch (error) {
        entry = await this.rebuild(entry, error);
        updates.push(...entry.routes);
      }
    }
    return updates;
  }
}
